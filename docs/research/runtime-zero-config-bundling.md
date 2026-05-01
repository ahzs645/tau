---
title: 'Runtime Zero-Config Bundling: WASM, Fonts, and Plugin Modules'
description: 'How @taucad/runtime should ship binaries and dynamically-loaded plugins so consumers (Vite, Node CLI, edge) bundle them transparently with no per-asset configuration'
status: active
created: '2026-04-26'
updated: '2026-04-26'
category: architecture
related:
  - docs/research/runtime-cross-origin-isolation-distribution.md
  - docs/research/cli-runtime-ergonomics.md
  - docs/research/dynamic-runtime-plugins.md
  - docs/research/lazy-capabilities-manifest.md
  - docs/policy/runtime-architecture-policy.md
---

# Runtime Zero-Config Bundling: WASM, Fonts, and Plugin Modules

How `@taucad/runtime` should ship its WASM binaries, fonts, and dynamically-loaded plugin modules so every downstream consumer — browser apps, Node CLIs, edge functions, custom Vite/Rolldown/Webpack hosts — picks them up transparently without hand-rolling `copy-files-from-to.cjson` rules, manual `?url` imports, or per-binary tsdown declarations.

## Executive Summary

The CLI's pure-Node packaging attempt regressed because we treated the runtime as something to flatten into one file. That conflict surfaced because `@taucad/runtime` deliberately uses two ESM-native idioms — `new URL('./x.wasm', import.meta.url)` for binary assets and `await import(/* @vite-ignore */ moduleUrl)` for swappable kernel/middleware/transcoder plugins — and aggressive `inlineDynamicImports` + `noExternal: [/.*/]` defeats both.

**Finding**: every modern bundler in April 2026 (Vite, Rolldown, Rollup, Webpack 5, Parcel 2, esbuild) recognises `new URL(LITERAL, import.meta.url)` as a _first-class asset reference_. Libraries that distribute WASM today succeed by **(a)** authoring that exact expression with a string literal, **(b)** publishing each plugin/kernel as a _separate_ dist file (so the dynamic `moduleUrl` resolves to a real chunk), and **(c)** opting their package out of consumer pre-bundlers that strip `import.meta.url`. The runtime already does (a) and (b); what's missing is a thin Vite plugin that does (c) and a CLI build strategy that _does not_ try to flatten the dynamic plugin graph.

**Recommended direction**:

1. **Author** every binary URL as `new URL('LITERAL', import.meta.url).href` (already done). Never compute paths from variables.
2. **Publish** each kernel/middleware/transcoder/bundler as its own dist chunk (already done; finish the missing `tsdown` entries audited earlier).
3. **Ship** a single `@taucad/runtime/vite` helper that injects the _invariants_ every consumer needs (`optimizeDeps.exclude`, `assetsInlineLimit: 0` for `.wasm`, COOP/COEP) so consumer `vite.config.ts` collapses to one line.
4. **Build** the CLI as a _shim_, not a monolith: bundle the CLI shell, mark `@taucad/runtime` and all kernels external, ship them via npm dependencies. Node's ESM resolver loads `new URL` and `import(moduleUrl)` correctly against `node_modules/@taucad/runtime/dist/`.
5. **Track** the WebAssembly ESM-Integration phase 3 + source-phase imports (Node 24+, Chrome 131+, Deno 2.6+) as the next-generation replacement for `new URL(...wasm, import.meta.url)`. Stay on the current pattern until bundler support matures.

This collapses the bundling story to one rule: _"if it's authored as `new URL(literal, import.meta.url)`, every downstream tool already knows what to do."_

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Trade-offs](#trade-offs)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix](#appendix)

## Problem Statement

The CLI work surfaced three intertwined symptoms:

1. **`Cannot find module '/dist/middleware/parameter-cache.middleware.js'`** when running the `taucad` CLI bundled with `inlineDynamicImports: true`. The runtime worker resolves middleware via `new URL('../middleware/parameter-cache.middleware.js', import.meta.url).href` and then dynamically imports that string. After flattening the entire dynamic-import graph into one file, the `import.meta.url` of the bundle no longer points at a directory containing the middleware chunk.
2. **`module is not defined in ES module scope`** when `jszip` (a CJS-only dependency dynamically imported by `@taucad/filesystem`) was inlined into ESM without a CJS wrapper. Externalising it fixed the symptom but exposed a deeper question: _which_ third-party deps should the runtime bundle, and which should it externalise?
3. **`Cannot find module '/libs/types/src/constants/api.constants.js'`** when running the _built_ `dist/esm/node.js` directly with pure Node. Workspace `package.json#exports` map sibling packages (`@taucad/types`, `@taucad/utils`, `@taucad/chat`) to their `.ts` source. Node's ESM resolver cannot execute TypeScript without `oxc-node`. So even a "fully built" runtime doesn't run on plain Node from inside the workspace.

Underneath all three symptoms is a single architectural question:

> How do we package binaries (WASM + fonts) and dynamically-loaded plugin modules so that one library source serves browsers, Node CLIs, and edge runtimes, **without** asking each consumer to redeclare every asset and **without** breaking when a CLI wants to ship as a single executable?

The user's stated requirements:

- **No manual binary declaration** in consumer Vite/tsdown configs (today's `apps/ui/copy-files-from-to.cjson` and the CLI's `binBundleConfig.onSuccess` hook are the smell).
- **Preserve `new URL(...)` import sequences** so each plugin lands in its own file at consumer build time.
- **Use the latest ESM module-loading practices (April 2026)** — works equally in CLI Node and browsers.

## Methodology

This investigation combined four sources:

1. **In-tree audit** of every `new URL(...wasm)`, `new URL(...js)`, `await import(moduleUrl)`, and consumer build/Vite config in `packages/runtime`, `apps/ui`, `apps/api`, `kernels/openscad`, `libs/vite`, and `packages/cli`.
2. **Bundler reference reading**: rolldown changelog and `rolldown_plugin_vite_asset_import_meta_url` source (Nov 2025), Vite 7/rolldown-vite asset docs, esbuild API docs, Webpack 5 asset modules, Parcel 2 asset references.
3. **Peer-library survey**: how `ffmpeg.wasm`, `@duckdb/duckdb-wasm`, `monaco-editor`, `replicad`/`opencascade.js`, `@gltf-transform/core`, `wasm-pack`, `wasm-bindgen-rayon` ship binaries and ask consumers to wire them up.
4. **TC39 / WebAssembly spec status**: Import Attributes (ES2025, stage 4), Source Phase Imports (TC39 stage 3 + WebAssembly ESM-Integration phase 3), Node 24's `--experimental-wasm-modules` unflagging.

## Findings

### Finding 1: `new URL(LITERAL, import.meta.url)` is the de-facto cross-bundler convention

Every modern bundler treats `new URL(STRING_LITERAL, import.meta.url)` as a static asset reference — not as runtime code. The expression is valid ESM that resolves natively in browsers and Node, **and** the bundler statically rewrites the literal to the hashed asset URL during build. Sources:

| Bundler             | Behaviour                                                                   | Notes                                                                        |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Vite (Rollup)**   | Native; transforms to hashed URL at build, leaves untouched in dev          | "URL string must be static so it can be analyzed" — Vite docs                |
| **Vite (Rolldown)** | `rolldown_plugin_vite_asset_import_meta_url` (Nov 2025) — AST-based via OXC | Supports static + template-literal forms; `@vite-ignore` opt-out             |
| **Webpack 5**       | `asset/resource` module type emits the file beside the bundle               | Same syntax; documented in MDN/web.dev                                       |
| **Rollup**          | `@web/rollup-plugin-import-meta-assets`                                     | Handles arbitrary asset types                                                |
| **Parcel 2**        | Native                                                                      | URL dependency tracking                                                      |
| **esbuild**         | Plugin-based (`?url` query or custom `onResolve`/`onLoad`)                  | Source phase imports also planned                                            |
| **Node ESM**        | Native                                                                      | `import.meta.url` is the file URL of the current module; no transform needed |

The pattern's killer property: it is _valid ESM_. Browsers and Node execute the unmodified expression correctly. Bundlers only need to _rewrite the literal_ — they don't need to invent new syntax.

> "This pattern can be detected statically by tools, almost as if it was a special syntax, yet it's a valid JavaScript expression that works directly in the browser, too." — web.dev, _Bundling non-JavaScript resources_

The runtime already authors **all** WASM/font URLs this way (5 WASM, 2 TTFs, 1 sourcemap; complete inventory in [Appendix A](#appendix-a-runtime-asset-inventory)). No work needed in source authoring.

### Finding 2: Dynamic plugin loading via `await import(moduleUrl)` requires _separate dist chunks_

The runtime's plugin contract:

```ts
// packages/runtime/src/kernels/replicad/replicad.plugin.ts
export const replicad = createKernelPlugin({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  // ...
});
```

```ts
// packages/runtime/src/framework/kernel-runtime-worker.ts
const module = await import(/* @vite-ignore */ config.moduleUrl);
definition = module.default;
```

This pattern is _intentional_: it lets a host application register only the kernels it needs, and lets the worker lazy-load each kernel module on first use. There are 12 such `moduleUrl` declarations (6 kernels, 1 transcoder, 1 bundler, 4 middleware — full table in [Appendix B](#appendix-b-plugin-module-inventory)).

For the contract to work, each `moduleUrl` target must exist as a real file at the URL constructed from `import.meta.url`. Two failure modes:

| Failure                                                                                                                  | Root cause                                                                                                                                                                                                        | Fix                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Module not found at `dist/middleware/parameter-cache.middleware.js` after CLI bundling with `inlineDynamicImports: true` | Rolldown flattens all dynamic imports into the single output, but the `moduleUrl` _string_ still points at `<bundle-dir>/middleware/...`. The `@vite-ignore` comment tells the bundler to leave the import alone. | Don't flatten. Keep one chunk per plugin.                             |
| `Cannot find module '/dist/runtime/...'` in workspace dev                                                                | The runtime's `tsdown` `entry` array was missing 14 of the 32 `package.json` exports. Some plugin chunks were never built.                                                                                        | Audit `entry` array against `package.json#exports` (already started). |

The correct mental model: **plugin chunks are part of the public API surface, not internal modules to be optimised away**. Treat them like `dist/middleware/*.js` are first-class published files — because consumers' workers will dynamically import them.

Rolldown's `output.preserveModules` and the per-entry `emitFile({ type: 'chunk', preserveEntrySignature: 'strict' })` API both support this shape. The runtime's `tsdown.config.ts` already lists each plugin as its own `entry`, so the published `dist/esm/` tree mirrors source.

### Finding 3: Vite _pre-bundles_ dependencies, which corrupts `import.meta.url`

A widely-reported Vite gotcha: when a dependency uses `new URL('./asset.wasm', import.meta.url)`, Vite's esbuild-based `optimizeDeps` may copy the dep into `node_modules/.vite/deps/<dep>.js`. The dep's `import.meta.url` then resolves to the cache directory, which does **not** contain the original WASM file → 404.

The standard recipe (used by `opencascade.js`, `@duckdb/duckdb-wasm`, `@undecaf/zbar-wasm`, every `wasm-pack`-built dep) is two settings in the consumer's `vite.config.ts`:

```ts
export default defineConfig({
  optimizeDeps: {
    exclude: ['@taucad/runtime', '@taucad/openscad' /* every WASM-bearing kernel */],
  },
  build: {
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? 0 : undefined),
  },
});
```

This is the _only_ invariant a Vite consumer needs. There is no way for a library author to author code that is robust to consumer pre-bundling without these settings (`upstream Vite issue #8427` has been open since 2022; `#21434` was filed Jan 2026 to _finally_ map relative `new URL` paths after pre-bundling but is not yet merged).

**The user's request "no additional vite/tsdown config"** is therefore _partially achievable_: we cannot eliminate the two-line opt-out, but we _can_ ship it as a single Vite plugin that consumers add once.

### Finding 4: Peer libraries fall into three distribution patterns

Surveying the most cited WASM/binary-bearing JS libraries:

| Library                                             | Pattern                                                                                                | Consumer experience                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **ffmpeg.wasm** (`@ffmpeg/ffmpeg` + `@ffmpeg/core`) | **Runtime URL injection** — consumer passes `coreURL`/`wasmURL` as strings (CDN, blob, or self-hosted) | Manual; works everywhere                                                                            |
| **@duckdb/duckdb-wasm**                             | **`?url` imports per variant** + manual bundle declaration                                             | Vite users write `import wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'` for each variant |
| **monaco-editor**                                   | **`?worker` imports** + `MonacoEnvironment.getWorker` (or `vite-plugin-monaco-editor`)                 | Either ~30 lines of switch/case in user code, or a community Vite plugin                            |
| **replicad / opencascade.js**                       | `vite-plugin-wasm` + `optimizeDeps.exclude` + `?url` import                                            | 3-line consumer config + 1 import                                                                   |
| **wasm-pack `--target web`, wasm-bindgen-rayon**    | `new URL(literal, import.meta.url)` pattern emitted by toolchain                                       | Bundler picks it up; **zero consumer config** for any modern bundler                                |
| **@gltf-transform/core**                            | Pure JS; pluggable codecs (draco3d) injected at runtime by consumer                                    | Decoupled; consumer chooses codecs                                                                  |
| **esbuild-wasm**                                    | Both: `new URL` for the WASM, plus `initialize({ wasmURL })` runtime override                          | Library lets bundler handle it OR consumer overrides                                                |

**The wasm-pack pattern wins**: zero consumer config because the library _only_ uses the `new URL(literal, import.meta.url)` idiom. Every modern bundler picks it up. The runtime is structurally identical to wasm-pack's output — so consumers should get the same experience, modulo the Vite pre-bundling opt-out (Finding 3).

### Finding 5: Source-phase WASM imports are stage 3 — adopt later, not now

The TC39 Source Phase Imports proposal + WebAssembly/ESM Integration phase 3 enable:

```ts
import source replicadModule from './replicad.wasm';
const instance = await WebAssembly.instantiate(replicadModule, imports);
```

| Environment   | Status (April 2026)                                     |
| ------------- | ------------------------------------------------------- |
| Chrome V8     | M131+ (shipped)                                         |
| Node.js       | 24+ unflagged (PR #57038) — stage 1.2 release candidate |
| Deno          | 2.6+                                                    |
| Firefox       | Not yet                                                 |
| Safari        | Not yet                                                 |
| Vite/Rolldown | No first-class transform yet                            |

This is the _future_ of WASM loading: a single import statement, no `fetch + compile + instantiate` boilerplate, no bundler-specific URL rewriting, full CSP support without `wasm-unsafe-eval`. But until Safari and the bundler ecosystem catch up, it is not a viable replacement for `new URL(...wasm, import.meta.url)`. **Track, don't adopt** — revisit Q4 2026.

Import Attributes (`with { type: 'json' }`) are stage 4 (ES2025) and stable for JSON. WebAssembly via attributes is still under discussion. Same recommendation: track.

### Finding 6: The CLI should not flatten the runtime

The CLI's `binBundleConfig` with `noExternal: [/.*/]` + `inlineDynamicImports: true` is fundamentally incompatible with the runtime's plugin contract (Finding 2) and asset-emission contract (Finding 1). Even if we made it work, the resulting bundle would:

- Inline ~30+ MB of WASM as base64 (unacceptable startup cost on Node).
- Inline kernel modules that should be code-split (a `taucad export --ext=stl` invocation should not eagerly load `@kittycad/lib`, `manifold-3d`, OpenSCAD WASM, etc.).
- Re-bundle dependencies that are already correctly consumable from `node_modules` (`opencascade.js`, `replicad`, etc.).
- Force us to maintain `external` allowlists per CJS-only dep (`jszip` was the first; there will be more).

Compare to peer CLIs:

| CLI                             | Bundle strategy                                                                    | Dependencies                            |
| ------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| `@gltf-transform/cli`           | Bundles only the CLI shell (commander + handlers); deps loaded from `node_modules` | `peerDependencies` for swappable codecs |
| `esbuild` (the Go binary aside) | The Node `esbuild` package's CLI is a tiny shim over the Go binary                 | None to bundle                          |
| `tsx` / `tsm`                   | Tiny shim over registered loaders                                                  | Loaders shipped as deps                 |
| `vite`                          | CLI is a thin wrapper over `vite/dist/node`                                        | All deps via `node_modules`             |
| `wrangler`, `next`, `astro`     | Same pattern: shim + dependency tree                                               | All deps via `node_modules`             |

**None of the major Node CLIs in this space ship as a single flattened file**. They all rely on `npm install` to materialise dependencies, then a small shim invokes them. The `scripts/dist/repos.js` example the user pointed to is appropriate for _internal scripts_ (no native/WASM deps, no plugin contract) but is the wrong template for a runtime CLI.

### Finding 7: Workspace `exports → src/*.ts` blocks pure-Node smoke tests in-monorepo

Even after fully building `@taucad/runtime`, running `node /path/to/runtime/dist/esm/node.js` from inside the workspace fails because sibling packages' `package.json#exports` map to source `.ts` files — the canonical workspace dev convention. Pure Node cannot resolve those.

Two options:

- **Monorepo-only runtime**: continue dev with `oxc-node`. CLI smoke tests run via `pnpm exec node --import @oxc-node/core/register`. Only consumers _outside_ the monorepo (npm-installed) get the pre-built `dist/` paths via `publishConfig.exports`.
- **Build everything before CLI smoke**: run `pnpm nx build types utils chat runtime` then test the CLI against `dist/`. Slow.

The monorepo-only path is consistent with how every other workspace runtime is tested (e.g. apps/api uses `oxc-node` in dev). The CLI's _published_ binary will resolve correctly because npm-installed `@taucad/types` ships `dist/`-mapped exports.

## Trade-offs

### Bundling Strategies for the CLI

| Strategy                                                       | Bundle size       | Startup time               | Plugin contract | jszip/CJS interop           | Maintenance            |
| -------------------------------------------------------------- | ----------------- | -------------------------- | --------------- | --------------------------- | ---------------------- |
| **Monolithic** (`noExternal: [/.*/]` + `inlineDynamicImports`) | 30+ MB            | Slow (eager-load all WASM) | **Broken**      | Manual `external` allowlist | High                   |
| **Shim + node_modules** _(recommended)_                        | ~200 KB           | Fast (lazy WASM)           | **Works**       | Native CJS support          | Low                    |
| **Bun/Deno single binary**                                     | 80+ MB native exe | Fastest                    | Works           | Works                       | Medium (per-OS builds) |

### Asset Distribution Patterns

| Pattern                                                      | Consumer config                          | Cross-bundler portability          | Browser native | Node native  |
| ------------------------------------------------------------ | ---------------------------------------- | ---------------------------------- | -------------- | ------------ |
| `new URL(literal, import.meta.url)` _(current; recommended)_ | 1 line (`optimizeDeps.exclude` for Vite) | All major bundlers                 | Yes            | Yes          |
| `import url from 'pkg/asset.wasm?url'`                       | Per-asset import in user code            | Vite/Webpack only                  | No             | No           |
| Runtime `coreURL`/`wasmURL` injection (ffmpeg style)         | URL string per asset                     | Bundler-agnostic                   | Yes            | Yes          |
| Source phase imports (`import source x from './x.wasm'`)     | None                                     | Stage 3 — Chrome/Node 24/Deno only | Yes            | Yes (24+)    |
| Import attributes (`with { type: 'wasm' }`)                  | None                                     | Spec under discussion              | Partial        | Experimental |

### Where the Vite Plugin Lives

| Location                                                    | Pros                                                                                                         | Cons                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `@taucad/runtime/vite` _(recommended)_                      | Co-located with what it configures; consumers add `@taucad/runtime` and get the plugin from the same install | Couples runtime to a peer-dep on Vite types                     |
| `@taucad/vite`                                              | Already exists; centralises Vite plugins                                                                     | Consumers need a second install just for the runtime invariants |
| `@taucad/runtime` core export (`registerWithBundler(vite)`) | One import                                                                                                   | Hides the Vite-specific shape; harder to type                   |

The current `@taucad/runtime/vite` already exports `crossOriginIsolation()`. Adding a `runtimeVitePlugin()` that bundles all invariants is the natural extension.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                       | Priority | Effort | Impact          | Status                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | --------------- | ------------------------------------------------ |
| R1  | Stop attempting to bundle the CLI as a single executable. Build it as a thin shim with `@taucad/runtime` and all kernels marked `external`. Ship deps via `dependencies`.                                                                                    | **P0**   | Low    | High            | **RESOLVED**                                     |
| R2  | Promote `@taucad/runtime/vite`'s existing `crossOriginIsolation()` plugin into a single `runtime()` plugin that also sets `optimizeDeps.exclude` and `assetsInlineLimit:0` for `.wasm`.                                                                      | P0       | Low    | High            | **RESOLVED**                                     |
| R3  | Finish auditing `packages/runtime/tsdown.config.ts` `entry` array against `package.json#exports` so every public subpath builds to its own `dist/esm/*.js` chunk. (In progress; complete the remaining 14.)                                                  | P0       | Low    | High            | **RESOLVED**                                     |
| R4  | Document the consumer contract: _one_ Vite plugin import + adding `@taucad/runtime` as a dep is the entire setup. Add a `cross-origin-isolation.mdx`-style guide for "Bundling the runtime in your app".                                                     | P1       | Medium | High            | **RESOLVED**                                     |
| R5  | Audit every `new URL(...)` site in `packages/runtime/src` to confirm the first arg is a _string literal_ (no template literals with variables, no computed paths). Add an oxlint rule to enforce.                                                            | P1       | Low    | Medium          | **RESOLVED**                                     |
| R6  | Add a `@taucad/runtime/webpack` and `@taucad/runtime/rolldown` plugin with the same shape as the Vite one, so non-Vite consumers get the same one-liner.                                                                                                     | P2       | Medium | Medium          | **PARTIAL — Rolldown shipped, Webpack deferred** |
| R7  | Add a `peerDependencies` entry on each kernel package (`@taucad/openscad` already isolated; do the same for replicad/opencascade/manifold/jscad/zoo as separate packages over time) so consumers tree-shake by _not installing_ unused kernels.              | P2       | High   | High            | **DEFERRED — see Future Work**                   |
| R8  | Track WebAssembly ESM-Integration phase 4 + Vite/Rolldown `import source` support; write a follow-up migration research doc when Safari ships and Vite has a transform. Do **not** adopt before Safari support.                                              | P3       | Low    | Future-proofing | **DEFERRED — track only**                        |
| R9  | Drop `inlineDynamicImports` and `noExternal: [/.*/]` from `packages/cli/tsdown.config.ts`. Keep CJS-only deps (`jszip`) external.                                                                                                                            | P0       | Low    | High            | **RESOLVED**                                     |
| R10 | For headless Node usage (CLI, smoke tests, benchmarks), stop trying to load `dist/esm/node.js` from the source workspace; standardise on `node --import @oxc-node/core/register` for in-monorepo dev and on the published `dist/` for consumer-facing usage. | P1       | Low    | Medium          | **RESOLVED**                                     |

### Future Work

- **R6 — Webpack plugin**: The Webpack 5 plugin author API uses a `class { apply(compiler) {} }` shape with a `webpack` peer dependency, and integration testing it requires a Webpack-driven consumer fixture we do not currently host. Shipping the plugin without an integration test would land an unverifiable surface. Track until either (a) a real Webpack consumer arrives, or (b) we add a minimal Webpack fixture project. The Vite/Rolldown plugins cover ~95% of the JS ecosystem in April 2026.
- **R7 — Per-kernel package extraction**: The `@taucad/openscad` extraction is the proof point; replicating it for replicad/opencascade/manifold/jscad/zoo is multi-day work per kernel (build harness, public surface audit, downstream tau-runtime imports, kernel-specific test fixtures). The current PR keeps the kernels co-located inside `@taucad/runtime`. The bundler invariants shipped here apply equally to extracted-kernel packages, so the eventual extraction does not require rewriting any of this PR's plugin shapes.
- **R8 — WebAssembly source-phase imports / Import Attributes**: Safari has not shipped support as of April 2026, and Vite/Rolldown do not yet expose a plugin transform for them. The current `new URL(literal, import.meta.url)` pattern is broadly supported and stable; revisit when Safari ships and `vite-plugin-wasm-source-phase` (or equivalent) is published.

## Code Examples

### Recommended runtime Vite plugin (R2)

```ts
// packages/runtime/src/vite/runtime.vite-plugin.ts
import type { Plugin } from 'vite';
import { coiPlugin } from './cross-origin-isolation.vite-plugin.js';

const RUNTIME_PACKAGES = [
  '@taucad/runtime',
  '@taucad/openscad',
  // future: extracted kernels go here
];

const WASM_BEARING_DEPS = [
  'replicad-opencascadejs',
  'opencascade.js',
  'manifold-3d',
  '@kittycad/lib',
  'esbuild-wasm',
  'openscad-wasm-prebuilt',
];

export const runtime = (options?: { crossOriginIsolation?: boolean }): Plugin[] => [
  ...(options?.crossOriginIsolation === false ? [] : [coiPlugin()]),
  {
    name: 'taucad:runtime',
    enforce: 'pre',
    config: () => ({
      optimizeDeps: {
        exclude: [...RUNTIME_PACKAGES, ...WASM_BEARING_DEPS],
      },
      build: {
        assetsInlineLimit: (filePath: string) => (filePath.endsWith('.wasm') ? 0 : undefined),
      },
      worker: {
        format: 'es' as const,
      },
    }),
  },
];
```

Consumer `vite.config.ts` collapses from today's:

```ts
import { defineConfig } from 'vite';
import { crossOriginIsolation } from '@taucad/runtime/vite';
import { tsModuleUrlPlugin } from '@taucad/vite/ts-module-url';

export default defineConfig({
  plugins: [crossOriginIsolation(), tsModuleUrlPlugin() /* ... */],
  build: {
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? 0 : undefined),
  },
});
```

To:

```ts
import { defineConfig } from 'vite';
import { runtime } from '@taucad/runtime/vite';

export default defineConfig({
  plugins: [runtime()],
});
```

### Recommended CLI build (R1, R9)

```ts
// packages/cli/tsdown.config.ts
import { defineConfig, type Options } from 'tsdown';

const cliConfig: Options = {
  entry: { taucad: 'src/bin.ts' },
  format: 'esm',
  outDir: 'dist/bin',
  platform: 'node',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  // Bundle only the CLI shell. Everything else stays in node_modules.
  external: [
    '@taucad/runtime',
    '@taucad/runtime/*',
    '@taucad/types',
    '@taucad/types/*',
    '@taucad/utils',
    '@taucad/utils/*',
    '@taucad/filesystem',
    '@taucad/filesystem/*',
    '@taucad/converter',
    'jszip',
    'replicad',
    'replicad-opencascadejs',
    'opencascade.js',
    'manifold-3d',
    '@kittycad/lib',
  ],
  dts: false,
  minify: false,
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
};

export default defineConfig([cliConfig /*, esmConfig, cjsConfig if still needed for programmatic API */]);
```

Plus in `packages/cli/package.json`:

```json
{
  "bin": { "taucad": "./dist/bin/taucad.js" },
  "dependencies": {
    "@taucad/runtime": "workspace:*",
    "@taucad/types": "workspace:*",
    "@taucad/utils": "workspace:*",
    "@taucad/filesystem": "workspace:*",
    "commander": "^12.0.0"
  }
}
```

### Source code authoring rule (R5)

```ts
// PASS — literal string, statically analysable
const wasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href;

// PASS — template literal with literal segments only (Rolldown supports this)
const wasmUrl = new URL(`./wasm/${kernelName}.wasm`, import.meta.url).href;
//                                  ^^^^^^^^^^^ NOT a literal — Vite/Rolldown
//                                  fall back to "leave untransformed"

// FAIL — runtime variable; bundlers cannot lift this asset
const wasmPath = computeWasmPath(); // e.g. options.wasmUrl ?? defaultPath
const wasmUrl = new URL(wasmPath, import.meta.url).href;
```

The pattern guarantee is _string literal first arg_. Anything else opts out of bundler asset emission.

## Diagrams

### Asset & plugin flow today (works in browser, breaks in CLI bundle)

```
@taucad/runtime SOURCE                 PUBLISHED dist/esm/
─────────────────────                  ───────────────────
replicad.kernel.ts ──new URL─────────► replicad/wasm/replicad_single.wasm
opencascade.kernel.ts ──new URL──────► opencascade/wasm/opencascade_full.wasm
                                       opencascade/wasm/opencascade_full.js
manifold.kernel.ts ──new URL─────────► manifold/wasm/manifold.wasm
zoo.kernel.ts ──new URL──────────────► zoo/wasm/kcl_wasm_lib_bg.wasm
esbuild.bundler.ts ──new URL─────────► bundler/wasm/esbuild.wasm
replicad.kernel.ts ──new URL─────────► replicad/fonts/Geist-Regular.ttf

replicad.plugin.ts ──new URL─────────► replicad.kernel.js   (separate chunk)
manifold.plugin.ts ──new URL─────────► manifold.kernel.js   (separate chunk)
parameter-cache.middleware.ts ───────► middleware/parameter-cache.middleware.js
…                                      …

CONSUMER (Vite browser app)            CONSUMER (CLI on Node)
───────────────────────────            ──────────────────────
import { runtime } from               import {createNodeClient} from
   '@taucad/runtime/vite';               '@taucad/runtime/node';
plugins: [runtime()]                   client.export('stl', …)
                                       │
Vite picks up new URL(...) ──►         Node ESM resolves new URL(...)
emits hashed wasm/font assets          to file:// in node_modules/
emits per-plugin chunks                imports per-plugin chunk by URL
```

### Where the CLI bundle attempt went wrong

```
CLI bundle with inlineDynamicImports:true + noExternal:[/.*/]
────────────────────────────────────────────────────────────────
                                   ┌────────────────────────────┐
ALL plugin chunks ─────flattened──►│  dist/bin/taucad.js (huge) │
ALL deps (incl. jszip) ──inlined──►│                            │
                                   └────────────────────────────┘
                                              │
                                              ▼
At runtime, kernel-runtime-worker.ts evaluates:
   new URL('replicad.kernel.js', import.meta.url).href
 → file:///…/dist/bin/replicad.kernel.js  ◄── FILE DOES NOT EXIST
 → ERR_MODULE_NOT_FOUND
```

### Recommended CLI bundle (shim only)

```
CLI bundle with external:[@taucad/*, replicad, opencascade.js, …]
────────────────────────────────────────────────────────────────
       ┌──────────────────────────────────┐
       │  dist/bin/taucad.js (~200 KB)    │
       │  - commander handlers            │
       │  - import @taucad/runtime/node   │
       └─────────────┬────────────────────┘
                     │ npm-resolved
                     ▼
       node_modules/@taucad/runtime/dist/esm/
         ├── node.js
         ├── kernels/replicad/replicad.kernel.js
         ├── kernels/replicad/wasm/replicad_single.wasm
         ├── middleware/parameter-cache.middleware.js
         └── …
                     │
                     ▼ at runtime
       new URL('replicad.kernel.js', import.meta.url).href
        = file://…/node_modules/@taucad/runtime/dist/esm/kernels/replicad/replicad.kernel.js
        ✓ resolves naturally via Node ESM
```

## References

- [Bundling non-JavaScript resources — web.dev](https://web.dev/articles/bundling-non-js-resources) — the canonical reference for `new URL(...)` as a cross-bundler asset convention
- [Vite — Static Asset Handling](https://vitejs.dev/guide/assets) — `new URL(url, import.meta.url)` section
- [Rolldown — `experimental.resolveNewUrlToAsset`](https://rolldown.rs/options) and changelog PRs #7113, #7140, #7141 (Nov 2025)
- [Rolldown — `output.preserveModules` and `emitFile`](https://rolldown.rs/reference/interface.plugincontext)
- [Vite issue #8427](https://github.com/vitejs/vite/issues/8427) — `new URL(foo, import.meta.url)` doesn't work when dependency was optimised; Vite issue #21434 (Jan 2026) is the long-awaited fix
- [TC39 Source Phase Imports](https://github.com/tc39/proposal-source-phase-imports) — stage 3
- [WebAssembly/ES Module Integration — Phase 3](https://github.com/WebAssembly/esm-integration/blob/main/proposals/esm-integration/README.md)
- [Node.js PR #57038 — unflag `--experimental-wasm-modules`](https://github.com/nodejs/node/pull/57038) — Node 24 native WASM modules
- [TC39 Import Attributes (ES2025, stage 4)](https://2ality.com/2025/01/import-attributes.html)
- [DuckDB-WASM Vite recipe](https://www.npmjs.com/package/@duckdb/duckdb-wasm) — peer-library precedent
- [opencascade.js bundler config](https://ocjs.org/docs/getting-started/configure-bundler) — peer-library precedent
- [esbuild API — Bundling for node](https://esbuild.github.io/api/#bundling-for-node) — `--packages=external` rationale
- Related: `docs/research/runtime-cross-origin-isolation-distribution.md`, `docs/research/cli-runtime-ergonomics.md`, `docs/research/dynamic-runtime-plugins.md`

## Appendix

### Appendix A: Runtime asset inventory

WASM and font assets shipped from `packages/runtime/src/**`, all referenced via `new URL(LITERAL, import.meta.url).href`:

| Asset                                      | Source path                                   | Loader                                                                     | Used by                                     |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| `esbuild.wasm`                             | `bundler/wasm/esbuild.wasm`                   | `esbuild.initialize({ wasmURL })` (browser only — Node uses native binary) | `bundler/esbuild-core.ts`                   |
| `replicad_single.wasm`                     | `kernels/replicad/wasm/replicad_single.wasm`  | `loadWasmBinary`                                                           | `kernels/replicad/replicad.kernel.ts`       |
| `opencascade_full.wasm` (+ `.js`, `.d.ts`) | `kernels/opencascade/wasm/`                   | OCJS bindings                                                              | `kernels/opencascade/opencascade.kernel.ts` |
| `manifold.wasm`                            | `kernels/manifold/wasm/manifold.wasm`         | `setWasmUrl` (manifold-3d)                                                 | `kernels/manifold/init-manifold.ts`         |
| `kcl_wasm_lib_bg.wasm`                     | `kernels/zoo/wasm/kcl_wasm_lib_bg.wasm`       | wasm-bindgen                                                               | `kernels/zoo/kcl-utils.ts`                  |
| `Geist-Regular.ttf`                        | `kernels/replicad/fonts/Geist-Regular.ttf`    | `loadBinaryFile`                                                           | `kernels/replicad/replicad.kernel.ts`       |
| `replicad.js.map`                          | `kernels/replicad/sourcemaps/replicad.js.map` | Stack trace decoder                                                        | `kernels/replicad/replicad.kernel.ts`       |

Plus `kernels/openscad/src/fonts/Geist-{Regular,Bold}.ttf` in the extracted `@taucad/openscad` package.

### Appendix B: Plugin module inventory

Plugin chunks dynamically loaded via `await import(/* @vite-ignore */ moduleUrl)`. Each must exist as a separate file in `dist/esm/` after build:

| Kind       | `id`                      | `moduleUrl` target                                      | Source plugin file                          |
| ---------- | ------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Kernel     | `replicad`                | `replicad.kernel.js`                                    | `kernels/replicad/replicad.plugin.ts`       |
| Kernel     | `opencascade`             | `opencascade.kernel.js`                                 | `kernels/opencascade/opencascade.plugin.ts` |
| Kernel     | `manifold`                | `manifold.kernel.js`                                    | `kernels/manifold/manifold.plugin.ts`       |
| Kernel     | `jscad`                   | `jscad.kernel.js`                                       | `kernels/jscad/jscad.plugin.ts`             |
| Kernel     | `zoo`                     | `zoo.kernel.js`                                         | `kernels/zoo/zoo.plugin.ts`                 |
| Kernel     | `tau`                     | `tau.kernel.js`                                         | `kernels/tau/tau.plugin.ts`                 |
| Kernel     | `openscad` (external)     | `openscad.kernel.js`                                    | `kernels/openscad/src/openscad.plugin.ts`   |
| Bundler    | `esbuild`                 | `../bundler/esbuild.bundler.js`                         | `plugins/bundler-factories.ts`              |
| Transcoder | `converter`               | `converter.transcoder.js`                               | `transcoders/converter/converter.plugin.ts` |
| Middleware | `parameterCache`          | `../middleware/parameter-cache.middleware.js`           | `plugins/middleware-factories.ts`           |
| Middleware | `geometryCache`           | `../middleware/geometry-cache.middleware.js`            | `plugins/middleware-factories.ts`           |
| Middleware | `gltfCoordinateTransform` | `../middleware/gltf-coordinate-transform.middleware.js` | `plugins/middleware-factories.ts`           |
| Middleware | `gltfEdgeDetection`       | `../middleware/gltf-edge-detection.middleware.js`       | `plugins/middleware-factories.ts`           |

### Appendix C: Why `@vite-ignore` is correct on plugin imports

The `await import(/* @vite-ignore */ entry.moduleUrl)` pattern in `kernel-runtime-worker.ts` and `kernel-worker.ts` is intentional. Without `@vite-ignore`, Vite's import-analysis plugin would try to _statically resolve_ `entry.moduleUrl` (a runtime string) at build time, fail, and emit a warning. The `@vite-ignore` tells the bundler "trust the runtime to provide a valid URL" — and the runtime _does_, because `moduleUrl` was constructed at _plugin-definition_ time via `new URL('x.kernel.js', import.meta.url).href`, which Vite _did_ statically analyse and rewrite to a hashed asset URL.

This split (analysed at plugin definition; opaque at dynamic import) is what lets each kernel land in its own chunk while keeping the worker generic.
