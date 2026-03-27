// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- file-path keys in FileParameterConfig test data */
import { describe, it, expect } from 'vitest';
import { createMockRuntime, createMockInput, createMockCreateGeometryHandler } from '@taucad/runtime/testing';
import { parameterFileResolverMiddleware } from '#middleware/parameter-file-resolver.middleware.js';

type ParameterFileOptions = { parametersFile: string; watchDebounceMs: number };

function createTestContext(options?: {
  readFileResult?: string;
  readFileError?: Error;
  input?: Parameters<typeof createMockInput>[0];
}) {
  const runtime = createMockRuntime<Record<string, never>, ParameterFileOptions>({
    options: { parametersFile: '.tau/parameters.json', watchDebounceMs: 200 },
  });

  if (options?.readFileError) {
    runtime.filesystem.mocks.readFile.mockRejectedValue(options.readFileError);
  } else if (options?.readFileResult !== undefined) {
    runtime.filesystem.mocks.readFile.mockResolvedValue(options.readFileResult);
  }

  return {
    runtime,
    input: createMockInput({
      filePath: '/projects/test/main.ts',
      basePath: '/projects/test',
      parameters: { width: 10 },
      ...options?.input,
    }),
    handler: createMockCreateGeometryHandler(),
  };
}

function makeConfig(files: Record<string, unknown>, version = 1): string {
  return JSON.stringify({ version, files });
}

describe('parameterFileResolverMiddleware', () => {
  it('should have correct name', () => {
    expect(parameterFileResolverMiddleware.name).toBe('parameter-file-resolver');
  });

  it('should merge file override values into input parameters', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({
        'main.ts': {
          activeSet: 'default',
          sets: { default: { values: { width: 99, height: 50 } } },
        },
      }),
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { width: 99, height: 50 },
      }),
    );
  });

  it('should pass through when file does not exist', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileError: new Error('ENOENT: file not found'),
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(input);
  });

  it('should pass through when JSON is invalid', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: '{invalid json',
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(input);
  });

  it('should pass through when version is not 1', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({}, 2),
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(input);
  });

  it('should pass through when no file entry exists for current file', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({
        'other.ts': {
          activeSet: 'default',
          sets: { default: { values: { size: 5 } } },
        },
      }),
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(input);
  });

  it('should register watch path with 200ms debounce', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({}),
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(runtime.registerWatchPath).toHaveBeenCalledWith('/projects/test/.tau/parameters.json', { debounceMs: 200 });
  });

  it('should preserve existing input parameters when no file overrides apply', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({
        'main.ts': {
          activeSet: 'empty',
          sets: { empty: { values: {} } },
        },
      }),
      input: { parameters: { width: 10, depth: 5 } },
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { width: 10, depth: 5 },
      }),
    );
  });

  it('should override specific parameters while preserving others', async () => {
    const { input, handler, runtime } = createTestContext({
      readFileResult: makeConfig({
        'main.ts': {
          activeSet: 'default',
          sets: { default: { values: { width: 99 } } },
        },
      }),
      input: { parameters: { width: 10, height: 20 } },
    });

    await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: { width: 99, height: 20 },
      }),
    );
  });

  describe('nested parameter deep merge', () => {
    it('should deep-merge nested object overrides with input parameters', async () => {
      const { input, handler, runtime } = createTestContext({
        readFileResult: makeConfig({
          'main.ts': {
            activeSet: 'default',
            sets: { default: { values: { base: { cornerRadius: 10 } } } },
          },
        }),
        input: {
          parameters: {
            base: { width: 30, depth: 20, cornerRadius: 5 },
            profile: { line1X: 5, line1Y: 5 },
          },
        },
      });

      await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

      const calledParams = (handler.mock.calls[0]![0] as { parameters: Record<string, unknown> }).parameters;
      expect(calledParams).toEqual({
        base: { width: 30, depth: 20, cornerRadius: 10 },
        profile: { line1X: 5, line1Y: 5 },
      });
    });

    it('should deep-merge multiple nested groups without losing sibling properties', async () => {
      const { input, handler, runtime } = createTestContext({
        readFileResult: makeConfig({
          'main.ts': {
            activeSet: 'default',
            sets: {
              default: {
                values: {
                  base: { cornerRadius: 10 },
                  brim: { height: 3 },
                },
              },
            },
          },
        }),
        input: {
          parameters: {
            base: { width: 30, depth: 20, cornerRadius: 5 },
            profile: { line1X: 5 },
            brim: { width: 2, height: 1 },
          },
        },
      });

      await parameterFileResolverMiddleware.wrapCreateGeometry!(input, handler, runtime);

      const calledParams = (handler.mock.calls[0]![0] as { parameters: Record<string, unknown> }).parameters;
      expect(calledParams).toEqual({
        base: { width: 30, depth: 20, cornerRadius: 10 },
        profile: { line1X: 5 },
        brim: { width: 2, height: 3 },
      });
    });
  });

  describe('getDependencies', () => {
    it('should return the parameters file path', () => {
      const result = parameterFileResolverMiddleware.getDependencies!(
        { filePath: '/projects/test/main.ts', basePath: '/projects/test' },
        { parametersFile: '.tau/parameters.json' },
      );

      expect(result).toEqual(['/projects/test/.tau/parameters.json']);
    });

    it('should use custom parametersFile option', () => {
      const result = parameterFileResolverMiddleware.getDependencies!(
        { filePath: '/projects/test/main.ts', basePath: '/projects/test' },
        { parametersFile: '.config/params.json' },
      );

      expect(result).toEqual(['/projects/test/.config/params.json']);
    });

    it('should return synchronously (not a promise)', () => {
      const result = parameterFileResolverMiddleware.getDependencies!(
        { filePath: '/projects/test/main.ts', basePath: '/projects/test' },
        { parametersFile: '.tau/parameters.json' },
      );

      expect(Array.isArray(result)).toBe(true);
    });
  });
});
