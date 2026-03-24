import { describe, it, expect } from 'vitest';
import type { RuntimeClientOptions } from '#client/runtime-client.js';
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';
import { createRuntimeClientOptions } from '#client/runtime-client-options.js';

function kernel(id: string, extra?: Record<string, unknown>): KernelPlugin {
  return { id, moduleUrl: `https://example.com/${id}.js`, extensions: ['ts', 'js'], ...extra };
}

function middleware(id: string): MiddlewarePlugin {
  return { id, moduleUrl: `https://example.com/${id}.js` };
}

function bundler(id: string, extensions = ['ts', 'js']): BundlerPlugin {
  return { id, moduleUrl: `https://example.com/${id}.js`, extensions };
}

function baseOptions(overrides: Partial<RuntimeClientOptions> = {}): RuntimeClientOptions {
  return {
    kernels: [kernel('alpha'), kernel('beta'), kernel('gamma')],
    middleware: [middleware('cache'), middleware('transform')],
    bundlers: [bundler('esbuild')],
    ...overrides,
  };
}

describe('createRuntimeClientOptions', () => {
  // ── Identity overload ────────────────────────────────────────────────────

  describe('identity overload', () => {
    it('should return the same shape with all fields preserved', () => {
      const options = baseOptions({
        tessellation: { preview: { linearTolerance: 0.1, angularTolerance: 0.1 } },
      });

      const result = createRuntimeClientOptions(options);

      expect(result).toEqual(options);
    });

    it('should return the input reference directly', () => {
      const options = baseOptions();

      const result = createRuntimeClientOptions(options);

      expect(result).toBe(options);
    });
  });

  // ── ID-based plugin merge: replacement ───────────────────────────────────

  describe('ID-based plugin merge -- replacement', () => {
    it('should replace a kernel by ID, preserving position in array', () => {
      const base = baseOptions();
      const replacedBeta = kernel('beta', { options: { debug: true } });

      const result = createRuntimeClientOptions(base, { kernels: [replacedBeta] });

      expect(result.kernels).toHaveLength(3);
      expect(result.kernels[0]!.id).toBe('alpha');
      expect(result.kernels[1]).toEqual(replacedBeta);
      expect(result.kernels[2]!.id).toBe('gamma');
    });

    it('should replace a middleware by ID, preserving position in array', () => {
      const base = baseOptions();
      const replacedCache = middleware('cache');
      replacedCache.options = { maxSize: 100 };

      const result = createRuntimeClientOptions(base, { middleware: [replacedCache] });

      expect(result.middleware).toHaveLength(2);
      expect(result.middleware![0]).toEqual(replacedCache);
      expect(result.middleware![1]!.id).toBe('transform');
    });

    it('should replace a bundler by ID, preserving position in array', () => {
      const base = baseOptions();
      const replacedBundler = bundler('esbuild', ['tsx', 'jsx']);

      const result = createRuntimeClientOptions(base, { bundlers: [replacedBundler] });

      expect(result.bundlers).toHaveLength(1);
      expect(result.bundlers![0]).toEqual(replacedBundler);
    });

    it('should replace multiple plugins at once in the same array', () => {
      const base = baseOptions();
      const newAlpha = kernel('alpha', { options: { v2: true } });
      const newGamma = kernel('gamma', { options: { v2: true } });

      const result = createRuntimeClientOptions(base, { kernels: [newAlpha, newGamma] });

      expect(result.kernels).toHaveLength(3);
      expect(result.kernels[0]).toEqual(newAlpha);
      expect(result.kernels[1]!.id).toBe('beta');
      expect(result.kernels[2]).toEqual(newGamma);
    });

    it('should preserve all non-replaced plugins from the base', () => {
      const base = baseOptions();

      const result = createRuntimeClientOptions(base, {
        kernels: [kernel('beta', { options: { replaced: true } })],
      });

      expect(result.kernels[0]).toEqual(base.kernels[0]);
      expect(result.kernels[2]).toEqual(base.kernels[2]);
    });
  });

  // ── ID-based plugin merge: supplement ────────────────────────────────────

  describe('ID-based plugin merge -- supplement', () => {
    it('should append a kernel with a new ID to the end of the array', () => {
      const base = baseOptions();
      const newKernel = kernel('delta');

      const result = createRuntimeClientOptions(base, { kernels: [newKernel] });

      expect(result.kernels).toHaveLength(4);
      expect(result.kernels[3]).toEqual(newKernel);
    });

    it('should append multiple new plugins', () => {
      const base = baseOptions();
      const delta = kernel('delta');
      const epsilon = kernel('epsilon');

      const result = createRuntimeClientOptions(base, { kernels: [delta, epsilon] });

      expect(result.kernels).toHaveLength(5);
      expect(result.kernels[3]).toEqual(delta);
      expect(result.kernels[4]).toEqual(epsilon);
    });

    it('should handle mix of replacement and supplement in the same override array', () => {
      const base = baseOptions();
      const replacedBeta = kernel('beta', { options: { replaced: true } });
      const newDelta = kernel('delta');

      const result = createRuntimeClientOptions(base, { kernels: [replacedBeta, newDelta] });

      expect(result.kernels).toHaveLength(4);
      expect(result.kernels[0]!.id).toBe('alpha');
      expect(result.kernels[1]).toEqual(replacedBeta);
      expect(result.kernels[2]!.id).toBe('gamma');
      expect(result.kernels[3]).toEqual(newDelta);
    });
  });

  // ── ID-based plugin merge: edge cases ────────────────────────────────────

  describe('ID-based plugin merge -- edge cases', () => {
    it('should preserve entire base array when override array is empty', () => {
      const base = baseOptions();

      const result = createRuntimeClientOptions(base, { kernels: [] });

      expect(result.kernels).toEqual(base.kernels);
    });

    it('should handle override for middleware when base has no middleware', () => {
      const base: RuntimeClientOptions = { kernels: [kernel('alpha')] };
      const newMiddleware = middleware('cache');

      const result = createRuntimeClientOptions(base, { middleware: [newMiddleware] });

      expect(result.middleware).toEqual([newMiddleware]);
    });

    it('should handle override for bundlers when base has no bundlers', () => {
      const base: RuntimeClientOptions = { kernels: [kernel('alpha')] };
      const newBundler = bundler('esbuild');

      const result = createRuntimeClientOptions(base, { bundlers: [newBundler] });

      expect(result.bundlers).toEqual([newBundler]);
    });

    it('should preserve plugin ordering: replacements in original position, new plugins appended', () => {
      const base = baseOptions();
      const replacedGamma = kernel('gamma', { options: { replaced: true } });
      const newDelta = kernel('delta');
      const replacedAlpha = kernel('alpha', { options: { replaced: true } });

      const result = createRuntimeClientOptions(base, {
        kernels: [replacedGamma, newDelta, replacedAlpha],
      });

      expect(result.kernels.map((k) => k.id)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
      expect(result.kernels[0]).toEqual(replacedAlpha);
      expect(result.kernels[2]).toEqual(replacedGamma);
      expect(result.kernels[3]).toEqual(newDelta);
    });
  });

  // ── Deep merge: tessellation ─────────────────────────────────────────────

  describe('deep merge -- tessellation', () => {
    it('should preserve base preview when overriding export', () => {
      const base = baseOptions({
        tessellation: { preview: { linearTolerance: 0.1, angularTolerance: 0.1 } },
      });

      const result = createRuntimeClientOptions(base, {
        tessellation: { export: { linearTolerance: 0.01, angularTolerance: 0.01 } },
      });

      expect(result.tessellation).toEqual({
        preview: { linearTolerance: 0.1, angularTolerance: 0.1 },
        export: { linearTolerance: 0.01, angularTolerance: 0.01 },
      });
    });

    it('should preserve base export when overriding preview', () => {
      const base = baseOptions({
        tessellation: { export: { linearTolerance: 0.01, angularTolerance: 0.01 } },
      });

      const result = createRuntimeClientOptions(base, {
        tessellation: { preview: { linearTolerance: 0.5, angularTolerance: 0.5 } },
      });

      expect(result.tessellation).toEqual({
        preview: { linearTolerance: 0.5, angularTolerance: 0.5 },
        export: { linearTolerance: 0.01, angularTolerance: 0.01 },
      });
    });

    it('should replace both preview and export when both are overridden', () => {
      const base = baseOptions({
        tessellation: {
          preview: { linearTolerance: 0.1, angularTolerance: 0.1 },
          export: { linearTolerance: 0.01, angularTolerance: 0.01 },
        },
      });

      const result = createRuntimeClientOptions(base, {
        tessellation: {
          preview: { linearTolerance: 0.5, angularTolerance: 0.5 },
          export: { linearTolerance: 0.001, angularTolerance: 0.001 },
        },
      });

      expect(result.tessellation).toEqual({
        preview: { linearTolerance: 0.5, angularTolerance: 0.5 },
        export: { linearTolerance: 0.001, angularTolerance: 0.001 },
      });
    });

    it('should set tessellation when base has none', () => {
      const base = baseOptions();

      const result = createRuntimeClientOptions(base, {
        tessellation: { preview: { linearTolerance: 0.2, angularTolerance: 0.2 } },
      });

      expect(result.tessellation).toEqual({
        preview: { linearTolerance: 0.2, angularTolerance: 0.2 },
      });
    });

    it('should preserve base tessellation when override omits it', () => {
      const tess = { preview: { linearTolerance: 0.1, angularTolerance: 0.1 } };
      const base = baseOptions({ tessellation: tess });

      const result = createRuntimeClientOptions(base, {
        kernels: [kernel('alpha', { options: { v2: true } })],
      });

      expect(result.tessellation).toEqual(tess);
    });
  });

  // ── Scalar field replacement ─────────────────────────────────────────────

  describe('scalar field replacement', () => {
    it('should replace transport entirely', () => {
      const transport1 = {
        send: () => {
          /* Noop */
        },
        onMessage: () => {
          /* Noop */
        },
        close: () => {
          /* Noop */
        },
      };
      const transport2 = {
        send: () => {
          /* Noop */
        },
        onMessage: () => {
          /* Noop */
        },
        close: () => {
          /* Noop */
        },
      };
      const base = baseOptions({ transport: transport1 });

      const result = createRuntimeClientOptions(base, { transport: transport2 });

      expect(result.transport).toBe(transport2);
    });

    it('should replace fileSystem entirely', () => {
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Test stub: empty object for identity-equality check
      const fs1 = {} as RuntimeClientOptions['fileSystem'];
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Test stub: empty object for identity-equality check
      const fs2 = {} as RuntimeClientOptions['fileSystem'];
      const base = baseOptions({ fileSystem: fs1 });

      const result = createRuntimeClientOptions(base, { fileSystem: fs2 });

      expect(result.fileSystem).toBe(fs2);
    });

    it('should preserve omitted fields from base', () => {
      const tess = { preview: { linearTolerance: 0.1, angularTolerance: 0.1 } };
      const base = baseOptions({ tessellation: tess });

      const result = createRuntimeClientOptions(base, {
        kernels: [kernel('alpha', { options: { v2: true } })],
      });

      expect(result.tessellation).toEqual(tess);
      expect(result.middleware).toEqual(base.middleware);
      expect(result.bundlers).toEqual(base.bundlers);
    });
  });

  // ── Immutability ─────────────────────────────────────────────────────────

  describe('immutability', () => {
    it('should not mutate the base object', () => {
      const base = baseOptions();
      const baseCopy = { ...base, kernels: [...base.kernels] };

      createRuntimeClientOptions(base, {
        kernels: [kernel('alpha', { options: { replaced: true } })],
      });

      expect(base.kernels).toEqual(baseCopy.kernels);
    });

    it('should not mutate base plugin arrays', () => {
      const base = baseOptions();
      const originalKernels = [...base.kernels];

      createRuntimeClientOptions(base, { kernels: [kernel('delta')] });

      expect(base.kernels).toEqual(originalKernels);
      expect(base.kernels).toHaveLength(3);
    });

    it('should not mutate base tessellation object', () => {
      const tess = { preview: { linearTolerance: 0.1, angularTolerance: 0.1 } };
      const base = baseOptions({ tessellation: tess });

      createRuntimeClientOptions(base, {
        tessellation: { export: { linearTolerance: 0.01, angularTolerance: 0.01 } },
      });

      expect(base.tessellation).toEqual({
        preview: { linearTolerance: 0.1, angularTolerance: 0.1 },
      });
    });

    it('should not mutate the override object', () => {
      const base = baseOptions();
      const overrides: Partial<RuntimeClientOptions> = {
        kernels: [kernel('delta')],
      };
      const overridesCopy = { kernels: [...overrides.kernels!] };

      createRuntimeClientOptions(base, overrides);

      expect(overrides.kernels).toEqual(overridesCopy.kernels);
    });
  });
});
