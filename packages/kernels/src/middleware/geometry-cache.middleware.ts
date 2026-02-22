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
import type { GeometryResponse, KernelFilesystem } from '@taucad/types';
import { z } from 'zod';
import { joinPath } from '@taucad/utils/path';
import { createKernelMiddleware } from '#middleware/kernel-middleware.js';
import { createKernelSuccess } from '#framework/kernel-helpers.js';

/**
 * Serialized geometry format for cache storage.
 * GLTF content is stored as binary Uint8Array (MessagePack handles natively).
 * Hash is NOT stored - it's the cache key (filename), not the content.
 */
type SerializedGeometry =
  | { format: 'gltf'; content: Uint8Array<ArrayBuffer> } // Binary data stored directly by MessagePack
  | {
      format: 'svg';
      color?: string;
      paths: string[];
      viewbox: string;
      opacity?: number;
      strokeType?: string;
      name: string;
    }
  | { format: 'webrtc' }; // Cannot cache streams, just store format marker

/**
 * Cache entry structure for MessagePack serialization.
 */
type CacheEntry = {
  version: 1;
  geometries: SerializedGeometry[];
};

/**
 * Serialize geometries for cache storage using MessagePack.
 * Binary data (GLTF Uint8Array) is stored directly without base64 encoding.
 * Hash is NOT stored - it's derived from the cache key.
 *
 * @param geometries - The geometries to serialize
 * @returns Binary MessagePack-encoded data
 */
function serializeGeometries(geometries: readonly GeometryResponse[]): Uint8Array<ArrayBuffer> {
  const serialized: SerializedGeometry[] = geometries.map((geometry): SerializedGeometry => {
    switch (geometry.format) {
      case 'gltf': {
        // MessagePack handles Uint8Array natively - no base64 conversion needed
        return { format: 'gltf', content: geometry.content };
      }

      case 'svg': {
        // SVG data is stored as-is
        const { format, color, paths, viewbox, opacity, strokeType, name } = geometry;

        return { format, color, paths, viewbox, opacity, strokeType, name };
      }

      case 'webrtc': {
        // Cannot cache streams - store marker only
        return { format: 'webrtc' };
      }

      default: {
        // Exhaustive check - this should never happen
        const _exhaustiveCheck: never = geometry;

        throw new Error(`Unexpected geometry format: ${String(_exhaustiveCheck)}`);
      }
    }
  });

  const entry: CacheEntry = {
    version: 1,
    geometries: serialized,
  };

  return msgpackEncode(entry) as Uint8Array<ArrayBuffer>;
}

/**
 * Deserialize geometries from cache storage using MessagePack.
 * Binary data (GLTF Uint8Array) is restored directly without base64 decoding.
 * Returns GeometryBase (without hash) - hash is added by kernel-worker.ts.
 *
 * @param data - Binary MessagePack-encoded data
 * @returns The deserialized geometries (excluding webrtc which can't be cached)
 * @throws Error if cache format is invalid or incompatible version
 */
function deserializeGeometries(data: Uint8Array<ArrayBuffer>): GeometryResponse[] {
  // Decode MessagePack data - result is unknown at runtime
  const decoded: unknown = msgpackDecode(data);

  // Validate cache format version (runtime check for corrupted or old format caches)
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('version' in decoded) ||
    decoded.version !== 1 ||
    !('geometries' in decoded) ||
    !Array.isArray(decoded.geometries)
  ) {
    throw new Error('Invalid or incompatible cache format');
  }

  const entry = decoded as CacheEntry;
  const geometries: GeometryResponse[] = [];

  for (const item of entry.geometries) {
    switch (item.format) {
      case 'gltf': {
        // MessagePack returns Uint8Array directly - no base64 decoding needed
        // Copy to ensure we have a proper Uint8Array with its own ArrayBuffer
        // (MessagePack may return a view into a shared buffer)
        geometries.push({ format: 'gltf', content: new Uint8Array(item.content) });
        break;
      }

      case 'svg': {
        geometries.push({
          format: 'svg',
          color: item.color,
          paths: item.paths,
          viewbox: item.viewbox,
          opacity: item.opacity,
          strokeType: item.strokeType,
          name: item.name,
        });
        break;
      }

      case 'webrtc': {
        // Cannot restore streams from cache - skip
        break;
      }
    }
  }

  return geometries;
}

/**
 * Get the cache file path for a given cache key.
 * Uses .bin extension for MessagePack binary storage.
 *
 * @param basePath - The base path for the build
 * @param cacheKey - The cache key
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
function getCacheDir(basePath: string): string {
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
 * Deletes entries older than maxAgeMs and keeps only maxEntries most recent files.
 *
 * @param filesystem - The filesystem for file operations
 * @param cacheDir - The cache directory path
 * @param maxAgeMs - Maximum age in milliseconds for cache entries
 * @param maxEntries - Maximum number of cache entries to keep
 */
async function cleanupOldCacheEntries(
  filesystem: KernelFilesystem,
  cacheDir: string,
  maxAgeMs: number,
  maxEntries: number,
): Promise<void> {
  try {
    const files = await filesystem.getDirectoryStat(cacheDir);

    // Filter to only .bin cache files (MessagePack binary format)
    const cacheFiles = files.filter((file) => file.type === 'file' && file.name.endsWith('.bin'));

    if (cacheFiles.length === 0) {
      return;
    }

    const now = Date.now();
    const filesToDelete: string[] = [];

    // First pass: identify files older than maxAgeMs
    for (const file of cacheFiles) {
      const age = now - file.mtimeMs;
      if (age > maxAgeMs) {
        filesToDelete.push(joinPath(cacheDir, file.path));
      }
    }

    // Second pass: if still over maxEntries, delete oldest files
    const remainingFiles = cacheFiles.filter((file) => {
      const fullPath = joinPath(cacheDir, file.path);
      return !filesToDelete.includes(fullPath);
    });

    if (remainingFiles.length > maxEntries) {
      // Sort by modification time (oldest first)
      remainingFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

      // Delete oldest files to get under maxEntries
      const excessCount = remainingFiles.length - maxEntries;
      for (let index = 0; index < excessCount; index++) {
        const file = remainingFiles[index];
        if (file) {
          filesToDelete.push(joinPath(cacheDir, file.path));
        }
      }
    }

    // Delete identified files
    await Promise.all(filesToDelete.map(async (path) => filesystem.unlink(path)));
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
 */
export const geometryCacheMiddleware = createKernelMiddleware({
  name: 'GeometryCache',
  version: '1.0.0',

  configSchema: z.object({
    maxEntries: z.number().default(100),
    maxAgeMs: z.number().default(7 * 24 * 60 * 60 * 1000),
  }),

  async wrapCreateGeometry(input, handler, { logger, filesystem, dependencyHash, config }) {
    const { basePath } = input;
    // Use pre-computed dependency hash as cache key
    const cacheKey = dependencyHash;
    const cachePath = getCachePath(basePath, cacheKey);

    // 1. Try reading cache directly (single round-trip instead of exists + readFile)
    try {
      const cachedData = await filesystem.readFile(cachePath);
      logger.debug(`Cache hit for ${cacheKey}`);

      const geometries = deserializeGeometries(cachedData);
      return createKernelSuccess(geometries);
    } catch (error) {
      // Cache miss or read error - proceed to compute
      logger.debug(`Cache miss for ${cacheKey}: ${String(error)}`);
    }

    // 2. Cache miss - execute downstream
    logger.debug(`Cache miss for ${cacheKey}`);
    const result = await handler(input);

    // 4. Write to cache on the way back up (skip if webrtc geometries present)
    if (result.success && result.data.length > 0) {
      // Skip caching if any geometry is a webrtc - these cannot be cached
      // and would result in incomplete data on cache hit
      if (hasVideoStreamGeometry(result.data)) {
        logger.debug(`Skipping cache for ${cacheKey}: contains webrtc geometry`);
      } else {
        try {
          // Ensure cache directory exists
          const cacheDir = getCacheDir(basePath);
          await filesystem.ensureDirectoryExists(cacheDir);

          // Serialize all geometries to MessagePack binary (handles GLTF, SVG)
          const serialized = serializeGeometries(result.data);
          await filesystem.writeFile(cachePath, serialized);
          logger.debug(`Cached ${result.data.length} geometries at ${cacheKey}`);

          // Cleanup old cache entries to prevent unbounded growth
          await cleanupOldCacheEntries(filesystem, cacheDir, config.maxAgeMs, config.maxEntries);
        } catch (error) {
          // Cache write error - log and continue
          logger.warn(`Cache write error for ${cacheKey}: ${String(error)}`);
        }
      }
    }

    return result;
  },
});
