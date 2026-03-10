import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from 'vite';
import { tsModuleUrlBuildPlugin, tsModuleUrlServePlugin, tsModuleUrlPlugin } from '#ts-module-url.vite-plugin.js';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

const { existsSync } = await import('node:fs').then((m) => m.default);
const mockExistsSync = vi.mocked(existsSync);

type TransformContext = { emitFile: ReturnType<typeof vi.fn> };

type TransformInput = {
  plugin: Plugin;
  code: string;
  id: string;
  context?: TransformContext;
};

const noopContext: TransformContext = { emitFile: vi.fn() };

function callTransform({ plugin, code, id, context = noopContext }: TransformInput) {
  type Hook = (this: TransformContext, code: string, id: string) => { code: string } | undefined;
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Vite plugin transform uses object form; cast needed to access handler
  const transform = plugin.transform as unknown as { handler: Hook };
  return transform.handler.call(context, code, id);
}

const fakeId = '/project/src/plugins/factories.ts';
const fakeDirectory = path.dirname(fakeId);

beforeEach(() => {
  mockExistsSync.mockReset();
});

// =============================================================================
// tsModuleUrlBuildPlugin
// =============================================================================

describe('tsModuleUrlBuildPlugin', () => {
  const plugin = tsModuleUrlBuildPlugin();

  it('should have correct metadata', () => {
    expect(plugin.name).toBe('vite:ts-module-url-build');
    expect(plugin.enforce).toBe('pre');
    expect(plugin.apply).toBe('build');
  });

  it('should have a hook filter for import.meta.url', () => {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Vite plugin transform uses object form; cast needed to access filter
    const transform = plugin.transform as unknown as { filter: unknown };
    expect(transform.filter).toEqual({ code: 'import.meta.url' });
  });

  it('should skip files without import.meta.url', () => {
    const result = callTransform({ plugin, code: `const x = 1;`, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should skip when no .ts source file exists for the .js reference', () => {
    mockExistsSync.mockReturnValue(false);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = callTransform({ plugin, code, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should emit a chunk and replace new URL().href when .ts source exists', () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('abc123');

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: path.resolve(fakeDirectory, '../bundler/esbuild.bundler.ts'),
    });
    expect(result).toMatchObject({
      code: `const url = import.meta.ROLLUP_FILE_URL_abc123;`,
    });
  });

  it('should emit a chunk and replace new URL() (without .href) when .ts source exists', () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('def456');

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
    const result = callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(result).toMatchObject({
      code: `const url = new URL(import.meta.ROLLUP_FILE_URL_def456);`,
    });
  });

  it('should handle multiple URL references in the same file', () => {
    mockExistsSync.mockReturnValue(true);
    let callCount = 0;
    const emitFile = vi.fn().mockImplementation(() => `ref${++callCount}`);

    const code = [
      `const a = new URL('../kernels/replicad.kernel.js', import.meta.url).href;`,
      `const b = new URL('../bundler/esbuild.bundler.js', import.meta.url);`,
    ].join('\n');
    const result = callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledTimes(2);
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_ref1');
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_ref2');
  });

  it('should skip .js references where only .js exists (no .ts source)', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      return String(filePath).endsWith('.ts') && String(filePath).includes('existing');
    });

    const code = [
      `const a = new URL('../existing/module.js', import.meta.url).href;`,
      `const b = new URL('../prebuilt/library.js', import.meta.url).href;`,
    ].join('\n');

    const emitFile = vi.fn().mockReturnValue('onlyRef');
    const result = callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledTimes(1);
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_onlyRef');
    expect(result!.code).toContain(`new URL('../prebuilt/library.js', import.meta.url).href`);
  });
});

// =============================================================================
// tsModuleUrlServePlugin
// =============================================================================

describe('tsModuleUrlServePlugin', () => {
  const plugin = tsModuleUrlServePlugin();

  it('should have correct metadata', () => {
    expect(plugin.name).toBe('vite:ts-module-url-serve');
    expect(plugin.enforce).toBe('pre');
    expect(plugin.apply).toBe('serve');
  });

  it('should have a hook filter for import.meta.url', () => {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Vite plugin transform uses object form; cast needed to access filter
    const transform = plugin.transform as unknown as { filter: unknown };
    expect(transform.filter).toEqual({ code: 'import.meta.url' });
  });

  it('should skip files without import.meta.url', () => {
    const result = callTransform({ plugin, code: `const x = 1;`, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should skip when no .ts source exists', () => {
    mockExistsSync.mockReturnValue(false);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = callTransform({ plugin, code, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should rewrite .js to .ts in new URL().href when .ts source exists', () => {
    mockExistsSync.mockReturnValue(true);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = callTransform({ plugin, code, id: fakeId });

    expect(result).toMatchObject({
      code: `const url = new URL('../bundler/esbuild.bundler.ts', import.meta.url).href;`,
    });
  });

  it('should rewrite .js to .ts in new URL() without .href', () => {
    mockExistsSync.mockReturnValue(true);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
    const result = callTransform({ plugin, code, id: fakeId });

    expect(result).toMatchObject({
      code: `const url = new URL('../bundler/esbuild.bundler.ts', import.meta.url);`,
    });
  });

  it('should handle multiple URL references', () => {
    mockExistsSync.mockReturnValue(true);

    const code = [
      `const a = new URL('../kernels/replicad.kernel.js', import.meta.url).href;`,
      `const b = new URL('../bundler/esbuild.bundler.js', import.meta.url);`,
    ].join('\n');
    const result = callTransform({ plugin, code, id: fakeId });

    expect(result!.code).toContain(`'../kernels/replicad.kernel.ts'`);
    expect(result!.code).toContain(`'../bundler/esbuild.bundler.ts'`);
    expect(result!.code).not.toContain(`.js'`);
  });

  it('should only rewrite references where .ts source exists', () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      return String(filePath).endsWith('.ts') && String(filePath).includes('existing');
    });

    const code = [
      `const a = new URL('../existing/module.js', import.meta.url).href;`,
      `const b = new URL('../prebuilt/library.js', import.meta.url).href;`,
    ].join('\n');
    const result = callTransform({ plugin, code, id: fakeId });

    expect(result!.code).toContain(`'../existing/module.ts'`);
    expect(result!.code).toContain(`'../prebuilt/library.js'`);
  });

  it('should not touch non-.js URL references', () => {
    const code = `const url = new URL('../assets/model.wasm', import.meta.url);`;
    const result = callTransform({ plugin, code, id: fakeId });
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// tsModuleUrlPlugin (convenience)
// =============================================================================

describe('tsModuleUrlPlugin', () => {
  it('should return both build and serve plugins', () => {
    const plugins = tsModuleUrlPlugin();
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.name).toBe('vite:ts-module-url-build');
    expect(plugins[0]!.apply).toBe('build');
    expect(plugins[1]!.name).toBe('vite:ts-module-url-serve');
    expect(plugins[1]!.apply).toBe('serve');
  });
});
