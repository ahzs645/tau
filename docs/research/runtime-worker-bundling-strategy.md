---
title: 'Runtime Worker Bundling Strategy'
description: 'How @taucad/runtime should ship its kernel worker so it works under every consumer bundler (Vite, Rolldown, webpack, esbuild, electron-vite, electron-forge) and every host runtime (browser, Node, Electron main, Electron renderer).'
status: draft
created: '2026-04-28'
updated: '2026-04-28'
category: architecture
related:
  - docs/research/runtime-channel-blueprint-v5.md
  - docs/research/runtime-cross-origin-isolation-distribution.md
---

# Runtime Worker Bundling Strategy

How `@taucad/runtime` should ship its kernel worker so it works under every consumer bundler (Vite, Rolldown, webpack, esbuild, electron-vite, electron-forge) and every host runtime (browser, Node, Electron main, Electron renderer) — without leaking bundler-specific assumptions into library code.

## Executive Summary

Tau's `getDefaultKernelWorkerUrl()` resolves the kernel worker via `new URL('../framework/kernel-runtime-worker.js', import.meta.url)` _inside the runtime's own source_. This pattern silently breaks in the v5 Electron PoC — `electron-vite`'s `externalizeDepsPlugin` does not externalize the workspace-aliased `@taucad/runtime` package, so the helper ends up bundled into `dist/main/index.cjs` and `import.meta.url` resolves against the bundled file rather than the source location, leaving the worker file unemitted.

The library-side resolution pattern works only when (a) the runtime is consumed as built `dist/` artefacts, (b) those artefacts are externalized by the consumer's bundler, and (c) the consumer's bundler doesn't pre-bundle them away. Across the bundler matrix surveyed (Vite library mode, electron-vite main, webpack 5, esbuild, Rolldown), this combination is the exception, not the rule.

The ecosystem has converged on the **inverted resolution pattern**: the library exposes a dedicated `./worker` subpath export, and the consumer constructs the URL/Worker using their own bundler's static-analysis pattern (`new URL('lib/worker', import.meta.url)`, `?worker&url`, `?modulePath`, `?nodeWorker`). Comlink, ffmpeg.wasm, Monaco, and the Vite maintainer's own recommended library pattern all follow this shape. Tau already publishes the required `./worker` subpath export — the fix is to delete `getDefaultKernelWorkerUrl()`'s false promise of bundler-agnosticism and document the per-bundler integration recipe instead.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix](#appendix)

## Problem Statement

Phase 14 of the v5 Channel Blueprint (Playwright e2e under `examples/electron-tau`) timed out at 60s. Bisecting the Electron startup showed the kernel `worker_threads.Worker` never spawned. `nodeWorkerRunner` was being constructed with a URL produced by `getDefaultKernelWorkerUrl()`:

```typescript
// packages/runtime/src/runner/get-default-kernel-worker-url.ts
export function getDefaultKernelWorkerUrl(): URL {
  return new URL('../framework/kernel-runtime-worker.js', import.meta.url);
}
```

In the Electron build the call site (`examples/electron-tau/src/main/index.ts`) is bundled by `electron-vite` (Rolldown under the hood) into `examples/electron-tau/dist/main/index.cjs`. The expectation was that `externalizeDepsPlugin()` would treat `@taucad/runtime` as external so `import.meta.url` would still resolve against the runtime source. Inspection of the 10,200-line `dist/main/index.cjs` showed both `getDefaultKernelWorkerUrl` and the literal string `'kernel-runtime-worker.js'` inlined — the workspace dependency was bundled, not externalized, and the worker file itself was never emitted as a sibling chunk.

The deeper question this triggered: **what _is_ the right way for a library that ships a worker to publish it across the bundler matrix?** Tau's runtime needs to work for:

| Consumer                 | Bundler                                       | Runtime                          |
| ------------------------ | --------------------------------------------- | -------------------------------- |
| `apps/ui` (Tau itself)   | Vite 7 (renderer) + tsdown (workspace source) | Browser SharedWorker             |
| `examples/electron-tau`  | electron-vite (Rolldown)                      | Electron main → `worker_threads` |
| Future: Tau Electron app | electron-vite or electron-forge               | Electron main + renderer         |
| 3rd-party browser app    | Vite, webpack, Rspack, Parcel                 | Browser Web Worker               |
| 3rd-party Node CLI       | tsx, esbuild, plain Node                      | `worker_threads`                 |
| `@taucad/cli`            | tsdown (workspace source)                     | `worker_threads`                 |

The current pattern fails the workspace-source consumers and the electron-vite consumer. We need a strategy that works for all of them.

## Scope and Non-Goals

**In scope**: How `@taucad/runtime` exposes its kernel worker entry; what `getDefaultKernelWorkerUrl()` should do (or be replaced with); what `package.json` exports the runtime needs; how each consumer bundler should be wired; the future migration of Electron transport wiring into the runtime.

**Out of scope**: The wire protocol itself (covered by `runtime-channel-blueprint-v5.md`); cross-origin isolation distribution (covered by `runtime-cross-origin-isolation-distribution.md`); WASM asset distribution (covered by `runtime-cross-origin-isolation-distribution.md` and per-kernel `copy-files-from-to.cjson` configuration).

## Methodology

1. **Audited current Tau code paths**: `getDefaultKernelWorkerUrl`, `webWorkerRunner`, `nodeWorkerRunner`, `packages/runtime/package.json` exports, `tsdown.config.ts` entry list, and every call site in `apps/ui` + `examples/electron-tau`.
2. **Surveyed Vite and Rolldown handling** of `new Worker(new URL(..., import.meta.url))` in app mode, library mode, and dependency-optimizer mode (issues #15547, #15618, #20644, #21325, #21422, #21434).
3. **Surveyed electron-vite and electron-forge** worker bundling APIs (`?modulePath`, `?nodeWorker`, multi-input rollupOptions; alex8088/electron-vite-worker-example).
4. **Surveyed webpack 5** native worker handling (`new Worker(new URL(..., import.meta.url))` for both `Worker` and `worker_threads.Worker`; `worker` export condition; webpack 5.105 release notes).
5. **Surveyed how major worker-shipping libraries publish workers**: Comlink, ffmpeg.wasm (`@ffmpeg/core` / `@ffmpeg/core-mt`), monaco-editor (`monaco-editor-webpack-plugin`), pdfjs-dist, web-worker (developit), worker-lib.
6. **Cross-referenced the OpenJS Foundation's bundler-collab-space module-resolution audit** (issue #7) for the canonical mismatch matrix between bundlers' default conditions and condition-merge semantics.

## Findings

### Finding 1: The `new URL(..., import.meta.url)` pattern only works at the consumer's entry-graph level

Every bundler that supports the `new Worker(new URL('./w.js', import.meta.url))` pattern (Vite, webpack 5, Rolldown, esbuild) does so via **static analysis of the call site**. The pattern is recognised, the relative URL is rewritten to a fingerprinted output asset, and a chunk is emitted for the worker entry — _but only at the layer the bundler is actively building_.

Once the same expression appears inside a third-party library that the consumer's bundler is re-bundling, the pattern fails in characteristic ways:

| Scenario                                                                      | Failure mode                                                                                                                                                | Source                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Vite library mode publishes a lib that uses `new URL(...)` for its own worker | Output URL is `/assets/worker-{hash}.js` — 404 in the consumer app                                                                                          | vitejs/vite#15618 (open since 2024-01, 16+ thumbs-up)        |
| Vite app consumes such a lib without `optimizeDeps.exclude`                   | Lib gets pre-bundled into `node_modules/.vite/deps/`, relative URL points at non-existent worker                                                            | vitejs/vite#21422, partially fixed in #21434 (2026-01)       |
| Vite library + `?worker&url` + `base: './'`                                   | Works in lib's standalone preview, breaks in consumer's dev because `?worker&url` paths are not rewritten through the deps optimizer                        | vitejs/vite#15547                                            |
| webpack 5 + library-side `new URL(...)` re-bundled by app                     | Webpack re-emits the URL but resolves it relative to the _consumer_ output directory, dependency files unbundled                                            | webpack/webpack.js.org#4898                                  |
| electron-vite main + workspace-aliased dependency carrying `new URL(...)`     | Dependency is inlined (workspace deps bypass `externalizeDepsPlugin`); `import.meta.url` resolves to the bundled file; worker is never emitted as a sibling | Direct repro in `examples/electron-tau` (this investigation) |

**The pattern is bundler-agnostic only when authored at the application root** — i.e. in code the consumer's bundler is the _first_ bundler to see. The moment the expression crosses an `npm publish` boundary (or a workspace boundary), every bundler in the chain reinterprets `import.meta.url` against its own output position. There is no universal fix because bundlers do not (and cannot) statically know which deeper-relative-URL targets a downstream bundler will need.

### Finding 2: The ecosystem has converged on the "consumer-resolves-the-URL" pattern

The libraries with the highest usage and the cleanest cross-bundler stories all share one structural choice: **the library does not resolve the worker URL — the consumer does**. The library exposes a dedicated worker entry via a subpath export, and the consumer constructs the `Worker` (or `URL`) with whatever bundler-specific syntax their build supports.

| Library                    | Weekly DL | Pattern                                                                                                                                 | Consumer surface                                                                                       |
| -------------------------- | --------: | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Comlink** (Google)       |     1.6 M | Library never spawns a Worker — accepts an `endpoint` (Worker, MessagePort, anything `postMessage`-shaped)                              | `Comlink.wrap(new Worker('w.js'))`                                                                     |
| **ffmpeg.wasm**            |    200 k+ | After `@ffmpeg/core-mt` issue #758 / #767, exposed `./worker`, `./wasm` subpath exports                                                 | `import workerURL from '@ffmpeg/core-mt/worker?url'`                                                   |
| **monaco-editor**          |      7 M+ | Workers shipped as separate package entries; `monaco-editor-webpack-plugin` materialises them as consumer-side webpack entries          | Per-language `monaco-editor/esm/vs/language/.../worker.js`                                             |
| **pdfjs-dist**             |      5 M+ | Worker shipped as `pdfjs-dist/build/pdf.worker.{m,}js`; consumer sets `GlobalWorkerOptions.workerSrc` with the URL their bundler emits  | `pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url)` |
| **web-worker** (developit) |     ~80 k | Polyfills `Worker` for Node; deliberately does **not** ship a worker — consumer always provides one via `new URL(..., import.meta.url)` | `new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' })`                             |

Vite maintainer @sapphi-red explicitly recommends this pattern for any library publishing a worker (vitejs/vite Discussion #15886):

> Allow specifying the worker URL and make the worker entry point accessible.
>
> ```jsonc
> {
>   "exports": {
>     ".": "./index.js",
>     "./worker.js": "./worker.js",
>   },
> }
> ```
>
> ```js
> // app code
> import workerUrl from 'your-lib/worker.js?worker&url';
> import { myWorker } from 'your-lib';
> myWorker(workerUrl);
> ```

This is structurally identical to the ffmpeg.wasm fix and the Comlink contract. **The library-side `new URL(..., import.meta.url)` pattern that Tau currently uses is the anti-pattern that issue #15886 exists to discourage.**

### Finding 3: Each consumer bundler has a static-analysable pattern — but they are not interchangeable

Different bundlers detect worker entries via different syntax. A consumer using one of these patterns benefits from automatic chunk emission, hashing, and asset graph integration; a consumer using the wrong pattern for their bundler gets a 404 at runtime.

| Bundler / Tool                    | Recommended consumer pattern                                                                                                                        | Notes                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vite (browser)**                | `new Worker(new URL('@taucad/runtime/worker', import.meta.url), { type: 'module' })`                                                                | Requires the dep to _not_ be in `optimizeDeps.include` for the URL to remain analysable; many libs use `import workerUrl from 'lib/worker?worker&url'` instead |
| **Vite (browser, lib-friendly)**  | `import workerUrl from '@taucad/runtime/worker?worker&url'` then `new Worker(workerUrl, { type: 'module' })`                                        | `?worker&url` survives the deps optimizer better than raw `new URL`                                                                                            |
| **webpack 5 (web)**               | `new Worker(new URL('@taucad/runtime/worker', import.meta.url), { type: 'module' })`                                                                | Native; supports `worker` export condition (5.105+)                                                                                                            |
| **webpack 5 (Node)**              | Same as web, `import { Worker } from 'node:worker_threads'`                                                                                         | Only ESM output; CJS not supported (webpack/webpack.js.org#4898)                                                                                               |
| **electron-vite (main)**          | `import workerPath from './worker?modulePath'` then `new Worker(workerPath)`                                                                        | `?modulePath` is electron-vite's first-class node-worker syntax (alex8088 maintainer-recommended)                                                              |
| **electron-vite (main, alt)**     | `import createWorker from './worker?nodeWorker'` then `createWorker({ workerData })`                                                                | Returns a constructor; equivalent ergonomics                                                                                                                   |
| **electron-forge plugin-vite**    | Multi-entry `build: [{entry: 'src/main.ts'}, {entry: 'src/worker.ts'}]` + `path.join(__dirname, 'worker.js')`                                       | Same Vite primitives, different config shape                                                                                                                   |
| **electron-forge plugin-webpack** | Add worker as second `entry` in `webpack.main.config.js`; reference by emitted filename                                                             | Documented at length in stackoverflow/79607008                                                                                                                 |
| **Rolldown (standalone)**         | `new Worker(new URL('./w.js', import.meta.url))`                                                                                                    | Same as Vite build mode                                                                                                                                        |
| **esbuild (browser)**             | No native worker support — consumer wraps in `new URL(..., import.meta.url)` and ships worker file separately, OR uses esbuild-plugin-inline-worker | Several open feature requests since 2022                                                                                                                       |
| **tsdown / tsx / ts-node (Node)** | `new Worker(require.resolve('@taucad/runtime/worker'))` or `new URL(import.meta.resolve('@taucad/runtime/worker'))`                                 | Source-mode consumers; no bundler involved                                                                                                                     |
| **Plain Node (no bundler)**       | Same as tsdown — `import.meta.resolve` (Node 20.6+) or `require.resolve`                                                                            | Resolves through the package's `exports` map                                                                                                                   |

The consequence: **the runtime cannot abstract this away**. Any helper the runtime ships that returns "a URL that always works" is lying to at least one of the bundlers above. The honest API surface is `runner({ url })` where `url` is supplied by the consumer using whichever bundler-native syntax they have available.

### Finding 4: The `worker` package.json export condition is orthogonal to URL resolution

Webpack 5.105 (2026-02) and Vite 7 (with `resolve.conditions: ['worker']`) both support a `"worker"` field inside `package.json` `exports` conditions. This selects a different _file_ when a module is imported _from inside a worker context_ — it does **not** help a consumer locate the worker entry to instantiate.

```jsonc
{
  "exports": {
    "./logger": {
      "worker": "./logger-worker.js", // tree-shaken DOM-free build
      "browser": "./logger-browser.js",
      "default": "./logger-node.js",
    },
  },
}
```

This is useful if the runtime ever wants to ship a smaller worker-side build of, say, the logging or telemetry module without DOM polyfills. It's **not** the mechanism for shipping the kernel worker entry. Conflating the two is a common confusion in the linked discussions (vitejs/vite#7439, vitejs/vite#20230). Tau may want to adopt the `worker` condition later for tree-shaking opportunities, but the kernel-runtime-worker problem is solved entirely at the _URL resolution_ layer, not the _condition resolution_ layer.

### Finding 5: Tau's `./worker` subpath export already exists and is correct

Inspection of `packages/runtime/package.json` shows the runtime already publishes the required subpath export, both for workspace mode and the npm-published artefacts:

```jsonc
"exports": {
  "./worker": "./src/framework/kernel-runtime-worker.ts"
},
"publishConfig": {
  "exports": {
    "./worker": {
      "require": {
        "types": "./dist/cjs/framework/kernel-runtime-worker.d.cts",
        "default": "./dist/cjs/framework/kernel-runtime-worker.cjs"
      },
      "import": {
        "types": "./dist/esm/framework/kernel-runtime-worker.d.ts",
        "default": "./dist/esm/framework/kernel-runtime-worker.js"
      }
    }
  }
}
```

`tsdown.config.ts` already lists `src/framework/kernel-runtime-worker.ts` as a dedicated entry, so the published artefact is bundled standalone (not inlined into the main runtime barrel). The `kernel-runtime-worker.ts` source is also self-detecting via `isWorkerContext()` so importing it as `import '@taucad/runtime/worker'` from main-thread code is a no-op rather than an error.

**Nothing on the publishing side needs to change.** The runtime is already in the right shape. The issue is entirely on the _consumption_ side: `getDefaultKernelWorkerUrl()` was meant to spare consumers from per-bundler integration but instead bakes in a single resolution strategy that fails for at least three of Tau's own consumer profiles.

### Finding 6: Why the Electron PoC specifically broke

Three independent decisions compound to produce the timeout:

1. **`@taucad/runtime` is a workspace dependency** (`"@taucad/runtime": "workspace:*"`). pnpm symlinks it to `packages/runtime`, whose `exports` field points at `.ts` source.
2. **`externalizeDepsPlugin()` does not externalize workspace deps by default** — it reads `dependencies` + `peerDependencies` and externalizes those names, but Rolldown still tries to resolve the alias to its source on disk and inlines anything that doesn't have a built `dist/` it can `require()` cleanly. With workspace symlinks pointing at `.ts`, Rolldown inlines.
3. **`getDefaultKernelWorkerUrl()` was inlined alongside the rest of the runtime source** into `dist/main/index.cjs`. Inside the bundled file, `import.meta.url` is `file:///.../dist/main/index.cjs`. The relative target `'../framework/kernel-runtime-worker.js'` resolves to `file:///.../dist/framework/kernel-runtime-worker.js` — a path that nothing emits.

This is not a Rolldown bug or an electron-vite bug. It is the predictable outcome of a workspace-source library trying to resolve its own assets via `import.meta.url` after being inlined into a consumer's bundle. The same failure would occur under webpack, esbuild, or any other re-bundler that doesn't pin the asset's source location.

### Finding 7: Inverting responsibility scales to the future Electron transport in `@taucad/runtime/electron`

The user noted that we plan to move the Electron transport wiring (currently in `examples/electron-tau/src/main/index.ts`) into `@taucad/runtime/electron` once the PoC is proven. Under the inverted-resolution pattern this future move composes cleanly:

```typescript
// future @taucad/runtime/electron
export function createElectronRuntimeBackend(options: {
  workerUrl: string | URL; // consumer-supplied
  fileSystem: RuntimeFileSystemBase | RuntimeFileSystemHandle;
}): ElectronRuntimeBackend {
  /* … */
}
```

The runtime owns the IPC plumbing (port handoff, lifecycle, header injection) — the consumer owns worker-URL resolution because only the consumer's bundler knows where the worker file ended up. This mirrors how `webWorkerRunner({ url })` and `nodeWorkerRunner({ url })` already work today; the future Electron backend simply composes them rather than introducing a new resolution surface.

### Finding 8: Worker URL resolution is not the runtime's problem; the runtime should not pretend it is

Comlink ships 1.6 M weekly downloads, zero dependencies, 1.1 KB minified, and supports every bundler under the sun — by deliberately _not_ solving worker resolution. Its README literally says: "WebWorkers use `postMessage` and therefore work with Comlink. `const obj = Comlink.wrap(worker)`". It accepts an endpoint; the consumer brings the endpoint.

`webWorkerRunner` and `nodeWorkerRunner` already follow this contract — they accept `url: string | URL`. The only Tau API that violates the pattern is `getDefaultKernelWorkerUrl()`, whose three-line implementation makes a load-bearing assumption (the runtime is at a known relative path to its sibling worker entry at runtime) that holds in roughly half of the consumer profiles.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                 | Priority | Effort | Impact                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------- |
| R1  | Delete `getDefaultKernelWorkerUrl()` from `@taucad/runtime/runner` and remove the `src/runner/get-default-kernel-worker-url.ts` file                                                                                                                                                                                                   | P0       | Low    | High — removes the false bundler-agnostic promise         |
| R2  | Update Electron PoC to construct the worker URL with `electron-vite`'s `?modulePath` suffix from a per-app worker bootstrap file (`src/main/kernel-runtime-worker.ts`) that does `import '@taucad/runtime/worker'`                                                                                                                     | P0       | Low    | High — unblocks Phase 14 e2e                              |
| R3  | Add a second input to `examples/electron-tau/electron.vite.config.ts` main pipeline so the worker bootstrap emits as a sibling chunk of `index.cjs`                                                                                                                                                                                    | P0       | Low    | High — required for R2                                    |
| R4  | Audit `apps/ui` to confirm it does not import `getDefaultKernelWorkerUrl` (it currently uses `inProcessRunner`); migrate any latent doc references to the new pattern                                                                                                                                                                  | P1       | Low    | Medium                                                    |
| R5  | Update `apps/ui/content/docs/(runtime)/concepts/worker-model.mdx` and `embedding-in-a-host.mdx` to show the per-bundler integration recipes (Vite, electron-vite, webpack, Node) instead of the deleted helper                                                                                                                         | P1       | Medium | Medium                                                    |
| R6  | Add an integration test `packages/runtime/src/runner/web-worker-runner.integration.test.ts` that imports `@taucad/runtime/worker?url` (Vite + jsdom) and instantiates `webWorkerRunner` to lock in the consumer surface                                                                                                                | P2       | Medium | Medium                                                    |
| R7  | When `@taucad/runtime/electron` is promoted from `examples/electron-tau`, the `createElectronRuntimeBackend({ workerUrl, fileSystem })` signature accepts `workerUrl` as a required parameter — _do not_ re-introduce a default-URL helper                                                                                             | P1       | Low    | High — sets the precedent for future host-runtime exports |
| R8  | Defer `worker` export-condition adoption (Finding 4) until a tree-shaking-driven worker-only build slice is identified — not part of this work                                                                                                                                                                                         | P3       | —      | Low (deferred)                                            |
| R9  | Consider adding a `?taucad-worker` Vite plugin under `@taucad/vite` that auto-resolves `@taucad/runtime/worker` for browser consumers using a one-line `runtime()` plugin (parallels how `vite-plugin-arraybuffer`, `vite-plugin-comlink` cover their gaps) — only if R5's per-bundler recipe proves too verbose for typical consumers | P3       | Medium | Medium                                                    |

## Trade-offs

### Library-resolves-URL vs consumer-resolves-URL

| Dimension                                                             | Library resolves (status quo)                        | Consumer resolves (recommended)                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Consumer ergonomics for happy path (Vite app + npm-installed runtime) | Single function call: `getDefaultKernelWorkerUrl()`  | One extra import: `import workerUrl from '@taucad/runtime/worker?worker&url'` |
| Workspace-source mode (Tau itself)                                    | Broken — `.ts` URL leaks                             | Works — consumer uses bundler-native syntax                                   |
| Vite library-mode consumer                                            | Broken — pre-bundling rebases URL                    | Works — `?worker&url` survives optimizer                                      |
| electron-vite main process                                            | Broken — workspace inline + wrong `import.meta.url`  | Works — `?modulePath` resolves through electron-vite's pipeline               |
| Bundler portability                                                   | Pretends to be portable, isn't                       | Honest about per-bundler integration; one recipe per bundler                  |
| Future Electron transport export                                      | Forces the same broken assumption to compose forward | Composes cleanly: `createElectronRuntimeBackend({ workerUrl })`               |
| API surface size                                                      | One helper                                           | Zero helpers (the runner already accepts `url`)                               |

### Default-URL helper vs `?taucad-worker` Vite plugin (R9, deferred)

If the per-bundler verbosity becomes a sustained complaint, a Vite-plugin-style abstraction (`@taucad/vite` already exists) is preferable to re-introducing a runtime-side default-URL helper. Plugins live in the _consumer's_ bundler graph where `import.meta.url` and asset emission semantics are well-defined. A runtime-side helper does not.

## Code Examples

### Example 1: Electron PoC fix (R2 + R3)

**`examples/electron-tau/src/main/kernel-runtime-worker.ts`** — new file, consumer-owned worker bootstrap that re-exports the Tau kernel worker through electron-vite's build graph:

```typescript
import '@taucad/runtime/worker';
```

**`examples/electron-tau/electron.vite.config.ts`** — diff: add the worker as a second input to the main pipeline:

```typescript
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'kernel-runtime-worker': resolve(import.meta.dirname, 'src/main/kernel-runtime-worker.ts'),
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
    /* unchanged */
  },
  renderer: {
    /* unchanged */
  },
});
```

**`examples/electron-tau/src/main/index.ts`** — diff: replace `getDefaultKernelWorkerUrl()` with a `pathToFileURL` of the sibling chunk:

```typescript
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { nodeWorkerRunner } from '@taucad/runtime/runner';

const kernelWorkerUrl = pathToFileURL(join(import.meta.dirname, 'kernel-runtime-worker.cjs'));

const host = createRuntimeHost({
  port: hostPort,
  runner: nodeWorkerRunner({ url: kernelWorkerUrl }),
  fileSystem: fsHandle.fs,
});
```

The bootstrap file is one line. The config change is one extra input. The main-process change is two lines + a one-line import. No runtime API changes required.

### Example 2: Browser consumer (Vite app)

**App code** — direct, no plugin needed:

```typescript
import workerUrl from '@taucad/runtime/worker?worker&url';
import { webWorkerRunner } from '@taucad/runtime/runner';
import { createRuntimeClient } from '@taucad/runtime';

const runner = webWorkerRunner({ url: workerUrl });
const client = createRuntimeClient({
  runner,
  kernels: [
    /* … */
  ],
});
```

### Example 3: Webpack 5 consumer (browser or Node)

```typescript
import { webWorkerRunner } from '@taucad/runtime/runner';

const workerUrl = new URL('@taucad/runtime/worker', import.meta.url);
const runner = webWorkerRunner({ url: workerUrl });
```

Webpack's static analysis picks up the bare-specifier `new URL(...)` form (webpack/webpack#16466c8) and emits the worker file under `dist/`.

### Example 4: Plain Node CLI (`@taucad/cli`)

```typescript
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { nodeWorkerRunner } from '@taucad/runtime/runner';

const require = createRequire(import.meta.url);
const workerUrl = pathToFileURL(require.resolve('@taucad/runtime/worker'));
const runner = nodeWorkerRunner({ url: workerUrl });
```

Node 20.6+ alternative without `createRequire`:

```typescript
const workerUrl = new URL(import.meta.resolve('@taucad/runtime/worker'));
```

## Diagrams

### Current (broken) resolution under workspace + electron-vite

```
┌──────────────────────────┐
│  examples/electron-tau   │
│   src/main/index.ts      │
│  ─────────────────────   │
│  nodeWorkerRunner({      │
│    url: getDefault…()    │ ─┐
│  })                      │  │ (1) call site
└──────────────────────────┘  │
                              ▼
┌──────────────────────────────────────────────────────┐
│  electron-vite (Rolldown) bundles main pipeline      │
│  ──────────────────────────────────────────────────  │
│  externalizeDepsPlugin sees @taucad/runtime in       │
│  workspace deps → does NOT externalize (no dist/)    │
│  → inlines runtime source (10 200 LOC) into          │
│  dist/main/index.cjs, INCLUDING                      │
│  getDefaultKernelWorkerUrl                           │
└──────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────┐
│  At runtime inside dist/main/index.cjs               │
│  ──────────────────────────────────────────────────  │
│  import.meta.url   = file:///.../dist/main/index.cjs │
│  new URL('../framework/kernel-runtime-worker.js',    │
│          import.meta.url)                            │
│                    = file:///.../dist/framework/     │
│                                  kernel-runtime-…js  │
│                                                      │
│  ❌ no such file emitted ⇒ worker_threads.Worker     │
│                            never spawns ⇒ 60 s       │
│                            Playwright timeout        │
└──────────────────────────────────────────────────────┘
```

### Recommended resolution (R2 + R3)

```
┌──────────────────────────┐    ┌──────────────────────────┐
│  src/main/index.ts       │    │  src/main/               │
│  ─────────────────────   │    │  kernel-runtime-worker.ts│
│  import { pathToFileURL }│    │  ─────────────────────   │
│  url = pathToFileURL(    │    │  import '@taucad/runtime │
│    join(__dirname,       │    │           /worker';      │
│    'kernel-runtime-      │    └──────────────────────────┘
│    worker.cjs'))         │                  │
└──────────────────────────┘                  │
            │                                 │
            │      both are inputs to         │
            ▼                                 ▼
┌──────────────────────────────────────────────────────┐
│  electron.vite.config.ts                             │
│  ──────────────────────────────────────────────────  │
│  rollupOptions.input = {                             │
│    index:                ./src/main/index.ts,        │
│    'kernel-runtime-worker':                          │
│       ./src/main/kernel-runtime-worker.ts            │
│  }                                                   │
│  output.entryFileNames = '[name].cjs'                │
└──────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────┐
│  dist/main/                                          │
│   ├── index.cjs                                      │
│   └── kernel-runtime-worker.cjs   ← sibling chunk    │
│                                                      │
│  pathToFileURL(join(__dirname,                       │
│   'kernel-runtime-worker.cjs'))                      │
│   = file:///.../dist/main/kernel-runtime-worker.cjs  │
│   ✅ exists; nodeWorkerRunner spawns successfully    │
└──────────────────────────────────────────────────────┘
```

## References

### Vite

- [vitejs/vite#15547 — How to bundle a worker in library mode?](https://github.com/vitejs/vite/discussions/15547)
- [vitejs/vite#15618 — Bundling a worker in library mode results in 404](https://github.com/vitejs/vite/issues/15618) (open since 2024-01)
- [vitejs/vite#15886 — Vite 6 discussion: maintainer recommendation to invert URL resolution](https://github.com/vitejs/vite/discussions/15886)
- [vitejs/vite#20644 — multiline new URL(..., import.meta.url) regression fix](https://github.com/vitejs/vite/pull/20644) (Vite 7.1)
- [vitejs/vite#21422 — Importing worker from a Vite library fails because of dependency optimization](https://github.com/vitejs/vite/issues/21422)
- [vitejs/vite#21434 — fix(optimizer): map relative new URL paths to correct relative file location](https://github.com/vitejs/vite/issues/21434) (closed 2026-01)
- [vitejs/vite#7439 — Prefer worker condition for web-workers](https://github.com/vitejs/vite/issues/7439)

### Webpack

- [Webpack — Web Workers guide](https://webpack.js.org/guides/web-workers/)
- [Webpack 5.105 — Automatic Module Resolution for Web Workers (`worker` export condition)](https://webpack.js.org/blog/webpack-5-105/)
- [webpack/webpack@16466c8 — deduplicate workers with different URL patterns](https://github.com/webpack/webpack/commit/16466c8ce30f66d79e3116e1a9bf300051dd370b)
- [webpack/webpack.js.org#4898 — Workers not bundling imported files for node environments](https://github.com/webpack/webpack.js.org/issues/4898)

### Electron tooling

- [electron-vite — Worker Threads guide (`?modulePath` / `?nodeWorker`)](https://electron-vite.org/guide/dev#worker-threads)
- [electron-vite/vite-plugin-electron#275 — Correct way of using workers in main](https://github.com/electron-vite/vite-plugin-electron/issues/275)
- [alex8088/electron-vite-worker-example](https://github.com/alex8088/electron-vite-worker-example)
- [alex8088/electron-vite#809 — Worker `?modulePath` in ESM scope](https://github.com/alex8088/electron-vite/issues/809) (fixed in electron-vite 5)
- [Electron Forge — Vite Plugin (multi-entry build pattern)](https://www.electronforge.io/config/plugins/vite)
- [stackoverflow/79607008 — How do I import js files in a worker_thread when using Webpack and Electron Forge?](https://stackoverflow.com/questions/79607008)

### Library shipping patterns

- [GoogleChromeLabs/comlink — endpoint-agnostic worker RPC](https://github.com/GoogleChromeLabs/comlink)
- [ffmpegwasm/ffmpeg.wasm#758 — missing `./worker` export](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/758)
- [ffmpegwasm/ffmpeg.wasm#767 — Export ffmpeg-core.worker.js for core package](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/767)
- [microsoft/monaco-editor — webpack-plugin README](https://github.com/microsoft/monaco-editor/blob/main/webpack-plugin/README.md)
- [developit/web-worker — Native cross-platform Web Workers, works in published npm modules](https://github.com/developit/web-worker)

### Cross-bundler resolution

- [openjs-foundation/bundler-collab-space#7 — Module Resolution: Aligning package.json exports across bundlers](https://github.com/openjs-foundation/bundler-collab-space/issues/7)
- [nodejs/node#31664 — worker_threads: allow URL in Worker constructor](https://github.com/nodejs/node/pull/31664)
- [nodejs/node#30780 — Worker instantiation from URLs](https://github.com/nodejs/node/issues/30780)

### Related Tau research

- `docs/research/runtime-channel-blueprint-v5.md` — overall v5 transport architecture this work plugs into
- `docs/research/runtime-cross-origin-isolation-distribution.md` — sibling distribution concern (COEP/COOP, WASM assets)

## Appendix

### A. Tau runtime entry points relevant to worker shipping

From `packages/runtime/tsdown.config.ts`:

```
src/index.ts                              → @taucad/runtime
src/runner/index.ts                       → @taucad/runtime/runner
src/host/index.ts                         → @taucad/runtime/host
src/framework/kernel-runtime-worker.ts    → @taucad/runtime/worker  ← THE ONE
src/filesystem/index.ts                   → @taucad/runtime/filesystem
src/plugins/kernels-entry.ts              → @taucad/runtime/kernels
src/plugins/middleware-entry.ts           → @taucad/runtime/middleware
src/plugins/transcoder-factories.ts       → @taucad/runtime/transcoder
…
```

The worker entry is built standalone (the `unbundle: true` tsdown setting plus the dedicated entry list), so consumers receive `dist/{esm,cjs}/framework/kernel-runtime-worker.{js,cjs}` as a self-contained module.

### B. Per-consumer matrix after the recommendations land

| Consumer                                       | URL construction                                                                                              | Runner                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `apps/ui` (current — `inProcessRunner`)        | n/a — kernel inline                                                                                           | `inProcessRunner()`                   |
| `apps/ui` (future SharedWorker variant)        | `import workerUrl from '@taucad/runtime/worker?worker&url'`                                                   | `webWorkerRunner({ url: workerUrl })` |
| `examples/electron-tau` (Phase 14)             | `pathToFileURL(join(import.meta.dirname, 'kernel-runtime-worker.cjs'))` from electron-vite multi-input bundle | `nodeWorkerRunner({ url })`           |
| `@taucad/cli`                                  | `new URL(import.meta.resolve('@taucad/runtime/worker'))`                                                      | `nodeWorkerRunner({ url })`           |
| 3rd-party Vite app                             | `import workerUrl from '@taucad/runtime/worker?worker&url'`                                                   | `webWorkerRunner({ url: workerUrl })` |
| 3rd-party webpack 5 app                        | `new URL('@taucad/runtime/worker', import.meta.url)`                                                          | `webWorkerRunner({ url })`            |
| 3rd-party electron-vite app                    | own bootstrap file + `?modulePath`                                                                            | `nodeWorkerRunner({ url })`           |
| 3rd-party electron-forge (vite) app            | second `build` entry pointing at own bootstrap                                                                | `nodeWorkerRunner({ url })`           |
| Future `@taucad/runtime/electron` host package | `createElectronRuntimeBackend({ workerUrl, fileSystem })` — workerUrl supplied by app                         | composed internally                   |

### C. Files to delete / modify under the recommendations

| Action                          | Path                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Delete                          | `packages/runtime/src/runner/get-default-kernel-worker-url.ts`                                     |
| Modify (remove export)          | `packages/runtime/src/runner/index.ts`                                                             |
| Modify (remove entry)           | `packages/runtime/tsdown.config.ts` (no — entry not present; helper is bundled into runner barrel) |
| Modify (replace JSDoc examples) | `packages/runtime/src/runner/web-worker-runner.ts`, `node-worker-runner.ts`                        |
| Modify (replace example)        | `apps/ui/content/docs/(runtime)/concepts/worker-model.mdx`                                         |
| New                             | `examples/electron-tau/src/main/kernel-runtime-worker.ts`                                          |
| Modify                          | `examples/electron-tau/electron.vite.config.ts`                                                    |
| Modify                          | `examples/electron-tau/src/main/index.ts`                                                          |
