---
title: 'WASM Memory.toResizableBuffer() Status in Node.js (April 2026)'
description: 'Why GROWABLE_ARRAYBUFFERS in replicad-opencascadejs breaks Node.js consumers, what shipped where, and what to do instead.'
status: active
created: '2026-04-10'
updated: '2026-04-17'
category: investigation
related:
  - docs/research/wasm-heap-view-detachment.md
---

# WASM Memory.toResizableBuffer() Status in Node.js (April 2026)

Pinpointing where `WebAssembly.Memory.prototype.toResizableBuffer()` is enabled by default versus where it still requires `--experimental-wasm-rab-integration`, and what that means for consumers of `replicad-opencascadejs` after enabling Emscripten's `-sGROWABLE_ARRAYBUFFERS=1`.

> **Decision (2026-04-17): Rollback executed.** Based on the findings below, `GROWABLE_ARRAYBUFFERS` was removed from `replicad-opencascadejs` (v8.51) and `replicad` (v8.52) ships with R2 — fresh `Float32Array(wasmMemory.buffer)` views taken after every `extract()` call. Vitest's `--experimental-wasm-rab-integration` workaround was removed from `packages/runtime/vitest.config.ts`. All 115 `replicad.kernel.test.ts` cases pass on Node 24 without flags. See [`wasm-heap-view-detachment.md`](./wasm-heap-view-detachment.md) R2 for the implementation details and the `oc-tracing.ts` `isOcNamespace` proxy fix it required.

## Executive Summary

After enabling `-sGROWABLE_ARRAYBUFFERS=1` in the `replicad-opencascadejs` build, the generated JS unconditionally calls `wasmMemory.toResizableBuffer()` during module instantiation. **This API is enabled by default in Chrome 144+, Firefox 145+, and Safari 26.2+ (all 2025–2026 releases), but remains behind `--experimental-wasm-rab-integration` in every currently shipping Node.js version, including Node 25.7 (V8 14.1)**. V8 only enabled it by default on 2025-11-21 (V8 14.4 → Chrome 144). Node.js does not pick up V8 14.4 until Node 26 (planned October 2026). Node 24 Active LTS (V8 13.6) will never receive it via point releases. Consequently, **`GROWABLE_ARRAYBUFFERS` cannot ship today without breaking the Tau CLI, vitest test runner, and any third-party Node consumer**, since `NODE_OPTIONS` rejects the V8 flag and `worker_threads.execArgv` cannot reliably propagate it. The pragmatic options are (a) roll back `GROWABLE_ARRAYBUFFERS` and adopt the R2/R3 alternatives from [`wasm-heap-view-detachment.md`](./wasm-heap-view-detachment.md), or (b) accept Node-only breakage and document the V8 flag requirement until Node 26 LTS ships.

## Problem Statement

The Tau CLI (`packages/cli/src/bin.ts`), executed under `node --import @oxc-node/core/register`, reproducibly fails after enabling `GROWABLE_ARRAYBUFFERS`:

```
Error: Unhandled rejection in worker: wasmMemory.toResizableBuffer is not a function
    at RuntimeWorkerClient.handleMessage (packages/runtime/src/framework/runtime-worker-client.ts:588:23)
    ...
> node -v
v24.3.0
```

Vitest runs of `replicad.kernel.test.ts` exhibit the same failure mode: 112 of 116 tests fail with the same `toResizableBuffer is not a function` exception thrown from `updateMemoryViews()` during WASM instantiation.

Locally we confirmed the API is reachable in Node 24.3 only when explicitly enabled:

```bash
node --experimental-wasm-rab-integration -e \
  "const m=new WebAssembly.Memory({initial:1,maximum:10});console.log(typeof m.toResizableBuffer)"
# function
node -e "..."  # without flag
# undefined
```

`NODE_OPTIONS="--experimental-wasm-rab-integration" node …` is rejected: V8 flags are not allowed in `NODE_OPTIONS`.

## Methodology

1. Read the generated `replicad_single.js` after `build-wasm.sh link` to confirm the call sites that depend on the API (`wasmMemory.toResizableBuffer()` inside `updateMemoryViews`, plus skipped `updateMemoryViews` in `growMemory`).
2. Inspected V8's `src/wasm/wasm-feature-flags.h` git log on `refs/heads/main` to identify the exact ship and flag-removal commits.
3. Walked the Emscripten upstream issue ([emscripten#24287](https://github.com/emscripten-core/emscripten/issues/24287)) for guidance from the Emscripten/V8 maintainers.
4. Cross-referenced V8 branch-cut announcements with Chrome milestone numbers.
5. Walked Node.js v25.0 → v25.7 release notes to see when V8 has been bumped past 14.1.
6. Confirmed runtime behavior locally with the installed `node` (v24.3.0, V8 13.6.233.10-node.18).

## Findings

### Finding 1: V8 enabled RAB integration by default on 2025-11-21 (V8 14.4)

V8 commit `544e1c01b080671b3cb2212ed4d112c3dcf89eb5` ("[wasm] Enable Wasm RAB/GSAB integration on by default", `refs/heads/main@{#103884}`, 2025-11-21) flipped the default. The follow-up cleanup commit `fee1aff6f0a2882e486fad7a36087292e67f55b5` (2026-03-30) removed the feature flag entirely with the message _"RAB/GSAB integration has been shipped several milestones ago"_.

| Engine                         | Branch cut / release     | V8 version | Status         |
| ------------------------------ | ------------------------ | ---------- | -------------- |
| Chrome 143 (stable Q4 2025)    | V8 14.3                  | 14.3       | Behind flag    |
| Chrome 144 (stable Dec 2025)   | V8 14.4 (cut 2025-12-01) | 14.4       | **Default ON** |
| Chrome 145 (stable early 2026) | V8 14.5 (cut 2026-01-12) | 14.5       | Default ON     |

WebKit shipped its own implementation by toggling `useWasmMemoryToBufferAPIs` to true (commit `b3fa045`, "Enable by default support for Wasm Memory buffer APIs"), so Safari 26.2+ supports it natively.

### Finding 2: Every released Node.js still pins V8 < 14.4

| Node.js                                 | Released   | V8   | `Memory.toResizableBuffer()` default             |
| --------------------------------------- | ---------- | ---- | ------------------------------------------------ |
| 20.x (Iron, Maintenance)                | Apr 2023   | 11.3 | Not present (API never compiled)                 |
| 22.x LTS (Jod, Maintenance Oct 2025)    | Apr 2024   | 12.4 | Not present                                      |
| 24.x LTS (Krypton, Active LTS Oct 2025) | Apr 2025   | 13.6 | **Behind `--experimental-wasm-rab-integration`** |
| 25.0 Current                            | 2025-10-15 | 14.1 | Behind flag                                      |
| 25.5 Current                            | 2026-01-26 | 14.1 | Behind flag                                      |
| 25.7 Current                            | 2026-02-24 | 14.1 | Behind flag                                      |
| 26.x (planned Oct 2026, future LTS)     | TBD        | 14.x | Expected default ON                              |

Node releases typically ship a major V8 upgrade only with each new major Node line. Node 25 picked up V8 14.1 at GA and has not bumped past it in the seven point releases that followed. Node 24 LTS is contractually frozen on V8 13.6 for its support window; even when Node 26 ships, **Node 24 LTS will keep the flag requirement until it reaches end-of-life on 2028-04-30**.

### Finding 3: The V8 flag cannot be set via `NODE_OPTIONS`

Node deliberately allow-lists which CLI flags are accepted via `NODE_OPTIONS`, and `--experimental-wasm-*` is not on that list:

```bash
NODE_OPTIONS="--experimental-wasm-rab-integration" node -e ""
# node: --experimental-wasm-rab-integration is not allowed in NODE_OPTIONS
```

That removes the cleanest "ship it and document the env var" workaround. Setting it via `node --experimental-wasm-rab-integration script.mjs` works, but every consumer's launcher must be updated:

- `packages/cli/src/bin.ts` and any user-facing CLI invocation
- Vitest (only via `poolOptions.{forks,threads}.execArgv`, per-package config)
- `node --import` chains, `npx`, `tsx`, `pnpm exec`, `bun --bun-flag`, etc.
- Third-party tools that import `@taucad/runtime` (Storybook, Astro, Next.js test runners, etc.)
- Worker threads spawned by user code (`new Worker(file, { execArgv: [...] })`); upstream issue [nodejs/node#41103](https://github.com/nodejs/node/issues/41103) documents that worker `execArgv` filtering is fragile and unsupported flags throw `ERR_WORKER_INVALID_EXEC_ARGV`.

### Finding 4: Browsers we ship to are mostly safe; older Safari and Firefox are not

Per the Emscripten feature matrix (`tools/feature_matrix.py`), `GROWABLE_ARRAYBUFFERS` requires:

| Engine                  | Min version                                                                                                                                    | Today (Apr 2026) state                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Chrome / Chromium-based | 136                                                                                                                                            | Stable channel ≥ 144; ✅                                                                       |
| Firefox                 | 145                                                                                                                                            | Released early 2026; ✅ for current Firefox, ❌ for Firefox ESR 128 (still on supported track) |
| Safari / WebKit         | 26.2 (per Emscripten feature matrix; unflagged in WebKit commit b3fa045)                                                                       | ✅ on current macOS/iOS releases; ❌ for Safari < 26.2 (e.g., users still on macOS Sonoma)     |
| Node.js                 | "240000" (i.e. 24.0) per feature matrix — **but the matrix is wrong**: it tracks underlying RAB/GSAB support, not `Memory.toResizableBuffer()` | ❌ in all current LTS lines                                                                    |

The Emscripten feature matrix conflates _availability of resizable ArrayBuffers_ (Baseline 2024) with _availability of `WebAssembly.Memory.toResizableBuffer()_. The former has been broadly available since 2024; the latter is only Chrome 144+, Firefox 145+, Safari 26.2+, and a future Node release. This is the same trap that Emscripten maintainers themselves fell into in [emscripten#24287](https://github.com/emscripten-core/emscripten/issues/24287) before realizing the dependency on the unshipped Wasm-side API.

### Finding 5: There is no runtime polyfill or fallback path

`updateMemoryViews()` in the generated JS is structurally:

```javascript
function updateMemoryViews() {
  var b = wasmMemory.toResizableBuffer();
  HEAP8 = new Int8Array(b);
  // ...
}
```

We could monkey-patch `WebAssembly.Memory.prototype.toResizableBuffer` to return `wasmMemory.buffer`, but that defeats the entire purpose: the returned buffer is non-resizable and detaches on every `grow()`, reintroducing the original failure mode. There is no production-quality polyfill for this API because the semantics (live, growth-tracking views) cannot be reproduced without engine support.

The only conditional-compile escape hatch in Emscripten is the legacy `GROWABLE_HEAP_*()` accessor pattern (issue [#18589](https://github.com/emscripten-core/emscripten/issues/18589)), which costs ~5× on hot paths and isn't compatible with our existing C++ extractor code.

## Trade-offs

| Approach                                                                             | Browser ship today                    | Node ship today                                              | DX impact                                              | Detachment risk                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Keep `GROWABLE_ARRAYBUFFERS=1` as-is                                                 | ✅ Chrome 144+, FF 145+, Safari 26.2+ | ❌ Requires `--experimental-wasm-rab-integration` everywhere | Breaks CLI, breaks tests, breaks all Node consumers    | Eliminated when API exists                                                                |
| Roll back to plain `ALLOW_MEMORY_GROWTH` + R2 (fresh views from `wasmMemory.buffer`) | ✅ All browsers                       | ✅ All Node versions                                         | None                                                   | Eliminated by always reading the live `buffer` after `extract()`                          |
| Roll back + R3 (pre-grow `wasmMemory.grow()` before `extract()`)                     | ✅ All                                | ✅ All                                                       | Minor heuristics needed                                | Eliminated when pre-grow estimate is accurate; falls back to detachment on under-estimate |
| Keep `GROWABLE_ARRAYBUFFERS=1` + ship two builds (legacy + RAB)                      | ✅ All (RAB build)                    | ✅ All (legacy build)                                        | Doubles WASM bundle, build matrix, and selection logic | Mixed                                                                                     |
| Wait for Node 26 LTS (October 2026 → Active LTS April 2027)                          | ✅                                    | Eventually ✅                                                | Status quo broken for ~6–12 months                     | High in interim                                                                           |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                              | Priority | Effort                            | Impact                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------- | ----------------------------------------------------------------------------- |
| R1  | Roll back `-sGROWABLE_ARRAYBUFFERS=1` from `custom_build_single.yml`, re-link, repack, relink                                                                                                                                                                                                                       | P0       | Low                               | Restores Node compatibility immediately                                       |
| R2  | Implement R2 from `wasm-heap-view-detachment.md`: in `repos/replicad/packages/replicad/src/shapes.ts`, take fresh `Float32Array(this.oc.wasmMemory.buffer, ptr, len)` views immediately after `ReplicadMeshExtractor.extract()` returns and `.slice()` from those, instead of the cached `this.oc.HEAPF32` property | P0       | Low                               | Eliminates detachment in browsers and Node; portable; zero-copy view creation |
| R3  | Add an Emscripten-internal `Module.HEAPF32`-equivalent re-read helper invoked via `getHEAPF32()` accessor exported through `EXPORTED_RUNTIME_METHODS`, so consumers stop caching stale views                                                                                                                        | P1       | Medium                            | Defense-in-depth against future regressions                                   |
| R4  | Re-evaluate enabling `-sGROWABLE_ARRAYBUFFERS=1` once Node 26 LTS reaches Active status (April 2027) and Firefox ESR rolls forward past 145                                                                                                                                                                         | P2       | Trivial decision, same build flow | Long-term zero-detachment guarantee with no consumer DX cost                  |
| R5  | If we must ship before R4 lands, document the `node --experimental-wasm-rab-integration` requirement prominently in the CLI README and add a startup probe (`typeof WebAssembly.Memory.prototype.toResizableBuffer === 'function'`) that throws a friendly error before WASM instantiation rather than after        | P3       | Low                               | Better failure messaging only — does not solve the underlying breakage        |

## Code Examples

### The vulnerable call site (`repos/replicad/packages/replicad/src/shapes.ts`)

```ts
mesh({ tolerance = 1e-3, angularTolerance = 0.1 } = {}): ShapeMesh {
  const raw = this.oc.ReplicadMeshExtractor.extract(
    this.wrapped, tolerance, angularTolerance, false,
  );
  const vertices = Array.from(
    this.oc.HEAPF32.slice(            // <- detached buffer if extract() grew memory
      raw.getVerticesPtr() / 4,
      raw.getVerticesPtr() / 4 + raw.getVerticesSize(),
    ),
  );
}
```

### R2 fix sketch (no engine changes required, ships everywhere today)

```ts
const raw = this.oc.ReplicadMeshExtractor.extract(...);
// Re-read the live buffer AFTER extract() — survives any growth that happened during it.
const heapF32 = new Float32Array(this.oc.wasmMemory.buffer);
const heapU32 = new Uint32Array(this.oc.wasmMemory.buffer);
const vertices = Array.from(
  heapF32.subarray(raw.getVerticesPtr() / 4, raw.getVerticesPtr() / 4 + raw.getVerticesSize()),
);
```

This requires `wasmMemory` to be exported from the WASM module (already true under Emscripten when `MODULARIZE` is set), and either `EXPORTED_RUNTIME_METHODS` must include `wasmMemory` or we expose a thin getter. Either way, no engine flag, no detachment, single allocation only inside `Array.from`.

## References

- V8 commit history for `src/wasm/wasm-feature-flags.h` (verified 2026-04-10):
  - Enable by default: `544e1c01b080671b3cb2212ed4d112c3dcf89eb5` (2025-11-21)
  - Drop flag entirely: `fee1aff6f0a2882e486fad7a36087292e67f55b5` (2026-03-30)
- WebKit commit `b3fa045` — "Enable by default support for Wasm Memory buffer APIs"
- Emscripten upstream tracking issue: [emscripten-core/emscripten#24287](https://github.com/emscripten-core/emscripten/issues/24287)
- Node.js worker `execArgv` limitations: [nodejs/node#41103](https://github.com/nodejs/node/issues/41103)
- WebAssembly spec: [issue #1895](https://github.com/WebAssembly/spec/issues/1895), [PR #1871](https://github.com/WebAssembly/spec/pull/1871)
- Related: [`docs/research/wasm-heap-view-detachment.md`](./wasm-heap-view-detachment.md)
