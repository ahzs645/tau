/**
 * Tests for the geometry cache middleware.
 * Tests the wrap-style hook with onion model execution.
 */

import { describe, it, expect, vi } from 'vitest';
import { uint8ArrayToBase64 } from 'uint8array-extras';
import type {
  ComputeGeometryResult,
  ComputeGeometryRequest,
  ComputeGeometryHandler,
  ExportGeometryRequest,
  ExportGeometryHandler,
  Dependency,
} from '@taucad/types';
import { geometryCacheMiddleware } from '#components/geometry/kernel/utils/geometry-cache.middleware.js';
import {
  createMockRuntime,
  createMockInput,
  createGltfSuccessResult,
  createErrorResult,
} from '#components/geometry/kernel/utils/kernel-testing.utils.js';

type CacheState = {
  cacheHit: boolean;
  basePath: string;
};

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
 * Create serialized cache content (JSON format with base64 for GLTF).
 */
function createSerializedCacheContent(content: Uint8Array, hash = 'a'.repeat(64)): string {
  // Convert Uint8Array to base64 (same as the middleware does)
  const base64 = uint8ArrayToBase64(content);

  return JSON.stringify([{ format: 'gltf', hash, content: base64 }]);
}

/**
 * Create a request with runtime configured for cache testing.
 */
function createCacheRequest(options?: {
  cacheExists?: boolean;
  cachedContent?: Uint8Array;
  input?: Parameters<typeof createMockInput>[0];
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
}): ComputeGeometryRequest<CacheState> & {
  runtime: ReturnType<typeof createMockRuntime<CacheState>>;
} {
  // Create serialized content if cachedContent is provided
  const serializedContent = options?.cachedContent
    ? createSerializedCacheContent(options.cachedContent, options.dependencyHash ?? 'a'.repeat(64))
    : '';

  const runtime = createMockRuntime<CacheState>({
    fileManagerOptions: {
      existsResult: options?.cacheExists ?? false,
      readFileResult: serializedContent,
    },
    dependencies: options?.dependencies ?? createMockDependencies(),
    dependencyHash: options?.dependencyHash ?? 'a'.repeat(64),
  });

  return {
    input: createMockInput(options?.input),
    runtime,
  };
}

/**
 * Create a mock handler for testing.
 */
function createMockHandler(result?: ComputeGeometryResult): ComputeGeometryHandler<CacheState> {
  return vi.fn().mockResolvedValue(result ?? createGltfSuccessResult(new Uint8Array([1, 2, 3])));
}

describe('geometryCacheMiddleware', () => {
  describe('wrapComputeGeometry', () => {
    describe('cache hit', () => {
      it('should return cached result and not call handler', async () => {
        const gltfContent = new Uint8Array([1, 2, 3, 4]);

        const request = createCacheRequest({
          cacheExists: true,
          cachedContent: gltfContent,
        });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        expect(wrapComputeGeometry).toBeDefined();

        const result = await wrapComputeGeometry!(request, handler);

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

      it('should update state with cacheHit: true', async () => {
        const gltfContent = new Uint8Array([1, 2, 3]);
        const request = createCacheRequest({
          cacheExists: true,
          cachedContent: gltfContent,
        });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.state.update).toHaveBeenCalled();
        expect(request.runtime.state.value.cacheHit).toBe(true);
      });

      it('should log cache hit message', async () => {
        const gltfContent = new Uint8Array([1, 2, 3]);
        const request = createCacheRequest({
          cacheExists: true,
          cachedContent: gltfContent,
        });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache hit'));
      });
    });

    describe('cache miss', () => {
      it('should call handler and return its result', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([5, 6, 7]));
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        const result = await wrapComputeGeometry!(request, handler);

        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should update state with cacheHit: false', async () => {
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.state.update).toHaveBeenCalled();
        expect(request.runtime.state.value.cacheHit).toBe(false);
      });

      it('should log cache miss message', async () => {
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cache miss'));
      });

      it('should write result to cache after handler returns', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.fileManager.writeFile).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writePath = request.runtime.fileManager.writeFile.mock.calls[0]?.[0];
        expect(writePath).toContain('.tau/cache/geometry');
        expect(writePath).toContain('.json');
      });

      it('should ensure cache directory exists before writing', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.fileManager.ensureDirectoryExists).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const dirPath = request.runtime.fileManager.ensureDirectoryExists.mock.calls[0]?.[0];
        expect(dirPath).toContain('.tau/cache/geometry');
      });

      it('should log cache write message', async () => {
        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cached 1 geometries'));
      });

      it('should not cache failed results', async () => {
        const errorResult = createErrorResult();
        const request = createCacheRequest({ cacheExists: false });
        const handler = createMockHandler(errorResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        expect(request.runtime.fileManager.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('dependency hash usage', () => {
      it('should use runtime.dependencyHash for cache path', async () => {
        const dependencyHash = 'b'.repeat(64);
        const request = createCacheRequest({
          cacheExists: false,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        // Verify that writeFile was called with a path containing the dependency hash
        expect(request.runtime.fileManager.writeFile).toHaveBeenCalledWith(
          expect.stringContaining(dependencyHash),
          expect.any(String),
        );
      });

      it('should use runtime.dependencyHash for cache lookup', async () => {
        const dependencyHash = 'c'.repeat(64);
        const cachedContent = new Uint8Array([1, 2, 3]);
        const request = createCacheRequest({
          cacheExists: true,
          cachedContent,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        await wrapComputeGeometry!(request, handler);

        // Verify that exists was called with a path containing the dependency hash
        expect(request.runtime.fileManager.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
      });
    });

    describe('error handling', () => {
      it('should handle file read errors gracefully', async () => {
        const request = createCacheRequest({ cacheExists: true });
        // Make readFile throw an error
        request.runtime.fileManager.readFile.mockRejectedValue(new Error('Read error'));

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        const result = await wrapComputeGeometry!(request, handler);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
        expect(request.runtime.state.value.cacheHit).toBe(false);
      });

      it('should handle file write errors gracefully', async () => {
        const request = createCacheRequest({ cacheExists: false });
        // Make writeFile throw an error
        request.runtime.fileManager.writeFile.mockRejectedValue(new Error('Write error'));

        const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
        const handler = createMockHandler(handlerResult);

        const { wrapComputeGeometry } = geometryCacheMiddleware;
        // Should not throw, just log warning
        const result = await wrapComputeGeometry!(request, handler);

        expect(result).toBe(handlerResult);
        expect(request.runtime.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Cache write error'));
      });
    });
  });

  describe('wrapExportGeometry', () => {
    it('should throw error when state is missing', async () => {
      const runtime = createMockRuntime<CacheState>({
        dependencies: createMockDependencies(),
      });
      // State not updated - basePath is undefined
      const request: ExportGeometryRequest<CacheState> = {
        input: { fileType: 'gltf' },
        runtime,
      };
      const handler: ExportGeometryHandler<CacheState> = vi.fn();

      const { wrapExportGeometry } = geometryCacheMiddleware;
      const result = await wrapExportGeometry!(request, handler);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain('geometry not computed');
      }
    });

    it('should return cached GLTF for gltf export', async () => {
      const cachedContent = new Uint8Array([1, 2, 3, 4]);
      const serializedContent = createSerializedCacheContent(cachedContent);
      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies(),
      });
      // Simulate state from computeGeometry
      runtime.state.update({ basePath: 'builds/test', cacheHit: true });

      const request: ExportGeometryRequest<CacheState> = {
        input: { fileType: 'gltf' },
        runtime,
      };
      const handler: ExportGeometryHandler<CacheState> = vi.fn();

      const { wrapExportGeometry } = geometryCacheMiddleware;
      const result = await wrapExportGeometry!(request, handler);

      expect(result.success).toBe(true);
      expect(handler).not.toHaveBeenCalled();

      if (result.success) {
        expect(result.data[0]?.name).toBe('model.gltf');
      }
    });

    it('should return cached GLB for glb export', async () => {
      const cachedContent = new Uint8Array([1, 2, 3, 4]);
      const serializedContent = createSerializedCacheContent(cachedContent);
      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies(),
      });
      runtime.state.update({ basePath: 'builds/test', cacheHit: true });

      const request: ExportGeometryRequest<CacheState> = {
        input: { fileType: 'glb' },
        runtime,
      };
      const handler: ExportGeometryHandler<CacheState> = vi.fn();

      const { wrapExportGeometry } = geometryCacheMiddleware;
      const result = await wrapExportGeometry!(request, handler);

      expect(result.success).toBe(true);
      expect(handler).not.toHaveBeenCalled();

      if (result.success) {
        expect(result.data[0]?.name).toBe('model.glb');
      }
    });

    it('should delegate to handler for non-GLTF formats', async () => {
      const cachedContent = new Uint8Array([1, 2, 3]);
      const serializedContent = createSerializedCacheContent(cachedContent);
      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies(),
      });
      runtime.state.update({ basePath: 'builds/test', cacheHit: true });

      const request: ExportGeometryRequest<CacheState> = {
        input: { fileType: 'stl' },
        runtime,
      };
      const handlerResult = {
        success: true as const,
        data: [{ blob: new Blob(), name: 'model.stl' }],
        issues: [],
      };
      const handler: ExportGeometryHandler<CacheState> = vi.fn().mockResolvedValue(handlerResult);

      const { wrapExportGeometry } = geometryCacheMiddleware;
      const result = await wrapExportGeometry!(request, handler);

      expect(handler).toHaveBeenCalled();
      expect(result).toBe(handlerResult);
    });

    it('should return error if cache is missing', async () => {
      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: false,
        },
        dependencies: createMockDependencies(),
      });
      runtime.state.update({ basePath: 'builds/test', cacheHit: true });

      const request: ExportGeometryRequest<CacheState> = {
        input: { fileType: 'gltf' },
        runtime,
      };
      const handler: ExportGeometryHandler<CacheState> = vi.fn();

      const { wrapExportGeometry } = geometryCacheMiddleware;
      const result = await wrapExportGeometry!(request, handler);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.message).toContain('cached geometry not found');
      }
    });
  });

  describe('cache key behavior with parameter changes', () => {
    it('should use dependencyHash for cache key lookup', async () => {
      const dependencyHash = 'abc123'.repeat(11).slice(0, 64);
      const cachedContent = new Uint8Array([1, 2, 3]);
      const serializedContent = createSerializedCacheContent(cachedContent, dependencyHash);

      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies(),
        dependencyHash,
      });

      const request = {
        input: createMockInput(),
        runtime,
      };
      const handler: ComputeGeometryHandler<CacheState> = vi.fn();

      const { wrapComputeGeometry } = geometryCacheMiddleware;
      await wrapComputeGeometry!(request, handler);

      // Verify cache was checked at the correct path using the dependency hash
      expect(runtime.fileManager.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
    });

    it('should result in cache miss when dependencyHash differs (simulating parameter change)', async () => {
      // Different dependency hash simulates a parameter change
      const dependencyHash = 'hash2'.repeat(13).slice(0, 64);

      // Cache doesn't exist for this new hash
      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: false,
        },
        dependencies: createMockDependencies([{ type: 'parameter', parametersHash: 'newParams123' }]),
        dependencyHash,
      });

      const request = {
        input: createMockInput(),
        runtime,
      };

      const handlerResult = createGltfSuccessResult(new Uint8Array([1, 2, 3]));
      const handler: ComputeGeometryHandler<CacheState> = vi.fn().mockResolvedValue(handlerResult);

      const { wrapComputeGeometry } = geometryCacheMiddleware;
      await wrapComputeGeometry!(request, handler);

      // Handler should be called because cache missed
      expect(handler).toHaveBeenCalled();
    });

    it('should result in cache hit when dependencyHash is identical', async () => {
      const dependencyHash = 'same'.repeat(16);
      const cachedContent = new Uint8Array([1, 2, 3]);
      const serializedContent = createSerializedCacheContent(cachedContent, dependencyHash);

      const runtime = createMockRuntime<CacheState>({
        fileManagerOptions: {
          existsResult: true,
          readFileResult: serializedContent,
        },
        dependencies: createMockDependencies([{ type: 'parameter', parametersHash: 'sameParams' }]),
        dependencyHash,
      });

      const request = {
        input: createMockInput(),
        runtime,
      };

      const handler: ComputeGeometryHandler<CacheState> = vi.fn();

      const { wrapComputeGeometry } = geometryCacheMiddleware;
      await wrapComputeGeometry!(request, handler);

      // Handler should NOT be called because cache hit
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
