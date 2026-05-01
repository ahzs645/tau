---
title: 'Runtime Async-Event Contract & Transport-Agnostic Architecture'
description: 'Eigenquestion analysis of the void-promise/IIFE/microtask-drain code smells in RuntimeClient and the transport-layer split that lets the runtime ship over MessageChannel, WebSocket, Electron IPC, or any future channel.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: architecture
related:
  - docs/policy/library-api-policy.md
  - docs/research/runtime-event-driven-api-blueprint-v5.md
  - docs/research/runtime-blueprint-v5-implementation-audit.md
---

# Runtime Async-Event Contract & Transport-Agnostic Architecture

A root-cause analysis of three converging code smells in `RuntimeClient` — fire-and-forget `void` IIFEs, `await Promise.resolve()` microtask drains in tests, and the leakage of `MessagePort` into the public surface — and a proposal for the API/transport contract that eliminates all three classes of issue while opening the runtime to WebSocket, Electron IPC, and future channels.

## Executive Summary

Three smells that look superficially syntactic — `void (async () => {…})()`, `await Promise.resolve()` in tests, and a manual `new Promise((resolve, reject) => { void (async () => {…})() })` in `connect()` — share a single root cause: the **transport surface emits unmaterialised wire bytes through synchronous callbacks**, while the consumer-visible event payload (`HashedGeometryResult`) requires an **asynchronous materialisation step** (`transport.resolveGeometry`). The runtime client is forced to bridge the two with off-the-books asyncness, and the only places that can observe the materialisation lag (consumer awaits, tests) are forced to drain microtasks blindly.

Recommendation: **invert the transport contract** so the transport (which is the only layer that knows whether materialisation is sync, async, SAB-backed, or remote) emits **already-resolved domain events**, and **split the wire layer from the channel layer** so any in-process / worker / WebSocket / Electron IPC / FFI primitive can satisfy it. The runtime client never constructs a `MessageChannel`, never holds a `MessagePort` in its public type signature, and never invokes async work from a sync void callback.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [The Eigenquestion](#the-eigenquestion)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Migration Sketch](#migration-sketch)
- [Antipatterns to Encode in Policy](#antipatterns-to-encode-in-policy)

## Problem Statement

### Smell 1 — `void (async () => {…})()` IIFE inside a sync event callback

`packages/runtime/src/client/runtime-client.ts` line 1041:

```typescript
onGeometryComputed(transportResult) {
  void (async () => {
    const resolved = await resolveTransportResult(transportResult);
    if (resolved.success) {
      hasSettledRender = true;
    }
    resolvePendingRender(resolved);
    emitGeometry(resolved);
  })();
},
```

The handler signature is sync (`(result) => void`), but the body must `await` the transport's `resolveGeometry` promise. The IIFE is the syntactic glue. A consumer reading this can only conclude one of two things: either the runtime author hit an awkward dead-end and the API is wrong, or there is a load-bearing reason that requires deep familiarity with the message dispatcher. Both are bad.

### Smell 2 — `await Promise.resolve()` microtask drains in tests

`packages/runtime/src/framework/kernel-worker.test.ts` exports a helper invoked **23 times** across the suite:

```typescript
async function flushMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}
```

`packages/runtime/src/client/runtime-client.test.ts` carries an analogous 8-iteration drain. Tests have to call `await flushMicrotasks(); await flushMicrotasks();` between a `pushResponse(...)` and an assertion because the consumer-visible event fires **after** the IIFE has settled — and the IIFE is invisible to the test author. Every consumer who writes a test against `RuntimeClient` is going to inherit this pattern.

This is not a private testing trick. Any downstream consumer (apps/ui, packages/cli, third-party integrators) writing the kind of unit test that drives the client by mocking the transport is forced to either reproduce the helper or reverse-engineer the IIFE schedule. That violates the "TypeScript-first, opinionated, low-ceremony" promise the runtime makes.

### Smell 3 — IIFE inside `new Promise()` constructor in `connect()`

`packages/runtime/src/client/runtime-client.ts` line 1219:

```typescript
return new Promise<void>((resolve, reject) => {
  const slot: PendingConnect = { reject };
  pendingConnect = slot;

  void (async () => {
    try {
      await ensureConnected(connectOptions);
      // …
      resolve();
    } catch (error) {
      // …
      reject(/* RuntimeConnectionError */);
    }
  })();
});
```

`connect()` cannot be a plain `async function` because `terminate()` needs to grab the `reject` handle out of the `pendingConnect` slot before the in-flight call settles. The author resolved this by writing the Promise constructor by hand and stuffing the async work into an IIFE, leaving the file with an `oxlint-disable-next-line @typescript-eslint/promise-function-async` directive ten lines above as a tombstone.

### Smell 4 — `MessagePort` in the public `ConnectOptions` union

`packages/runtime/src/client/runtime-client.ts` line 519:

```typescript
export type ConnectOptions =
  | { fileSystem: RuntimeFileSystemBase; filePoolBuffer?: SharedArrayBuffer }
  | { port: MessagePort; filePoolBuffer?: SharedArrayBuffer };
```

`MessagePort` is a `MessageChannel`-shaped primitive. A WebSocket transport cannot synthesise one. An Electron IPC transport cannot synthesise one. An FFI transport cannot synthesise one. Yet the public `connect()` surface accepts it. The runtime client therefore advertises a coupling to the worker/MessageChannel transport even when the consumer is going to plug in a remote transport — and the transport-conformance suite has to look the other way.

## Methodology

- Read every site in `packages/runtime/src/client/runtime-client.ts` that uses `void`, `then`, or a manual Promise constructor.
- Catalogued the `await Promise.resolve()` / `flushMicrotasks` pattern across all of `packages/runtime/src/**/*.{ts,test.ts}` to estimate consumer-side test cost.
- Walked the three concrete transports (`createInProcessTransport`, `createWorkerTransport`, `createWebSocketTransport`) to extract the actual cross-channel surface contract.
- Compared the current `RuntimeTransport` shape to event-stream contracts in three reference libraries: `vercel/ai` (UIMessageChunk async iterators), `nestjs/websockets` (Subject-based event multiplexing), `tRPC` over WebSocket subscription channels.
- Cross-referenced `docs/research/runtime-event-driven-api-blueprint-v5.md` for the prior design intent that motivated the SAB-encapsulation refactor.

## Findings

### Finding 1: All four smells share one root cause

The transport surface today is a **wire-level message stream plus an out-of-band async resolver**. The top half of the contract (`onMessage`, `signalAbort`, `send`) is synchronous-by-design — it has to be, because it sits directly on top of `MessagePort.onmessage`/`Worker.onmessage`/etc., none of which await their handlers. The bottom half (`resolveGeometry`) is asynchronous-by-design — it must be, because remote transports do network I/O and SAB transports may copy non-trivially.

`RuntimeClient` is the layer that has to glue the sync top to the async bottom. Every smell catalogued in [Problem Statement](#problem-statement) is a consequence of that glue running inside a sync void callback.

| Smell                                   | Where the asyncness originates                      | Why the syntax is forced                                                               |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `void (async () => {…})()` IIFE         | `transport.resolveGeometry()`                       | `onGeometryComputed` returns void; can't `await` inline                                |
| Test `await Promise.resolve()` × N      | Same — IIFE settlement is invisible from outside    | Test author has no Promise to await; only the side-effect emit is observable           |
| `new Promise((resolve, reject)) + IIFE` | `ensureConnected()` chain awaiting + slot capture   | `pendingConnect` slot must be visible to `terminate()` before the awaited chain begins |
| `port: MessagePort` in `ConnectOptions` | Wire-channel primitive leaking past the abstraction | No transport-agnostic primitive exists for "filesystem channel handle"                 |

### Finding 2: The asyncness is non-negotiable, the surface that hides it is

`transport.resolveGeometry` legitimately needs to be async — that's the whole point of the v5 SAB-encapsulation refactor that produced this code. Reverting it would re-leak `SharedPool` into the runtime client.

What is **not** non-negotiable is the choice to keep `RuntimeWorkerClient.onGeometryComputed` synchronous. Three alternative shapes would each eliminate the IIFE:

1. **Async-handler contract** — every event handler returns `Promise<void>`; the dispatcher awaits before invoking the next.
2. **Pre-materialised events** — the transport awaits `resolveGeometry` itself and emits already-resolved domain events; consumer handlers stay sync because they receive resolved values.
3. **AsyncIterable event stream** — the consumer `for await (const event of transport.events())` and the dispatcher pulls; back-pressure is implicit.

Option (2) is the least invasive and the most aligned with the existing codebase: it preserves sync handlers (good for React `useEffect`), keeps the `EventTarget`-style API surface (Section 7 of `library-api-policy.md`), and concentrates the materialisation knowledge in the only layer that already understands transport identity.

### Finding 3: `connect()` IIFE is a separate but related shape

`connect()`'s manual Promise constructor exists because **slot capture must precede `await`**. This is a recognisable pattern: any single-flight async API where supersession/cancellation must be able to find and reject the in-flight call has the same shape. The fix is the same shape too — a small `createDeferredSlot<T>()` helper that returns `{ promise, resolve, reject }` and lets the body stay an `async function`:

```typescript
async connect(connectOptions: ConnectOptions): Promise<void> {
  if (lifecycleState === 'terminated') throw new RuntimeTerminatedError();
  if (firstConnectOptions !== undefined) {
    /* idempotent / mismatch checks */
    return;
  }
  const slot = createDeferredSlot<void>();
  pendingConnect = slot;
  try {
    await ensureConnected(connectOptions);
    if (pendingConnect === slot) pendingConnect = undefined;
    firstConnectOptions = connectOptions;
    slot.resolve();
  } catch (error) {
    if (pendingConnect !== slot) {
      // terminate() already rejected this slot; swallow secondary errors.
      return;
    }
    pendingConnect = undefined;
    if (lifecycleState !== 'terminated') lifecycleState = 'unconnected';
    slot.reject(/* classify */);
  }
  return slot.promise;
}
```

`createDeferredSlot` is **eight lines** of boilerplate that's been written hundreds of times in the JS ecosystem (see `Promise.withResolvers()`, [TC39 Stage 4 since 2024](https://github.com/tc39/proposal-promise-with-resolvers)). The runtime can adopt `Promise.withResolvers()` directly on Node 22+/modern browsers and ship a tiny shim for older targets. This pattern is **not** the IIFE smell — it's a Deferred, which is well-understood.

### Finding 4: `MessagePort` leakage in `ConnectOptions` blocks the WebSocket / Electron IPC roadmap

The current public type:

```typescript
export type ConnectOptions =
  | { fileSystem: RuntimeFileSystemBase; filePoolBuffer?: SharedArrayBuffer }
  | { port: MessagePort; filePoolBuffer?: SharedArrayBuffer };
```

`MessagePort` is a structurally exclusive primitive. A WebSocket consumer would have to fabricate one by piping a `MessageChannel` through their socket adapter — an absurd round-trip. An Electron IPC consumer would face the same friction with `ipcRenderer`/`MessagePortMain`. An FFI consumer (Node.js native addon) has no equivalent primitive at all.

The right abstraction is a **filesystem channel handle** that any transport knows how to bind. The two existing concrete forms (a JS `RuntimeFileSystemBase` instance, or a `MessagePort` wired by `createFileSystemBridge`) become two of N implementations of that handle:

```typescript
export type ConnectOptions = {
  fileSystem: RuntimeFileSystem; // typed handle, never a wire primitive
  filePool?: FilePoolHandle; // opaque pool handle, not a raw SAB
};
```

The handle layer is what a WebSocket / Electron IPC transport implements; the runtime client never sees the wire primitive. `filePool` becomes a transport-aware handle that can resolve to a SAB on capable transports and to inline-bytes on remote ones, mirroring the geometry-pool resolution model.

### Finding 5: The test `flushMicrotasks` helper is a load-bearing test smell

Tests that have to drain N microtasks between `pushResponse` and `expect` are testing **schedule timing**, not behaviour. A shape change that adds one more `await` in the IIFE silently breaks every such test until the iteration count is bumped. The kernel-worker test suite already runs `flushMicrotasks()` 23 separate times — the helper is doing real work, but the work it's doing is "wait until the IIFE finishes", which the API should expose directly.

When the materialisation moves into the transport (Finding 2 / Recommendation 1), the consumer-visible event fires only after the materialisation Promise resolves. Tests can `await pushResponse(...)` directly because `pushResponse` returns the Promise the transport itself is awaiting. No `flushMicrotasks` needed.

### Finding 6: The `oxlint-disable-next-line @typescript-eslint/promise-function-async` comment is a confession

The file currently carries:

```typescript
// oxlint-disable-next-line @typescript-eslint/promise-function-async -- explicit Promise constructor required so terminate() can reject the connect via the captured `pendingConnect` slot
connect(connectOptions: ConnectOptions): Promise<void> { …
```

A linter suppression that explains "the lint rule is correct but the architecture forces us around it" is a code smell at the architecture level, not the lint level. The Deferred pattern in [Finding 3](#finding-3) removes the suppression entirely.

## The Eigenquestion

> **Who owns the materialisation step between an inbound transport message and the consumer-visible domain event?**

Today: nobody owns it cleanly. The transport delivers wire bytes; the runtime client awaits materialisation inside a sync callback via IIFE; the consumer event fires from inside the IIFE; the test author drains microtasks because nothing in the public surface exposes the Promise.

Correct answer: **the transport**. It is the only layer that knows whether materialisation is a free pointer-cast (in-process), a SAB read (Worker), a network round-trip (WebSocket), or a Buffer copy (Electron IPC). It is the only layer that can decide what "the event has arrived" actually means. Once the transport owns materialisation, every layer above it gets a clean sync contract: the event payload is already-resolved.

This single ownership shift collapses all four smells:

| Smell                                   | Resolved by                                                            |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `void (async () => {…})()` IIFE         | Transport awaits `resolveGeometry` before emitting; handler stays sync |
| Test `await Promise.resolve()` × N      | Tests await the transport's `pushResponse` Promise directly            |
| `new Promise() + IIFE` in `connect()`   | Replaced with `Promise.withResolvers()` Deferred pattern               |
| `port: MessagePort` in `ConnectOptions` | Transport owns the wire primitive; consumer passes a typed handle      |

## Recommendations

| #   | Action                                                                                                                   | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Move geometry materialisation into the transport; emit pre-resolved domain events.                                       | P0       | Medium | High   |
| R2  | Rename `RuntimeTransport` to a two-layer split: **wire channel** (bytes) + **event source** (typed domain events).       | P0       | Medium | High   |
| R3  | Replace manual `new Promise((res, rej))` + IIFE with `Promise.withResolvers()` Deferred pattern.                         | P0       | Low    | High   |
| R4  | Introduce a `RuntimeFileSystem` handle abstraction; remove `MessagePort` from public `ConnectOptions`.                   | P0       | Medium | High   |
| R5  | Encode the IIFE / `void promise.then()` / `await Promise.resolve()` patterns as antipatterns in `library-api-policy.md`. | P0       | Low    | High   |
| R6  | Add a transport-conformance test asserting that domain events are never delivered with unresolved payloads.              | P1       | Low    | Medium |
| R7  | Delete the `flushMicrotasks` helper in `runtime-client.test.ts` and `kernel-worker.test.ts` after R1 lands.              | P1       | Low    | Medium |
| R8  | Author transport stubs for Electron IPC (`createElectronIpcTransport`) and validate against conformance suite.           | P2       | Medium | Medium |

### R1 — Transport owns materialisation

Move `resolveTransportResult` from `runtime-client.ts` into the transport. The transport's existing `onMessage` callback wraps the user's handler with the materialisation step:

```typescript
// inside in-process-transport.ts
const eventBus = createDomainEventSource();
channel.port2.onmessage = async (event) => {
  const wireResponse = event.data;
  const domainEvent = await materialiseDomainEvent(wireResponse, geometryPool);
  eventBus.emit(domainEvent);
};
```

The runtime client then subscribes to the materialised event stream:

```typescript
transport.events.on('geometry', (geometry) => {
  /* sync — geometry is HashedGeometryResult, already resolved */
});
```

`onMessage(handler: (wire) => void)` stays available for advanced consumers (the dispatcher inside `RuntimeWorkerClient`) but the **default ergonomic surface** is the materialised event source.

### R2 — Two-layer transport split

```typescript
/** Wire-level bidirectional channel — the only thing every transport must implement. */
export type RuntimeChannel = {
  send(message: RuntimeCommand, attachments?: ChannelAttachments): void;
  onMessage(handler: (message: RuntimeResponse) => void): Unsubscribe;
  close(): void;
};

/** Polymorphic attachment bag — replaces `Transferable[]`. */
export type ChannelAttachments = {
  transferables?: Transferable[]; // MessageChannel/Worker only
  binaries?: Uint8Array[]; // WebSocket binary frames, Electron IPC, FFI
  ports?: ChannelHandle[]; // typed handle for any port-like primitive
};

/** Materialised event stream — what RuntimeClient subscribes to. */
export type RuntimeEventSource = {
  on<E extends keyof DomainEvents>(event: E, handler: (payload: DomainEvents[E]) => void): Unsubscribe;
};

/** Composite transport — what `createWorkerTransport` / `createWebSocketTransport` return. */
export type RuntimeTransport = {
  channel: RuntimeChannel;
  events: RuntimeEventSource;
  configureMemory(request: ConfigureMemoryRequest): MemoryHandle;
  describe(): TransportDescriptor;
  close(): void;
};
```

This split lets:

- **`RuntimeChannel`** be the smallest possible portable contract — bytes in/out, no async resolver. Mappable onto MessageChannel, Worker, WebSocket, Electron IPC (`ipcRenderer.invoke`), `process.send` (forked Node child), `tRPC` link, raw TCP, native FFI.
- **`RuntimeEventSource`** be the consumer-visible surface — already-materialised, typed, sync handlers.
- The transport implementer owns the bridge from the former to the latter.

### R3 — Deferred pattern for slot capture

Replace:

```typescript
return new Promise<void>((resolve, reject) => {
  pendingConnect = { reject };
  void (async () => { … })();
});
```

with:

```typescript
async connect(options: ConnectOptions): Promise<void> {
  /* … guards … */
  const slot = Promise.withResolvers<void>();
  pendingConnect = { reject: slot.reject };
  try {
    await ensureConnected(options);
    /* … */
    slot.resolve();
  } catch (error) {
    /* … */
    slot.reject(/* classify */);
  }
  return slot.promise;
}
```

Targets: Node 22+ (shipped May 2024), all current evergreen browsers. For the few build targets that still use Node 20, ship a tiny inline shim:

```typescript
const withResolvers = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
```

### R4 — Filesystem channel handle

Replace `MessagePort` in `ConnectOptions` with a typed handle:

```typescript
export type RuntimeFileSystem =
  | { kind: 'inline'; fs: RuntimeFileSystemBase } // main-thread relay
  | { kind: 'channel'; channel: ChannelHandle }; // any port-like primitive

export type ConnectOptions = {
  fileSystem: RuntimeFileSystem;
  filePool?: FilePoolHandle;
};
```

`ChannelHandle` is a typed wrapper that each transport knows how to bind:

- **Worker / in-process transports**: bind via `MessagePort` internally.
- **WebSocket transport**: multiplex over the same socket using a sub-channel id.
- **Electron IPC transport**: bind via `MessagePortMain` (the Electron equivalent) or `ipcRenderer.invoke`.

The runtime client never types against `MessagePort`. The wire primitive stays inside the transport.

### R5 — Antipatterns in `library-api-policy.md`

Add a new section to `docs/policy/library-api-policy.md`:

> **§ 22 — Async Surface Hygiene (Antipatterns)**
>
> 1. **Never invoke async work from a sync void callback via `void (async () => {…})()`.** If the body needs to await, the callback contract is wrong: change the contract to return `Promise<void>` or pre-resolve the payload upstream so the body stays sync.
> 2. **Never use `void promise.then(…)` to "consume" a promise.** Same reason — it discards the error pipeline and hides asyncness from observers.
> 3. **Never write `await Promise.resolve()` to drain microtasks.** If your test needs this, the API does not expose the asyncness it should expose. Fix the API.
> 4. **Never wrap an async chain in `new Promise((resolve, reject) => { void (async () => {…})() })`.** Use `Promise.withResolvers()` (or a tiny shim) and keep the body an `async function`.
> 5. **Never type wire primitives (`MessagePort`, `Worker`, `WebSocket`) into a public option object.** Accept a typed handle and let the transport bind the wire primitive internally.

The full antipattern entry is drafted in [Antipatterns to Encode in Policy](#antipatterns-to-encode-in-policy).

### R6 — Conformance: pre-resolved payloads

Extend `transport-conformance.test.ts`:

```typescript
it('emits geometry events with already-materialised payloads', async () => {
  const transport = createXxxTransport();
  let emitted: HashedGeometryResult | undefined;
  transport.events.on('geometry', (g) => {
    emitted = g;
  });
  await transport.simulate(/* a wire 'geometryComputed' response */);
  expect(emitted).toBeDefined();
  expect(emitted!.success).toBe(true);
  // The crucial assertion: the payload is HashedGeometryResult, not HashedGeometryResultTransport.
  expect(isWireFormat(emitted!)).toBe(false);
});
```

### R7 — Delete `flushMicrotasks`

Once R1 lands, every test that previously called `await flushMicrotasks(); await flushMicrotasks();` can be rewritten as `await pushResponse(...)`. The helper deletion is the canary that proves the API now exposes its own asyncness.

### R8 — Electron IPC transport

Implementation sketch:

```typescript
// packages/runtime/src/transport/electron-ipc-transport.ts
import { ipcRenderer } from 'electron';

export function createElectronIpcTransport(channelName: string): RuntimeTransport {
  const eventBus = createDomainEventSource();
  ipcRenderer.on(channelName, async (_event, wireResponse) => {
    eventBus.emit(await materialiseDomainEvent(wireResponse));
  });
  return {
    channel: {
      send: (message, attachments) => ipcRenderer.send(channelName, message, attachments?.binaries),
      onMessage: (handler) => {
        /* … */
      },
      close: () => ipcRenderer.removeAllListeners(channelName),
    },
    events: eventBus,
    configureMemory: () => ({}), // remote: no SAB
    describe: () => ({ name: 'electron-ipc', locality: 'remote', sharedMemory: false, latencyClass: 'low' }),
    close: () => {
      /* … */
    },
  };
}
```

This drops in beside `createInProcessTransport` / `createWorkerTransport` / `createWebSocketTransport` with **zero changes** to `RuntimeClient`.

## Trade-offs

### Option A — Promise-returning handlers

Make every transport callback return `Promise<void>`. Dispatcher awaits between handlers.

| Pro                                          | Con                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Smallest API change to the existing surface  | Forces every consumer to deal with async handlers (React `useEffect` regresses) |
| Keeps materialisation in `runtime-client.ts` | Doesn't fix the `MessagePort` leakage                                           |

### Option B — Pre-resolved domain events (recommended)

Transport awaits materialisation; emits already-resolved domain events.

| Pro                                                                              | Con                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Sync handlers preserved (good for React, EventTarget, `on()` API)                | Transport implementer takes on materialisation responsibility |
| Concentrates transport identity in the only layer that has it                    | Slightly larger transport interface                           |
| Tests await the transport's `pushResponse` Promise directly — no microtask hacks | Existing transports need a one-time refactor                  |

### Option C — AsyncIterable event stream

Consumer `for await (const event of transport.events())`.

| Pro                                           | Con                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Modern, idiomatic, naturally back-pressured   | Multiple subscribers require fan-out; not great for the `on(event, handler)` API |
| Works well for log streaming, progress events | Imperative loop is awkward inside React/XState                                   |

**Verdict**: Option B is the recommended baseline. Option C is appropriate for the **log/telemetry/progress** sub-streams as a _secondary_ consumer surface, but not for the primary `geometry` / `parameters` / `state` events.

## Code Examples

### Before / after — `onGeometryComputed`

Before:

```typescript
onGeometryComputed(transportResult) {
  void (async () => {
    const resolved = await resolveTransportResult(transportResult);
    if (resolved.success) hasSettledRender = true;
    resolvePendingRender(resolved);
    emitGeometry(resolved);
  })();
},
```

After:

```typescript
events.on('geometry', (geometry) => {
  if (geometry.success) hasSettledRender = true;
  resolvePendingRender(geometry);
  emitGeometry(geometry);
});
```

### Before / after — `connect()`

Before:

```typescript
connect(connectOptions: ConnectOptions): Promise<void> {
  /* … guards … */
  return new Promise<void>((resolve, reject) => {
    pendingConnect = { reject };
    void (async () => {
      try {
        await ensureConnected(connectOptions);
        /* … */
        resolve();
      } catch (error) {
        /* … classify … */
        reject(/* classified error */);
      }
    })();
  });
},
```

After:

```typescript
async connect(connectOptions: ConnectOptions): Promise<void> {
  /* … guards … */
  const slot = Promise.withResolvers<void>();
  pendingConnect = { reject: slot.reject };
  try {
    await ensureConnected(connectOptions);
    if (pendingConnect?.reject === slot.reject) pendingConnect = undefined;
    firstConnectOptions = connectOptions;
    slot.resolve();
  } catch (error) {
    if (pendingConnect?.reject !== slot.reject) return slot.promise;
    pendingConnect = undefined;
    if (lifecycleState !== 'terminated') lifecycleState = 'unconnected';
    slot.reject(classifyConnectError(error));
  }
  return slot.promise;
},
```

### Before / after — test for geometry response

Before:

```typescript
pushResponse({ type: 'geometryComputed', result: wireResult });
await flushMicrotasks();
await flushMicrotasks();
expect(eventResult).toBeDefined();
expect(eventResult!.success).toBe(true);
```

After:

```typescript
await pushResponse({ type: 'geometryComputed', result: wireResult });
expect(eventResult).toBeDefined();
expect(eventResult!.success).toBe(true);
```

`pushResponse` returns `Promise<void>` that resolves after the transport's materialisation step completes. No drain helper required.

## Diagrams

### Current architecture

```text
┌───────────────────────────────────────────────────────────────┐
│ Consumer (apps/ui, apps/cli, third-party)                     │
│   client.on('geometry', (g) => {})  ◄── sync void callback     │
└──────────────▲────────────────────────────────────────────────┘
               │  emitGeometry(resolved)
               │  (fires from inside an IIFE; tests can't await)
┌──────────────┴────────────────────────────────────────────────┐
│ RuntimeClient                                                 │
│   onGeometryComputed(wireResult) {                             │
│     void (async () => {                                       │
│       const resolved = await transport.resolveGeometry(...);  │
│       emitGeometry(resolved);                                 │
│     })();   ◄── IIFE here                                      │
│   }                                                           │
└──────────────▲────────────────────────────────────────────────┘
               │  onGeometryComputed(transportResult)  (sync void)
┌──────────────┴────────────────────────────────────────────────┐
│ RuntimeWorkerClient                                           │
│   handleMessage(response): switch over wire types             │
└──────────────▲────────────────────────────────────────────────┘
               │  transport.onMessage(handler)  (sync void)
┌──────────────┴────────────────────────────────────────────────┐
│ Transport (in-process / worker / websocket)                   │
│   onMessage  ───────► sync wire delivery                      │
│   resolveGeometry ──► async, called separately by consumer    │
└───────────────────────────────────────────────────────────────┘
```

### Recommended architecture

```text
┌───────────────────────────────────────────────────────────────┐
│ Consumer                                                       │
│   client.on('geometry', (g) => {})  ◄── sync, payload resolved │
└──────────────▲────────────────────────────────────────────────┘
               │  forwards already-resolved domain events
┌──────────────┴────────────────────────────────────────────────┐
│ RuntimeClient                                                  │
│   transport.events.on('geometry', (geometry) => { … })        │
└──────────────▲────────────────────────────────────────────────┘
               │  sync handler; payload is HashedGeometryResult
┌──────────────┴────────────────────────────────────────────────┐
│ Transport.events  ◄──── RuntimeEventSource                    │
│   on('geometry'): emits HashedGeometryResult (resolved)       │
│                                                                │
│ Transport.channel ◄──── RuntimeChannel (wire bytes)           │
│   onMessage: sync wire delivery                                │
│   send: bytes + ChannelAttachments                             │
│                                                                │
│ Transport bridges channel→events internally:                   │
│   channel.onMessage(async (wire) => {                          │
│     events.emit(await materialise(wire));                      │
│   });                                                          │
└───────────────────────────────────────────────────────────────┘
```

### Channel adapters (R2 + R8)

```text
                       ┌─────────────────────────┐
                       │      RuntimeChannel     │
                       │  (bytes in/out only)    │
                       └────────────┬────────────┘
                                    │ implemented by
        ┌───────────────┬───────────┼───────────┬──────────────────┐
        ▼               ▼           ▼           ▼                  ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ MessageChannel│ │   Worker     │ │  WebSocket   │ │ Electron IPC │ │   FFI / N-API │
│ (in-process) │ │  (browser)   │ │  (remote)    │ │ (desktop)    │ │   (native)    │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## Migration Sketch

This is a sequenced plan; each step is independently shippable.

| Step | Change                                                                                                                | Test surface                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | Add `Promise.withResolvers()` shim in `libs/utils`; refactor `connect()` to use it.                                   | Existing terminate-invariant tests must still pass (no behaviour change).    |
| 2    | Add `RuntimeEventSource` type + `createDomainEventSource()` helper.                                                   | Unit tests for the helper (subscribe / emit / unsubscribe / sync semantics). |
| 3    | Refactor each transport (`in-process`, `worker`, `websocket`) to expose `events` + `channel`.                         | Conformance suite extended with the pre-resolved-payload assertion (R6).     |
| 4    | Refactor `RuntimeClient` to subscribe to `transport.events` instead of `RuntimeWorkerClient.onGeometryComputed` IIFE. | All existing client tests pass with `flushMicrotasks` calls **deleted**.     |
| 5    | Delete `flushMicrotasks` from `kernel-worker.test.ts` and `runtime-client.test.ts`.                                   | Smoke check that no test secretly depended on the drain.                     |
| 6    | Replace `port: MessagePort` in `ConnectOptions` with a typed `RuntimeFileSystem` discriminated union.                 | New connect-options tests for each `kind`; old `port:` callers migrated.     |
| 7    | Author `createElectronIpcTransport` stub; run conformance suite.                                                      | Conformance + a stub end-to-end smoke test.                                  |

Steps 1, 2, 5 are pure refactors. Steps 3–4 are the substantive change. Step 6 is an API break (caught by the public-surface audit script). Step 7 is additive.

## Antipatterns to Encode in Policy

The new section to land in `docs/policy/library-api-policy.md`:

> ### § 22 — Async Surface Hygiene
>
> Five patterns that signal an async/sync mismatch in your API contract. If you find yourself reaching for any of them, the contract is wrong — fix the contract, not the syntax.
>
> **Antipattern 1 — `void (async () => { … })()` IIFE.** Indicates a sync void callback whose body needs to await. Either change the callback signature to return `Promise<void>` (and have the dispatcher await it), or move the async work upstream so the payload arrives already-resolved.
>
> **Antipattern 2 — `void promise.then(…)`.** Identical root cause. Discards the error pipeline and hides asyncness from any caller that wants to know "is this done yet?". Fix the contract so the caller sees the Promise.
>
> **Antipattern 3 — `await Promise.resolve()` to drain microtasks (in tests _or_ production).** A test that needs this is testing schedule timing, not behaviour. The API failed to expose its own asyncness; the test author is reverse-engineering the dispatcher's microtask schedule. Add an awaitable surface (`pushResponse` returning a Promise; `flush()` returning the in-flight Promise; etc.) and delete the helper.
>
> **Antipattern 4 — `new Promise((resolve, reject) => { void (async () => {…})() })`.** Symptom of the Deferred pattern in disguise. Use [`Promise.withResolvers()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers) (or a tiny shim) and keep the body an `async function`. The pattern exists when slot capture (e.g. `pendingConnect = { reject }`) must precede the awaited chain.
>
> **Antipattern 5 — Wire primitives in public option objects.** `MessagePort`, `Worker`, `WebSocket`, `ipcRenderer`, `MessagePortMain`, raw `SharedArrayBuffer` — these are channel-specific. A public option type that includes them couples the consumer to a single transport choice. Accept a typed handle (`RuntimeFileSystem`, `FilePoolHandle`, `ChannelHandle`) and let the transport bind the wire primitive internally.
>
> **Smell test**: if the file containing your callback also contains `// oxlint-disable @typescript-eslint/promise-function-async`, you have one of these antipatterns.

## References

- [`Promise.withResolvers()` — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers)
- [TC39 Stage 4 — `Promise.withResolvers`](https://github.com/tc39/proposal-promise-with-resolvers)
- [Electron `MessagePortMain`](https://www.electronjs.org/docs/latest/api/message-port-main) — the cross-process MessageChannel analog used by the proposed Electron IPC transport.
- Related research: [`runtime-event-driven-api-blueprint-v5.md`](./runtime-event-driven-api-blueprint-v5.md), [`runtime-blueprint-v5-implementation-audit.md`](./runtime-blueprint-v5-implementation-audit.md)
- Policy: [`library-api-policy.md`](../policy/library-api-policy.md)

## Appendix — Catalogued Smells in `packages/runtime/src`

| Site                                                 | Pattern                                            | Lines       |
| ---------------------------------------------------- | -------------------------------------------------- | ----------- |
| `client/runtime-client.ts`                           | `void (async () => {…})()` IIFE                    | 1041, 1219  |
| `client/runtime-client.ts`                           | `oxlint-disable promise-function-async` confession | 1197        |
| `client/runtime-client.ts`                           | `MessagePort` in public `ConnectOptions`           | 519         |
| `client/runtime-client.test.ts`                      | `flushMicrotasks` (8 iter)                         | 34–39       |
| `framework/kernel-worker.test.ts`                    | `flushMicrotasks` (100 iter, 23× usage)            | 33–38, etc. |
| `client/runtime-client-terminate-invariants.test.ts` | `await Promise.resolve()` between act / assert     | 98          |
