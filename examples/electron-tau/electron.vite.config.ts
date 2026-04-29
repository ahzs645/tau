import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { tsModuleUrlPlugin } from '@taucad/vite/ts-module-url';

/* `electron-vite` orchestrates three coordinated build pipelines (main /
 * preload / renderer); each pipeline is a regular Vite config underneath. We
 * keep dependencies external in main + preload so Electron resolves them at
 * runtime from `node_modules`, and bundle the renderer into a single ESM tree
 * because the renderer is loaded via `loadFile`. */
export default defineConfig({
  main: {
    /* `@taucad/openscad` resolves through the workspace exports map to
     * raw `.ts` files; the utility process (Node) cannot dynamic-import
     * those. We bundle openscad + runtime worker primitives into the
     * main pipeline so `kernel-host.cjs` is a self-contained Node
     * module. The rest of the deps (electron, etc.) stay external.
     *
     * `tsModuleUrlPlugin` (mirrors `apps/ui/vite.config.ts`) tells Rollup
     * to emit `.ts` files referenced via `new URL('./x.js', import.meta.url)`
     * as full Rollup chunks (transpile → bundle), instead of copying them
     * verbatim as raw assets with the `.ts` extension. Without this,
     * `dist/main/assets/openscad.kernel-XXX.ts` (raw TypeScript) gets
     * shipped where Node's ESM loader rejects it. */
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@taucad/openscad',
          '@taucad/runtime',
          '@taucad/runtime/worker',
          '@taucad/runtime/host',
          '@taucad/runtime/transport',
          '@taucad/runtime/filesystem',
          '@taucad/runtime/kernel',
          '@taucad/rpc',
        ],
      }),
      ...tsModuleUrlPlugin(),
    ],
    build: {
      outDir: 'dist/main',
      /* Topology C multi-entry main pipeline: `index` is the Electron main
       * entry; `kernel-host` is the utility-process bootstrap that hosts
       * `KernelRuntimeWorker` directly (no separate worker_threads spawn —
       * the kernel runs in-process inside the utility process). Forked by
       * `electronUtilityTransport` via `utilityProcess.fork(kernelHostUrl)`. */
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'kernel-host': resolve(import.meta.dirname, 'src/main/kernel-host.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
        external: ['electron'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: resolve(import.meta.dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rollupOptions: { external: ['electron'] },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    /* Same `tsModuleUrlPlugin` as `apps/ui/vite.config.ts:50` — required
     * so that workspace `.ts` source files referenced via `new URL(...)`
     * (e.g. `@taucad/openscad`'s `openscad.kernel.ts`) get transpiled
     * into Rollup chunks instead of being copied as raw `.ts` assets. */
    plugins: [...tsModuleUrlPlugin()],
    build: {
      outDir: resolve(import.meta.dirname, 'dist/renderer'),
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
    server: {
      headers: {
        /* COEP enables `SharedArrayBuffer` access for the kernel runtime in
         * the renderer process. Mirrors the `apps/ui` Netlify policy. */
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  },
});
