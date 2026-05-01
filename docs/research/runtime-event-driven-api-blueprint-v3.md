---
title: 'Runtime Event-Driven API Blueprint v3'
description: 'Final-state blueprint for @taucad/runtime: one-client-per-pane invariant, render() as the universal mutation primitive, behavior-complete transport hiding SAB entirely, single ordered event channel, and a public API reduced to nine methods with zero generation/SAB leakage.'
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
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/capabilities-manifest-api-audit.md
  - docs/research/runtime-client-type-safety-audit.md
  - docs/research/cli-runtime-ergonomics.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/lazy-capabilities-manifest.md
---

# Runtime Event-Driven API Blueprint v3

Final-state blueprint for the `@taucad/runtime` consumer API: respects the one-client-per-pane architectural invariant, collapses every render-mutation primitive into a single Promise-correlated `render()` method, hides SAB and capability negotiation entirely behind a behavior-complete transport, guarantees single-channel event ordering, and shrinks the SAB scope to one internal cooperative-abort flag.

## Executive Summary

This document supersedes v1 and v2 and replaces an earlier v3 draft. The earlier v3 introduced a `RenderSession` abstraction with the rationale that it would "eliminate cross-session interference and simplify the multi-pane UI case." That rationale was wrong: the production architecture already creates a separate `RuntimeClient` per pane (see [The One-Client-Per-Pane Invariant](#the-one-client-per-pane-invariant)), so cross-pane isolation is solved at the client-instance level. Layering a `RenderSession` on top of that adds a redundant scope without removing any real problem. v3 corrects that mistake and lands on a smaller surface.

Three architectural shifts drive every recommendation:

1. **One client per pane is the invariant.** Every pane in the UI constructs its own `createRuntimeClient(...)` inside its own CAD machine. Each client owns one worker, one bridge to the file manager, and one render context. Render isolation, event isolation, and lifecycle isolation are properties of the client instance, not of any sub-scope. The public API design must respect this and stop pretending the client serves multiple concurrent contexts.
2. **`render()` is the universal mutation primitive.** Because each client manages exactly one render context, every state mutation (`setFile`, `setParameters`, `setOptions`) collapses into a single Promise-coalesced `render(input)` call. The first call kicks off rendering and (in filesystem mode) starts the worker's autonomous file-watch loop. Subsequent calls supersede and update. There are no setter footguns, no `void` async returns, no separate "settled" primitive.
3. **The transport hides SAB and capability negotiation entirely.** Every "do I have SAB?" branch in today's runtime client moves into the transport implementations themselves. The runtime client calls polymorphic methods (`observeWorkerState`, `signalAbort`, `resolveGeometry`) and the transport chooses internally between SAB and message-routing. There is no `TransportCapabilities` flag struct because flags would re-create the leak.

The combined result is a **public client surface of 9 methods and 9 event types** (down from today's 14 methods and 9 event types), with zero references to generations, requestIds, SAB, or capability flags in any consumer-visible signature. A future `createWebSocketTransport` works under exactly the same consumer code that works today against a local `Worker`. SAB shrinks to a single internal `abortGeneration` flag used by cooperative-abort polling inside WASM.

## Table of Contents

- [Scope and Non-Goals](#scope-and-non-goals)
- [The One-Client-Per-Pane Invariant](#the-one-client-per-pane-invariant)
- [Methodology](#methodology)
- [Consumer Surface Survey](#consumer-surface-survey)
- [Findings](#findings)
  - [Finding 1: One client per pane is the architectural invariant; sessions are over-engineering](#finding-1-one-client-per-pane-is-the-architectural-invariant-sessions-are-over-engineering)
  - [Finding 2: Generations are an internal cooperative-abort primitive](#finding-2-generations-are-an-internal-cooperative-abort-primitive)
  - [Finding 3: render() is the universal Promise-correlated mutation primitive](#finding-3-render-is-the-universal-promise-correlated-mutation-primitive)
  - [Finding 4: setFile and setParameters are not setters](#finding-4-setfile-and-setparameters-are-not-setters)
  - [Finding 5: Capability flags on transports are a leaky abstraction](#finding-5-capability-flags-on-transports-are-a-leaky-abstraction)
  - [Finding 6: Events have no cross-channel ordering guarantee today](#finding-6-events-have-no-cross-channel-ordering-guarantee-today)
  - [Finding 7: SAB scope can shrink to a single internal abort flag](#finding-7-sab-scope-can-shrink-to-a-single-internal-abort-flag)
  - [Finding 8: notifyFileChanged is redundant in filesystem mode](#finding-8-notifyfilechanged-is-redundant-in-filesystem-mode)
  - [Finding 9: setRenderTimeout duplicates RuntimeClientOptions.renderTimeout](#finding-9-setrendertimeout-duplicates-runtimeclientoptionsrendertimeout)
  - [Finding 10: geometryPool getter leaks SAB internals](#finding-10-geometrypool-getter-leaks-sab-internals)
  - [Finding 11: cancelPendingRender is subsumed by render supersession](#finding-11-cancelpendingrender-is-subsumed-by-render-supersession)
  - [Finding 12: connect is half-lazy; full laziness simplifies the contract](#finding-12-connect-is-half-lazy-full-laziness-simplifies-the-contract)
  - [Finding 13: Library API Policy compliance — point-by-point](#finding-13-library-api-policy-compliance--point-by-point)
  - [Finding 14: A WebSocket transport breaks SAB-flavoured public APIs](#finding-14-a-websocket-transport-breaks-sab-flavoured-public-apis)
- [Target Architecture](#target-architecture)
- [Should consumers see SAB? A transparency analysis](#should-consumers-see-sab-a-transparency-analysis)
- [Recommendations](#recommendations)
- [Trade-offs vs v1, v2, and the prior v3 draft](#trade-offs-vs-v1-v2-and-the-prior-v3-draft)
- [Migration Path](#migration-path)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Appendix A: API Surface Audit Table](#appendix-a-api-surface-audit-table)
- [Appendix B: Per-Render Event Lifecycle Contract](#appendix-b-per-render-event-lifecycle-contract)
- [Appendix C: Inheritance and corrections from v1, v2, and the prior v3](#appendix-c-inheritance-and-corrections-from-v1-v2-and-the-prior-v3)

## Scope and Non-Goals

**In scope:**

- Public API surface of `@taucad/runtime` (`createRuntimeClient`, `RuntimeClient`).
- `RuntimeTransport` interface contract and its concrete implementations.
- Internal command/response protocol (`RuntimeCommand`, `RuntimeResponse`).
- SAB usage scope and the single-ordered-channel event contract.
- Library API Policy compliance pass for every consumer-facing symbol.
- Forward-compatibility with a `createWebSocketTransport` (or HTTP+SSE / gRPC) remote runtime worker.

**Out of scope:**

- Plugin authoring contracts (`defineKernel`, `defineMiddleware`, `defineBundler`, `defineTranscoder`) — covered by separate research.
- Kernel-internal cache invalidation algorithms — covered by [`runtime-topology.md`](../architecture/runtime-topology.md).
- Type-level audits — covered by [`runtime-client-type-safety-audit.md`](runtime-client-type-safety-audit.md).
- Capabilities-manifest contents (kernels, transcoders, formats) — covered by [`capabilities-manifest-api-audit.md`](capabilities-manifest-api-audit.md). v3 only addresses the orthogonal **transport** capability surface.

## The One-Client-Per-Pane Invariant

This invariant is the single most important constraint that drives v3's design. Every other recommendation flows from respecting it.

### What the invariant says

Every UI pane that renders CAD geometry constructs its own `RuntimeClient`. That client owns:

- One `Worker` (the kernel worker).
- One `MessagePort` bridge into the shared file manager worker.
- One render context (`currentFile`, `currentParameters`, `currentOptions`).
- One geometry SAB pool (when SAB is available).
- One event subscriber set.
- One lifecycle (terminated when the pane closes).

Multiple panes operate concurrently because they have **separate clients**, **separate workers**, and **separate event streams**. Cross-pane isolation is a property of process topology, not of any in-client abstraction.

### Evidence in the codebase

| Source                                                        | Lines       | What it shows                                                                                                                  |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/ui/app/machines/cad.machine.ts`                         | 113         | `const client = createRuntimeClient(kernelOptions);` — runs inside `connectKernelActor`, invoked once per CAD machine instance |
| `apps/ui/app/machines/project.machine.ts`                     | spawnChild  | Project machine spawns one CAD machine per geometry unit                                                                       |
| `apps/ui/app/machines/cad.machine.ts:120`                     | 120         | `client.terminate()` runs in the actor teardown — one worker dies per pane close                                               |
| `apps/ui/app/machines/cad.machine.ts:126-160`                 | 126-160     | Event handlers `client.on('geometry'/'state'/'progress'/...)` forward to `machineRef.send(...)` — one machine per client       |
| `apps/ui/app/machines/kernel.integration.test.ts:131,160,189` | 131,160,189 | Tests construct a fresh `createRuntimeClient` per scenario, mirroring the production per-pane wiring                           |

The screenshot the reviewer flagged on the prior v3 draft was correct: any design proposal that talks about "cross-session interference" inside a single client is solving a non-existent problem.

### What this invariant rules out

- **Sessions inside a client.** A `RenderSession` would split a single client's render context into multiple sub-contexts. Since the client never has multiple contexts in production, the abstraction adds API surface without removing any failure mode.
- **Multiple concurrent watches.** Because a client serves exactly one pane, it watches exactly one file at a time. New watches replace old ones. No "watch list" bookkeeping.
- **Per-event filtering by file path.** Today's `cad.machine.ts` doesn't filter `'geometry'` events by file path because every event on its client belongs to its pane. v3 keeps that property — the API never exposes a multi-target event stream.
- **Cross-pane request correlation.** RPC handlers in `apps/ui/app/hooks/rpc-handlers.ts` resolve a `cadUnit` actor first, then talk to that actor's client. The handler never reaches across panes.

### What this invariant enables

- **`render()` can be the universal mutation primitive.** Because there's only one render context, `render(input)` can both kick off the first render AND update the live render context. No `start`/`update`/`stop` triad.
- **Events stay on the client.** No need to scope events to a sub-object — the client itself is the scope.
- **Lifecycle is unambiguous.** `client.terminate()` cleans everything up because there's nothing else to clean up.

### What this invariant does not rule out

- **Workspace-shared state still exists.** The file manager (FM) worker is shared across all panes and is not part of any pane's client. The FM owns the workspace filesystem and broadcasts change events to every client's bridge. v3 does not change FM ownership.
- **Workspace-level capabilities still exist.** `client.capabilities` (kernels/transcoders/formats) is per-client today and remains so; no global capabilities object.

## Methodology

1. Re-read the prior v3 draft end-to-end and identified the `RenderSession` abstraction as a misalignment with production topology.
2. Verified the one-client-per-pane invariant by tracing `createRuntimeClient` call sites in `apps/ui/app/machines/cad.machine.ts` and confirming each call corresponds to one pane lifecycle.
3. Re-enumerated every consumer of `createRuntimeClient` / `createNodeClient` across the monorepo to confirm no consumer needs multiple render contexts on one client: CLI (`packages/cli/`), benchmark runner (`packages/runtime/src/benchmarks/`), API server (`apps/api/`), testing helpers (`packages/testing/`), UI machines (`apps/ui/app/machines/`).
4. Re-walked v1 and v2 findings, kept the survivors, dropped the assumptions that the session model relied on, and re-derived the public surface from first principles using the one-client-per-pane invariant as ground truth.
5. Designed a minimal `RuntimeTransport` interface that fulfills every protocol responsibility polymorphically (no client-side branching) and validated that the same interface can be implemented by `in-process`, `worker`, and a future `websocket` transport.
6. Modelled the event-ordering contract under the current dual-channel implementation (SAB-monitor for state vs `postMessage` for geometry) and confirmed cross-channel races. Designed the single-channel contract.
7. Audited every public method on today's `RuntimeClient` against [`docs/policy/library-api-policy.md`](../policy/library-api-policy.md) §1, §3, §4, §5, §7, §10, §11, §17.

## Consumer Surface Survey

Every consumer of the runtime, the mode they use, and the correlation primitive they rely on today.

| Consumer                                         | Entry point            | Transport    | Promise-style commands                           | Streaming events                                               | Correlation today                                        |
| ------------------------------------------------ | ---------------------- | ------------ | ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------- |
| CLI `taucad export`                              | `createNodeClient`     | `in-process` | `client.export(format, input)`                   | `'log'` only                                                   | None beyond `await`                                      |
| CLI `taucad render` (future)                     | `createNodeClient`     | `in-process` | `client.render({ file, params })`                | `'log'`, `'progress'`                                          | None beyond `await`                                      |
| Runtime benchmark runner                         | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | `'telemetry'`                                                  | None beyond `await`                                      |
| API benchmarks (`model-benchmark-geometry.ts`)   | `createRuntimeClient`  | `in-process` | `client.render({ code, file })`                  | None                                                           | None beyond `await`                                      |
| `packages/testing` (`analyze-glb.test.ts`, etc.) | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | None                                                           | None beyond `await`                                      |
| Kernel integration tests                         | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | One-shot `client.on('geometry', resolve)` to test setFile path | First-event-after-setFile (race-prone)                   |
| UI live preview (`cad.machine.ts`)               | `createRuntimeClient`  | `worker`     | `client.setFile`/`setParameters` (today: `void`) | `'geometry'`, `'kernelIssue'`, `'state'`                       | "Has the worker settled to reflect what I asked for?"    |
| UI agent RPCs (`rpc-handlers.ts`)                | (uses `cadUnit` actor) | `worker`     | None directly                                    | None directly                                                  | "Wait for `state.value === 'idle'`" via XState `waitFor` |

**Two consumer classes:**

- **One-shot consumers** (CLI, benchmarks, API tests, `packages/testing`, kernel integration tests): one or more `await client.render(...)` calls, then `client.terminate()`. These never need to know the worker is watching anything.
- **Live-preview consumers** (UI live preview, agent RPCs which transitively drive live preview): one client per pane, mutate the render context as the user edits, observe events as the worker re-renders autonomously on file changes.

Every consumer in both classes is satisfied by a Promise-coalesced `client.render(input)` and a single ordered event stream. No consumer in either class needs sub-client scoping.

Source data:

- CLI: `packages/cli/src/commands/export.ts:72-101` — `await client.export(format, { file, parameters })`.
- Benchmark: `packages/runtime/src/benchmarks/benchmark-runner.ts:196-262` — `client.on('telemetry', …)` + `await client.render(…)`.
- API benchmarks: `apps/api/app/benchmarks/model-benchmark-geometry.ts` — `await client.render({ code, file })`.
- Testing: `packages/testing/src/geometry/analyze-glb.test.ts:9-28` — `await client.render({ code, file })`.
- UI live preview: `apps/ui/app/machines/cad.machine.ts:113` — one `createRuntimeClient` per `connectKernelActor` invocation.
- UI agent RPCs: `apps/ui/app/hooks/rpc-handlers.ts:223` — `waitFor(cadUnit, state => state.value === 'idle' || state.value === 'error')`.

## Findings

### Finding 1: One client per pane is the architectural invariant; sessions are over-engineering

The prior v3 introduced a `RenderSession` returned from `client.watch(input)` with the rationale of "eliminating cross-session interference and simplifying the multi-pane UI case." This rationale collapses on inspection.

**Why sessions don't help.** Cross-pane interference is impossible today because each pane has its own `RuntimeClient` instance (verified at `cad.machine.ts:113`), its own `Worker`, and its own event subscriber set. A `RenderSession` would slice a single client's already-singular render context into one sub-scope per session, which is a layering of empty containers.

**What sessions cost.** Adding a `RenderSession` type expands the surface from one type the consumer learns (`RuntimeClient`) to two (`RuntimeClient` + `RenderSession`). Each consumer call site goes from one indirection (`client.method(...)`) to two (`session = client.watch(...); session.method(...)`). The state machine in `cad.machine.ts` would need to track two refs (the client and the session) and synchronize their lifecycles. None of this buys any new isolation.

**Conclusion.** v3 abandons the session abstraction and treats the client itself as the render context. Every method that the prior v3 placed on `RenderSession` (`update`, `dispose`, `on`) becomes a method directly on `RuntimeClient` (`render`, `terminate`, `on`).

### Finding 2: Generations are an internal cooperative-abort primitive

This finding carries from v2 unchanged. `signalSlot.abortGeneration` exists for one purpose: long-running C++ code inside Replicad/OCCT/Manifold needs to be told "stop, your work is obsolete" without crossing back to JavaScript. The mechanism is `Atomics.add` on the main thread, polled inside WASM via `cooperative-abort.ts:checkAbort()`, throwing `RenderAbortedError` on divergence.

That's the entire role. The dispatcher never reads it. No `RuntimeResponse` carries it. No public method returns it. v1 proposed promoting this counter to a public correlation primitive; v2 corrected that to "internal-only" and v3 keeps the same conclusion. Generations are not part of the public API.

### Finding 3: render() is the universal Promise-correlated mutation primitive

Today's `render()` already provides the ideal contract for one-shot consumers (CLI, benchmarks, tests):

```typescript
const result = await client.render({ file, parameters });
```

For live-preview consumers (UI), the contract should be **the same**, with one additional behavior: after `render()` resolves, the worker continues to watch the rendered file for changes (via the existing bridge watch chain), emitting subsequent geometry as `'geometry'` events. Calling `render()` again supersedes the previous render and switches the watch target.

This collapses three of today's mutation methods (`setFile`, `setParameters`, `notifyFileChanged`) into one Promise-correlated primitive, and it works because of the one-client-per-pane invariant — the client always has exactly one render target, so a method that updates "the render target" is unambiguous.

**Promise contract:**

- `client.render(input)` returns `Promise<HashedGeometryResult>`.
- The Promise resolves when the first geometry result for **this call's input** is delivered.
- A subsequent `client.render(...)` rejects the previous Promise with `RenderSupersededError` (same shape today's `cancelPendingRender` produces).
- After the Promise resolves, autonomous re-renders triggered by file watches continue to fire `'geometry'` events but do not resolve a new Promise (no Promise is pending until the next `render()` call).
- `client.terminate()` rejects any pending Promise with a generic `Error('Runtime terminated')`.

**Why this works for one-shot consumers.** CLI calls `await client.render(...)` then `client.terminate()`. The watch loop runs briefly between resolution and terminate, but the file isn't changing, so no autonomous re-render fires and the worker idles. The watch loop is invisible.

**Why this works for live-preview consumers.** UI calls `await client.render({ file, parameters })` once. Subsequent file edits trigger autonomous re-renders; the UI observes them via `client.on('geometry', ...)`. When the user changes parameters, UI calls `client.render({ file, parameters: newParams })` — same method, supersedes, returns a new Promise.

**Why this works for benchmark/test consumers that mutate an unbridged FS.** Inline-code mode (`render({ code: { ... } })`) handles FS writes internally and is the appropriate path for benchmarks. Benchmarks today using direct FS mutation should migrate to inline-code mode or (for test fixtures only) a tagged `__test__invalidate(paths)` escape hatch. The public `notifyFileChanged` is removed.

### Finding 4: setFile and setParameters are not setters

The verb `setFile` describes a setter — pure mutation, no result. But the method actually triggers an asynchronous render, mutates worker state, and produces geometry events as a side effect. The verb misleads consumers into expecting fire-and-forget semantics, when in reality the call has side effects spanning multiple events.

`setParameters` has the same problem: the verb says "mutation," the behavior says "side-effecting async operation."

**Existence justifications, audited:**

| Justification                                                                             | Holds up?                                                                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "They're separate from `render()` because they coalesce"                                  | No — `render()` can be Promise-coalesced too                                                                    |
| "They're separate because file changes use 500ms debounce and parameter changes use 50ms" | Internal optimization, not a consumer concern; can be inferred from "did file change?" inside the worker        |
| "They're void because the result comes via the event stream"                              | Footgun — event-vs-promise duality has no benefit; a Promise that ALSO drives an event is strictly more capable |
| "They exist to support live-preview semantics"                                            | Live preview is satisfied by re-callable `render()` under the one-client-per-pane invariant                     |

**Conclusion.** Both methods collapse into `render(input)`. The verb `render` accurately describes the action (it produces geometry). The Promise return signals completion. Re-callability subsumes both setters.

### Finding 5: Capability flags on transports are a leaky abstraction

v2 proposed `transport.capabilities.sharedMemory` so the runtime client could branch:

```typescript
// v2 proposal — leaky:
const monitor = transport.capabilities.sharedMemory
  ? createSabStateMonitor(this.signalView)
  : createMessageStateMonitor(this.transport);
```

This violates **Tell, Don't Ask**: the client asks the transport "what kind are you?" and then performs the SAB logic itself. It violates **Open-Closed**: every new transport requires updating every client-side branch. It violates **Single Responsibility**: the runtime client ends up knowing about both SAB-monitoring and message-monitoring as separate implementation paths.

**Solution.** Replace the flag struct with a behavior-complete `RuntimeTransport` interface. Each transport implementation owns its SAB-vs-message decision **internally**. The runtime client calls polymorphic methods and never branches on transport identity:

```typescript
type RuntimeTransport = {
  send(command: RuntimeCommand, transferables?: Transferable[]): void;
  onMessage(handler: (message: RuntimeResponse) => void): void;

  observeWorkerState(handler: (state: WorkerState, detail?: string) => void): Unsubscribe;
  signalAbort(reason: AbortReason): void;
  resolveGeometry(payload: GeometryTransport): Promise<Geometry>;

  describe(): TransportDescriptor;
  close(): void;
};
```

`createInProcessTransport` and `createWorkerTransport` allocate SAB internally (or accept it as an option) and use `Atomics.waitAsync` for `observeWorkerState` and `Atomics.add` for `signalAbort`. Geometry resolution dereferences pool keys against an internally-held `SharedPool`.

`createWebSocketTransport` (future) implements `observeWorkerState` as a wire-message subscription, `signalAbort` as a wire command, and `resolveGeometry` returns inline bytes from the wire response.

The runtime client never branches on what the transport is. SOLID violations dissolve because each transport is a polymorphic implementation of one interface.

`describe()` returns a **diagnostic-only** descriptor (`{ name, locality, sharedMemory, latencyClass }`) — for telemetry overlays, debug logs, and `LogEntry.data`. It is never used for control flow. The user is never asked to read it; it's just available for inspection.

### Finding 6: Events have no cross-channel ordering guarantee today

Two delivery channels run independently:

| Channel     | Carries                                                                                       | Mechanism                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| SAB monitor | `state`, `abortGeneration`, `progress`                                                        | `Atomics.waitAsync` polling loop in `RuntimeWorkerClient.startStateMonitor` |
| postMessage | `geometry`, `error`, `parametersResolved`, `log`, `capabilities`, `telemetry`, `activeKernel` | `transport.onMessage`                                                       |

These two channels are **not synchronized**. A consumer subscribed to both can see:

```
state: idle      ← from SAB monitor (fast)
geometry: {...}  ← from postMessage (slow)
```

…even though the worker emitted `geometry` BEFORE writing `idle` to SAB. The natural reading "state idle means all results have been delivered" is violated.

This is the root cause of the race that the original RPC-handlers investigation surfaced: agent RPC code that waits for `state.value === 'idle'` and then reads geometry can read the geometry from the **previous** render because the new render's `state: idle` arrived ahead of its `geometry` event.

v2's Finding 9 proposed gating `stateChanged` `postMessage` on `!sabPresent` — meaning when SAB is present, state arrives via SAB only. **That made the cross-channel race permanent**, not transient. v3 inverts this: state events always flow through `postMessage`, and SAB shrinks to internal abort polling only.

### Finding 7: SAB scope can shrink to a single internal abort flag

Once event ordering is solved by single-channel `postMessage` delivery (Finding 6), SAB's role reduces dramatically.

**Today's SAB layout** (`packages/runtime/src/types/runtime-protocol.types.ts:184-190`):

| Slot                         | Direction     | Purpose                                                     | Required for ordering?         |
| ---------------------------- | ------------- | ----------------------------------------------------------- | ------------------------------ |
| `signalSlot.abortGeneration` | main → worker | Cooperative abort polled by WASM via `cooperative-abort.ts` | No (internal to abort)         |
| `signalSlot.workerState`     | worker → main | Worker state snapshot polled by main thread                 | **Yes — moves to postMessage** |
| `signalSlot.abortReason`     | main → worker | Encodes why abort was requested                             | No (internal to abort)         |
| `signalSlot.progressPercent` | worker → main | Progress percentage                                         | **Yes — moves to postMessage** |

**v3's SAB layout**: only `abortGeneration` (and the implementation-coupled `abortReason`) survive. Both are main → worker, both are internal-only, both serve cooperative abort. No worker → main direction.

This shrinks SAB's responsibility to a single coherent role: **let WASM polling code see "the work you're doing has been superseded" without crossing the JS boundary**. That's exactly what SAB is good at, and removing the worker → main slots removes every ordering hazard.

**What this enables:**

- A future remote transport (WebSocket) doesn't need to emulate any worker → main SAB slot. The wire-message channel carries everything.
- The dispatcher logic simplifies: every outbound event takes the same path.
- Tests for state ordering become trivial — single channel, single ordering.

### Finding 8: notifyFileChanged is redundant in filesystem mode

This finding carries from v1 and v2 unchanged. The kernel worker subscribes to bridge watch events at `kernel-worker.ts:1181`. The handler does identical work to `notifyFileChanged`: invalidates caches via `_invalidateCachesForPaths` and reschedules the render via `scheduleRender`. Production UI writers go through `FileContentService.write` → `proxy.writeFile` → FM worker `FileService.writeFile`, which always triggers the bridge watch.

`notifyFileChanged` is dead weight in production filesystem mode. It survives in only two contexts: (1) inline `render({ code })` writes into a `fromMemoryFS()` instance with no FM worker, and (2) headless tests / benchmarks that mutate an unbridged FS directly.

**v3 conclusion:** `notifyFileChanged` is removed from the public API. The inline `render({ code })` path absorbs its function via a private `setFiles({ files })` operation. Tests get a tagged `__test__invalidate(paths)` escape hatch that's not part of the typed public surface.

### Finding 9: setRenderTimeout duplicates RuntimeClientOptions.renderTimeout

Today there are two ways to set the same value:

- `RuntimeClientOptions.renderTimeout` — set once at construction.
- `client.setRenderTimeout(seconds)` — set dynamically.

The dynamic setter exists, but no consumer in the audit dynamically adjusts the timeout — every site sets it once and forgets it. The dynamic setter just adds API surface.

**v3 conclusion:** `setRenderTimeout` is removed from the public API. `RuntimeClientOptions.renderTimeout` remains the single source. If a future use case requires dynamic adjustment, it can be added back as a property setter (`client.renderTimeoutSeconds = …`) without breaking the established convention.

### Finding 10: geometryPool getter leaks SAB internals

`client.geometryPool: SharedPool | undefined` exposes the SAB pool to consumers. The only legitimate use is diagnostic ("is SAB active?"), and that's covered by `transport.describe()` (Finding 5).

Consumer code that reads `client.geometryPool` is reaching into transport internals to make a decision the transport should be making. Nothing outside the runtime should construct a `SharedPool` directly or resolve pool keys manually — `transport.resolveGeometry(payload)` is the only legitimate path.

**v3 conclusion:** `client.geometryPool` is removed from the public API. The pool moves into the transport (Finding 5) and is internal-only.

### Finding 11: cancelPendingRender is subsumed by render supersession

`client.cancelPendingRender()` exists because today's `render()` is request-correlated and can be cancelled. Under v3, calling `render()` again automatically supersedes the previous render — the previous Promise rejects with `RenderSupersededError`, the worker aborts in-progress work via the existing abort generation increment, and the new render starts.

If a consumer wants to **stop** rendering without starting a new render, they call `client.terminate()` (which destroys the client). For "pause rendering but keep the client alive," there's no use case in the audit — every consumer either renders something else next or shuts down.

**v3 conclusion:** `cancelPendingRender` is removed. Render supersession via re-callable `render()` is the only cancel mechanism.

### Finding 12: connect is half-lazy; full laziness simplifies the contract

Today's `connect()` is half-lazy:

- If `RuntimeClientOptions.fileSystem` is provided at construction, `ensureConnected()` (`runtime-client.ts:547`) auto-connects on first `render()` call.
- If not, the consumer must explicitly call `await client.connect({ fileSystem })` before `render()`.

This is two contracts the consumer must learn. The auto-connect path is strictly preferable — it lets `client.render(...)` "just work" the first time.

**v3 conclusion:** `connect()` becomes fully lazy. Construction stores the connection options; the first `render()` (or `export()`) auto-connects. An explicit `client.connect()` method survives only as an opt-in for consumers that want to pay the connection cost up-front (e.g., to measure cold-start latency separately from first render).

### Finding 13: Library API Policy compliance — point-by-point

| Today's symbol                             | Policy violation                                                                               | v3 resolution                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `setFile(file, parameters?, options?)`     | §4 same-concern positional params (all three describe "what to render")                        | Removed; collapsed into `render({ file, parameters?, options? })`                      |
| `setFile(...)` returns `void`              | §7 implicit (no Promise = no completion signal for async work)                                 | Removed; `render()` returns Promise                                                    |
| `setParameters(parameters)` returns `void` | §7 implicit (no Promise = no completion signal for async work)                                 | Removed; collapsed into `render({ file, parameters })`                                 |
| `notifyFileChanged(paths)`                 | §10 (high-level wrappers) — bypasses the autonomous loop the framework already runs            | Removed; absorbed by inline-code `setFiles` and `__test__invalidate` escape hatch      |
| `cancelPendingRender()`                    | §10 (high-level wrappers) — exposes a low-level cancel that the supersession contract subsumes | Removed; supersession via re-callable `render()` is the cancel mechanism               |
| `setRenderTimeout(seconds)`                | §3 (flat options) — duplicates `RuntimeClientOptions.renderTimeout`                            | Removed; construction-only via `RuntimeClientOptions.renderTimeout`                    |
| `geometryPool` getter                      | §10 (high-level wrappers) — leaks transport internals                                          | Removed; moved into transport, exposed via `transport.describe()` for diagnostics only |
| `connect(options)` requirement             | §1 / §10 — partial laziness creates two contracts                                              | Becomes fully lazy; explicit `connect()` survives as an opt-in pre-warm                |
| `RuntimeTransport` (today)                 | §11 — capability flags would be the wrong fix; behavior-complete interface is the right shape  | Adds `observeWorkerState`, `signalAbort`, `resolveGeometry`, `describe`                |
| Multiple delivery channels for events      | §7 (subscribe-anytime) — channels race                                                         | Single ordered `postMessage` channel for all events                                    |

### Finding 14: A WebSocket transport breaks SAB-flavoured public APIs

Carried from v2 and reinforced by v3's behavior-complete transport design.

A WebSocket transport (or HTTP+SSE, or gRPC) has these constraints:

| Capability                   | `MessageChannel`/`Worker` | `WebSocket` (remote)              |
| ---------------------------- | ------------------------- | --------------------------------- |
| `SharedArrayBuffer` transfer | Yes                       | **No**                            |
| `Transferable[]` (zero-copy) | Yes                       | **No** (binary frames are copies) |
| Synchronous abort signalling | Yes (`Atomics.store`)     | **No** (round-trip)               |
| Latency                      | <1 ms                     | 10–500 ms                         |
| Backpressure                 | Implicit (queue grows)    | Explicit (flow control)           |

Any public surface that mentions SAB, generations, requestIds, or capability flags forces every consumer to branch when the transport is remote. The Promise-correlated `client.render(input)` + behavior-complete transport contract is **transport-agnostic by construction**: the same consumer code works against `worker`, `in-process`, and (future) `websocket` transports. The transport is the only layer that needs to know.

## Target Architecture

A four-layer model where each layer hides the implementation details of the layer below.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Layer 4: Consumer surface (apps, CLI, tests)                        │
│  • await client.render({ file, parameters?, options? })              │
│  • await client.export(format, input?)                               │
│  • client.on('geometry' | 'state' | 'error' | 'progress' | …, cb)    │
│  • client.capabilities (kernels, transcoders)                        │
│  • client.terminate()                                                │
│  ── No generations. No SAB. No requestIds. No capability flags. ──   │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 3: Runtime client (correlation, coalescing, lifecycle)        │
│  • Pending render Promise (one outstanding at a time)                │
│  • Subscribes once to transport.observeWorkerState (single channel)  │
│  • Forwards events to subscribers in arrival order                   │
│  • Lazy connect on first render                                      │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 2: Behavior-complete transport                                │
│  • send(command, transferables?)                                     │
│  • onMessage(RuntimeResponse)                                        │
│  • observeWorkerState(handler) → unsubscribe                         │
│  • signalAbort(reason)                                               │
│  • resolveGeometry(payload) → Promise<Geometry>                      │
│  • describe() → diagnostic descriptor (read-only)                    │
│  • close()                                                           │
│  • Implementations:                                                  │
│    - createInProcessTransport (SAB internally when COI available)    │
│    - createWorkerTransport    (SAB internally when COI available)    │
│    - createWebSocketTransport (future, fully message-based)          │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 1: Wire protocol (JSON + optional Transferables)              │
│  • RuntimeCommand / RuntimeResponse — JSON-serialisable              │
│  • Each command carries an internal requestId (string)               │
│  • Each response either carries a requestId (correlated) or          │
│    'autonomous' (broadcast)                                          │
│  • Geometry payloads: inline bytes OR pool key (when SAB)            │
└──────────────────────────────────────────────────────────────────────┘
```

Internally, between layers 1 and 3, a single SAB slot remains: `signalSlot.abortGeneration` (plus the implementation-coupled `abortReason`). It is never exposed outwards.

### Public type surface (final)

```typescript
type RuntimeClient<Kernels, Transcoders> = {
  // Lifecycle
  connect(options?: ConnectOptions): Promise<void>;
  terminate(): void;

  // Render & export
  render(input: RenderInput): Promise<HashedGeometryResult>;
  export(format: Format, input?: RenderInput): Promise<ExportResult>;

  // Capabilities helpers
  routesFor(format: Format): readonly ExportRoute[];
  bestRouteFor(format: Format, kernelId?: KernelId): ExportRoute | undefined;

  // Read-only state
  readonly capabilities: CapabilitiesManifest | undefined;
  readonly activeKernelId: KernelId | undefined;

  // Events
  on(event: 'geometry', handler: (result: HashedGeometryResult) => void): Unsubscribe;
  on(event: 'state', handler: (state: WorkerState, detail?: string) => void): Unsubscribe;
  on(event: 'error', handler: (issues: KernelIssue[]) => void): Unsubscribe;
  on(event: 'progress', handler: (phase: RenderPhase, detail?: Record<string, unknown>) => void): Unsubscribe;
  on(event: 'parametersResolved', handler: (result: GetParametersResult) => void): Unsubscribe;
  on(event: 'telemetry', handler: (entries: PerformanceEntryData[]) => void): Unsubscribe;
  on(event: 'log', handler: (entry: LogEntry) => void): Unsubscribe;
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest) => void): Unsubscribe;
  on(event: 'activeKernel', handler: (kernelId: KernelId | undefined) => void): Unsubscribe;
};

type RenderInput =
  | { file: string | GeometryFile; parameters?: Record<string, unknown>; options?: Record<string, unknown> }
  | {
      code: Record<string, string>;
      file?: string;
      parameters?: Record<string, unknown>;
      options?: Record<string, unknown>;
    };

type RuntimeTransport = {
  send(command: RuntimeCommand, transferables?: Transferable[]): void;
  onMessage(handler: (message: RuntimeResponse) => void): void;
  observeWorkerState(handler: (state: WorkerState, detail?: string) => void): Unsubscribe;
  signalAbort(reason: AbortReason): void;
  resolveGeometry(payload: GeometryTransport): Promise<Geometry>;
  describe(): TransportDescriptor;
  close(): void;
};

type TransportDescriptor = {
  readonly name: 'in-process' | 'worker' | 'websocket' | string;
  readonly locality: 'in-process' | 'worker' | 'remote';
  readonly sharedMemory: boolean;
  readonly latencyClass: 'sub-millisecond' | 'low' | 'high';
};
```

**Method count:** 9 public methods on `RuntimeClient` (`connect`, `terminate`, `render`, `export`, `routesFor`, `bestRouteFor`, `on`, plus the `capabilities` and `activeKernelId` getters). 9 event types. Down from today's 14 methods + 9 events.

`TransportDescriptor` is read-only and used for diagnostics only — never branched on.

## Should consumers see SAB? A transparency analysis

The question: should SAB-vs-fallback be **fully internalised** to the client (consumer-transparent) or should the consumer make the choice themselves?

**Answer: fully internalised, with a narrow opt-in for advanced cases.**

| Decision axis                      | Internalise                                   | Expose                           |
| ---------------------------------- | --------------------------------------------- | -------------------------------- |
| Consumer code complexity           | ✓ Single API surface                          | ✗ Branching code per environment |
| Future-proofing for new transports | ✓ Add transport, no consumer change           | ✗ Every consumer must update     |
| Testability                        | ⚠ Need force-degrade hook for tests           | ✓ Tests can pick mode            |
| Diagnostics / observability        | ⚠ Need readonly descriptor accessor           | ✓ Trivial                        |
| Performance tuning by consumer     | ⚠ Consumer can swap transport at construction | ✓ Direct knob                    |

The rule that resolves this:

- **Control flow**: never branch on transport mode. Internalise.
- **Diagnostics**: expose `transport.describe()` for telemetry, debug overlays, and "why is my geometry slow?" investigations.
- **Tuning**: consumers express preference by constructing the transport they want (`createInProcessTransport({ shared: false })` to force degradation in tests) — not by calling a runtime knob on the client.

This mirrors the philosophy of `fetch` (transport details are properties of the request/response, not knobs on consumers) and Three.js renderers (consumers choose the renderer at construction; rendering code is renderer-agnostic).

The CLI is a clean test of the rule: `taucad export` works in Node where `crossOriginIsolated` is irrelevant, in a browser where it might be true or false, and (future) over a WebSocket to a remote runtime worker. The CLI source code never references SAB. v3 preserves that property for every consumer.

## Recommendations

| #   | Action                                                                                                                                                                                                                            | Priority | Effort | Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add the behavior-complete methods to `RuntimeTransport`: `observeWorkerState`, `signalAbort`, `resolveGeometry`, `describe`. Implement in `createInProcessTransport` and `createWorkerTransport`.                                 | P0       | Medium | High   |
| R2  | Move SAB pool ownership and SAB monitor logic from `RuntimeClient` and `RuntimeWorkerClient` into the transport implementations. The runtime client reads zero `signalView`/`crossOriginIsolated`/`SharedArrayBuffer` references. | P0       | Medium | High   |
| R3  | Drop the v2 `TransportCapabilities` flag struct. `transport.describe()` returns a diagnostic-only descriptor; nothing in the client branches on it.                                                                               | P0       | Low    | High   |
| R4  | Make `client.render(input)` Promise-coalesced and re-callable with supersede semantics. The first call kicks off rendering and the autonomous file-watch loop; subsequent calls supersede and update.                             | P0       | Medium | High   |
| R5  | Remove `setFile`, `setParameters`, `notifyFileChanged`, `cancelPendingRender`, `setRenderTimeout`, `geometryPool` from `RuntimeClient`. Migrate all consumer call sites to `render(input)`.                                       | P0       | Medium | High   |
| R6  | Inline `render({ code })` absorbs `notifyFileChanged` internally via a private `setFiles({ files })` operation. Add a tagged `__test__invalidate(paths)` escape hatch for tests that mutate an unbridged FS.                      | P0       | Medium | Medium |
| R7  | Make all worker → main events flow through a single ordered `postMessage` channel. Drop the v2 proposal to gate `stateChanged` `postMessage` on `!sabPresent`; state events always come via `postMessage` regardless of SAB.      | P0       | Medium | High   |
| R8  | Shrink the SAB layout to `abortGeneration` and `abortReason` only (both main → worker, both internal-only). Remove `signalSlot.workerState` and `signalSlot.progressPercent`. Mark `cooperative-abort.ts` `@internal`.            | P0       | Medium | Medium |
| R9  | Document the per-render event lifecycle contract: `state:rendering → progress* → parametersResolved? → (geometry \| error) → state:idle`. Add lifecycle-ordering tests.                                                           | P0       | Low    | Medium |
| R10 | Make `client.connect()` fully lazy. Auto-connect on first `render()` or `export()`. Keep an explicit `connect()` method as an opt-in pre-warm (returns the same Promise the first render would have awaited).                     | P1       | Low    | Medium |
| R11 | Update `cad.machine.ts` `connectKernelActor` to drive renders via `await client.render({ file, parameters, options })`. Replace event-stream "settled" detection with the Promise return.                                         | P0       | Medium | High   |
| R12 | Update `apps/ui/app/hooks/rpc-handlers.ts` to call `await ensureGeometryUnit(file).client.render(input)` directly. Delete the bespoke "fresh render" helper.                                                                      | P0       | Low    | High   |
| R13 | Add wire-format `{ type: 'abort', requestId }` command for transports without SAB. Worker handler increments local `renderGeneration` from the message.                                                                           | P1       | Medium | Medium |
| R14 | Pre-stub `createWebSocketTransport(url)` implementing the new behavior-complete transport interface, with `send`/`signalAbort` throwing "not implemented" — validates the abstraction.                                            | P2       | Low    | Medium |
| R15 | Library-API-policy compliance pass on the reduced surface (R1–R14): symmetric Promise return types, no `void` setters, no leaking SAB internals.                                                                                  | P1       | Low    | Medium |
| R16 | Migration guide for downstream consumers. Breaking changes: `setFile`/`setParameters`/`notifyFileChanged`/`cancelPendingRender`/`setRenderTimeout`/`geometryPool` removed; consumers move to `client.render(input)`.              | P2       | Low    | Low    |

**Dropped from v2 and the prior v3:**

- ~~v2 R1: `latestGeneration` SAB slot~~ — generations stay internal.
- ~~v2 R2: generation field on `RuntimeResponse`~~ — Promise correlation replaces it.
- ~~v2 R3: `setFile`/`setParameters` return generation number~~ — they don't exist anymore.
- ~~v2 R4: `whenSettled(generation)` primitive~~ — Promise return on `render()` is the settled signal.
- ~~v2 R5: gate `stateChanged` `postMessage` on `!sabPresent`~~ — inverted; always `postMessage`.
- ~~Prior v3: `RenderSession` type~~ — the client itself is the render context (one client per pane).
- ~~Prior v3: `client.watch(input)` method~~ — collapsed into re-callable `render(input)`.
- ~~Prior v3: per-session event scoping~~ — events stay on the client.
- ~~v2 `TransportCapabilities` flag struct~~ — replaced by behavior-complete transport.

## Trade-offs vs v1, v2, and the prior v3 draft

| Dimension                           | v1                                                | v2                                                                 | Prior v3 (session model)                            | v3 (this doc)                                                                                 |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Public concepts consumers learn     | Generation, settled-generation, whenSettled       | Promise + transport.capabilities flags                             | Session, session.update, session.dispose            | Just `Promise<T>` + `client.on(...)`                                                          |
| Client method count                 | 14                                                | 13                                                                 | 10 client + 4 session                               | 9 client                                                                                      |
| Public type count                   | 1 (`RuntimeClient`)                               | 1 (`RuntimeClient`) + `TransportCapabilities`                      | 2 (`RuntimeClient` + `RenderSession`)               | 1 (`RuntimeClient`); `TransportDescriptor` is internal-API-readable but not consumer-branched |
| Abort/cancel API                    | `cancelPendingRender`                             | Promise rejection on supersede                                     | `session.dispose`                                   | Implicit via `render()` re-call; explicit via `terminate()`                                   |
| Per-pane isolation                  | Implicit (client per pane)                        | Implicit (client per pane)                                         | Explicit (session) — over-engineered                | Explicit (client per pane) — matches reality                                                  |
| SAB visibility to consumer          | High (latestGeneration slot, generation field)    | Medium (`transport.capabilities.sharedMemory` flag)                | Low (transport behavior-complete, no flags)         | None                                                                                          |
| Cross-channel ordering              | Not addressed                                     | Half-addressed (gates `stateChanged` postMessage on `!sabPresent`) | Single ordered channel via postMessage              | Single ordered channel via postMessage (same as prior v3)                                     |
| Survives a remote transport         | No (SAB-shaped APIs)                              | Partially (capability null-shape)                                  | Yes                                                 | Yes                                                                                           |
| Consumer migration cost (UI)        | Moderate (every event handler learns generations) | Low (`void` callers add `await` for safety)                        | High (`setFile`/`setParameters` → `session.update`) | Low (`setFile`/`setParameters` → `client.render`)                                             |
| Consumer migration cost (CLI/tests) | Low (no event handlers in those contexts)         | Low                                                                | Low                                                 | Low (no change for CLI; minor for benchmark)                                                  |

v3 picks the **right level of abstraction** by anchoring on the architectural invariant (one client per pane) instead of inventing a redundant scope.

## Migration Path

Five stages, each independently mergeable, no flag day.

### Stage 1: Behavior-complete transport (R1, R2, R3)

- Define new methods on `RuntimeTransport`: `observeWorkerState`, `signalAbort`, `resolveGeometry`, `describe`.
- Move SAB allocation and monitoring from `RuntimeClient` / `RuntimeWorkerClient` into `createInProcessTransport` / `createWorkerTransport`.
- The runtime client reads zero `signalView`/`crossOriginIsolated`/`SharedArrayBuffer` references after this stage.
- Tests assert each transport's `describe()` reports correctly and that the client still functions identically.

No consumer-visible behavior change. Pure refactor.

### Stage 2: Single ordered event channel (R7, R8)

- Worker sends all events via `postMessage` (no SAB writes for `workerState`/`progressPercent`).
- Main thread subscribes to events via `transport.observeWorkerState` (transport implementation drains messages in order) instead of running a separate SAB monitor.
- SAB layout shrinks to `abortGeneration` + `abortReason` only.
- Tests assert event ordering: `state:rendering → progress* → parametersResolved? → (geometry | error) → state:idle`.

Behavior change: tests that assumed cross-channel race semantics will start passing deterministically. No consumer code changes required.

### Stage 3: Promise-coalesced re-callable render (R4, R6, R10, R13)

- `client.render(input)` returns `Promise<HashedGeometryResult>`.
- Re-callable: each call supersedes the previous, rejecting the previous Promise with `RenderSupersededError`.
- `client.connect()` becomes fully lazy.
- Inline `render({ code })` writes through internal `setFiles` (no public `notifyFileChanged`).
- Worker handles `{ type: 'abort', requestId }` wire-format command for non-SAB transports.

Consumer-visible behavior change: `render()` now also drives the autonomous file-watch loop. `setFile`/`setParameters` still exist (deprecated) and delegate to `render()` internally.

### Stage 4: Consumer migration (R11, R12)

- Update `cad.machine.ts` `connectKernelActor` to call `await client.render({ file, parameters, options })`.
- Update `rpc-handlers.ts` to call `await cadUnit.client.render(input)` directly.
- Delete bespoke "settled" detection helpers in UI code.
- All consumer call sites use `render()`; no remaining call sites for `setFile`/`setParameters`.

### Stage 5: Public surface removal (R5, R14, R15, R16)

- Remove `setFile`, `setParameters`, `notifyFileChanged`, `cancelPendingRender`, `setRenderTimeout`, `geometryPool` from `RuntimeClient` types and runtime.
- Pre-stub `createWebSocketTransport(url)` to validate the abstraction holds.
- Library-API-policy compliance pass.
- Publish migration guide.

After Stage 5, the runtime client has no public API surface that mentions SAB, generations, requestIds, or transport mode. A future WebSocket transport implementation is purely a Layer 1 + Layer 2 task.

## Code Examples

### Before (today, UI live preview via cad.machine)

```typescript
const client = createRuntimeClient(kernelOptions);

cleanups.push(
  client.on('geometry', (result) => machineRef.send({ type: 'geometryComputed', ... })),
  client.on('state', (state) => machineRef.send({ type: 'stateChanged', state })),
  client.on('progress', (phase) => machineRef.send({ type: 'kernelProgress', phase })),
  // … many more event subscriptions …
);

// Elsewhere in the machine:
client.setFile(file, parameters, options);  // void, no completion signal
client.setParameters(newParameters);        // void, no completion signal
```

### After (v3, UI live preview via cad.machine)

```typescript
const client = createRuntimeClient(kernelOptions);

cleanups.push(
  client.on('geometry', (result) => machineRef.send({ type: 'geometryComputed', ... })),
  client.on('state', (state) => machineRef.send({ type: 'stateChanged', state })),
  client.on('progress', (phase) => machineRef.send({ type: 'kernelProgress', phase })),
  // … same event subscriptions, no change …
);

// Elsewhere in the machine:
const result = await client.render({ file, parameters, options });
// Promise resolves with first geometry; subsequent file-change-driven renders fire events.

// Update parameters:
const next = await client.render({ file, parameters: newParameters, options });
// Previous Promise (if still pending) rejected with RenderSupersededError.
```

### Before (today, UI agent RPC handler)

```typescript
const cadUnit = await ensureGeometryUnit(targetFile);
const initialState = cadUnit.getSnapshot();
if (initialState.value !== 'rendering') {
  cadUnit.send({ type: 'setFile', file: targetFile });
}
const settled = await waitFor(cadUnit, (state) => state.value === 'idle' || state.value === 'error');
if (settled.value === 'error') {
  return failure(settled.context.lastError);
}
return success(settled.context.geometry);
```

### After (v3, UI agent RPC handler)

```typescript
const cadUnit = await ensureGeometryUnit(targetFile);
try {
  const result = await cadUnit.client.render({
    file: targetFile,
    parameters: cadUnit.getSnapshot().context.parameters,
  });
  return success(result);
} catch (error) {
  if (error instanceof RenderSupersededError) {
    return failure({ code: 'SUPERSEDED' });
  }
  return failure(toFailure(error));
}
```

### CLI (unchanged from today)

```typescript
const client = await createNodeClient(projectPath);
client.on('log', (entry) => consola[entry.level](entry.message));
const result = await client.export(format, { file: inputFilename, parameters });
client.terminate();
```

The CLI source code is byte-identical to today's. v3 changes nothing for the one-shot path.

### Capability-driven internal branching (Layer 3, before)

```typescript
const monitor = transport.capabilities.sharedMemory
  ? createSabStateMonitor(this.signalView)
  : createMessageStateMonitor(this.transport);
monitor.on('state', (state) => this.handleStateChange(state));
```

### Capability-driven internal branching (Layer 3, after)

```typescript
const off = transport.observeWorkerState((state) => this.handleStateChange(state));
// Transport chose internally between SAB-monitor and message-routing.
// Client never branched. Cleanup via off().
```

## Diagrams

### Current architecture (with cross-channel race)

```
┌─────────────────┐         ┌──────────────┐
│  Consumer       │         │  Consumer    │
│  (live preview) │         │  (one-shot)  │
└────────┬────────┘         └──────┬───────┘
         │ on('geometry')          │ await render()
         │ on('state')             │
         │ setFile (void)          │
         ▼                         ▼
┌─────────────────────────────────────────┐
│  RuntimeClient                          │
│  ├ pendingRender (Promise)              │
│  ├ pendingExport (Promise)              │
│  ├ setFile/setParameters → void         │
│  ├ try/catch SAB allocation             │
│  └ try/catch crossOriginIsolated probe  │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  RuntimeTransport (no behavior contract)│
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  Worker                                 │
│  ├ executeRender + renderGeneration     │
│  ├ pushState → SAB AND postMessage      │  ← dual delivery
│  └ onGeometryComputed (autonomous)      │
└─────────────────────────────────────────┘
         │   │
   SAB ──┘   └── postMessage
         │   │
         ▼   ▼
   ┌─────────────┐
   │ Main thread │  ← receives state via SAB monitor and
   │ event loop  │    geometry via postMessage; no ordering
   └─────────────┘    guarantee between them
```

### v3 target architecture (single ordered channel, behavior-complete transport)

```
┌─────────────────────────────────────────┐
│  Consumer (one client per pane)         │
│  await client.render(...)               │
│  await client.export(...)               │
│  client.on('geometry' | 'state' | ...)  │
└────────────────┬────────────────────────┘
                 │ ── No SAB / generations / requestIds visible ──
                 ▼
┌─────────────────────────────────────────┐
│  RuntimeClient (Layer 3)                │
│  ├ pendingRender (Promise)              │
│  ├ pendingExport (Promise)              │
│  ├ render → Promise (re-callable)       │
│  ├ subscribes to transport.observeWorker│
│  │  State (single ordered channel)      │
│  └ no SAB references anywhere           │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  RuntimeTransport (Layer 2)             │
│  send / onMessage / observeWorkerState /│
│  signalAbort / resolveGeometry / describe│
│  ── Each implementation owns its SAB ──  │
│    in-process: SAB internal when COI    │
│    worker:     SAB internal when COI    │
│    websocket:  fully message-based      │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Wire protocol (Layer 1)                │
│  RuntimeCommand { requestId, ... }      │
│  RuntimeResponse { requestId | 'autonomous', ... } │
│  Optional Transferable[] when supported │
│  Geometry inline OR pool key when SAB   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  Worker                                 │
│  ├ executeRender + signalSlot.abortGen  │  ← internal abort flag only
│  ├ Each emission stamped with requestId │
│  └ All events via postMessage (single   │
│    ordered channel)                     │
└─────────────────────────────────────────┘
```

### Promise-coalesced render sequence (one pane, supersede)

```
Consumer        RuntimeClient         Worker
   │                  │                  │
   │ render(A)        │                  │
   ├─────────────────►│ requestId=1      │
   │                  ├─────────────────►│ render A (gen=1)
   │ render(B) ──┐    │                  │
   │             │    │ requestId=2      │
   │             └───►│  reject(P1, RenderSupersededError)
   │                  ├─────────────────►│ abortGen++ → 2; render B
   │                  │                  │
   │                  │       ◄──────────┤ {state:'rendering', requestId=2}
   │ ◄────────────────┤ on('state', 'rendering')
   │                  │       ◄──────────┤ {progress:0.3, requestId=2}
   │ ◄────────────────┤ on('progress', …)
   │                  │       ◄──────────┤ {parametersResolved, requestId=2}
   │ ◄────────────────┤ on('parametersResolved', …)
   │                  │       ◄──────────┤ {geometryComputed, requestId=2}
   │ ◄────────────────┤ resolve(P2, B-geometry)
   │                  │       ◄──────────┤ {state:'idle', requestId=2}
   │ ◄────────────────┤ on('state', 'idle')
   │                  │                  │
```

The `state:idle` event always arrives **after** `geometryComputed` for the same requestId, because both flow through the same `postMessage` channel in worker emit order.

### Multi-pane topology (the invariant)

```
┌──────────────────────────────────────────────────────────────────┐
│  Workspace                                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  File Manager Worker (shared across panes)                 │  │
│  │  • workspace filesystem                                    │  │
│  │  • broadcasts file change events to all bridges            │  │
│  └─────┬───────────────┬───────────────┬──────────────────────┘  │
│        │ MessagePort   │ MessagePort   │ MessagePort             │
│        ▼               ▼               ▼                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                    │
│  │ Pane A   │    │ Pane B   │    │ Pane C   │                    │
│  │ ┌──────┐ │    │ ┌──────┐ │    │ ┌──────┐ │                    │
│  │ │client│ │    │ │client│ │    │ │client│ │  ← createRuntimeClient │
│  │ └──┬───┘ │    │ └──┬───┘ │    │ └──┬───┘ │                    │
│  │    ▼     │    │    ▼     │    │    ▼     │                    │
│  │ ┌──────┐ │    │ ┌──────┐ │    │ ┌──────┐ │                    │
│  │ │worker│ │    │ │worker│ │    │ │worker│ │  ← kernel worker  │
│  │ │ A    │ │    │ │ B    │ │    │ │ C    │ │                    │
│  │ └──────┘ │    │ └──────┘ │    │ └──────┘ │                    │
│  └──────────┘    └──────────┘    └──────────┘                    │
│   /main.ts        /other.ts       /shared.ts                     │
└──────────────────────────────────────────────────────────────────┘
```

Edit `/main.ts` → only worker A re-renders. Edit `/shared.ts` → all three workers re-render (each independently). Cross-pane isolation is a property of this topology, not of any in-client abstraction.

## Appendix A: API Surface Audit Table

Status legend: ✓ keep, ⚠ refactor, ✗ remove, + add.

| Surface element                          | v3 status    | Rationale                                                                               |
| ---------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `client.render(input)`                   | ⚠            | Becomes Promise-coalesced and re-callable; supersede semantics                          |
| `client.export(format, input?)`          | ✓            | Already Promise-correlated; unchanged                                                   |
| `client.connect(options?)`               | ⚠            | Becomes fully lazy; explicit call survives as opt-in pre-warm                           |
| `client.terminate()`                     | ✓            | Lifecycle; unchanged                                                                    |
| `client.setFile(file, params, opts)`     | ✗            | Collapsed into `render({ file, parameters, options })`                                  |
| `client.setParameters(params)`           | ✗            | Collapsed into `render({ file: lastFile, parameters: newParams })`                      |
| `client.notifyFileChanged(paths)`        | ✗            | Redundant in filesystem mode; absorbed by inline `render({ code })` private helper      |
| `client.cancelPendingRender()`           | ✗            | Subsumed by render supersession via re-callable `render()`                              |
| `client.setRenderTimeout(seconds)`       | ✗            | Duplicates `RuntimeClientOptions.renderTimeout`                                         |
| `client.geometryPool`                    | ✗            | Leaks SAB internals; pool moves into transport                                          |
| `client.routesFor(format)`               | ✓            | Capabilities-derived helper; unchanged                                                  |
| `client.bestRouteFor(format, kernelId?)` | ✓            | Capabilities-derived helper; unchanged                                                  |
| `client.capabilities` (getter)           | ✓            | Kernel/transcoder capabilities; unchanged                                               |
| `client.activeKernelId` (getter)         | ✓            | Active kernel identifier; unchanged                                                     |
| `client.on('geometry')`                  | ✓            | Live-preview consumers want "latest"; unchanged                                         |
| `client.on('state')`                     | ✓            | Diagnostics; ordering now guaranteed                                                    |
| `client.on('error')`                     | ✓            | Per-render errors                                                                       |
| `client.on('progress')`                  | ✓            | Per-render progress; ordering now guaranteed                                            |
| `client.on('parametersResolved')`        | ✓            | Per-render parameter extraction                                                         |
| `client.on('telemetry')`                 | ✓            | Used by benchmark runner                                                                |
| `client.on('log')`                       | ✓            | Used by CLI and UI                                                                      |
| `client.on('capabilities')`              | ✓            | Capabilities manifest pushes                                                            |
| `client.on('activeKernel')`              | ✓            | Active kernel changes                                                                   |
| `RuntimeCommand.requestId`               | ⚠            | Made mandatory on every command (string)                                                |
| `RuntimeResponse.requestId`              | ⚠            | Either a string for correlated responses or `'autonomous'`                              |
| `RuntimeCommand: 'render'`               | ⚠            | Becomes a wire-level command derived from `client.render(input)`; no longer "the" entry |
| `RuntimeCommand: 'cancel'`               | ✗            | Replaced by render supersession                                                         |
| `RuntimeCommand: 'fileChanged'`          | ✗            | Removed; inline path uses `setFiles`                                                    |
| `RuntimeCommand: 'setFiles'`             | + (private)  | Inline `render({ code })` writes-then-renders atomically                                |
| `RuntimeCommand: 'abort'`                | +            | `{ requestId }`. Wire-format fallback for transports without SAB                        |
| `RuntimeCommand: 'setFile'`              | ✗            | Subsumed by `render`                                                                    |
| `RuntimeCommand: 'setParameters'`        | ✗            | Subsumed by `render`                                                                    |
| `signalSlot.abortGeneration`             | ✓ (internal) | `@internal`. Stays SAB-only. Internal cooperative abort flag                            |
| `signalSlot.abortReason`                 | ✓ (internal) | `@internal`. Implementation-coupled to abort                                            |
| `signalSlot.workerState`                 | ✗            | Removed; state events flow via `postMessage` only                                       |
| `signalSlot.progressPercent`             | ✗            | Removed; progress events flow via `postMessage` only                                    |
| `signalSlot.latestGeneration` (was v1)   | ✗            | Not introduced                                                                          |
| `RuntimeTransport.send`                  | ✓            | Unchanged                                                                               |
| `RuntimeTransport.onMessage`             | ✓            | Unchanged                                                                               |
| `RuntimeTransport.close`                 | ✓            | Unchanged                                                                               |
| `RuntimeTransport.observeWorkerState`    | +            | Behavior-complete API; replaces SAB-monitor in client                                   |
| `RuntimeTransport.signalAbort`           | +            | Behavior-complete API; replaces `incrementAbortGeneration` in client                    |
| `RuntimeTransport.resolveGeometry`       | +            | Behavior-complete API; replaces `resolveTransportResult` in client                      |
| `RuntimeTransport.describe`              | +            | Diagnostic-only descriptor; not for control flow                                        |
| `RuntimeTransport.capabilities`          | ✗            | Was v2 proposal; replaced by behavior-complete methods                                  |
| `TransportCapabilities` type             | ✗            | Was v2 proposal; replaced by `TransportDescriptor` (read-only, diagnostic)              |
| `TransportDescriptor` type               | +            | `{ name, locality, sharedMemory, latencyClass }` — diagnostic only                      |
| `createInProcessTransport`               | ⚠            | Implements behavior-complete interface; owns SAB internally                             |
| `createWorkerTransport`                  | ⚠            | Implements behavior-complete interface; owns SAB internally                             |
| `createWebSocketTransport`               | + (stub)     | R14. Implements behavior-complete interface; pre-stub validates the abstraction         |
| `inspectCrossOriginIsolation()`          | ✓            | Stays as a global probe; consumed by `createInProcessTransport`/`createWorkerTransport` |
| `cooperative-abort.ts` exports           | ⚠ (internal) | `@internal`. Not part of the public package surface                                     |

## Appendix B: Per-Render Event Lifecycle Contract

For a single `render(input)` call:

```
1. state: 'rendering'                       (must be first)
2. progress (0..N times, monotonic percent) (zero or more)
3. parametersResolved                       (zero or one)
4. geometry  XOR  error                     (exactly one)
5. state: 'idle'                            (must be last)
```

Promise resolution semantics:

- Step 4 with `geometry` → Promise resolves with that result.
- Step 4 with `error` → Promise rejects with the error (`RenderTimeoutError` / `RenderAbortedError` for the timeout/abort cases).
- A new `render()` call before step 4 → previous Promise rejects with `RenderSupersededError`. The new render starts its own lifecycle from step 1.

For an autonomous re-render triggered by a file watch (no pending Promise):

- Same lifecycle (steps 1–5), but step 4 does not resolve any Promise — the `geometry`/`error` event fires for subscribers and the cycle continues.

Cross-render ordering:

- `state: 'idle'` from render N is always observed before `state: 'rendering'` from render N+1.
- Events for render N and render N+1 never interleave (single ordered channel).

Tests should assert these orderings at the message level (`transport.onMessage` log) and at the consumer level (`client.on(...)` arrival order).

## Appendix C: Inheritance and corrections from v1, v2, and the prior v3

**Inherited unchanged from v2:**

- Generations are an internal cooperative-abort primitive (v2 F1 → v3 F2).
- `notifyFileChanged` is redundant in filesystem mode (v2 F8 → v3 F8).
- `cancelPendingRender` is a leak from the legacy request/response era (v2 F10 → v3 F11).
- A WebSocket transport breaks SAB-flavoured public APIs (v2 F7 → v3 F14).
- Wire-format `{ type: 'abort', requestId }` for non-SAB transports (v2 R8 → v3 R13).
- Pre-stub `createWebSocketTransport` to validate the abstraction (v2 R13 → v3 R14).

**Inherited from v2 with refinement:**

- v2 F4 (Setter API missing request-correlation handles) → v3 F4 (setFile/setParameters are not setters; collapsed into `render(input)`).
- v2 F5 (Events lack generation tags) → v3 F6 (Events have no cross-channel ordering guarantee). The fix is single-channel ordering, not generation tagging.
- v2 F9 (Dual state delivery when SAB is present) → v3 F6/F7 (single-channel postMessage; SAB shrinks to internal abort).

**Inherited from v1 unchanged:**

- The bridge watch chain is the autonomous render mechanism (v1 F1).

**Dropped from v1 (already dropped in v2):**

- v1 R1 `latestGeneration` SAB slot.
- v1 R2 `generation` field on `RuntimeResponse`.
- v1 R3 `setFile`/`setParameters` return generation number.
- v1 R4 `whenSettled(generation)` primitive.

**Dropped from v2:**

- v2 R5 (gate `stateChanged` postMessage on `!sabPresent`) — inverted; state always flows through postMessage regardless of SAB presence. v3 F6/R7.
- v2 `TransportCapabilities` flag struct — replaced by behavior-complete `RuntimeTransport`. v3 F5/R1/R3.

**Dropped from the prior v3 (this revision corrects):**

- Prior v3 `RenderSession` type — eliminated. The client itself is the render context (one client per pane). v3 F1.
- Prior v3 `client.watch(input)` method — collapsed into re-callable `client.render(input)`. v3 F3/R4.
- Prior v3 per-session event scoping — events stay on the client. v3 F1.
- Prior v3 `session.update(partial)` / `session.dispose()` / `session.on(...)` — all replaced by methods that already exist or are added on `RuntimeClient`. v3 F1/F3/R4/R5.
- Prior v3 multi-pane-isolation rationale for sessions — invalidated by the one-client-per-pane invariant. v3 F1.

## References

- v1 of this blueprint: `docs/research/runtime-event-driven-api-blueprint.md` (superseded; carry-over findings noted in Appendix C).
- v2 of this blueprint: `docs/research/runtime-event-driven-api-blueprint-v2.md` (superseded by v3; carry-over findings noted in Appendix C).
- [Library API Policy](../policy/library-api-policy.md) — §1 (factory functions), §3 (flat options), §4 (parameter design), §5 (naming), §7 (subscribe-anytime events), §10 (high-level wrappers), §11 (no optional interface methods), §17 (options merge tiers).
- [Runtime Architecture Policy](../policy/runtime-architecture-policy.md) — current transport list and forward-looking transport plans.
- [Runtime Topology](../architecture/runtime-topology.md) — target render pipeline (autonomous worker, bridge watch).
- [CLI Runtime Ergonomics](cli-runtime-ergonomics.md) — `createNodeClient`, `FileInput` shape, multi-file bundling.
- [Safari Cross-Origin Isolation](safari-cross-origin-isolation.md) — when SAB is and is not available; consumed by `inspectCrossOriginIsolation`.
- [Capabilities Manifest API Audit](capabilities-manifest-api-audit.md) — orthogonal capability surface (kernels/transcoders), not transport.
- [Lazy Capabilities Manifest](lazy-capabilities-manifest.md) — manifest evolution after kernel load; orthogonal to transport capabilities.
- [Shared-Memory Geometry Pipeline](shared-memory-geometry-pipeline.md) — pool-based geometry transfer when SAB is available; encapsulated by `transport.resolveGeometry`.
- [Runtime Client Type Safety Audit](runtime-client-type-safety-audit.md) — generic inference for kernel/transcoder formats; orthogonal to this work.
