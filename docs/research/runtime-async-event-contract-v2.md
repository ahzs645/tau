---
title: 'Runtime Async-Event Contract v2 (Adversarial Review)'
description: 'Adversarial follow-up to runtime-async-event-contract.md: validates assumptions, identifies missed architectural constraints, and extends transport topology recommendations for WebSocket/Electron IPC-ready runtime deployment.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: architecture
related:
  - docs/research/runtime-async-event-contract.md
  - docs/policy/library-api-policy.md
  - docs/research/runtime-event-driven-api-blueprint-v5.md
  - docs/research/runtime-blueprint-v5-implementation-audit.md
---

# Runtime Async-Event Contract v2 (Adversarial Review)

Adversarial extension of `docs/research/runtime-async-event-contract.md`, focused on falsifying assumptions, stress-testing recommendations against current source, and adding topology constraints needed for a truly transport-agnostic runtime.

## Executive Summary

The v1 investigation correctly identified the central async contract smell (`void` IIFEs plus microtask-drain tests) and the public `MessagePort` leak in `ConnectOptions`. The adversarial pass confirms those findings, but adds a deeper constraint: the runtime currently couples transport semantics at the **protocol layer** (`RuntimeCommand.initialize.fileSystemPort?: MessagePort`), not only at the public client API layer.

The v1 recommendation ("transport owns geometry materialisation") still stands, but only if paired with explicit ordering/correlation rules. Without those rules, moving async work to transport can introduce new reordering hazards and hidden head-of-line blocking.

This v2 doc adds: (1) assumption corrections, (2) missing architecture constraints, (3) an updated topology contract that separates wire channel, event materialisation, and filesystem backplane, and (4) scoped smell triage. Non-scope runtime smells are moved to a separate research artifact.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Adversarial Findings](#adversarial-findings)
- [Assumption Validation](#assumption-validation)
- [Updated Architecture Considerations](#updated-architecture-considerations)
- [Topology Implications for WebSocket and Electron IPC](#topology-implications-for-websocket-and-electron-ipc)
- [Recommendations v2](#recommendations-v2)
- [Scope Triage for Runtime Smells](#scope-triage-for-runtime-smells)
- [Migration Delta from v1](#migration-delta-from-v1)
- [References](#references)

## Problem Statement

The user requested a second pass from the same lens as v1, but adversarial:

1. Identify architectural considerations not uncovered in the first investigation.
2. Validate whether v1 makes incorrect assumptions.
3. Add future transport/topology considerations in-scope for "run anywhere" runtime deployment.
4. Identify other runtime smells and split them into "in-scope" vs "separate doc".

The success condition for this pass is not just "find more smells", but to determine whether v1's proposed contract remains valid under stricter topology and protocol scrutiny.

## Methodology

1. Re-read v1 (`runtime-async-event-contract.md`) and extract falsifiable claims.
2. Re-audit `packages/runtime/src/client/runtime-client.ts` async pathways (`connect`, `onGeometryComputed`, `export`, `terminate`).
3. Re-audit protocol and worker bridge layers:
   - `packages/runtime/src/types/runtime-protocol.types.ts`
   - `packages/runtime/src/framework/runtime-worker-client.ts`
   - `packages/runtime/src/framework/runtime-worker-dispatcher.ts`
   - `packages/runtime/src/framework/kernel-runtime-worker.ts`
4. Re-audit transport implementations and conformance tests:
   - `packages/runtime/src/transport/{runtime-transport,worker-transport,in-process-transport,websocket-transport}.ts`
   - `packages/runtime/src/transport/transport-conformance.test.ts`
5. Broad smell inventory across `packages/runtime/src` and split scope.

## Adversarial Findings

### Finding 1: `MessagePort` coupling exists in the protocol, not only in `ConnectOptions`

v1 correctly flagged public API leakage:

```typescript
export type ConnectOptions =
  | { fileSystem: RuntimeFileSystemBase; filePoolBuffer?: SharedArrayBuffer }
  | { port: MessagePort; filePoolBuffer?: SharedArrayBuffer };
```

But the deeper coupling is here:

```typescript
// packages/runtime/src/types/runtime-protocol.types.ts
type RuntimeCommand = {
  type: 'initialize';
  // ...
  fileSystemPort?: MessagePort;
  memoryHandle?: InitializeMemoryHandle;
};
```

And in the worker-client API:

```typescript
// packages/runtime/src/framework/runtime-worker-client.ts
public async initialize(input: {
  // ...
  fileSystemPort: MessagePort;
  memoryHandle?: InitializeMemoryHandle;
})
```

Implication: removing `MessagePort` from `RuntimeClient.connect()` alone does not make topology transport-agnostic. The protocol contract itself must be abstracted.

### Finding 2: Request correlation is slot-based and single-flight, not requestId-based

`RuntimeWorkerClient` tracks:

- `pendingInit` (single slot)
- `pendingRender` (single slot)
- `pendingExport` (single slot)

`handleMessage()` settles slots by message type and does not match by `requestId`.

Autonomous events emitted by dispatcher are sent with blank request ids:

```typescript
respond({ type: 'geometryComputed', requestId: '', result: transport });
respond({ type: 'parametersResolved', requestId: '', result });
respond({ type: 'progress', requestId: '', phase });
```

Implication: v1's materialisation fix solves async-smell ergonomics, but correlation/concurrency remains an architectural boundary. Future remote transports must either preserve single-flight guarantees or upgrade to explicit correlation maps.

### Finding 3: Async materialisation migration needs explicit ordering semantics

v1 recommended moving geometry materialisation into transport. Correct direction, but adversarially incomplete without an ordering contract.

Current risk: when async work is detached from message receipt, event ordering can drift unless sequenced.

Today this already happens in client-side IIFE form:

```typescript
onGeometryComputed(transportResult) {
  void (async () => {
    const resolved = await resolveTransportResult(transportResult);
    resolvePendingRender(resolved);
    emitGeometry(resolved);
  })();
}
```

If migrated into transport, the same reordering risk exists unless transport event emission is serialized per channel.

Required invariant to add:

- For a single transport channel, domain events must preserve worker emit order for equal-priority streams (`stateChanged`, `progress`, `parametersResolved`, `geometryComputed`), even when some require async materialisation.

### Finding 4: Worker dispatcher concurrency is under-specified

`createWorkerDispatcher` registers an async message handler:

```typescript
const dispatchCommand = async (command) => { ... };
port.onMessage(dispatchCommand);
```

Whether this behaves as strict run-to-completion queueing or interleavable async work depends on adapter/runtime message semantics. The current code does not enforce queueing explicitly.

Implication: this is a topology concern for remote transports too. A transport-neutral architecture should specify dispatcher queue semantics explicitly rather than relying on host event-loop behavior.

### Finding 5: WebSocket transport is structurally conformant but behaviorally stubbed

`createWebSocketTransport` intentionally throws for `send()` / `signalAbort()` and is included for shape conformance.

That is valid for incremental development, but it means v1's future-facing topology claims must be interpreted as design intent, not implemented readiness.

## Assumption Validation

### Corrections / caveats to v1

| v1 claim                                                             | Adversarial verdict                        | Evidence                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Promise.withResolvers` target references Node 22+/Node 20 fallback  | Partially incorrect for this repo baseline | Workspace engine is `node >=24.0.0` in root `package.json`; the recommendation is still valid, but stated runtime target was stale. |
| `flushMicrotasks` helper invoked 23 times in `kernel-worker.test.ts` | Count drifted                              | Current grep shows lower count than written in v1. The smell still stands; exact count was unstable.                                |
| Main blocker is `ConnectOptions.port: MessagePort`                   | Incomplete                                 | Protocol-level `RuntimeCommand.initialize.fileSystemPort?: MessagePort` is the deeper blocker.                                      |
| "Transport owns materialisation" is sufficient                       | Incomplete                                 | Must add ordering and correlation rules; otherwise migration can reintroduce race/reordering bugs.                                  |

### Assumptions that still hold

| Claim                                                                       | Verdict | Evidence                                                                                 |
| --------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `void (async () => ...)()` smell in runtime client is real and load-bearing | Valid   | Present in `runtime-client.ts` (`onGeometryComputed`, `connect`).                        |
| Microtask-drain tests are contract smell signal                             | Valid   | `flushMicrotasks` helper + repeated use in runtime tests remains.                        |
| Public `MessagePort` in runtime client is transport-coupling smell          | Valid   | Present in `ConnectOptions` union.                                                       |
| SAB encapsulation direction is correct                                      | Valid   | `configureMemory` and `InitializeMemoryHandle` are already transport-owned abstractions. |

## Updated Architecture Considerations

### 1) Three-layer transport topology (not two)

v1 proposed wire/event split. v2 extends to three layers:

1. **RuntimeChannel** — bidirectional command/response bytes + attachment envelope.
2. **RuntimeEventMaterializer** — deterministic transform from wire responses to domain events, including async geometry resolution.
3. **RuntimeBackplanes** — pluggable side channels (`filesystem`, `filePool`, `abortSignal`) negotiated per transport.

This extra layer prevents overloading "transport" with too many responsibilities and makes ordering and flow control testable in isolation.

### 2) Ordering policy must be codified

Define two event classes:

- **Ordered-control events**: `stateChanged`, `progress`, `parametersResolved`, `geometryComputed`, `error`.
- **Best-effort observability events**: `logBatch`, `telemetry`.

Recommended policy:

- Ordered-control events use a serialized processing queue per channel.
- Observability events may be batched/debounced but cannot overtake terminal control events (`geometryComputed`, `error`) for the same render generation.

### 3) Correlation model needs explicit contract

Current mixed model (single-slot + requestId fields + blank requestIds for autonomous path) is workable only under strict single-flight assumptions.

For future topology (remote transports, retries, multiplexing), add:

- `commandId` for all command-response paths.
- `renderGeneration` on autonomous streams (`progress`, `parametersResolved`, `geometryComputed`, `error`).
- Optional `streamId` if multiple geometry units share a single channel.

### 4) Backplane abstraction must replace hardcoded `fileSystemPort`

Introduce:

```typescript
type RuntimeBackplaneDescriptor =
  | { kind: 'filesystem'; binding: 'message-port' | 'rpc' | 'ipc'; handle: unknown }
  | { kind: 'file-pool'; binding: 'sab' | 'inline-chunks'; handle: unknown }
  | { kind: 'abort-signal'; binding: 'sab' | 'wire-command'; handle: unknown };
```

Worker initialise command receives a list of backplanes, not a fixed `fileSystemPort` field.

### 5) Attachment envelope should be transport-neutral

Current `send(message, transferables?: Transferable[])` is worker-centric.

Remote channels need non-transferable attachment modes (binary frames, chunk ids). Add an envelope with optional transferables for local transports and alternate binary payloads for remote channels.

## Topology Implications for WebSocket and Electron IPC

### WebSocket

Additional requirements not covered in v1:

- Filesystem backplane must be RPC/multiplexed, not `MessagePort` transfer.
- Binary transport needs chunking policy for large geometry payloads.
- Abort path should stay parity-safe with SAB semantics (`abortGeneration` monotonicity).
- Reconnect/retry semantics must define whether in-flight render outcomes are superseded or retried.

### Electron IPC

Additional requirements:

- Process-boundary channel abstraction (`ipcRenderer` / `MessagePortMain`) should satisfy `RuntimeChannel` without leaking Electron types to runtime public API.
- Security topology (main vs renderer) must define who owns filesystem backplane and whether renderer has direct FS authority or proxied authority.
- Structured clone differences and transfer support should be part of conformance tests.

## Recommendations v2

| #   | Action                                                                                                                                          | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Keep v1 materialisation shift, but add serialized event materializer queue and formal ordering invariants.                                      | P0       | Medium | High   |
| R2  | Refactor protocol to remove fixed `initialize.fileSystemPort`; replace with negotiated backplanes list.                                         | P0       | Medium | High   |
| R3  | Introduce explicit correlation fields (`commandId`, `renderGeneration`, optional `streamId`) and test out-of-order delivery behavior.           | P0       | Medium | High   |
| R4  | Replace raw `Transferable[]` send signature with transport-neutral attachment envelope.                                                         | P1       | Medium | Medium |
| R5  | Convert `connect()` / `export()` deferred wiring to `Promise.withResolvers()` pattern (Node 24 baseline; no fallback needed in this workspace). | P1       | Low    | Medium |
| R6  | Add a dispatcher-level queue contract test that proves deterministic command processing under async handler work.                               | P1       | Low    | Medium |
| R7  | Expand transport conformance suite from structural to behavioral: ordering, correlation, abort parity, and backplane negotiation.               | P1       | Medium | High   |
| R8  | Keep `createWebSocketTransport` stub but annotate as "shape-only"; gate feature documentation on behavioral conformance completion.             | P2       | Low    | Medium |

## Scope Triage for Runtime Smells

### In-scope for async event contract work

1. `void` IIFE/thenable patterns in runtime client async boundaries.
2. Microtask-drain test choreography caused by hidden async contract.
3. `MessagePort` coupling in public client API and internal protocol initialize command.
4. Mixed/implicit correlation semantics (single-slot + blank request ids).
5. Missing ordering/queue contract for async event materialisation.

### Out-of-scope (moved to separate research doc)

Additional runtime smells that are important but not owned by this transport-contract scope are documented in:

- `docs/research/runtime-smells-outside-async-transport-scope.md`

## Migration Delta from v1

v1 migration sketch remains directionally correct. Apply these deltas:

1. Before moving materialisation, define ordering/correlation invariants and write failing conformance tests.
2. Replace protocol fixed fields (`fileSystemPort`) with backplane negotiation contract before claiming transport neutrality.
3. Distinguish "shape-conformant" from "behavior-conformant" transports in test matrix and docs.
4. Update v1's environment assumptions to repository baseline (`node >=24`).

## References

- Related baseline: `docs/research/runtime-async-event-contract.md`
- Policy: `docs/policy/library-api-policy.md`
- Protocol types: `packages/runtime/src/types/runtime-protocol.types.ts`
- Client orchestration: `packages/runtime/src/client/runtime-client.ts`
- Worker client/dispatcher: `packages/runtime/src/framework/runtime-worker-client.ts`, `packages/runtime/src/framework/runtime-worker-dispatcher.ts`
- Transport implementations: `packages/runtime/src/transport/*.ts`
