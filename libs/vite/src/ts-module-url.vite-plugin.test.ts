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

type ResolveResult = { id: string } | undefined;
type TransformContext = {
  emitFile: ReturnType<typeof vi.fn>;
  resolve?: ReturnType<typeof vi.fn>;
};

type TransformInput = {
  plugin: Plugin;
  code: string;
  id: string;
  context?: TransformContext;
};

const noopContext: TransformContext = { emitFile: vi.fn() };

async function callTransform({ plugin, code, id, context = noopContext }: TransformInput) {
  type Hook = (
    this: TransformContext,
    code: string,
    id: string,
  ) => { code: string } | undefined | Promise<{ code: string } | undefined>;
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Vite plugin transform uses object form; cast needed to access handler
  const transform = plugin.transform as unknown as { handler: Hook };
  return transform.handler.call(context, code, id);
}

const makeResolveStub = (resolutions: Record<string, string | undefined>) =>
  vi.fn(async (specifier: string): Promise<ResolveResult> => {
    const resolved = resolutions[specifier];
    return resolved ? { id: resolved } : undefined;
  });

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

  it('should skip files without import.meta.url', async () => {
    const result = await callTransform({ plugin, code: `const x = 1;`, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should skip when no .ts source file exists for the .js reference', async () => {
    mockExistsSync.mockReturnValue(false);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const resolve = makeResolveStub({});
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile: vi.fn(), resolve } });
    expect(result).toBeUndefined();
  });

  it('should emit a chunk and replace new URL().href when .ts source exists', async () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('abc123');

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: path.resolve(fakeDirectory, '../bundler/esbuild.bundler.ts'),
      preserveSignature: 'strict',
    });
    expect(result).toMatchObject({
      code: `const url = import.meta.ROLLUP_FILE_URL_abc123;`,
    });
  });

  it('should emit a chunk and replace new URL() (without .href) when .ts source exists', async () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('def456');

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(result).toMatchObject({
      code: `const url = new URL(import.meta.ROLLUP_FILE_URL_def456);`,
    });
  });

  it('should handle multiple URL references in the same file', async () => {
    mockExistsSync.mockReturnValue(true);
    let callCount = 0;
    const emitFile = vi.fn().mockImplementation(() => `ref${++callCount}`);

    const code = [
      `const a = new URL('../kernels/replicad.kernel.js', import.meta.url).href;`,
      `const b = new URL('../bundler/esbuild.bundler.js', import.meta.url);`,
    ].join('\n');
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledTimes(2);
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_ref1');
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_ref2');
  });

  it('should handle trailing comma after import.meta.url', async () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('trailing1');

    const code = `const url = new URL('middleware.js', import.meta.url,).href;`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: path.resolve(fakeDirectory, 'middleware.ts'),
      preserveSignature: 'strict',
    });
    expect(result).toMatchObject({
      code: `const url = import.meta.ROLLUP_FILE_URL_trailing1;`,
    });
  });

  it('should handle multi-line new URL() with trailing comma', async () => {
    mockExistsSync.mockReturnValue(true);
    const emitFile = vi.fn().mockReturnValue('multiline1');

    const code = [
      `const url = new URL(`,
      `  'parameter-file-resolver.middleware.js',`,
      `  import.meta.url,`,
      `).href;`,
    ].join('\n');
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });

    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: path.resolve(fakeDirectory, 'parameter-file-resolver.middleware.ts'),
      preserveSignature: 'strict',
    });
    expect(result).toMatchObject({
      code: `const url = import.meta.ROLLUP_FILE_URL_multiline1;`,
    });
  });

  it('should skip .js references where only .js exists (no .ts source)', async () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      return String(filePath).endsWith('.ts') && String(filePath).includes('existing');
    });

    const code = [
      `const a = new URL('../existing/module.js', import.meta.url).href;`,
      `const b = new URL('../prebuilt/library.js', import.meta.url).href;`,
    ].join('\n');

    const emitFile = vi.fn().mockReturnValue('onlyRef');
    const resolve = makeResolveStub({});
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile, resolve } });

    expect(emitFile).toHaveBeenCalledTimes(1);
    expect(result!.code).toContain('import.meta.ROLLUP_FILE_URL_onlyRef');
    expect(result!.code).toContain(`new URL('../prebuilt/library.js', import.meta.url).href`);
  });

  /* Bare-specifier coverage (RR3 — `tsModuleUrlBuildPlugin` smoking gun).
   *
   * Pre-fix: the regex required a `.js` suffix, so `new URL('@scope/pkg/sub', import.meta.url)`
   * slipped through the build plugin. Vite/Rollup then emitted the resolved
   * `.ts` file as a verbatim asset (`/assets/<chunk>-<hash>.ts`), which the
   * browser refuses to load as a Worker module (`video/mp2t` MIME type),
   * stalling the worker handshake.
   *
   * Post-fix: any `new URL('<spec>', import.meta.url)` whose `this.resolve()`
   * lands on a `.ts` source is hoisted into a Rollup chunk via `emitFile`.
   */
  it('should emit a chunk for bare module specifiers that resolve to a .ts source', async () => {
    mockExistsSync.mockReturnValue(false); // No sibling .ts on disk
    const emitFile = vi.fn().mockReturnValue('bareSpec1');
    const resolvedTsPath = '/workspace/packages/runtime/src/framework/kernel-runtime-worker.ts';
    // eslint-disable-next-line @typescript-eslint/naming-convention -- bare module specifier used as resolution stub key
    const resolve = makeResolveStub({ '@taucad/runtime/worker': resolvedTsPath });

    const code = `const url = new URL('@taucad/runtime/worker', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile, resolve } });

    expect(resolve).toHaveBeenCalledWith('@taucad/runtime/worker', fakeId);
    expect(emitFile).toHaveBeenCalledWith({
      type: 'chunk',
      id: resolvedTsPath,
      preserveSignature: 'strict',
    });
    expect(result).toMatchObject({
      code: `const url = new URL(import.meta.ROLLUP_FILE_URL_bareSpec1);`,
    });
  });

  it('should skip bare specifiers that resolve to non-.ts files (prebuilt JS deps)', async () => {
    mockExistsSync.mockReturnValue(false);
    const emitFile = vi.fn();
    const resolve = makeResolveStub({
      'some-prebuilt-js-pkg': '/workspace/node_modules/some-prebuilt-js-pkg/dist/index.js',
    });

    const code = `const url = new URL('some-prebuilt-js-pkg', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile, resolve } });

    expect(emitFile).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('should skip absolute URLs (http://, file://, data:) without attempting resolution', async () => {
    const emitFile = vi.fn();
    const resolve = vi.fn();

    const code = [
      `const a = new URL('https://example.com/asset.js', import.meta.url);`,
      `const b = new URL('file:///abs/path.js', import.meta.url);`,
      `const c = new URL('data:text/javascript,console.log(1)', import.meta.url);`,
    ].join('\n');
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile, resolve } });

    expect(emitFile).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  /* Comment / literal poisoning regression suite.
   *
   * Pre-fix: the regex scanned raw source, so any `new URL(spec, import.meta.url)`
   * appearing inside JSDoc / `//` / string literals materialised as a real
   * `emitFile()` edge in Rolldown's chunk graph. When the same spec also resolved
   * to a chunk that statically imported the file containing the JSDoc, the cycle
   * deadlocked Rolldown's chunk planner during `pnpm nx build ui`.
   *
   * Post-fix: matches whose position falls inside a comment or string literal
   * are filtered out via `strip-literal`. Real call sites still emit chunks
   * exactly as before.
   */
  describe('comment + string-literal isolation', () => {
    it('should ignore `new URL(...)` appearing in a block comment', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn();
      const code = `/* see new URL('../bundler/esbuild.bundler.js', import.meta.url) for the pattern */`;
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should ignore `new URL(...)` appearing in a line comment', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn();
      const code = `// const x = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should ignore `new URL(...)` appearing inside a JSDoc block', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn();
      const code = [
        `/**`,
        ` * Uses \`new URL('../bundler/esbuild.bundler.js', import.meta.url)\` to`,
        ` * locate the bundled worker entry.`,
        ` */`,
        `export const noop = () => {};`,
      ].join('\n');
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should ignore `new URL(...)` appearing inside a double-quoted string literal', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn();
      const code = `const msg = "new URL('../bundler/esbuild.bundler.js', import.meta.url)";`;
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should ignore `new URL(...)` appearing inside a template literal', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn();
      const code = "const msg = `try new URL('../bundler/esbuild.bundler.js', import.meta.url)`;";
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should emit only the real call when a JSDoc reference precedes a real `new URL(...)`', async () => {
      mockExistsSync.mockReturnValue(true);
      const emitFile = vi.fn().mockReturnValue('mixed1');
      const code = [
        `/**`,
        ` * @example new URL('../bundler/esbuild.bundler.js', import.meta.url)`,
        ` */`,
        `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`,
      ].join('\n');
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).toHaveBeenCalledTimes(1);
      /* JSDoc text is preserved verbatim; only the real call site is rewritten. */
      expect(result!.code).toContain(`@example new URL('../bundler/esbuild.bundler.js', import.meta.url)`);
      expect(result!.code).toContain(`const url = import.meta.ROLLUP_FILE_URL_mixed1;`);
    });

    it('should emit exactly N chunks for N real calls when interleaved with M commented references', async () => {
      mockExistsSync.mockReturnValue(true);
      let counter = 0;
      const emitFile = vi.fn().mockImplementation(() => `chunk${++counter}`);
      const code = [
        `/* new URL('../a.js', import.meta.url) — DOC */`,
        `const real1 = new URL('../b.js', import.meta.url);`,
        `// new URL('../c.js', import.meta.url) — DOC`,
        `const real2 = new URL('../d.js', import.meta.url).href;`,
      ].join('\n');
      const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile } });
      expect(emitFile).toHaveBeenCalledTimes(2);
      expect(result!.code).toContain('chunk1');
      expect(result!.code).toContain('chunk2');
      /* Spec-level proof: the only paths emitted are the REAL call sites. */
      const emittedIds = emitFile.mock.calls.map((call) => (call[0] as { id: string }).id);
      expect(emittedIds).toEqual([
        path.resolve(fakeDirectory, '../d.js'.replace('.js', '.ts')),
        path.resolve(fakeDirectory, '../b.js'.replace('.js', '.ts')),
      ]);
    });
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

  it('should skip files without import.meta.url', async () => {
    const result = await callTransform({ plugin, code: `const x = 1;`, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should skip when no .ts source exists', async () => {
    mockExistsSync.mockReturnValue(false);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = await callTransform({ plugin, code, id: fakeId });
    expect(result).toBeUndefined();
  });

  it('should rewrite .js to .ts in new URL().href when .ts source exists', async () => {
    mockExistsSync.mockReturnValue(true);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`;
    const result = await callTransform({ plugin, code, id: fakeId });

    expect(result).toMatchObject({
      code: `const url = new URL('../bundler/esbuild.bundler.ts', import.meta.url).href;`,
    });
  });

  it('should rewrite .js to .ts in new URL() without .href', async () => {
    mockExistsSync.mockReturnValue(true);

    const code = `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId });

    expect(result).toMatchObject({
      code: `const url = new URL('../bundler/esbuild.bundler.ts', import.meta.url);`,
    });
  });

  it('should handle multiple URL references', async () => {
    mockExistsSync.mockReturnValue(true);

    const code = [
      `const a = new URL('../kernels/replicad.kernel.js', import.meta.url).href;`,
      `const b = new URL('../bundler/esbuild.bundler.js', import.meta.url);`,
    ].join('\n');
    const result = await callTransform({ plugin, code, id: fakeId });

    expect(result!.code).toContain(`'../kernels/replicad.kernel.ts'`);
    expect(result!.code).toContain(`'../bundler/esbuild.bundler.ts'`);
    expect(result!.code).not.toContain(`.js'`);
  });

  it('should only rewrite references where .ts source exists', async () => {
    mockExistsSync.mockImplementation((filePath: unknown) => {
      return String(filePath).endsWith('.ts') && String(filePath).includes('existing');
    });

    const code = [
      `const a = new URL('../existing/module.js', import.meta.url).href;`,
      `const b = new URL('../prebuilt/library.js', import.meta.url).href;`,
    ].join('\n');
    const result = await callTransform({ plugin, code, id: fakeId });

    expect(result!.code).toContain(`'../existing/module.ts'`);
    expect(result!.code).toContain(`'../prebuilt/library.js'`);
  });

  it('should rewrite .js to .ts with trailing comma after import.meta.url', async () => {
    mockExistsSync.mockReturnValue(true);

    const code = `const url = new URL('middleware.js', import.meta.url,).href;`;
    const result = await callTransform({ plugin, code, id: fakeId });

    expect(result).toMatchObject({
      code: `const url = new URL('middleware.ts', import.meta.url,).href;`,
    });
  });

  it('should not touch non-.js URL references that fail to resolve', async () => {
    const resolve = makeResolveStub({});
    const code = `const url = new URL('../assets/model.wasm', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile: vi.fn(), resolve } });
    expect(result).toBeUndefined();
  });

  /* Bare-specifier serve-mode coverage. In dev mode Vite resolves bare
   * specifiers via its module resolver and serves the .ts on the fly,
   * so the serve plugin must NOT rewrite the URL string (the bare spec
   * is the correct request token). */
  it('should leave bare module specifiers untouched (Vite dev resolves them natively)', async () => {
    const resolve = makeResolveStub({
      // eslint-disable-next-line @typescript-eslint/naming-convention -- bare module specifier used as resolution stub key
      '@taucad/runtime/worker': '/workspace/packages/runtime/src/framework/kernel-runtime-worker.ts',
    });
    const code = `const url = new URL('@taucad/runtime/worker', import.meta.url);`;
    const result = await callTransform({ plugin, code, id: fakeId, context: { emitFile: vi.fn(), resolve } });
    expect(result).toBeUndefined();
  });

  /* Mirror of the build-plugin comment-isolation suite. The serve plugin
   * never deadlocks Rolldown (it runs in dev only), but a stray rewrite
   * inside a JSDoc / string literal would still corrupt the source map and
   * confuse downstream Vite plugins. */
  describe('comment + string-literal isolation', () => {
    it('should not rewrite `new URL(...)` inside a block comment', async () => {
      mockExistsSync.mockReturnValue(true);
      const code = `/* see new URL('../bundler/esbuild.bundler.js', import.meta.url) */`;
      const result = await callTransform({ plugin, code, id: fakeId });
      expect(result).toBeUndefined();
    });

    it('should not rewrite `new URL(...)` inside a line comment', async () => {
      mockExistsSync.mockReturnValue(true);
      const code = `// const x = new URL('../bundler/esbuild.bundler.js', import.meta.url);`;
      const result = await callTransform({ plugin, code, id: fakeId });
      expect(result).toBeUndefined();
    });

    it('should not rewrite `new URL(...)` inside a JSDoc block', async () => {
      mockExistsSync.mockReturnValue(true);
      const code = [
        `/**`,
        ` * Example: \`new URL('../bundler/esbuild.bundler.js', import.meta.url)\``,
        ` */`,
        `export const noop = () => {};`,
      ].join('\n');
      const result = await callTransform({ plugin, code, id: fakeId });
      expect(result).toBeUndefined();
    });

    it('should not rewrite `new URL(...)` inside a string literal', async () => {
      mockExistsSync.mockReturnValue(true);
      const code = `const msg = "new URL('../bundler/esbuild.bundler.js', import.meta.url)";`;
      const result = await callTransform({ plugin, code, id: fakeId });
      expect(result).toBeUndefined();
    });

    it('should rewrite real call sites while leaving JSDoc references untouched', async () => {
      mockExistsSync.mockReturnValue(true);
      const code = [
        `/**`,
        ` * @example new URL('../bundler/esbuild.bundler.js', import.meta.url)`,
        ` */`,
        `const url = new URL('../bundler/esbuild.bundler.js', import.meta.url).href;`,
      ].join('\n');
      const result = await callTransform({ plugin, code, id: fakeId });
      /* JSDoc verbatim, real call site rewritten. */
      expect(result!.code).toContain(`@example new URL('../bundler/esbuild.bundler.js', import.meta.url)`);
      expect(result!.code).toContain(`const url = new URL('../bundler/esbuild.bundler.ts', import.meta.url).href;`);
    });
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
