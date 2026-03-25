import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const helperPrefix = '@oxc-project/runtime/helpers/';

/**
 * Vite 8's built-in `vite:oxc` plugin transforms TypeScript decorators into
 * imports from `@oxc-project/runtime/helpers/*`. Its internal resolveId hook
 * resolves these from Vite's own bundled `@oxc-project/runtime` copy, where
 * the `node` (CJS) condition is listed first in conditional exports. The
 * ESM-only SSR module runner then crashes with `module is not defined`.
 *
 * This plugin intercepts those imports before `vite:oxc` and resolves them
 * directly to the ESM file on disk, bypassing the conditional export map.
 *
 * Resolution uses `createRequire` anchored at `vite/package.json` so it
 * finds the same `@oxc-project/runtime` copy that `vite:oxc` ships, even
 * under pnpm strict mode where the runtime is not hoisted.
 *
 * @public
 */
export function oxcRuntimeEsm(): Plugin {
  const esmRequire = createRequire(import.meta.url);
  const viteRequire = createRequire(esmRequire.resolve('vite/package.json'));
  let runtimeDirectory: string;
  return {
    name: 'vite:oxc-runtime-esm',
    enforce: 'pre',
    apply: 'serve',
    configResolved() {
      runtimeDirectory = path.dirname(viteRequire.resolve('@oxc-project/runtime/package.json'));
    },
    resolveId: {
      filter: { id: /^@oxc-project\/runtime\/helpers\// },
      handler(id) {
        if (id.includes('/esm/')) {
          return;
        }
        const helperName = id.slice(helperPrefix.length);
        return path.join(runtimeDirectory, 'src/helpers/esm', helperName + '.js');
      },
    },
  };
}
