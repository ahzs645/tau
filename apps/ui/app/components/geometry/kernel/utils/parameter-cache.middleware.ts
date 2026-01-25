/**
 * Parameter Cache Middleware
 *
 * Caches extractParameters results to avoid redundant parameter parsing.
 * Uses the pre-computed dependency hash from the runtime environment.
 *
 * Uses wrap-style hooks with onion model:
 * 1. Check cache - if hit, return cached result (short-circuit)
 * 2. If miss, call handler() to execute downstream
 * 3. Write result to cache on the way back up
 */

import type { ExtractParametersResult, ExtractParametersRequest, ExtractParametersHandler } from '@taucad/types';
import { createKernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';

/**
 * Get the cache file path for a given cache key.
 *
 * @param basePath - The base path for the build
 * @param cacheKey - The cache key
 * @returns The full path to the cache file
 */
function getCachePath(basePath: string, cacheKey: string): string {
  return `${basePath}/.tau/cache/params/${cacheKey}.json`;
}

/**
 * Get the cache directory path.
 *
 * @param basePath - The base path for the build
 * @returns The full path to the cache directory
 */
function getCacheDir(basePath: string): string {
  return `${basePath}/.tau/cache/params`;
}

/**
 * Parameter cache middleware.
 *
 * Caches extractParameters results based on file dependencies.
 * Uses wrap-style hook with onion model execution:
 * - Check cache before calling handler()
 * - Write to cache after handler() returns (on cache miss)
 */
export const parameterCacheMiddleware = createKernelMiddleware({
  name: 'ParameterCache',
  version: '1.0.0',

  async wrapExtractParameters(
    request: ExtractParametersRequest,
    handler: ExtractParametersHandler,
  ): Promise<ExtractParametersResult> {
    const { input, runtime } = request;

    // Use pre-computed dependency hash as cache key
    const cacheKey = runtime.dependencyHash;
    const cachePath = getCachePath(input.basePath, cacheKey);

    // 2. Check if cache exists
    try {
      const cacheExists = await runtime.fileManager.exists(cachePath);

      if (cacheExists) {
        // Cache hit - read and return cached result
        runtime.logger.debug(`Parameter cache hit for ${cacheKey}`);

        const cachedData = await runtime.fileManager.readFile(cachePath, 'utf8');
        const cachedResult = JSON.parse(cachedData) as ExtractParametersResult;

        return cachedResult;
      }
    } catch (error) {
      // Cache read error - treat as cache miss
      runtime.logger.debug(`Parameter cache read error for ${cacheKey}: ${String(error)}`);
    }

    // 3. Cache miss - execute downstream
    runtime.logger.debug(`Parameter cache miss for ${cacheKey}`);
    const result = await handler(request);

    // 4. Write to cache on the way back up
    if (result.success) {
      try {
        // Ensure cache directory exists
        const cacheDir = getCacheDir(input.basePath);
        await runtime.fileManager.ensureDirectoryExists(cacheDir);

        await runtime.fileManager.writeFile(cachePath, JSON.stringify(result));
        runtime.logger.debug(`Cached parameters at ${cacheKey}`);
      } catch (error) {
        // Cache write error - log and continue
        runtime.logger.warn(`Parameter cache write error for ${cacheKey}: ${String(error)}`);
      }
    }

    return result;
  },
});
