---
title: 'Runtime Transport ↔ Filesystem Topology'
description: 'Eigenquestion analysis of where the filesystem plugs into the runtime transport layer; identifies the dead-code field and supply-seam asymmetry that forced the Electron transport to provision two filesystems via test utilities.'
status: active
created: '2026-05-01'
updated: '2026-05-01'
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/research/runtime-transport-authoring-simplification.md
  - docs/policy/library-api-policy.md
---

# Runtime Transport ↔ Filesystem Topology

How the filesystem should plug into the v6 runtime transport plane — uncovered by the Electron utility transport's need to spin up two filesystems and import a test-only API.

## Executive Summary

The v6 transport layer ships with a structural smell: `HostInitializeBindings.fileSystem` is a typed slot that no consumer reads. Worker-side hosts (`webWorkerHost`, `nodeWorkerHost`) return placeholder `{}` casts; the actual filesystem binding flows through a separate `memoryHandle.fileSystemPort` / `inlineFileSystem` channel. The Electron utility transport, written against the documented type without the dispatcher source open, dutifully populated the placeholder slot — creating a second filesystem via the test-only `getTestFileSystem()` API and dragging vitest into the production renderer bundle.

The eigenquestion is **not** "how do we make the Electron transport less awkward". The eigenquestion is **"which side of the wire owns the filesystem authority for each topology, and what is the canonical seam for supplying it?"**. Today the answer is encoded inconsistently: web/node/in-process transports put `fileSystem` on `client(...)`, the Electron transport's own host script put it on `host(...)`, and `HostInitializeBindings` carries a third (dead) slot for it.

The architecturally correct answer is: **the side that owns the filesystem authority supplies it at that side's factory call**. The transport plugin author declares which side owns it via Zod schemas; the runtime never branches on a "fileSystem mode". A second, related smell surfaces when the same lens is applied to non-`MessagePort` wires (WebSocket, WebRTC, sandboxed-iframe `postMessage`): the FS bridge primitives in `transport-internals` are typed against the DOM `MessagePort` even though they only depend on the wire-agnostic `Port<T>` abstraction internally — blocking the same class of 3rd-party transport authors at a different layer. Six targeted recommendations (R1–R6) take the platform from today's state to a fully wire-agnostic shape with zero consumer-facing breakage and two new entries on `@taucad/runtime/transport-internals`.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Scope and Non-Goals](#scope-and-non-goals)
3. [Methodology](#methodology)
4. [Findings](#findings)
5. [Eigenquestion Analysis](#eigenquestion-analysis)
6. [Target Architecture](#target-architecture)
7. [Recommendations](#recommendations)
8. [Trade-offs](#trade-offs)
9. [Code Examples](#code-examples)
10. [Diagrams](#diagrams)
11. [Migration Path](#migration-path)
12. [References](#references)

## Problem Statement

The example transport at `examples/electron-tau/src/transport/electron-utility-transport.ts` provisions **two filesystems** in its `host()` factory:

```401:402:examples/electron-tau/src/transport/electron-utility-transport.ts
const utilityFsBase = getTestFileSystem();
const utilityFs = fromMemoryFs();
```

- `utilityFsBase` (a `RuntimeFileSystemBase`) — fed to `createWorkerDispatcher`'s `inlineFileSystem` option.
- `utilityFs` (the opaque `RuntimeFileSystem`) — returned from `adoptInitialize` so the `bindings.fileSystem` slot has a value.

The first import (`getTestFileSystem`) drags `vitest` and `vitest-mock-extended` into the renderer bundle through the transport file's import graph. In `nx dev` (no tree-shaking), vitest evaluates inside the browser, fails to find its worker state, and the renderer never mounts — a blank white window. In `nx test:e2e` (production-built renderer with Rollup tree-shaking) the unused `host()` body is pruned and the bug stays latent. The blank-screen renderer is the symptom; the architectural question is _why_ a transport author had to reach into a test API in the first place.

A second, layered question surfaced when the lens was widened from "Electron utility" to "every wire the v6 plugin author surface anticipates". The v6 doc's §6 Layer 1 inventory lists `WebSocket` alongside `MessagePort` / `MessagePortMain` / `Worker` / `utilityProcess`, and D6 explicitly defers a remote/WebSocket transport as an author-extension target. A WebSocket transport has the same fs-supply choice the Electron utility has (host-owned vs. client-bridged), but the bridged sub-case hits a _separate_ MessagePort-coupling at the bridge primitive layer — surfaced here so the recommendations cover both gaps in one pass.

## Scope and Non-Goals

**In scope**:

- The `HostInitializeBindings.fileSystem` field and whether it is wired anywhere in the dispatcher.
- The supply-seam asymmetry across `inProcessTransport`, `webWorkerTransport`, `nodeWorkerTransport`, `electronUtilityTransport`, and a hypothetical (deferred per v6 D6) `webSocketTransport`.
- The public-API gap that forced `electronUtilityTransport` to import `@taucad/runtime/testing#getTestFileSystem`.
- The `MessagePort`-typed parameter on `createBridgeServer` / `createBridgeProxy` / `createBridgeCall` and whether it can be relaxed to `Port<T>` without changing the wire protocol.

**Out of scope**:

- A _layered/overlay_ filesystem (e.g. server-supplied libs + client-supplied projects rendered into a single namespace). That is an fs-composition concern (`fromUnionFs(a, b)` factory candidate) orthogonal to where each leaf fs is supplied.
- Wire-encoding details for non-`MessagePort` transports (binary framing, JSON vs. MessagePack vs. CBOR for `Uint8Array` payloads, sub-protocol multiplexing one connection across runtime + fs RPC). These are wire-author concerns for whoever writes the WebSocket / WebRTC adapter.
- A v7 promotion of `fileSystem` to a top-level peer of `transport` on `RuntimeClientOptions` / `RuntimeHostConfig`. Considered and rejected here for v6.x (see Eigenquestion E4) — revisit if a future use case demands a single fs reference shared across two transports.

## Methodology

This investigation drew on:

- A line-by-line read of `packages/runtime/src/transport/{in-process,web-worker-host,web-worker-client,node-worker-host,node-worker-client}.ts`.
- The `worker-host-bindings.ts` shared factory and the `runtime-worker-dispatcher.ts` `WorkerDispatcherOptions` slot.
- The opaque `RuntimeFileSystem` brand in `packages/runtime/src/filesystem/runtime-filesystem.ts` and the `transport/_internal/runtime-filesystem-handle.ts` resolver.
- The bridge primitives in `packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts` (`createBridgeServer`, `createBridgeProxy`, `createBridgeCall`, `createBridgePort`) and the `Port<T>` / `wrapMessagePort` abstractions in `packages/rpc/src/port.ts`.
- All current call sites of those bridge primitives (4 in runtime sources, ~50 in tests) to size the migration footprint of any API relaxation.
- Consumer call sites in `apps/ui/app/constants/kernel-worker.constants.ts`, `apps/ui/app/machines/cad.machine.ts`, `packages/cli/src/commands/export.ts`, and `packages/runtime/src/node.ts` (`createNodeClient`).
- The full chronological transcript at `agent-transcripts/83eb9751-da06-4638-9e85-85f65b0eb7f6` documenting the Electron renderer regression and its triage.
- Cross-reference against [`docs/research/runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md) for the target architecture (esp. Finding 4 "Layered FS authority", §"`RuntimeFileSystem` factories", the per-transport descriptor `fileSystem: 'inline' | 'bridged' | 'host-local' | 'unbound'`, and §6 Layer 1 wire inventory which lists WebSocket as an anticipated author-extension wire).

All path references reflect the working tree at the date in `updated`.

## Findings

### Finding 1: `HostInitializeBindings.fileSystem` is dead code

The `HostInitializeBindings` core type declares a `fileSystem: RuntimeFileSystem` field, intended (per v6 doc) as the canonical handle the dispatcher binds. In practice **no dispatcher path reads it**. Worker-side hosts populate it with empty placeholders:

```58:61:packages/runtime/src/transport/web-worker-host.ts
const hostFileSystemPlaceholder = (): RuntimeFileSystem => {
  const placeholder: RuntimeFileSystem = {} as unknown as RuntimeFileSystem;
  return placeholder;
};
```

```95:96:packages/runtime/src/transport/node-worker-host.ts
return {
  fileSystem: {} as unknown as RuntimeFileSystem,
```

The dispatcher binds the kernel's filesystem from one of two **other** sources entirely:

```549:560:packages/runtime/src/framework/kernel-worker.ts
/* Filesystem wiring — three precedence rules (TR16):
 * 1. `inlineFileSystem` takes precedence: same V8 cluster fast-path,
 *    no MessagePort serialization or bridge proxy.
 * 2. `fileSystemPort` falls back to the generic bridge proxy (worker /
 *    cross-process topologies).
 * 3. Neither: filesystem stays undefined; kernel runs without FS. */
if (input.transferables.inlineFileSystem) {
  this.fileSystem = adaptInlineFileSystem(input.transferables.inlineFileSystem);
  this._filesystem = this.createFileSystem();
} else if (input.transferables.fileSystemPort) {
  this.fileSystem = createBridgeProxy<RuntimeFileSystemBase>(input.transferables.fileSystemPort, {
```

The `bindings.fileSystem` slot is plumbed nowhere. It is a pre-v6 vestige carried into the new shape "for completeness" without an active consumer. The Electron transport author, working from the public type, populated it correctly per the contract — but the contract itself was incorrect.

### Finding 2: The filesystem supply seam is inconsistent across transports

| Transport                         | Supply seam (today)                           | Why this seam                                                                                        | FS lives in                     |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `inProcessTransport`              | `client({ fileSystem })`                      | Caller IS the host (same isolate)                                                                    | Caller's isolate                |
| `webWorkerTransport`              | `client({ fileSystem })`                      | Renderer owns the FM-worker channel; bridges to worker                                               | Renderer (bridged)              |
| `nodeWorkerTransport`             | `client({ fileSystem })`                      | Caller owns Node disk; bridges to worker                                                             | Caller (bridged)                |
| `electronUtilityTransport`        | `host({})` (no fs option — author hard-coded) | Renderer has no FS authority; utility process is the Node-disk owner                                 | Utility process                 |
| `createNodeClient` (CLI)          | `client({ fileSystem })` (in-process)         | Caller IS the host                                                                                   | Caller's isolate                |
| `webSocketTransport` (D6, future) | n/a (transport not yet authored)              | Two valid sub-shapes: server owns disk (host-local) or client bridges browser fs over wire (bridged) | Server _or_ client, app-defined |

The same conceptual concern — "where is the filesystem authority" — lives at four different API positions across the bundled and example transports. The Electron transport is the only case where the host owns FS authority, but its current implementation hides this by manufacturing one inside `host()` rather than accepting it as a host-side option.

The hypothetical `webSocketTransport` row is included because it surfaces a _second_ seam decision: the bridged sub-shape (server-side kernel reading from a `fromBrowserFs(handle)` over the wire) needs the same fs-supply primitive as the worker transports, but cannot use the existing `MessagePort`-based bridge machinery. That gap is enumerated in Finding 7.

The v6 blueprint actually predicts this asymmetry — its example schema for the Electron transport reads:

```1337:1339:docs/research/runtime-transport-architecture-v6.md
export const electronUtilityHostOptionsSchema = z.object({
  fileSystem: runtimeFileSystemSchema,
});
```

…but the implementation drifted: the actual `electron-utility-transport.schemas.ts` declares an empty host-options schema and the host body manufactures the fs internally, leading to the `getTestFileSystem` workaround.

### Finding 3: Third-party transport authors have no public API to extract a `RuntimeFileSystemBase`

The `RuntimeFileSystem` opaque handle resolves to a `RuntimeFileSystemHandle` discriminated union (`{ kind: 'inline', fs }` | `{ kind: 'channel', port }`) via `resolveRuntimeFileSystem(...)` in `transport/_internal/runtime-filesystem-handle.ts`. The bundled `inProcessTransport` uses this internally:

```259:268:packages/runtime/src/transport/in-process-transport.ts
const extractInlineFileSystem = (fs: RuntimeFileSystem | undefined): RuntimeFileSystemBase | undefined => {
  if (!fs) {
    return undefined;
  }
  const handle = resolveRuntimeFileSystem(fs);
  if (handle.kind !== 'inline') {
    throw new Error(`inProcessTransport: fileSystem must be in-isolate; received '${handle.kind}'`);
  }
  return handle.fs;
};
```

But `resolveRuntimeFileSystem` is **not** re-exported from `@taucad/runtime/transport-internals` — that subpath exposes bridge primitives (`createBridgeServer`, `createBridgePort`, `createBridgeCall`, etc.) and the `exposeFileSystem` / `createFileSystemBridge` wrappers, but no inline-base extractor. A 3rd-party transport that needs to thread an inline `RuntimeFileSystemBase` to `createWorkerDispatcher({ inlineFileSystem })` can:

| Option                                                               | Verdict                              |
| -------------------------------------------------------------------- | ------------------------------------ |
| Reach into `@taucad/runtime/testing#getTestFileSystem`               | Drags vitest into prod (today's bug) |
| Reach into `transport/_internal/runtime-filesystem-handle` (private) | Bypasses the public API contract     |
| Receive a `RuntimeFileSystemBase` from somewhere                     | No public source exists              |
| Construct a `RuntimeFileSystemBase` manually                         | Not exported as a constructor        |

There is no clean third-party path. This is the API gap that _caused_ the misuse in the renderer-blanking bug.

### Finding 4: The "two-filesystems" symptom collapses to one underlying problem

The Electron host's two filesystems exist for two different reasons:

1. `utilityFsBase` (`RuntimeFileSystemBase`) → satisfies `createWorkerDispatcher({ inlineFileSystem: ... })`. Real use: the kernel needs FS access.
2. `utilityFs` (`RuntimeFileSystem` opaque) → satisfies `bindings.fileSystem` in the return value of `adoptInitialize(...)`. Real use: **none** (Finding 1).

Eliminate the `bindings.fileSystem` field (Finding 1), and the host needs only ONE filesystem. Then expose a public extractor (Finding 3), and the host can derive the `RuntimeFileSystemBase` from a properly-supplied opaque `RuntimeFileSystem` via the host options schema, mirroring the v6 doc's own example.

### Finding 5: The transport descriptor's `fileSystem` axis already documents the correct topology vocabulary

The v6 `TransportDescriptor` enumerates:

```691:691:packages/runtime/src/transport/runtime-transport.types.ts (per v6 doc §6)
readonly fileSystem: 'inline' | 'bridged' | 'host-local' | 'unbound';
```

| Value        | Meaning                                       | Today's transports                          | Future transports (anticipated)                                                                     | FS supplied at                                    |
| ------------ | --------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `inline`     | Same isolate as caller                        | `inProcessTransport`                        | —                                                                                                   | `client.fileSystem`                               |
| `bridged`    | Caller's isolate, transport bridges over wire | `webWorkerTransport`, `nodeWorkerTransport` | `webSocketTransport` (W2 — browser-FS-over-wire), `webRtcTransport`, sandboxed-iframe `postMessage` | `client.fileSystem`                               |
| `host-local` | Host's isolate (caller has none)              | `electronUtilityTransport`                  | `webSocketTransport` (W1 — server-disk render), `cloudflareWorkerTransport`                         | `host.fileSystem` (intended) / fabricated (today) |
| `unbound`    | No FS                                         | (none today)                                | `webSocketTransport` (W3 — stateless render)                                                        | n/a                                               |

The descriptor vocabulary already encodes the supply-seam decision. The implementation just needs to honor it: `inline` and `bridged` modes accept fs on `client()`; `host-local` mode accepts fs on `host()`. This is not a new architectural primitive — it's surfacing what the descriptor already says.

The `webSocketTransport` slot is filled in for three sub-shapes (W1/W2/W3) to demonstrate that a single transport plugin author may legitimately ship multiple `fileSystem` descriptor values depending on consumer configuration. The schema decides at compile time which side accepts the option; the descriptor merely advertises the wire's capability.

### Finding 6: Renderer blank-screen is a downstream symptom, not a separate issue

The transcript captures the renderer-side crash as a `vitest` import side-effect when `getTestFileSystem` resolves through `@taucad/runtime/testing#kernel-testing.utils.ts`:

```19:21:packages/runtime/src/testing/kernel-testing.utils.ts
import type { Mock } from 'vitest';
import { expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
```

In dev (Vite, no tree-shaking), the entire transitive graph of `electronUtilityTransport` evaluates inside the renderer, vitest tries to bootstrap, fails, the React tree never mounts. In e2e (Rollup, full tree-shaking), the host-only `getTestFileSystem` reference is dead-coded out and the bug doesn't manifest.

**Conclusion**: the renderer crash is one of _several_ observable consequences of the underlying API gap. Other latent consequences include:

- A second `fromMemoryFs()` allocation per host process (memory waste — small but architectural noise).
- Future co-located host imports (e.g. `@taucad/runtime/worker-internals`) silently bloating the renderer bundle.
- Other 3rd-party transport authors hitting the same dead-end and copying the workaround.

A correct fix removes all three at once.

### Finding 7: Bridge primitives are `MessagePort`-coupled at the public API surface

The bridged-fs path (used by `webWorkerTransport`, `nodeWorkerTransport`, and the future Electron utility/WebSocket bridged sub-shapes) flows through three primitives in `transport-internals`:

```225:241:packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts
export function createBridgeServer<T extends StringKeyedObject>(
  handlers: T,
  port: MessagePort,    // ← typed as DOM MessagePort
  options?: { /* ... */ },
): BridgeServerHandle {
  /* ... */
  const wrappedPort = wrapPort(port, 'bridge-server');
```

`createBridgeProxy(port: MessagePort, ...)` and `createBridgeCall(port: MessagePort, ...)` mirror the same coupling. The internal `wrapPort` is a thin one-liner:

```208:210:packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts
const wrapPort = (port: MessagePort, label: string): Port<unknown> => {
  const wrapped = wrapMessagePort<unknown>(port, { label });
  return wrapped;
};
```

Downstream of `wrapPort`, every consumer (`createChannelServer`, `createChannelClient`) only depends on the wire-agnostic `Port<T>` abstraction from `@taucad/rpc`:

```12:23:packages/rpc/src/port.ts
export type Port<T> = {
  postMessage(data: T, transfer?: readonly Transferable[]): void;
  onMessage(handler: (data: T) => void): () => void;
  start?(): void;
  close(): void;
};
```

The bridge protocol (`{ v: 1, k: 'c'|'r'|'l'|'p'|… }` envelopes) does not require `MessagePort`-specific semantics. It requires a bidirectional channel that can carry structured data plus optional transferables — `Port<T>` already encodes both. The `MessagePort` typing on the public API is **incidental coupling**, not load-bearing.

This matters for any 3rd-party transport author whose wire is not a `MessagePort` and who needs the bridged-fs sub-shape:

| Wire family                                                                                      | Today's outcome                                                                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| DOM Worker / Node `worker_threads` / Electron `MessagePortMain` (native `MessagePort`)           | Works                                                                                                      |
| WebSocket / WebRTC `RTCDataChannel` / sandboxed-iframe `postMessage` / custom in-memory channels | Type error at `createBridgeServer` despite a trivial `Port<T>` adapter being possible (~30 lines per wire) |

The transport author can build a `Port<T>` adapter from any of the second-row wires (the structural shape is just `postMessage` + `onMessage` + `close`, with `transfer` ignored — fs RPC binary payloads fall back to copy framing via the existing `WithTransferables` hoist). But the current bridge primitive signatures **reject the adapter at compile time** because they demand a real DOM `MessagePort`.

The internal call-site footprint of relaxing the signature is mechanical: 4 production-source call sites in `runtime-filesystem-bridge.ts` (lines 188, 426, 650) and `filesystem-bridge.ts` (line 188), plus ~50 test sites in `runtime-filesystem-bridge.test.ts`. Every change is a one-line wrap (`createBridgeServer(handlers, channel.port1)` → `createBridgeServer(handlers, wrapMessagePort(channel.port1))`). No wire protocol change, no behavioral change, no consumer impact.

## Eigenquestion Analysis

The user-stated framing was _"is having the electron transport spin up 2 filesystems correct?"_ The answer (no, per Finding 4) is downstream of a deeper question:

> **E1: Where does filesystem authority live in each topology, and what is the canonical seam for the consumer to supply it?**

Each topology has exactly one fs-authority side, derivable from environmental facts:

| Topology                       | Wire shape                | FS-authority side            | Why                                                                 |
| ------------------------------ | ------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| In-process                     | Same isolate              | Either side (caller==host)   | Trivial                                                             |
| Browser web-worker             | Renderer ↔ Worker         | Renderer (caller)            | Worker can't access disk; FM-worker bridge lives in renderer        |
| Node `worker_threads`          | Main ↔ Worker             | Main (caller)                | Worker doesn't have its own FS root                                 |
| Electron utility               | Renderer ↔ Utility (Node) | Utility (host)               | Utility has Node disk access; renderer is sandboxed                 |
| Electron utility (alt.)        | Renderer ↔ Utility (Node) | Renderer (bridges FM worker) | If app routes FM through renderer like `apps/ui`                    |
| WebSocket — W1 "render server" | Browser ↔ Remote Node     | Server (host)                | Server owns project disk; browser is thin client                    |
| WebSocket — W2 "tunneled FS"   | Browser ↔ Remote Node     | Browser (client)             | Kernel runs server-side but reads `fromBrowserFs(handle)` over wire |
| WebSocket — W3 "stateless"     | Browser ↔ Remote Node     | Neither                      | Request/response render with no project files                       |

The architecturally correct seam is: **whichever side owns FS authority supplies the fs at that side's factory call**.

This collapses naturally onto the existing `client()` / `host()` factory split:

- `inline` and `bridged` topologies → fs on `client(options)`.
- `host-local` topology → fs on `host(options)`.
- `unbound` → fs nowhere.

The transport plugin author **declares which side(s) accept fs via Zod schemas**. The runtime never sees a "fs mode" enum or branches on the descriptor. This is the same single-source-of-truth pattern the kernel layer already uses for `optionsSchema` / `renderSchema` / `exportSchemas`.

> **E2: Should `HostInitializeBindings.fileSystem` exist?**

No. The dispatcher binds fs from `WorkerDispatcherOptions.inlineFileSystem` (in-isolate fast path) or `RuntimeInitializeMemoryHandle.fileSystemPort` (bridged path). The bindings record's `fileSystem` field is not on either path. Removing it deletes the dead-code that forced the Electron host's misuse.

> **E3: Is `RuntimeFileSystemBase` part of the public transport-author surface?**

Yes. Any transport that runs the dispatcher in its host needs to supply `inlineFileSystem` (when the host owns the fs). The bundled `inProcessTransport` does this via the internal `extractInlineFileSystem` helper. A third-party transport (Electron utility today, future iframe / WebSocket / WebRTC tomorrow) needs the same primitive on the **public** transport-author surface. The cleanest place is `@taucad/runtime/transport-internals`, which is the documented "transport-author primitives" subpath.

> **E4: Should `fileSystem` be promoted to a top-level peer of `transport` on `RuntimeClientOptions` / `RuntimeHostConfig`?**

Considered but rejected for v6.x. Promoting it to the top level would:

- Force every consumer to refactor their call sites (vs the per-transport status quo where some have it and some don't).
- Conflate fs-authority side: which side is `RuntimeClientOptions.fileSystem` for? It's ambiguous in transports where both sides theoretically could carry one.
- Lose the natural validation power of the per-transport Zod schema (which currently rejects fs at the wrong side at compile time).

The per-transport schema-driven seam (Finding 5 + the descriptor vocabulary) is more honest about the inherent topology coupling. Top-level promotion is a v7 candidate if a future use case demands a single fs reference shared across two transports — none exists today.

> **E5: Should the FS bridge primitives (`createBridgeServer` / `createBridgeProxy` / `createBridgeCall`) accept `Port<T>` instead of `MessagePort`?**

Yes. The protocol the bridge implements is wire-agnostic — `{ v: 1, k: ... }` envelopes plus `WithTransferables` payload hoisting. The bridge depends on `Port<T>` semantics (`postMessage` / `onMessage` / `close`) and nothing else. The `MessagePort` typing on the public signature is a residual coupling from when the only callers were worker transports; it has no implementation justification.

Relaxing the parameter to `Port<T>` lets every 3rd-party transport author with a non-`MessagePort` wire build a `~30-line` adapter and use the same battle-tested bridge protocol. Wire-encoding details (binary framing for `Uint8Array`, multiplexing one connection across runtime + fs RPC) are properly the adapter's concern — the bridge protocol stays clean.

The author DX symmetry is also worth naming: the runtime's _own_ fs supply seam is the opaque `RuntimeFileSystem` (consumer-facing), and the runtime's _own_ bridging primitive should be the opaque `Port<T>` (transport-author-facing). Both layers stop leaking wire types where they don't belong.

This is parallel to E2 in shape: just as `HostInitializeBindings.fileSystem` was a typed slot wired to nothing, the `MessagePort`-typed bridge parameter is a typed _narrowing_ doing no work — both are removable without touching runtime semantics.

## Target Architecture

### Layered model (delta from v6)

```
┌────────────────────────────────────────────────────────────────────┐
│ Layer 4 — Plugin Layer                                             │
│   Transport plugin: client({...}) and host({...}) — each with      │
│   its own Zod options schema. The schema declares whether          │
│   `fileSystem` is required, optional, or absent on this side.      │
│                                                                    │
│   Per-topology rules (declared in schemas, not branched):          │
│     'inline'      → client.fileSystem required, host: passthrough  │
│     'bridged'     → client.fileSystem required, host: bundled host │
│     'host-local'  → host.fileSystem required,  client: no fs       │
│     'unbound'     → neither side accepts fs                        │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 3b — Transport Internals (private)                           │
│   HostInitializeBindings = { abort, geometryDelivery,              │
│                              fileDelivery } & BindingsExtra        │
│   ── NO `fileSystem` field — that was dead code (Finding 1).       │
│                                                                    │
│   FS binding flows through TWO non-bindings paths:                 │
│     1. WorkerDispatcherOptions.inlineFileSystem (same-isolate)     │
│     2. RuntimeInitializeMemoryHandle.fileSystemPort (bridged)      │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 3c — `@taucad/runtime/transport-internals` (public for       │
│   transport authors)                                               │
│                                                                    │
│   NEW (R2): `extractInlineFileSystem(fs: RuntimeFileSystem):       │
│               RuntimeFileSystemBase | undefined`                   │
│                                                                    │
│   RELAXED (R6): `createBridgeServer(handlers, port: Port<T>, ...)` │
│                 `createBridgeProxy(port: Port<T>, ...)`            │
│                 `createBridgeCall(port: Port<T>, ...)`             │
│     — was `MessagePort`; callers wrap raw `MessagePort` with       │
│       `wrapMessagePort` from `@taucad/rpc` (one-line shim).        │
│                                                                    │
│   Existing: exposeFileSystem, createFileSystemBridge,              │
│             createBridgePort (returns transferable MessagePort —   │
│             unchanged because its output MUST be a transferable),  │
│             waitForWorkerReady                                     │
└────────────────────────────────────────────────────────────────────┘
```

### Per-transport responsibility matrix (target)

| Transport                         | `client({fileSystem})`        | `host({fileSystem})`          | How dispatcher gets fs                                                                                                                       |
| --------------------------------- | ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `inProcessTransport`              | required (opaque)             | not accepted (passthrough)    | `extractInlineFileSystem(client.fileSystem)` → dispatcher's `inlineFileSystem`                                                               |
| `webWorkerTransport`              | required (opaque)             | not accepted (worker-bundled) | bridge port → `memoryHandle.fileSystemPort` → bridge proxy in worker                                                                         |
| `nodeWorkerTransport`             | required (opaque)             | not accepted (worker-bundled) | same as web-worker                                                                                                                           |
| `electronUtilityTransport`        | not accepted (renderer no-fs) | required (opaque)             | `extractInlineFileSystem(host.fileSystem)` → dispatcher's `inlineFileSystem`                                                                 |
| `webSocketTransport` (W1, future) | not accepted (browser no-fs)  | required (opaque)             | `extractInlineFileSystem(host.fileSystem)` → dispatcher's `inlineFileSystem` (server-side)                                                   |
| `webSocketTransport` (W2, future) | required (opaque)             | not accepted (server bundled) | `extractInlineFileSystem(client.fileSystem)` → wrap as `Port<T>` over WS sub-channel → `createBridgeServer(handlers, wrappedPort)` on server |
| `webSocketTransport` (W3, future) | not accepted                  | not accepted                  | dispatcher runs without fs (`unbound`)                                                                                                       |

Reading rule: each transport's Zod schema rejects `fileSystem` on the wrong side at compile time. `electronUtilityTransport.client({ fileSystem: ... })` is a type error; `webWorkerTransport.host({ fileSystem: ... })` is a type error. WebSocket sub-shapes (W1/W2/W3) are most naturally modelled as **separate transport plugins** sharing a common WS adapter — `webSocketHostLocalTransport`, `webSocketBridgedTransport`, `webSocketStatelessTransport` — each with its own schema. A single union plugin with `z.discriminatedUnion(...)` over a `mode` literal is also viable; the choice belongs to whoever authors the WS transport.

### Runtime client / host configuration (unchanged)

`RuntimeClientOptions` and `RuntimeHostConfig` keep their current shape — `transport` is the only fs-relevant field. The fs-supply decision is delegated to whichever factory call constructs the transport. This honors the v6 invariant _"the runtime never reads wire facts"_ — the runtime never even sees `fileSystem` as a separate top-level option.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Priority | Effort | Impact                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Delete `HostInitializeBindings.fileSystem`.** Drop the field from the type, drop the dead `hostFileSystemPlaceholder()` from `webWorkerHost`, drop the `{} as unknown as RuntimeFileSystem` from `nodeWorkerHost`, drop the `utilityFs` second-fs from the Electron transport.                                                                                                                                                                                                                                                                                                             | P0       | S      | **Status: implemented (this PR).** Eliminates the type-driven misuse across all transports; removes 3 placeholders.                                                                                                              |
| R2  | **Add `extractInlineFileSystem(fs: RuntimeFileSystem): RuntimeFileSystemBase \| undefined` to `@taucad/runtime/transport-internals`.** Wraps the internal `resolveRuntimeFileSystem` + `kind === 'inline'` check. Lets 3rd-party transports thread an opaque fs into `createWorkerDispatcher({ inlineFileSystem })` without reaching into `/testing` or `/_internal`.                                                                                                                                                                                                                        | P0       | S      | **Status: implemented (this PR).** Closes the API gap that _caused_ the renderer-blanking bug; idiomatic surface for future Electron / iframe / WebRTC / WebSocket transports.                                                   |
| R3  | **Refactor `electronUtilityTransport` to accept `fileSystem` on its `host({...})` options** (matching the v6 doc's `electronUtilityHostOptionsSchema`). The bootstrap script supplies `host({ fileSystem: fromNodeFs(projectRoot) })`. Internally the host calls the new `extractInlineFileSystem(...)` from R2. Removes the `getTestFileSystem` import → removes the vitest-in-renderer pollution.                                                                                                                                                                                          | P0       | M      | **Status: implemented (this PR).** Fixes the renderer blank-screen bug by construction; aligns the example with the v6 spec it claims to implement.                                                                              |
| R4  | **Add a transport-author lint guardrail** banning imports from `@taucad/runtime/testing` outside `**/*.test.ts` / `**/testing/**` files.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P1       | S      | **Status: implemented (this PR).** Prevents the next test-API-in-prod regression of the same shape.                                                                                                                              |
| R5  | **Document the supply-seam matrix in the runtime-architecture-policy.md** with a per-topology rule: "fs goes on the side that owns fs authority for that wire".                                                                                                                                                                                                                                                                                                                                                                                                                              | P1       | S      | **Status: implemented (this PR).** Codifies the eigenquestion answer so future transport authors don't re-derive it.                                                                                                             |
| R6  | **Relax `createBridgeServer` / `createBridgeProxy` / `createBridgeCall` to accept `Port<T>` instead of `MessagePort`.** Drop the internal `wrapPort` helper; existing callers wrap their raw `MessagePort` with `wrapMessagePort` from `@taucad/rpc` (one-line change at 4 production-source call sites + ~50 mechanical test-site changes). `createBridgePort` keeps its current shape (its return value MUST be a transferable `MessagePort`). Re-export `wrapMessagePort` from `@taucad/runtime/transport-internals` so transport authors don't have to depend on `@taucad/rpc` directly. | P2       | S      | **Status: implemented (this PR).** Unblocks WebSocket / WebRTC / iframe-`postMessage` / custom-channel transports without changing the bridge wire protocol. Pure type relaxation; runtime behavior unchanged. Closes Finding 7. |

**Status**: Recommendations **R1–R6 are implemented** in the Tau monorepo (dead `HostInitializeBindings.fileSystem`, `extractInlineFileSystem`, required Electron utility `host({ fileSystem })`, ESLint guardrail + policy matrix, bridge `Port<unknown>` + `transport-internals` `wrapMessagePort` re-export, Playwright disk-supply coverage).

Net change: one type-field deletion, two new public APIs (`extractInlineFileSystem` + re-exported `wrapMessagePort`), three relaxed parameter types, one example refactor, one lint rule, one policy update. No consumer-facing breakage in `apps/ui`, `packages/cli`, `apps/api`, or any bundled transport — the changes are confined to the `host` side of the Electron example transport, the `host` placeholder removal in worker hosts, and the bridge-primitive call-site wrapping (mechanical, internally-owned).

## Trade-offs

| Decision                                               | Option chosen                                    | Alternative considered                                                                                                  | Why chosen                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HostInitializeBindings.fileSystem`                    | Delete                                           | Keep, document as "set if known, dispatcher ignores"                                                                    | Dead fields are landmines — they invite the exact misuse that surfaced (Finding 4).                                                                                                                                                                                                                                                                                                                                                  |
| Inline-fs extractor location                           | `@taucad/runtime/transport-internals`            | `@taucad/runtime/filesystem`                                                                                            | `transport-internals` is the documented "transport-author primitives" subpath; `filesystem` is consumer-facing and should stay opaque.                                                                                                                                                                                                                                                                                               |
| Inline-fs extractor name                               | `extractInlineFileSystem`                        | `resolveRuntimeFileSystem` (rename internal)                                                                            | The extractor returns _only_ the inline arm and throws for `channel` arm — a more constrained shape than the internal resolver.                                                                                                                                                                                                                                                                                                      |
| Where the fs option goes per topology                  | Per-transport schema                             | Top-level `RuntimeClientOptions.fileSystem` peer of `transport`                                                         | Per-transport schema gives compile-time validation per topology; top-level peer would be ambiguous (which side?) and would force every consumer to refactor.                                                                                                                                                                                                                                                                         |
| Electron host supplied at `host(...)`                  | Required option (Zod-enforced)                   | Optional with internal `fromMemoryFs()` fallback                                                                        | An optional fallback hides intent — a renderer-side host script that forgot the fs would silently use an in-memory fixture instead of the user's project. Fail loudly at the schema.                                                                                                                                                                                                                                                 |
| Renderer-side reach into `/testing`                    | Lint guardrail (R4)                              | TypeScript "private" markers                                                                                            | Lint runs in CI and surfaces the violation at PR time; private markers don't propagate through path mappings cleanly.                                                                                                                                                                                                                                                                                                                |
| Bridge primitive parameter type                        | Relax to `Port<T>`, callers wrap explicitly (R6) | Add `MessagePort \| Port<T>` overload (non-breaking) OR keep `MessagePort` and detect at runtime (status quo, narrowed) | The relaxation costs ~54 mechanical call-site wraps (all internally-owned). The overload approach hides the wrap inside the primitive, which re-introduces the coupling we're trying to eliminate. Status quo blocks every non-port wire at compile time. Explicit wrapping at call sites is the cleanest contract: the _primitive_ sees only `Port<T>`; the _caller_ knows whether it has a real `MessagePort` or a custom adapter. |
| Re-export `wrapMessagePort` from `transport-internals` | Yes                                              | Force authors to depend on `@taucad/rpc` directly                                                                       | `transport-internals` is the documented one-stop subpath for transport-author primitives; an extra dep on `@taucad/rpc` is unnecessary friction. Re-export keeps the transitive surface narrow.                                                                                                                                                                                                                                      |
| WebSocket sub-shapes (W1/W2/W3)                        | Separate transport plugins per shape             | Single union plugin with `mode` discriminator                                                                           | Either is viable; defer the choice to whoever authors the WS transport. Separate plugins are clearer per call site; a discriminator union shares the WS adapter code.                                                                                                                                                                                                                                                                |

## Code Examples

### Today (broken — vitest leaks into renderer)

```typescript
// examples/electron-tau/src/transport/electron-utility-transport.ts (current)

import { fromMemoryFs } from '@taucad/runtime/filesystem';
import { getTestFileSystem } from '@taucad/runtime/testing'; // ← drags vitest into renderer
import { KernelRuntimeWorker /* ... */ } from '@taucad/runtime/worker-internals';

export const electronUtilityTransport = defineRuntimeTransport({
  /* ... */
  host(_hostOptions) {
    /* ... */
    const utilityFsBase = getTestFileSystem(); // ← Test API for prod use
    const utilityFs = fromMemoryFs(); // ← Second fs, never read
    /* ... */
    return {
      adoptInitialize(_handle) {
        return {
          fileSystem: utilityFs, // ← Dead code (Finding 1)
          /* ... */
        };
      },
      /* ... */
    };
  },
});
```

### After R1 + R2 + R3 (clean)

```typescript
// packages/runtime/src/transport-internals.ts (NEW export, R2)

export { extractInlineFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';
```

```typescript
// packages/runtime/src/transport/_internal/runtime-filesystem-handle.ts (R2)

/**
 * Extract the underlying `RuntimeFileSystemBase` from an opaque
 * `RuntimeFileSystem` produced by a `fromX` factory. Returns `undefined`
 * when no fs was supplied.
 *
 * Throws when the fs was constructed via `fromChannelFs(...)` (the
 * `channel` arm) — channel-bridged filesystems do not have an inline
 * base; they must be bridged via `MessagePort`.
 *
 * @public — for transport authors. Ordinary runtime consumers never
 *   need this primitive; `RuntimeFileSystem` stays opaque on the public
 *   `@taucad/runtime/filesystem` barrel.
 */
export const extractInlineFileSystem = (fs: RuntimeFileSystem | undefined): RuntimeFileSystemBase | undefined => {
  if (!fs) {
    return undefined;
  }
  const handle = resolveRuntimeFileSystem(fs);
  if (handle.kind !== 'inline') {
    throw new TypeError(`extractInlineFileSystem: expected inline fs, received '${handle.kind}'`);
  }
  return handle.fs;
};
```

```typescript
// examples/electron-tau/src/transport/electron-utility-transport.schemas.ts (R3)

import { z } from 'zod';
import { runtimeFileSystemSchema } from '@taucad/runtime/filesystem';

export const electronUtilityClientOptionsSchema = z.object({
  port: z.instanceof(MessagePort),
  /* no fileSystem — renderer has no fs authority for this topology */
});

export const electronUtilityHostOptionsSchema = z.object({
  fileSystem: runtimeFileSystemSchema, // ← required on host side
});
```

```typescript
// examples/electron-tau/src/transport/electron-utility-transport.ts (R3)

import { extractInlineFileSystem } from '@taucad/runtime/transport-internals';
//      ^^^^^^^^^^^^^^^^^^^^^^^^^^ no more @taucad/runtime/testing
import { fromMemoryFs } from '@taucad/runtime/filesystem';

export const electronUtilityTransport = defineRuntimeTransport({
  id: 'electron-utility',
  clientOptionsSchema: electronUtilityClientOptionsSchema,
  hostOptionsSchema: electronUtilityHostOptionsSchema,

  client(clientOptions) {
    /* ... unchanged ... */
  },

  host(hostOptions) {
    const utilityFsBase = extractInlineFileSystem(hostOptions.fileSystem);
    //    ^^^^^^^^^^^^^ one fs, supplied by the bootstrap script
    /* ... */
    const dispatcher = createWorkerDispatcher(worker, wireport, {
      inlineFileSystem: utilityFsBase,
      encodeGeometry,
      encodeFile,
    });
    /* ... */
    return {
      adoptInitialize(_handle) {
        return {
          /* no `fileSystem` field — R1 deleted the slot */
          abort: {
            /* ... */
          },
          geometryDelivery: {
            /* ... */
          },
          fileDelivery: {
            /* ... */
          },
        };
      },
      /* ... */
    };
  },
});
```

```typescript
// examples/electron-tau/src/main/kernel-host.ts (R3)

import { createRuntimeHost } from '@taucad/runtime/host';
import { fromNodeFs } from '@taucad/runtime/filesystem/node';
import { electronUtilityTransport } from '../transport/electron-utility-transport.js';

const projectRoot = process.env['TAU_PROJECT_ROOT'] ?? process.cwd();

const host = createRuntimeHost({
  transport: electronUtilityTransport.host({
    fileSystem: fromNodeFs(projectRoot), // ← real project fs, not a fixture
  }),
});
```

The renderer never imports `getTestFileSystem`, never imports `fromMemoryFs` from this transport file (there's no need), never drags vitest into its bundle. The example transport now matches the v6 doc's documented schema shape.

### After R6 — WebSocket "render server" (W1, host-owned fs)

The W1 sub-shape is **structurally identical to the Electron utility transport**: server-side fs authority, no client-side fs option, `extractInlineFileSystem` consumed inside `host()`. Only the wire (`WebSocket` vs. `MessagePortMain`) and the delivery tier (`copy` everywhere — no SAB) differ. The schema and host body fit on one screen:

```typescript
// future: packages/transports-websocket/src/web-socket-host-local-transport.ts (sketch)

import { defineRuntimeTransport, createWorkerDispatcher } from '@taucad/runtime';
import { extractInlineFileSystem } from '@taucad/runtime/transport-internals';
import { WebSocketServer } from 'ws';

export const webSocketHostLocalTransport = defineRuntimeTransport({
  id: 'web-socket-host-local',
  clientOptionsSchema: z.object({ url: z.string().url() }),
  hostOptionsSchema: z.object({
    fileSystem: runtimeFileSystemSchema,
    port: z.number().int().min(1024),
  }),
  client(clientOptions) {
    /* opens ws, returns Channel<RuntimeProtocol> */
  },
  host(hostOptions) {
    const fsBase = extractInlineFileSystem(hostOptions.fileSystem); // R2
    const wss = new WebSocketServer({ port: hostOptions.port });
    wss.on('connection', (ws) => {
      const dispatcher = createWorkerDispatcher(kernelWorker, wsAsRuntimePort(ws), {
        inlineFileSystem: fsBase,
        encodeGeometry,
        encodeFile,
      });
      bindDispatcherToWebSocket(dispatcher, ws);
    });
    return {
      adoptInitialize(_handle) {
        return {
          /* no `fileSystem` field — R1 deleted the slot */
          abort: { kind: 'wire-notify' },
          geometryDelivery: { kind: 'copy' },
          fileDelivery: { kind: 'copy' },
        };
      },
    };
  },
});
```

The bootstrap script on the render server is the obvious mirror of the Electron `kernel-host.ts` from the previous example: `createRuntimeHost({ transport: webSocketHostLocalTransport.host({ fileSystem: fromNodeFs('/srv/projects/user-123'), port: 8080 }) })`. Net structural difference vs. Electron: zero — confirming the eigenquestion answer scales to remote wires without new primitives.

### After R6 — WebSocket "tunneled FS" (W2, client-owned fs bridged over wire)

The W2 sub-shape needs the bridge primitives to work over a non-`MessagePort` wire. R6 makes that legal at compile time. The transport author writes a `~30-line` `Port<T>` adapter (`webSocketAsPort(ws)` — `ws.send` for `postMessage`, `'message'` event for `onMessage`, `ws.close()` for `close`; wire-encoding for binary payloads is the adapter's concern) and feeds it to `createBridgeServer`. The W2 client and host shapes:

```typescript
// future: packages/transports-websocket/src/web-socket-bridged-transport.ts (sketch)

import { defineRuntimeTransport, createWorkerDispatcher } from '@taucad/runtime';
import {
  createBridgeServer,
  extractInlineFileSystem, // R2
  wrapMessagePort, // re-exported from transport-internals — R6
} from '@taucad/runtime/transport-internals';
import { webSocketAsPort } from './web-socket-as-port.js';

export const webSocketBridgedTransport = defineRuntimeTransport({
  id: 'web-socket-bridged',
  clientOptionsSchema: z.object({
    url: z.string().url(),
    fileSystem: runtimeFileSystemSchema, // browser-owned, bridged over wire
  }),
  hostOptionsSchema: z.object({ port: z.number().int().min(1024) }),

  client(clientOptions) {
    const ws = new WebSocket(clientOptions.url);
    const fsBase = extractInlineFileSystem(clientOptions.fileSystem);
    // Bridge SERVER lives on the client — browser fs serves RPC calls
    // coming back from the server-side kernel.
    const fsSubChannel = webSocketAsPort(openFsSubChannel(ws));
    createBridgeServer(handlersFromFs(fsBase!), fsSubChannel); // R6
    return {
      /* runtime channel over the main ws sub-channel */
    };
  },

  host(hostOptions) {
    const wss = new WebSocketServer({ port: hostOptions.port });
    wss.on('connection', (ws) => {
      const fsProxyChannel = webSocketAsPort(openFsSubChannel(ws));
      const fsProxy = createBridgeProxy<RuntimeFileSystemBase>(fsProxyChannel); // R6
      const dispatcher = createWorkerDispatcher(kernelWorker, wsAsRuntimePort(ws), {
        // Server side has no inlineFileSystem — the dispatcher reads
        // from the bridge proxy attached above (RPC over the WS).
        encodeGeometry,
        encodeFile,
      });
      bindDispatcherToWebSocket(dispatcher, ws, { fsProxy });
    });
    return {
      adoptInitialize(_handle) {
        return {
          abort: { kind: 'wire-notify' },
          geometryDelivery: { kind: 'copy' },
          fileDelivery: { kind: 'copy' },
          /* no `fileSystem` field — R1 deleted the slot */
        };
      },
    };
  },
});
```

The takeaway from W2: the _bridge protocol_ and the _fs supply seam_ are both wire-agnostic with R2 + R6 in place. The transport author writes only the wire-specific glue (encoding, multiplexing, ws lifecycle) — the fs-bridge machinery and the opaque-handle extractor are reused as-is. This is the v6 "thin runtime core" promise honored at the transport-author layer. The internal call-site migration for R6 is a one-line wrap (see Finding 7's call-site table for the full inventory): `createBridgeServer(handlers, port)` becomes `createBridgeServer(handlers, wrapMessagePort(port))`, and `createBridgeServer`'s public parameter type changes from `MessagePort` to `Port<T>`.

## Diagrams

### FS supply seam, per topology

```
inline / bridged (in-process, web-worker, node-worker)
─────────────────────────────────────────────────────
                client.fileSystem  ←── consumer supplies here
                       │
                       ▼
       ┌───────────────────────────┐
       │ transport.client({...})   │
       │  - extracts opaque handle │
       │  - if 'inline' → pass to  │
       │    dispatcher.inlineFs    │
       │  - if 'channel' → bridge  │
       │    over wire as fsPort    │
       └───────────────────────────┘
                       │
                       ▼ (wire if bridged)
                 host (worker entry)
                       │
                       ▼
                  dispatcher reads
              inlineFs OR fsPort →
                    bridge proxy
                  → kernel.fs
```

```
host-local (electron-utility, future webSocketTransport W1)
───────────────────────────────────────────────────────────
   client.fileSystem  →  ✗ (rejected by Zod schema — type error)

                                    host.fileSystem  ←── consumer supplies here
                                            │ (bootstrap script in
                                            │   utility process / WS server)
                                            ▼
                              ┌──────────────────────────┐
                              │ transport.host({fs})     │
                              │  - extractInlineFs(fs)   │ ◀── R2
                              │  - pass to dispatcher    │
                              │    .inlineFileSystem     │
                              └──────────────────────────┘
                                            │
                                            ▼
                                       dispatcher reads
                                       inlineFs → kernel.fs
```

```
bridged over a non-MessagePort wire (future webSocketTransport W2)
──────────────────────────────────────────────────────────────────
            client.fileSystem (browser FileSystemAccess)
                       │
                       ▼ (extractInlineFs — R2)
       ┌──────────────────────────────────┐
       │ transport.client({fs, url})      │
       │  - opens WebSocket               │
       │  - opens fs sub-channel on ws    │
       │  - webSocketAsPort(fsChannel)    │ ◀── transport author writes
       │  - createBridgeServer(           │     a ~30-line Port<T> adapter
       │      fsHandlers, wsPort) ◀── R6  │
       └──────────────────────────────────┘
                       │
                       ▼ wire (WebSocket frames; binary-encoded fs RPC)
       ┌──────────────────────────────────┐
       │ transport.host(...)              │
       │  - opens fs sub-channel on ws    │
       │  - webSocketAsPort(fsChannel)    │
       │  - createBridgeProxy(wsPort) ◀── R6
       │  - feeds proxy to dispatcher     │
       └──────────────────────────────────┘
                       │
                       ▼
                  dispatcher reads
              bridge proxy → kernel.fs
                  (RPC calls travel back over WS to browser)
```

### Bindings shape — before vs after R1

```
Before (today):                          After (R1):
───────────────                          ───────────
HostInitializeBindings = {               HostInitializeBindings = {
  fileSystem,    ← DEAD CODE              abort,
  abort,                                  geometryDelivery,
  geometryDelivery,                       fileDelivery,
  fileDelivery,                         }
}                                       & BindingsExtra
& BindingsExtra
```

## Migration Path

1. **Land R1 + R2 in `packages/runtime` as a single PR.** Both are type-level changes and one new public export. No consumer-facing API change, no `apps/ui` / `packages/cli` impact. Existing transports (`webWorkerHost`, `nodeWorkerHost`, `inProcessTransport`) drop their fs placeholders / extractor inlining.

2. **Land R3 in a follow-up PR** that touches only `examples/electron-tau`. Updates the schemas, refactors `host()`, updates the bootstrap script. This PR makes `nx dev example-electron` work again.

3. **Land R4 (lint rule) in a third PR** to prevent regression of the `@taucad/runtime/testing` import pattern outside test files.

4. **Land R5 (policy doc update) alongside R4** so transport-author guidance reflects the supply-seam matrix.

5. **Land R6 (bridge primitive `Port<T>` relaxation) in a fifth PR.** Three signature relaxations + one re-export from `transport-internals` + ~54 mechanical call-site wraps (4 production-source + ~50 test sites). Single PR, single semantic change. Schedule when the next non-`MessagePort` transport is being authored or when the platform reaches a quiescent v6.x window — no consumer pressure today.

6. **No deprecation cycle needed.** No public consumer of `HostInitializeBindings.fileSystem` exists outside the runtime itself; no public consumer of the Electron host's `host({})` empty options shape exists outside the example; no public consumer of the bridge primitives exists outside the runtime's own `transport/` and `filesystem/` modules (they are `transport-internals`-tier APIs intended for transport authors, none of which exist as 3rd-party packages today).

### Test coverage to add

| Test                                                     | Lives in                                      | Asserts                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-bindings-no-filesystem.test-d.ts`                  | `packages/runtime/src/transport`              | `HostInitializeBindings` does not have a `fileSystem` field (compile error if regression)                                                                      |
| `extract-inline-filesystem.test.ts`                      | `packages/runtime/src/transport/_internal`    | Returns `undefined` for `undefined` input; returns base for inline fs; throws `TypeError` for channel fs                                                       |
| `extract-inline-filesystem.test-d.ts`                    | same                                          | `extractInlineFileSystem` is exported from `@taucad/runtime/transport-internals`                                                                               |
| `electron-utility-host-fs-required.test-d.ts`            | `examples/electron-tau`                       | `electronUtilityTransport.host({})` is a type error (missing `fileSystem`)                                                                                     |
| `electron-utility-no-test-imports.test.ts`               | `examples/electron-tau`                       | The transport file does not import `@taucad/runtime/testing` (lint-rule equivalent at file level)                                                              |
| `bridge-accepts-port-t.test-d.ts`                        | `packages/runtime/src/transport/_internal`    | `createBridgeServer(handlers, port: Port<T>)` accepts a non-`MessagePort` `Port<T>` adapter; rejects values missing `postMessage`/`onMessage`/`close`          |
| `bridge-port-t-runtime.test.ts`                          | same                                          | A custom `Port<T>` adapter (in-memory queue) exchanges full bridge protocol round-trips: `readFile` / `writeFile` / `watch` / `fileChanged` events / `dispose` |
| `transport-internals-wrapmessageport-reexport.test-d.ts` | `packages/runtime/src/transport-internals.ts` | `wrapMessagePort` is exported from `@taucad/runtime/transport-internals` (so transport authors don't depend on `@taucad/rpc` directly)                         |

## References

- [Runtime Transport Architecture (v6 blueprint)](./runtime-transport-architecture-v6.md) — the target architecture this work refines (esp. Finding 4 "Layered FS authority", §6 Primitive inventory, Appendix A's `RuntimeFileSystem` factory list, and §6 Layer 1 wire inventory which lists WebSocket as an anticipated author-extension wire).
- [Runtime Transport Authoring Simplification](./runtime-transport-authoring-simplification.md) — the prior sweep that introduced `definePassthroughTransport` and split web-/node-worker client/host modules; this work extends the same authoring-DX cleanup to the fs supply seam and the bridge primitive parameter type.
- [`docs/policy/library-api-policy.md`](../policy/library-api-policy.md) §22 Antipattern 5 — wire primitives must not appear on cross-layer public option types. Both the dead `bindings.fileSystem` slot and the `MessagePort`-typed bridge parameter are downstream consequences of mis-locating wire concerns.
- [`packages/runtime/src/transport-internals.ts`](../../packages/runtime/src/transport-internals.ts) — the subpath that gains `extractInlineFileSystem` (R2) and a re-exported `wrapMessagePort` (R6).
- [`packages/runtime/src/transport/_internal/runtime-filesystem-handle.ts`](../../packages/runtime/src/transport/_internal/runtime-filesystem-handle.ts) — current home of `resolveRuntimeFileSystem`; gains the public `extractInlineFileSystem` wrapper.
- [`packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts`](../../packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts) — bridge primitives whose public signatures are relaxed from `MessagePort` to `Port<T>` per R6.
- [`packages/rpc/src/port.ts`](../../packages/rpc/src/port.ts) — defines the wire-agnostic `Port<T>` abstraction and the `wrapMessagePort` adapter; basis for R6's relaxation.
- [`examples/electron-tau/src/transport/electron-utility-transport.ts`](../../examples/electron-tau/src/transport/electron-utility-transport.ts) — the file refactored per R3.

## Appendix — Transport file inventory (current)

| File                                                                    | Role                                              | FS option seam                                                    | Notes                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/transport/in-process-transport.ts`                | Bundled in-process                                | `client.fileSystem` (opaque, optional)                            | `host()` is passthrough-throw per R3 of authoring-simplification work                                                             |
| `packages/runtime/src/transport/web-worker-client.ts`                   | Bundled web-worker — client                       | `client.fileSystem` (opaque, optional)                            | bridges via `buildFileSystemBridge` → `memoryHandle.fileSystemPort`                                                               |
| `packages/runtime/src/transport/web-worker-host.ts`                     | Bundled web-worker — host                         | none accepted                                                     | adopts inbound `fileSystemPort`; `bindings.fileSystem` populated with placeholder (R1 deletes)                                    |
| `packages/runtime/src/transport/node-worker-client.ts`                  | Bundled node-worker — client                      | `client.fileSystem` (opaque, optional)                            | mirrors web-worker-client                                                                                                         |
| `packages/runtime/src/transport/node-worker-host.ts`                    | Bundled node-worker — host                        | none accepted                                                     | mirrors web-worker-host                                                                                                           |
| `packages/runtime/src/transport/web-worker-transport.ts`                | Composition file                                  | n/a                                                               | thin re-export per authoring-simplification R1                                                                                    |
| `packages/runtime/src/transport/node-worker-transport.ts`               | Composition file                                  | n/a                                                               | thin re-export per authoring-simplification R2                                                                                    |
| `packages/runtime/src/transport/_internal/runtime-filesystem-handle.ts` | FS opaque-handle resolver                         | n/a                                                               | gains public `extractInlineFileSystem` wrapper per R2                                                                             |
| `packages/runtime/src/transport/_internal/runtime-filesystem-bridge.ts` | Bridge protocol primitives                        | n/a                                                               | `MessagePort` parameter relaxed to `Port<T>` per R6; internal `wrapPort` helper deleted                                           |
| `packages/rpc/src/port.ts`                                              | `Port<T>` abstraction + `wrapMessagePort` adapter | n/a                                                               | source-of-truth for the wire-agnostic port shape; `wrapMessagePort` re-exported from `@taucad/runtime/transport-internals` per R6 |
| `packages/runtime/src/host/create-runtime-host.ts`                      | Runtime host surface                              | n/a (transport-only config)                                       | `RuntimeHostConfig` does not carry fs at top level                                                                                |
| `packages/runtime/src/client/runtime-client.ts`                         | Runtime client surface                            | n/a (transport-only config)                                       | `RuntimeClientOptions` does not carry fs at top level                                                                             |
| `packages/runtime/src/node.ts`                                          | Bundled CLI helper                                | `client.fileSystem` via `inProcessTransport`                      | Falls back to `fromMemoryFs()` when no `projectPath` supplied                                                                     |
| `examples/electron-tau/src/transport/electron-utility-transport.ts`     | Example                                           | none accepted today; R3 adds `host.fileSystem` (required, opaque) | The file at the heart of this investigation                                                                                       |
