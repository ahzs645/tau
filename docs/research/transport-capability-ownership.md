---
title: 'Transport Capability Ownership — Who Owns Capability and Backplane Negotiation?'
description: 'Eigenquestion analysis of who owns capability/backplane negotiation across the runtime/channel/transport layers — the runtime reads domain backplanes, the channel reads wire capabilities, the transport adapter is the only entity that knows the wire.'
status: superseded
created: '2026-04-28'
updated: '2026-04-28'
superseded_by: docs/research/runtime-transport-architecture-v6.md
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/research/electron-rpc-transport-architecture.md
  - docs/research/runtime-channel-blueprint-v5.md
  - docs/research/runtime-async-event-contract.md
  - docs/policy/library-api-policy.md
  - docs/policy/vision-policy.md
---

# Transport Capability Ownership — Who Owns Capability and Backplane Negotiation?

> **Status: SUPERSEDED.** This document has been superseded by [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md). Adversarial review of the two-layer capability model proposed below revealed two material drifts against the actual code: (1) the document claimed `@taucad/rpc.Channel` owns delivery tiering, but tiering actually lives in `runtime-worker-dispatcher.ts`; (2) the document proposed retaining `Port.capabilities` as a public type with internal-only readers, but the v6 cutover deletes `Port.capabilities` entirely and folds capability ownership into the `defineRuntimeTransport` primitive. The eigenquestion framing and §22 Antipattern 5 analysis below are correct and carried forward into v6's "Eigenquestions Resolved" section. Refer to v6 for the current source of truth.

A focused eigenquestion analysis: when a transport-agnostic runtime sits over heterogeneous wires (Web Worker, `worker_threads`, Electron `MessageChannelMain`, Electron `utilityProcess` `MessagePort`, WebSocket, future FFI), at what layer does each capability decision live, and which layer is responsible for negotiating it? Driven by a re-evaluation of the recommendations in [Electron RPC Transport Architecture](./electron-rpc-transport-architecture.md), which proposed that the runtime read wire-level capability bits (`messagePortTransfer`, `arrayBufferTransfer`, `sharedArrayBufferClone`) to make placement decisions.

## Executive Summary

**The user's intuition is correct.** Having the runtime read wire-level capability bits violates [§22 Antipattern 5](../policy/library-api-policy.md#22-async-surface-hygiene-antipatterns) of `library-api-policy.md` ("never type wire primitives in public option objects") by extension — a runtime that branches on `arrayBufferTransfer` or `sharedArrayBufferClone` to decide whether to allocate a `SharedArrayBuffer` is reasoning about the wire even though no `MessagePort` appears in its public type. The capability bit is a wire primitive in disguise.

**But capabilities themselves are not the problem.** The codebase already has the architecturally correct shape: a **two-layer capability model** with strict ownership boundaries.

| Layer                   | What it owns                                                                | What it reads                                                           | Where it lives                              |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| Wire                    | Bytes in/out + raw transfer/SAB facts                                       | `Port.capabilities` (wire facts: `transfer`/`sab`/`signalSlot`/`pool`)  | `@taucad/rpc` `Port` adapter                |
| Channel (RPC primitive) | Frame routing + delivery-tier selection (pool → transfer → copy)            | `Port.capabilities` for **internal** tier choice — never exposed upward | `@taucad/rpc` `Channel`                     |
| Runtime (domain)        | Filesystem / file-pool / abort / log-stream / telemetry concerns            | `BackplaneDeclaration[]` from the channel — domain-typed bindings only  | `@taucad/runtime/runner`                    |
| Consumer                | App-level glue: which kernels, which transport, which backplanes to request | `BackplaneRequest[]` it issues into `connect()`                         | App (`apps/ui`, `examples/electron-tau`, …) |

The architecturally correct rule: **capabilities live at the layer that owns the work that depends on them, and they are never read across layer boundaries**. The runtime never reads `Port.capabilities`. The channel never reads `BackplaneDeclaration`. The consumer never reads either — it requests by name.

**Where the previous Electron blueprint is wrong** ([R1 / R2 / R3 in `electron-rpc-transport-architecture.md`](./electron-rpc-transport-architecture.md#poc-required-p0--must-land-for-green-topology-c-e2e)): it promotes `Port.capabilities` to a runtime-visible contract that `RuntimeWorkerClient.initialize()` branches on. That collapses the two-layer model into one and forces the runtime to know wire facts. The correct rewrite keeps `Port.capabilities` strictly internal to `@taucad/rpc.Channel`, and has the runtime declare/request via `BackplaneDeclaration`/`BackplaneRequest` only — exactly the shape `packages/runtime/src/runner/backplanes.ts` already ships.

**Recommendation**: adopt the strict layering, demote `Port.capabilities` to channel-internal, promote `BackplaneDeclaration` to the only capability surface the runtime reads, and amend the Electron blueprint's R1–R3 to consume the existing backplane abstraction instead of re-inventing capability gating in the runtime layer. Concrete amendments in [§ Recommendations](#recommendations).

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [The Eigenquestion](#the-eigenquestion)
- [Prior Art Synthesis](#prior-art-synthesis)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Amendments to the Electron Blueprint](#amendments-to-the-electron-blueprint)
- [References](#references)

## Problem Statement

The accepted Electron blueprint ([`electron-rpc-transport-architecture.md`](./electron-rpc-transport-architecture.md)) recommends that the runtime layer (`packages/runtime/src/framework/runtime-worker-client.ts`) consult `port.capabilities.{messagePortTransfer,arrayBufferTransfer,sharedArrayBufferClone,signalSlot,pool}` to decide:

1. Whether to allocate a `SharedArrayBuffer` for the cooperative cancel signal slot.
2. Whether to push the FS port into the `transferables` list of the `initialize` envelope.
3. Which geometry-delivery tier (`pool` / `transfer` / `copy`) to register with the dispatcher.
4. Whether to throw `MissingCapabilityError` on consumer-explicit feature requests the wire cannot honour.

Two things are simultaneously true. First: the runtime obviously must avoid posting a `SharedArrayBuffer` over a wire that rejects it. Second: a runtime that branches on `arrayBufferTransfer` is reasoning about a wire-shape primitive — the same class of leak that [§22 Antipattern 5](../policy/library-api-policy.md#22-async-surface-hygiene-antipatterns) calls out for `MessagePort` in `ConnectOptions`. The blueprint trades one form of wire coupling (a `MessagePort` field) for another (a wire-fact capability bit field) and calls it transport-agnostic.

The user's question reframes this: **is having the runtime know about capabilities the right way for the runtime to remain agnostic?** Or should each transport own its capabilities, with the runtime omitting any responsibility for capability negotiation?

The answer is not "yes" or "no" — it is "at which layer?". This document identifies the layered architecture that resolves the apparent contradiction, validates it against prior art, and amends the Electron blueprint accordingly.

## Methodology

1. Read every export of `@taucad/rpc` (`packages/rpc/src/{port,channel,index}.ts`) plus the type-d conformance suite (`channel.test-d.ts`).
2. Read every existing capability-related abstraction in `@taucad/runtime` (`runner/backplanes.ts`, `runner/runner.types.ts`, `types/runtime.types.ts`, `types/runtime-capabilities.test-d.ts`, `types/transport-descriptor.types.ts`) and confirmed that the legacy two-layer transport (`RuntimeTransport`, `RuntimeEventSource`) was deleted in Phase 7 (`legacy-transport-deletion.test.ts`).
3. Re-read `library-api-policy.md` §22 ("Async Surface Hygiene") and `runtime-async-event-contract.md` for the existing Antipattern 5 framing of wire-primitive leakage.
4. Re-read `vision-policy.md` to ground the recommendation in the long-term goal of multi-discipline, code-first engineering across many transports and many environments.
5. Re-read the relevant findings and recommendations of `electron-rpc-transport-architecture.md` (Findings 1–3, 10; R1–R3) and identified the precise lines where the proposed runtime-side capability gating violates the layered model the rest of the codebase already implements.
6. Web survey of seven prior-art systems for layered capability declaration: JDBC `DatabaseMetaData`, WebGPU `requestAdapter` / `requestDevice`, Rust `embedded-hal` traits, libhal interfaces, the A2A protocol's three-layer model (data / operations / bindings), the PACT protocol's L1–L5 layered architecture, and the WebSocket subprotocol negotiation pattern.
7. Mapped each prior-art system onto the four-layer Tau model (consumer / runtime / channel / wire) and confirmed that **every** mature system in the survey treats capability ownership the same way: capabilities live at the layer that owns the work, and consumers/applications request by name, never read wire facts.

## Findings

### Finding 1: The two-layer capability model already exists in the codebase, but is not consistently applied

The codebase already ships two co-existing capability abstractions, each correctly scoped to its layer:

**Wire-layer** — `packages/rpc/src/port.ts`:

```typescript
export type PortCapabilities = {
  readonly sab?: boolean; // wire delivers SAB references
  readonly signalSlot?: boolean; // wire exposes an Atomics-pollable abort slot
  readonly transfer?: boolean; // wire honours postMessage transfer list
  readonly pool?: boolean; // both sides share a SAB-backed delivery pool
};
```

These are wire facts. They describe **what the underlying primitive can carry**. The JSDoc on `PortCapabilities` is explicit about the consumer:

> "The dispatcher walks the ladder `pool → transfer → copy` for binary delivery (geometry, export bytes) and `signalSlot + wire → wire-only` for cooperative abort, gating each faster path on the capability bit. Adapters never lie."

The "dispatcher" here is `@taucad/rpc.Channel` itself — not the runtime. The capability bits exist so the channel can pick the fast-path tier without branching on transport-class strings. They are an **internal** input to the channel's tier-selection logic.

**Runtime-layer** — `packages/runtime/src/runner/backplanes.ts`:

```typescript
export type BackplaneDeclaration =
  | { kind: 'filesystem'; bindings: ReadonlyArray<'message-port' | 'rpc' | 'shared-memory'> }
  | { kind: 'file-pool'; bindings: ReadonlyArray<'sab' | 'inline-chunks'> }
  | { kind: 'abort'; bindings: ReadonlyArray<'sab' | 'wire-command'>; latency: 'sub-microsecond' | 'queue-bound' }
  | { kind: 'log-stream'; bindings: ReadonlyArray<'inline' | 'sub-channel'> }
  | { kind: 'telemetry'; bindings: ReadonlyArray<'inline' | 'sub-channel' | 'opentelemetry'> };

export type BackplaneRequest<K extends BackplaneKind = BackplaneKind> = {
  readonly kind: K;
  readonly binding: BackplaneBindingName<K>;
};
```

These are **runtime concerns**, not wire facts. `kind: 'filesystem'` is a domain word; `bindings: ['message-port', 'rpc', 'shared-memory']` are the **mechanisms by which this transport can serve filesystem operations**, declared in domain terms. The consumer issues `backplaneRequest('filesystem', 'message-port')` — the runtime matches the request against the channel's declarations and either binds the requested binding or rejects connect with `BackplaneUnavailableError`.

The JSDoc again is explicit about scope:

> "Backplanes are not negotiated dynamically. They are static channel properties exposed at `client.capabilities.transport.backplanes` so consumers can diff `declared` against `bound` for diagnostics overlays and conformance assertions."

These two abstractions co-exist because they answer different questions:

| Question                                                                 | Abstraction                                                    | Owner                                                                                        | Consumer of the bits                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| "Can this wire carry a `SharedArrayBuffer` at all?"                      | `Port.capabilities.sab`                                        | `@taucad/rpc` `Port` adapter                                                                 | `@taucad/rpc.Channel` (internal tier choice)   |
| "Can this transport serve the filesystem backplane via a `MessagePort`?" | `BackplaneDeclaration { kind: 'filesystem', bindings: [...] }` | `@taucad/rpc` `Port` adapter (declares); `@taucad/runtime` runtime client (matches requests) | `RuntimeClient.connect({ backplanes: [...] })` |

When applied consistently, the runtime never reads `Port.capabilities` directly. The runtime asks "do you have the filesystem backplane bound to message-port?" and the channel internally consults `Port.capabilities.transfer` to know whether the `MessagePort` will survive `postMessage`'s second arg. The wire fact never escapes the channel.

### Finding 2: The previous Electron blueprint collapses the two-layer model

The accepted blueprint's [R1](./electron-rpc-transport-architecture.md#poc-required-p0--must-land-for-green-topology-c-e2e) renames the four wire-fact bits and adds `messagePortTransfer`. Its R2 prescribes that `RuntimeWorkerClient.initialize()` reads those bits to decide whether to allocate SAB and whether to push the FS port into transferables. Its R3 makes both sides advertise `lh.d.capabilities` (typed as `PortCapabilities`) at handshake.

Concretely from R2's pseudocode:

```typescript
// inside packages/runtime/src/framework/runtime-worker-client.ts
const caps = this.channel.port.capabilities;          // ← runtime reads wire facts
if (caps.messagePortTransfer === true) {              // ← runtime branches on wire facts
  memoryHandle.fileSystemPort = this.fileSystemPort;
  transferables.push(this.fileSystemPort);
} else if (this.options.fileSystem.requested === 'port') {
  throw new MissingCapabilityError('messagePortTransfer', …);
}
```

This shape is wrong for three reasons that compound:

**Reason A — it leaks wire knowledge into the runtime.** `messagePortTransfer` is a fact about a specific wire kind. The runtime now knows that `MessagePort`s are a thing and can be transferred. A future WebSocket transport (no `MessagePort`s at all) cannot honestly answer the question — it would have to either lie (`messagePortTransfer: true`, which is meaningless when there's no port to transfer) or false (`messagePortTransfer: false`, which the runtime then interprets as "no FS"). The bit set is wire-shape.

**Reason B — every new transport extends the runtime's switch.** When a future FFI transport is added, the runtime needs new bits (`ffiSharedMemoryRegion`?). When a future WebRTC transport is added, more bits (`dataChannelOrdered`?). The runtime's `initialize()` keeps growing a switch over wire-class facts. Any new wire mechanism not anticipated by the bit vocabulary either (a) requires extending the runtime, or (b) silently degrades.

**Reason C — `library-api-policy.md` §22 Antipattern 5 already rejects the underlying class.** The policy section is explicit: _"Never type wire primitives (`MessagePort`, `Worker`, `WebSocket`) into a public option object."_ A capability bit named after a wire fact (`messagePortTransfer`, `sharedArrayBufferClone`) is a wire primitive in disguise — it has the same blast radius (couples the runtime to the wire kind, blocks new transports, requires consumer-side awareness of wire mechanism). The policy's reasoning translates cleanly: the runtime should accept a typed handle (`BackplaneRequest`) and let the channel/transport bind the wire primitive internally.

### Finding 3: The runtime already does the right thing for `BackplaneDeclaration`; the same shape must own all transport-driven decisions

`backplanes.ts` already implements the correct pattern — `findBackplaneDeclaration(declarations, request)` matches by **domain kind + binding name**, not by wire fact. When the match fails, the runtime throws `BackplaneUnavailableError` (per `BackplaneRequest` JSDoc) — the typed equivalent of the blueprint's proposed `MissingCapabilityError`, but at the right abstraction layer.

The blueprint's `MissingCapabilityError(messagePortTransfer, …)` is a special case of `BackplaneUnavailableError({ kind: 'filesystem', binding: 'message-port' })`. The latter is honest about what the runtime is actually checking ("can you serve the filesystem backplane via a message-port binding?") and degrades gracefully ("no? then I'll request the rpc binding instead").

The runtime never needs to know whether the wire can transfer an `ArrayBuffer`. It needs to know whether the channel can serve `file-pool` via the `sab` binding (which transitively requires `arrayBufferTransfer + sharedArrayBufferClone`, but that's the channel's problem, not the runtime's).

### Finding 4: `Port.capabilities` is correctly scoped already — it just needs to be promoted to channel-internal and demoted from public-API exposure

`Port.capabilities` is read in three places in the codebase today (excluding tests):

1. `@taucad/rpc.Channel` internal logic for binary-delivery tier choice — **correct**, this is the layer that owns the work.
2. `@taucad/rpc` lifecycle/notify/transferables tests that mirror `port.capabilities` — **harmless** (test infrastructure).
3. `@taucad/runtime` does NOT currently read it (the field is unused at the runtime layer outside the proposed blueprint changes).

The current state is already correct! The blueprint's R1–R3 would _introduce_ a violation that doesn't exist today. The fix is to leave `Port.capabilities` exactly where it is — strictly internal to `@taucad/rpc.Channel` — and add the missing piece: have the channel project its internal `Port.capabilities` reads into the `BackplaneDeclaration[]` it advertises at handshake, so the runtime can consume the result in domain terms.

### Finding 5: Vision-policy demands the strict layering

[`vision-policy.md`](../policy/vision-policy.md) commits Tau to the long-term goal of running across "the five pillars of hardware engineering — systems, analysis, CAD, software/firmware, simulation — through code and AI agents." Phase 6 (Automated Robotic Systems) explicitly requires:

> "Robots in the field are parameterized variants of the same codebase. Update a requirement, re-run the pipeline, push firmware OTA, and queue revised parts for manufacturing. Fleet-wide changes propagate from code, not spreadsheets."

This implies a runtime that runs identically across:

- Browser (Web Worker)
- Electron desktop (`utilityProcess` `MessagePort`)
- Server / cloud (WebSocket, gRPC stream)
- Edge device / embedded (FFI, custom IPC)
- Field robot telemetry pipeline (multiplexed network channel)
- AI agent orchestration (in-process, federated agents)

Every one of these wires has different capability bits. If the runtime grows a switch on wire facts, the runtime must be re-released for every new transport. If the runtime instead reads only domain backplanes, the same runtime binary serves every transport — the transport author writes a `Port` adapter that declares which backplanes/bindings they can offer, and they are done. This is the only design that scales to Phase 6.

The library-api-policy's principle "everything is pluggable" (§22 Antipattern 5 plus the broader plugin-factory pattern) is exactly this property at the API level.

### Finding 6: The eigenquestion's answer composes cleanly with the existing v5 channel blueprint

The [v5 channel blueprint](./runtime-channel-blueprint-v5.md) Finding 7 already captures the channel-internal nature of `PortCapabilities` ("Capability-tiered `Port<T>` adapters … the `Channel` layer reads the capability set off the `Port` and routes each delivery decision through three explicit tiers: pool → transfer → copy"). The channel-internal scope was the v5 design intent.

The Electron blueprint's R1–R3 inadvertently undid that scoping by promoting `Port.capabilities` from a channel-internal optimisation knob to a runtime-visible negotiation contract. The correct amendment is to restore the v5 scoping: `Port.capabilities` stays channel-internal (the only public consumer is the channel's tier picker), and the runtime consumes `BackplaneDeclaration` exclusively.

### Finding 7: Prior art is unanimous — capabilities live at the layer that owns the work

The web survey of seven prior-art systems (JDBC, WebGPU, embedded-hal, libhal, A2A, PACT, WebSocket subprotocols) found a single consistent pattern: capabilities are declared at one layer and consumed by code in that same layer or one layer above; they are never read across multiple-layer gaps. Detailed mapping in [§ Prior Art Synthesis](#prior-art-synthesis); summary:

| System                | Wire-layer capabilities                                 | App-layer capabilities                              | App reads wire?                                                                   |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| JDBC                  | Driver implementation features (`supportsBatchUpdates`) | Domain queries via `Connection`/`Statement`         | No — the framework (ORM) reads driver caps; the app reads only the framework      |
| WebGPU                | `adapter.features` / `adapter.limits`                   | `device.requestDevice({ requiredFeatures })`        | App requests by name; adapter rejects if unmet — same shape as `BackplaneRequest` |
| `embedded-hal` (Rust) | Trait implementations (`OutputPin`, `SteadyClock`)      | Generic over the trait, not the impl                | No — the trait IS the capability; the app uses generics                           |
| libhal (C++)          | Interface implementations                               | Polymorphic dispatch                                | Same                                                                              |
| A2A                   | Protocol bindings (Layer 3: JSON-RPC / gRPC / HTTP)     | Operations (Layer 2: Send Message / Stream Message) | App talks Layer 2; Layer 3 is invisible to it                                     |
| PACT                  | Transport adapters (gRPC, HTTP/2, UDS)                  | Identity + Discovery + Negotiation layers           | Explicit non-goal: "the protocol MUST NOT assume a specific transport"            |
| WebSocket             | Subprotocol negotiation at handshake                    | Message frames                                      | App speaks the subprotocol; the WS layer hides framing                            |

Tau's correct model maps onto every one of these: `Port.capabilities` is the wire fact (analog of WebGPU `adapter.features`); `BackplaneDeclaration` is the domain capability (analog of WebGPU `device.requestDevice`'s `requiredFeatures` request); the runtime/consumer talks domain.

## The Eigenquestion

> **At what layer does each capability decision live, and does that layer ever need to read a layer below it?**

Restated as the test for any proposed capability surface:

- A capability the **runtime** branches on must be expressible in the runtime's own vocabulary (filesystem / file-pool / abort / log-stream / telemetry — domain words). If the proposed bit is named after a wire mechanism (`messagePortTransfer`, `sharedArrayBufferClone`), the runtime is reaching across a layer it should not cross.
- A capability the **channel** branches on must describe wire facts (transfer / SAB / signal slot / pool). If the proposed bit is named after a domain concern (`filesystemPort`, `geometryPool`), the channel is reaching across a layer it should not cross.
- A capability the **transport adapter** declares is the only place where the two vocabularies meet — the adapter author knows their wire (`MessagePortMain`, `WebSocket`, …) and translates "what the wire can carry" into both `Port.capabilities` (for the channel) and `BackplaneDeclaration[]` (for the runtime).

Three downstream questions collapse into this single test:

1. _"Should the runtime know that Electron exists?"_ → No. The runtime reads `BackplaneDeclaration[]`. Whether the underlying wire is Electron, Web Worker, or WebSocket is invisible.
2. _"Should the channel know that filesystem RPC exists?"_ → No. The channel reads `Port.capabilities` to pick `pool → transfer → copy`. It has no concept of "filesystem"; that's a backplane the runtime declares against the channel's primitives.
3. _"Should the consumer pass a `MessagePort` into `connect()`?"_ → No (already settled by [Antipattern 5](../policy/library-api-policy.md#22-async-surface-hygiene-antipatterns)). The consumer passes a typed handle; the transport binds the wire.

The same test rules out every shape that violates the layering, automatically.

## Prior Art Synthesis

Each of the seven systems below answers the eigenquestion the same way — capability ownership is layered, consumers request by domain name, transports declare their primitives, the framework wires them together.

### JDBC `DatabaseMetaData` (1996, still canonical)

**Layered model:** Driver → JDBC API → Application.

The driver implements `DatabaseMetaData` and exposes wire/DBMS facts (`supportsBatchUpdates()`, `supportsCorrelatedSubqueries()`, `getTypeInfo()`). The application **never** calls these directly — it talks SQL through `Connection` and `Statement`. The framework layer (ORMs like Hibernate, query builders like JOOQ) reads `DatabaseMetaData` to decide whether to emit a batch insert or fall back to a loop, but that decision is invisible to the application.

> "A user for this interface is **commonly a tool** that needs to discover how to deal with the underlying DBMS." — JDBC docs (every Java SE version 8 through 26)

Key insight: the API surface explicitly identifies its consumer as the **framework**, not the application. This is the exact pattern Tau needs: `Port.capabilities` is for the channel ("a tool"), not the runtime ("an application").

### WebGPU `requestAdapter` / `requestDevice` (2023, the modern web equivalent)

**Layered model:** GPU driver → WebGPU adapter → WebGPU device → Application.

`navigator.gpu.requestAdapter()` returns a `GPUAdapter` whose `features` and `limits` enumerate what the underlying GPU can do (wire-layer facts). The application then calls `adapter.requestDevice({ requiredFeatures: [...], requiredLimits: {...} })` to **request** specific capabilities by name. If any required feature/limit cannot be honoured, `requestDevice` rejects.

> "Applications should typically make a single requestAdapter call with the lowest feature level they support, then inspect the adapter for additional capabilities they can use optionally, and request those in requestDevice." — WebGPU spec

This is precisely the `BackplaneDeclaration` + `BackplaneRequest` pattern Tau already ships. The adapter declares; the application requests by name; the request is granted or rejected. The application never branches on raw GPU driver facts.

### Rust `embedded-hal` (2018, ecosystem-defining)

**Layered model:** Chip-specific HAL crate → `embedded-hal` traits → Driver crate → Application.

The chip-specific HAL implements `embedded-hal` traits (`OutputPin`, `SteadyClock`, `I2c`, …). Driver crates are generic over the trait, not the implementation:

```rust
fn blink<P: OutputPin, C: SteadyClock>(pin: &mut P, clock: &C) { ... }
```

The application instantiates the chip-specific HAL once, passes it through generics, and the rest of the code is wire-agnostic. Capability declaration **is** trait implementation; capability querying **is** generic constraint. There is no separate capability bit to read.

For Tau, the analog is: `BackplaneDeclaration` is what a transport implements; the runtime is generic over which backplane bindings it can use.

### libhal (C++)

Same model as `embedded-hal`, with runtime polymorphism instead of monomorphisation. Drivers implement interfaces; applications hold pointers to interface types; the underlying device class is invisible.

### A2A Protocol (Google, 2024–2026)

**Layered model:** Data Model (L1) → Operations (L2) → Protocol Bindings (L3).

L1 defines `Task`, `Message`, `AgentCard` — pure data. L2 defines abstract operations like `SendMessage`, `StreamMessage`. L3 maps operations onto JSON-RPC / gRPC / HTTP endpoints. Per the spec:

> "Layer 2: Abstract Operations describes the fundamental capabilities and behaviors that A2A agents must support, **independent of how they are exposed over specific protocols**."

> "Core semantics remain consistent across all protocol bindings. New protocol bindings can be added without changing the fundamental data model."

Capability negotiation lives in `AgentCard` (L1 data) — agents declare which L2 operations they support. Clients request by L2 operation name. L3 binding choice is a per-call concern that the operation layer hides.

### PACT Protocol (2026)

**Layered model:** L1 Identity → L2 Discovery → L3 Negotiation → L4 Execution → L5 Settlement.

> "Transport independence. The protocol MUST NOT assume a specific transport. PACT messages MUST be expressible over gRPC, HTTP/2 with Server-Sent Events, and Unix domain sockets."

Same philosophy as A2A. Capability declaration lives in L2 (Discovery — what each agent says it can do). L3 (Negotiation) speaks in capability terms. L1 (transport identity / wire) is below the negotiation layer and never read by it.

### WebSocket Subprotocol Negotiation (RFC 6455, 2011)

**Layered model:** TCP → WebSocket frame → Subprotocol → Application.

The client offers a list of subprotocols in the `Sec-WebSocket-Protocol` header; the server picks one. After handshake, the application speaks the chosen subprotocol; framing details are invisible. Capability negotiation is one-shot at handshake; the application never re-reads the choice.

### Synthesis: the universal pattern

| Pattern                                         | Wire-fact surface                      | Domain-capability surface                   | App reads wire?                                               |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| JDBC                                            | `DatabaseMetaData`                     | `Connection.prepareStatement(sql)`          | No                                                            |
| WebGPU                                          | `adapter.features/limits`              | `requestDevice({ requiredFeatures })`       | No                                                            |
| `embedded-hal`                                  | trait implementation                   | trait constraint on generic                 | No                                                            |
| A2A                                             | L3 protocol bindings                   | L2 operations                               | No                                                            |
| PACT                                            | L1 transport                           | L3 negotiation                              | No                                                            |
| WebSocket                                       | TCP frame mechanics                    | chosen subprotocol                          | No                                                            |
| **Tau (correct)**                               | `Port.capabilities` (channel-internal) | `BackplaneRequest` ↔ `BackplaneDeclaration` | No                                                            |
| **Tau (current Electron blueprint, incorrect)** | `Port.capabilities` exposed to runtime | —                                           | **Yes** (R2 reads bits in `RuntimeWorkerClient.initialize()`) |

The universal answer is: **the application/runtime never reads wire facts**. Tau's existing `BackplaneDeclaration` infrastructure already enacts this universally across prior art; the Electron blueprint's R1–R3 broke ranks.

## Recommendations

The recommendations split into two groups: **structural** changes that re-establish the layered capability model in the codebase, and **amendments** to the existing Electron blueprint that consume the corrected model. Items marked P0 must land before any further work on the Electron PoC; items marked P1 raise it to production quality.

### Structural

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | **Demote `Port.capabilities` to channel-internal documentation status.** Keep the type and the field exactly as they are in `packages/rpc/src/port.ts`; update the JSDoc on `PortCapabilities` to state explicitly: _"Read by `@taucad/rpc.Channel` only. Runtime consumers MUST NOT branch on these bits — read `BackplaneDeclaration[]` from the channel handshake instead."_ Promotion to a normative-handshake contract is reverted.                                                                     | P0       | S      | High   |
| R2  | **Promote `BackplaneDeclaration` / `BackplaneRequest` to the only capability surface the runtime reads.** `RuntimeWorkerClient.initialize()` consumes `channel.backplanes.declared` (existing field), matches it against the consumer-passed `BackplaneRequest[]`, throws `BackplaneUnavailableError` for unmatched requests. No reads of `port.capabilities` survive in `packages/runtime/src/`.                                                                                                            | P0       | M      | High   |
| R3  | **Channel-internal projection**: `@taucad/rpc.Channel` exposes a `backplanes: BackplaneDeclaration[]` field that the channel computes from its `Port.capabilities` plus its known protocol features. The projection is one-way: `Port.capabilities` flows into `BackplaneDeclaration[]`; nothing flows back. The projection rules are documented next to the channel implementation as a normative table (e.g., `port.capabilities.transfer === true` ⇒ `filesystem` declares the `'message-port'` binding). | P0       | M      | High   |
| R4  | **Mandatory handshake declaration of `BackplaneDeclaration[]`.** `lh.d` adopts `{ peer?: string; backplanes: BackplaneDeclaration[] }` (replacing the proposed `capabilities: PortCapabilities` shape from the Electron blueprint). Both sides AND-merge by intersection per `(kind, binding)` tuple. If either side omits `lh.d.backplanes`, reject with `IncompatibleHandshakeError`.                                                                                                                      | P0       | M      | High   |
| R5  | **`BackplaneUnavailableError` replaces `MissingCapabilityError`.** The runtime never throws an error named after a wire fact. The error name carries the domain `(kind, binding)` tuple of the unmet request, e.g. `BackplaneUnavailableError({ kind: 'file-pool', binding: 'sab' })`.                                                                                                                                                                                                                       | P0       | S      | High   |
| R6  | **Encode the layering rule in `library-api-policy.md`.** Extend §22 with a sixth antipattern: _"Wire-fact capability bits in cross-layer types. A capability bit named after a wire mechanism (`messagePortTransfer`, `sharedArrayBufferClone`, `webSocketBinaryFrame`) and read by a layer above the wire is the same coupling as a wire-primitive type. Read domain capabilities (`BackplaneDeclaration`) from upper layers; the wire layer projects its facts into domain bindings internally."_          | P1       | S      | Medium |
| R7  | **Conformance test: cross-layer leak detector.** `packages/runtime/src/` shipped sources must not import `PortCapabilities` from `@taucad/rpc`. Add a Vitest structural assertion (parallel to `legacy-transport-deletion.test.ts`) that fails the build if any non-test file in `packages/runtime/src/` references `PortCapabilities`. The runtime can read `BackplaneDeclaration` (which it already does) but never wire bits.                                                                             | P1       | S      | Medium |

### Amendments to the Electron Blueprint

Three amendments to `electron-rpc-transport-architecture.md` that align it with this doc; full diff in [§ Amendments to the Electron Blueprint](#amendments-to-the-electron-blueprint).

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R8  | **Replace R1 (PortCapabilities rename) with R3 (channel-internal projection).** The Electron blueprint's R1 ships a wider wire-fact vocabulary (`messagePortTransfer` etc.) that is no longer needed because the runtime never reads it. Keep the existing four-bit `Port.capabilities` shape in `@taucad/rpc`; add the projection layer instead.                                                                                                                                                                                                        | P0       | M      | High   |
| R9  | **Replace R2 (capability gating) with backplane-request gating.** The runtime never gates on capability bits; it gates on `BackplaneRequest` matching. The Electron-specific behaviour ("don't push SAB on the renderer↔main wire") happens because that wire's `Port.capabilities.sab` is `false`, the channel projects no `('file-pool', 'sab')` declaration, the consumer's request for that binding fails at handshake, and the consumer requests `'inline-chunks'` instead — all in domain terms, all without the runtime knowing what Electron is. | P0       | M      | High   |
| R10 | **`wrapElectronUtilityPort` and `wrapElectronCrossProcessPort` declare `BackplaneDeclaration[]`, not just `PortCapabilities`.** Adapters are the only place where wire facts and domain bindings co-exist. The adapter's job is to translate one to the other.                                                                                                                                                                                                                                                                                           | P0       | S      | High   |

## Trade-offs

### Where capability declaration lives

| Strategy                                                                                                                                                                                         | Pros                                                                                                                                                                                                                                                               | Cons                                                                                                                                                                                          | Decision                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Layered (R1–R5, recommended)**: wire facts live in `@taucad/rpc.Channel` internal logic only; domain bindings live in `BackplaneDeclaration` and are the only thing the runtime/consumer reads | Strict layering; runtime is wire-blind; new transports add a `Port` adapter only; existing `BackplaneDeclaration` infrastructure already implements it; matches every prior-art system; satisfies vision-policy's Phase 6 portability and library-api-policy's §22 | Requires the channel to author the projection from wire facts to domain bindings; one-time engineering cost                                                                                   | **adopted**                             |
| Flat (Electron blueprint baseline): runtime reads `Port.capabilities` directly                                                                                                                   | Smallest immediate change                                                                                                                                                                                                                                          | Couples runtime to wire vocabulary; every new transport requires new bits and runtime updates; violates Antipattern 5 by extension; collapses two layers into one                             | rejected                                |
| Reverse: runtime reads only `BackplaneDeclaration`; `@taucad/rpc.Channel` is wire-blind                                                                                                          | Maximally clean separation                                                                                                                                                                                                                                         | Channel cannot pick its own fast-path tier without re-reading wire facts somewhere else; the projection has to live somewhere; this is just the layered model with the projection point moved | rejected — same shape, worse ergonomics |

### Negotiation strategy

| Strategy                                                         | Pros                                                                                                                                                                  | Cons                                                                                                    | Decision    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- |
| **AND-merge of `BackplaneDeclaration[]` at `lh` handshake (R4)** | Both sides agree on the lowest common denominator before any payload moves; surfaces mismatches as typed `BackplaneUnavailableError`; honest descriptor for telemetry | Requires `lh.d.backplanes` to become normative; one minor protocol bump                                 | **adopted** |
| Per-request negotiation (re-check on every `initialize`)         | Maximally flexible                                                                                                                                                    | Runtime overhead per call; impossible to expose stable `client.capabilities` snapshot                   | rejected    |
| Client-only declaration (no handshake check)                     | Simple                                                                                                                                                                | Server's true bindings invisible to client; mismatches discovered by failure rather than by typed error | rejected    |

### Where the projection lives

| Strategy                     | Pros                                                                                                                   | Cons                                                                                      | Decision    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| **In `@taucad/rpc.Channel`** | Channel already reads `Port.capabilities`; projection is one extra method; keeps wire knowledge within the rpc package | Channel grows a small projection table                                                    | **adopted** |
| In each `Port` adapter       | Adapter authors duplicate the projection rules                                                                         | Bug-prone; adapter authors would have to know which backplanes care about which wire bits | rejected    |
| In `@taucad/runtime`         | Centralised                                                                                                            | Re-introduces wire-knowledge in the runtime — the exact thing this doc removes            | rejected    |

## Code Examples

All sketches below match the recommended layered model.

### `Port.capabilities` (unchanged, with corrected JSDoc) — `@taucad/rpc`

```typescript
/**
 * Wire-fact capability bits read by `@taucad/rpc.Channel` only.
 *
 * Runtime consumers MUST NOT branch on these bits. Read
 * `channel.backplanes` (a `BackplaneDeclaration[]` projection of these
 * bits plus protocol features) and request specific bindings via
 * `BackplaneRequest`. The channel projects wire facts into domain
 * bindings; the runtime never crosses the wire/domain layer boundary.
 *
 * @internal — public type, but the only honest external consumer is
 *             `Channel`'s tier-selection logic. Reading these bits in
 *             `packages/runtime/` fails the cross-layer-leak conformance
 *             test (R7).
 */
export type PortCapabilities = {
  readonly sab?: boolean;
  readonly signalSlot?: boolean;
  readonly transfer?: boolean;
  readonly pool?: boolean;
};
```

### Channel-internal projection from wire facts to domain bindings (R3) — `@taucad/rpc`

```typescript
// packages/rpc/src/channel.ts (sketch)
import type { BackplaneDeclaration } from '@taucad/runtime/runner'; // type-only import; rpc remains lib-leaf

const projectCapabilitiesToBackplanes = (port: PortCapabilities): readonly BackplaneDeclaration[] => {
  const backplanes: BackplaneDeclaration[] = [];

  // Filesystem: every channel can serve filesystem via the rpc binding.
  // Add the message-port binding only on wires that can transfer MessagePort objects.
  const filesystemBindings: Array<'message-port' | 'rpc' | 'shared-memory'> = ['rpc'];
  if (port.transfer === true) filesystemBindings.push('message-port');
  if (port.sab === true) filesystemBindings.push('shared-memory');
  backplanes.push({ kind: 'filesystem', bindings: filesystemBindings });

  // File pool: SAB binding requires both shared-memory transfer AND a long-lived pool.
  const filePoolBindings: Array<'sab' | 'inline-chunks'> = ['inline-chunks'];
  if (port.sab === true && port.pool === true) filePoolBindings.push('sab');
  backplanes.push({ kind: 'file-pool', bindings: filePoolBindings });

  // Abort: SAB binding requires a signal slot; wire-command always works.
  const abortBindings: Array<'sab' | 'wire-command'> = ['wire-command'];
  if (port.signalSlot === true) abortBindings.push('sab');
  backplanes.push({
    kind: 'abort',
    bindings: abortBindings,
    latency: port.signalSlot === true ? 'sub-microsecond' : 'queue-bound',
  });

  // Log stream / telemetry: every channel can do inline; sub-channel requires multiplex support.
  backplanes.push({ kind: 'log-stream', bindings: ['inline', 'sub-channel'] });
  backplanes.push({ kind: 'telemetry', bindings: ['inline', 'sub-channel'] });

  return backplanes;
};
```

The projection table IS the contract. Adding a new wire fact (e.g., a future `gpuBufferTransfer`) means extending this projection only — the runtime is untouched.

### Mandatory handshake declaration (R4) — `@taucad/rpc`

```typescript
// packages/rpc/src/wire.ts
export type LinkHelloPayload = {
  readonly peer?: string;
  readonly backplanes: readonly BackplaneDeclaration[]; // required, not optional
};

// packages/rpc/src/channel.ts handshake
if (incoming.kind === 'lh') {
  if (!incoming.d || !Array.isArray(incoming.d.backplanes)) {
    throw new IncompatibleHandshakeError(
      'Peer omitted lh.d.backplanes; both sides must declare BackplaneDeclaration[] at handshake.',
    );
  }
  const local = projectCapabilitiesToBackplanes(this.port.capabilities);
  this._negotiatedBackplanes = intersectBackplanes(local, incoming.d.backplanes);
}
```

`intersectBackplanes(a, b)` keeps only `(kind, binding)` tuples present on both sides. The result is the channel's authoritative declaration for the runtime to consume.

### Runtime consumes only `BackplaneDeclaration` (R2) — `@taucad/runtime`

```typescript
// packages/runtime/src/framework/runtime-worker-client.ts (sketch)
public async initialize(input: InitializeInput): Promise<void> {
  const declared = this.channel.backplanes; // BackplaneDeclaration[], not PortCapabilities
  const requested = this.options.backplanes; // BackplaneRequest[] from consumer

  for (const request of requested) {
    if (findBackplaneDeclaration(declared, request) === undefined) {
      throw new BackplaneUnavailableError({ kind: request.kind, binding: request.binding });
    }
  }

  // Bind each requested backplane in domain terms.
  // The runtime never asks "is this a MessagePort?" — it asks "which binding did the
  // consumer request for filesystem?" and acts on the answer.
  const memoryHandle: InitializeMemoryHandle = await this.bindBackplanes(requested);

  await this.channel.call('initialize', { value: { ...input, memoryHandle }, transferables: this.gatherTransferables() });
}
```

`bindBackplanes` switches on `request.kind` + `request.binding` — pure domain vocabulary. No `port.capabilities` read survives.

### Adapter declares both wire facts AND backplane projections (R10) — `examples/electron-tau`

```typescript
// examples/electron-tau/src/main/electron-port-adapters.ts
import type { Port, PortCapabilities } from '@taucad/rpc';
import { wrapMessagePort } from '@taucad/rpc';

/**
 * High-capability adapter for renderer ↔ utilityProcess kernel wire.
 * The adapter only declares wire facts; the channel projects them into
 * BackplaneDeclaration[] internally.
 */
export const wrapElectronUtilityPort = <T>(port: MessagePort | MessagePortMain): Port<T> =>
  wrapMessagePort<T>(port, {
    capabilities: {
      sab: true, // utility wire carries SAB end-to-end (Finding 10 of Electron blueprint)
      signalSlot: true,
      transfer: true,
      pool: true,
    } satisfies PortCapabilities,
  });

/**
 * Low-capability adapter for renderer ↔ main FS / control plane wire.
 * Same shape; the wire facts the adapter declares dictate which backplane
 * bindings the channel will project (e.g., no SAB ⇒ no `('file-pool','sab')`
 * declaration ⇒ consumer requesting that binding gets BackplaneUnavailableError).
 */
export const wrapElectronCrossProcessPort = <T>(port: MessagePort | MessagePortMain): Port<T> =>
  wrapMessagePort<T>(port, {
    capabilities: {
      sab: false, // electron/electron #50291
      signalSlot: false,
      transfer: false, // electron/electron #34905
      pool: false,
    } satisfies PortCapabilities,
  });
```

The adapter is the only place in the entire system where the words "Electron" and "MessagePort" co-exist with capability semantics. Everything above this layer talks domain.

### Consumer-side bootstrap (R10) — `examples/electron-tau`

```typescript
// examples/electron-tau/src/renderer/app.tsx
import { backplaneRequest, createRuntimeClient } from '@taucad/runtime';
import { portRunner } from '@taucad/runtime/runner';
import { fromPort } from '@taucad/runtime/filesystem';
import { wrapElectronUtilityPort, wrapElectronCrossProcessPort } from './electron-port-adapters';

const client = createRuntimeClient({
  runner: portRunner({ port: wrapElectronUtilityPort(kernelPort) }),
  fileSystem: fromPort(wrapElectronCrossProcessPort(fsPort)),
  backplanes: [
    backplaneRequest('filesystem', 'message-port'), // domain term
    backplaneRequest('file-pool', 'sab'), // domain term
    backplaneRequest('abort', 'sab'), // domain term
  ],
});

await client.connect();
```

The consumer talks domain too. If `backplaneRequest('file-pool', 'sab')` cannot be honoured by the underlying wire, `connect()` rejects with `BackplaneUnavailableError({ kind: 'file-pool', binding: 'sab' })` — the consumer can switch to `'inline-chunks'` and re-connect, no wire knowledge required.

## Diagrams

### Layered capability model (recommended)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Consumer (apps/ui, examples/electron-tau, third-party)                   │
│                                                                           │
│  createRuntimeClient({                                                    │
│    backplanes: [                                                          │
│      backplaneRequest('filesystem', 'message-port'),  ◄── domain word     │
│      backplaneRequest('file-pool',  'sab'),           ◄── domain word     │
│    ],                                                                     │
│  });                                                                      │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ BackplaneRequest[] (domain vocabulary)
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  @taucad/runtime — RuntimeClient + RuntimeWorkerClient                    │
│                                                                           │
│  reads: channel.backplanes (BackplaneDeclaration[])                       │
│  matches: BackplaneRequest[] against declared bindings                    │
│  throws: BackplaneUnavailableError on unmatched request                   │
│                                                                           │
│  NEVER reads: port.capabilities (enforced by R7 conformance test)         │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ channel.backplanes (domain vocabulary)
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  @taucad/rpc — Channel                                                    │
│                                                                           │
│  reads: port.capabilities (wire vocabulary, internal only)                │
│  projects: PortCapabilities → BackplaneDeclaration[] via fixed table      │
│  exposes: backplanes (the projection result, advertised in lh handshake)  │
│  picks: pool → transfer → copy fast-path tiers per port.capabilities       │
└──────────────────┬───────────────────────────────────────────────────────┘
                   │ port.capabilities (wire vocabulary)
                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Port adapter (wrapMessagePort, wrapElectronUtilityPort, …)               │
│                                                                           │
│  declares: PortCapabilities (the only honest source of wire facts)        │
│  binds: postMessage / addEventListener to the wire primitive              │
│                                                                           │
│  THE ONLY LAYER WHERE WIRE PRIMITIVES (MessagePort, WebSocket, …)         │
│  AND DOMAIN-CAPABILITY SEMANTICS (BackplaneDeclaration) CO-EXIST          │
└──────────────────────────────────────────────────────────────────────────┘
```

Each layer reads only its own vocabulary plus the layer immediately below it. Adding a new wire kind extends one layer (the adapter). Adding a new domain backplane extends one layer (the runtime + the channel projection table). Neither change ripples across layers.

### Failure-mode comparison — current Electron blueprint vs. corrected

```
SCENARIO: consumer requests SAB-backed file pool on renderer↔main wire (broken for SAB)

═══════════════════════════════════════════════════════════════════════════
Current Electron blueprint (incorrect — runtime reads wire facts):
───────────────────────────────────────────────────────────────────────────
  Consumer:     createRuntimeClient({ sharedMemory: { geometry: { capacity } } })
                       │
  Runtime:    initialize() reads port.capabilities.sharedArrayBufferClone
                       │
                       ▼
                if (caps.sharedArrayBufferClone === false &&
                    consumer.requested === 'sab') {
                  throw MissingCapabilityError('sharedArrayBufferClone', …);
                }
                       │
  Error:        MissingCapabilityError('sharedArrayBufferClone', …)
                ↑ The error name leaks the wire fact. The consumer has to know
                  what 'sharedArrayBufferClone' means to handle it.

═══════════════════════════════════════════════════════════════════════════
Corrected (recommended — runtime reads domain bindings only):
───────────────────────────────────────────────────────────────────────────
  Consumer:     createRuntimeClient({
                  backplanes: [backplaneRequest('file-pool', 'sab')],
                })
                       │
  Runtime:    initialize() reads channel.backplanes (BackplaneDeclaration[])
                       │
                       ▼
                if (findBackplaneDeclaration(declared, request) === undefined) {
                  throw BackplaneUnavailableError({
                    kind: 'file-pool', binding: 'sab',
                  });
                }
                       │
  Error:        BackplaneUnavailableError({ kind: 'file-pool', binding: 'sab' })
                ↑ The error speaks domain terms. The consumer can request
                  the 'inline-chunks' binding instead — no wire knowledge needed.

  Channel internal: port.capabilities.sab === false ⇒ no 'sab' binding in
                    the projected file-pool declaration. The wire fact is
                    consumed and translated within the channel layer; never
                    surfaces to the runtime.
═══════════════════════════════════════════════════════════════════════════
```

### Adding a future transport (e.g., WebRTC `RTCDataChannel`)

```
Today (incorrect): runtime would gain new bits like rtcDataChannelOrdered,
                   rtcDataChannelBinaryFrame, …, plus matching switch arms
                   in RuntimeWorkerClient.initialize(). Every transport adds
                   runtime knowledge.

Recommended:       new transport ships:
                     1. wrapWebRtcDataChannelPort adapter declaring its
                        PortCapabilities (only wire facts it knows)
                     2. (no other code changes anywhere)
                   Channel projects the new wire facts into BackplaneDeclaration[]
                   automatically via the fixed projection table.
                   Runtime continues reading BackplaneDeclaration[]. Done.
```

Adding the WebSocket transport (currently aspirational) becomes a one-package change: a `wrapWebSocketPort` adapter in `@taucad/rpc` (or a `@taucad/websocket` companion) declaring `{ sab: false, signalSlot: false, transfer: false, pool: false }`. The runtime never learns about WebSockets.

## Amendments to the Electron Blueprint

The accepted blueprint at [`docs/research/electron-rpc-transport-architecture.md`](./electron-rpc-transport-architecture.md) requires three concrete edits to align with this analysis. None of the topology recommendations (Topology C, layered FS Q1-D, one utilityProcess per RuntimeClient, two adapters by wire kind) change — the only changes are to the capability-handling recommendations. Suggested PR scope:

| Site in Electron blueprint                                           | Original                                                                                                                      | Replacement                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Executive Summary, "Runtime stays transport-agnostic" bullet         | "`Port.capabilities` becomes the authoritative ledger; the runtime's behaviour is a pure function of those bits"              | "`BackplaneDeclaration[]` (projected by the channel from `Port.capabilities`) becomes the authoritative ledger the runtime reads. Wire-fact bits stay channel-internal. The runtime's behaviour is a pure function of negotiated `BackplaneDeclaration[]` and consumer-supplied `BackplaneRequest[]`." |
| R1 (PortCapabilities rename)                                         | Hard rename to `arrayBufferTransfer`, add `messagePortTransfer`, add `sharedArrayBufferClone`                                 | **Deleted.** Keep the existing four-bit `Port.capabilities` (`sab`/`signalSlot`/`transfer`/`pool`) unchanged — they are channel-internal and don't need a vocabulary that mirrors Electron's wire taxonomy.                                                                                            |
| R2 (capability gating)                                               | Read `port.capabilities` in `RuntimeWorkerClient.initialize()`; throw `MissingCapabilityError` on explicit requests           | Read `channel.backplanes` (BackplaneDeclaration projection) in `RuntimeWorkerClient.initialize()`; throw `BackplaneUnavailableError` on unmatched `BackplaneRequest`. The Electron-specific behaviour ("don't push SAB on renderer↔main") emerges automatically from the projection table.             |
| R3 (handshake `lh.d.capabilities`)                                   | `lh.d.capabilities: PortCapabilities` mandatory at handshake                                                                  | `lh.d.backplanes: BackplaneDeclaration[]` mandatory at handshake. AND-merge by `(kind, binding)` intersection. `IncompatibleHandshakeError` if either side omits.                                                                                                                                      |
| R4 + R5 (`wrapElectronUtilityPort` + `wrapElectronCrossProcessPort`) | Adapters declare a `PortCapabilities` constant                                                                                | Adapters declare a `PortCapabilities` constant unchanged — but the JSDoc points readers to the channel's projection rules, and the consumer never sees the wire bits.                                                                                                                                  |
| Failure-mode quick reference (A.7)                                   | "Renderer parks at `lifecycleState === 'connecting'` → R3: AND-merged handshake fails fast with `IncompatibleHandshakeError`" | unchanged in spirit; replace `IncompatibleHandshakeError` cause-text from "either side mis-declares `capabilities`" with "either side omits `lh.d.backplanes`"                                                                                                                                         |
| Q&A resolution log (A.8)                                             | OQ-3, OQ-11, OQ-12 phrased in `PortCapabilities` terms                                                                        | Re-phrase in `BackplaneDeclaration` / `BackplaneRequest` / `BackplaneUnavailableError` terms; semantics are unchanged but the vocabulary aligns with this doc's layering rule.                                                                                                                         |

The Electron blueprint's overall topology recommendation (Topology C with main-mediated `MessageChannelMain` bootstrap, one `utilityProcess` per `RuntimeClient`, layered FS per Q1-D) survives intact. Only the capability-handling vocabulary changes.

## References

### External / prior art

- [JDBC `DatabaseMetaData` (Java SE 21)](https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/DatabaseMetaData.html) — driver-declared capabilities, framework-consumed, application-invisible
- [WebGPU `requestAdapter` / `requestDevice` (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter) — adapter declares features/limits; consumer requests by name; rejection on unmet requirement
- [WebGPU optional features and limits (webgpufundamentals.org)](https://webgpufundamentals.org/webgpu/lessons/webgpu-limits-and-features.html) — best-practice "request only what you need" pattern
- [Rust `embedded-hal`](https://github.com/rust-embedded/embedded-hal) — trait-as-capability for hardware abstraction
- [libhal (C++)](https://libhal.github.io/4.1/) — interface-as-capability, runtime polymorphic
- [A2A Protocol — three-layer model](https://a2a-protocol.org/v1.0.0/specification) — Layer 1 data, Layer 2 abstract operations, Layer 3 protocol bindings
- [PACT Protocol RFC-001](https://github.com/noahfavreau/pact-protocol/blob/main/pact-spec/docs/PACT-RFC-001.md) — "transport independence" as a normative requirement
- [WebSocket subprotocol negotiation (RFC 6455 §4.2)](https://datatracker.ietf.org/doc/html/rfc6455#section-4.2.2) — handshake-time domain-name negotiation

### Internal / Tau

- [Library API Policy §22 — Async Surface Hygiene (Antipattern 5)](../policy/library-api-policy.md#22-async-surface-hygiene-antipatterns) — wire primitives in public option objects
- [Vision Policy](../policy/vision-policy.md) — five-pillar long-term goal that motivates strict transport agnosticism
- [Runtime Async-Event Contract](./runtime-async-event-contract.md) — original derivation of Antipattern 5; the typed-handle pattern that this doc generalises to capability bits
- [Runtime Channel Blueprint v5](./runtime-channel-blueprint-v5.md) — Finding 7 already scoped `Port.capabilities` as channel-internal; this doc restores that scoping
- [Electron RPC Transport Architecture](./electron-rpc-transport-architecture.md) — the doc whose R1–R3 this doc amends
- `packages/rpc/src/port.ts` — `PortCapabilities` definition (channel-internal after R1)
- `packages/runtime/src/runner/backplanes.ts` — existing `BackplaneDeclaration` / `BackplaneRequest` infrastructure that R2 promotes to the runtime's sole capability surface
- `packages/runtime/src/legacy-transport-deletion.test.ts` — pattern to extend for R7 conformance check
