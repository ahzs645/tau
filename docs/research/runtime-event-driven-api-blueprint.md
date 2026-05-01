---
title: 'Runtime Event-Driven API Blueprint'
description: 'API surface audit and target architecture for the @taucad/runtime client: SAB-first signalling, event-driven graceful degradation, and elimination of redundant command paths superseded by autonomous watches.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/architecture/runtime-topology.md
  - docs/policy/runtime-architecture-policy.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/capabilities-manifest-api-audit.md
  - docs/research/runtime-client-type-safety-audit.md
---

# Runtime Event-Driven API Blueprint

Audit of every consumer-visible API on `@taucad/runtime`, identification of branches superseded by autonomous file-watch / SAB infrastructure, and a target-state blueprint that prioritises shared-memory signalling with graceful degradation to event-driven `postMessage` delivery.

## Executive Summary

The runtime worker is already an **autonomous reactive render service** — the FM worker emits `fileChanged` events through `ChangeEventBus → coalescer → throttledWorker → bridge.emit('watch:${watchId}', event)`, and the kernel worker's bridge subscription (kernel-worker.ts:1181) auto-invalidates caches and calls `scheduleRender()`. The consumer-facing `client.notifyFileChanged(paths)` command is **dead weight in production filesystem mode**: it duplicates work the bridge already performs. The only legitimate caller is the inline `render({ code })` path, where the client writes into a `fromMemoryFS()` instance that has no FM worker and therefore no watch chain.

Beyond `notifyFileChanged`, the public API has three holes that force every RPC consumer to reinvent generation tracking on the main thread:

1. No "request generation" returned from `setFile`/`setParameters` — they are fire-and-forget `void` calls.
2. No generation tag on `geometryComputed`/`error`/`stateChanged` events — consumers cannot match an emission to the request that produced it.
3. No `whenSettled` / `awaitGeneration` primitive — every consumer rolls its own waitFor/state-machine barrier.

The recommended target state collapses these into a single "request → settled" contract delivered SAB-first (latest-generation slot, atomic monitor) with a single `postMessage` fallback path for the geometry payload itself. `notifyFileChanged` is retired from the public surface; the inline `render({ code })` path absorbs its responsibility internally via a private `setFiles({ files })` operation.

## Table of Contents

- [Scope and Non-Goals](#scope-and-non-goals)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: notifyFileChanged is redundant in filesystem mode](#finding-1-notifyfilechanged-is-redundant-in-filesystem-mode)
  - [Finding 2: notifyFileChanged still legitimate for inline-code mode and tests](#finding-2-notifyfilechanged-still-legitimate-for-inline-code-mode-and-tests)
  - [Finding 3: Documented architecture target is "removed" but unimplemented](#finding-3-documented-architecture-target-is-removed-but-unimplemented)
  - [Finding 4: Setter API missing request-correlation handles](#finding-4-setter-api-missing-request-correlation-handles)
  - [Finding 5: Events lack generation tags](#finding-5-events-lack-generation-tags)
  - [Finding 6: No whenSettled / awaitGeneration primitive](#finding-6-no-whensettled--awaitgeneration-primitive)
  - [Finding 7: Dual delivery path for state when SAB is present](#finding-7-dual-delivery-path-for-state-when-sab-is-present)
  - [Finding 8: cancelPendingRender is a leak from the legacy request/response era](#finding-8-cancelpendingrender-is-a-leak-from-the-legacy-requestresponse-era)
  - [Finding 9: Library API policy compliance gaps](#finding-9-library-api-policy-compliance-gaps)
- [Target Architecture](#target-architecture)
- [Recommendations](#recommendations)
- [Migration Path](#migration-path)
- [Appendix: API Surface Audit Table](#appendix-api-surface-audit-table)

## Scope and Non-Goals

**In scope:**

- Public API surface of `@taucad/runtime` (`createRuntimeClient`, `RuntimeClient` methods and events).
- Internal command/response protocol (`RuntimeCommand`, `RuntimeResponse`).
- Shared signal channel (`signalSlot.*`) and graceful-degradation fallbacks.
- Compliance with [Library API Policy](../policy/library-api-policy.md) §1, §5, §7, §10, §11.

**Out of scope:**

- Plugin authoring contracts (`defineKernel`, `defineMiddleware`, `defineBundler`, `defineTranscoder`) — covered by separate research.
- Kernel-internal cache invalidation algorithms — covered by [runtime-topology.md](../architecture/runtime-topology.md).
- Type-level audits (kernel format inference, transcoder edge inference) — covered by [runtime-client-type-safety-audit.md](runtime-client-type-safety-audit.md).

## Methodology

Investigation steps:

1. Enumerated every `client.notifyFileChanged` call site via `Grep`. Result: 12 hits across runtime tests, kernel tests, benchmark runner, internal `runtime-client.ts` inline path, and one production `runtime-client.ts` consumer entry.
2. Traced the bridge watch chain end-to-end: `FileService.watch()` → `WatchRegistry` → `ChangeEventBus` → `exposeFileSystem` coalescer → `BridgeServer.emit('watch:${watchId}', event)` → `BridgeProxy.watch()` listener → `kernel-worker.ts:1181` `_invalidateCachesForPaths` + `scheduleRender(fileChangeDebounceMs)`.
3. Read the architecture target documents: `docs/architecture/runtime-topology.md` (target topology), `docs/policy/runtime-architecture-policy.md` (current policy), `docs/research/shared-memory-geometry-pipeline.md` (SAB transport).
4. Cross-referenced with `docs/policy/library-api-policy.md` §1–§19 to identify each policy violation.
5. Inspected SAB layout: `signalSlot.{abortGeneration, workerState, abortReason, progressPercent}` in `runtime-protocol.types.ts`, monitor loop in `runtime-worker-client.ts:startStateMonitor`, dispatcher fan-out in `runtime-worker-dispatcher.ts`.

## Findings

### Finding 1: notifyFileChanged is redundant in filesystem mode

The kernel worker subscribes to bridge watch events via `this.fileSystem.watch(...)` at `packages/runtime/src/framework/kernel-worker.ts:1181`. The handler:

```1209:1219:packages/runtime/src/framework/kernel-worker.ts
        if (changedPaths.length > 0) {
          this._invalidateCachesForPaths(changedPaths);
          this.onFileChanged(changedPaths);
          if (this.currentFile) {
            let debounceMs = fileChangeDebounceMs;
            for (const p of changedPaths) {
              debounceMs = Math.min(debounceMs, this.middlewareWatchPaths.get(p) ?? fileChangeDebounceMs);
            }
            this.scheduleRender(debounceMs);
          }
        }
```

This is **identical** to what `notifyFileChanged` does in command-driven mode (kernel-worker.ts:1133–1136), except:

| Aspect                     | Watch path (autonomous)                                                                                       | `notifyFileChanged` (command)                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Trigger source             | FM worker `ChangeEventBus` after a real write                                                                 | Main thread tells worker "files changed"                                                       |
| Cache invalidation         | `_invalidateCachesForPaths`                                                                                   | `_invalidateCachesForPaths` (same code)                                                        |
| Render reschedule          | `scheduleRender(debounceMs)`                                                                                  | None — caller must call `render()` separately                                                  |
| Per-write debounce         | Bridge coalescer (500 ms default) + worker `fileChangeDebounceMs`                                             | None                                                                                           |
| Latency vs reality         | ≤ ~500 ms (coalescer window) after the FM worker fires the event                                              | Whatever the main-thread orchestrator imposes                                                  |
| Aborts in-progress renders | Watch handler's `scheduleRender` clears the param-debounce timer; render aborts at next OC proxy / async tick | None (no abort generation bump). Caller must call `cancelPendingRender()` first, manually      |
| Required when…             | Writer goes through FM worker (`FileContentService.write`)                                                    | Writer bypasses the FM worker (in-memory FS, direct `proxy.writeFile`, headless test fixtures) |

Production UI path (`FileContentService.write` → `proxy.writeFile` → FM worker `FileService.writeFile`) **always** triggers the bridge watch. `notifyFileChanged` is therefore unreachable production work.

### Finding 2: notifyFileChanged still legitimate for inline-code mode and tests

The legitimate callers are:

1. `runtime-client.ts:796` — `render({ code })` writes inline source into a `fromMemoryFS()` instance. That instance is **not** wrapped by an `exposeFileSystem` server, so no watch event is emitted. The client compensates with `client.notifyFileChanged(absolutePaths)`.
2. `benchmark-runner.ts:226` — headless harness that mutates the FS directly without the FM worker.
3. `runtime-client.test.ts:243`, `in-process-transport.test.ts:145` — tests using `fromMemoryFS()` directly.
4. `kernel-worker.test.ts:230`, `replicad.kernel.test.ts:2983,3030,3140,3214,3290,3383`, `openscad.kernel.test.ts:2137`, `kernel-runtime-worker.test.ts:273,278` — direct worker-level tests bypassing the bridge.

These callers all share one property: **they own and mutate a filesystem that is not bridged through a `watchHandler`**. The watch chain is structurally absent for them.

The right shape for this is **not** to retain a public `notifyFileChanged`, but to absorb the inline use case into a private internal call (the public consumer never asks for it directly) and expose a test-only escape hatch.

### Finding 3: Documented architecture target is "removed" but unimplemented

Two binding documents already declare `notifyFileChanged` slated for removal:

```498:499:docs/architecture/runtime-topology.md
Gains a render loop, abort infrastructure, watch subscription management, and shared memory pools. The `notifyFileChanged` command path is removed. New internal methods:
```

```143:143:docs/policy/runtime-architecture-policy.md
**Filesystem mode** (`FileInput`): Renders from a connected filesystem. `file` can be a string shorthand (e.g., `'/src/main.ts'`) or a `GeometryFile` object. `changedPaths` absorbs the old `notifyFileChanged` pattern -- the client internally notifies the worker about changed files before rendering.
```

Neither absorption has actually shipped. `notifyFileChanged` still exists on `RuntimeClient` (`runtime-client.ts:405`), `RuntimeWorkerClient` (`runtime-worker-client.ts:388`), `KernelWorker` (`kernel-worker.ts:1133`), the `RuntimeCommand` union, and the dispatcher (`runtime-worker-dispatcher.ts:240`). The `changedPaths` field on `FileInput` does not exist either; the field is shown as `changedPaths?: never` in `CodeInput` (runtime-client.ts:75) and absent from `FileInput`. **The current API is in a half-migrated state, and we should finish the migration rather than build new infrastructure on top of `notifyFileChanged`.**

### Finding 4: Setter API missing request-correlation handles

`setFile` and `setParameters` are `void`:

```351:381:packages/runtime/src/framework/runtime-worker-client.ts
  public setFile(file: GeometryFile, parameters?: Record<string, unknown>, options?: Record<string, unknown>): void {
    if (this.signalView) {
      Atomics.store(this.signalView, signalSlot.abortReason, abortReason.superseded);
    }
    this.incrementAbortGeneration();
    const command: RuntimeCommand = {
      type: 'setFile',
      file,
      parameters: parameters ?? {},
      options,
    };
    this.transport.send(command);
  }
```

`incrementAbortGeneration()` returns the new generation, but the returned value is discarded. Consumers therefore have no way to correlate "this render output was for the setFile I just issued".

This is the root cause of every RPC handler in `apps/ui` reinventing a generation barrier (e.g. `awaitFreshRender` proposed in the prior plan, the `waitFor` `predicate` in `rpc-handlers.ts`, the parallel `lastRequestedGeneration` field discussed in the cad.machine plan). Each reinvention is a thin wrapper over the same primitive: "wait until the worker's settled generation ≥ the generation my last command produced."

The fix is to surface the generation as a return value:

```typescript
const generation = client.setFile(file, parameters); // or setFile returns Promise<void> that resolves when settled
```

### Finding 5: Events lack generation tags

`onGeometryComputed`, `onError`, `onStateChanged` callbacks all carry only domain payload — no generation, no request id:

```232:243:packages/runtime/src/client/runtime-client.ts
type EventHandlers = {
  log: Set<(entry: LogEntry) => void>;
  progress: Set<(phase: RenderPhase, detail?: Record<string, unknown>) => void>;
  telemetry: Set<(entries: PerformanceEntryData[]) => void>;
  parametersResolved: Set<(result: GetParametersResult) => void>;
  geometry: Set<(result: HashedGeometryResult) => void>;
  state: Set<(state: WorkerState, detail?: string) => void>;
  error: Set<(issues: KernelIssue[]) => void>;
  capabilities: Set<(manifest: CapabilitiesManifest) => void>;
  activeKernel: Set<(kernelId: string | undefined) => void>;
};
```

A consumer subscribing to `'geometry'` cannot tell whether the emission is for the file/params combination they just requested, an earlier in-flight render that beat them to the wire, or an autonomous re-render triggered by a watch event from somewhere else.

The runtime _internally_ tracks `renderGeneration` (kernel-worker.ts:399) and the abort generation lives in `signalSlot.abortGeneration`. Lifting it onto every emission costs one number and removes the entire class of stale-snapshot consumer bugs.

### Finding 6: No whenSettled / awaitGeneration primitive

Combining Findings 4 and 5: even if generation were on every event, there would be no `client.whenSettled()` or `client.awaitGeneration(n)` to await it. Each consumer must build their own:

- `apps/ui/app/hooks/rpc-handlers.ts` — uses XState `waitFor` predicates that infer settledness from the cad.machine state and a derived `pendingRenderGeneration` shadow counter.
- `cad-preview.machine.ts` — uses an internal `awaitFirstGeometryActor` actor that subscribes to the runtime client's `geometry` event and races a timeout.
- `kernel.integration.test.ts` — uses ad-hoc `Promise<void>` wrappers around `client.on('geometry', resolve)`.

This is exactly the "high-level wrapper missing, every consumer rebuilds it" smell flagged in [Library API Policy §10](../policy/library-api-policy.md#10-high-level-wrappers-with-low-level-escape-hatches).

A single primitive collapses all of these:

```typescript
const generation = client.setFile({ file, parameters });
const result = await client.whenSettled(generation); // resolves with HashedGeometryResult or rejects with KernelError | RenderTimeoutError
```

### Finding 7: Dual delivery path for state when SAB is present

`pushState` writes to SAB **and** invokes the `postMessage` callback:

```1565:1580:packages/runtime/src/framework/kernel-worker.ts
  private pushState(state: WorkerState): void {
    if (state === this.lastPushedState) {
      return;
    }
    this.lastPushedState = state;
    if (this.signalView) {
      Atomics.store(this.signalView, signalSlot.workerState, workerStateEnum[state]);
      Atomics.notify(this.signalView, signalSlot.workerState);
    }
    this.onStateChanged?.(state);
  }
```

When SAB is present, the main-thread state monitor loop (`runtime-worker-client.ts:startStateMonitor`) wakes via `Atomics.waitAsync` on `signalSlot.workerState` AND the dispatcher's `stateChanged` postMessage callback also fires. Both paths fan out to `RuntimeClient.handlers.state` and `cadMachine` listeners. **State events are delivered twice in COI environments.** This is a benign correctness issue today (handlers are idempotent) but it complicates future generation-tagged delivery: if the SAB carries `latestGeneration` but the postMessage carries a different (older) generation snapshot, consumers see flapping.

The dispatcher should gate `stateChanged` postMessage on `!sabPresent`.

### Finding 8: cancelPendingRender is a leak from the legacy request/response era

`RuntimeWorkerClient.cancelPendingRender()` (line 330) sends a `cancel` command keyed by the legacy `requestId` and rejects `pendingRender`. It is invoked once, by `RuntimeClient.render()` (line 762), at the top of every `render()` call to discard the previous `pendingRender` promise.

This belongs to the **old** request/response render protocol (`RuntimeCommand: 'render' | 'cancel'`). The new autonomous protocol (`'setFile' | 'setParameters'`) handles cancellation entirely through the SAB abort generation; there is no per-request `cancel` message in the target topology. `cancelPendingRender` and the entire `pendingRender` map should evaporate when the legacy `'render'` command path retires.

The transitional reality is that `RuntimeClient.render()` (used by `client.render({ code })` and `client.render({ file })`) still calls the legacy worker `'render'` command, so `cancelPendingRender` survives. Once `render()` is rewritten as `setFile + whenSettled`, the legacy path goes away.

### Finding 9: Library API policy compliance gaps

| Policy section                                    | Status | Gap                                                                                                                                                            |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 Factory functions over classes                 | ✅     | `createRuntimeClient` is a factory; `RuntimeWorkerClient` class is internal                                                                                    |
| §3 Flat options                                   | ✅     | `RuntimeClientOptions` is flat                                                                                                                                 |
| §4 Max 3 params                                   | ✅     | All public methods are 1-arg or 1-arg + options                                                                                                                |
| §5 Naming — describe the action, not architecture | ⚠      | `notifyFileChanged` describes the architecture (the framework command path); a consumer wants "set up the workspace" or "discard cache". **Rename or remove.** |
| §5 Naming — `on*` for callbacks                   | ✅     | Event names are bare (`'geometry'`, `'state'`) but the subscription verb is `on(event, handler)` per §7                                                        |
| §7 Subscribe-anytime events                       | ✅     | `on(event, handler)` returns unsubscribe                                                                                                                       |
| §10 High-level wrappers with low-level escapes    | ⚠      | `notifyFileChanged` is a low-level escape **without** a corresponding high-level wrapper; consumers reinvent generation barriers (see Finding 6)               |
| §11 No optional interface methods                 | ✅     | All methods on `RuntimeClient` are required                                                                                                                    |
| §13 JSDoc — `@public` on every export             | ✅     | Public exports carry `@public`                                                                                                                                 |
| §15 Presets for zero-config                       | ✅     | `presets.all()` exists                                                                                                                                         |
| §19 Error design — actionable, code-tagged        | ⚠      | `RenderSupersededError`, `RenderAbortedError`, `RenderTimeoutError` are well-formed; missing: `KernelNotReadyError` for "command before connect"               |

The two ⚠s are tightly coupled: removing `notifyFileChanged` and replacing the missing high-level wrapper (`whenSettled`) addresses both §5 and §10.

## Target Architecture

### Layered design

```
┌─────────────────────────────────────────────────────────────────┐
│ CONSUMER (apps/ui hooks, rpc-handlers, cad.machine, tests)      │
│                                                                 │
│  const gen = client.setFile({ file, parameters });              │
│  const result = await client.whenSettled(gen);                  │
│                                                                 │
│  client.on('geometry', ({ result, generation }) => ...);        │
│  client.on('state', ({ state, generation }) => ...);            │
│  client.on('error', ({ issues, generation }) => ...);           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ RuntimeClient (high-level)                                       │
│                                                                 │
│  - Owns SAB allocation (geometry pool)                          │
│  - Mirrors `lastRequestedGeneration` and `lastSettledGeneration`│
│  - whenSettled(gen): waits for settled >= gen via SAB monitor   │
│  - setFiles(files): private op for inline-code render() path    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ RuntimeWorkerClient (low-level transport)                       │
│                                                                 │
│  - SAB monitor reads (workerState, latestGeneration) atomically │
│  - setFile/setParameters returns generation                     │
│  - All emissions stamped with generation                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│ Worker (KernelWorker + dispatcher)                              │
│                                                                 │
│  - Single-increment generation discipline                       │
│  - pushState writes (state, generation) to SAB                  │
│  - Dispatcher: stateChanged postMessage gated on !sabPresent    │
│  - geometryComputed/error always carry generation               │
│  - Bridge watch → autonomous reschedule (no main-thread relay)  │
└─────────────────────────────────────────────────────────────────┘
```

### SAB-first signalling, postMessage fallback

Each communication channel has a primary SAB path and a degradation path. Critical: when SAB is present, the postMessage path **must not also fire** for state-class events to avoid double delivery (Finding 7).

| Channel                    | SAB-first                                                                              | Fallback                                            | Dedup gate                                                     |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Render abort               | `Atomics.store(signalSlot.abortGeneration, n)`; OC Proxy reads at every WASM call      | `worker.terminate()` (nuclear; only if SAB unavail) | n/a (one-way main→worker)                                      |
| Worker state (idle/busy)   | `Atomics.store(signalSlot.workerState)` + `Atomics.notify`; main reads via `waitAsync` | `postMessage({ type: 'stateChanged', state, gen })` | Dispatcher: omit postMessage when `signalBuffer !== undefined` |
| Latest generation          | New: `Atomics.store(signalSlot.latestGeneration, n)` (paired with workerState write)   | `postMessage` carries `generation` field            | Same gate as workerState                                       |
| Progress percent           | `Atomics.store(signalSlot.progressPercent, n)` (no notify; polled by RAF)              | `postMessage({ type: 'progress', phase, detail })`  | Always send postMessage (cosmetic, low-frequency UI)           |
| Geometry payload           | `geometryPool.store(hash, glb)` → `{ delivery: 'pooled', key }`                        | `{ delivery: 'inline', bytes }` via `postMessage`   | n/a (always one path; payload too large for both)              |
| File content (bridge read) | `filePool.resolveCopy(path)` zero-IPC                                                  | Bridge RPC `readFile(path)`                         | n/a (reader checks pool first; fallback only on miss)          |

The unifying rule: **state-class deltas (workerState, latestGeneration) prefer SAB exclusively when present; payload-class deltas (geometry bytes, progress detail, errors) always travel via `postMessage` because they don't fit in fixed slots.**

### Generation as the universal correlator

Every command-issuing API returns a generation; every event carries the generation it corresponds to. The contract:

```typescript
// Commands
interface RuntimeClient {
  setFile(input: { file; parameters; options? }): number; // returns generation
  setParameters(parameters: Record<string, unknown>): number; // returns generation

  // High-level wrapper (subsumes setFile + whenSettled)
  render(input: FileInput | CodeInput): Promise<HashedGeometryResult>;

  // Low-level barrier
  whenSettled(
    generation: number,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<HashedGeometryResult>;

  // Read-only generation introspection (mirrors SAB)
  readonly lastRequestedGeneration: number;
  readonly lastSettledGeneration: number;
}

// Events
interface ClientEventMap {
  geometry: { result: HashedGeometryResult; generation: number };
  state: { state: WorkerState; generation: number; detail?: string };
  error: { issues: KernelIssue[]; generation: number };
  // unchanged:
  log: LogEntry;
  progress: { phase; detail };
  telemetry: PerformanceEntryData[];
  parametersResolved: GetParametersResult;
  capabilities: CapabilitiesManifest;
  activeKernel: string | undefined;
}
```

### Removal of notifyFileChanged

Public surface: deleted entirely. Consumers using filesystem mode receive autonomous re-renders; consumers using inline code call `render({ code })` which absorbs the cache invalidation internally via a private `RuntimeWorkerClient.setFiles({ files, paths })` operation. Test escape hatch lives behind `@taucad/runtime/testing`:

```typescript
// @taucad/runtime/testing
import { invalidateFileCache } from '@taucad/runtime/testing';
invalidateFileCache(client, ['/projects/test/main.ts']); // for harnesses that mutate FS directly
```

### Removal of cancelPendingRender

Drops out naturally when the legacy `'render'` command retires. `setFile` + `whenSettled` covers every use case; abort happens via SAB regardless.

## Recommendations

| #   | Action                                                                                                                                                                                                                 | Priority | Effort | Impact                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------------------------------------- |
| R1  | Add `signalSlot.latestGeneration` (grow `signalBufferByteLength` to 24); worker writes paired with `workerState` writes                                                                                                | P0       | Low    | Enables atomic (state, generation) reads on main thread                                 |
| R2  | Stamp `geometryComputed`, `error`, `stateChanged` responses with `generation: number`                                                                                                                                  | P0       | Low    | Enables consumer correlation                                                            |
| R3  | Change `setFile`/`setParameters` to return `number` (the generation they bumped to) on both `RuntimeClient` and `RuntimeWorkerClient`                                                                                  | P0       | Low    | Closes the request-correlation gap                                                      |
| R4  | Add `client.whenSettled(generation, options?)` and `client.lastSettledGeneration` getter                                                                                                                               | P0       | Med    | Single high-level barrier; eliminates per-consumer reinvention                          |
| R5  | Single-increment generation discipline in `executeRender` (drop the second bump)                                                                                                                                       | P0       | Low    | Predictable generation numbers; removes the off-by-one between main and worker          |
| R6  | Dispatcher: gate `stateChanged` postMessage on `!signalBuffer`; SAB monitor becomes the only state delivery path when SAB is present                                                                                   | P0       | Low    | Eliminates double-delivery (Finding 7)                                                  |
| R7  | Worker watch handler: bump `signalSlot.abortGeneration` and write `signalSlot.latestGeneration` symmetrically with `setFile`/`setParameters`                                                                           | P0       | Low    | Watch-driven re-renders are observable to the main thread via the same SAB protocol     |
| R8  | Delete `notifyFileChanged` from the public `RuntimeClient` interface; relocate the inline `render({ code })` invocation to a private `RuntimeWorkerClient.setFiles(...)` that bundles writes + invalidation atomically | P1       | Med    | Removes the dead command path; finishes the migration documented in runtime-topology.md |
| R9  | Move `notifyFileChanged` test escape hatch to `@taucad/runtime/testing` as `invalidateFileCache(client, paths)`                                                                                                        | P1       | Low    | Keeps headless harness/test ergonomics without polluting the public surface             |
| R10 | Retire `RuntimeCommand.'fileChanged'` from the protocol; remove dispatcher case and `KernelWorker.notifyFileChanged` (`_invalidateCachesForPaths` stays internal)                                                      | P1       | Low    | Cleans up the protocol; only retainable as `'invalidatePaths'` if R9 needs a wire op    |
| R11 | Retire `cancelPendingRender` and the `'render'`/`'cancel'` legacy commands once `render()` is rewritten as `setFile + whenSettled`                                                                                     | P2       | High   | Removes the last vestige of request/response orchestration                              |
| R12 | Document the SAB-vs-postMessage contract in `runtime-architecture-policy.md` so future plugins/middleware don't re-introduce double delivery                                                                           | P1       | Low    | Prevents regression of Finding 7 in plugin authoring                                    |
| R13 | Rename `RuntimeClient.notifyFileChanged` references in `apps/ui` to autonomous-watch reliance — no code change needed in production filesystem mode                                                                    | P0       | Low    | Audit confirms no production caller exists; staging/test paths only                     |
| R14 | Add `KernelNotReadyError` (`code: 'KERNEL_NOT_READY'`) for commands issued before connect — currently throws bare `Error('… must be called with a fileSystem')`                                                        | P2       | Low    | Aligns with [Library API Policy §19](../policy/library-api-policy.md#19-error-design)   |
| R15 | Add `client.terminate({ awaitInflight?: boolean })` to make the cleanup path observable; today `terminate()` discards in-flight renders silently                                                                       | P2       | Low    | Prevents teardown races in tests                                                        |

## Migration Path

A staged migration that keeps `apps/ui` compiling at every step:

### Stage 1 — additive runtime (backwards compatible)

1. R1, R2, R3, R5, R6, R7 land in `@taucad/runtime`. `notifyFileChanged` still exists; `setFile` becomes `: number` (consumers can ignore).
2. R4 ships `whenSettled` and `lastSettledGeneration`. No consumer required to use them yet.
3. R12 documents the dedup contract.

After Stage 1, every event carries a generation, the SAB latest-generation slot is live, and consumers can opt into the new barrier.

### Stage 2 — apps/ui adoption

4. `apps/ui/app/hooks/rpc-handlers.ts` switches to `client.whenSettled(client.setFile(...))` for all RPC surfaces.
5. `apps/ui/app/machines/cad.machine.ts` deletes the parallel `pendingRenderGeneration` shadow counter; reads `client.lastSettledGeneration` directly, listens to generation-tagged events.
6. The cross-cad-unit fan-out that the previous plan considered (project.machine listening to `FileContentService.onDidContentChange` and forwarding to `cadUnit`) becomes **unnecessary**: the FM worker's bridge watch already delivers to every kernel worker that subscribed.

### Stage 3 — public surface cleanup

7. R8, R9, R10: `notifyFileChanged` removed from public `RuntimeClient`; inline-code path uses internal `setFiles`; tests use `@taucad/runtime/testing`.
8. R13: confirm no `apps/ui` caller of `client.notifyFileChanged` survives (audit shows none today).
9. R14, R15: error and teardown polish.

### Stage 4 — legacy protocol retirement

10. R11: `RuntimeClient.render()` rewritten as `setFile + whenSettled`. `'render'`/`'cancel'` commands removed from `RuntimeCommand`. `cancelPendingRender` and `pendingRender` map deleted.

After Stage 4, the protocol is exactly the three commands and six events documented in [runtime-topology.md](../architecture/runtime-topology.md): `setFile`, `setParameters`, `export` in; `geometryComputed`, `parametersResolved`, `stateChanged`, `progress`, `error`, `log`/`telemetry` out. SAB carries `(abortGeneration, workerState, latestGeneration, progressPercent, abortReason)`.

## Code Examples

### Before — every consumer rebuilds the barrier

```typescript
// apps/ui/app/hooks/rpc-handlers.ts (current shape)
const cadUnit = await resolveOrCreateGeometryUnit(projectRef, file);
cadUnit.send({ type: 'setFile', file });
await waitFor(
  cadUnit,
  (s) => {
    // hand-rolled predicate trying to detect "settled and reflects my request"
    return s.matches('idle') && s.context.lastRenderedFile === file;
  },
  { timeout: 30_000 },
);
const geometry = cadUnit.getSnapshot().context.geometry;
```

### After — single primitive

```typescript
// apps/ui/app/hooks/rpc-handlers.ts (target shape)
const generation = client.setFile({ file, parameters });
const { result } = await client.whenSettled(generation, { timeoutMs: 30_000 });
return result;
```

The cad.machine becomes a thin XState reflection of `client.lastSettledGeneration` / `client.on('state')` — no parallel generation bookkeeping, no fan-out actor, no `fileWritten` event handler.

### Inline-code path (internal only)

```typescript
// runtime-client.ts render({ code }) replacement
async function render(input: CodeInput<...>): Promise<HashedGeometryResult> {
  const writes = Object.entries(input.code).map(([filename, content]) => ({
    absolutePath: ensureLeadingSlash(filename), content,
  }));
  await Promise.all(writes.map(({ absolutePath, content }) =>
    managedFileSystem.writeFile(absolutePath, content)));

  const client = await ensureConnected({ fileSystem: managedFileSystem });
  // PRIVATE: bundles writes + invalidation in one transport message,
  // bumps abortGeneration, returns the new generation.
  const generation = client.setFiles({
    paths: writes.map((w) => w.absolutePath),
    file: resolveFileString(input.file ?? Object.keys(input.code)[0]!),
    parameters: input.parameters ?? {},
    options: input.options,
  });
  return client.whenSettled(generation);
}
```

`setFiles` is internal to `@taucad/runtime`; the public API consumer never sees it. The inline-code authoring experience (`client.render({ code: { 'main.ts': source } })`) is unchanged.

## Diagrams

### Current (half-migrated)

```
   ┌─────────────────┐  setFile (void)
   │   Consumer      │──────────────────┐
   │ (rpc-handlers,  │  notifyFileChanged (public, redundant in fs mode)
   │   cad.machine)  │──────────────┐   │
   └────────┬────────┘              │   │
            │ on('state'),          │   │
            │ on('geometry')        ▼   ▼
            │           ┌────────────────────────────┐
            │           │      RuntimeClient         │
            │           │ (no generation correlator) │
            │           └─────────────┬──────────────┘
            │ ◀─ duplicate state delivery: SAB + postMessage (Finding 7)
            │                         │
   ┌────────▼─────────────────────────▼───────────────┐
   │ RuntimeWorkerClient                              │
   │  pendingRender map (legacy req/resp leftover)    │
   │  cancelPendingRender (legacy op)                 │
   └────────┬─────────────────────────────────────────┘
            │
   ┌────────▼─────────────────────────────────────────┐
   │ KernelWorker                                     │
   │  notifyFileChanged() — duplicate of watch handler│
   │  bridge watch → scheduleRender (autonomous, ok)  │
   │  pushState() writes BOTH SAB & callback          │
   └──────────────────────────────────────────────────┘
```

### Target (event-driven, SAB-first)

```
   ┌─────────────────┐  gen = setFile({ file, params })
   │   Consumer      │──────────────────────────┐
   │                 │  await whenSettled(gen)  │
   └────────┬────────┘──────────────────────────┤
            │ on('state',    { state, gen })    │
            │ on('geometry', { result, gen })   │
            │ on('error',    { issues, gen })   │
            │                                   │
   ┌────────▼───────────────────────────────────▼─┐
   │ RuntimeClient                                │
   │  whenSettled(n): atomic SAB read of          │
   │    (workerState, latestGeneration); resolves │
   │    when settled >= n                         │
   └────────┬─────────────────────────────────────┘
            │
   ┌────────▼─────────────────────────────────────┐
   │ RuntimeWorkerClient                          │
   │  setFile/setParameters returns generation    │
   │  SAB monitor: ONE delivery path for state    │
   └────────┬─────────────────────────────────────┘
            │
   ┌────────▼─────────────────────────────────────┐
   │ KernelWorker                                 │
   │  pushState writes SAB ONLY (when present)    │
   │  bridge watch → scheduleRender (unchanged)   │
   │  every emission stamped with generation      │
   └──────────────────────────────────────────────┘
```

## References

- [Library API Policy](../policy/library-api-policy.md)
- [Runtime Architecture Policy](../policy/runtime-architecture-policy.md)
- [Runtime Topology Architecture](../architecture/runtime-topology.md)
- [Shared Memory Geometry Pipeline Research](shared-memory-geometry-pipeline.md)
- [Runtime Client Type Safety Audit](runtime-client-type-safety-audit.md)
- [Capabilities Manifest API Audit](capabilities-manifest-api-audit.md)

## Appendix: API Surface Audit Table

`RuntimeClient` (consumer-facing) method audit. Status legend: ✅ keep, ⚠ refactor, ❌ remove.

| Method                        | Status | Rationale                                                                                                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect(options)`            | ✅     | Lazy init handle; aligns with [Library API Policy §9](../policy/library-api-policy.md#9-lazy-initialization-for-expensive-resources)              |
| `render({ file })`            | ⚠      | Refactor as sugar over `setFile + whenSettled`; drop `cancelPendingRender` callsite                                                               |
| `render({ code })`            | ⚠      | Refactor: writes via `managedFileSystem`, then `setFiles({ files, paths }) + whenSettled`; absorbs `notifyFileChanged` privately                  |
| `export(format, input?)`      | ✅     | Aligned with target; preserves self-rendering sugar                                                                                               |
| `setFile(file, params?)`      | ⚠      | Change return type from `void` → `number` (generation)                                                                                            |
| `setParameters(params)`       | ⚠      | Change return type from `void` → `number` (generation)                                                                                            |
| `setRenderTimeout(s)`         | ✅     | Already SAB-aware                                                                                                                                 |
| `notifyFileChanged(paths)`    | ❌     | Remove from public surface. Inline `render({ code })` absorbs internally; tests use `@taucad/runtime/testing`                                     |
| `whenSettled(gen)`            | ➕     | New high-level barrier; closes [Library API Policy §10](../policy/library-api-policy.md#10-high-level-wrappers-with-low-level-escape-hatches) gap |
| `lastSettledGeneration`       | ➕     | New read-only mirror of SAB; consumers introspect without subscribing                                                                             |
| `lastRequestedGeneration`     | ➕     | New read-only mirror of `setFile`/`setParameters`'s last return value                                                                             |
| `on('geometry', h)`           | ⚠      | Stamp emission with `generation`                                                                                                                  |
| `on('state', h)`              | ⚠      | Stamp emission with `generation`; deliver via SAB monitor only when SAB present                                                                   |
| `on('error', h)`              | ⚠      | Stamp emission with `generation`                                                                                                                  |
| `on('progress', h)`           | ✅     | Cosmetic; postMessage delivery is correct                                                                                                         |
| `on('log', h)`                | ✅     | Cosmetic; postMessage delivery is correct                                                                                                         |
| `on('telemetry', h)`          | ✅     | Cosmetic; postMessage delivery is correct                                                                                                         |
| `on('parametersResolved', h)` | ✅     | Domain payload; unchanged                                                                                                                         |
| `on('capabilities', h)`       | ✅     | Manifest replay-on-subscribe per [capabilities-manifest-api-audit.md](capabilities-manifest-api-audit.md)                                         |
| `on('activeKernel', h)`       | ✅     | Unchanged                                                                                                                                         |
| `routesFor(format)`           | ✅     | Pure projection over `_capabilities`                                                                                                              |
| `bestRouteFor(format, k?)`    | ✅     | Pure projection over `_capabilities`                                                                                                              |
| `terminate()`                 | ⚠      | Add optional `{ awaitInflight?: boolean }` to make teardown observable in tests (R15)                                                             |
| `geometryPool` (getter)       | ✅     | Domain-owned SAB pool; consumers needing zero-IPC reads keep direct access                                                                        |
| `capabilities` (getter)       | ✅     | Mirror of last manifest                                                                                                                           |
| `activeKernelId` (getter)     | ✅     | Mirror of last active kernel                                                                                                                      |

`RuntimeCommand` (wire) protocol audit. Stage 4 target shape:

| Command            | Status (target) | Rationale                                                                       |
| ------------------ | --------------- | ------------------------------------------------------------------------------- |
| `initialize`       | ✅              | Bootstrap                                                                       |
| `setFile`          | ✅              | Autonomous render trigger                                                       |
| `setParameters`    | ✅              | Autonomous render trigger                                                       |
| `setFiles` (NEW)   | ➕              | Internal: bundles writes + cache invalidation atomically for inline-code mode   |
| `export`           | ✅              | Format-specific export                                                          |
| `setRenderTimeout` | ✅              | Wall-clock timeout                                                              |
| `setMiddleware`    | ✅              | Reconfigure                                                                     |
| `loadBundler`      | ✅              | Bundler init                                                                    |
| `cleanup`          | ✅              | Worker teardown                                                                 |
| `render`           | ❌              | Legacy request/response — retire in Stage 4                                     |
| `cancel`           | ❌              | Pairs with legacy `render`                                                      |
| `fileChanged`      | ❌              | Superseded by autonomous bridge watch + private `setFiles` for inline-code mode |

`signalSlot` SAB layout audit. Stage 1 target:

| Slot index | Name                  | Direction   | Mechanism                                       | Required by                                                       |
| ---------- | --------------------- | ----------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| 0          | `abortGeneration`     | main→worker | `Atomics.store` polled by OC Proxy              | Existing                                                          |
| 1          | `workerState`         | worker→main | `Atomics.store` + `Atomics.notify`; `waitAsync` | Existing                                                          |
| 2          | `progressPercent`     | worker→main | `Atomics.store` polled                          | Existing                                                          |
| 3          | `abortReason`         | main→worker | `Atomics.store` polled by worker                | Existing                                                          |
| 4          | `latestGeneration` ➕ | worker→main | `Atomics.store` paired with `workerState`       | R1 — enables `whenSettled` to read (state, generation) atomically |
| 5          | reserved              | n/a         | n/a                                             | Pad to 24 bytes (alignment + future headroom)                     |

Total: `signalBufferByteLength = 24` (6 × `Int32`).
