---
title: 'XState Patterns: Current State Analysis'
description: 'Comprehensive audit of XState v5 usage in Tau, identifying good patterns and areas for improvement.'
status: active
created: '2026-03-04'
updated: '2026-03-05'
category: audit
related:
  - docs/policy/xstate-policy.md
---

# XState Patterns: Current State Analysis

## Table of Contents

1. [Overview](#overview)
2. [Machine Inventory](#machine-inventory)
3. [Good Patterns](#good-patterns)
4. [Anti-Patterns and Issues](#anti-patterns-and-issues)
5. [Testing Gap](#testing-gap)
6. [Improvement Priorities](#improvement-priorities)

---

## Overview

The codebase uses XState v5 extensively with **25+ machine definitions** across UI state management, worker lifecycle, I/O operations, and rendering pipelines. The overall adoption is strong — machines are well-structured with `setup()`, proper type annotations, and the actor model.

However, several anti-patterns have been identified that contribute to resource leaks, unpredictable behavior, and maintainability issues.

---

## Machine Inventory

| Machine                 | File                               | States         | Exit Actions                       | Key Actors                                                                      |
| ----------------------- | ---------------------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `build`                 | `project.machine.ts`               | 6+ (parallel)  | `stopStatefulActors`               | `spawn('git')`, `spawn('cad')`, `spawn('logs')`, `spawn('graphics')`            |
| `cad`                   | `cad.machine.ts`                   | 8              | **None**                           | `spawn(kernelMachine)`                                                          |
| `kernel`                | `kernel.machine.ts`                | 5              | `destroyWorkers`                   | `invoke(initKernelActor)`, `invoke(renderActor)`, `invoke(exportGeometryActor)` |
| `file-manager`          | `file-manager.machine.ts`          | 4              | `stopFileWatcher`, `destroyWorker` | `spawnChild('readDirectoryActor')`, `spawnChild('fileWatcherActor')`            |
| `build-manager`         | `project-manager.machine.ts`       | 4              | `destroyWorker`                    | `invoke(initializeWorkerActor)`                                                 |
| `graphics`              | `graphics.machine.ts`              | 15+ (parallel) | **None**                           | —                                                                               |
| `editor`                | `editor.machine.ts`                | 5              | **None**                           | `invoke(loadEditorStateActor)`, `invoke(saveEditorStateActor)`                  |
| `git`                   | `git.machine.ts`                   | 15+            | **None**                           | `invoke(initGitActor, cloneRepositoryActor, ...)`, `buildListenerActor`         |
| `cad-preview`           | `cad-preview.machine.ts`           | 4              | **None**                           | `invoke(prepareFilesActor)`                                                     |
| `import-github`         | `import-github.machine.ts`         | 15+            | **None**                           | `invoke(getRepoMetadataActor, ...)`                                             |
| `import-disk`           | `import-disk.machine.ts`           | 8              | **None**                           | `invoke(readFilesActor, ...)`                                                   |
| `export-geometry`       | `export-geometry.machine.ts`       | 2              | **None**                           | `invoke(cadListener)`                                                           |
| `logs`                  | `logs.machine.ts`                  | 1              | **None**                           | —                                                                               |
| `parameter`             | `parameter.machine.ts`             | 6              | **None**                           | —                                                                               |
| `camera-capability`     | `camera-capability.machine.ts`     | 3              | **None**                           | `invoke(resetCamera)`                                                           |
| `screenshot-capability` | `screenshot-capability.machine.ts` | 4              | **None**                           | `invoke(capture*)`                                                              |
| `screenshot-request`    | `screenshot-request.machine.ts`    | 2              | **None**                           | `invoke(graphicsListener)`                                                      |
| `controls-listener`     | `controls-listener.machine.ts`     | 1              | `stopControlsMonitoring`           | `invoke(controlsMonitor)`                                                       |
| `webgl-context`         | `webgl-context.machine.ts`         | flat           | **None**                           | —                                                                               |
| `zip`                   | `zip.machine.ts`                   | 4              | **None**                           | `invoke(generateZipActor)`                                                      |
| `unzip`                 | `unzip.machine.ts`                 | 3              | **None**                           | `invoke(extractZipActor)`                                                       |
| `draft`                 | `draft.machine.ts`                 | 4              | **None**                           | `invoke(persistDraftActor, ...)`                                                |
| `chat-persistence`      | `chat-persistence.machine.ts`      | 4              | **None**                           | `invoke(loadChatActor, ...)`                                                    |
| `chat-mode`             | `chat-mode.machine.ts`             | 3              | **None**                           | —                                                                               |
| `auth-splashback`       | `auth-splashback.machine.ts`       | 3              | **None**                           | —                                                                               |

**Key observation**: Only **5 of 25 machines** have exit actions for cleanup (4 original + `projectMachine` added). The rest rely on XState's built-in `stopChildren` behavior. All cleanup chains are now error-isolated via `safeDispose()` from `@taucad/utils/dispose`.

---

## Good Patterns

### 1. Consistent `setup()` API usage

All machines use the v5 `setup({}).createMachine()` pattern with proper type declarations:

```typescript
export const kernelMachine = setup({
  types: {
    context: {} as KernelContext,
    events: {} as KernelEvent,
    input: {} as KernelInput,
  },
  actors: kernelActors,
  actions: {
    /* ... */
  },
}).createMachine({
  /* ... */
});
```

### 2. `useActorRef` + `useSelector` for React integration

The codebase consistently uses `useActorRef` (not `useMachine`) paired with `useSelector` for fine-grained re-render control:

```typescript
const actorRef = useActorRef(projectMachine, { input: { ... } });
const compilationUnits = useSelector(actorRef, (state) => state.context.compilationUnits);
```

~~**One exception**: `auth-splashback.tsx` uses `useMachine` — should be migrated.~~ **Resolved**: migrated to `useActorRef` + `useSelector`.

### 3. `machine.provide()` for dependency injection

Build and preview providers correctly use `.provide()` to inject environment-specific actors:

```typescript
const actorRef = useActorRef(
  projectMachine.provide({
    actors: {
      loadProjectActor: fromPromise(async ({ input }) => {
        /* ... */
      }),
    },
  }),
  { input: { projectId } },
);
```

### 4. Event emission for decoupled communication

Machines use `emit()` for parent-facing events rather than tight coupling:

```typescript
emitProjectLoaded: emit(({ event }) => ({
  type: 'projectLoaded' as const,
  project: event.output,
})),
```

### 5. `assertEvent()` for type narrowing

Most action handlers use `assertEvent` for runtime+type safety:

```typescript
registerParentRef: assign({
  parentRef({ event }) {
    assertEvent(event, 'initializeKernel');
    return event.parentRef;
  },
}),
```

### 6. `enqueueActions` for conditional multi-action flows

Complex conditional logic correctly uses `enqueueActions`:

```typescript
stopStatefulActors: enqueueActions(({ enqueue, context }) => {
  enqueue.stopChild(context.gitRef);
  for (const unit of context.compilationUnits.values()) {
    enqueue.stopChild(unit);
  }
  for (const gfx of context.viewGraphics.values()) {
    enqueue.stopChild(gfx);
  }
}),
```

### 7. `fromCallback` with cleanup functions

Long-running actors correctly return cleanup functions:

```typescript
// controls-listener.machine.ts
fromCallback(({ sendBack, receive, input }) => {
  const controls = input.controls;
  const handler = () => {
    sendBack({ type: 'controlsChanged' });
  };
  controls.addEventListener('change', handler);
  return () => {
    controls.removeEventListener('change', handler);
  };
});
```

---

## Anti-Patterns and Issues

### AP-1: ~~Fire-and-Forget Async in Actions~~ (RESOLVED)

**Location**: `kernel.machine.ts:251-283`

```typescript
fireRender({ context, event, self }) {
  assertEvent(event, 'createGeometry');
  void (async () => {
    try {
      const client = await ensureRuntimeClient(context, self);
      await client.render({ ... });
    } catch (error) { /* ... */ }
  })();
}
```

**Problem**: XState actions are synchronous and fire-and-forget by design. The `void (async () => { ... })()` pattern creates an async task completely invisible to XState. The machine has no visibility into the async operation and cannot cancel it on state exit or machine stop.

**Why it matters**: If the machine stops while `ensureRuntimeClient` is awaiting, the async function continues running independently. The `context.destroyed` guard mitigates creation races, but the pattern is architecturally fragile.

**Fix**: Convert to an invoked `fromPromise` actor in the `rendering` state. XState automatically aborts the promise via `AbortSignal` on state exit:

```typescript
rendering: {
  invoke: {
    src: fromPromise(async ({ input, signal }) => {
      const client = await ensureRuntimeClient(input.context, signal);
      return client.render({ file: input.file, parameters: input.parameters });
    }),
    input: ({ context, event }) => ({ context, ...event }),
    onDone: { /* ... */ },
    onError: { /* ... */ },
  },
}
```

### AP-2: ~~Direct Context Mutation~~ (RESOLVED)

**Locations**:

- `kernel.machine.ts:46` — `context.kernelClient = client` (inside `ensureRuntimeClient`)
- `kernel.machine.ts:286-296` — `context.destroyed = true`, `context.eventCleanups = []`, `context.kernelClient = undefined`
- `file-manager.machine.ts:92-94` — `context.worker`, `context.proxy`, `context.bridgeDispose` (inside `fromPromise` output)
- `file-manager.machine.ts:331-343` — `context.proxy`, `context.bridgeDispose`, `context.worker` in `destroyWorker`
- `camera-capability.machine.ts:56` — `context.resetFunction = event.reset`
- `project-manager.machine.ts:31-32` — `context.worker`, `context.wrappedWorker`
- `logs.machine.ts:40,57` — `context.logBuffer.push(...)` inside `assign`

**Problem**: XState docs explicitly state: "Do not mutate the context object." Direct mutation bypasses XState's immutability model, can cause issues with devtools inspection, state persistence, and the `stopRootWithRehydration` pattern in `@xstate/react` (which captures and restores snapshots).

**Why it matters for workers**: When `@xstate/react`'s `stopRootWithRehydration` captures the snapshot before `destroyWorkers` runs and then restores it, the `destroyed` flag is reset to `false` and `kernelClient` is restored to its pre-stop value. In React Strict Mode, this means the restarted actor has a reference to a terminated worker.

**Fix**: Use `assign()` for all context updates. For `ensureRuntimeClient`, return values from the async operation and use `assign` in `onDone`:

```typescript
// Instead of mutating context inside ensureRuntimeClient:
invoke: {
  src: fromPromise(async ({ input }) => {
    const client = createRuntimeClient(input.kernelOptions);
    const bridge = createFileSystemBridge(input.worker);
    await client.connect({ port: bridge.port });
    return { client, bridgeDispose: bridge.dispose };
  }),
  onDone: {
    actions: assign({
      kernelClient: ({ event }) => event.output.client,
      eventCleanups: ({ context, event }) => [...context.eventCleanups, event.output.bridgeDispose],
    }),
  },
}
```

### AP-3: ~~Missing Exit Actions on `projectMachine`~~ (RESOLVED)

**Location**: `project.machine.ts`

**Problem**: The `projectMachine` spawns `gitRef`, `compilationUnits` (cad machines), and `viewGraphics` (graphics machines) but has **no `exit` action**. Cleanup only happens via `stopStatefulActors` when a `loadProject` event with `isProjectIdChanging` fires. If the machine stops for any other reason (component unmount), cleanup depends entirely on XState's internal `stopChildren` behavior.

The XState v5 source contains a TODO comment:

```
// TODO: atm children don't belong entirely to the actor so
// in a way - it's not even super aware of them
// so we can't stop them from here but we really should!
// right now, they are being stopped within the machine's transition
// but that could throw and leave us with "orphaned" active actors
```

**Fix**: Add explicit exit action:

```typescript
exit: ['stopStatefulActors'],
```

### AP-4: ~~Non-null Assertions on Actor Refs (`parentRef!`)~~ (RESOLVED)

**Location**: `kernel.machine.ts:354,364,374,383,392,424,431`

```typescript
sendTo(
  ({ context }) => context.parentRef!,
  ({ event }) => { /* ... */ },
),
```

**Problem**: `context.parentRef` is `undefined` until `initializeKernel` is processed. The non-null assertion `!` bypasses TypeScript's safety. While `parentRef` should always be set by the time these `sendTo` calls execute (they're in `rendering`/`exporting` states, which are only reachable after `initializeKernel`), this is a fragile assumption.

**Fix**: Use `enqueueActions` with a guard, or restructure to make `parentRef` required:

```typescript
// Option A: Guard
enqueueActions(({ context, event, enqueue }) => {
  if (context.parentRef) {
    enqueue.sendTo(context.parentRef, event);
  }
});

// Option B: Make parentRef required via state restructuring
// parentRef is set in 'initializing' → 'ready' transition, so it's
// guaranteed in 'ready' and descendants. Use a typestate or assertion.
```

### AP-5: ~~Side Effects Inside `assign` Callbacks~~ (DOCUMENTED)

**Location**: `logs.machine.ts:38-48,53-68`

```typescript
addLog: {
  actions: assign({
    logVersion({ context, event }) {
      context.logBuffer.push({  // Mutation inside assign!
        id: `log_${String(logIdCounter++)}`,
        // ...
      });
      return context.logVersion + 1;
    },
  }),
},
```

**Problem**: The `assign` callback mutates `context.logBuffer` (a ring buffer) as a side effect while returning a new `logVersion`. `assign` callbacks should be pure — compute and return new values only.

**Fix**: Separate the mutation into an action, or return a new buffer reference:

```typescript
addLog: {
  actions: assign(({ context, event }) => ({
    logBuffer: context.logBuffer.withEntry({
      id: `log_${String(logIdCounter++)}`,
      // ...
    }),
    logVersion: context.logVersion + 1,
  })),
}
```

### AP-6: ~~`useMachine` Instead of `useActorRef`~~ (RESOLVED)

**Location**: `auth-splashback.tsx:759`

```typescript
const [state, send, actorRef] = useMachine(authSplashbackMachine);
```

**Problem**: `useMachine` (alias for `useActor`) re-renders on every state change. `useActorRef` + `useSelector` provides fine-grained control.

### AP-7: No Error Handling on Some Invoked Actors (LOW)

Several `invoke` configurations only handle the `onDone` path, not `onError`:

- `file-manager.machine.ts`: `readDirectoryActor` uses `onDone` with guard-based error routing
- `project-manager.machine.ts`: `initializeWorkerActor` uses `onDone` with guard-based error routing

**Mitigating factor**: These use `onDone` with guards that check for error outputs, which is a valid pattern for `fromPromise` actors that catch errors internally and return error objects.

### AP-8: Missing `onError` in `fromPromise` that Can Reject (MEDIUM)

**Location**: `kernel.machine.ts:411-444` — `exportGeometryActor` invoke

The export invoke handles both `onDone` and `onError`, which is correct. However, the `fireRender` async (AP-1) has no error modeling at all — errors are caught and sent as events, but the machine has no visibility.

### AP-9: Event Naming Convention Inconsistency (LOW)

XState v5 recommends `dot.case` event names for wildcard matching. The codebase uses `camelCase`:

```typescript
// Current: camelCase
'createGeometry' | 'geometryComputed' | 'kernelIssue' | 'kernelProgress';

// Recommended by XState: dot.case
'geometry.create' | 'geometry.computed' | 'kernel.issue' | 'kernel.progress';
```

**Impact**: Low — `camelCase` works fine, but `dot.case` enables wildcard transitions (`'kernel.*'`).

**Recommendation**: Not worth migrating existing events. Adopt `dot.case` for new machines.

---

## Testing Gap

### Current state: No XState unit tests

The codebase has **zero direct machine tests**. No files call `createActor()` or test machine transitions, guards, or actions in isolation.

Machines are tested indirectly through:

- Component integration tests (Vitest + Testing Library)
- E2E tests (Playwright)
- Manual testing

### Risk

Without machine tests:

- Transition logic bugs are only caught at integration level
- Guard logic changes can silently break flows
- Actor communication patterns aren't validated
- Regression detection is slow and expensive

### Recommended testing strategy

1. **Unit test critical machines** (`kernel`, `build`, `file-manager`, `cad`) with `createActor` + `waitFor`:

```typescript
test('kernel machine terminates worker on stop', async () => {
  const mockClient = { terminate: vi.fn(), connect: vi.fn(), render: vi.fn() };
  const actor = createActor(kernelMachine, {
    input: { kernelOptions: defaultOptions },
  });
  actor.start();
  // ... setup ...
  actor.stop();
  expect(mockClient.terminate).toHaveBeenCalled();
});
```

2. **Test guards in isolation** — export guard functions and test them directly
3. **Use `machine.provide()`** to inject mock actors for testing
4. **Snapshot-test machine configs** to catch unintended transition changes

---

## Improvement Priorities

### P0: Critical (Resource Leaks / Correctness) — ALL RESOLVED

| ID       | Issue                                           | Location             | Status                                                             |
| -------- | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| ~~AP-1~~ | ~~Fire-and-forget async in `fireRender`~~       | `kernel.machine.ts`  | **Resolved** — converted to invoked `renderActor` with AbortSignal |
| ~~AP-2~~ | ~~Direct context mutation in `destroyWorkers`~~ | `kernel.machine.ts`  | **Resolved** — uses `assign()` + `safeDispose()`                   |
| ~~AP-3~~ | ~~Missing exit actions on `projectMachine`~~    | `project.machine.ts` | **Resolved** — added `exit: ['stopStatefulActors']`                |

### P1: High (Correctness / Robustness) — ALL RESOLVED

| ID       | Issue                                                | Location                  | Status                                                                 |
| -------- | ---------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| ~~AP-2~~ | ~~Direct context mutation in `ensureRuntimeClient`~~ | `kernel.machine.ts`       | **Resolved** — split into `initKernelActor` + `connectingKernel` state |
| ~~AP-2~~ | ~~Direct context mutation in worker init~~           | `file-manager.machine.ts` | **Resolved** — actor returns resources, `onDone` assigns them          |
| ~~AP-5~~ | ~~Side effects in `assign` (log buffer)~~            | `logs.machine.ts`         | **Documented** — intentional mutation for performance                  |

### P2: Medium (DX / Maintainability)

| ID       | Issue                                  | Location            | Status                                            |
| -------- | -------------------------------------- | ------------------- | ------------------------------------------------- |
| ~~AP-4~~ | ~~Non-null assertions on `parentRef`~~ | `kernel.machine.ts` | **Resolved** — guarded with `enqueueActions`      |
| T-1      | No machine unit tests                  | All machines        | **Open** — recommend adding for critical machines |

### P3: Low (Polish) — MOSTLY RESOLVED

| ID       | Issue                                     | Location              | Status                                               |
| -------- | ----------------------------------------- | --------------------- | ---------------------------------------------------- |
| ~~AP-6~~ | ~~`useMachine` instead of `useActorRef`~~ | `auth-splashback.tsx` | **Resolved** — migrated to `useActorRef`             |
| AP-9     | `camelCase` event names (not `dot.case`)  | All machines          | **Open** — low priority, adopt for new machines only |

## Resolved Items

All critical and high-priority anti-patterns have been resolved:

- **`safeDispose()` utility** (`@taucad/utils/dispose`): All cleanup chains are now error-isolated
- **`initKernelActor`**: Client initialization extracted into a proper invoked actor with `connectingKernel` state
- **`renderActor`**: Fire-and-forget `fireRender` replaced with XState-managed invoke + AbortSignal
- **`destroyWorkers` as `assign()`**: Cleanup is now pure context assignment
- **`projectMachine` exit action**: Root `exit: ['stopStatefulActors']` ensures spawned children are stopped
- **`parentRef!` guards**: All 9 non-null assertions replaced with `enqueueActions` + guard checks
- **`cameraCapability!` guard**: Same pattern in `graphics.machine.ts`
- **`useMachine` → `useActorRef`**: `auth-splashback.tsx` migrated
- **AbortSignal support**: Added to `initializeWorkerActor`, `readDirectoryActor`, `exportGeometryActor`, and `initKernelActor`
- **Direct context mutations eliminated**: 22 mutations across 5 machines converted to `assign()` or actor output patterns

---

## References

- [Stately: Actions](https://stately.ai/docs/actions)
- [Stately: Actors](https://stately.ai/docs/actors)
- [Stately: Spawn](https://stately.ai/docs/spawn)
- [Stately: Naming Conventions](https://stately.ai/blog/2024-01-23-state-machines-whats-in-a-name)
- [Stately: Migration to v5](https://stately.ai/blog/2024-02-02-migrating-machines-to-xstate-v5)
- [XState v5 Source: createActor.ts](https://github.com/statelyai/xstate/blob/main/packages/core/src/createActor.ts)
- [Worker Management Research](./worker-management.md)
- [Worker Policy](../policy/worker-policy.md)
