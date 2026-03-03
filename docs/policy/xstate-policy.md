# XState Policy

Standard patterns for state machine design, actor lifecycle, and React integration using XState v5 in the Tau application.

## Machine Definition

### Use `setup()` for all machine definitions

Every machine must use the `setup()` API with explicit type declarations for `context`, `events`, and `input`:

```typescript
export const myMachine = setup({
  types: {
    context: {} as MyContext,
    events: {} as MyEvent,
    input: {} as MyInput,
  },
  actors: { /* named actor logic */ },
  actions: { /* named action implementations */ },
  guards: { /* named guard implementations */ },
}).createMachine({
  id: 'my-machine',
  context: ({ input }) => ({ /* ... */ }),
  initial: 'idle',
  states: { /* ... */ },
});
```

### Machine naming

- **Machine ID**: `kebab-case` (e.g., `'file-manager'`, `'kernel'`, `'build'`)
- **States**: Nouns or adjectives (`idle`, `loading`, `ready`, `error`, `rendering`, `exporting`)
- **Events**: `camelCase` verbs (e.g., `createGeometry`, `loadBuild`, `setParameters`)
- **Actions**: `camelCase` verb phrases (e.g., `registerParentRef`, `destroyWorkers`, `emitBuildLoaded`)
- **Guards**: `camelCase` predicates (e.g., `isLoggedIn`, `hasValidData`, `isBuildIdChanging`)

> **Note on `dot.case`**: XState v5 recommends `dot.case` for event names to enable wildcard transitions (`'kernel.*'`). The current codebase uses `camelCase`. New machines may adopt `dot.case` if wildcard matching provides clear value, but consistency within a machine is more important than convention.

---

## Context Rules

### Never mutate context directly

All context updates must go through `assign()`. Direct mutation (`context.foo = bar`) bypasses XState's immutability model and causes issues with devtools, state persistence, and `@xstate/react`'s snapshot rehydration.

```typescript
// WRONG
actions: {
  setWorker({ context, event }) {
    context.worker = event.worker;  // Direct mutation
  },
}

// CORRECT
actions: {
  setWorker: assign({
    worker: ({ event }) => event.worker,
  }),
}
```

### Keep context lean

Store only what the machine needs for decision-making and actor communication. Large data sets (file contents, geometry buffers) should live in external stores or dedicated actors.

### Use states, not boolean flags

Model distinct operational modes as states rather than boolean context flags:

```typescript
// WRONG — boolean flags in context
context: { isLoading: false, hasError: false, data: null }

// CORRECT — discrete states
states: {
  idle: {},
  loading: {
    invoke: { src: 'fetchData', onDone: 'success', onError: 'error' },
  },
  success: {},
  error: {},
}
```

---

## Actions

### `assign` for context updates

Use `assign` for all context updates. Prefer the property-based form for targeted updates:

```typescript
// Property-based (preferred)
assign({
  count: ({ context }) => context.count + 1,
  name: ({ event }) => event.name,
})

// Function-based (for returning full context shape)
assign(({ context, event }) => ({
  ...context,
  count: context.count + event.value,
}))
```

### No side effects in `assign`

`assign` callbacks must be pure — compute and return new values only. No logging, API calls, mutations, or I/O:

```typescript
// WRONG — mutation inside assign
assign({
  version({ context }) {
    context.buffer.push(newEntry);  // Side effect!
    return context.version + 1;
  },
})

// CORRECT — return new value
assign(({ context }) => ({
  buffer: context.buffer.withEntry(newEntry),
  version: context.version + 1,
}))
```

### `enqueueActions` for conditional multi-action composition

Use `enqueueActions` when you need to conditionally execute different combinations of built-in actions:

```typescript
enqueueActions(({ enqueue, context, check }) => {
  enqueue.assign({ status: 'processing' });

  if (check('shouldNotify')) {
    enqueue.sendTo(context.parentRef, { type: 'processing' });
  }

  for (const child of context.children) {
    enqueue.stopChild(child);
  }
})
```

Do not use `enqueueActions` when `assign` alone suffices.

### No fire-and-forget async in actions

Actions are synchronous. Never wrap async operations in `void (async () => { ... })()`:

```typescript
// FORBIDDEN — invisible to XState, not cancellable
actions: {
  doWork({ context }) {
    void (async () => {
      const result = await heavyComputation();
      context.result = result;
    })();
  },
}
```

For async operations, use **invoked actors** (`fromPromise`, `fromCallback`). See [Async Operations](#async-operations).

### `assertEvent` for type narrowing

Use `assertEvent` in actions that handle specific events to narrow the event type:

```typescript
registerParentRef: assign({
  parentRef({ event }) {
    assertEvent(event, 'initializeKernel');
    return event.parentRef;
  },
}),
```

---

## Actors

### When to use each actor type

| Actor | Lifecycle | Cancellation | Use case |
|---|---|---|---|
| `invoke` with `fromPromise` | State-scoped (auto-stop on exit) | `AbortSignal` | One-shot async (API calls, initialization) |
| `invoke` with `fromCallback` | State-scoped (auto-stop on exit) | Cleanup function return | Long-running processes (event listeners, polling) |
| `invoke` with `fromObservable` | State-scoped (auto-stop on exit) | Unsubscribe | Streaming data sources |
| `spawn` (inside `assign`) | Manual (explicit `stopChild`) | Manual | Dynamic actors needing a context reference |
| `spawnChild` (action) | Manual (explicit `stopChild`) | Manual | Dynamic actors without context reference |

### Prefer `invoke` over `spawn` when possible

`invoke` provides automatic lifecycle management — the actor starts when the state is entered and stops when the state is exited. Prefer `invoke` unless the actor needs to persist across multiple states.

### Always stop spawned actors

Spawned actors are NOT automatically stopped when the parent machine stops. Always pair `spawn` with explicit `stopChild`:

```typescript
// Spawn
entry: assign({
  workerRef: ({ spawn }) => spawn('workerActor', { id: 'my-worker' }),
})

// Stop — in exit action or explicit cleanup
exit: enqueueActions(({ enqueue, context }) => {
  if (context.workerRef) {
    enqueue.stopChild(context.workerRef);
    enqueue.assign({ workerRef: undefined });
  }
})
```

### Always handle `onError` for invoked promises

```typescript
invoke: {
  src: 'fetchData',
  onDone: {
    target: 'success',
    actions: assign({ data: ({ event }) => event.output }),
  },
  onError: {
    target: 'error',
    actions: assign({ error: ({ event }) => event.error }),
  },
}
```

The only exception is `fromCallback`, which does not emit `onDone`/`onError` events.

---

## Async Operations

### Use `fromPromise` for one-shot async

```typescript
const fetchDataActor = fromPromise(async ({ input, signal }) => {
  const response = await fetch(input.url, { signal });
  signal.throwIfAborted();
  return response.json();
});
```

**Key**: Use the `signal` parameter. XState creates an `AbortController` for each invoked promise and aborts it when the state exits or the machine stops. Check `signal.throwIfAborted()` after each `await` to ensure the operation stops promptly.

### Use `fromCallback` for long-running processes

```typescript
const fileWatcherActor = fromCallback(({ sendBack, receive, input }) => {
  const interval = setInterval(async () => {
    const changes = await pollForChanges(input.directory);
    if (changes.length > 0) {
      sendBack({ type: 'filesChanged', changes });
    }
  }, input.intervalMs);

  // Cleanup: guaranteed to run on actor stop
  return () => {
    clearInterval(interval);
  };
});
```

The cleanup function is guaranteed to run when the actor is stopped (state exit or machine stop).

### Worker lifecycle as invoked callback

For workers tied to a specific machine state:

```typescript
const workerActor = fromCallback(({ sendBack }) => {
  const worker = new Worker(workerUrl, { type: 'module' });
  worker.onmessage = (event) => {
    sendBack({ type: 'workerResult', data: event.data });
  };
  return () => {
    worker.terminate();
  };
});

states: {
  active: {
    invoke: { src: 'workerActor', id: 'worker' },
    // Worker auto-terminates when leaving 'active' state
  },
}
```

---

## Cleanup and Exit Actions

### Every machine with resources must have exit actions

If a machine creates workers, opens connections, subscribes to events, or holds any resource that requires explicit cleanup, it must have a root-level `exit` action:

```typescript
setup({
  actions: {
    cleanup({ context }) {
      // Release all resources
    },
  },
}).createMachine({
  exit: ['cleanup'],
  // ...
});
```

### Error-isolate cleanup chains

If a cleanup action iterates over multiple resources, wrap each in try/catch to ensure all resources are released even if one cleanup fails:

```typescript
cleanup({ context }) {
  for (const disposable of context.disposables) {
    try {
      disposable();
    } catch (error) {
      console.error('[Cleanup] failed:', error);
    }
  }
  // Critical cleanup (e.g., worker.terminate()) must always run
  context.worker?.terminate();
}
```

See [Worker Policy, Rule 5](./worker-policy.md#rule-5-error-isolated-cleanup) for the full pattern.

### Guard against post-teardown operations

When a machine has exit actions that set a `destroyed` flag, check this flag at every yield point in any associated async operations:

```typescript
async function ensureResource(context: MachineContext): Promise<Resource> {
  if (context.destroyed) {
    throw new Error('Machine was stopped');
  }
  const resource = await createResource();
  if (context.destroyed) {
    resource.dispose();
    throw new Error('Machine was stopped during initialization');
  }
  return resource;
}
```

---

## React Integration

### Use `useActorRef` + `useSelector` (not `useMachine`)

`useMachine` (alias: `useActor`) re-renders on every state change. Use `useActorRef` for the actor reference and `useSelector` for fine-grained subscriptions:

```typescript
function MyComponent(): React.JSX.Element {
  const actorRef = useActorRef(myMachine, { input: { /* ... */ } });
  const isLoading = useSelector(actorRef, (s) => s.matches('loading'));
  const count = useSelector(actorRef, (s) => s.context.count);

  return (/* ... */);
}
```

### Input is read once at initialization

`useActorRef(machine, { input })` reads `input` only when the actor is created. Changing the `input` object on re-renders does NOT update the running actor. To react to external changes, send events:

```typescript
// Send events when props change
useEffect(() => {
  actorRef.send({ type: 'loadBuild', buildId });
}, [actorRef, buildId]);
```

### Use `key` prop for identity-based remounting

When a component wraps a machine whose identity changes (e.g., different build ID), use a React `key` prop to force unmount/remount:

```typescript
<BuildProvider key={buildId} buildId={buildId}>
  {children}
</BuildProvider>
```

This ensures:
1. Old actor is stopped (cleanup runs)
2. New actor is created with fresh input

### Actor propagation

Pass actor references via React context or props, not by reaching into parent machine context:

```typescript
// CORRECT: Provider exposes actor ref via context
<BuildContext.Provider value={{ buildRef: actorRef }}>
  {children}
</BuildContext.Provider>

// WRONG: Reaching into parent machine internals
const kernelRef = parentActor.getSnapshot().context.kernelRef;
```

---

## Communication Patterns

### Parent-to-child: `sendTo`

```typescript
sendTo(({ context }) => context.childRef, { type: 'doWork', data: 42 })
```

### Child-to-parent: `sendTo` with parent ref (preferred over `sendParent`)

Pass the parent ref via `input` to avoid tight coupling:

```typescript
// Parent spawns child with self reference
entry: assign({
  childRef: ({ spawn, self }) => spawn('child', {
    input: { parentRef: self },
  }),
})

// Child sends to parent via stored ref
entry: sendTo(
  ({ context }) => context.parentRef,
  { type: 'childReady' },
)
```

### Guard `sendTo` targets against undefined

When the target actor ref may be undefined in some machine states, use `enqueueActions` with a guard:

```typescript
// RISKY — parentRef may be undefined
sendTo(({ context }) => context.parentRef!, { type: 'event' })

// SAFE — guarded
enqueueActions(({ context, enqueue }) => {
  if (context.parentRef) {
    enqueue.sendTo(context.parentRef, { type: 'event' });
  }
})
```

### Decoupled communication: `emit`

Use `emit` for events that parent components observe via `.on()` subscriptions, without requiring the machine to know who is listening:

```typescript
// Machine emits
emitBuildLoaded: emit(({ event }) => ({
  type: 'buildLoaded',
  build: event.output,
})),

// React component subscribes
useEffect(() => {
  const sub = actorRef.on('buildLoaded', (event) => {
    // Handle event
  });
  return () => sub.unsubscribe();
}, [actorRef]);
```

---

## Testing

### Test machines with `createActor`

```typescript
import { createActor, waitFor } from 'xstate';

test('transitions to ready on successful load', async () => {
  const actor = createActor(
    myMachine.provide({
      actors: {
        loadData: fromPromise(async () => ({ items: [1, 2, 3] })),
      },
    }),
    { input: { id: 'test-123' } },
  );

  actor.start();
  actor.send({ type: 'load' });

  const snapshot = await waitFor(actor, (s) => s.matches('ready'));
  expect(snapshot.context.items).toHaveLength(3);

  actor.stop();
});
```

### Use `machine.provide()` for dependency injection

Override actors, actions, and guards for testing:

```typescript
const testMachine = machine.provide({
  actors: {
    fetchData: fromPromise(async () => mockData),
  },
  actions: {
    logAnalytics: () => { /* no-op */ },
  },
  guards: {
    isAuthenticated: () => true,
  },
});
```

### Test guards and actions in isolation

Export guard and action functions for direct unit testing:

```typescript
// In machine file
export function isBuildIdChanging({ context, event }: GuardArgs): boolean {
  return event.buildId !== context.buildId;
}

// In test file
test('isBuildIdChanging returns true for different IDs', () => {
  expect(isBuildIdChanging({
    context: { buildId: 'a' },
    event: { type: 'loadBuild', buildId: 'b' },
  })).toBe(true);
});
```

---

## Performance

### Minimize context size

Large context objects increase serialization overhead for devtools, persistence, and snapshot operations. If a value is only needed inside an action (not for state decisions), pass it through events rather than storing it in context.

### Use `useSelector` with stable selectors

Define selectors outside components or memoize them to prevent unnecessary re-renders:

```typescript
// CORRECT: Stable selector reference
const selectCount = (state: SnapshotFrom<typeof myMachine>) => state.context.count;

function MyComponent({ actorRef }: Props): React.JSX.Element {
  const count = useSelector(actorRef, selectCount);
  return <span>{count}</span>;
}
```

### Limit spawned actor count

Each spawned actor is a live object with subscriptions. For variable-count actors (compilation units, graphics views), set reasonable limits and clean up eagerly.

---

## References

- [XState v5 Documentation](https://stately.ai/docs)
- [XState v5 Actions](https://stately.ai/docs/actions)
- [XState v5 Actors](https://stately.ai/docs/actors)
- [XState v5 Invoke](https://stately.ai/docs/invoke)
- [XState v5 Callback Actors](https://stately.ai/docs/callback-actors)
- [XState v5 React Integration](https://stately.ai/docs/xstate-react)
- [Naming Conventions](https://stately.ai/blog/2024-01-23-state-machines-whats-in-a-name)
- [Migration to v5](https://stately.ai/blog/2024-02-02-migrating-machines-to-xstate-v5)
- [Worker Policy](./worker-policy.md)
- [XState Patterns Research](../research/xstate-patterns.md)
