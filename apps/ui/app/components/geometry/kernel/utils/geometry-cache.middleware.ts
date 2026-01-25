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
 *
 * For exportGeometry, retrieves the pre-transform geometry from the cache.
 * Throws an error if cache is missing (architecture guarantees compute runs before export).
 */

import { z } from 'zod';
import { uint8ArrayToBase64, base64ToUint8Array } from 'uint8array-extras';
import type {
  ComputeGeometryResult,
  ComputeGeometryRequest,
  ComputeGeometryHandler,
  ExportGeometryResult,
  ExportGeometryRequest,
  ExportGeometryHandler,
  GeometryBase,
  GeometryGltf,
  MiddlewareFileManager,
} from '@taucad/types';
import { createKernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { createKernelError, createKernelSuccess } from '#components/geometry/kernel/utils/kernel-helpers.js';

/**
 * Schema for the cache middleware state.
 * State persists for the duration of one wrap hook execution.
 */
const cacheStateSchema = z.object({
  /** Whether the cache was hit */
  cacheHit: z.boolean(),
  /** The base path (needed for export) */
  basePath: z.string(),
});

type CacheState = z.infer<typeof cacheStateSchema>;

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
  | { format: 'video-stream' }; // Cannot cache streams, just store format marker

/**
 * Serialize geometries for cache storage.
 * Converts Uint8Array to base64 for GLTF, passes through other types.
 * Hash is NOT stored - it's derived from the cache key.
 *
 * @param geometries - The geometries to serialize
 * @returns JSON string of serialized geometries
 */
function serializeGeometries(geometries: readonly GeometryBase[]): string {
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

      case 'video-stream': {
        // Cannot cache streams - store marker only
        return { format: 'video-stream' };
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
 * @returns The deserialized geometries (excluding video-stream which can't be cached)
 */
function deserializeGeometries(data: string): GeometryBase[] {
  const serialized = JSON.parse(data) as SerializedGeometry[];
  const geometries: GeometryBase[] = [];

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

      case 'video-stream': {
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
 * Check if any geometries in the result have video-stream format.
 * Video-stream geometries cannot be cached as they contain live streams.
 *
 * @param geometries - The geometries to check
 * @returns True if any geometry is a video-stream
 */
function hasVideoStreamGeometry(geometries: readonly GeometryBase[]): boolean {
  return geometries.some((geometry) => geometry.format === 'video-stream');
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
 * For exportGeometry:
 * - Retrieves pre-transform geometry from cache
 * - Throws error if cache miss (should never happen given architecture)
 */
export const geometryCacheMiddleware = createKernelMiddleware({
  name: 'GeometryCache',
  version: '2.0.0',
  stateSchema: cacheStateSchema,

  async wrapComputeGeometry(
    request: ComputeGeometryRequest<CacheState>,
    handler: ComputeGeometryHandler<CacheState>,
  ): Promise<ComputeGeometryResult> {
    const { input, runtime } = request;

    // Use pre-computed dependency hash as cache key
    const cacheKey = runtime.dependencyHash;
    const cachePath = getCachePath(input.basePath, cacheKey);

    // 1. Check if cache exists
    try {
      const cacheExists = await runtime.fileManager.exists(cachePath);

      if (cacheExists) {
        // Cache hit - read and return cached result
        runtime.state.update({ cacheHit: true, basePath: input.basePath });
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
    runtime.state.update({ cacheHit: false, basePath: input.basePath });
    runtime.logger.debug(`Cache miss for ${cacheKey}`);
    const result = await handler(request);

    // 4. Write to cache on the way back up (skip if video-stream geometries present)
    if (result.success && result.data.length > 0) {
      // Skip caching if any geometry is a video-stream - these cannot be cached
      // and would result in incomplete data on cache hit
      if (hasVideoStreamGeometry(result.data)) {
        runtime.logger.debug(`Skipping cache for ${cacheKey}: contains video-stream geometry`);
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

  async wrapExportGeometry(
    request: ExportGeometryRequest<CacheState>,
    handler: ExportGeometryHandler<CacheState>,
  ): Promise<ExportGeometryResult> {
    const { runtime } = request;
    const { basePath } = runtime.state.value;

    // Use pre-computed dependency hash as cache key
    const cacheKey = runtime.dependencyHash;

    // Cache should always exist at this point - computeGeometry runs before exportGeometry
    if (!basePath) {
      return createKernelError([
        {
          message: 'Export failed: geometry not computed. This indicates a bug in the kernel architecture.',
          type: 'kernel',
          severity: 'error',
        },
      ]);
    }

    const cachePath = getCachePath(basePath, cacheKey);

    try {
      const cacheExists = await runtime.fileManager.exists(cachePath);

      if (!cacheExists) {
        // This should never happen given the architecture
        return createKernelError([
          {
            message: `Export failed: cached geometry not found at ${cacheKey}. This indicates a bug in the caching middleware.`,
            type: 'kernel',
            severity: 'error',
          },
        ]);
      }

      // Read and deserialize geometry from cache
      const cachedData = await runtime.fileManager.readFile(cachePath, 'utf8');
      const geometries = deserializeGeometries(cachedData);

      // For GLTF/GLB export, find GLTF geometry and return it
      if (request.input.fileType === 'gltf' || request.input.fileType === 'glb') {
        const gltfGeometry = geometries.find((g): g is GeometryGltf => g.format === 'gltf');

        if (!gltfGeometry) {
          return createKernelError([
            {
              message: 'Export failed: no GLTF geometry found in cache.',
              type: 'kernel',
              severity: 'error',
            },
          ]);
        }

        const blob = new Blob([gltfGeometry.content], { type: 'model/gltf-binary' });
        const filename = request.input.fileType === 'glb' ? 'model.glb' : 'model.gltf';

        return createKernelSuccess([{ blob, name: filename }]);
      }

      // For other formats, delegate to the worker's export logic
      return await handler(request);
    } catch (error) {
      return createKernelError([
        {
          message: `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'kernel',
          severity: 'error',
        },
      ]);
    }
  },
});
