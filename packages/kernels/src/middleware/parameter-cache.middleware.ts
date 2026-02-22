/**
 * Parameter Cache Middleware
 *
 * Caches getParameters results to avoid redundant parameter parsing.
 * Uses the pre-computed dependency hash from the runtime environment.
 *
 * Uses wrap-style hooks with onion model:
 * 1. Check cache - if hit, return cached result (short-circuit)
 * 2. If miss, call handler() to execute downstream
 * 3. Write result to cache on the way back up
 */

import type { GetParametersResult } from '@taucad/types';
import { joinPath } from '@taucad/utils/path';
import { createKernelMiddleware } from '#middleware/kernel-middleware.js';

/**
 * Get the cache file path for a given cache key.
 *
 * @param basePath - The base path for the build
 * @param cacheKey - The cache key
 * @returns The full path to the cache file
 */
function getCachePath(basePath: string, cacheKey: string): string {
  return joinPath(basePath, '.tau/cache/parameters', `${cacheKey}.json`);
}

/**
 * Get the cache directory path.
 *
 * @param basePath - The base path for the build
 * @returns The full path to the cache directory
 */
function getCacheDir(basePath: string): string {
  return joinPath(basePath, '.tau/cache/parameters');
}

/**
 * Parameter cache middleware.
 *
 * Caches getParameters results based on file dependencies.
 * Uses wrap-style hook with onion model execution:
 * - Check cache before calling handler()
 * - Write to cache after handler() returns (on cache miss)
 */
export const parameterCacheMiddleware = createKernelMiddleware({
  name: 'ParameterCache',
  version: '1.0.0',

  async wrapGetParameters(input, handler, { logger, filesystem, dependencyHash }) {
    const { basePath } = input;

    // Use pre-computed dependency hash as cache key
    const cacheKey = dependencyHash;
    const cachePath = getCachePath(basePath, cacheKey);

    // 2. Try reading cache directly (single round-trip instead of exists + readFile)
    try {
      const cachedData = await filesystem.readFile(cachePath, 'utf8');
      logger.debug(`Parameter cache hit for ${cacheKey}`);

      const cachedResult = JSON.parse(cachedData) as GetParametersResult;
      return cachedResult;
    } catch (error) {
      // Cache miss or read error - proceed to compute
      logger.debug(`Parameter cache miss for ${cacheKey}: ${String(error)}`);
    }

    // 3. Cache miss - execute downstream
    logger.debug(`Parameter cache miss for ${cacheKey}`);
    const result = await handler(input);

    // 4. Write to cache on the way back up
    if (result.success) {
      try {
        // Ensure cache directory exists
        const cacheDir = getCacheDir(basePath);
        await filesystem.ensureDirectoryExists(cacheDir);

        await filesystem.writeFile(cachePath, JSON.stringify(result));
        logger.debug(`Cached parameters at ${cacheKey}`);
      } catch (error) {
        // Cache write error - log and continue
        logger.warn(`Parameter cache write error for ${cacheKey}: ${String(error)}`);
      }
    }

    return result;
  },
});
