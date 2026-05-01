---
title: 'Electron Kernel Bundling Strategy (ESM, WASM, Fonts)'
description: 'How to make @taucad/runtime kernel + transcoder bundles resolve identically across Vite-bundled renderers, Web Workers, and Electron utility processes (Topology C) without forking the kernel author API.'
status: draft
created: '2026-04-28'
updated: '2026-04-28'
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/research/electron-rpc-transport-architecture.md
  - docs/research/runtime-worker-bundling-strategy.md
  - docs/research/runtime-zero-config-bundling.md
---

# Electron Kernel Bundling Strategy (ESM, WASM, Fonts)

How `@taucad/runtime` kernel modules, fonts, and WASM assets should be bundled so a single `defineKernel` author API resolves identically across (a) Vite-bundled browser renderers, (b) browser Web Workers spawned from those renderers, (c) Electron utility processes hosted off the renderer over `MessagePort`, and (d) Node-hosted CLIs / API workers — without forking the author surface or re-introducing per-target string concatenation.

## Executive Summary

Tau's web UI (`apps/ui`) ships kernels via Vite's `new URL(asset, import.meta.url)` contract: every kernel plugin's `moduleUrl` and every kernel-internal asset (replicad WASM, OpenSCAD fonts, OCCT WASM) is resolved at the renderer-bundle boundary. The renderer's Web Worker runs in the same browser asset graph, so dynamic-importing the bundled kernel URL and fetching its asset siblings Just Works.

Electron Topology C (renderer → `utilityProcess.fork` → kernel host) breaks this contract: the utility is a **Node ESM process**, not a Chromium asset graph. Renderer-bundled kernel URLs (`file:///dist/renderer/assets/openscad.kernel-XXX.ts`) are unimportable from Node — wrong file root, wrong extension, browser-targeted bundle.

The fix is **dual-target bundling with id-routed resolution**: kernels keep their single `defineKernel` source, but build infrastructure (electron-vite for Tau, the kernel package's own `tsdown` for downstream consumers) emits Node-compatible chunks alongside the renderer-asset variants. Renderers ship kernel **identifiers** over the wire; the Electron utility process resolves the id to its locally-bundled chunk via a `host.kernels` registry. WASM and font assets travel through `?asset&asarUnpack` so they land outside `app.asar` and survive `path.join` resolution on every platform.

This preserves the existing `RuntimeClient<Kernels, ...>` generic type-safety chain and removes the renderer-asset/Node module mismatch that currently blocks Topology C from rendering geometry end-to-end.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Eigenquestion](#eigenquestion)
- [Methodology](#methodology)
- [Findings](#findings)
- [Trade-offs](#trade-offs)
- [Recommendation](#recommendation)
- [Implementation Plan](#implementation-plan)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

While integrating the v6 `electronUtilityTransport` (per `runtime-transport-architecture-v6.md`), the renderer-side `createRuntimeClient({ transport: electronUtilityTransport, kernels: [openscad()] })` succeeded at:

| Stage                                              | Status |
| -------------------------------------------------- | ------ |
| Renderer requests runtime port via preload IPC     | ✓      |
| Main spawns `utilityProcess.fork(kernel-host.cjs)` | ✓      |
| `MessageChannelMain` allocated and ports relayed   | ✓      |
| Utility wraps `MessagePortMain`, wires dispatcher  | ✓      |
| First wire frame received from renderer            | ✓      |
| `getParameters` / `createGeometry` returns         | ✗      |

Symptom: the utility hangs after receiving the renderer's `initialize` frame because `KernelRuntimeWorker.ensureActiveKernel` calls `import(/* @vite-ignore */ config.moduleUrl)` with the renderer-bundled URL `file:///.../dist/renderer/assets/openscad.kernel-BywVyJyD.ts`. Node's ESM loader cannot import a `.ts` file (no transpiler), and the file is also a browser-targeted Vite asset bundle, not a Node module.

The same architectural fault would block:

- `replicad` kernel (its own `replicad_single.wasm` + `Geist-Regular.ttf` + `replicad.js.map`)
- `manifold` / `jscad` / `opencascade` kernels (each has their own WASM)
- `converterTranscoder` (its underlying `@taucad/converter` ships `assimpjs` + `draco3d` WASM blobs + `rhino3dm.js`)

So the issue is not "OpenSCAD's plugin URL" — it is a load-bearing resolution contract for every kernel and transcoder in `@taucad/runtime`.

## Eigenquestion

> **What is the canonical `kernel.moduleUrl` resolution contract that satisfies BOTH the Chromium ESM loader (renderer + Web Worker) AND the Node ESM loader (Electron main, utility process, CLI / API worker) under a single `defineKernel(...)` author surface — without forcing kernel authors to ship two builds, without leaking transport-target awareness into the runtime core, and without breaking the existing `RuntimeClient<Kernels, Transcoders, Transport>` generic inference?**

Equivalent reformulations:

1. **Build-graph view**: How can a single `kernel.moduleUrl` literal in source produce a renderer-asset URL under Vite's renderer pipeline AND a Node `file://` URL under electron-vite's main pipeline AND a Node `file://` URL under `tsdown`'s kernel package build — with each consumer importing the right artefact?
2. **Wire-protocol view**: Should the `KernelModuleEntry` shipped from client to host be (a) a transport-resolved URL the host blindly imports, (b) an id the host looks up in a local registry, or (c) an opaque token resolved through a host-side resolution hook?
3. **Asset-coupling view**: When a kernel's `.kernel.js` file uses `new URL('asset.wasm', import.meta.url)`, who owns the contract that the resolved URL is reachable from the resolving process's filesystem / network root?

The eigenquestion's answer dictates every other decision in this space.

## Methodology

1. **UI baseline audit** — read `apps/ui/app/constants/kernel-worker.constants.ts`, `apps/ui/app/machines/cad.machine.ts`, `apps/ui/app/hooks/use-project.tsx`, and `packages/runtime/src/vite/index.ts` to capture how the Vite renderer resolves kernel + asset URLs today.
2. **Asset inventory** — `rg "new URL\(.*import\.meta\.url"` across `packages/runtime/src/kernels`, `kernels/openscad`, and `packages/runtime/src/transcoders` to list every place a runtime author depends on `import.meta.url` resolution.
3. **Electron + electron-vite April-2026 web research** — Electron 28+ ESM tutorial, electron-vite Asset Handling guide, electron-vite Isolated Build experimental guide, electron/electron PR #37535 + #48375 (ESM in main + dynamic ESM in preload), electron-builder Application Contents docs.
4. **Failure repro** — built `examples/electron-tau` with the renderer registering `openscad()`, traced Topology-C boot via `TAU_ELECTRON_DEBUG=1`, confirmed the dispatcher hangs at `import(rendererAssetUrl)` from inside the utility process.
5. **Cross-pipeline build-output inspection** — examined `dist/renderer/assets/openscad.kernel-*.ts` (extension preserved by Vite, browser-targeted) vs the published `@taucad/openscad/dist/{esm,cjs}/openscad.kernel.{js,cjs}` (Node-importable).

## Findings

### Finding 1: UI succeeds because renderer + worker share one Vite asset graph

`apps/ui` consumes kernels via:

```typescript
import { openscad } from '@taucad/openscad';
import { replicad } from '@taucad/runtime/kernels';
const opts = createRuntimeClientOptions({ kernels: [openscad(), replicad()], ... });
```

Each kernel plugin's `moduleUrl` is `new URL('xxx.kernel.js', import.meta.url).href`, evaluated **at the consumer's bundler boundary**. Vite emits each kernel as a hashed renderer asset (`/assets/openscad.kernel-XXX.ts`) and rewrites the literal to that URL. The runtime client spawns its kernel worker via `new Worker(new URL('@taucad/runtime/worker', import.meta.url), { type: 'module' })` — also a renderer-asset reference. Inside the worker, `KernelRuntimeWorker.loadKernelModule` does `await import(config.moduleUrl)`; the worker is a sibling Vite asset whose `import()` shares the renderer's `file://`/`http://` asset root, so it resolves cleanly.

Asset-resolution invariants enforced by `@taucad/runtime/vite`:

| Invariant                                    | Mechanism                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Don't pre-bundle runtime / WASM-bearing deps | `optimizeDeps.exclude: [...runtimePackages, ...wasmBearingDeps]`                      |
| Don't inline `.wasm` as base64               | `build.assetsInlineLimit: filePath => filePath.endsWith('.wasm') ? false : undefined` |
| Workers preserve `import.meta.url`           | `worker.format: 'es'`                                                                 |
| Renderer serves COOP/COEP for SAB            | `crossOriginIsolation()` plugin                                                       |

This is a clean, proven, **single-graph** contract.

### Finding 2: Electron utility process is a Node ESM context, not a browser asset graph

`utilityProcess.fork()` spawns a real Node process with `process.parentPort`. Its module resolution is **Node ESM** (`.mjs`/`.cjs`/`"type":"module"` with `.js`), not Chromium's URL-relative loader. Consequences:

| Aspect                          | Browser Worker (UI)             | Electron Utility (Topology C)                     |
| ------------------------------- | ------------------------------- | ------------------------------------------------- |
| Default ESM loader              | Chromium                        | Node ESM                                          |
| `import('file:///foo.ts')`      | Works if Vite served that asset | TypeError: unknown extension                      |
| `import('file:///foo.js')`      | Works if reachable              | Works if it's actual Node ESM, not browser bundle |
| `node_modules` resolution       | Bundler-resolved at build time  | Node resolver at runtime                          |
| `new URL('x', import.meta.url)` | Vite asset URL                  | `file://` to source/dist                          |

A renderer-asset URL is unreachable from inside `utilityProcess.fork`'s root, AND the file is bundled for the browser. **Both axes fail**.

### Finding 3: electron-vite has first-class primitives for this — they were not yet wired

electron-vite v4+ (we use `^4.0.0`) ships exactly the primitives needed:

| Primitive                         | Purpose                                                                                                                                                                    | Where it goes                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `import x from './f?modulePath'`  | Emits `f` as a separate chunk; default export = absolute path. Consumer-side file is NOT bundled into the importer. Use to pass a fork target to `utilityProcess.fork(x)`. | `main/index.ts` referencing `kernel-host.ts`  |
| `import x from './f.wasm?loader'` | Emits `f.wasm` next to importer; default export = `() => Promise<WebAssembly.Instance>`. Replaces inline `WebAssembly.instantiate`. Node-compatible.                       | Main + utility WASM imports                   |
| `import x from './f?asset'`       | Emits `f` next to importer; default export = absolute path. Use for fonts, sourcemaps, `.node` addons.                                                                     | `geistRegularUrl`, `replicadSourceMapUrl`     |
| `?asset&asarUnpack`               | Same as `?asset` but rewrites `path.replace('app.asar', 'app.asar.unpacked')` AND configures electron-builder to unpack it.                                                | All binary assets at the kernel-host boundary |
| `build.isolatedEntries: true`     | Multi-entry pipeline without cross-chunk references. Solves the `rolldown-vite#572` cross-reference bug.                                                                   | `electron.vite.config.ts` `main` block        |
| `build.externalizeDeps.exclude`   | Bundle a specific dependency that would otherwise be externalized.                                                                                                         | `@taucad/openscad` etc. for the main pipeline |

We currently use `externalizeDepsPlugin()` with no exclude list and no `?modulePath` import, which is why `kernel-host.cjs` cannot reach kernel modules.

### Finding 4: ESM in Electron is fully production-ready in April 2026

| Capability                                         | Electron version | Notes                                                                       |
| -------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| ESM main entry (`"type":"module"` or `.mjs`)       | 28+              | Top-level `await` fires before `app.ready` — must `await` setup explicitly. |
| ESM preload (`.mjs`)                               | 28+              | Must NOT be sandboxed; sandboxed preloads remain plain JS only.             |
| Dynamic `import()` in unsandboxed preload          | 28+              | Routes through Node ESM loader if context-isolated.                         |
| Dynamic `import()` in non-context-isolated preload | 36+ (PR #48375)  | Routing distinguished by `v8_host_defined_options` length.                  |
| ASAR-aware ESM resolution                          | 28+ (PR #37535)  | ESM imports inside `app.asar` resolve correctly.                            |
| `utilityProcess` ESM target                        | All current      | Honors `.mjs` / `"type":"module"` like any Node child.                      |

We currently target Electron 36 and `"type": "module"` in `examples/electron-tau/package.json`. We can run ESM end-to-end across main / preload / utility today.

### Finding 5: ASAR-unpack is a hard requirement for runtime WASM/font assets

`electron-builder` packs the app into `app.asar` by default. ASAR is a tar-like format that Node can `fs.readFile` from but **cannot** `dlopen`, `child_process.execFile`, or pass to APIs that re-open the file by path. WASM `WebAssembly.instantiate` works against `Uint8Array`, so reading from ASAR is technically OK, but:

- `path.join(__dirname, 'foo.wasm')` resolves to an in-asar path that some downstream APIs reject.
- Hashed font URLs consumed by Emscripten's virtual FS expect real on-disk files.
- The `?asset&asarUnpack` electron-vite suffix automatically rewrites the resolved path to `app.asar.unpacked` AND emits the file to the unpacked tree.

Recommended `electron-builder` config (or equivalent):

```jsonc
{
  "build": {
    "asar": true,
    "asarUnpack": ["**/*.wasm", "**/*.ttf", "**/*.otf", "**/*.woff", "**/*.woff2", "**/*.node", "**/sourcemaps/**"],
  },
}
```

### Finding 6: Asset URL coupling in current kernels

| File                                                                                           | `new URL(asset, import.meta.url)`                                                    | Works in renderer? | Works in Node utility?                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------- |
| `packages/runtime/src/kernels/replicad/replicad.kernel.ts`                                     | `fonts/Geist-Regular.ttf`, `wasm/replicad_single.wasm`, `sourcemaps/replicad.js.map` | ✓ (Vite)           | ✗ (no Node-target build emits these next to the bundled kernel) |
| `kernels/openscad/src/openscad.kernel.ts`                                                      | `fonts/Geist-Regular.ttf`, `fonts/Geist-Bold.ttf`                                    | ✓                  | ✗                                                               |
| `kernels/openscad/src/openscad.plugin.ts`                                                      | `openscad.kernel.js`                                                                 | ✓                  | ✗                                                               |
| `packages/runtime/src/transcoders/converter/converter.plugin.ts`                               | `converter.transcoder.js`                                                            | ✓                  | ✗                                                               |
| `packages/converter/src/loaders/file-resolver-io.ts` (and assimpjs/draco3d/rhino3dm internals) | several .wasm + .js                                                                  | ✓                  | ✗                                                               |

The renderer side is solved. The Node utility side has no parallel build pipeline emitting the same `import.meta.url`-relative siblings.

### Finding 7: Rolldown-vite multi-entry cross-reference bug (vitejs/rolldown-vite#572)

Multi-entry main pipelines under rolldown-vite can produce cross-references between independent entries (e.g. `kernel-host.cjs` ending up requiring `index.cjs`). This is documented as expected behaviour by rolldown maintainers and is the reason `build.isolatedEntries: true` exists. Without it, kernel-host's CJS output may pull main-process code into the utility process, polluting the utility's globals.

### Finding 8: Renderer cannot rescue the situation alone

Two failed approaches we considered and rejected:

1. **Renderer ships a Node-resolvable URL over the wire**: Renderer would need to call something like `await ipcRenderer.invoke('resolve-kernel-path', '@taucad/openscad/kernel')`. This adds a synchronous main-process dependency, forces the renderer to know its own deployment topology, and breaks if kernels arrive from middleware / runtime extensions that the main process doesn't have a-priori knowledge of.
2. **Utility re-resolves the URL via `require.resolve`**: Works for first-party kernels in `node_modules` (we partially proved this), but fails for kernels embedded as workspace source (`@taucad/openscad` in dev resolves to `./src/openscad.kernel.ts`) AND for runtime-supplied middleware/transcoder kernels that don't expose a stable package path.

The renderer cannot own this. The dual-target bundling must be a **build-system contract** between the kernel author and electron-vite.

### Finding 9: Type safety chain currently end-to-end via phantom carriers

The v6 generic chain — `RuntimeClient<Kernels, Transcoders, Transport>` → `CollectKernelIds<Kernels>` / `ExportFormatsFor<...>` / `CollectRenderOptions<...>` → `client.export({ format, options })` inference — flows entirely through the **types** of the kernel plugin tuple supplied at `createRuntimeClient` call site. The wire never carries types. So as long as the renderer keeps passing `kernels: [openscad(), replicad(), ...]` for **type inference**, the actual wire payload can be anything (URL, id, opaque token) without breaking generics.

This is what makes Recommendation R1 below safe: replacing wire-shipped URLs with wire-shipped ids does not regress any consumer's typed `client.export(...)` surface.

## Trade-offs

| Approach                                                         | Pros                                                                                                                                                    | Cons                                                                                                                   | Verdict                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **A. Renderer hosts kernels (Topology A in renderer)**           | Zero new infra; matches UI exactly; full crash isolation via Web Worker; proven path                                                                    | Heavy CAD shares OS process with React/Three.js; renderer crash blast-radius includes kernel state                     | Acceptable fallback, not the target |
| **B. Dual-build with id-routed resolution (recommended)**        | Single kernel author API; preserves type-safety chain; kernels stay topology-agnostic; works for all kernels uniformly; honors electron-vite primitives | Requires electron-vite config investment; main pipeline build size grows; needs `kernels` field on `RuntimeHostConfig` | **Adopt for v6 Topology C**         |
| **C. Build-time JSON manifest replacing `import.meta.url`**      | Removes runtime URL coupling entirely; works across all bundlers                                                                                        | Breaking change for kernel authors; kernel packages must adopt manifest format; large surface churn                    | Defer to post-v6                    |
| **D. Single-isolate kernel via `inProcessTransport` in utility** | Trivial wiring; no kernel-loading nuance                                                                                                                | Defeats the whole point of Topology C (utility isolation)                                                              | Anti-pattern                        |
| **E. Custom `app.asar` ESM protocol handler**                    | Could let renderer import node_modules                                                                                                                  | Doesn't help utility-process kernel loading at all                                                                     | Wrong layer                         |

## Recommendation

**Adopt Approach B (Dual-Build with Id-Routed Resolution)** for v6 Topology C. The architecture decomposes into five binding decisions:

| #   | Decision                                                                                                                    | Rationale                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1  | Wire ships `KernelModuleEntry` with id only — no `moduleUrl`                                                                | URL is resolved by whichever side actually loads the module; renderer no longer pretends to know the host's filesystem |
| D2  | `RuntimeHostConfig` gains a required-when-no-runner `kernels: ReadonlyArray<KernelPlugin>` field                            | The host owns its own kernel registry just as the client does; symmetry mirrors `kernels` on the client                |
| D3  | `KernelRuntimeWorker.onInitialize` MERGES wire-supplied + host-pre-registered modules (host id wins)                        | Removes the current "wire stomps host" semantics; lets Topology C inject Node-resolvable definitions                   |
| D4  | electron-vite main pipeline imports `kernel-host` via `?modulePath`, kernels via direct ESM, assets via `?asset&asarUnpack` | Honors electron-vite's documented contracts; survives ASAR packaging                                                   |
| D5  | Add `electronUtilityTransport` opinion: `host()` consumes pre-registered kernels from `RuntimeHostConfig.kernels`           | Closes the loop — renderer no longer sends URLs the utility cannot resolve                                             |

Recommendations:

| #   | Action                                                                                                                                                                                                                                                                                                          | Priority | Effort | Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Drop `moduleUrl` from `KernelModuleEntry` shipped over the wire; ship `id` only. Wire schema becomes `{ id, extensions?, options?, builtinModuleNames? }`.                                                                                                                                                      | P0       | Low    | High   |
| R2  | Add `kernels: ReadonlyArray<KernelPlugin>` to `RuntimeHostConfig`; thread through `createRuntimeHost` → `electronUtilityTransport.host()` → dispatcher options                                                                                                                                                  | P0       | Med    | High   |
| R3  | Refactor `KernelRuntimeWorker.onInitialize` to merge `this.kernelModules` (pre-populated by host config) with wire-supplied entries by id — host registration wins on collision                                                                                                                                 | P0       | Low    | High   |
| R4  | Configure `examples/electron-tau/electron.vite.config.ts`: `externalizeDepsPlugin({ exclude: ['@taucad/openscad', '@taucad/runtime/*', '@taucad/rpc'] })`, `isolatedEntries: true`, `main.publicDir: '../resources'`                                                                                            | P0       | Low    | Med    |
| R5  | Migrate `main/index.ts` to import `kernel-host` via `?modulePath` (electron-vite canonical pattern); drop ad-hoc `join(import.meta.dirname, 'kernel-host.cjs')`                                                                                                                                                 | P1       | Low    | Med    |
| R6  | Refactor every `new URL('foo.{wasm,ttf,...}', import.meta.url)` in `packages/runtime/src/kernels/**` and `kernels/openscad/**` to keep the SAME source pattern but rely on electron-vite's `?asset&asarUnpack` rewrite at the consuming pipeline; document the contract in `docs/policy/kernel-asset-policy.md` | P1       | Med    | Med    |
| R7  | Add an `asarUnpack` glob to the example's `electron-builder` (or its successor) config covering `**/*.{wasm,ttf,otf,woff,woff2,node}` and `**/sourcemaps/**`                                                                                                                                                    | P1       | Low    | Med    |
| R8  | Add a transport-conformance test (C18, new) asserting that `RuntimeClient` constructed with a kernel plugin and `electronUtilityTransport` reaches `geometry` event without ever reading the wire-supplied `moduleUrl` field                                                                                    | P1       | Med    | Med    |
| R9  | Update `docs/policy/library-api-policy.md` (or similar) to capture: kernel authors continue to use `new URL(asset, import.meta.url)`; consumers MUST run a Vite-class bundler (vite, electron-vite, rolldown) for the resolution contract to hold                                                               | P2       | Low    | Med    |
| R10 | Document Topology-A renderer fallback as the supported path for Electron consumers who cannot or will not run a parallel main-pipeline build (CLI-style Electron tools)                                                                                                                                         | P2       | Low    | Low    |

R1–R3 unblock e2e immediately; R4–R8 harden the contract for production distribution; R9–R10 close the policy gap.

## Implementation Plan

Per-phase, TDD-style, mirroring the plan format used by `runtime-transport-architecture-v6.md`:

| Phase | Scope                                                                                                                                                                                                           | Conformance hook                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| K1    | Drop `moduleUrl` requirement from wire-shipped `KernelModuleEntry` schema (keep optional for back-compat); add `kernels` field to `RuntimeHostConfig`                                                           | C18 (id-routed wire test, fail-first)            |
| K2    | Plumb `RuntimeHostConfig.kernels` through `createRuntimeHost` → `RuntimeTransportHost.start()` → `createWorkerDispatcher` `dispatcherOptions.kernels`                                                           | Existing C2 transport-conformance                |
| K3    | Refactor `KernelRuntimeWorker.onInitialize` to merge maps; host wins; wire-supplied entries without `moduleUrl` resolve via host registry                                                                       | New unit test in `kernel-runtime-worker.test.ts` |
| K4    | Update `examples/electron-tau/electron.vite.config.ts` per R4 + R5; rebuild; verify `dist/main/kernel-host.cjs` size and that openscad bundles into the main chunk graph                                        | Build smoke + size-limit budget                  |
| K5    | Update `examples/electron-tau/src/main/kernel-host.ts` to construct a `RuntimeHost` via `createRuntimeHost({ transport: electronUtilityTransport, kernels: [openscad()] })` instead of inline dispatcher wiring | Existing render.spec.ts e2e                      |
| K6    | Renderer uses `kernels: [openscad()]` for **type inference only**; wire payload omits `moduleUrl` per K1                                                                                                        | electron-utility-e2e.spec.ts (un-fixme)          |
| K7    | Add `?asset&asarUnpack` rewrite at every `new URL('foo.wasm'/'foo.ttf', ...)` site OR document that consumers must opt in via electron-vite plugin chain                                                        | Asset-resolution test in main pipeline           |
| K8    | Add electron-builder `asarUnpack` glob to the example's packaging config (when packaging path is added; PoC currently runs unpacked)                                                                            | Future package-time test                         |

## Diagrams

### Current (broken) Topology C resolution path

```text
   Renderer (Vite asset graph)            Utility (Node ESM)
   ─────────────────────────              ──────────────────
   import { openscad }
        │
        ▼
   openscad() → KernelPlugin {
     id: 'openscad',
     moduleUrl: 'file:///dist/renderer/         ─┐
                 assets/openscad.kernel-X.ts'    │   wire { kernelModules: [{ id, moduleUrl }] }
   }                                            ───────────────────►
                                                                    │
                                                                    ▼
                                                          import(moduleUrl)
                                                                    │
                                                                    ▼
                                                          ✗ TypeError: Unknown
                                                            file extension ".ts"
                                                            ✗ Path is browser bundle
```

### Recommended Topology C resolution path

```text
   Renderer (Vite asset graph)               Utility (Node ESM, electron-vite main pipeline)
   ─────────────────────────                 ───────────────────────────────────────────────
   import { openscad }              [build]  import { openscad } from '@taucad/openscad'
        │                                          │
        ▼                                          ▼
   openscad() ── type inference ──┐         openscad() → KernelPlugin {
                                   │           id: 'openscad',
   wire { kernelIds: ['openscad'] }│           moduleUrl: 'file:///app/.../openscad.kernel.cjs',
        ───────────────────────────┼──────►    definition: <bundled by electron-vite>
                                   │         }
                                   │              │
                                   │              ▼
                                   └──────► host registry lookup by id
                                                  │
                                                  ▼
                                            kernel.definition.createGeometry(...)
                                                  │
                                            assets resolved via
                                            ?asset&asarUnpack →
                                            app.asar.unpacked/wasm/...
```

### electron-vite primitives map

```text
                           ┌──────────────────────────┐
                           │   src/main/index.ts      │
                           │                          │
                           │  import host from        │
                           │   './kernel-host         │
                           │     ?modulePath'         │  → emits dist/main/kernel-host.mjs
                           │                          │     and host = '/abs/path/...mjs'
                           │  utilityProcess.fork(host)│
                           └──────────────────────────┘

      ┌────────────────────────────────────────────────────────────────┐
      │   src/main/kernel-host.ts                                      │
      │                                                                │
      │   import { openscad } from '@taucad/openscad';                 │
      │   import wasm from './replicad.wasm?loader';                   │  → init function
      │   import font from './Geist.ttf?asset&asarUnpack';             │  → unpacked path
      │                                                                │
      │   createRuntimeHost({                                          │
      │     transport: electronUtilityTransport,                       │
      │     kernels: [openscad(), replicad()],                         │
      │   });                                                          │
      └────────────────────────────────────────────────────────────────┘
```

## References

- `docs/research/runtime-transport-architecture-v6.md` — defines `electronUtilityTransport` shape this work plugs into
- `docs/research/electron-rpc-transport-architecture.md` — Topology A/B/C taxonomy
- `docs/research/runtime-worker-bundling-strategy.md` — UI-side worker bundling baseline (R1–R6 implemented)
- `docs/research/runtime-zero-config-bundling.md` — `@taucad/runtime/vite` invariants used by the UI today
- [electron-vite — Asset Handling](https://electron-vite.org/guide/assets.html)
- [electron-vite — Isolated Build (experimental)](https://electron-vite.org/guide/isolated-build)
- [electron-vite — Dependency Handling](https://electron-vite.org/guide/dependency-handling)
- [Electron — ES Modules tutorial](https://www.electronjs.org/docs/latest/tutorial/esm)
- [electron/electron #37535 — ESM landed in Electron 28](https://github.com/electron/electron/pull/37535)
- [electron/electron #48375 — dynamic ESM in non-context-isolated preload (Electron 36+)](https://github.com/electron/electron/pull/48375)
- [electron-builder — Application Contents (asar / asarUnpack / extraResources)](https://mintlify.com/electron-userland/electron-builder/concepts/application-contents)
- [vitejs/rolldown-vite #572 — multi-entry cross-reference bug (motivates `isolatedEntries: true`)](https://github.com/vitejs/rolldown-vite/issues/572)

## Appendix

### A. Inventory of `import.meta.url`-relative assets in Tau kernels (April 2026)

| Kernel / transcoder package                  | Asset siblings of source file                                                                                                                | Loader pattern                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `packages/runtime/src/kernels/replicad`      | `wasm/replicad_single.wasm` (~13 MB), `fonts/Geist-Regular.ttf`, `sourcemaps/replicad.js.map`                                                | `new URL(asset, import.meta.url).href` |
| `packages/runtime/src/kernels/opencascade`   | `wasm/opencascade.wasm` (~14 MB)                                                                                                             | same                                   |
| `packages/runtime/src/kernels/manifold`      | `wasm/manifold.wasm`                                                                                                                         | same                                   |
| `packages/runtime/src/kernels/jscad`         | (pure-JS, no WASM siblings, but bundled deps may carry assets)                                                                               | n/a                                    |
| `packages/runtime/src/kernels/zoo`           | (network-served via Zoo API, no local assets)                                                                                                | n/a                                    |
| `packages/runtime/src/kernels/tau`           | (placeholder)                                                                                                                                | n/a                                    |
| `kernels/openscad`                           | `openscad.kernel.js` (kernel module entry), `fonts/Geist-Regular.ttf`, `fonts/Geist-Bold.ttf`, plus `openscad-wasm-prebuilt`'s embedded WASM | same                                   |
| `packages/runtime/src/transcoders/converter` | `converter.transcoder.js`                                                                                                                    | same                                   |
| `packages/converter` (transitive)            | assimpjs WASM variants (mini / all / exporter), draco3d WASM, rhino3dm WASM                                                                  | bundler-handled by `@taucad/converter` |

All of the above resolve correctly today under Vite renderer builds. None resolve under the current electron-vite main pipeline configuration.

### B. Summary of electron-vite `?suffix` import patterns

| Suffix                     | Default export type                              | Side effect                                                        | Use case                                        |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `?modulePath`              | `string` (absolute path)                         | Emits target as separate chunk; not bundled                        | `utilityProcess.fork(modulePath)`               |
| `?asset`                   | `string` (absolute path)                         | Copies file to `dist/main/chunks/`                                 | Fonts, .node addons, source maps                |
| `?asset&asarUnpack`        | `string` (path with `app.asar.unpacked` rewrite) | Emits + flags for electron-builder unpacking                       | Binary assets that must be on real disk         |
| `?loader`                  | `() => Promise<WebAssembly.Instance>`            | Inlines WASM bytes (or emits + reads at runtime) — Node-compatible | Main-process WASM where `?init` is browser-only |
| `?init`                    | `() => Promise<WebAssembly.Instance>`            | Browser-only WASM init                                             | Renderer process WASM imports                   |
| `?commonjs-external&asset` | `string` (path)                                  | Like `?asset` for JSON-ish imports                                 | When you want a JSON file as path, not parsed   |
