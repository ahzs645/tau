/**
 * Geometry Cache Middleware
 *
 * Caches createGeometry results to avoid redundant kernel computations.
 * Uses a content-addressable cache based on all dependencies (file content hashes,
 * middleware signatures, framework version, and kernel options).
 *
 * Uses wrap-style hooks with onion model:
 * 1. Check cache - if hit, return cached result (short-circuit)
 * 2. If miss, call handler() to execute downstream
 * 3. Write result to cache on the way back up
 *
 * Short-circuited results still flow through upstream middleware (e.g., transform)
 * because each middleware wraps around the next in the onion model.
 *
 * Storage format: MessagePack binary serialization for efficient storage of
 * binary geometry data (GLTF) without base64 encoding overhead.
 */

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { GeometryResponse } from '@taucad/types';
import { z } from 'zod';
import { LruMap } from '@taucad/utils/cache';
import { joinPath } from '@taucad/utils/path';
import type { KernelFileSystem } from '#types/runtime-kernel.types.js';
import type { KernelSuccessResult } from '#types/runtime.types.js';
import { defineMiddleware } from '#middleware/runtime-middleware.js';

const mebibyte = 1024 * 1024;
const geometryMemoryCacheMaxBytes = 100 * mebibyte;
const geometryFilesystemCacheMaxBytes = 512 * mebibyte;

function geometryResultByteLength(result: KernelSuccessResult<GeometryResponse[]>): number {
  let byteLength = 0;
  for (const geometry of result.data) {
    switch (geometry.format) {
      case 'gltf': {
        byteLength += geometry.content.byteLength;
        break;
      }
      case 'svg': {
        byteLength += geometry.paths.reduce((total, path) => total + path.length * 2, 0);
        break;
      }
      case 'webrtc': {
        break;
      }
    }
  }
  return byteLength;
}

/**
 * In-memory L1 cache for deserialized geometry results.
 * Module-scoped so each worker gets its own cache.
 * Smaller than parameter cache due to larger value sizes (binary GLTF).
 * Exported for test isolation (`beforeEach` → `.clear()`).
 * @public
 */
export const geometryMemoryCache = new LruMap<KernelSuccessResult<GeometryResponse[]>>({
  maxEntries: 20,
  maxWeight: geometryMemoryCacheMaxBytes,
  getWeight: geometryResultByteLength,
});

/**
 * Cache entry structure for MessagePack serialization.
 * Stores the full KernelSuccessResult so that all fields (geometries, issues,
 * and any future additions) are persisted implicitly.
 */
type CacheEntry = {
  version: 3;
  result: KernelSuccessResult<GeometryResponse[]>;
};

/**
 * Serialize a successful geometry result for cache storage using MessagePack.
 * The entire result (geometries + issues) is stored directly; MessagePack
 * handles Uint8Array natively so no base64 conversion is needed.
 *
 * @param result - The successful geometry result to serialize
 * @returns Binary MessagePack-encoded data
 */
function serializeResult(result: KernelSuccessResult<GeometryResponse[]>): Uint8Array<ArrayBuffer> {
  const entry: CacheEntry = { version: 3, result };
  return msgpackEncode(entry);
}

/**
 * Deserialize a geometry result from cache storage using MessagePack.
 * Returns the full KernelSuccessResult including issues.
 *
 * @param data - Binary MessagePack-encoded data
 * @returns The deserialized result with geometries and issues
 * @throws Error if cache format is invalid or incompatible version
 */
function deserializeResult(data: Uint8Array<ArrayBuffer>): KernelSuccessResult<GeometryResponse[]> {
  const decoded: unknown = msgpackDecode(data);

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('version' in decoded) ||
    decoded.version !== 3 ||
    !('result' in decoded)
  ) {
    throw new Error('Invalid or incompatible cache format');
  }

  const entry = decoded as CacheEntry;

  // Copy GLTF Uint8Arrays to ensure we have proper ArrayBuffers
  // (MessagePack may return views into a shared buffer)
  for (const geometry of entry.result.data) {
    if (geometry.format === 'gltf') {
      geometry.content = new Uint8Array(geometry.content);
    }
  }

  return entry.result;
}

/**
 * Produce a delivery-safe copy of a cached result whose GLTF byte buffers
 * are freshly allocated.
 *
 * The worker host publishes GLTF geometry through a *transfer* tier that
 * detaches `content.buffer` for zero-copy hand-off (see
 * `worker-host-bindings.ts`). The L1 cache, however, retains the result by
 * reference, so handing the cached object straight to the transport would
 * detach the cached buffer — every subsequent cache hit would then fail with
 * "ArrayBuffer at index 0 is already detached". Returning a copy for delivery
 * keeps the cached entry pristine while the caller still gets a transferable
 * buffer it can safely detach.
 *
 * Only GLTF content is copied; SVG/WebRTC payloads ride the copy tier and are
 * never detached.
 *
 * @param result - The cached result to copy for delivery
 * @returns A shallow clone with fresh GLTF byte buffers
 */
function cloneResultForDelivery(
  result: KernelSuccessResult<GeometryResponse[]>,
): KernelSuccessResult<GeometryResponse[]> {
  return {
    ...result,
    data: result.data.map((geometry) =>
      geometry.format === 'gltf' ? { ...geometry, content: new Uint8Array(geometry.content) } : geometry,
    ),
  };
}

/**
 * Get the cache file path for a given cache key.
 * Uses .bin extension for MessagePack binary storage.
 *
 * @param basePath - The base path for the build
 * @param cacheKey - identifier used to locate and deduplicate cached geometry files
 * @returns The full path to the cache file
 */
function getCachePath(basePath: string, cacheKey: string): string {
  return joinPath(basePath, '.tau/cache/geometry', `${cacheKey}.bin`);
}

/**
 * Get the cache directory path.
 *
 * @param basePath - The base path for the build
 * @returns The full path to the cache directory
 */
function getCacheDirectory(basePath: string): string {
  return joinPath(basePath, '.tau/cache/geometry');
}

/**
 * Check if any geometries in the result have webrtc format.
 * Video-stream geometries cannot be cached as they contain live streams.
 *
 * @param geometries - The geometries to check
 * @returns True if any geometry is a webrtc
 */
function hasVideoStreamGeometry(geometries: readonly GeometryResponse[]): boolean {
  return geometries.some((geometry) => geometry.format === 'webrtc');
}

/**
 * Clean up old cache entries to prevent unbounded cache growth.
 * Deletes entries older than `maxAge`, then evicts the oldest files until both
 * the entry-count and aggregate-byte limits are satisfied.
 */
async function cleanupOldCacheEntries({
  filesystem,
  cacheDirectory,
  maxAge,
  maxBytes,
  maxEntries,
}: {
  /** The filesystem for file operations */
  filesystem: KernelFileSystem;
  /** The cache directory path */
  cacheDirectory: string;
  /** Maximum age for cache entries. Milliseconds. */
  maxAge: number;
  /** Maximum aggregate size of cache entries. Bytes. */
  maxBytes: number;
  /** Maximum number of cache entries to keep */
  maxEntries: number;
}): Promise<void> {
  try {
    const files = await filesystem.readdirStat(cacheDirectory);

    // Filter to only .bin cache files (MessagePack binary format)
    const cacheFiles = files.filter((file) => file.type === 'file' && file.name.endsWith('.bin'));

    if (cacheFiles.length === 0) {
      return;
    }

    const now = Date.now();
    const filesToDelete = new Set<string>();

    // First pass: identify files older than maxAge
    for (const file of cacheFiles) {
      const age = now - file.mtimeMs;
      if (age > maxAge) {
        filesToDelete.add(file.path);
      }
    }

    // Second pass: if still over either capacity limit, delete oldest files.
    const remainingFiles = cacheFiles
      .filter((file) => !filesToDelete.has(file.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let remainingBytes = remainingFiles.reduce((total, file) => total + file.size, 0);

    while (remainingFiles.length > maxEntries || remainingBytes > maxBytes) {
      const file = remainingFiles.shift();
      if (!file) {
        break;
      }
      filesToDelete.add(file.path);
      remainingBytes -= file.size;
    }

    // Delete identified files
    await Promise.all([...filesToDelete].map(async (path) => filesystem.unlink(path)));
  } catch {
    // Cleanup errors are non-fatal - silently ignore
  }
}

/**
 * Geometry cache middleware.
 *
 * Caches createGeometry results based on all dependencies (files, middleware, framework, options).
 * Uses wrap-style hook with onion model execution:
 * - Check cache before calling handler()
 * - Write to cache after handler() returns (on cache miss)
 * - Short-circuited results still flow through upstream middleware
 *
 * Export operations are not cached - they are delegated to kernel workers
 * which handle format-specific conversion (e.g., GLTF JSON vs GLB binary).
 * @public
 */
export const geometryCacheMiddleware = defineMiddleware({
  name: 'GeometryCache',
  version: '1.1.0',

  optionsSchema: z.object({
    maxEntries: z.number().int().positive().default(100),
    maxBytes: z.number().int().positive().default(geometryFilesystemCacheMaxBytes),
    /** Maximum age for cache entries. Milliseconds. */
    maxAge: z
      .number()
      .nonnegative()
      .default(7 * 24 * 60 * 60 * 1000),
  }),

  async wrapCreateGeometry(input, handler, { logger, filesystem, dependencyHash, options }) {
    const { basePath } = input;
    const cacheKey = dependencyHash;

    // L1: In-memory cache (fast, no I/O or deserialization)
    const memoryCached = geometryMemoryCache.get(cacheKey);
    if (memoryCached) {
      logger.debug(`Geometry memory cache hit for ${cacheKey}`);
      return cloneResultForDelivery(memoryCached);
    }

    // L2: Filesystem cache
    const cachePath = getCachePath(basePath, cacheKey);
    try {
      const cachedData = await filesystem.readFile(cachePath);
      logger.debug(`Cache hit for ${cacheKey}`);

      const result = deserializeResult(cachedData);
      const retainedInMemory = geometryMemoryCache.set(cacheKey, result);
      return retainedInMemory ? cloneResultForDelivery(result) : result;
    } catch (error) {
      logger.debug(`Cache miss for ${cacheKey}: ${String(error)}`);
    }

    // Compute: execute downstream
    const result = await handler(input);

    // Write back to L2 and populate L1 (skip webrtc for both)
    let retainedInMemory = false;
    if (result.success && result.data.length > 0) {
      if (hasVideoStreamGeometry(result.data)) {
        logger.debug(`Skipping cache for ${cacheKey}: contains webrtc geometry`);
      } else {
        retainedInMemory = geometryMemoryCache.set(cacheKey, result);

        try {
          const serialized = serializeResult(result);
          if (serialized.byteLength > options.maxBytes) {
            logger.debug(`Skipping filesystem cache for ${cacheKey}: entry exceeds maxBytes`);
          } else {
            const cacheDirectory = getCacheDirectory(basePath);
            await filesystem.ensureDir(cacheDirectory);
            await filesystem.writeFile(cachePath, serialized);
            logger.debug(`Cached ${result.data.length} geometries at ${cacheKey}`);

            await cleanupOldCacheEntries({
              filesystem,
              cacheDirectory,
              maxAge: options.maxAge,
              maxBytes: options.maxBytes,
              maxEntries: options.maxEntries,
            });
          }
        } catch (error) {
          logger.warn(`Cache write error for ${cacheKey}: ${String(error)}`);
        }
      }
    }

    // When the result is retained by the L1 cache, hand the caller a copy so
    // the downstream transfer tier never detaches the cached buffer.
    return retainedInMemory && result.success ? cloneResultForDelivery(result) : result;
  },
});
