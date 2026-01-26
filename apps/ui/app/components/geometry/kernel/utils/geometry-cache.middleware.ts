/**
 * Geometry Cache Middleware
 *
 * Caches computeGeometry results to avoid redundant kernel computations.
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
 */

import { uint8ArrayToBase64, base64ToUint8Array } from 'uint8array-extras';
import type { ComputeGeometryResult, GeometryResponse, MiddlewareFileManager } from '@taucad/types';
import { createKernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';

/**
 * Serialized geometry format for cache storage.
 * GLTF content is stored as base64 string, other types are stored as-is.
 * Hash is NOT stored - it's the cache key (filename), not the content.
 */
type SerializedGeometry =
  | { format: 'gltf'; content: string } // Base64-encoded Uint8Array
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
 * Serialize geometries for cache storage.
 * Converts Uint8Array to base64 for GLTF, passes through other types.
 * Hash is NOT stored - it's derived from the cache key.
 *
 * @param geometries - The geometries to serialize
 * @returns JSON string of serialized geometries
 */
function serializeGeometries(geometries: readonly GeometryResponse[]): string {
  const serialized: SerializedGeometry[] = geometries.map((geometry): SerializedGeometry => {
    switch (geometry.format) {
      case 'gltf': {
        // Convert Uint8Array to base64 string using uint8array-extras
        const base64 = uint8ArrayToBase64(geometry.content);

        return { format: 'gltf', content: base64 };
      }

      case 'svg': {
        // SVG is already JSON-serializable
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

  return JSON.stringify(serialized);
}

/**
 * Deserialize geometries from cache storage.
 * Converts base64 back to Uint8Array for GLTF, passes through other types.
 * Returns GeometryBase (without hash) - hash is added by kernel-worker.ts.
 *
 * @param data - JSON string of serialized geometries
 * @returns The deserialized geometries (excluding webrtc which can't be cached)
 */
function deserializeGeometries(data: string): GeometryResponse[] {
  const serialized = JSON.parse(data) as SerializedGeometry[];
  const geometries: GeometryResponse[] = [];

  for (const item of serialized) {
    switch (item.format) {
      case 'gltf': {
        // Convert base64 back to Uint8Array using uint8array-extras
        const content = base64ToUint8Array(item.content);

        geometries.push({ format: 'gltf', content });
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
 * Uses .json extension for JSON storage of all geometry types.
 *
 * @param basePath - The base path for the build
 * @param cacheKey - The cache key
 * @returns The full path to the cache file
 */
function getCachePath(basePath: string, cacheKey: string): string {
  return `${basePath}/.tau/cache/geometry/${cacheKey}.json`;
}

/**
 * Get the cache directory path.
 *
 * @param basePath - The base path for the build
 * @returns The full path to the cache directory
 */
function getCacheDir(basePath: string): string {
  return `${basePath}/.tau/cache/geometry`;
}

/**
 * Maximum number of cache entries to keep.
 * Uses LRU-style eviction based on file modification time.
 */
const maxCacheEntries = 100;

/**
 * Maximum age for cache entries in milliseconds (7 days).
 * Entries older than this are eligible for cleanup.
 */
const maxCacheAgeMs = 7 * 24 * 60 * 60 * 1000;

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
 * @param fileManager - The file manager for filesystem operations
 * @param cacheDir - The cache directory path
 * @param maxAgeMs - Maximum age in milliseconds for cache entries
 * @param maxEntries - Maximum number of cache entries to keep
 */
async function cleanupOldCacheEntries(
  fileManager: MiddlewareFileManager,
  cacheDir: string,
  maxAgeMs: number,
  maxEntries: number,
): Promise<void> {
  try {
    const files = await fileManager.getDirectoryStat(cacheDir);

    // Filter to only .json cache files
    const cacheFiles = files.filter((file) => file.type === 'file' && file.name.endsWith('.json'));

    if (cacheFiles.length === 0) {
      return;
    }

    const now = Date.now();
    const filesToDelete: string[] = [];

    // First pass: identify files older than maxAgeMs
    for (const file of cacheFiles) {
      const age = now - file.mtimeMs;
      if (age > maxAgeMs) {
        filesToDelete.push(`${cacheDir}/${file.path}`);
      }
    }

    // Second pass: if still over maxEntries, delete oldest files
    const remainingFiles = cacheFiles.filter((file) => {
      const fullPath = `${cacheDir}/${file.path}`;
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
          filesToDelete.push(`${cacheDir}/${file.path}`);
        }
      }
    }

    // Delete identified files
    await Promise.all(filesToDelete.map(async (path) => fileManager.unlink(path)));
  } catch {
    // Cleanup errors are non-fatal - silently ignore
  }
}

/**
 * Geometry cache middleware.
 *
 * Caches computeGeometry results based on all dependencies (files, middleware, framework, options).
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

  async wrapComputeGeometry(request, handler): Promise<ComputeGeometryResult> {
    const { input, runtime } = request;

    // Use pre-computed dependency hash as cache key
    const cacheKey = runtime.dependencyHash;
    const cachePath = getCachePath(input.basePath, cacheKey);

    // 1. Check if cache exists
    try {
      const cacheExists = await runtime.fileManager.exists(cachePath);

      if (cacheExists) {
        // Cache hit - read and return cached result
        runtime.logger.debug(`Cache hit for ${cacheKey}`);

        // Read and deserialize all geometry types from JSON
        const cachedData = await runtime.fileManager.readFile(cachePath, 'utf8');
        const geometries = deserializeGeometries(cachedData);

        // Short-circuit: return cached result
        // This still flows through upstream middleware on the "return journey"
        return createKernelSuccess(geometries);
      }
    } catch (error) {
      // Cache read error - treat as cache miss
      runtime.logger.debug(`Cache read error for ${cacheKey}: ${String(error)}`);
    }

    // 2. Cache miss - execute downstream
    runtime.logger.debug(`Cache miss for ${cacheKey}`);
    const result = await handler(request);

    // 4. Write to cache on the way back up (skip if webrtc geometries present)
    if (result.success && result.data.length > 0) {
      // Skip caching if any geometry is a webrtc - these cannot be cached
      // and would result in incomplete data on cache hit
      if (hasVideoStreamGeometry(result.data)) {
        runtime.logger.debug(`Skipping cache for ${cacheKey}: contains webrtc geometry`);
      } else {
        try {
          // Ensure cache directory exists
          const cacheDir = getCacheDir(input.basePath);
          await runtime.fileManager.ensureDirectoryExists(cacheDir);

          // Serialize all geometries to JSON (handles GLTF, SVG)
          const serialized = serializeGeometries(result.data);
          await runtime.fileManager.writeFile(cachePath, serialized);
          runtime.logger.debug(`Cached ${result.data.length} geometries at ${cacheKey}`);

          // Cleanup old cache entries to prevent unbounded growth
          await cleanupOldCacheEntries(runtime.fileManager, cacheDir, maxCacheAgeMs, maxCacheEntries);
        } catch (error) {
          // Cache write error - log and continue
          runtime.logger.warn(`Cache write error for ${cacheKey}: ${String(error)}`);
        }
      }
    }

    return result;
  },
});
