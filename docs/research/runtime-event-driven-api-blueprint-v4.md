---
title: 'Runtime Event-Driven API Blueprint v4'
description: 'Final blueprint for @taucad/runtime: render() owns autonomous live mode (openFile/updateParameters + event stream); export(format, input?) owns one-shot imperative mode for CLI/tests/RPC; in-memory native handle invariant guarantees fast live exports.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/policy/runtime-architecture-policy.md
  - docs/architecture/runtime-topology.md
  - docs/research/runtime-event-driven-api-blueprint.md
  - docs/research/runtime-event-driven-api-blueprint-v2.md
  - docs/research/runtime-event-driven-api-blueprint-v3.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/capabilities-manifest-api-audit.md
  - docs/research/runtime-client-type-safety-audit.md
  - docs/research/cli-runtime-ergonomics.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/lazy-capabilities-manifest.md
  - docs/research/nativehandle-serialization-and-pipeline-architecture.md
---

# Runtime Event-Driven API Blueprint v4

Final-state blueprint for the `@taucad/runtime` consumer API. Resolves the `render` vs `export` dichotomy left ambiguous in v3 by splitting them into two non-overlapping modes (autonomous live render vs imperative one-shot export), preserves `openFile`/`updateParameters` as named primitives for the autonomous mode, and elevates "kernel always retains the most recent native handle in memory" to a runtime invariant so live exports stay fast without extra round-trips.

## Executive Summary

v3 collapsed every render-mutation primitive into a single Promise-correlated `client.render(input)` call on the principle that "render is the universal mutation primitive." Reviewer feedback on v3 surfaced two orthogonal problems with that move:

1. **It overloads `render()` across two fundamentally different consumer modes.** UI panes are an autonomous reactive service (file changes, parameter slider, kernel-watched re-renders); CLI/tests/RPC handlers are one-shot byte-producers that do not subscribe to live updates. Conflating both behind the same verb forces consumers to opt into machinery they do not want and forces the runtime to negotiate "is this a one-shot or a live consumer?" at every entry point.
2. **It hides the natural workhorse for the imperative mode.** `client.export(format, input?)` already exists in production today, already returns the bytes those consumers actually consume, and is what the CLI already calls. v3's `render(input) → export(format)` two-step is strictly worse than the one-step `export(format, input)` for the imperative case — it forces a render Promise that the caller will discard.

v4 corrects both. The public API is split along the two real consumer modes:

| Mode                    | Verb                                                                                           | Consumers                                                                                          | Wire pattern                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Autonomous live**     | `openFile()`, `updateParameters()`, `setOptions()`, `on('geometry'\|'state'\|'progress'\|...)` | UI panes (`cad.machine`), `useRender` hook                                                         | Fire-and-forget command, results arrive on the event stream; supersession is built in |
| **Imperative one-shot** | `export(format, input?)`                                                                       | CLI, RPC (`fetchGeometry`, `getKernelResult`), tests, benchmarks, AR conversion, `useExportToDisk` | Promise-correlated request, returns bytes; live state is irrelevant                   |

A user-confirmed factual correction underwrites this split: the production `Geometry` type contains only bytes (`{ format: 'gltf'; content: Uint8Array<ArrayBuffer> }`), never structured mesh data. Every existing `client.render` consumer parses those bytes via `gltf-transform` to recover meshes/bbox/materials. So migrating those consumers to `client.export('glb', input)` is a verb rename with no semantic loss.

A new runtime invariant — **kernels MUST retain the most-recent native handle in memory after each successful render** — guarantees that a live UI pane's "Quick export" never has to re-execute the kernel. The native handle is already the cache key for the existing export reheat path (see `kernel-worker.ts:1278-1336`); v4 simply elevates "always present after success" from an opportunistic optimisation to a contract that exporters can rely on.

The combined surface drops to **8 public methods and 9 event types**. There is no `render(input)` method on the public client. There is one autonomous-mode trigger pair (`openFile`/`updateParameters`), one imperative-mode workhorse (`export`), and zero overlap between them.

## Table of Contents

- [Scope and Non-Goals](#scope-and-non-goals)
- [The Render-vs-Export Dichotomy](#the-render-vs-export-dichotomy)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Geometry already only carries bytes — render and export return the same payload kind](#finding-1-geometry-already-only-carries-bytes--render-and-export-return-the-same-payload-kind)
  - [Finding 2: Two consumer modes, not one](#finding-2-two-consumer-modes-not-one)
  - [Finding 3: render() belongs to the autonomous mode and is event-driven, not Promise-driven](#finding-3-render-belongs-to-the-autonomous-mode-and-is-event-driven-not-promise-driven)
  - [Finding 4: export(format, input?) belongs to the imperative mode and is the workhorse](#finding-4-exportformat-input-belongs-to-the-imperative-mode-and-is-the-workhorse)
  - [Finding 5: openFile and updateParameters are the right primitives for the autonomous mode](#finding-5-openfile-and-updateparameters-are-the-right-primitives-for-the-autonomous-mode)
  - [Finding 6: Live-export speed depends on an "always-warm native handle" invariant](#finding-6-live-export-speed-depends-on-an-always-warm-native-handle-invariant)
  - [Finding 7: A 'memory' pseudo-format is the wrong layer to solve "give me the geometry"](#finding-7-a-memory-pseudo-format-is-the-wrong-layer-to-solve-give-me-the-geometry)
  - [Finding 8: CLI never needs a render verb](#finding-8-cli-never-needs-a-render-verb)
  - [Finding 9: RPC handlers are imperative consumers and route through export](#finding-9-rpc-handlers-are-imperative-consumers-and-route-through-export)
  - [Finding 10: useRender is autonomous-mode and must migrate to event subscription](#finding-10-userender-is-autonomous-mode-and-must-migrate-to-event-subscription)
  - [Finding 11: Test helpers move to export trivially](#finding-11-test-helpers-move-to-export-trivially)
  - [Finding 12: export(format) without input requires a live render context](#finding-12-exportformat-without-input-requires-a-live-render-context)
  - [Finding 13: Library API Policy compliance — point-by-point](#finding-13-library-api-policy-compliance--point-by-point)
  - [Finding 14: Inheritance from v3 — what survives, what reverts, what is new](#finding-14-inheritance-from-v3--what-survives-what-reverts-what-is-new)
- [Target API Surface](#target-api-surface)
- [Recommendations](#recommendations)
- [Migration Plan](#migration-plan)
- [Trade-offs vs v3](#trade-offs-vs-v3)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Appendix A: Full Consumer Call-Site Inventory](#appendix-a-full-consumer-call-site-inventory)
- [Appendix B: Per-Mode Contract](#appendix-b-per-mode-contract)
- [Appendix C: Inheritance and corrections from v1, v2, v3](#appendix-c-inheritance-and-corrections-from-v1-v2-v3)

## Scope and Non-Goals

**In scope:**

- Public API surface of `@taucad/runtime` (`createRuntimeClient`, `RuntimeClient`).
- The render-vs-export dichotomy — semantics, signatures, return types.
- The "kernel always retains a live native handle after success" runtime invariant.
- Migration of every in-tree consumer of `client.render(...)`.
- Library API Policy compliance pass for the new surface.
- Forward-compatibility with `createWebSocketTransport` (shares the same surface unmodified).

**Out of scope:**

- Plugin authoring contracts (`defineKernel`, `defineMiddleware`, `defineBundler`, `defineTranscoder`).
- Internal cache-invalidation algorithms — covered by [`runtime-topology.md`](../architecture/runtime-topology.md).
- Type-level audits — covered by [`runtime-client-type-safety-audit.md`](runtime-client-type-safety-audit.md).
- Capabilities-manifest contents (kernels, transcoders, formats) — covered by [`capabilities-manifest-api-audit.md`](capabilities-manifest-api-audit.md).
- Backwards-compatibility shims — explicitly disallowed by reviewer ("no support for breaking changes").

## The Render-vs-Export Dichotomy

The dichotomy is the single most important contract introduced by v4. Every other recommendation follows it.

### Two consumer modes

There are exactly two modes in which any caller uses `@taucad/runtime`:

| Property                         | Autonomous live mode                                               | Imperative one-shot mode                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Who                              | UI panes (`cad.machine`), `@taucad/react`'s `useRender`            | CLI (`taucad export`), RPC handlers (`fetchGeometry`, `getKernelResult`), `useExportToDisk`, AR conversion, tests, benchmarks |
| When does work happen            | Continuously: file changes, parameter sliders, kernel watch fires  | Once per call, then done                                                                                                      |
| What does the consumer want back | A _stream_ of geometries, states, progress, errors over time       | A _value_ — bytes for a specific format                                                                                       |
| Lifetime                         | Long-lived (per-pane)                                              | Short-lived (per call)                                                                                                        |
| Who decides "render again?"      | The runtime worker (autonomous re-render on file/parameter change) | The caller (re-invokes the verb)                                                                                              |
| Wire pattern                     | Fire-and-forget command, async event delivery                      | Request/response Promise                                                                                                      |
| Supersession needed              | Yes (slider drag, fast file edits)                                 | No (each call is independent)                                                                                                 |

Forcing both modes through the same verb is the root cause of every API confusion that v1/v2/v3 tried to paper over. The two modes do not benefit from a unified verb — they actively penalise each other.

### Why this is not "render returns bytes, export also returns bytes, so unify"

`Geometry` and `ExportFile` happen to both wrap `Uint8Array<ArrayBuffer>` payloads, but the _protocol shape_ around them differs:

| Concern                                       | `render` (autonomous)                                 | `export` (imperative)                           |
| --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| When does the result arrive                   | On every kernel re-render (could be many per session) | Exactly once, at the end of the awaited Promise |
| Can the result be superseded after delivery   | Yes — a newer geometry replaces the older event       | No — each Promise resolves independently        |
| Does the consumer subscribe to state/progress | Yes                                                   | No (Promise lifecycle is sufficient)            |
| Does the call kick off a watch loop           | Yes (entry file watched, deps discovered)             | No (one-shot bundle, render, export, drop)      |

Today's `client.render(input)` is bolted to the second protocol shape (Promise-correlated, one-shot) but consumed by the first kind of caller (autonomous UI). That mismatch is the smell every prior version chased.

## Methodology

Approach taken:

1. Read the v3 blueprint front-to-back to understand the unified-`render()` proposal.
2. Validated the reviewer's claim that `client.render` returns only byte payloads by reading `libs/types/src/types/cad.types.ts` (the canonical `Geometry`/`GeometryResponse` definitions).
3. Surveyed every in-tree call to `client.render(...)` with `rg "client\.render\("` and classified each call site by mode (autonomous vs imperative).
4. Walked the kernel worker (`packages/runtime/src/framework/kernel-worker.ts`) to confirm `nativeHandle` retention semantics and the existing export reheat path (`ensureNativeHandle`).
5. Audited the CLI `export` command (`packages/cli/src/commands/export.ts`) to confirm CLI today already uses `client.export(format, input)` with no render call.
6. Re-read `library-api-policy.md` to validate compliance for every renamed/retained method in the proposed surface.
7. Cross-checked v1 and v2 to identify which findings survive into v4 unchanged and which were reverted by user feedback.

## Findings

### Finding 1: Geometry already only carries bytes — render and export return the same payload kind

**Claim**: The v3 doc argued (in its trade-off discussion) that splitting `render` from `export` would deprive tests and benchmarks of "structured Geometry[] with mesh data, materials, bounds." That claim was wrong.

**Evidence**: The canonical `Geometry` type is defined in `libs/types/src/types/cad.types.ts:75`:

```typescript
export type Geometry = GeometryResponse & {
  hash: string;
};

export type GeometryResponse = GeometrySvg | GeometryGltf | GeometryWebRtc;

export type GeometryGltf = {
  format: 'gltf';
  content: Uint8Array<ArrayBuffer>;
};
```

There is no structured mesh, no materials field, no bounds field on `Geometry`. For 3D output, the entire payload is the GLB byte buffer.

Cross-check the consumers of `client.render(...)`:

| Consumer                                                                                                   | What it does with the result                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/app/benchmarks/model-benchmark-geometry.ts:63-68`                                                | `result.data.find((g) => g.format === 'gltf')` then reads `gltf.content` (bytes)                                                   |
| `packages/runtime/src/testing/kernel-geometry-testing.utils.ts:186-193`                                    | `extractGltfFromResult` → returns `gltfResponse.content` (bytes)                                                                   |
| `packages/testing/src/geometry/{analyze-glb,connected-components,evaluate-requirement,watertight}.test.ts` | Each calls `extractGltfFromResult(result)` and parses bytes via `gltf-transform`                                                   |
| `packages/runtime/src/benchmarks/benchmark-runner.ts:235-244`                                              | Times the call and asserts `result.success`; never reads structured fields                                                         |
| `packages/react/src/hooks/use-render.ts:148-159`                                                           | `setGeometries(result.data)` — passes opaque payloads through to the React renderer (`<gltf-mesh>`), which itself parses the bytes |
| `apps/api/app/api/analysis/geometry-analysis.service.test.ts:28`                                           | Same pattern — extracts bytes, parses with `gltf-transform`                                                                        |

**Conclusion**: every consumer is a byte-consumer. Migrating any of them to `client.export('glb', input)` (which returns `ExportResult` containing `data.bytes: Uint8Array<ArrayBuffer>`) is a one-line change with no semantic regression. The v3 trade-off concern was a phantom.

### Finding 2: Two consumer modes, not one

**Claim**: `@taucad/runtime` serves exactly two consumer patterns. Conflating them is the source of every render-vs-export confusion.

**Evidence**: Classification of every `client.render(...)` call site in-tree:

| Call site                                                                                   | Mode                               | Why                                                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/ui/app/machines/cad.machine.ts`                                                       | Autonomous                         | Per-pane UI; reacts to slider changes, file writes, kernel-watched re-renders                                     |
| `packages/react/src/hooks/use-render.ts`                                                    | Autonomous                         | Reactive React hook; re-renders on `code`/`file`/`parameters` deps change                                         |
| `apps/api/app/benchmarks/model-benchmark-geometry.ts`                                       | Imperative                         | One-shot grade per benchmark case                                                                                 |
| `apps/api/app/api/analysis/geometry-analysis.service.test.ts`                               | Imperative                         | Test fixture                                                                                                      |
| `packages/runtime/src/benchmarks/benchmark-runner.ts`                                       | Imperative (with file-watch trick) | Multi-iteration benchmark; uses `notifyFileChanged` to trigger rebuild but each iteration awaits a single Promise |
| `packages/testing/src/geometry/*.test.ts` (4 files)                                         | Imperative                         | Test helpers                                                                                                      |
| `packages/runtime/src/transport/in-process-transport.test.ts`                               | Imperative                         | Transport-level test                                                                                              |
| `packages/runtime/src/client/runtime-client.test.ts` (~25 calls)                            | Imperative                         | Client behaviour tests                                                                                            |
| `packages/runtime/src/framework/runtime-worker-client.test.ts` (7 calls)                    | Imperative                         | Worker-client behaviour tests                                                                                     |
| `packages/runtime/src/framework/kernel-worker.test.ts` (2 calls — `worker.render`)          | Imperative                         | Worker-level test (not a client)                                                                                  |
| `packages/runtime/src/types/define-plugin.test-d.ts` (4 calls)                              | Imperative                         | Type-level test                                                                                                   |
| `kernels/openscad/src/openscad.kernel.test.ts` (2 calls — `worker.render`)                  | Imperative                         | Worker-level kernel test                                                                                          |
| `packages/runtime/src/kernels/replicad/replicad.kernel.test.ts` (6 calls — `worker.render`) | Imperative                         | Worker-level kernel test                                                                                          |
| `packages/runtime/src/client/render-input.test-d.ts`                                        | Imperative                         | Type-level test                                                                                                   |

**Tally**: 2 autonomous call sites, all the rest are imperative.

The autonomous-mode call sites are the production-critical ones (UI panes serve the actual product). The imperative call sites are tests/benchmarks/CLI. The current API forces the autonomous consumers to use a Promise-correlated verb that is wrong for them, and forces the imperative consumers to either:

- use `render()` and discard structured fields they never had, or
- use `render()` then `export()` to get bytes, paying double the work.

Both are wrong outcomes from a forced-unified API.

### Finding 3: render() belongs to the autonomous mode and is event-driven, not Promise-driven

**Claim**: The autonomous mode does not need a Promise-returning `render()`. It needs:

- A way to _declare intent_ ("I want to render this file with these parameters and these options").
- A way to _subscribe to results_ over time ("call me when the geometry is ready, the state changes, progress fires, an error occurs").

Promises are the wrong shape for "stream of results over time."

**Evidence**: `cad.machine.ts:113-160` (the production autonomous consumer) does exactly this:

- `createRuntimeClient(...)` once.
- `client.on('geometry', ...)`, `client.on('state', ...)`, `client.on('progress', ...)`, etc. — six subscriptions forwarding to the XState machine.
- Calls `client.setFile(file, params)` and `client.setParameters(...)` as the autonomous mutators.

It never awaits a render Promise. The autonomous-mode primitives (`setFile`, `setParameters`) already return `void` and the machine consumes events. v3's "let's collapse into Promise-coalesced `render(input)`" change works against this real architecture.

**Implication**: keep the autonomous-mode mutators (renamed `openFile`, `updateParameters`); they should be Promise-returning to satisfy the no-`void`-async rule (§7 of `library-api-policy.md`), but the Promise resolves on settlement of _that specific request_ (so callers who care about completion can await), not as the primary delivery channel. The event stream remains the primary delivery channel.

### Finding 4: export(format, input?) belongs to the imperative mode and is the workhorse

**Claim**: `client.export(format, input?)` already exists in the production runtime, already returns the right shape (`ExportResult` with `data.bytes`), and is what every imperative consumer should call.

**Evidence**: `packages/cli/src/commands/export.ts:82-99`:

```typescript
const result = await client.export(format, {
  file: inputFilename,
  parameters,
});
// ...
await writeFile(outputPath, result.data.bytes);
```

That is the entire imperative-mode contract. The CLI is a one-shot byte-producer; it expresses that intent directly with `export(format, input)`. No render Promise to discard, no setFile call, no event subscription, no terminate dance — `createNodeClient` already wraps lifetime.

**The two-input form** (`export(format, input)`) is the one-shot variant. **The one-input form** (`export(format)`) requires a live render context (i.e., the caller is autonomous-mode and has previously set the context via `openFile`/`updateParameters`). See [Finding 12](#finding-12-exportformat-without-input-requires-a-live-render-context).

**Implication**: `export(format, input?)` is the universal verb for the imperative mode and is the _only_ way that mode produces output. There is no `render(input)` on the public client surface in v4.

### Finding 5: openFile and updateParameters are the right primitives for the autonomous mode

**Claim**: The autonomous mode needs _two distinct verbs_ for its two distinct intents. v3's "collapse into render(input)" was a regression on this point. Reviewer feedback explicitly reverts it.

**Evidence**: `kernel-worker.ts` distinguishes the two intents at the worker level:

| Verb                                         | Worker behaviour                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `handleSetFile(file, parameters?, options?)` | Re-watches the entry file, increments abort generation, runs `executeRender()` immediately (no debounce) |
| `handleSetParameters(parameters)`            | Increments abort generation, schedules `scheduleRender(50ms)` (parameter debounce), does NOT re-watch    |

These are not the same operation with different arguments — they have categorically different worker effects. Forcing them through a single `render(input)` verb would either:

- branch on whether `input` includes a file (smelly, leaks intent), or
- re-watch on every parameter slide (wasteful), or
- never re-watch (broken — parameter-only updates wouldn't bootstrap the watch loop on a fresh client).

**Naming**: `setFile` → `openFile` and `setParameters` → `updateParameters`. The new names communicate intent without overloading "set":

- `openFile` reads as "open this file in the runtime" (matches the editor mental model — every consumer of the runtime client thinks of "opening" a file in a CAD viewer).
- `updateParameters` reads as "I changed a slider value" — inherently the autonomous-mode signal.

Both are Promise-returning so callers that need settlement can await; the Promise resolves when the resulting render settles (success or error), and is auto-superseded if a newer call replaces it (resolves with `{ superseded: true }` per §7 of the API policy).

### Finding 6: Live-export speed depends on an "always-warm native handle" invariant

**Claim**: For "live" panes (autonomous mode), `client.export(format)` (no input) must be near-instant. That requires the kernel to always have the most-recent native handle in memory after a successful render. This must be a runtime invariant, not an opportunistic cache.

**Evidence**: `kernel-worker.ts:208-211` already has the field, and `kernel-worker.ts:1278-1336` already has an `ensureNativeHandle` reheat path. The existing reheat is fragile — it only fires when `nativeHandle` is `undefined` _and_ a `lastSerializedHandle` exists _and_ the deserialize succeeds, otherwise it silently re-runs `createGeometry` (paying the full kernel cost) before the export can proceed.

**Risk in current code**: any code path that nulls `this.nativeHandle = undefined` after a successful render breaks the live-export performance contract. There is one such code path today (`kernel-worker.ts:637`, in render abort cleanup). Without an invariant, the next refactor could add more.

**Invariant to add to `runtime-topology.md`**:

> After every successful `executeRender()`, the kernel worker MUST hold a non-null `nativeHandle` for that render until either (a) a newer `executeRender()` succeeds (replacing it), (b) `terminate()` is called, or (c) the kernel explicitly invalidates its own cache. Aborts of _subsequent_ renders MUST NOT clear the handle from the _previous_ successful render. Exporters rely on `nativeHandle` being live without re-execution.

**Implication**: live exports skip the bundle/run/tessellate phases and go straight to format conversion. The "Quick export" UX ([`chat-parameters.tsx`](../../apps/ui/app/routes/projects_.$id/chat-parameters.tsx)) keeps its sub-second feel without any extra plumbing.

### Finding 7: A 'memory' pseudo-format is the wrong layer to solve "give me the geometry"

**Claim**: An earlier draft proposed `client.export('memory', input)` as a way for tests/benchmarks to get back a structured `Geometry[]` without a serialised byte format. The reviewer rejected it explicitly.

**Why it was wrong**:

- `Geometry` already only carries bytes ([Finding 1](#finding-1-geometry-already-only-carries-bytes--render-and-export-return-the-same-payload-kind)) — there is no "structured" alternative to give back.
- Adding 'memory' to the format list pollutes a type that today enumerates real on-disk file formats (`glb`, `stl`, `step`, `3mf`, ...). It would need to be filtered out of every UI dropdown, every CLI help string, every capabilities table.
- It would create a second axis of "is this a real format or a metadata escape hatch?" that downstream code must reason about.

**Right answer**: tests and benchmarks call `client.export('glb', input)`, get bytes back, and parse them with the existing `gltf-transform` helpers (`getInspectReport`, `analyzeGlb`). Those helpers already exist and already work today.

### Finding 8: CLI never needs a render verb

**Claim**: The CLI is a pure imperative consumer — it has no UI to subscribe to events from, no slider to drag, no live-update model. It needs exactly one verb: "produce bytes for this format from this input."

**Evidence**: `packages/cli/src/commands/export.ts` is the entire CLI surface today. There is no `render` command, and there has never been one. The reviewer confirmed there is no need to add one.

**Implication**: in the v4 surface, `client.render(input)` does not exist as a public method. CLI continues to call `client.export(format, input)` unchanged.

### Finding 9: RPC handlers are imperative consumers and route through export

**Claim**: The chat RPC handlers (`getKernelResult`, `fetchGeometry`) are not autonomous consumers — they fire once per LLM tool call, return bytes (or a structured grade), then unwind. They belong on the imperative side.

**Evidence**: `apps/ui/app/hooks/rpc-handlers.ts:181-276` — `getKernelResult(targetFile)` and `fetchGeometry({targetFile})`. Each is a one-shot tool invocation. The handler does not subscribe to ongoing geometry events; it just needs _one_ fresh GLB for _this_ tool call.

**Risk**: today they piggy-back on the live `cad.machine`'s render output via the `awaitFreshRender` helper (see pending TDD tasks t9, t10). That works but couples RPC freshness guarantees to autonomous-mode internals (generation tracking, settled-vs-pending state, supersession). A direct `client.export('glb', { file, parameters })` is simpler: each RPC owns its own one-shot request, no coupling to the live pane's generation state.

**Implication**: migrate `rpc-handlers.ts` to call `client.export('glb', { file: targetFile, parameters: <current pane parameters>})` and stop relying on `awaitFreshRender`. This also retires the entire generation-tracking helper machinery on the RPC side. (The helper survives as an internal implementation detail of the _autonomous_ client — but it never crosses the public API.)

This intersects with the pending TDD plan: tasks t5, t6, t9, t10 should be re-scoped before implementation. See [Migration Plan](#migration-plan).

### Finding 10: useRender is autonomous-mode and must migrate to event subscription

**Claim**: `@taucad/react`'s `useRender` is autonomous-mode (it re-renders on dependency changes). Its current implementation calls `client.render(...)` inside a `useEffect`, which works but doesn't take advantage of the event stream and breaks supersession semantics across React commits.

**Evidence**: `packages/react/src/hooks/use-render.ts:135-179`:

```typescript
useEffect(() => {
  // ... cancelled flag, awaits client.render(...)
  const result = await client.render({ code, file: resolvedFile, parameters });
  if (cancelled) return;
  setGeometries(result.data);
}, [code, file, parameters, enabled]);
```

Issues with the current shape:

- Each `useEffect` run kicks off a _new_ render Promise that races prior ones. The `cancelled` flag stops state writes but cannot stop the in-flight render in the worker.
- `client.render(...)` is being called as if it were autonomous-mode (continuous re-runs) but is implemented as imperative (one-shot Promise).

**Right shape**:

```typescript
useEffect(() => {
  const unsub = client.on('geometry', (result) => {
    if (result.success) setGeometries(result.data);
    setStatus('success');
  });
  return unsub;
}, [client]);

useEffect(() => {
  void client.openFile({ code, file: resolvedFile, parameters });
}, [code, file, resolvedFile, parameters]);
```

The hook becomes a thin event-subscription wrapper. Supersession is the runtime's job (newer `openFile`/`updateParameters` aborts older ones internally). The React side just subscribes and renders the latest.

### Finding 11: Test helpers move to export trivially

**Claim**: Every test helper that wraps `client.render(...)` for assertions is doing the same thing: extract bytes, parse with `gltf-transform`, assert on parsed structure. Migrating to `client.export('glb', input)` is a one-line change per helper.

**Evidence**: `kernel-geometry-testing.utils.ts:186-193`:

```typescript
export function extractGltfFromResult(result: CreateGeometryResult): Uint8Array<ArrayBuffer> | undefined {
  if (!result.success) return undefined;
  const gltfResponse = result.data.find((response) => isGltfResponse(response));
  return gltfResponse?.content;
}
```

After migration, the helper becomes:

```typescript
export function extractGltfFromExportResult(result: ExportResult): Uint8Array<ArrayBuffer> | undefined {
  return result.success ? result.data.bytes : undefined;
}
```

Test files (`analyze-glb.test.ts`, `connected-components.test.ts`, `evaluate-requirement.test.ts`, `watertight.test.ts`) change from:

```typescript
const result = await client.render({ code: { [filename]: code }, file: filename });
```

to:

```typescript
const result = await client.export('glb', { code: { [filename]: code }, file: filename });
```

Single-line change. No semantic loss because the helpers always parsed bytes anyway.

### Finding 12: export(format) without input requires a live render context

**Claim**: The two `export` overloads serve two callers and the contract must distinguish them.

| Overload                | Caller                                      | Precondition                                                                               |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `export(format)`        | Autonomous client (UI pane post-`openFile`) | A previous successful render established context; runtime uses the in-memory native handle |
| `export(format, input)` | Imperative caller (CLI/test/RPC)            | No prior render context needed; runtime bundles+renders+exports in a single shot           |

The autonomous overload throws (`NoActiveRenderContextError`) if called before the first successful render settles. The imperative overload is always callable.

**Why this matters for the autonomous-mode invariant**: `export(format)` _only_ works because [Finding 6](#finding-6-live-export-speed-depends-on-an-always-warm-native-handle-invariant) makes the native handle always-warm. Without that invariant, `export(format)` would have to either: (a) silently re-run the render (slow, defeats the purpose) or (b) fail (terrible UX). With the invariant, it is fast and reliable.

**Library API Policy compliance** (§4 same-concern positional cap of 3 — both forms have ≤2 positional params; §7 errors for "no live context" are typed and predictable).

### Finding 13: Library API Policy compliance — point-by-point

The proposed v4 surface against [`library-api-policy.md`](../policy/library-api-policy.md):

| Method                            | §1 Single concern                    | §2 Naming | §3 Async returns Promise    | §4 ≤3 positional | §5 No flag args | §6 Errors typed                                | §7 No void async |
| --------------------------------- | ------------------------------------ | --------- | --------------------------- | ---------------- | --------------- | ---------------------------------------------- | ---------------- |
| `connect(options?)`               | ✅                                   | ✅        | ✅                          | ✅ (1)           | ✅              | ✅                                             | ✅               |
| `terminate()`                     | ✅                                   | ✅        | n/a (sync)                  | ✅ (0)           | ✅              | n/a                                            | ✅               |
| `openFile(input)`                 | ✅ open file = autonomous-mode entry | ✅        | ✅ resolves on settlement   | ✅ (1)           | ✅              | ✅ `RenderError`, `BundleError`, `KernelError` | ✅               |
| `updateParameters(parameters)`    | ✅ slider/input change               | ✅        | ✅ resolves on settlement   | ✅ (1)           | ✅              | ✅ same as openFile                            | ✅               |
| `setOptions(options)`             | ✅ runtime option update             | ✅        | ✅                          | ✅ (1)           | ✅              | ✅                                             | ✅               |
| `export(format, input?)`          | ✅ produce bytes                     | ✅        | ✅                          | ✅ (2)           | ✅              | ✅ `ExportError`, `NoActiveRenderContextError` | ✅               |
| `routesFor(format)`               | ✅ capability query                  | ✅        | n/a (sync)                  | ✅ (1)           | ✅              | n/a                                            | ✅               |
| `bestRouteFor(format, kernelId?)` | ✅ capability query                  | ✅        | n/a (sync)                  | ✅ (2)           | ✅              | n/a                                            | ✅               |
| `on(event, handler)`              | ✅                                   | ✅        | n/a (returns `Unsubscribe`) | ✅ (2)           | ✅              | n/a                                            | ✅               |

**Result**: 8 methods + `on()`. Zero open API-policy violations. (Today's surface has two violations: `setFile`/`setParameters` are `void` async — violating §7. v4 fixes both via the rename to `openFile`/`updateParameters` with Promise return.)

### Finding 14: Inheritance from v3 — what survives, what reverts, what is new

| v3 finding                                                           | Status in v4                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F1: One client per pane is the architectural invariant               | ✅ Survives. Foundation for v4 too                                                                                |
| F2: Generations are an internal cooperative-abort primitive          | ✅ Survives. SAB stays internal-only                                                                              |
| F3: render() is the universal Promise-correlated mutation primitive  | ❌ **Reverted**. Render is autonomous-only and event-driven; export is the universal imperative verb              |
| F4: setFile and setParameters are not setters (collapse into render) | ❌ **Reverted on collapse**, ✅ kept on rename: `openFile`, `updateParameters` survive as distinct primitives     |
| F5: Capability flags on transports are a leaky abstraction           | ✅ Survives                                                                                                       |
| F6: Events have no cross-channel ordering guarantee today            | ✅ Survives                                                                                                       |
| F7: SAB scope can shrink to a single internal abort flag             | ✅ Survives                                                                                                       |
| F8: notifyFileChanged is redundant in filesystem mode                | ✅ Survives. Removed from public surface                                                                          |
| F9: setRenderTimeout duplicates RuntimeClientOptions.renderTimeout   | ✅ Survives. Removed from public surface                                                                          |
| F10: geometryPool getter leaks SAB internals                         | ✅ Survives. Removed from public surface                                                                          |
| F11: cancelPendingRender is subsumed by render supersession          | ✅ Survives. Removed from public surface                                                                          |
| F12: connect is half-lazy; full laziness simplifies the contract     | ✅ Survives                                                                                                       |
| F13: Library API Policy compliance — point-by-point                  | ✅ Survives, redone for new surface (see [Finding 13](#finding-13-library-api-policy-compliance--point-by-point)) |
| F14: A WebSocket transport breaks SAB-flavoured public APIs          | ✅ Survives                                                                                                       |
| **NEW F1 (v4)**: Geometry already carries only bytes                 | New                                                                                                               |
| **NEW F2 (v4)**: Two consumer modes, not one                         | New                                                                                                               |
| **NEW F6 (v4)**: Always-warm native handle invariant                 | New (formalises an existing implicit dependency)                                                                  |
| **NEW F7 (v4)**: No 'memory' pseudo-format                           | New (pre-empts a known-bad design escape)                                                                         |

## Target API Surface

```typescript
type RuntimeClient<Kernels, Transcoders> = {
  // ----- Lifecycle -----
  connect(options?: ConnectOptions): Promise<void>;
  terminate(): void;

  // ----- Autonomous live-render mode -----
  openFile(input: OpenFileInput): Promise<RenderSettlement>;
  updateParameters(parameters: Record<string, unknown>): Promise<RenderSettlement>;
  setOptions(options: KernelOptions<Kernels>): Promise<RenderSettlement>;

  // ----- Imperative one-shot mode -----
  export(format: Format, input?: ExportInput): Promise<ExportResult>;

  // ----- Capability queries (synchronous, read-only) -----
  routesFor(format: Format): readonly ExportRoute[];
  bestRouteFor(format: Format, kernelId?: KernelId): ExportRoute | undefined;

  // ----- Read-only state -----
  readonly capabilities: CapabilitiesManifest | undefined;
  readonly activeKernelId: KernelId | undefined;

  // ----- Event subscriptions (autonomous-mode delivery) -----
  on(event: 'geometry', handler: (result: HashedGeometryResult) => void): Unsubscribe;
  on(event: 'state', handler: (state: WorkerState, detail?: string) => void): Unsubscribe;
  on(event: 'progress', handler: (progress: number) => void): Unsubscribe;
  on(event: 'error', handler: (error: KernelIssue) => void): Unsubscribe;
  on(event: 'parametersResolved', handler: (result: ParametersResolved) => void): Unsubscribe;
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest) => void): Unsubscribe;
  on(event: 'log', handler: (entry: LogEntry) => void): Unsubscribe;
  on(event: 'activeKernelChanged', handler: (id: KernelId) => void): Unsubscribe;
  on(event: 'fileResolutionFailed', handler: (paths: readonly string[]) => void): Unsubscribe;
};
```

### Input shapes

```typescript
type OpenFileInput =
  | { file: string | { path: string; filename: string }; parameters?: Record<string, unknown>; options?: KernelOptions }
  | { code: Record<string, string>; file?: string; parameters?: Record<string, unknown>; options?: KernelOptions };

type ExportInput = OpenFileInput;

type RenderSettlement = { superseded: false; geometry: HashedGeometryResult } | { superseded: true };
```

### Removed from today's surface

| Removed                                 | Replaced by                                                                                   | Rationale                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `render(input)`                         | `openFile`/`updateParameters` for autonomous mode; `export('glb', input)` for imperative mode | Mode confusion ([Finding 2](#finding-2-two-consumer-modes-not-one)) |
| `setFile(file, params, options)` (void) | `openFile(input): Promise<RenderSettlement>`                                                  | Rename + Promise per §7                                             |
| `setParameters(params)` (void)          | `updateParameters(params): Promise<RenderSettlement>`                                         | Rename + Promise per §7                                             |
| `notifyFileChanged(paths)`              | Internal worker file-watch loop                                                               | v3 F8 redundant in filesystem mode                                  |
| `cancelPendingRender()`                 | Built into supersession of `openFile`/`updateParameters`/`export`                             | v3 F11 subsumed                                                     |
| `setRenderTimeout(ms)`                  | `RuntimeClientOptions.renderTimeout`                                                          | v3 F9 duplicate                                                     |
| `geometryPool` getter                   | Internal                                                                                      | v3 F10 leaks SAB                                                    |
| `lastRequestedGeneration` getter        | Internal                                                                                      | Never needed publicly                                               |
| `incrementAbortGeneration()`            | Internal supersession                                                                         | Never needed publicly                                               |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                     | Priority | Effort | Impact                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------- |
| R1  | Add `openFile(input): Promise<RenderSettlement>` to `RuntimeClient`; resolves on settlement, returns `{ superseded: true }` if a newer call wins                                                                                                                                                                           | P0       | M      | Foundational                            |
| R2  | Add `updateParameters(parameters): Promise<RenderSettlement>` with same settlement semantics as R1                                                                                                                                                                                                                         | P0       | M      | Foundational                            |
| R3  | Keep `export(format, input?)` exactly as it exists today; document the two overloads (with/without input) and the `NoActiveRenderContextError` for the no-input form on a fresh client                                                                                                                                     | P0       | S      | Clarifies workhorse                     |
| R4  | Remove `render(input)` from the public `RuntimeClient` surface                                                                                                                                                                                                                                                             | P0       | S      | Eliminates dichotomy                    |
| R5  | Establish runtime invariant: kernels MUST hold a non-null `nativeHandle` after every successful render until replaced/terminated/explicitly invalidated. Document in `runtime-topology.md` and add a kernel-worker test guarding it                                                                                        | P0       | S      | Live-export performance                 |
| R6  | Migrate `useRender` (`packages/react/src/hooks/use-render.ts`) to call `openFile`/`updateParameters` and subscribe to `'geometry'` / `'state'` / `'parametersResolved'` events; drop the `useEffect`/`cancelled` pattern                                                                                                   | P0       | M      | Production hook correctness             |
| R7  | Migrate `cad.machine.ts` (`apps/ui/app/machines/cad.machine.ts`): replace `client.setFile` → `client.openFile`, `client.setParameters` → `client.updateParameters`. No semantic change beyond the rename and Promise availability                                                                                          | P0       | S      | UI parity                               |
| R8  | Migrate RPC handlers (`apps/ui/app/hooks/rpc-handlers.ts`): replace the `awaitFreshRender`-via-cad-machine path with direct `client.export('glb', { file: targetFile, parameters })`. Re-scope pending TDD tasks t5/t6/t9/t10 accordingly                                                                                  | P0       | M      | Removes generation coupling             |
| R9  | Migrate API benchmark consumer (`apps/api/app/benchmarks/model-benchmark-geometry.ts:56`): `client.render → client.export('glb', ...)`; drop the `result.data.find((g) => g.format === 'gltf')` extraction (export already returns `data.bytes`)                                                                           | P0       | S      | Benchmark correctness                   |
| R10 | Migrate analysis test (`apps/api/app/api/analysis/geometry-analysis.service.test.ts:28`): `client.render → client.export('glb', ...)`                                                                                                                                                                                      | P1       | S      | Test consistency                        |
| R11 | Migrate testing-package tests (`packages/testing/src/geometry/{analyze-glb,connected-components,evaluate-requirement,watertight}.test.ts`): same one-line rename                                                                                                                                                           | P1       | S      | Test consistency                        |
| R12 | Migrate `kernel-geometry-testing.utils.ts`: `extractGltfFromResult(CreateGeometryResult)` → `extractGltfFromExportResult(ExportResult)`; rewrite `createGeometryTestHelpers` to consume `ExportResult`                                                                                                                     | P1       | S      | Helper alignment                        |
| R13 | Migrate runtime benchmark runner (`packages/runtime/src/benchmarks/benchmark-runner.ts:235`): `client.render → client.export('glb', ...)`. Replace `client.notifyFileChanged(...)` with file-write→export pattern (each iteration is independent)                                                                          | P1       | M      | Benchmark correctness                   |
| R14 | Migrate AR conversion (`apps/ui/app/hooks/use-ar.ts`): already on `client.export`; verify it survives unchanged                                                                                                                                                                                                            | P2       | XS     | Verification only                       |
| R15 | Migrate Quick Export UX (`chat-converter.tsx`, `chat-parameters.tsx`): already on `client.export`; verify the no-input overload (`export(format)`) reads from in-memory native handle per R5                                                                                                                               | P1       | S      | UX latency                              |
| R16 | Migrate transport-level test (`packages/runtime/src/transport/in-process-transport.test.ts`): swap `render` for `export('glb', ...)`                                                                                                                                                                                       | P1       | S      | Test consistency                        |
| R17 | Migrate runtime client test suite (`packages/runtime/src/client/runtime-client.test.ts`): ~25 `client.render` calls. Each becomes `export('glb', ...)` for one-shot intent or `openFile(...)` + event-await for autonomous intent. Audit each call for which mode the test is exercising                                   | P1       | L      | Test consistency + coverage realignment |
| R18 | Migrate runtime worker-client test (`packages/runtime/src/framework/runtime-worker-client.test.ts`): 7 `client.render` calls. Same audit                                                                                                                                                                                   | P1       | M      | Test consistency                        |
| R19 | Update type-level tests (`packages/runtime/src/types/define-plugin.test-d.ts`, `packages/runtime/src/client/render-input.test-d.ts`): replace `client.render(...)` type assertions with `client.export(...)` and `client.openFile(...)` assertions                                                                         | P1       | M      | Type-level coverage                     |
| R20 | Worker-level tests (`packages/runtime/src/framework/kernel-worker.test.ts`, `packages/runtime/src/kernels/replicad/replicad.kernel.test.ts`, `kernels/openscad/src/openscad.kernel.test.ts`) call `worker.render(...)` directly — that is internal API; assess whether the worker-level surface should also rename or stay | P2       | M      | Internal API decision                   |
| R21 | Update `runtime-topology.md` protocol table: remove `render(...)` row from the public surface; document `openFile`/`updateParameters` and `export` rows; document the always-warm-native-handle invariant in the §"Worker State" section                                                                                   | P0       | S      | Architecture doc parity                 |
| R22 | Update `library-api-policy.md` if needed: add an example of "supersession with auto-resolved Promise" pattern for the `RenderSettlement` discriminated union                                                                                                                                                               | P2       | S      | Policy reference                        |
| R23 | Re-scope the pending TDD plan (tasks t5/t6/t9/t10): `awaitFreshRender` is no longer needed for RPC; the helper either disappears entirely or becomes a private XState concern; update tests accordingly                                                                                                                    | P0       | M      | Prevents implementing dead helper       |
| R24 | Add a kernel-worker test asserting the always-warm-native-handle invariant (R5): after a successful render, `nativeHandle` remains set across an unrelated abort cycle                                                                                                                                                     | P0       | S      | Lock the invariant                      |
| R25 | Add a runtime-client test asserting `client.export('glb')` (no input) on a freshly-connected client throws `NoActiveRenderContextError` (per [Finding 12](#finding-12-exportformat-without-input-requires-a-live-render-context))                                                                                          | P0       | S      | Lock the contract                       |
| R26 | Add a runtime-client test asserting `client.openFile(...)` Promise resolves with `{ superseded: true }` when a second call follows before the first settles                                                                                                                                                                | P0       | S      | Lock the contract                       |
| R27 | Update `@taucad/runtime` JSDoc and `README` to lead with the autonomous-mode story (open + subscribe) and the imperative-mode story (export); remove all `client.render(...)` examples                                                                                                                                     | P1       | M      | DX clarity                              |
| R28 | Update `useRender` JSDoc to describe the new event-driven pattern; update its `@example` block                                                                                                                                                                                                                             | P1       | S      | Public API docs                         |

## Migration Plan

The migration is a single coordinated change because the public method `render` is being removed. Sequencing matters: runtime impl lands first, consumers migrate, then the public method is dropped.

### Phase 0 — Foundations (P0, parallelisable)

- R5 + R24: Land the always-warm-native-handle invariant and its test.
- R21: Update `runtime-topology.md` (protocol table + invariant section).

### Phase 1 — New surface, parallel to old (P0)

- R1, R2, R3: Add `openFile`, `updateParameters`, formalise two-overload `export`. Old `render`, `setFile`, `setParameters` remain temporarily so consumer migration can land independently.
- R25, R26: Lock the no-context export error and the supersession-Promise behaviour with tests.

### Phase 2 — Consumer migration (P0/P1, parallelisable)

Production consumers first (P0):

- R7: `cad.machine.ts` → `openFile`/`updateParameters`.
- R6: `useRender` → event-subscription pattern.
- R8: `rpc-handlers.ts` → `client.export('glb', ...)`. Re-scope pending TDD plan (R23).
- R9: API benchmark `model-benchmark-geometry.ts`.

Then test/benchmark consumers (P1):

- R10–R13, R16–R19: All `client.render` test/benchmark sites.
- R12: Test helper rewrite.

### Phase 3 — Removal (P0)

- R4: Delete `render`, `setFile`, `setParameters`, `notifyFileChanged`, `cancelPendingRender`, `setRenderTimeout`, `geometryPool` getter, `lastRequestedGeneration` getter, `incrementAbortGeneration` from the public client.
- R20: Decide worker-level surface naming; either rename `worker.render` to match or document the asymmetry.

### Phase 4 — Documentation (P1)

- R22, R27, R28: Update policy, README, hook JSDoc.

### Re-scoping the pending TDD plan

The current pending TDD plan (tasks t1–t13 from the prior session) was built around v3's "expose generations to the UI for fresh-render coordination" design. Several tasks become unnecessary or change shape under v4:

| Pending task                                                                                    | v4 status                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| t1 Runtime tests (latestGeneration SAB slot, generation-stamped events)                         | **Internal-only** — keep as internal-runtime tests, drop the "exposed to UI" portion. SAB stays for internal abort coordination                          |
| t2 Runtime impl (signalSlot.latestGeneration, generation field on responses, dispatcher gating) | **Same** — internal impl, no public surface change                                                                                                       |
| t3 cad.machine tests (lastRequestedGeneration tracking)                                         | **Drop** — `cad.machine` no longer tracks generation; supersession lives in `openFile`/`updateParameters` Promise return                                 |
| t4 cad.machine impl (lastRequestedGeneration field, callback forwarding)                        | **Drop** — replaced by R7 (rename to `openFile`/`updateParameters`)                                                                                      |
| t5 await-fresh-render tests                                                                     | **Drop** — RPC migrates to `client.export` (R8); helper unnecessary                                                                                      |
| t6 await-fresh-render impl                                                                      | **Drop** — same                                                                                                                                          |
| t7 project.machine write-fanout tests                                                           | **Keep** — file-write fanout to UI panes remains needed for editor/runtime sync, but uses internal worker mechanism, not `notifyFileChanged` from the UI |
| t8 project.machine fanout impl                                                                  | **Re-scope** — no `kernelClient.notifyFileChanged` call; rely on the FS worker → kernel-worker watch path                                                |
| t9 RPC handler tests (covering generation, fresh snapshot)                                      | **Re-scope** — tests assert that `client.export('glb', { file, parameters })` is called and resolves; no generation assertions                           |
| t10 RPC handler impl                                                                            | **Re-scope** — `ensureGeometryUnit` becomes `ensureKernelClient` (per pane) and the handler calls `client.export(...)` directly                          |
| t11 RENDER_TIMEOUT in rpcClientErrorCodeSchema                                                  | **Keep** — still needed                                                                                                                                  |
| t12 kernel.integration.test.ts edit-then-fetch                                                  | **Re-scope** — assert that after a file edit, `client.export('glb', ...)` returns the updated geometry. No generation assertions                         |
| t13 Final gate (typecheck/lint/test)                                                            | **Keep**                                                                                                                                                 |

## Trade-offs vs v3

| Dimension                               | v3 (unified `render(input)`)                                                  | v4 (split `openFile`/`updateParameters` + `export`)                   |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Public method count                     | 9                                                                             | 8 + `on()`                                                            |
| Verb overloading                        | `render(input)` does both modes                                               | Each verb has exactly one mode                                        |
| API policy §7 (no void async)           | ✅ — `render` returns Promise                                                 | ✅ — `openFile`/`updateParameters` return Promise                     |
| API policy §1 (single concern)          | ⚠️ `render(input)` carries two concerns (live mutate + one-shot byte-produce) | ✅ Each verb has one concern                                          |
| Wire pattern match                      | Mismatch — autonomous consumers use Promise but want events                   | ✅ Each verb's wire shape matches its consumer's mental model         |
| Live-export speed (no input)            | Implicit — undocumented dependency on warm `nativeHandle`                     | ✅ Codified as runtime invariant (R5)                                 |
| RPC freshness mechanism                 | Generation-coupled `awaitFreshRender` helper                                  | ✅ Direct `client.export('glb', ...)`; no coupling                    |
| Test/benchmark migration cost           | None — keep `render`                                                          | One-line rename per call site                                         |
| `useRender` correctness                 | Promise-based race condition under fast deps                                  | ✅ Event-subscription, race-free                                      |
| Forward-compat with WebSocket transport | ✅ Same                                                                       | ✅ Same                                                               |
| Conceptual onboarding                   | "render does everything" — appears simple, masks complexity                   | "open + subscribe for live; export for one-shot" — explicit dichotomy |

The line-cost trade-off for v4 is one extra public method (8 vs v3's 7 if you collapsed `openFile`/`updateParameters` further). The clarity-cost trade-off is heavily in v4's favour.

## Code Examples

### Autonomous mode — UI pane (the new `cad.machine` shape)

```typescript
const client = createRuntimeClient(kernelOptions);

const subs = [
  client.on('geometry', (result) => machineRef.send({ type: 'geometry', result })),
  client.on('state', (state) => machineRef.send({ type: 'state', state })),
  client.on('progress', (progress) => machineRef.send({ type: 'progress', progress })),
  client.on('error', (error) => machineRef.send({ type: 'kernelIssue', error })),
  client.on('parametersResolved', (resolved) => machineRef.send({ type: 'parametersResolved', resolved })),
];

await client.openFile({ file: '/projects/abc/main.scad', parameters: initialParams });

await client.updateParameters({ ...initialParams, height: 42 });

await client.openFile({ file: '/projects/abc/other.scad' });
```

### Imperative mode — CLI (unchanged)

```typescript
const client = await createNodeClient(inputDirectory);
try {
  const result = await client.export('glb', { file: 'main.scad', parameters });
  if (!result.success) throw new Error(result.issues.map((i) => i.message).join('\n'));
  await writeFile(outputPath, result.data.bytes);
} finally {
  client.terminate();
}
```

### Imperative mode — RPC handler (post-migration)

```typescript
async fetchGeometry({ targetFile, parameters }: FetchGeometryArgs): Promise<FetchGeometryRpcResult> {
  const client = await ensureKernelClient(targetFile);

  const result = await client.export('glb', { file: targetFile, parameters });

  if (!result.success) {
    return { ok: false, error: classifyExportError(result.issues) };
  }
  return { ok: true, glb: result.data.bytes };
}
```

### Imperative mode — Test (post-migration)

```typescript
const result = await client.export('glb', { code: { 'main.ts': boxCode } });
const stats = await analyzeGlb(result.data.bytes);
expect(stats.vertexCount).toBe(8);
expect(stats.connectedComponents(0.01)).toBe(1);
```

### Live export from a UI pane (no input — uses warm native handle)

```typescript
await client.openFile({ file: '/projects/abc/main.scad', parameters });

const stl = await client.export('stl');
const step = await client.export('step');
```

## Diagrams

### Autonomous mode dataflow

```
┌─────────────────┐    openFile / updateParameters     ┌──────────────────────┐
│  UI pane        │ ────────────────────────────────▶  │  RuntimeClient       │
│  (cad.machine)  │                                    │  (per pane)          │
│                 │                                    │                      │
│                 │ ◀───── on('geometry') ───────────  │   internal:          │
│                 │ ◀───── on('state')    ───────────  │     - one Worker     │
│                 │ ◀───── on('progress') ───────────  │     - one bridge     │
│                 │ ◀───── on('error')    ───────────  │     - SAB abort      │
└─────────────────┘                                    │     - generation     │
                                                       └──────────────────────┘
                                                                  │
                                          worker autonomously     │
                                          re-renders on:          │
                                            - file watch fires    │
                                            - param debounce      │
                                            - dep changes         ▼
                                                       ┌──────────────────────┐
                                                       │  KernelWorker        │
                                                       │  - currentFile       │
                                                       │  - currentParameters │
                                                       │  - nativeHandle ◀────┐
                                                       │  (always warm after  │ R5 invariant
                                                       │   success)           │
                                                       └──────────────────────┘
```

### Imperative mode dataflow

```
┌─────────────────┐    export('glb', input)            ┌──────────────────────┐
│  CLI / RPC /    │ ────────────────────────────────▶  │  RuntimeClient       │
│  Test / Bench   │                                    │  (one-shot or live)  │
│                 │                                    │                      │
│                 │ ◀───── Promise<ExportResult> ────  │   bundle → render →  │
└─────────────────┘                                    │   export → resolve   │
                                                       └──────────────────────┘
```

### Live export reuses warm native handle

```
┌─────────────────┐                                    ┌──────────────────────┐
│  UI pane        │     openFile + updateParameters    │  RuntimeClient       │
│                 │ ────────────────────────────────▶  │                      │
│                 │ ◀───────── geometry event          │  KernelWorker:       │
│                 │                                    │  nativeHandle ✅       │
│                 │     export('stl')  (no input)      │  (warm)              │
│                 │ ────────────────────────────────▶  │                      │
│                 │ ◀──── Promise<ExportResult>        │  reuses handle,      │
│                 │      (~tens of ms, no kernel run)  │  skips bundle/render │
└─────────────────┘                                    └──────────────────────┘
```

## Appendix A: Full Consumer Call-Site Inventory

Every in-tree call to `client.render(...)` (excluding `worker.render(...)` direct calls), with prescribed v4 migration:

| File                                                            | Line                                                                                              | Mode                    | v4 verb                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/app/machines/cad.machine.ts`                           | 113-160 (uses `client.setFile`/`setParameters` today, not `client.render`; relevant to migration) | Autonomous              | `client.openFile` / `client.updateParameters`                                                                           |
| `packages/react/src/hooks/use-render.ts`                        | 148                                                                                               | Autonomous              | Refactor to event-subscription on `'geometry'`; trigger via `client.openFile` / `client.updateParameters`               |
| `apps/api/app/benchmarks/model-benchmark-geometry.ts`           | 56                                                                                                | Imperative              | `client.export('glb', { code, file })`                                                                                  |
| `apps/api/app/api/analysis/geometry-analysis.service.test.ts`   | 28                                                                                                | Imperative              | `client.export('glb', { code: { [filename]: code }, file: filename })`                                                  |
| `packages/testing/src/geometry/connected-components.test.ts`    | 21                                                                                                | Imperative              | `client.export('glb', ...)`                                                                                             |
| `packages/testing/src/geometry/evaluate-requirement.test.ts`    | 20                                                                                                | Imperative              | `client.export('glb', ...)`                                                                                             |
| `packages/testing/src/geometry/analyze-glb.test.ts`             | 17                                                                                                | Imperative              | `client.export('glb', ...)`                                                                                             |
| `packages/testing/src/geometry/watertight.test.ts`              | 18                                                                                                | Imperative              | `client.export('glb', ...)`                                                                                             |
| `apps/ui/app/machines/kernel.integration.test.ts`               | 141, 195                                                                                          | Imperative (test)       | `client.export('glb', ...)`                                                                                             |
| `packages/runtime/src/benchmarks/benchmark-runner.ts`           | 235                                                                                               | Imperative              | `client.export('glb', { file, parameters })`; replace `client.notifyFileChanged(...)` with file-write→export sequencing |
| `packages/runtime/src/transport/in-process-transport.test.ts`   | 51, 78, 109, 132, 147, 164                                                                        | Imperative              | `client.export('glb', ...)`                                                                                             |
| `packages/runtime/src/client/runtime-client.test.ts`            | ~25 sites                                                                                         | Mixed                   | Per-test audit: imperative → `client.export('glb', ...)`; autonomous → `client.openFile(...)` + event await             |
| `packages/runtime/src/framework/runtime-worker-client.test.ts`  | 56, 87, 126, 140, 167, 271, 320                                                                   | Mixed                   | Same audit                                                                                                              |
| `packages/runtime/src/types/define-plugin.test-d.ts`            | 2391, 2399, 2403, 3250                                                                            | Type-level              | Replace `client.render(...)` type assertions with `client.export(...)` and `client.openFile(...)`                       |
| `packages/runtime/src/client/render-input.test-d.ts`            | 206, 211, 224, 230, 234, 238, 243, 248, 253, 342, 350                                             | Type-level              | Same; rename file to `open-file-input.test-d.ts`                                                                        |
| `packages/runtime/src/framework/kernel-worker.test.ts`          | 294, 320                                                                                          | Worker-level (internal) | Decision per R20                                                                                                        |
| `packages/runtime/src/kernels/replicad/replicad.kernel.test.ts` | 2937, 3073, 3082, 3321, 3347, 3410                                                                | Worker-level (internal) | Decision per R20                                                                                                        |
| `kernels/openscad/src/openscad.kernel.test.ts`                  | 2103, 2127                                                                                        | Worker-level (internal) | Decision per R20                                                                                                        |
| `packages/runtime/src/client/runtime-client.ts`                 | 470 (JSDoc), 734 (`input.client.render` — internal call)                                          | Internal/docs           | Update JSDoc to `client.export` example; rewrite the internal call as needed                                            |

Total: **~80 call sites** across **18 files**. The bulk (~70%) is test code where the change is a one-line rename.

## Appendix B: Per-Mode Contract

### Autonomous mode

| Aspect          | Contract                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Trigger verbs   | `openFile(input)`, `updateParameters(parameters)`, `setOptions(options)`                               |
| Return          | `Promise<RenderSettlement>` — resolves on the _next_ settled render that this call started or covered  |
| Supersession    | A subsequent trigger before settlement causes the prior Promise to resolve with `{ superseded: true }` |
| Result delivery | `on('geometry')`, `on('state')`, `on('progress')`, `on('error')`                                       |
| Event ordering  | Single ordered postMessage channel; events arrive in worker-emit order                                 |
| Lifetime        | One pair of trigger/event-stream lives for the lifetime of the client                                  |
| Watch loop      | `openFile` (re)starts the file watch; `updateParameters` does not                                      |
| Debouncing      | `updateParameters` debounced 50ms; `openFile` immediate                                                |
| Live export     | `export(format)` (no input) reads warm `nativeHandle`                                                  |

### Imperative mode

| Aspect             | Contract                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Trigger verb       | `export(format, input)`                                                                                                 |
| Return             | `Promise<ExportResult>` — resolves once with the bytes for that format                                                  |
| Supersession       | None — each call is independent                                                                                         |
| Event subscription | Optional but typically not used by imperative consumers                                                                 |
| Lifetime           | Per call; client may be created+terminated per batch (CLI) or shared across calls (RPC)                                 |
| Watch loop         | None established by `export` with input                                                                                 |
| Live export        | `export(format)` without input requires a previous `openFile` settlement; otherwise throws `NoActiveRenderContextError` |

## Appendix C: Inheritance and corrections from v1, v2, v3

Cumulative survival table across blueprint revisions:

| Concept                                                     | v1       | v2       | v3                         | v4                                                     |
| ----------------------------------------------------------- | -------- | -------- | -------------------------- | ------------------------------------------------------ |
| Generations are public API                                  | ✅       | ❌       | ❌                         | ❌                                                     |
| Generations are internal-only abort primitive               | n/a      | ✅       | ✅                         | ✅                                                     |
| `TransportCapabilities` flag struct                         | n/a      | ✅       | ❌                         | ❌                                                     |
| Behavior-complete `RuntimeTransport` interface              | n/a      | n/a      | ✅                         | ✅                                                     |
| Single ordered event channel                                | n/a      | partial  | ✅                         | ✅                                                     |
| SAB scope = single internal `abortGeneration` flag          | n/a      | partial  | ✅                         | ✅                                                     |
| `notifyFileChanged` on public surface                       | ✅       | ✅       | ❌                         | ❌                                                     |
| `cancelPendingRender` on public surface                     | ✅       | ✅       | ❌                         | ❌                                                     |
| `setRenderTimeout` on public surface                        | ✅       | ✅       | ❌                         | ❌                                                     |
| `geometryPool` getter on public surface                     | ✅       | ✅       | ❌                         | ❌                                                     |
| `setFile`/`setParameters` (void async, violating §7)        | ✅       | ✅       | ❌ collapsed into `render` | ❌ replaced by `openFile`/`updateParameters` (Promise) |
| `RenderSession` abstraction                                 | n/a      | n/a      | considered then dropped    | n/a                                                    |
| `render(input)` Promise-correlated as universal mutator     | n/a      | n/a      | ✅                         | ❌                                                     |
| `render` for autonomous mode + `export` for imperative mode | n/a      | n/a      | n/a                        | ✅                                                     |
| Always-warm-native-handle invariant                         | implicit | implicit | implicit                   | ✅ codified (R5)                                       |
| 'memory' pseudo-format for `export`                         | n/a      | n/a      | n/a                        | ❌ rejected                                            |
| One client per pane invariant                               | implicit | implicit | ✅ named                   | ✅                                                     |
| Library API Policy compliance audit                         | partial  | ✅       | ✅                         | ✅ (redone for new surface)                            |

## References

- [`docs/research/runtime-event-driven-api-blueprint.md`](runtime-event-driven-api-blueprint.md) — v1, original blueprint
- [`docs/research/runtime-event-driven-api-blueprint-v2.md`](runtime-event-driven-api-blueprint-v2.md) — v2, capability-flag iteration
- [`docs/research/runtime-event-driven-api-blueprint-v3.md`](runtime-event-driven-api-blueprint-v3.md) — v3, unified `render(input)` (corrected by v4)
- [`docs/policy/library-api-policy.md`](../policy/library-api-policy.md) — public API rules
- [`docs/architecture/runtime-topology.md`](../architecture/runtime-topology.md) — autonomous reactive render service
- [`docs/research/shared-memory-geometry-pipeline.md`](shared-memory-geometry-pipeline.md) — SAB pipeline
- [`docs/research/nativehandle-serialization-and-pipeline-architecture.md`](nativehandle-serialization-and-pipeline-architecture.md) — native handle lifecycle (related to R5 invariant)
- [`docs/research/cli-runtime-ergonomics.md`](cli-runtime-ergonomics.md) — CLI consumer profile
- [`docs/research/capabilities-manifest-api-audit.md`](capabilities-manifest-api-audit.md) — capabilities surface (orthogonal)
