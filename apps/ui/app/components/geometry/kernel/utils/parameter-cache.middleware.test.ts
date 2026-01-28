/**
 * Tests for the parameter cache middleware.
 * Tests the wrap-style hook with onion model execution.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  GetParametersResult,
  GetParametersInput,
  GetParametersHandler,
  Dependency,
  KernelMiddlewareRuntime,
} from '@taucad/types';
import { parameterCacheMiddleware } from '#components/geometry/kernel/utils/parameter-cache.middleware.js';
import { createMockRuntime, createMockInput } from '#components/geometry/kernel/utils/kernel-testing.utils.js';

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

/** The data type for a successful GetParametersResult */
type GetParametersData = {
  defaultParameters: Record<string, unknown>;
  jsonSchema: unknown;
};

/**
 * Create a successful extract parameters result for testing.
 */
function createSuccessResult(overrides?: Partial<GetParametersData>): GetParametersResult {
  return {
    success: true,
    data: {
      defaultParameters: { width: 10, height: 20 },
      jsonSchema: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      ...overrides,
    },
    issues: [],
  };
}

/**
 * Create an error result for testing.
 */
function createErrorResult(): GetParametersResult {
  return {
    success: false,
    issues: [{ severity: 'error', message: 'Test error' }],
  };
}

/**
 * Create serialized cache content (JSON format).
 */
function createSerializedCacheContent(result: GetParametersResult): string {
  return JSON.stringify(result);
}

/**
 * Create input and runtime configured for cache testing.
 */

function createCacheContext(options?: {
  cacheExists?: boolean;
  cachedResult?: GetParametersResult;
  input?: Parameters<typeof createMockInput>[0];
  dependencies?: readonly Dependency[];
  dependencyHash?: string;
}): {
  input: GetParametersInput;

  runtime: KernelMiddlewareRuntime & ReturnType<typeof createMockRuntime>;
} {
  const serializedContent = options?.cachedResult ? createSerializedCacheContent(options.cachedResult) : '';

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
function createMockHandler(result?: GetParametersResult): GetParametersHandler {
  return vi.fn().mockResolvedValue(result ?? createSuccessResult());
}

describe('parameterCacheMiddleware', () => {
  describe('wrapGetParameters', () => {
    describe('cache hit', () => {
      it('should return cached result and not call handler', async () => {
        const cachedResult = createSuccessResult({ defaultParameters: { cached: true } });

        const { input, runtime } = createCacheContext({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        expect(wrapGetParameters).toBeDefined();

        const result = await wrapGetParameters!(input, handler, runtime);

        // Handler should not be called on cache hit
        expect(handler).not.toHaveBeenCalled();

        // Result should be from cache
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.defaultParameters).toEqual({ cached: true });
        }
      });

      it('should log cache hit message', async () => {
        const cachedResult = createSuccessResult();
        const { input, runtime } = createCacheContext({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache hit'));
      });

      it('should preserve jsonSchema from cached result', async () => {
        const cachedResult = createSuccessResult({
          jsonSchema: {
            type: 'object',
            properties: {
              customProp: { type: 'string', default: 'test' },
            },
          },
        });

        const { input, runtime } = createCacheContext({
          cacheExists: true,
          cachedResult,
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        const result = await wrapGetParameters!(input, handler, runtime);

        expect(result.success).toBe(true);
        if (result.success) {
          const schema = result.data.jsonSchema as { properties?: Record<string, unknown> };
          expect(schema.properties).toHaveProperty('customProp');
        }
      });
    });

    describe('cache miss', () => {
      it('should call handler and return its result', async () => {
        const handlerResult = createSuccessResult({ defaultParameters: { fresh: true } });
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        const result = await wrapGetParameters!(input, handler, runtime);

        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should log cache miss message', async () => {
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache miss'));
      });

      it('should write result to cache after handler returns', async () => {
        const handlerResult = createSuccessResult();
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writePath = runtime.filesystem.mocks.writeFile.mock.calls[0]?.[0];
        expect(writePath).toContain('.tau/cache/parameters');
        expect(writePath).toContain('.json');
      });

      it('should write valid JSON to cache', async () => {
        const handlerResult = createSuccessResult({ defaultParameters: { a: 1, b: 2 } });
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const writeContent = runtime.filesystem.mocks.writeFile.mock.calls[0]?.[1];
        expect(writeContent).toBeDefined();
        expect(typeof writeContent).toBe('string');

        // Should be valid JSON
        const parsed = JSON.parse(writeContent as string) as GetParametersResult;
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.defaultParameters).toEqual({ a: 1, b: 2 });
        }
      });

      it('should ensure cache directory exists before writing', async () => {
        const handlerResult = createSuccessResult();
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.filesystem.mocks.ensureDirectoryExists).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Vitest mock call args
        const dirPath = runtime.filesystem.mocks.ensureDirectoryExists.mock.calls[0]?.[0];
        expect(dirPath).toContain('.tau/cache/parameters');
      });

      it('should log cache write message', async () => {
        const handlerResult = createSuccessResult();
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Cached parameters'));
      });

      it('should not cache failed results', async () => {
        const errorResult = createErrorResult();
        const { input, runtime } = createCacheContext({ cacheExists: false });
        const handler = createMockHandler(errorResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.filesystem.mocks.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('dependency hash usage', () => {
      it('should use runtime.dependencyHash for cache path', async () => {
        const dependencyHash = 'b'.repeat(64);
        const { input, runtime } = createCacheContext({
          cacheExists: false,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        // Verify that writeFile was called with a path containing the dependency hash
        expect(runtime.filesystem.mocks.writeFile).toHaveBeenCalledWith(
          expect.stringContaining(dependencyHash),
          expect.any(String),
        );
      });

      it('should use runtime.dependencyHash for cache lookup', async () => {
        const dependencyHash = 'c'.repeat(64);
        const cachedResult = createSuccessResult();
        const { input, runtime } = createCacheContext({
          cacheExists: true,
          cachedResult,
          dependencyHash,
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        // Verify that exists was called with a path containing the dependency hash
        expect(runtime.filesystem.mocks.exists).toHaveBeenCalledWith(expect.stringContaining(dependencyHash));
      });

      it('should result in cache miss when dependencyHash differs', async () => {
        const dependencyHash = 'different'.repeat(8);
        const { input, runtime } = createCacheContext({
          cacheExists: false,
          dependencyHash,
        });

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        // Handler should be called because cache missed
        expect(handler).toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should handle file read errors gracefully', async () => {
        const { input, runtime } = createCacheContext({ cacheExists: true });
        // Make readFile throw an error
        runtime.filesystem.mocks.readFile.mockRejectedValue(new Error('Read error'));

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        const result = await wrapGetParameters!(input, handler, runtime);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });

      it('should log cache read error', async () => {
        const { input, runtime } = createCacheContext({ cacheExists: true });
        runtime.filesystem.mocks.readFile.mockRejectedValue(new Error('Read error'));

        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.logger.debug).toHaveBeenCalledWith(expect.stringContaining('cache read error'));
      });

      it('should handle file write errors gracefully', async () => {
        const { input, runtime } = createCacheContext({ cacheExists: false });
        // Make writeFile throw an error
        runtime.filesystem.mocks.writeFile.mockRejectedValue(new Error('Write error'));

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        // Should not throw, just log warning
        const result = await wrapGetParameters!(input, handler, runtime);

        expect(result).toBe(handlerResult);
        expect(runtime.logger.warn).toHaveBeenCalledWith(expect.stringContaining('cache write error'));
      });

      it('should handle JSON parse errors gracefully', async () => {
        const { input, runtime } = createCacheContext({ cacheExists: true });
        // Return invalid JSON
        runtime.filesystem.mocks.readFile.mockResolvedValue('not valid json {{{');

        const handlerResult = createSuccessResult();
        const handler = createMockHandler(handlerResult);

        const { wrapGetParameters } = parameterCacheMiddleware;
        const result = await wrapGetParameters!(input, handler, runtime);

        // Should treat as cache miss and call handler
        expect(handler).toHaveBeenCalled();
        expect(result).toBe(handlerResult);
      });
    });

    describe('cache path structure', () => {
      it('should use correct cache path format', async () => {
        const dependencyHash = 'd'.repeat(64);
        const { input, runtime } = createCacheContext({
          cacheExists: false,
          dependencyHash,
          input: { basePath: '/test/project' },
        });
        const handler = createMockHandler();

        const { wrapGetParameters } = parameterCacheMiddleware;
        await wrapGetParameters!(input, handler, runtime);

        expect(runtime.filesystem.mocks.exists).toHaveBeenCalledWith(
          `/test/project/.tau/cache/parameters/${dependencyHash}.json`,
        );
      });
    });
  });
});
