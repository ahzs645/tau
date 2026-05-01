---
title: 'Runtime Event-Driven API Blueprint v2'
description: 'Revised target architecture for @taucad/runtime: generations as internal-only abort primitive, Promise-coalesced commands as the public correlation surface, and transport-declared capabilities for centralised graceful degradation.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/policy/runtime-architecture-policy.md
  - docs/architecture/runtime-topology.md
  - docs/research/runtime-event-driven-api-blueprint.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/capabilities-manifest-api-audit.md
  - docs/research/runtime-client-type-safety-audit.md
  - docs/research/cli-runtime-ergonomics.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/lazy-capabilities-manifest.md
---

# Runtime Event-Driven API Blueprint v2

Revisits v1 by questioning whether "render generations" belong on the public `@taucad/runtime` surface at all, surveys every non-UI consumer, and proposes a Promise-coalesced command surface backed by capability-declaring transports so the same client works locally over `MessageChannel` today and remotely over `WebSocket` tomorrow without consumer changes.

## Executive Summary

v1 proposed promoting render generations to a first-class public concept: a `latestGeneration` SAB slot, a `generation` field on every `RuntimeResponse`, generation-returning setters, and a `whenSettled(generation)` primitive. A second-pass audit shows that promotion is the wrong shape. Generations exist for one job — letting cooperative abort code inside WASM read a `SharedArrayBuffer` slot and bail — and that job is purely internal. Every consumer-facing correlation problem the runtime has (UI agent RPCs, CLI exports, benchmark harness, API tests) is a request → settled question, not an event → request question, and the request → settled question is what `Promise<T>` was invented for. The runtime already proves this with `client.render()` and `client.export()`; the only reason `setFile`/`setParameters`/`notifyFileChanged` are `void` is historical.

The recommended target state collapses the public API to:

1. **Promise-coalesced commands** — `setFile`/`setParameters` return `Promise<HashedGeometryResultTransport>` that resolve when the coalesced render settles, reject with `RenderSupersededError` when overtaken, and reject with the same `RenderTimeoutError`/`RenderAbortedError` shapes that `render()` already produces.
2. **Internal-only generations** — `signalSlot.abortGeneration` stays exactly where it is, scoped to `cooperative-abort.ts` and `KernelWorker.executeRender`. No new SAB slots, no `generation` field on responses.
3. **Transport-declared capabilities** — `RuntimeTransport` grows a `capabilities: TransportCapabilities` field describing `{ sharedMemory, transferables, locality, backpressure }`. The client uses it to pick the best signalling path internally; consumers never branch on `crossOriginIsolated`.
4. **Wire-format that survives WebSocket** — `RuntimeCommand`/`RuntimeResponse` stay JSON-serialisable plus optional `Transferable[]`. The four current SAB slots (abort, state, reason, progress) get a parallel **message-based fallback channel** so a transport without `sharedMemory: true` works correctly with no consumer changes.
5. **Removal of `notifyFileChanged` from the public surface** — production filesystem mode already gets autonomous renders from the bridge watch; inline `render({ code })` absorbs its private equivalent internally; tests get a tagged `__test__invalidate(paths)` escape hatch.

Generations as a public concept are deleted from the plan. The Promise contract subsumes them. The five recommendations above replace v1's R1–R15.

## Table of Contents

- [Scope and Non-Goals](#scope-and-non-goals)
- [Methodology](#methodology)
- [Consumer Surface Survey](#consumer-surface-survey)
- [Findings](#findings)
  - [Finding 1: Generations are an internal cooperative-abort primitive, not a correlation primitive](#finding-1-generations-are-an-internal-cooperative-abort-primitive-not-a-correlation-primitive)
  - [Finding 2: Every non-UI consumer already uses Promise-correlated commands](#finding-2-every-non-ui-consumer-already-uses-promise-correlated-commands)
  - [Finding 3: The UI's "settled" question is solved at the state-machine layer, not the event layer](#finding-3-the-uis-settled-question-is-solved-at-the-state-machine-layer-not-the-event-layer)
  - [Finding 4: setFile/setParameters are void only for historical reasons](#finding-4-setfilesetparameters-are-void-only-for-historical-reasons)
  - [Finding 5: SAB capability detection is scattered across try/catch islands](#finding-5-sab-capability-detection-is-scattered-across-trycatch-islands)
  - [Finding 6: Transport interface lacks capability declaration](#finding-6-transport-interface-lacks-capability-declaration)
  - [Finding 7: A WebSocket transport breaks SAB-flavoured public APIs](#finding-7-a-websocket-transport-breaks-sab-flavoured-public-apis)
  - [Finding 8: notifyFileChanged is redundant in filesystem mode (carried from v1)](#finding-8-notifyfilechanged-is-redundant-in-filesystem-mode-carried-from-v1)
  - [Finding 9: Dual state delivery when SAB is present (carried from v1)](#finding-9-dual-state-delivery-when-sab-is-present-carried-from-v1)
  - [Finding 10: cancelPendingRender is a leak from the legacy request/response era (carried from v1)](#finding-10-cancelpendingrender-is-a-leak-from-the-legacy-requestresponse-era-carried-from-v1)
- [Target Architecture](#target-architecture)
- [Should the consumer see SAB? A transparency analysis](#should-the-consumer-see-sab-a-transparency-analysis)
- [Recommendations](#recommendations)
- [Trade-offs vs v1](#trade-offs-vs-v1)
- [Migration Path](#migration-path)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Appendix: API Surface Audit Table](#appendix-api-surface-audit-table)

## Scope and Non-Goals

**In scope:**

- Public API surface of `@taucad/runtime` (`createRuntimeClient`, `RuntimeClient` methods and events).
- Internal command/response protocol (`RuntimeCommand`, `RuntimeResponse`).
- `RuntimeTransport` capability negotiation and graceful degradation strategy.
- Wire-format requirements for a future WebSocket / HTTP+SSE / gRPC transport.
- Compliance with [Library API Policy](../policy/library-api-policy.md) §1, §5, §7, §10, §11.

**Out of scope:**

- Plugin authoring contracts (`defineKernel`, `defineMiddleware`, `defineBundler`, `defineTranscoder`).
- Kernel-internal cache invalidation algorithms — covered by [runtime-topology.md](../architecture/runtime-topology.md).
- Type-level audits — covered by [runtime-client-type-safety-audit.md](runtime-client-type-safety-audit.md).
- Capabilities manifest contents (kernels, transcoders, formats) — covered by [capabilities-manifest-api-audit.md](capabilities-manifest-api-audit.md). This document covers only the orthogonal **transport** capability surface.

## Methodology

1. **Read every consumer of `createRuntimeClient` / `createNodeClient`** across the monorepo: CLI (`packages/cli/`), benchmark runner (`packages/runtime/src/benchmarks/`), API server (`apps/api/`), testing helpers (`packages/testing/`), UI machines (`apps/ui/app/machines/`).
2. **Catalogued every site that touches `renderGeneration` / `abortGeneration` / `signalSlot.*`** to confirm the role of generations is purely abort signalling.
3. **Catalogued every site that needs request → response correlation** (`waitFor`, `pendingRender`, `client.on('geometry', resolve)`).
4. **Read v1 of this blueprint end-to-end**, plus the cross-referenced research docs (`shared-memory-geometry-pipeline`, `capabilities-manifest-api-audit`, `runtime-client-type-safety-audit`, `cli-runtime-ergonomics`, `safari-cross-origin-isolation`, `lazy-capabilities-manifest`).
5. **Mapped the SAB-shaped APIs to a hypothetical WebSocket transport** to test whether each public surface survives the transport boundary.

## Consumer Surface Survey

Every consumer of the runtime, the mode they use, and the correlation primitive they rely on today.

| Consumer                                         | Entry point            | Transport    | Promise-style commands                           | Streaming events                                               | Correlation needed                                       |
| ------------------------------------------------ | ---------------------- | ------------ | ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------- |
| CLI `taucad export`                              | `createNodeClient`     | `in-process` | `client.export(format, input)`                   | `'log'` only                                                   | None beyond `await`                                      |
| CLI `taucad render` (future)                     | `createNodeClient`     | `in-process` | `client.render({ file, params })`                | `'log'`, `'progress'`                                          | None beyond `await`                                      |
| Runtime benchmark runner                         | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | `'telemetry'`                                                  | None beyond `await`                                      |
| API benchmarks (`model-benchmark-geometry.ts`)   | `createRuntimeClient`  | `in-process` | `client.render({ code, file })`                  | None                                                           | None beyond `await`                                      |
| `packages/testing` (`analyze-glb.test.ts`, etc.) | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | None                                                           | None beyond `await`                                      |
| Kernel integration tests                         | `createRuntimeClient`  | `in-process` | `client.render(...)`                             | One-shot `client.on('geometry', resolve)` to test setFile path | First-event-after-setFile (race-prone)                   |
| UI live preview (`cad.machine.ts`)               | `createRuntimeClient`  | `worker`     | `client.setFile`/`setParameters` (today: `void`) | `'geometry'`, `'kernelIssue'`, `'state'`                       | "Has the worker settled to reflect what I asked for?"    |
| UI agent RPCs (`rpc-handlers.ts`)                | (uses `cadUnit` actor) | `worker`     | None directly                                    | None directly                                                  | "Wait for `state.value === 'idle'`" via XState `waitFor` |

**Key observation:** every Promise-style consumer already gets fully correlated `await` semantics today. The only consumers that face a "settled" question are the UI live preview and (transitively) UI agent RPCs, and for them the question lives at the **state-machine layer**, not the event layer. The state machine needs a reliable settled signal — it does not need to know which event corresponds to which `setFile` call.

Source data:

- CLI: `packages/cli/src/commands/export.ts:72-101` — `await client.export(format, { file, parameters })`.
- Benchmark: `packages/runtime/src/benchmarks/benchmark-runner.ts:196-262` — `client.on('telemetry', …)` + `await client.render(…)`.
- API benchmarks: `apps/api/app/benchmarks/model-benchmark-geometry.ts` — `await client.render({ code, file })`.
- Testing: `packages/testing/src/geometry/analyze-glb.test.ts:9-28` — `await client.render({ code, file })`.
- UI: `apps/ui/app/machines/cad.machine.ts:126-140` — `client.on('geometry', …)` forwards to XState event queue with no per-event correlation.
- UI RPC: `apps/ui/app/hooks/rpc-handlers.ts:223` — `waitFor(cadUnit, state => state.value === 'idle' || state.value === 'error')`.

## Findings

### Finding 1: Generations are an internal cooperative-abort primitive, not a correlation primitive

`signalSlot.abortGeneration` exists for exactly one reason: long-running C++ code inside Replicad/OCCT/Manifold needs a way to be told "stop, your work is obsolete" without crossing back to JavaScript. The mechanism is:

1. Main thread (or worker) `Atomics.add(view, signalSlot.abortGeneration, 1)`.
2. WASM-side iteration polls a generation snapshot through `cooperative-abort.ts`'s `checkAbort()` (`packages/runtime/src/framework/cooperative-abort.ts:20-47`).
3. When the polled value diverges from the snapshot captured at render start, `checkAbort()` throws `RenderAbortedError`, unwinding the WASM call.

That's the entire role. The dispatcher never reads it. The capabilities manifest never reads it. No `geometryComputed` payload carries it. No public method returns it. Even inside the worker, the local `renderGeneration` field exists only as a **non-SAB fallback** for the same abort role (`kernel-worker.ts:385`, `1599-1604`).

v1 proposed promoting this counter to a public correlation primitive by stamping every `RuntimeResponse` with it and exposing `client.lastRequestedGeneration`. That conflates two unrelated concepts: **abort signalling** (a cooperative-cancellation mechanism that needs SAB-cheap polling to be useful) and **request-response correlation** (a protocol concept that should work over any transport, including JSON-only ones). The right primitive for correlation is the same one `render()` and `export()` already use: a Promise plus an internal `requestId` that never escapes the IPC layer.

### Finding 2: Every non-UI consumer already uses Promise-correlated commands

The Consumer Surface Survey shows that CLI, benchmark runner, API benchmarks, and `packages/testing` use `await client.render(...)` or `await client.export(...)` exclusively. None of them subscribe to `'geometry'` events; none of them need to know about generations. If v1's `whenSettled(generation)` primitive shipped, none of them would call it.

This is strong evidence that the public API's centre of gravity is **request → response**, not **event → correlated request**. Streaming `'geometry'` push exists exclusively for live editing in the UI, where the consumer wants "the latest" and does not need to match emissions to specific commands.

### Finding 3: The UI's "settled" question is solved at the state-machine layer, not the event layer

`apps/ui/app/hooks/rpc-handlers.ts:223` uses XState's `waitFor(cadUnit, state => state.value === 'idle' || state.value === 'error')`. That predicate is a composite assertion: "the kernel client has finished processing every command I have sent so far." The CAD machine maintains this invariant by transitioning to `idle` only on `geometryComputed`/`kernelIssue` and back to `rendering` on `setFile`/`setParameters`.

The race v1 set out to fix is a CAD-machine bug: the machine transitions to `idle` after the first geometry message even when a later `setFile` has already been issued and is in flight. The fix does not require generation tags on events. It requires the **CAD machine** to count outstanding command Promises and only transition to `idle` when zero are outstanding. That counter is purely XState context; it doesn't need to be observable on the runtime API.

In other words: **the UI needs Promise-returning setters so the state machine can `await` them, not a generation tag on every event so it can re-implement Promise correlation by hand.**

### Finding 4: setFile/setParameters are void only for historical reasons

`render()` is Promise-based with full correlation via `pendingRender` + `lastRenderRequestId` + `nextRequestId` (`runtime-worker-client.ts:302-326`). The dispatcher routes `geometryComputed` to `pendingRender.resolve` when a render is in flight, otherwise to the autonomous `onGeometryComputed` callback (`runtime-worker-dispatcher.ts:152-154,203-226`).

`setFile`/`setParameters` are `void` (`runtime-worker-client.ts:351-381`) only because the original mental model was "these are configuration writes; the next render is what produces the result." That's fine for a one-shot `render()` consumer, but it forces every streaming consumer to re-derive the settled signal from the event stream. Making them Promise-coalesced is mechanical:

- Each call installs/replaces `pendingAutonomousRender` (analogous to `pendingRender`).
- The first `geometryComputed`/`error` after the call resolves/rejects the Promise.
- A subsequent `setFile`/`setParameters` rejects the previous Promise with `RenderSupersededError` (same shape `cancelPendingRender` already produces) before installing the new one.
- Debounce/coalescing happens _worker-side_ in `scheduleRender`; multiple rapid `setParameters` calls each get their own Promise, all of which resolve to the same eventual result, with everything but the last one rejected as superseded — or, alternatively, **all** of them resolve to the same result (cooperative coalesce). The choice is a small policy decision; both are usable.

This change requires no SAB. It requires only a per-`setFile`/`setParameters` `requestId` and the dispatcher routing the next autonomous geometry event to the matching Promise.

### Finding 5: SAB capability detection is scattered across try/catch islands

Three independent spots try to construct SAB and silently fall back:

1. `runtime-client.ts:648-662` — geometry pool `SharedArrayBuffer`.
2. `runtime-worker-client.ts:200-208` — signal channel `SharedArrayBuffer`.
3. `runtime-client.ts:525-544` — one-shot warning when `!status.crossOriginIsolated`.

`packages/runtime/src/cross-origin-isolation/index.ts:135-149` exposes `inspectCrossOriginIsolation()` which returns `{ crossOriginIsolated, sharedArrayBuffer, reason? }`. That function is the **closest thing the codebase has** to a centralised capability declaration, but:

- It's a global probe, not transport-scoped (a remote transport over WebSocket has a totally different capability set even when the document is COI).
- Pool-allocation success is independent (try/catch is still required because the constructor can succeed yet allocation fails on hostile environments).
- It's not threaded through to consumers; everyone calls it ad hoc.

There is no single source of truth for "does this client have SAB right now?" — every component re-derives it.

### Finding 6: Transport interface lacks capability declaration

The current `RuntimeTransport` is minimal:

```16:36:packages/runtime/src/transport/runtime-transport.ts
export type RuntimeTransport = {
  send(message: RuntimeCommand, transferables?: Transferable[]): void;
  onMessage(handler: (message: RuntimeResponse) => void): void;
  close(): void;
};
```

There is no way for the transport to advertise:

- Whether `transferables` are honoured (in-process `MessageChannel` handles them; a future WebSocket transport will not).
- Whether the transport is local enough that a `SharedArrayBuffer` can be sent across (the worker transport does; in-process transport does; WebSocket cannot).
- Whether the transport is synchronous (in-process `MessageChannel` is async even though the worker is in the same thread; the consumer might want to know).
- Whether back-pressure exists (a remote transport over a saturated link will need flow control; a `MessageChannel` will not).

Without these declarations, the runtime client must guess, and the only signal it has is `globalThis.crossOriginIsolated` — which is a property of the **document**, not of the transport. A consumer running an in-process transport in a non-isolated context can still benefit from `SharedArrayBuffer` if the transport is local; a consumer with a remote transport in a perfectly isolated context cannot, no matter how good the page's COOP/COEP headers are.

### Finding 7: A WebSocket transport breaks SAB-flavoured public APIs

This is the architectural argument that decisively rules out v1's promotion of generations.

A WebSocket transport (or HTTP+SSE, or gRPC, or any remote transport) has these constraints:

| Capability                   | `MessageChannel`/`Worker` | `WebSocket` (remote)              |
| ---------------------------- | ------------------------- | --------------------------------- |
| `SharedArrayBuffer` transfer | Yes                       | **No**                            |
| `Transferable[]` (Zero-copy) | Yes                       | **No** (binary frames are copies) |
| Synchronous abort signalling | Yes (`Atomics.store`)     | **No** (round-trip)               |
| Latency                      | <1 ms                     | 10–500 ms                         |
| Backpressure                 | Implicit (queue grows)    | Explicit (flow control)           |

If the public API exposes:

- `latestGeneration` SAB slot → meaningless on WebSocket; the slot is `undefined` and consumers must branch.
- `generation` field on every `RuntimeResponse` → still works, but only because v1 implicitly required the worker to also stamp messages. So we're already paying the cost of two correlation channels.
- `whenSettled(generation: number)` → leaks the generation concept into consumer code; consumers must obtain the generation from `setFile`'s return value, then pass it to `whenSettled`. Three API surface elements where one Promise chain would do.

If the public API exposes only:

- `await client.setFile(file, params)` → works on `MessageChannel` (resolves on local `geometryComputed`); works on `WebSocket` (resolves on remote `geometryComputed` over the wire).
- `client.on('geometry', handler)` → works identically; the wire format dictates whether geometry comes back inline or as a chunk reference.

The Promise-coalesced contract is **transport-agnostic by construction**. The generation-tagged contract requires every transport to either implement SAB-shaped semantics or expose null-shaped capabilities, which forces consumers to branch.

### Finding 8: notifyFileChanged is redundant in filesystem mode (carried from v1)

This finding from v1 stands. The kernel worker subscribes to bridge watch events at `kernel-worker.ts:1181`, and the handler does identical work to `notifyFileChanged`. Production UI writers go through `FileContentService.write` → `proxy.writeFile` → FM worker `FileService.writeFile`, which always triggers the bridge watch. `notifyFileChanged` is dead weight in production filesystem mode and remains necessary only for inline `render({ code })` and headless tests that mutate an unbridged FS.

The v2 recommendation absorbs this finding: `notifyFileChanged` is removed from the public API. The inline `render({ code })` path uses an internal `setFiles({ files })` operation; tests get a tagged escape hatch.

### Finding 9: Dual state delivery when SAB is present (carried from v1)

`KernelWorker.pushState` writes to SAB **and** invokes the `onStateChanged` callback over `postMessage` (`kernel-worker.ts:1576-1577`). When the main thread has a SAB monitor running on `signalSlot.workerState`, the duplicate `postMessage` event is wasted work and a potential reordering hazard.

v2 keeps v1's recommendation here: the dispatcher gates `stateChanged` `postMessage` wiring on `!sabPresent`. Implementation note in v2: `sabPresent` becomes a function of `transport.capabilities.sharedMemory`, not a separate try/catch.

### Finding 10: cancelPendingRender is a leak from the legacy request/response era (carried from v1)

`cancelPendingRender` and the `'render'`/`'cancel'` command pair are artifacts of the original request/response model. In the autonomous render world, supersession is the natural cancel signal: a new `setFile` aborts the in-progress render via the abort-generation increment. Promise-coalesced setters subsume `cancelPendingRender` entirely — calling a new setter automatically rejects the previous Promise with `RenderSupersededError`.

v2 marks `'render'`/`'cancel'` as legacy, replaced by the Promise-coalesced setter triad. `client.render(...)` survives as a **convenience wrapper** that issues `setFile` + `setParameters` + awaits the resulting Promise, used by CLI and tests — but `cancelPendingRender` is removed from the public surface.

## Target Architecture

A four-layer model where each layer hides the implementation details of the layer below.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Layer 4: Consumer surface (apps, CLI, tests)                        │
│  • await client.render({ file, params })                             │
│  • await client.export(format, opts)                                 │
│  • await client.setFile(file, params)         ← NEW: now a Promise   │
│  • await client.setParameters(params)         ← NEW: now a Promise   │
│  • client.on('geometry' | 'state' | 'error' | 'capabilities', cb)    │
│  • client.capabilities (kernels, transcoders)                        │
│  • client.transport.capabilities (sharedMemory, transferables, …)    │
│  ── No generations. No SAB. No requestIds. No whenSettled. ──        │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 3: Runtime client (correlation, coalescing, pool resolution)  │
│  • Pending-promise registry (one per outstanding command)            │
│  • Geometry pool resolution (SAB key → bytes when sharedMemory)      │
│  • State monitor: SAB Atomics.waitAsync OR postMessage subscription  │
│  • Capabilities-driven path selection                                │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 2: Transport with declared capabilities                       │
│  • RuntimeTransport.capabilities: TransportCapabilities              │
│  • send(command, transferables?)                                     │
│  • onMessage(RuntimeResponse)                                        │
│  • close()                                                           │
│  • Implementations: createInProcessTransport, createWorkerTransport, │
│    createWebSocketTransport (future), createSseTransport (future)    │
├──────────────────────────────────────────────────────────────────────┤
│  Layer 1: Wire protocol (JSON + optional Transferables)              │
│  • RuntimeCommand / RuntimeResponse — JSON-serialisable              │
│  • Each command carries an internal requestId (string)               │
│  • Each response either carries a requestId (correlated) or          │
│    'autonomous' (broadcast)                                          │
│  • Geometry payloads: inline bytes OR pool key (when sharedMemory)   │
└──────────────────────────────────────────────────────────────────────┘
```

Internally, between layers 1 and 3, generations remain — but only as `signalSlot.abortGeneration`. They never escape Layer 2 outwards.

### TransportCapabilities

A new declarative capability type, owned by the transport, consulted by Layer 3.

```typescript
export type TransportCapabilities = {
  /** Transport can transfer SharedArrayBuffer end-to-end. */
  readonly sharedMemory: boolean;

  /** Transport honours `Transferable[]` (zero-copy ArrayBuffer transfer). */
  readonly transferables: boolean;

  /** Transport endpoint locality. */
  readonly locality: 'in-process' | 'worker' | 'remote';

  /** Round-trip latency class for command/response. */
  readonly latencyClass: 'sub-millisecond' | 'low' | 'high';

  /** Transport surfaces explicit backpressure. */
  readonly backpressure: boolean;
};
```

| Transport            | sharedMemory    | transferables | locality   | latencyClass    | backpressure |
| -------------------- | --------------- | ------------- | ---------- | --------------- | ------------ |
| `in-process`         | true (when COI) | true          | in-process | sub-millisecond | false        |
| `worker`             | true (when COI) | true          | worker     | sub-millisecond | false        |
| `websocket` (future) | **false**       | **false**     | remote     | high            | true         |
| `sse` (future)       | false           | false         | remote     | high            | true         |

The runtime client reads `transport.capabilities` once at `connect` time. Every "do I have SAB?" branch elsewhere in the codebase is replaced with a property read on this struct.

### Wire-protocol additions for transport-agnostic signalling

The four current SAB slots get a parallel message channel for transports without `sharedMemory`:

| SAB slot today               | Wire-format fallback                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `signalSlot.workerState`     | `{ type: 'stateChanged', state }` push (already exists)      |
| `signalSlot.abortReason`     | Carried in `error` payload (`RenderAbortedError.reason`)     |
| `signalSlot.progressPercent` | `{ type: 'progress', percent, phase }` push (already exists) |
| `signalSlot.abortGeneration` | `{ type: 'abort', requestId }` command on the wire (new)     |

Cooperative abort over a remote transport is _not free_ — there's no SAB to poll. The fallback is:

1. Main thread sends `{ type: 'abort', requestId }`.
2. Worker receives the message at the next event-loop tick and increments its **local** `renderGeneration` (no SAB).
3. WASM polling reads the local counter via the same `checkAbort()` interface.

Latency is dictated by the transport's round-trip — for `MessageChannel` it's effectively free; for WebSocket it's one RTT. That latency penalty is acceptable for remote transports (which are by definition higher-latency), and consumers see no API difference.

### Promise-coalesced command lifecycle

The state machine for a single command Promise:

```
                       ┌───────────────────┐
                       │   await client.   │
                       │   setFile(f, p)   │
                       └─────────┬─────────┘
                                 │
                  installs ┌─────▼──────┐ rejects previous
                  pending  │ requestId, │ pendingAutonomous
                ──────────►│ Promise    │ with Superseded
                           └─────┬──────┘
                                 │
                                 │ transport.send({setFile, requestId})
                                 ▼
                       ┌───────────────────┐
                       │   Worker renders  │
                       └─────────┬─────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
    geometryComputed       error               superseded
    (matches requestId)    (matches requestId) (newer setFile)
            │                    │                    │
       resolve(g)           reject(e)          reject(Superseded)
```

Aborts fire identically: a new setter rejects the previous Promise via the same `RenderSupersededError` shape that `cancelPendingRender` produces today. `RenderTimeoutError` and `RenderAbortedError` propagate via the rejection path. Consumers handle them with normal `try`/`catch`/`.catch()`.

## Should the consumer see SAB? A transparency analysis

The user asked whether SAB-vs-fallback should be **fully internalised** to the client (consumer-transparent) or whether the consumer should make the choice themselves. The answer is **internalised by default, with a narrow opt-in for advanced cases**.

| Decision axis                      | Internalise                                   | Expose                           |
| ---------------------------------- | --------------------------------------------- | -------------------------------- |
| Consumer code complexity           | ✓ Single API surface                          | ✗ Branching code per environment |
| Future-proofing for new transports | ✓ Add transport, no consumer change           | ✗ Every consumer must update     |
| Testability                        | ⚠ Need force-degrade hook for tests           | ✓ Tests can pick mode            |
| Diagnostics / observability        | ⚠ Need readonly capabilities accessor         | ✓ Trivial                        |
| Performance tuning by consumer     | ⚠ Consumer can swap transport at construction | ✓ Direct knob                    |

The rule that resolves this:

- **Control flow**: never branch on transport mode. Internalise.
- **Diagnostics**: expose `client.transport.capabilities` as a readonly descriptor for telemetry, debug overlays, and "why is my geometry slow?" investigations.
- **Tuning**: consumers express preference by constructing the transport they want (`createInProcessTransport({ shared: false })` to force degradation) — not by calling a runtime knob on the client.

This mirrors the philosophy of `fetch` (transport details are properties of the request/response, not knobs on consumers) and Three.js renderers (consumers choose the renderer at construction; rendering code is renderer-agnostic).

The CLI is a clean test of the rule: `taucad export` works in Node where `crossOriginIsolated` is irrelevant, in a browser where it might be true or false, and (future) over a WebSocket to a remote runtime worker. The CLI source code never references SAB. v2 preserves that property for every consumer.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                | Priority | Effort | Impact |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Make `setFile` and `setParameters` return `Promise<HashedGeometryResultTransport>` with coalesced supersede semantics.                                                                                                                                                | P0       | Medium | High   |
| R2  | Add `requestId` correlation for autonomous setter Promises in `RuntimeWorkerClient` and the dispatcher.                                                                                                                                                               | P0       | Low    | High   |
| R3  | Define `TransportCapabilities` and add `capabilities: TransportCapabilities` to `RuntimeTransport`. Update `createInProcessTransport`, `createWorkerTransport`.                                                                                                       | P0       | Low    | High   |
| R4  | Replace every ad-hoc `crossOriginIsolated` / try/catch SAB check in `runtime-client.ts` and `runtime-worker-client.ts` with a single `transport.capabilities.sharedMemory` read.                                                                                      | P0       | Medium | Medium |
| R5  | Gate `stateChanged` `postMessage` delivery on `!transport.capabilities.sharedMemory` (carry-over from v1 R6).                                                                                                                                                         | P0       | Low    | Medium |
| R6  | Remove `notifyFileChanged` from the public API. Inline `render({ code })` uses a private `setFiles({ files })` operation. Tests get `__test__invalidate(paths)`. (Carry-over from v1 R10/R11.)                                                                        | P0       | Medium | Medium |
| R7  | Remove `cancelPendingRender` from the public API; supersession via Promise-coalesced setters subsumes it. (Carry-over from v1 R8.)                                                                                                                                    | P1       | Low    | Low    |
| R8  | Add a wire-format `{ type: 'abort', requestId }` command for transports without `sharedMemory`. Worker handler increments local `renderGeneration` from the message.                                                                                                  | P1       | Medium | Medium |
| R9  | Update the CAD machine to use the new Promise-coalesced setters: outstanding-Promise counter governs `idle` transition; remove duplicate per-event correlation logic.                                                                                                 | P0       | Medium | High   |
| R10 | Update `apps/ui/app/hooks/rpc-handlers.ts` to `await ensureGeometryUnit().setFile(...)` directly; delete the bespoke "fresh render" helper.                                                                                                                           | P0       | Low    | High   |
| R11 | Mark `signalSlot.abortGeneration` and `cooperative-abort.ts` as **internal**; document them as not part of the public API. Add `@internal` JSDoc tags.                                                                                                                | P1       | Low    | Medium |
| R12 | Ship a `transport.capabilities` JSDoc page; `client.transport.capabilities` exposed as readonly descriptor for diagnostics.                                                                                                                                           | P2       | Low    | Low    |
| R13 | Pre-stub `createWebSocketTransport(url)` with the capability declaration set to `{ sharedMemory: false, transferables: false, locality: 'remote', latencyClass: 'high', backpressure: true }`, even before implementing the wire protocol. Validates the abstraction. | P2       | Low    | Medium |
| R14 | Library-API-policy compliance pass on the new surface (R1–R13): symmetric Promise return types across `setFile`/`setParameters`/`render`, no `void` setters that hide async work, capability-driven branches centralised.                                             | P1       | Low    | Medium |
| R15 | Migration guide doc for downstream consumers: the only breaking change is `setFile`/`setParameters` returning `Promise` instead of `void`. Existing `void`-callers compile under the new return type but should `await` for race safety.                              | P2       | Low    | Low    |

**Dropped from v1:**

- ~~v1 R1: latestGeneration SAB slot~~ — generations stay internal.
- ~~v1 R2: generation field on RuntimeResponse~~ — Promise correlation replaces it.
- ~~v1 R3: setFile/setParameters return generation number~~ — they return `Promise<HashedGeometryResultTransport>`.
- ~~v1 R4: whenSettled(generation) primitive~~ — replaced by `await client.setFile(...)` directly.
- ~~v1 R7: lastRequestedGeneration getter~~ — internal-only.

## Trade-offs vs v1

| Dimension                              | v1 (generation-stamped events)                                       | v2 (Promise-coalesced commands)                                |
| -------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Public concepts consumers learn        | Generation, settled-generation, whenSettled, lastRequestedGeneration | Just `Promise<T>` and standard `client.on(...)`                |
| Lines of consumer code per RPC handler | ~30 (waitFor + generation + check)                                   | ~5 (`await client.setFile(...)`)                               |
| Survives a remote transport            | Partially (SAB-shaped APIs need null-shaped caps)                    | Yes, by construction                                           |
| Cooperative abort                      | Public surface knows about it                                        | Internal-only (`signalSlot` not in public types)               |
| Test fixtures for race scenarios       | Mock generation counter                                              | Mock Promise resolution order                                  |
| Implementation cost                    | Add SAB slot + protocol field + new primitive                        | Add requestId routing + reuse pendingRender pattern            |
| Risk of leaky abstraction              | High (every event field maps to a SAB byte)                          | Low (consumer surface is fully decoupled from transport)       |
| Consumer migration churn               | Moderate (every event handler learns generations)                    | Minimal (`void` callers already work; just `await` for safety) |

v1's strength was that it directly modelled the lowest-level mechanism that already exists (the SAB slot). v2's strength is that it picks the **right level of abstraction** for the consumer — `Promise<T>` — and lets the implementation choose freely between SAB-monitored and message-routed correlation underneath.

## Migration Path

Five stages, each independently mergeable, no flag day.

### Stage 1: Transport capabilities (R3, R4, R12)

- Define `TransportCapabilities` type.
- Update `RuntimeTransport` interface.
- Update `createInProcessTransport`, `createWorkerTransport` to declare capabilities.
- Replace ad-hoc `crossOriginIsolated` / try/catch checks with `transport.capabilities.sharedMemory` reads.
- Expose `client.transport.capabilities` for diagnostics.

No behaviour change. Pure refactor. Tests assert capability values per transport.

### Stage 2: Promise-coalesced setters (R1, R2, R5)

- Add `pendingAutonomousRender: { requestId, resolve, reject } | undefined` to `RuntimeWorkerClient`.
- Stamp every `setFile`/`setParameters` command with a `requestId`.
- Dispatcher routes correlated `geometryComputed`/`error` to `pendingAutonomousRender.resolve`/`reject`.
- A subsequent setter rejects the previous Promise with `RenderSupersededError`.
- Gate `stateChanged` `postMessage` on `!transport.capabilities.sharedMemory`.
- TypeScript: `setFile`/`setParameters` return `Promise<HashedGeometryResultTransport>` instead of `void`. Callers compile unchanged but should `await`.

Behaviour change: callers that fire-and-forget no longer see UnhandledPromiseRejection on supersession because rejection is the explicit signal. Document this.

### Stage 3: CAD machine and RPC handler refactor (R9, R10)

- CAD machine: replace per-event correlation with outstanding-Promise counter; transition to `idle` only when zero outstanding.
- `rpc-handlers.ts`: replace bespoke `awaitFreshRender` helper with `await ensureGeometryUnit().setFile(...)`.
- Delete the "first geometry after setFile" race fix machinery.
- Tests: rewrite `cad.machine.test.ts` and `rpc-handlers.test.ts` for the simpler contract.

### Stage 4: notifyFileChanged removal and cancelPendingRender removal (R6, R7)

- Internal `setFiles({ files })` for inline `render({ code })`.
- Tagged `__test__invalidate(paths)` for headless tests.
- Remove `notifyFileChanged` from `RuntimeClient` and `RuntimeWorkerClient` public surfaces.
- Remove `cancelPendingRender` from public surface.
- Update benchmark runner to use the inline-code path or the test escape hatch.

### Stage 5: Wire-format abort message + WebSocket pre-stub (R8, R11, R13)

- Add `{ type: 'abort', requestId }` command.
- Worker handler increments local `renderGeneration` on receipt.
- Mark `signalSlot.abortGeneration` and `cooperative-abort.ts` `@internal`.
- Pre-stub `createWebSocketTransport(url)` with capability declaration but `throw new Error('not yet implemented')` on `send` — validates that the abstraction holds.

After Stage 5, the runtime client has no public API surface that mentions SAB, generations, requestIds, or transport mode. A future WebSocket transport implementation is purely a Layer 1 + Layer 2 task.

## Code Examples

### Before (v1 plan, generation-stamped)

```typescript
const generation = await client.setFile(file, params);
const result = await client.whenSettled(generation);
if (result.kind === 'geometry') {
  return result.geometry;
}
```

### After (v2, Promise-coalesced)

```typescript
const geometry = await client.setFile(file, params);
return geometry;
```

### Before (UI RPC handler today)

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

### After (UI RPC handler, v2)

```typescript
const cadUnit = await ensureGeometryUnit(targetFile);
try {
  const geometry = await cadUnit.client.setFile(targetFile);
  return success(geometry);
} catch (error) {
  if (error instanceof RenderSupersededError) {
    // Caller will retry; another setFile is already in flight.
    return failure({ code: 'SUPERSEDED' });
  }
  return failure(toFailure(error));
}
```

### Capability-driven internal branching (Layer 3)

```typescript
const monitor = transport.capabilities.sharedMemory
  ? createSabStateMonitor(this.signalView)
  : createMessageStateMonitor(this.transport);

monitor.on('state', (state) => this.handleStateChange(state));
```

Consumers never see this. It's pure Layer 3.

## Diagrams

### Current (half-migrated) architecture

```
┌─────────────────┐         ┌──────────────┐
│  Consumer       │         │  Consumer    │
│  (autonomous)   │         │  (one-shot)  │
└────────┬────────┘         └──────┬───────┘
         │ on('geometry')          │ await render()
         │ + waitFor(idle)         │
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
│  RuntimeTransport (no capabilities)     │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  Worker                                 │
│  ├ executeRender + renderGeneration     │
│  ├ pushState → SAB AND postMessage      │
│  └ onGeometryComputed (autonomous)      │
└─────────────────────────────────────────┘
```

### Target (v2) architecture

```
┌─────────────────────────────────────────┐
│  Consumer                               │
│  await client.setFile(...)              │
│  await client.setParameters(...)        │
│  await client.render(...)               │
│  await client.export(...)               │
│  client.on('geometry' | 'state' | ...)  │
└────────────────┬────────────────────────┘
                 │ ── No SAB / generations / requestIds visible ──
                 ▼
┌─────────────────────────────────────────┐
│  RuntimeClient (Layer 3)                │
│  ├ pendingAutonomousRender (Promise)    │
│  ├ pendingRender (Promise)              │
│  ├ pendingExport (Promise)              │
│  ├ setFile/setParameters → Promise      │
│  └ stateMonitor: SAB or postMessage,    │
│    chosen from transport.capabilities   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  RuntimeTransport (Layer 2)             │
│  capabilities: TransportCapabilities    │
│  ├ in-process: { sharedMemory, transferables, in-process, sub-millisecond, no-bp } │
│  ├ worker:     { sharedMemory, transferables, worker, sub-millisecond, no-bp } │
│  └ websocket:  { no-shared, no-transfer, remote, high, backpressure } │
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
│  ├ executeRender + signalSlot.abort     │
│  │   (internal abort primitive only)    │
│  ├ Each emission stamped with requestId │
│  └ pushState gated on caps.sharedMemory │
└─────────────────────────────────────────┘
```

### Promise-coalesced setter sequence

```
Consumer        RuntimeClient         Worker
   │                  │                  │
   │ setFile(A)       │                  │
   ├─────────────────►│ requestId=1      │
   │                  ├─────────────────►│ render A (gen=1)
   │ setFile(B) ──┐   │                  │
   │              │   │ requestId=2      │
   │              └──►│  reject(P1, Superseded)
   │                  ├─────────────────►│ abortGen++ → 2; render B
   │                  │                  │
   │                  │       ◄──────────┤ {geometryComputed, requestId=2}
   │ ◄────────────────┤ resolve(P2, B-geometry)
   │                  │                  │
```

## Appendix: API Surface Audit Table

Status legend: ✓ keep, ⚠ refactor, ✗ remove, + add.

| Surface element                           | v2 status     | Rationale                                                                                                                           |
| ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `client.render(input)`                    | ✓             | Already Promise-correlated. Becomes a thin wrapper on setFile + setParameters.                                                      |
| `client.export(format, opts)`             | ✓             | Already Promise-correlated.                                                                                                         |
| `client.setFile(file, params)`            | ⚠             | Returns `Promise<HashedGeometryResultTransport>`.                                                                                   |
| `client.setParameters(params)`            | ⚠             | Returns `Promise<HashedGeometryResultTransport>`.                                                                                   |
| `client.notifyFileChanged(paths)`         | ✗             | Redundant; absorbed by inline `render({ code })` private helper.                                                                    |
| `client.cancelPendingRender()`            | ✗             | Subsumed by Promise-coalesced setter supersession.                                                                                  |
| `client.terminate()`                      | ✓             | Lifecycle.                                                                                                                          |
| `client.cleanup()`                        | ✓             | Lifecycle.                                                                                                                          |
| `client.on('geometry', cb)`               | ✓             | Live-preview consumers want "latest", not correlated.                                                                               |
| `client.on('kernelIssue', cb)`            | ✓             | Same.                                                                                                                               |
| `client.on('state', cb)`                  | ✓             | Diagnostics.                                                                                                                        |
| `client.on('progress', cb)`               | ✓             | Diagnostics.                                                                                                                        |
| `client.on('telemetry', cb)`              | ✓             | Used by benchmark.                                                                                                                  |
| `client.on('log', cb)`                    | ✓             | Used by CLI.                                                                                                                        |
| `client.on('capabilities', cb)`           | ✓             | Capabilities manifest pushes.                                                                                                       |
| `client.capabilities`                     | ✓             | Kernel/transcoder capabilities.                                                                                                     |
| `client.transport.capabilities`           | +             | TransportCapabilities readonly accessor for diagnostics.                                                                            |
| `client.lastRequestedGeneration`          | ✗             | Generations are internal.                                                                                                           |
| `client.whenSettled(generation)`          | ✗ (was v1 R4) | Subsumed by `await setFile/setParameters`.                                                                                          |
| `RuntimeCommand.requestId`                | ⚠             | Made mandatory on every command (string).                                                                                           |
| `RuntimeResponse.requestId`               | ⚠             | Either a string for correlated responses or `'autonomous'`.                                                                         |
| `RuntimeCommand: 'render'`                | ⚠             | Becomes a client-side macro: setFile + setParameters + await. Remove from wire protocol.                                            |
| `RuntimeCommand: 'cancel'`                | ✗             | Replaced by setter-supersession.                                                                                                    |
| `RuntimeCommand: 'fileChanged'`           | ✗             | Removed; inline path uses `setFiles`.                                                                                               |
| `RuntimeCommand: 'setFiles'`              | + (private)   | Inline `render({ code })` writes-then-renders atomically.                                                                           |
| `RuntimeCommand: 'abort'`                 | +             | `{ requestId }`. Wire-format fallback for transports without SAB.                                                                   |
| `signalSlot.abortGeneration`              | ✓ (internal)  | `@internal`. Stays SAB-only. No fallback needed for cooperative abort over remote: use `'abort'` command.                           |
| `signalSlot.workerState`                  | ✓ (internal)  | `@internal`. Drives the SAB monitor when `caps.sharedMemory`.                                                                       |
| `signalSlot.abortReason`                  | ✓ (internal)  | `@internal`.                                                                                                                        |
| `signalSlot.progressPercent`              | ✓ (internal)  | `@internal`. Has wire-format fallback (`progress` event).                                                                           |
| `signalSlot.latestGeneration` (was v1 R1) | ✗             | Not introduced.                                                                                                                     |
| `RuntimeTransport`                        | ⚠             | Add `capabilities: TransportCapabilities`.                                                                                          |
| `TransportCapabilities`                   | +             | New type, owned by transport, consulted by Layer 3.                                                                                 |
| `createInProcessTransport`                | ⚠             | Declare capabilities. Add `{ shared?: boolean }` opt-in override for tests.                                                         |
| `createWorkerTransport`                   | ⚠             | Declare capabilities.                                                                                                               |
| `createWebSocketTransport`                | + (stub)      | R13. Capability declaration in place; implementation deferred.                                                                      |
| `inspectCrossOriginIsolation()`           | ✓             | Stays as a global probe; consumed by `createInProcessTransport`/`createWorkerTransport` to compute their `sharedMemory` capability. |
| `cooperative-abort.ts` exports            | ⚠ (internal)  | `@internal`. Not part of the public package surface.                                                                                |

## References

- v1 of this blueprint: `docs/research/runtime-event-driven-api-blueprint.md` (superseded for the generation-promotion recommendations; the notifyFileChanged + dual-delivery + cancelPendingRender findings carry over).
- [Library API Policy](../policy/library-api-policy.md) — §1 (parameter object), §5 (event naming), §7 (no `void` for async), §10 (transport-agnostic), §11 (capability declaration).
- [Runtime Architecture Policy](../policy/runtime-architecture-policy.md) — current transport list and forward-looking transport plans.
- [Runtime Topology](../architecture/runtime-topology.md) — target render pipeline (autonomous worker, bridge watch).
- [CLI Runtime Ergonomics](cli-runtime-ergonomics.md) — `createNodeClient`, FileInput shape, multi-file bundling.
- [Safari Cross-Origin Isolation](safari-cross-origin-isolation.md) — when SAB is and is not available; consumed by `inspectCrossOriginIsolation`.
- [Capabilities Manifest API Audit](capabilities-manifest-api-audit.md) — orthogonal capability surface (kernels/transcoders), not transport.
- [Lazy Capabilities Manifest](lazy-capabilities-manifest.md) — manifest evolution after kernel load; orthogonal to transport capabilities.
- [Shared-Memory Geometry Pipeline](shared-memory-geometry-pipeline.md) — pool-based geometry transfer when `caps.sharedMemory`.
- [Runtime Client Type Safety Audit](runtime-client-type-safety-audit.md) — generic inference for kernel/transcoder formats; orthogonal to this work.
