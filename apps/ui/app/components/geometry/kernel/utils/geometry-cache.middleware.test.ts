/**
 * Tests for the geometry cache middleware.
 * Tests the wrap-style hook with onion model execution.
 */

import { describe, it, expect, vi } from 'vitest';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import type {
  CreateGeometryResult,
  CreateGeometryHandler,
  Dependency,
  CreateGeometryInput,
  KernelMiddlewareRuntime,
} from '@taucad/types';
import { geometryCacheMiddleware } from '#components/geometry/kernel/utils/geometry-cache.middleware.js';
import {
  createMockRuntime,
  createMockInput,
  createGltfSuccessResult,
  createErrorResult,
} from '#components/geometry/kernel/utils/kernel-testing.utils.js';

/**
 * Create mock dependencies for testing.
 */
function createMockDependencies(overrides?: Array<Partial<Dependency>>): readonly Dependency[] {
  const defaults: Dependency[] = [
    { type: 'file', path: 'test.kcl', contentHash: 'abc123' },
    { type: 'middleware', name: 'TestMiddleware', version: '1', index: 0 },
    { type: 'framework', name: 'tau', version: '0.0.1' },
  ];

  if (overrides) {
    return [...defaults, ...(overrides as Dependency[])];
  }

  return defaults;
}

/**
 * Create serialized cache content (MessagePack binary format).
 */
function createSerializedCacheContent(content: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  // Serialize using MessagePack (same as the middleware does)
  return msgpackEncode({
    version: 1,
    geometries: [{ format: 'gltf', content }],
  }) as Uint8Array<ArrayBuffer>;
}

/**
 * Create input and runtime for cache testing.
 */

function createCacheTestContext(options?: {
  cacheExists?: boolean;
  cachedContent?: Uint8Array<ArrayBuffer>;
  input?: Parameters<typeof createMockInput>[0];
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
}): {
  input: CreateGeometryInput;

  runtime: KernelMiddlewareRuntime & ReturnType<typeof createMockRuntime>;
} {
  // Create serialized content if cachedContent is provided (MessagePack binary format)
  const serializedContent = options?.cachedContent
    ? createSerializedCacheContent(options.cachedContent)
    : new Uint8Array();

  const runtime = createMockRuntime({
    filesystemOverrides: {
      existsResult: options?.cacheExists ?? false,
      readFileResult: serializedContent,
    },
    dependencies: options?.dependencies ?? createMockDependencies(),
    dependencyHash: options?.dependencyHash ?? 'a'.repeat(64),
  });

  return {
    input: createMockInput(options?.input),

    runtime: runtime as KernelMiddlewareRuntime & ReturnType<typeof createMockRuntime>,
  };
}

/**
 * Create a mock handler for testing.
 */
function createMockHandler(result?: CreateGeometryResult): CreateGeometryHandler {
  return vi.fn().mockResolvedValue(result ?? createGltfSuccessResult(new Uint8Array([1, 2, 3])));
}

describe('geometryCacheMiddleware', () => {
  describe('wrapCreateGeometry', () => {
    describe('cache hit', () => {
      it('should return cached result and not call handler', async () => {
        const gltfContent = new Uint8Array([1, 2, 3, 4]);

        const { input, runtime } = createCacheTestContext({
          cacheExists: true,
          cachedContent: gltfContent,
        });
        const handler = createMockHandler();

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        expect(wrapCreateGeometry).toBeDefined();

        const result = await wrapCreateGeometry!(input, handler, runtime);

        // Handler should not be called on cache hit
        expect(handler).not.toHaveBeenCalled();

        // Result should be from cache
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data).toHaveLength(1);
          expect(result.data[0]?.format).toBe('gltf');
          if (result.data[0]?.format === 'gltf') {
            // Content should be the cached Uint8Array
            expect(result.data[0].content).toBeInstanceOf(Uint8Array);
            expect(result.data[0].content).toEqual(gltfContent);
          } else {
            throw new Error(`Unexpected geometry format: ${result.data[0]?.format}`);
          }
        }
      });

      it('should log cache hit message', async () => {
        const gltfContent = new Uint8Array([1, 2, 3]);
        const { input, runtime } = createCacheTestContext({
          cacheExists: true,
          cachedContent: gltfContent,
        });
        const handler = createMockHandler();

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache hit'));
      });
    });

    describe('cache miss', () => {
      it('should call handler and return its result', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([5, 6, 7]));
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        const result = await wrapCreateGeometry!(input, handler, runtime);

        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should log cache miss message', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler();

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache miss'));
      });

      it('should write result to cache after handler returns', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writePath = runtime.filesystem.mocks.writeFile.mock.calls[0]?.[0];
        expect(writePath).toContain('.tau/cache/geometry');
        expect(writePath).toContain('.bin');
      });

      it('should ensure cache directory exists before writing', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.filesystem.mocks.ensureDirectoryExists).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const dirPath = runtime.filesystem.mocks.ensureDirectoryExists.mock.calls[0]?.[0];
        expect(dirPath).toContain('.tau/cache/geometry');
      });

      it('should log cache write message', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cached 1 geometries'));
      });

      it('should not cache failed results', async () => {
        const errorResult = createErrorResult();
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handler = createMockHandler(errorResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        expect(runtime.filesystem.mocks.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('dependency hash usage', () => {
      it('should use runtime.dependencyHash for cache path', async () => {
        const dependencyHash = 'b'.repeat(64);
        const { input, runtime } = createCacheTestContext({
          cacheExists: false,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Verify that writeFile was called with a path containing the dependency hash
        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalledWith(
          expect.stringContaining(dependencyHash),
          expect.any(Uint8Array),
        );
      });

      it('should use runtime.dependencyHash for cache lookup', async () => {
        const dependencyHash = 'c'.repeat(64);
        const cachedContent = new Uint8Array([1, 2, 3]);
        const { input, runtime } = createCacheTestContext({
          cacheExists: true,
          cachedContent,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Verify that exists was called with a path containing the dependency hash
        expect(runtime.filesystem.mocks.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
      });
    });

    describe('error handling', () => {
      it('should handle file read errors gracefully', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: true });
        // Make readFile throw an error
        runtime.filesystem.mocks.readFile.mockRejectedValue(new Error('Read error'));

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        const result = await wrapCreateGeometry!(input, handler, runtime);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should handle file write errors gracefully', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        // Make writeFile throw an error
        runtime.filesystem.mocks.writeFile.mockRejectedValue(new Error('Write error'));

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        // Should not throw, just log warning
        const result = await wrapCreateGeometry!(input, handler, runtime);

        expect(result).toBe(handlerResult);
        expect(runtime.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Cache write error'));
      });
    });

    describe('webrtc handling', () => {
      it('should skip caching when result contains webrtc geometry', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        // Create a handler that returns webrtc geometry
        const mockStream = new ReadableStream();
        const videoStreamResult = {
          success: true as const,
          data: [{ format: 'webrtc' as const, stream: mockStream }],
          issues: [],
        };
        const handler = createMockHandler(videoStreamResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        const result = await wrapCreateGeometry!(input, handler, runtime);

        // Handler should be called
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(videoStreamResult);

        // Should NOT write to cache
        expect(runtime.filesystem.mocks.writeFile).not.toHaveBeenCalled();
        // Should log that caching was skipped
        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Skipping cache'));
        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('webrtc'));
      });

      it('should cache when result contains only GLTF geometry', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Should write to cache
        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalled();
      });

      it('should skip caching when result contains mixed geometries including webrtc', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        // Mixed result with both GLTF and webrtc
        const mockStream = new ReadableStream();
        const mixedResult = {
          success: true as const,
          data: [
            { format: 'gltf' as const, content: new Uint8Array([1, 2, 3]) },
            { format: 'webrtc' as const, stream: mockStream },
          ],
          issues: [],
        };
        const handler = createMockHandler(mixedResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Should NOT write to cache when any geometry is webrtc
        expect(runtime.filesystem.mocks.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('cache cleanup', () => {
      it('should call cleanup after successful cache write', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // GetDirectoryStat should be called for cleanup
        expect(runtime.filesystem.mocks.getDirectoryStat).toHaveBeenCalled();
      });

      it('should delete old cache entries', async () => {
        const now = Date.now();
        const oldMtimeMs = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago (older than 7 day max age)
        const { input, runtime } = createCacheTestContext({ cacheExists: false });

        // Mock getDirectoryStat to return old cache files
        runtime.filesystem.mocks.getDirectoryStat.mockResolvedValue([
          { path: 'old-cache.bin', name: 'old-cache.bin', type: 'file', size: 100, mtimeMs: oldMtimeMs },
        ]);

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Should delete old cache file
        expect(runtime.filesystem.mocks.unlink).toHaveBeenCalled();
      });

      it('should delete excess cache entries when over max count', async () => {
        const now = Date.now();
        const { input, runtime } = createCacheTestContext({ cacheExists: false });

        // Create 102 files (2 over the 100 max)

        const manyFiles = Array.from({ length: 102 }, (_, index) => ({
          path: `cache-${index}.bin`,
          name: `cache-${index}.bin`,
          type: 'file' as const,
          size: 100,
          // Stagger mtimeMs so we can predict which get deleted (oldest first)
          mtimeMs: now - index * 1000,
        }));

        runtime.filesystem.mocks.getDirectoryStat.mockResolvedValue(manyFiles);

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        await wrapCreateGeometry!(input, handler, runtime);

        // Should delete 2 oldest files to get to 100
        expect(runtime.filesystem.mocks.unlink).toHaveBeenCalledTimes(2);
      });

      it('should handle cleanup errors gracefully', async () => {
        const { input, runtime } = createCacheTestContext({ cacheExists: false });

        // Make getDirectoryStat throw an error
        runtime.filesystem.mocks.getDirectoryStat.mockRejectedValue(new Error('Stat error'));

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapCreateGeometry } = geometryCacheMiddleware;
        // Should not throw, cleanup errors are non-fatal
        const result = await wrapCreateGeometry!(input, handler, runtime);

        expect(result.success).toBe(true);
        // Cache write should still have happened
        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalled();
      });
    });
  });

  describe('cache key behavior with parameter changes', () => {
    it('should use dependencyHash for cache key lookup', async () => {
      const dependencyHash = 'abc123'.repeat(11).slice(0, 64);
      const cachedContent = new Uint8Array([1, 2, 3]);
      const serializedContent = createSerializedCacheContent(cachedContent);

      const runtime = createMockRuntime({
        filesystemOverrides: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies(),
        dependencyHash,
      });

      const input = createMockInput();
      const handler: CreateGeometryHandler = vi.fn();

      const { wrapCreateGeometry } = geometryCacheMiddleware;

      await wrapCreateGeometry!(input, handler, runtime as KernelMiddlewareRuntime);

      // Verify cache was checked at the correct path using the dependency hash
      expect(runtime.filesystem.mocks.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
    });

    it('should result in cache miss when dependencyHash differs (simulating parameter change)', async () => {
      // Different dependency hash simulates a parameter change
      const dependencyHash = 'hash2'.repeat(13).slice(0, 64);

      // Cache doesn't exist for this new hash
      const runtime = createMockRuntime({
        filesystemOverrides: {
          existsResult: false,
        },
        dependencies: createMockDependencies([{ type: 'parameter', parametersHash: 'newParams123' }]),
        dependencyHash,
      });

      const input = createMockInput();

      const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
      const handler: CreateGeometryHandler = vi.fn().mockResolvedValue(handlerResult);

      const { wrapCreateGeometry } = geometryCacheMiddleware;

      await wrapCreateGeometry!(input, handler, runtime as KernelMiddlewareRuntime);

      // Handler should be called because cache missed
      expect(handler).toHaveBeenCalled();
    });

    it('should result in cache hit when dependencyHash is identical', async () => {
      const dependencyHash = 'same'.repeat(16);
      const cachedContent = new Uint8Array([1, 2, 3]);
      const serializedContent = createSerializedCacheContent(cachedContent);

      const runtime = createMockRuntime({
        filesystemOverrides: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies([{ type: 'parameter', parametersHash: 'sameParams' }]),
        dependencyHash,
      });

      const input = createMockInput();

      const handler: CreateGeometryHandler = vi.fn();

      const { wrapCreateGeometry } = geometryCacheMiddleware;

      await wrapCreateGeometry!(input, handler, runtime as KernelMiddlewareRuntime);

      // Handler should NOT be called because cache hit
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
