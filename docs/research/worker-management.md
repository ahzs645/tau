# Worker Management: Current State Analysis

> **Last updated**: 2026-03-02
> **Scope**: Comprehensive inventory of all Web Worker management across the Tau codebase, lifecycle analysis, and identified issues
> **Status**: Issues 1 and 2 resolved. See updates below.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Worker Inventory](#worker-inventory)
3. [Lifecycle Analysis by Subsystem](#lifecycle-analysis-by-subsystem)
4. [XState Actor Hierarchy](#xstate-actor-hierarchy)
5. [Identified Issues](#identified-issues)
6. [Memory Profile](#memory-profile)
7. [Improvement Priorities](#improvement-priorities)

---

## Executive Summary

The application manages **6 distinct worker types** across 3 lifecycle patterns:

| Pattern | Workers | Mechanism | Status |
|---|---|---|---|
| **XState-managed** | kernel-runtime, file-manager, object-store | Machine exit actions + `stopChild` | Corrected: error-isolated cleanup, invoked actors with AbortSignal |
| **Manual lifecycle** | KCL LSP | `initialize()`/`dispose()` | Correct but depends on registry disposal |
| **Framework-managed** | Monaco (JSON, TS, Editor) | Monaco internals | Uncontrolled; no explicit termination |

**Status update**: Issues 1 and 2 below have been fully resolved:
1. ~~Fire-and-forget async patterns in XState actions that escape machine lifecycle~~ — **Resolved**: `fireRender` converted to invoked `renderActor` with AbortSignal
2. ~~Missing error isolation in cleanup chains~~ — **Resolved**: All cleanup uses `safeDispose()` from `@taucad/utils/dispose`
3. `@xstate/react`'s `stopRootWithRehydration` restoring pre-stop snapshots (interferes with Strict Mode) — mitigated by using `assign()` instead of direct mutation
4. No centralized worker registry for lifecycle auditing — open

---

## Worker Inventory

### 1. Kernel Runtime Workers

| Property | Value |
|---|---|
| **Creation** | `createWorkerTransport()` → `new Worker(workerUrl, { type: 'module' })` |
| **Entry module** | `kernel-runtime-worker.ts` |
| **Size** | 120-175 MB per instance (includes WASM heap) |
| **Termination** | `kernelClient.terminate()` → `workerClient.terminate()` → `transport.close()` → `worker.terminate()` |
| **Owner** | `kernel.machine.ts` via `destroyWorkers` exit action |
| **Expected count** | 1 per compilation unit (typically 1 per build) |
| **Observed count** | 5-15+ (accumulating across navigation) |

**Termination chain**:
```
Component unmount
→ useActorRef cleanup (stopRootWithRehydration)
  → cadMachine.stop()
    → stopChildren(kernelRef)
      → kernelMachine receives XSTATE_STOP
        → exit: destroyWorkers
          → context.kernelClient.terminate()
            → transport.close()
              → worker.terminate()
```

**Files**:
- `packages/kernels/src/transport/worker-transport.ts` — Worker creation and `close()`
- `packages/kernels/src/client/kernel-client.ts` — `terminate()` method
- `packages/kernels/src/framework/kernel-worker-client.ts` — `cleanup()` + `terminate()`
- `apps/ui/app/machines/kernel.machine.ts` — `destroyWorkers` action, `initKernelActor`, `renderActor`

### 2. File Manager Worker

| Property | Value |
|---|---|
| **Creation** | `new FileManagerWorker({ name: 'fm-root' })` via Vite `?worker` import |
| **Entry module** | `file-manager.worker.ts` |
| **Size** | ~19 MB |
| **Termination** | `destroyWorker` machine exit action |
| **Owner** | `file-manager.machine.ts` |
| **Expected count** | 1 (root, shared via `SharedWorkerContext`) |
| **Observed count** | 1 (correct) |

**Design**: Single root worker pattern. Nested `FileManagerProvider` instances receive a shared reference via React context rather than creating their own workers. This is correct.

**Files**:
- `apps/ui/app/machines/file-manager.machine.ts` — Machine with `initializeWorkerActor`/`destroyWorker`
- `apps/ui/app/machines/file-manager.worker.ts` — Worker entry using `exposeFileSystem()`
- `apps/ui/app/hooks/use-file-manager.tsx` — Provider with `SharedWorkerContext`

### 3. Object Store Worker

| Property | Value |
|---|---|
| **Creation** | `new ObjectStoreWorker()` via Vite `?worker` import |
| **Entry module** | `object-store.worker.ts` |
| **Size** | ~8.5 MB |
| **Termination** | `destroyWorker` machine exit action |
| **Owner** | `build-manager.machine.ts` |
| **Expected count** | 1 (per build manager) |
| **Observed count** | 1 (correct) |

**Note**: Still uses Comlink (`expose`/`wrap`). This is the last remaining Comlink usage in the codebase.

**Files**:
- `apps/ui/app/hooks/build-manager.machine.ts` — Machine with worker lifecycle
- `apps/ui/app/hooks/object-store.worker.ts` — Worker entry using Comlink `expose()`

### 4. KCL LSP Worker

| Property | Value |
|---|---|
| **Creation** | `new Worker(new URL('kcl-lsp-worker.ts', import.meta.url), { type: 'module', name: 'kcl-lsp' })` |
| **Entry module** | `kcl-lsp-worker.ts` |
| **Size** | ~15 MB |
| **Termination** | `lspClient.dispose()` → `worker.terminate()` |
| **Owner** | `KclLspClient` via `kcl-register-language.ts` contribution registry |
| **Expected count** | 0-1 (only when KCL language is active) |
| **Observed count** | Typically correct |

**Risk**: Disposal depends on `monacoLanguageRegistry.dispose()` → `kclContribution.dispose()` → `disposeKclLsp()` → `lspClient.dispose()`. If the registry is never disposed, the worker leaks.

**Files**:
- `apps/ui/app/lib/kcl-language/lsp/kcl-lsp-client.ts` — Worker creation and `dispose()`
- `apps/ui/app/lib/kcl-language/kcl-register-language.ts` — Registration and disposal

### 5. Monaco Editor Workers

| Property | Value |
|---|---|
| **Creation** | `MonacoEnvironment.getWorker()` returns `new JsonWorker()`, `new TsWorker()`, `new EditorWorker()` |
| **Entry module** | Various (bundled by monaco-editor) |
| **Size** | Variable |
| **Termination** | Monaco-managed (no explicit `terminate()` in codebase) |
| **Owner** | Monaco internals |
| **Expected count** | Up to 3 (JSON, TypeScript, Editor) |

**Risk**: Monaco workers are never explicitly terminated. Their lifecycle is fully managed by the Monaco editor instance. If the editor is disposed, Monaco should clean up. But there is no explicit editor disposal in the current codebase; it relies on garbage collection.

**Files**:
- `apps/ui/app/lib/monaco.ts` — `MonacoEnvironment.getWorker` configuration

### 6. Kernel Model View Worker (Docs)

| Property | Value |
|---|---|
| **Creation** | `createKernelClient()` inside `IntersectionObserver` callback |
| **Entry module** | Same kernel-runtime-worker |
| **Size** | 120+ MB |
| **Termination** | `clientRef.current?.terminate()` in `useEffect` cleanup |
| **Owner** | `kernel-model-view.tsx` component via `useRef` |
| **Expected count** | 0-N (one per visible model in docs) |

**Risk**: Race condition between `IntersectionObserver` triggering creation and component unmount. If the component unmounts while `initializeAndRender` is in-flight, the worker may be created after the cleanup ran.

**Files**:
- `apps/ui/app/components/docs/kernel-model-view.tsx`

---

## Lifecycle Analysis by Subsystem

### Kernel Worker Lifecycle (Critical Path)

```
CadPreviewProvider mount / BuildProvider mount
  → useActorRef(cadMachine)
    → cadMachine spawns kernelMachine as kernelRef
      → kernelMachine starts in 'initializing'
        → 'initializeKernel' event → 'connectingKernel' state
          → invoke: initKernelActor (creates KernelClient + Worker)
            → onDone → 'ready' state
              → 'createGeometry' event → 'rendering' state
                → invoke: renderActor (AbortSignal-cancellable)
```

**Teardown path**:
```
Component unmount / route change
  → useActorRef cleanup: stopRootWithRehydration(cadRef)
    → cadRef.stop()
      → cadMachine XSTATE_STOP
        → stopChildren: stops kernelRef
          → kernelMachine XSTATE_STOP
            → exit: destroyWorkers (assign action)
              → safeDispose(each eventCleanup) — error-isolated
              → safeDispose(kernelClient?.terminate())
                → worker.terminate()
```

### Build-to-Build Navigation

The `BuildProvider` correctly handles `buildId` changes:

```typescript
// use-build.tsx line 170-176
useEffect(() => {
  actorRef.send({ type: 'loadBuild', buildId });
  editorRef.send({ type: 'reload', buildId });
}, [actorRef, buildId, editorRef]);
```

The `buildMachine` processes `loadBuild` with `isBuildIdChanging` guard:
```
loadBuild (buildId changed)
  → stopStatefulActors: stopChild(gitRef), stopChild(each compilationUnit), stopChild(each viewGraphics)
  → respawnStatefulActors: fresh git, empty compilationUnits, empty viewGraphics
  → setLoading → re-invoke loadBuildActor
```

This correctly terminates old kernel workers when switching builds within the same `BuildProvider` instance.

### Project Grid Preview Lifecycle

```
ProjectCard → toggle preview ON
  → setActivated(true), setVisible(true)
    → CadPreviewProvider mounts
      → cadRef = useActorRef(cadMachine)
      → cadPreviewMachine orchestrates file writing + kernel init
        → kernel worker created

ProjectCard → toggle preview OFF
  → setVisible(false) (CadPreviewProvider stays mounted due to activated state)
    → Worker stays alive (intentional: warm worker for re-toggle)

Page navigation away from project grid
  → ProjectCard unmounts
    → CadPreviewProvider unmounts (if activated)
      → useActorRef cleanup → cadRef.stop() → kernel worker terminated (SHOULD work)
```

---

## XState Actor Hierarchy

```
BuildProvider (useActorRef)
  └─ buildMachine
       ├─ gitMachine (spawned)
       ├─ logMachine (spawned)
       ├─ compilationUnits: Map<string, cadMachine> (spawned)
       │   └─ cadMachine
       │       └─ kernelMachine (spawned)
       │           └─ KernelClient → Web Worker (manual lifecycle)
       └─ viewGraphics: Map<string, graphicsMachine> (spawned)

CadPreviewProvider (useActorRef)
  ├─ cadMachine (standalone, NOT spawned by buildMachine)
  │   └─ kernelMachine (spawned)
  │       └─ KernelClient → Web Worker
  ├─ graphicsMachine (standalone)
  └─ cadPreviewMachine (standalone, sends events to cadRef)

FileManagerProvider (useActorRef)
  └─ fileManagerMachine
       └─ File Manager Worker (manual lifecycle)

BuildManagerProvider (useActorRef)
  └─ buildManagerMachine
       └─ Object Store Worker (manual lifecycle, Comlink)
```

---

## Identified Issues

### Issue 1: ~~Fire-and-Forget Async in `fireRender`~~ (RESOLVED)

**Location**: `apps/ui/app/machines/kernel.machine.ts:251-283`

```typescript
fireRender({ context, event, self }) {
  void (async () => {
    const client = await ensureKernelClient(context, self);
    await client.render({ ... });
  })();
}
```

**Problem**: XState actions are synchronous. The `void (async () => { ... })()` pattern creates an async task that is completely invisible to XState's lifecycle management. When the machine stops:
- The async function continues running independently
- `ensureKernelClient` may be mid-`await` and will resume after `destroyWorkers` has run
- The `context.destroyed` guard mitigates the creation race, but does not handle in-flight render operations

**Impact**: Medium. The `destroyed` guard prevents worker creation after stop, but the fire-and-forget pattern is architecturally unsound and fragile.

**Recommendation**: Convert to an invoked `fromPromise` or `fromCallback` actor, which XState automatically cancels on state exit (via `AbortController` for promises).

### Issue 2: ~~Missing Error Isolation in Cleanup Chain~~ (RESOLVED)

**Location**: `apps/ui/app/machines/kernel.machine.ts:285-298`

```typescript
destroyWorkers({ context }) {
  context.destroyed = true;
  for (const cleanup of context.eventCleanups) {
    cleanup();  // If this throws, subsequent cleanups AND terminate() are skipped
  }
  context.eventCleanups = [];
  if (context.kernelClient) {
    context.kernelClient.terminate();
    context.kernelClient = undefined;
  }
}
```

**Problem**: The `eventCleanups` array includes bridge `dispose()` functions and event unsubscribe functions. If ANY of these throws an exception, the loop halts and `kernelClient.terminate()` is never called. The worker leaks.

**Impact**: High. A single failing cleanup function prevents worker termination.

**Recommendation**: Wrap each cleanup call in a try/catch. Always ensure `kernelClient.terminate()` runs regardless of cleanup errors.

### Issue 3: `stopRootWithRehydration` Snapshot Restoration (MEDIUM)

**Location**: `@xstate/react` v5.0.5, `useActorRef` cleanup

```javascript
// Captures snapshot BEFORE stop
forEachActor(actorRef, ref => {
  persistedSnapshots.push([ref, ref.getSnapshot()]);
});
actorRef.stop();  // Exit actions run, workers terminated
// Restores ORIGINAL snapshot (before stop!)
persistedSnapshots.forEach(([ref, snapshot]) => {
  ref._processingStatus = 0;
  ref._snapshot = snapshot;
});
```

**Problem**: The `@xstate/react` hook captures actor snapshots before stop, then restores them after stop. This is designed for React Strict Mode (double-effect execution). In Strict Mode, the restored snapshot may reference a terminated `kernelClient`, and the `destroyed` flag is reset to `false`. On re-start, `ensureKernelClient` would return the terminated client instead of creating a new one.

**Impact**: Medium in development (Strict Mode). No impact in production.

**Recommendation**: Design `destroyWorkers` to be idempotent and verifiable. Check worker state on re-use rather than assuming context integrity after stop/restart cycles.

### Issue 4: No Centralized Worker Registry (MEDIUM)

**Problem**: Each worker type has its own creation and termination pattern. There is no single place to:
- Query how many workers exist
- Verify all workers were cleaned up
- Set limits on total worker count
- Detect orphaned workers

**Impact**: Makes debugging worker leaks extremely difficult. The Memory tab in DevTools is the only way to see worker count.

**Recommendation**: Create a `WorkerRegistry` that tracks all worker creation/termination, enforces limits, and provides diagnostic APIs.

### Issue 5: Kernel Model View Race Condition (LOW)

**Location**: `apps/ui/app/components/docs/kernel-model-view.tsx`

**Problem**: Two separate `useEffect` hooks with `[]` deps: one creates the client on intersection visibility, another terminates on unmount. If the component unmounts while `initializeAndRender` is in progress, the creation may complete after the cleanup effect ran.

**Impact**: Low — narrow race window, docs-only context.

**Recommendation**: Use a single `useEffect` with an `AbortController` or `cancelled` flag.

### Issue 6: Monaco Workers Not Managed (LOW)

**Problem**: Monaco editor creates up to 3 workers (JSON, TypeScript, Editor) via `MonacoEnvironment.getWorker`. These are never explicitly terminated. Lifecycle is fully under Monaco's control.

**Impact**: Low — Monaco generally manages its own workers. But when the editor is fully unmounted (e.g., navigating away from build page), Monaco workers may persist until GC collects the Monaco instance.

**Recommendation**: Call `editor.dispose()` on Monaco editor instances during component cleanup.

### Issue 7: Object Store Still Uses Comlink (LOW)

**Problem**: The object-store worker is the last remaining Comlink usage. It uses `Comlink.expose()` and `Comlink.wrap()`. This prevents transfer list control and adds unnecessary dependency overhead.

**Impact**: Low — the object-store handles small payloads (build metadata, editor state).

**Recommendation**: Migrate to the custom bridge pattern (`createBridgeServer`/`createBridgeProxy`) for consistency and eventual Comlink removal.

---

## Memory Profile

Observed memory distribution from a typical session with preview usage:

| Worker | Count | Memory Each | Total |
|---|---|---|---|
| kernel-runtime-worker | 8-15 | 120-175 MB | 960-2,625 MB |
| fm-root (file manager) | 1 | 19 MB | 19 MB |
| object-store | 1 | 8.5 MB | 8.5 MB |
| Monaco workers | 2-3 | 5-15 MB | 10-45 MB |
| Main thread | 1 | 174 MB | 174 MB |
| **Total** | | | **1,172-2,872 MB** |

The kernel runtime workers dominate memory consumption due to WASM heap allocations (OpenCASCADE, esbuild). Each worker maintains its own V8 isolate (~1.5 MB baseline) plus the WASM linear memory (up to 256 MB for OpenCASCADE).

**Mobile impact**: On iOS Safari, total page memory is limited to ~100-300 MB depending on device. A single kernel worker at 120 MB is already near the limit. Multiple workers will cause tab crashes.

---

## Improvement Priorities

### P0: Critical (Worker Leaks) — RESOLVED

1. ~~**Error-isolate cleanup chains**~~ — **Done**: All cleanup chains use `safeDispose()` utility
2. ~~**Convert `fireRender` to invoked actor**~~ — **Done**: Replaced with `initKernelActor` + `renderActor`, both with AbortSignal support

### P1: High (Memory Optimization)

3. **Worker count limits**: Cap concurrent kernel workers based on `navigator.hardwareConcurrency` (max 2 on mobile, max `hardwareConcurrency` on desktop)
4. **Idle worker termination**: Terminate kernel workers that have been idle for >60s in preview contexts
5. **Centralized worker registry**: Track all active workers for diagnostics and limit enforcement

### P2: Medium (Architecture)

6. **Migrate object-store from Comlink to bridge**: Eliminate last Comlink usage
7. **Monaco editor disposal**: Explicitly dispose Monaco editor instances on route unmount
8. **Kernel model view abort**: Add AbortController to docs kernel model view

### P3: Low (Future)

9. **Worker pooling**: Reuse kernel workers across builds of the same kernel type
10. **SharedArrayBuffer FS**: Evaluate ZenFS `SingleBuffer` backend for synchronous FS access without MessagePort overhead
