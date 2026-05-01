---
title: 'Electron RPC Transport Architecture'
description: 'Canonical blueprint for Topology C (Renderer ↔ utilityProcess kernel host with main-mediated MessagePort bootstrap) and a VS Code-style layered FS, with all runtime transport decisions driven by negotiated Port.capabilities.'
status: superseded
created: '2026-04-28'
updated: '2026-04-28'
superseded_by: docs/research/runtime-transport-architecture-v6.md
category: architecture
related:
  - docs/research/runtime-transport-architecture-v6.md
  - docs/research/runtime-channel-blueprint-v5.md
  - docs/research/runtime-worker-bundling-strategy.md
  - docs/research/electron-ipc-gap-analysis.md
  - docs/research/runtime-transport-implementation-blueprint-v4.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/runtime-cross-origin-isolation-distribution.md
---

# Electron RPC Transport Architecture

> **Status: SUPERSEDED.** This document has been superseded by [`runtime-transport-architecture-v6.md`](./runtime-transport-architecture-v6.md). The v6 blueprint folds `Runner`, `Port.capabilities`, and `BackplaneDeclaration` into a single `defineRuntimeTransport` primitive and removes wire-fact bits from public API surface (eliminating the `library-api-policy.md` §22 Antipattern 5 leak this document inadvertently exposed). The Electron Topology C and VS Code-style layered FS recommendations below remain factually correct as **environmental findings** and are carried forward verbatim into v6 — but the runtime/transport/capability ownership model below is no longer the recommended architecture. Refer to v6 for the current source of truth.

The canonical blueprint for how `@taucad/rpc` + `@taucad/runtime` integrate with Electron under **Topology C** (Renderer ↔ `utilityProcess` kernel host with a main-mediated `MessagePort` bootstrap) and a **VS Code-style layered filesystem** (per-process local `fromNodeFs` instances, main as the renderer's IPC endpoint, disk as the source of truth). The runtime stays transport-agnostic — every transport-dependent decision is a pure function of `Port.capabilities` declared by the consumer's adapter — while consumers compose Electron primitives in their own bootstrap layer.

## Executive Summary

**The architectural problem.** The current Electron PoC stalls at `lifecycleState === 'connecting'` because the renderer's `initialize` request packs a transferable `MessagePort` (the FS port) plus a cloneable `SharedArrayBuffer` into one cross-process message, and Electron's renderer↔main `MessagePort` wire silently nulls the entire `event.data` payload when any non-`MessagePortMain` transferable is in the transfer list (electron/electron #34905, #37565). Electron also rejects `SharedArrayBuffer` cloning on that same wire (#50291, #25446), and `contextBridge` strips `MessagePort` prototype methods so a `window.postMessage` relay is mandatory in preload (#27024).

**The deeper finding.** The renderer↔main wire is uniquely constrained in Electron — it is the only `MessagePort` pair in the system where SAB cloning is broken and where `ArrayBuffer` transfer is broken. Renderer↔renderer and renderer↔`utilityProcess` `MessagePort` pairs (once main forwards the port and steps out of the hot path) carry SAB and transferable `ArrayBuffer` end-to-end, exactly like browser `MessagePort`s, because the underlying Mojo pipe bypasses the main process entirely after handshake (electron/electron PR #22404; `electron-direct-ipc` empirical evidence). This is the architectural pattern VS Code adopted in its 2022 sandbox migration when it contributed the `utilityProcess` API to Electron specifically to host the Extension Host. **Tau's PoC chose the architecturally weakest of every plausible topology**: it placed the kernel runner on the far side of the only broken wire.

**The blueprint, in three parts.**

1. **Runtime stays transport-agnostic.** `Port.capabilities` becomes the authoritative ledger; the runtime's behaviour is a pure function of those bits. The hard rename `transfer → arrayBufferTransfer` and `sab → sharedArrayBufferClone` lands in one PR with no aliases (Q12). Capability mismatches throw `MissingCapabilityError` only when the consumer explicitly requested the missing feature; otherwise the runtime silently picks the best tier the wire actually supports (Q3). Handshake AND-merges `lh.d.capabilities` from both sides and rejects with `IncompatibleHandshakeError` if either side omits the field (Q11).

2. **Topology C is the only Electron kernel placement Tau ships.** Main spawns one `utilityProcess` per `RuntimeClient` (Q6 — multiple `cad.machine` instances each get their own utility process), creates a `MessageChannelMain`, and hands one port to the utility and one port to the renderer. After bootstrap, main is off the hot path. The runtime sees a 2-party RPC topology identical to the browser case. Two adapters live in `examples/electron-tau` for the PoC (Q4): `wrapElectronUtilityPort` for the renderer↔utility kernel wire (full capabilities) and `wrapElectronCrossProcessPort` for any renderer↔main wire (FS / control plane only, low capabilities). Adapters use fixed capability declarations named after the wire kind (Q5).

3. **Filesystem is layered VS Code-style** (Q1-D, Finding 20). Each Node-capable process holds its own local `fromNodeFs(...)` instance — the disk is the source of truth, no cross-process FS RPC is needed for state coordination. The kernel-host utility process reads source/parameter files and writes artifacts directly, with zero IPC hops on the kernel hot path. Main holds its own `fromNodeFs` and exposes it via `RuntimeFileSystemBridge` over a renderer↔main `MessageChannelMain` (low-cap wire) so the sandboxed renderer can drive the file tree, project save, and parameter-group edits. Watching is co-located with the kernel-host utility process for v1 (using the existing `FilesystemObserverBridge`); the dedicated watcher process is deferred until a CPU smell appears.

**Out of PoC scope (deferred, captured for future planning).** Lifecycle respawning of the kernel utility on crash (Q7), native N-API CAD addons (Q9), `OffscreenCanvas` 3D viewer (Q15), browser-side nested workers (Topology E), and moving adapters out of `examples/electron-tau` into a `@taucad/electron` companion package (Q4/Q8). Each is documented as a follow-up so the PoC stays small while the design absorbs the future without breaking.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Backplane Inventory](#backplane-inventory)
- [Topology Comparison](#topology-comparison)
- [Resolved Decisions](#resolved-decisions)
- [The Eigenquestion](#the-eigenquestion)
- [Recommendations](#recommendations)
- [PoC Scope](#poc-scope)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix](#appendix)

## Problem Statement

The v5 worker bundling strategy (`docs/research/runtime-worker-bundling-strategy.md`, R1–R6) inverted worker URL resolution so consumers own the bundling. With R1–R3 implemented, the Electron PoC builds and the kernel worker boots inside a Node `worker_threads` instance owned by the Electron main process. Renderer ↔ main wiring uses `MessageChannelMain` ports relayed through preload via `window.postMessage`.

**Symptoms:**

- Renderer's `RuntimeWorkerClient.initialize(...)` posts a `WireRequest` whose `a` payload contains `memoryHandle: { signalBuffer: SharedArrayBuffer, fileSystemPort: MessagePort }` and whose `transfer` list is `[fileSystemPort]`.
- Main-process port adapter (wrapping `MessagePortMain`) receives the message but `event.data === null`.
- `Channel` on the host side never sees a `WireMessage`, so `channel.ready` never resolves; renderer parks at `lifecycleState: 'connecting'` and the e2e Playwright assertions timeout.

**Trigger for this research:** the user's instruction — "deeply explore the RPC architecture+lib inside this codebase, identify how that RPC architecture+lib is integrated into the runtime package, deeply research on the web about Electron `MessageChannelMain` … identify the eigenquestion of our task, then deeply reason to identify the approach we must follow to implement Electron primitives into the RPC abstraction layer in Tau in a way that the runtime remains agnostic of the underlying transport."

## Methodology

1. Mapped every export of `@taucad/rpc` from `packages/rpc/src/index.ts` and read `channel.ts`, `port.ts`, `multiplex.ts`, `wire.ts`, `trace.ts` plus all `*.test.ts` siblings.
2. Mapped every `from '@taucad/rpc'` import inside `packages/runtime/src/` and traced the call chain from `RuntimeClient.connect()` → `RuntimeWorkerClient.initialize()` → `Channel.call()` → `Port.postMessage()`.
3. Traced the host side: `createRuntimeHost` → `runner.host(port, { fileSystem })` → `inProcessRunner` / `nodeWorkerRunner` / `webWorkerRunner` → `createWorkerDispatcher`.
4. Read the upstream Electron docs (`MessagePortMain`, `MessageChannelMain`, `utilityProcess`, `contextBridge`) and the four blocking GitHub issues (#27024, #34905, #37565, #50291, plus the SAB-clone issues #10409 and #25446).
5. Verified the empirical "data → null" failure against the issue body of #34905 (gist-confirmed by `yume-chan`): "If a message contains a `MessagePort`, the message will become null in main process."
6. Reread `docs/research/electron-ipc-gap-analysis.md` (v4 era) to confirm continuity with prior architectural decisions (`fromHost` FS arm, generic `createMessagePortTransport`).

## Findings

### Finding 1: `@taucad/rpc` is already transport-agnostic — capability data exists, but is never consulted as a contract

`Port<T>` is the entire transport contract (`packages/rpc/src/port.ts`):

```typescript
export type Port<T> = {
  readonly capabilities: PortCapabilities;
  postMessage(data: T, transfer?: readonly Transferable[]): void;
  onMessage(handler: (data: T) => void): () => void;
  start?(): void;
  close(): void;
};
```

`PortCapabilities` is a structural bag with four optional bits:

```typescript
export type PortCapabilities = {
  readonly sab?: boolean;
  readonly signalSlot?: boolean;
  readonly transfer?: boolean;
  readonly pool?: boolean;
};
```

`@taucad/rpc` never branches on these bits internally. `createChannelClient`/`createChannelServer` always assume `postMessage(data, transferList)` is honoured; `WithTransferables` envelopes are unwrapped and passed straight through. This is _correct_ for an RPC primitive — capability-blindness keeps the wire format uniform — but it means **gating must happen one layer up, in the runtime, before the runtime hands a message to the channel**.

### Finding 2: The runtime declares capabilities but does not gate behaviour on them

`packages/runtime/src/framework/runtime-message-adapter.ts` constructs a worker-side `Port` with `{ sab: true, signalSlot: true, transfer: true }` (no `pool`). `wrapMessagePort` (in `@taucad/rpc`) constructs every other adapter with `{ transfer: true }` only. Yet across `packages/runtime/src/`:

| Site                                                      | Capability consulted | Effect                                                                                                                       |
| --------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `runtime-worker-dispatcher.ts` `readDeliveryCapabilities` | `pool`, `transfer`   | Picks pooled vs inline vs transfer geometry tier — _correct_ pattern.                                                        |
| `runtime-client.ts` connect descriptor                    | `sab`                | Sets descriptor's `sharedMemory: boolean` reporting field — _passive_, doesn't gate behaviour.                               |
| `runtime-worker-client.ts` `initialize()`                 | none                 | Always allocates SAB and always packs `fileSystemPort` into `transferables`, regardless of what the wire can actually carry. |

The smoking gun is at `packages/runtime/src/framework/runtime-worker-client.ts` ~287–303: the assembly of `memoryHandle` and the `transferables.push(fileSystemPort)` is unconditional. There is no consultation of `port.capabilities` before deciding whether the wire can carry SAB at all, or whether the wire can transfer a `MessagePort` alongside cloneable data. That is the architectural gap.

### Finding 3: Electron `MessageChannelMain` is strictly less capable than `worker_threads` MessagePort or browser MessagePort

Hard limits, all confirmed against electron/electron upstream issues and Chromium source citations:

| Capability                                   | Browser `MessagePort`                 | Node `worker_threads` `MessagePort` | Electron `MessageChannelMain` cross-process                                                             |
| -------------------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Transfer `MessagePort`                       | yes                                   | yes                                 | yes                                                                                                     |
| Transfer `ArrayBuffer` (zero-copy)           | yes                                   | yes                                 | **no** — drops payload to `null` (#34905) or segfaults (#37565)                                         |
| Transfer `TypedArray` backing buffer         | yes                                   | yes                                 | **no** — same as `ArrayBuffer`                                                                          |
| Clone `SharedArrayBuffer` (shared semantics) | yes                                   | yes (Node policy permitting)        | **no** — `An object could not be cloned` (#50291, #25446)                                               |
| Clone `ArrayBuffer` (copy semantics)         | yes                                   | yes                                 | yes                                                                                                     |
| Mixing transferable + clone in one message   | yes                                   | yes                                 | **partial** — works for `MessagePortMain[]` only; mixing with non-port transferables nulls `event.data` |
| Implicit message queue before `start()`      | start required for `addEventListener` | start required for `on('message')`  | start required for `on('message')` (Node-style EventEmitter)                                            |

References: [#34905](https://github.com/electron/electron/issues/34905) (port-only transfers; `ArrayBuffer` in transfer list nulls data), [#37565](https://github.com/electron/electron/issues/37565) (segfault on `ArrayBuffer`/`TypedArray` transfer through `MessagePortMain`), [#50291](https://github.com/electron/electron/issues/50291) and [#25446](https://github.com/electron/electron/issues/25446) (`SharedArrayBuffer` rejected by Electron's IPC structured clone), [#10409](https://github.com/electron/electron/issues/10409) (SAB cannot cross OS process boundaries by spec; only OS-level shared-memory addons help).

### Finding 4: SharedArrayBuffer can still reach a renderer-spawned worker if the kernel worker is co-located with the renderer

`SharedArrayBuffer` is shareable between threads of the _same process_, not across OS processes. Inside Electron:

- A renderer process and a Web Worker spawned _from_ that renderer share a process → SAB works.
- The main process and a `worker_threads.Worker` spawned _from_ main share a process → SAB works.
- Renderer ↔ main are different OS processes → SAB cannot cross.

However, even cross-process, the Electron docs note one escape hatch ([Channel Messaging tutorial](https://www.electronjs.org/docs/latest/tutorial/message-ports), worker example): **the main process can mediate a `MessagePort` between two renderers, and SAB then flows directly renderer-to-renderer over that port without re-entering the main process**. Same applies to a renderer ↔ another renderer-spawned worker.

### Finding 5: `contextBridge` cannot expose `MessagePort` prototypes — `window.postMessage` relay is canonical

`contextBridge.exposeInMainWorld` copies values across V8 contexts using a Structured-Clone-like layer that drops prototypes (Electron docs: contextBridge type table — `Object` and `Array` types lose prototype). A `MessagePort` returned from a bridged function loses `addEventListener`, `start`, `close`, and `postMessage`. The maintainer-blessed workaround in [#27024](https://github.com/electron/electron/issues/27024) is for the preload (isolated world) to call `window.postMessage('tag', '*', [port])`, and the renderer (main world) to receive the genuine `MessagePort` from `event.ports[0]` of a `'message'` event. This is consumer-app concern, not runtime concern — but the runtime's `Port` contract must remain compatible with this delivery path.

### Finding 6: Electron's canonical "offload CPU from main thread" choices are utilityProcess, worker_threads, or hidden BrowserWindow — each with distinct port semantics

| Pattern                           | Process model                                | SAB scope                              | Standard wire                                                                           | When it fits Tau                                                                                                                     |
| --------------------------------- | -------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `utilityProcess.fork()`           | Chromium-services-managed Node child process | within child only                      | `MessagePortMain` via `child.postMessage(msg, [port])`, child uses `process.parentPort` | Modern Electron-blessed offload; isolates crashes; full Node API; pays one full V8 startup                                           |
| `worker_threads.Worker` (in main) | thread inside main process                   | shared with main                       | Node `MessagePort` (DOM-shape)                                                          | Lowest startup cost; main shares SAB with kernel; renderer cannot share SAB with kernel (cross-process boundary)                     |
| Web Worker (in renderer)          | thread inside renderer                       | shared with renderer                   | DOM `MessagePort`                                                                       | Renderer ↔ kernel share SAB; main cannot share SAB with kernel; FS authority must live in renderer or be RPC'd from main without SAB |
| Hidden BrowserWindow              | separate renderer process                    | within that renderer (and its workers) | `MessagePort` via main-mediated `MessageChannelMain`                                    | Useful for sandboxed Blink-feature work; SAB scope is that BrowserWindow only                                                        |

The right choice _depends entirely on which side needs SAB-backed coordination with the kernel_. Tau's geometry pipeline pools render outputs in SAB and uses a SAB signal slot for cooperative cancel — that is rendered _into the renderer's display thread_. Therefore a Web Worker spawned by the renderer is the natural placement for the kernel in Electron, with the main process kept as FS authority and window orchestrator. The runtime must not encode that decision; the consumer's `createRuntimeClient`/`createRuntimeHost` glue does.

### Finding 7: The PoC's choice (kernel in main via `nodeWorkerRunner`) is architecturally weakest for Tau's SAB-heavy workload

The PoC routes renderer → main → `worker_threads` kernel. To make SAB-backed pool delivery flow back to the renderer, the geometry pool would have to live in main and reach the renderer over the renderer↔main wire — which Electron forbids (#50291). Forced fallback: the runtime would have to copy every geometry blob across the renderer↔main boundary, defeating the SAB pool entirely.

The renderer-Web-Worker placement (Finding 6, row 3) keeps SAB-coordination exactly where Tau needs it, makes the renderer↔main wire purely an FS RPC that only carries cloneable bytes, and keeps `MessageChannelMain` doing only what it can do well (transferring `MessagePortMain` for the FS sub-channel).

### Finding 8: `@taucad/rpc` already proves transport portability via `topology-conformance.test.ts` — but tests cover Node `MessageChannel`, not Electron

`packages/rpc/src/topology-conformance.test.ts` runs T1–T4 against `node:worker_threads` `MessageChannel` and a real `Worker`, demonstrating that the channel's wire works across heterogeneous adapters. Electron's `MessageChannelMain` has never been a conformance target. The asymmetry — works in tests, fails in Electron — is exactly what Finding 3's capability gap predicts.

### Finding 9: Multiplex sub-ports inherit `capabilities` from the root, which is correct but blocks per-sub-channel tuning

`packages/rpc/src/multiplex.ts` ~227 sets sub-port `capabilities = root.capabilities`. If, for instance, the root wire is Electron `MessageChannelMain` (no SAB, no buffer transfer) but a single sub-channel has been arranged via a separate trustworthy port (e.g. another `MessageChannelMain` for FS), the sub-channels cannot opt _down_ from the root's declared bits. For Tau, this matters when one logical channel needs SAB and another does not — but in practice, when SAB is declared at the root, every sub-channel has access to that wire's SAB; it does not matter.

### Finding 10: The renderer↔main wire is uniquely broken; renderer↔renderer and renderer↔utility wires carry SAB and ArrayBuffer end-to-end

This is the single most consequential finding for Tau and was implicit but undeveloped in the first research pass. Electron upstream PR [#22404](https://github.com/electron/electron/pull/22404) (the PR that introduced `MessagePortMain`) contains a worked example, supplied by the maintainer, demonstrating that:

```js
// In renderer w1
const { port1, port2 } = new MessageChannel();
const buf = new SharedArrayBuffer(16);
port2.postMessage(buf);
ipcRenderer.postMessage('port', null, [port2]);

// In main
ipcMain.on('port', (e) => w2.webContents.postMessage('port', null, e.ports));

// In renderer w2
ipcRenderer.on('port', (e) => {
  const [port] = e.ports;
  port.onmessage = (ev) => {
    const buf = ev.data;
    // buf here is the same SharedArrayBuffer as in w1.
  };
});
```

Maintainer commentary on the same PR: _"Communication over `MessagePort` between two renderer processes is not proxied through the main process."_ The main process forwards the port at the OS-handle level, then steps out — the underlying Mojo pipe is direct between the two endpoints. This is why SAB cloning works on that wire even though it does not work on a renderer↔main wire: the latter genuinely has to deserialize on the main side, which has no Blink context, and SAB requires Blink.

The community library [`electron-direct-ipc`](https://github.com/jjeff/electron-direct-ipc) confirms the same pattern empirically and extends it to renderer↔utility process pairs — its README lists "Full SharedArrayBuffer support — true shared memory and zero-copy ArrayBuffer transfers" as a first-class feature, alongside "Full communication with Electron UtilityProcess workers". The mechanism is identical: main forwards the `MessagePortMain` once at bootstrap, then the renderer↔utility pipe carries SAB and transferable `ArrayBuffer`.

The implication for Tau is dramatic: **the only broken wire in Electron's ecosystem is the one Tau's PoC chose to place the kernel behind**. Every other plausible kernel placement (renderer Web Worker, utility process, hidden BrowserWindow) gives the runtime a wire that is functionally identical to a browser `MessagePort` from a `Port.capabilities` standpoint.

### Finding 11: Electron's idiomatic process-offloading API is `utilityProcess`, not `worker_threads` from main

VS Code's 2022 sandbox migration ([Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)) explicitly required a new Electron API to host the Extension Host outside the renderer. Quoting the post: _"At that time, Electron was not able to provide us with an API that supports these requirements and so we contributed a new utility process API to Electron. This API enabled us to move the extension host away from the renderer process and into a utility process that is created from the main process. Using message ports, we can communicate directly between the renderer and extension host without impacting any other process, such as the main process handling all user input."_

`utilityProcess.fork(scriptPath)` ([Electron docs](https://www.electronjs.org/docs/latest/api/utility-process)) gives the consumer:

- A Chromium-services-managed Node.js child process, isolated from main
- Full Node.js API (`require`, native addons, `worker_threads` _inside_ the utility process)
- A bidirectional `MessagePortMain` to the parent (`process.parentPort`)
- The ability to receive additional `MessagePortMain[]` via `child.postMessage(msg, [port])` from main
- Stdout/stderr piping, lifecycle events (`spawn`, `exit`), graceful shutdown
- Crash isolation — a utility-process segfault does not take down main or the renderer

This is materially different from `worker_threads.Worker` spawned from main:

| Property                           | `worker_threads.Worker` from main | `utilityProcess.fork`                         |
| ---------------------------------- | --------------------------------- | --------------------------------------------- |
| Process boundary                   | thread inside main process        | separate OS process                           |
| Crash isolation                    | crash takes down main             | crash isolated                                |
| Native addon loading               | shares main's addon space         | independent addon space                       |
| Renderer-direct port               | possible but goes through main    | direct via main-mediated `MessageChannelMain` |
| Can spawn its own `worker_threads` | yes                               | yes                                           |
| Memory accounting                  | main's V8 heap budget             | independent V8 heap                           |
| Standard Electron pattern          | not idiomatic                     | **idiomatic** since Electron 22               |

For Tau's stated goal (heavy CAD with native binaries + WASM, simulations, isolated from main thread), `utilityProcess` is the canonical choice and the closest analog to a "kernel runner" on Electron.

### Finding 12: Backplane inventory — the spectrum of cross-process data sharing in Electron

A comprehensive inventory of how production Electron apps move data between processes:

| Backplane                                                          | Where it works                                                            | Bandwidth                                                       | Latency                                             | Setup                                                | Production users                                                                                                                                                                   | When to use                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Structured-clone IPC** (`ipcMain.handle`/`invoke`)               | renderer ↔ main (any direction)                                           | low (full deep copy)                                            | medium (one V8 serialise/deserialise per direction) | trivial                                              | every Electron app                                                                                                                                                                 | small messages, no large binary                                      |
| **`webContents.postMessage`**                                      | main → renderer                                                           | high (zero-copy `ArrayBuffer` transfer supported one-way)       | low                                                 | trivial                                              | the [coldfusion-example 2026 post](https://coldfusion-example.blogspot.com/2026/01/electron-performance-optimizing.html) demonstrates 10M-element `Float32Array` transfers at O(1) | hot path, large binary, main → renderer                              |
| **`ipcRenderer.postMessage`**                                      | renderer → main                                                           | low (cannot transfer `ArrayBuffer` — silently fails per #34905) | medium                                              | trivial                                              | every Electron app for `MessagePort` setup                                                                                                                                         | use only to ship `MessagePort`s to main; never ship buffers this way |
| **`MessageChannelMain` cross-process port** (renderer ↔ main)      | renderer ↔ main                                                           | low for binary (transfer broken)                                | low for control plane                               | per-channel                                          | VS Code's main → window IPC                                                                                                                                                        | control plane, `MessagePort` plumbing, NOT bulk data                 |
| **Renderer ↔ renderer relayed `MessagePort`**                      | between renderer processes (window-to-window, BrowserView-to-BrowserView) | **high** (SAB and `ArrayBuffer` transfer both work end-to-end)  | low (direct Mojo pipe after handshake)              | one main-side relay step                             | VS Code (window↔window for some features); `electron-direct-ipc` users                                                                                                             | renderer-to-renderer hot path                                        |
| **Renderer ↔ `utilityProcess` relayed `MessagePort`**              | renderer ↔ utility                                                        | **high** (SAB and `ArrayBuffer` transfer both work)             | low                                                 | one main-side relay step                             | VS Code (renderer ↔ Extension Host); the explicit `utilityProcess` use case                                                                                                        | renderer ↔ kernel/worker hot path                                    |
| **`SharedArrayBuffer` (in-process)**                               | within one process and its Web Workers / `worker_threads`                 | maximum (true shared memory)                                    | zero                                                | requires COOP/COEP headers in renderer               | every WASM-multithreaded app                                                                                                                                                       | hot path inside one process                                          |
| **Native addon shared memory** (e.g. `shm-typed-array`, `mmap-io`) | any two processes that load the addon                                     | maximum (OS shared memory)                                      | zero                                                | native addon, manual lifecycle, key plumbing via IPC | high-frame-rate image/video apps; Molybden SDK uses it for C++↔JS at ~50 MB/s                                                                                                      | when SAB cannot reach (cross-process and the wire path doesn't fit)  |
| **WebRTC `RTCDataChannel`**                                        | any two processes once peers exchange SDP                                 | high but variable                                               | medium                                              | complex (SDP exchange, ICE)                          | mentioned in the Reddit thread for renderer ↔ main video frames                                                                                                                    | usually overkill; only if you also need network transparency         |
| **HTTP/WebSocket loopback**                                        | any process pair on the local machine                                     | medium (HTTP framing overhead)                                  | medium                                              | requires server in one peer                          | desktop apps that already have a local server                                                                                                                                      | when you also need a remote client                                   |

Three observations from the inventory:

1. **`SharedArrayBuffer` and in-process backplanes are by far the fastest** but constrained to a single process tree. Tau's geometry pool depends on SAB.
2. **Renderer ↔ utility / renderer ↔ renderer `MessagePort`s are the only cross-process backplanes that match SAB performance** because they bypass the main-process serialisation step. They are also the only Electron backplanes that match the browser `MessagePort` capability surface.
3. **Native addon shared memory is the universal escape hatch** but adds build complexity (per-platform binaries, ASAR unpacking, lifecycle), so it is only justified when no `MessagePort`-based path can reach the destination.

### Finding 13: VS Code is the de-facto reference architecture for heavy-compute Electron apps

VS Code's process model after the 2022 sandbox migration is the most mature, well-documented Electron-on-heavy-compute architecture in the public domain. Its choices are the defaults Tau should deviate from only with stated reason.

| Component        | Process kind                                    | Why                                                             | What Tau equivalent maps to                                   |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Main             | Electron main (Node)                            | App lifecycle, window management, OS integration                | Same                                                          |
| Workbench        | Renderer (sandboxed Chromium) per window        | UI, Monaco editor, Three.js if any                              | Tau renderer (UI + 3D viz)                                    |
| Extension Host   | `utilityProcess` per window                     | Runs untrusted extensions; full Node API; isolated crash domain | **Tau kernel host**                                           |
| Shared Process   | `utilityProcess` (originally hidden window)     | Storage, telemetry, updates — singleton across windows          | Tau FS authority + cross-window cache                         |
| File Watcher     | child of Shared Process                         | I/O-bound, isolated lifecycle                                   | Tau FS watcher (already designed)                             |
| Language Servers | independent processes spawned by Extension Host | LSP server bins; one per language                               | Future: native simulation binaries spawned by Tau kernel host |
| Webviews         | sandboxed Chromium child of renderer            | Markdown preview, notebooks                                     | Future: secondary 3D viewers, MDX renderers                   |

Three transferable design rules from VS Code:

1. **Renderer ↔ Extension Host uses MessagePort directly, not main-mediated IPC.** Main creates the channel at bootstrap, hands ports to both sides, then is not on the hot path. Source: ext.protocol.ts uses a `MessagePort`.
2. **The Extension Host is RPC-defined.** All cross-process behaviour goes through a typed proxy contract (`extHost.protocol.ts` defines 60+ services). Tau's `RuntimeProtocol` is the same shape.
3. **The Extension Host moved from a hidden BrowserWindow to a `utilityProcess`** because the hidden-window approach used too much memory and had no need for Blink. Same logic applies to Tau's kernel: it does not need Blink, so it should not pay for a renderer process.

### Finding 14: Figma's pattern is in-process WASM in the renderer (different problem domain)

Figma is the canonical Electron app for heavy compute + 2D/3D rendering, but its architecture does _not_ match Tau's needs. Figma compiles its document model and renderer to WASM (via Emscripten) and runs them inside the renderer process, alongside the WebGL/WebGPU canvas (sources: [Figma blog: WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu); [Figma's Rendering Architecture](https://kaelan.fyi/research/figma-architecture/)).

Why this works for Figma and does not work for Tau:

| Dimension               | Figma                                                               | Tau                                                                                           |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Compute kernel          | C++ → WASM, single binary                                           | Multi-kernel runtime: Replicad, JSCAD, Manifold, OpenSCAD, KCL — and (future) native binaries |
| Native binaries needed? | No (server-side renders use the same C++)                           | Yes — native CAD libs (e.g. native OCCT) and simulation binaries                              |
| Renderer-thread compute | Acceptable (UI is event-driven, canvas runs at 60fps independently) | Heavy CAD eval can take seconds; would block renderer                                         |
| Multi-kernel hot-swap   | N/A                                                                 | Kernels are dynamically dispatched per file extension                                         |

Figma can stay in-process because it has one kernel and it never needs Node APIs. Tau cannot: native CAD/simulation binaries need Node, and concurrent kernel options (e.g. native OCCT vs WASM Replicad alongside each other) need crash isolation per kernel-host. So **Figma's "everything in the renderer" model is a reference for Tau's _renderer-side_ concerns** (WebGPU, OffscreenCanvas, tile rendering for 3D viz) **but not for the kernel architecture**.

### Finding 15: Browser-side topology — nested workers are supported but rarely needed for parity

The user asked whether the browser topology should mirror Electron's by having the Web Worker spawn a sub-worker for CAD computation, so the "main worker" stays unblocked.

**Browser support for nested dedicated workers:**

| Browser                          | Nested workers | Caveat                                                                                                                     |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Chromium 69+                     | yes            | `requestAnimationFrame` not supported in nested workers ([chromium #1510413](https://issues.chromium.org/issues/41483010)) |
| Safari 16.4+                     | yes            | full support per [WebKit PR #4349](https://github.com/WebKit/WebKit/pull/4349)                                             |
| Firefox                          | long-standing  | full support                                                                                                               |
| `SharedWorker` spawning workers  | not supported  | spec gap                                                                                                                   |
| `ServiceWorker` spawning workers | not supported  | spec gap                                                                                                                   |

So nested dedicated workers are uniformly available in Tau's supported browser matrix. The architectural question is whether they are _useful_.

**Argument for nested workers (browser parity with Electron):**

- Tau's Electron topology has three thread-equivalents: renderer (UI), utilityProcess (kernel host), and any nested `worker_threads` the kernel host spawns for CPU-intensive work.
- Mirroring this in the browser would mean: renderer (UI), Web Worker (kernel host with RPC handler), nested Web Worker (CPU-intensive eval).
- This keeps the kernel host's RPC loop responsive even during long renders.

**Argument against (current pattern is sufficient):**

- Tau's current Web Worker IS the kernel; there is no separate RPC-handler-vs-evaluator split. Every render runs to completion before the next RPC is processed, but the SAB-backed signal slot already provides cooperative cancel mid-render. Cancel is the only "interruption" the runtime needs to honour during a long render.
- Adding a nested worker introduces another `Port` boundary, another channel handshake, more `WithTransferables` hops, and another bundling target. The marginal cost is not zero.
- If a future kernel needs to fan out (e.g. parallel STEP imports), it can spawn _ad hoc_ Web Workers from inside the kernel without involving the runtime — the runtime sees a single kernel host either way.

**Recommendation:** parity is a desirable property, but pursued at the runtime layer (one `Port`, one `Channel`, two parties on the hot path) rather than the OS-thread layer. Browser stays Browser ↔ Web Worker (kernel). Electron becomes Renderer ↔ utilityProcess (kernel). Both topologies present the same two-party RPC shape to the runtime.

### Finding 16: OffscreenCanvas is a worthwhile rendering optimisation but orthogonal to the kernel-host topology

`OffscreenCanvas` lets a Web Worker render to a `<canvas>` directly via `transferControlToOffscreen()` ([Three.js manual](https://threejs.org/manual/en/offscreencanvas.html); [react-three-offscreen](https://github.com/pmndrs/react-three-offscreen)). For Tau's 3D viewer this could:

- Move Three.js animation frame work off the renderer's main thread
- Free the main thread for UI/Monaco/state machines
- Be enabled in Electron (renderer is just Chromium)

This is independent of kernel placement. The kernel produces glTF bytes; the bytes flow into a 3D-viewer worker; the 3D-viewer worker renders to the canvas. The kernel host never touches the canvas. So **OffscreenCanvas is a renderer-side optimisation**, not a transport-layer concern, and can be adopted in a separate research/implementation cycle without changing any RPC architecture.

### Finding 17: There is no production CAD app on Electron that uses native CAD library bindings end-to-end

Onshape is browser-only (REST API + WebGL); FreeCAD/Fusion/SolidWorks/Inventor are native-Qt or native-Win32 desktop apps with no Electron front-end. The "Onshape MCP" servers ([hedless/onshape-mcp](https://github.com/hedless/onshape-mcp), [altendky/onshape-mcp](https://github.com/altendky/onshape-mcp)) run in Python and proxy the REST API; "morphe" is a CAD-agnostic sketch interchange format with Python adapters.

**This is a structural opportunity for Tau.** No prior art constrains the design — Tau is plausibly the first Electron CAD app to host native CAD libraries inside `utilityProcess` and serve them to the renderer over a SAB-capable `MessagePort`. The architectural reference therefore must come from VS Code's process model rather than from any existing CAD app.

### Finding 18: Native addon loading inside `utilityProcess` is the cleanest path for native CAD/simulation binaries

`utilityProcess.fork(scriptPath)` runs a Node.js process. Native addons (`.node` files built with `node-addon-api` / N-API) can be `require()`'d inside that script. This is the same loading path used by VS Code's language servers (which are typically external Node processes) and by `electron-rebuild` consumers.

Concretely for Tau, a future native OCCT kernel would:

1. Build an N-API addon wrapping OCCT C++ (e.g. via cppyy-style bindings or hand-written N-API)
2. Ship the addon as `<package>/build/Release/occt-native.node` per platform
3. `require('./occt-native.node')` from the kernel host script that `utilityProcess.fork` runs
4. Expose an OCCT JS facade implementing the same kernel contract as the WASM Replicad path
5. Register both in the runtime; consumer picks via the existing kernel-id selector

ASAR unpacking caveat: the addon path must be in `asarUnpack` in the electron-builder config so the dynamic linker can `dlopen` the file. This is well-trodden ground for VS Code, Slack, etc.

The capability profile of a native-OCCT kernel host is identical to a WASM-Replicad kernel host from the runtime's perspective: same `Port`, same `Channel`, same `RuntimeProtocol`. The only difference is which `.node` and which JS wrapper get loaded inside the host process.

### Finding 19: The renderer is the right home for Tau's 3D viewer; the kernel host is the right home for everything else

The user's framing — "do all 3d visualization in the electron renderer, and most efficiently pass the computed 3d file from the kernel runner to the main electron thread and back to the renderer" — embeds an assumption that the route must traverse main. Findings 10–11 invalidate that assumption: the main process should never see the geometry blob. The right route is:

```
kernel host (utilityProcess) → renderer (over relayed MessagePort, SAB-pooled) → 3D viewer
                                                                                  │
                                                                                  ├─ on main UI thread (current)
                                                                                  └─ in OffscreenCanvas worker (future)
```

Main only handles the bootstrap channel handshake and OS-level concerns. This is a strict superset of VS Code's pattern and the only Electron topology that gives the runtime a SAB-capable wire to the kernel.

### Finding 20: VS Code's FS architecture — per-process local instances, main as the renderer's IPC endpoint, disk as the source of truth

A direct read of `repos/vscode` confirms a layered pattern very different from the "one canonical FS authority" model my first FS hypothesis assumed. The same `DiskFileSystemProvider` Node class (`src/vs/platform/files/node/diskFileSystemProvider.ts`, 898 lines) is instantiated independently in **every Node-capable process**, and there is no cross-process FS RPC for state coordination — the disk is the source of truth and changes propagate via watcher events.

**The five process roles VS Code defines:**

| Process                                       | Holds `fs`?        | `file://` provider                                                                                                                                   | How it touches disk                                                                                                                                             | Watches files?                                                                                                                      |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Main (Electron)                               | yes                | real `DiskFileSystemProvider` + `DiskFileSystemProviderChannel` IPC server (`src/vs/platform/files/electron-main/diskFileSystemProviderServer.ts`)   | direct via Node `fs`                                                                                                                                            | non-recursive only; **rejects recursive** (`'Recursive file watching is not supported from main process for performance reasons.'`) |
| Renderer (sandboxed)                          | no                 | passthrough proxy → main IPC channel `LOCAL_FILE_SYSTEM_CHANNEL_NAME` (`src/vs/workbench/services/files/electron-browser/diskFileSystemProvider.ts`) | indirect, every call IPCs to main                                                                                                                               | delegates to dedicated `file-watcher` utility process                                                                               |
| Extension Host (`utilityProcess`, per window) | yes                | real `DiskFileSystemProvider` (local instance, **no IPC to main**) (`src/vs/workbench/api/node/extHostDiskFileSystemProvider.ts`)                    | direct via Node `fs` — _"Register disk file system provider so that certain file operations can execute fast within the extension host without roundtripping."_ | not implemented; throws on `watch()`                                                                                                |
| File Watcher (`utilityProcess`, per window)   | yes (watcher only) | n/a                                                                                                                                                  | n/a                                                                                                                                                             | yes — Parcel + Node `fs.watch`                                                                                                      |
| Shared Process (`utilityProcess`, singleton)  | yes                | real `DiskFileSystemProvider` (local)                                                                                                                | direct via Node `fs`                                                                                                                                            | n/a                                                                                                                                 |

**Three architectural rules.**

1. **The renderer cannot touch disk** because it is sandboxed, so it runs a passthrough provider whose every method (`stat`, `readFile`, `writeFile`, `readdir`, `mkdir`, `delete`, `rename`, `copy`, `cloneFile`, `open`/`read`/`write`/`close`) is `return this.provider.<method>(...)` against a `DiskFileSystemProviderClient` connected to main's channel. **No fast path** — the renderer pays an IPC hop for every disk byte. By design.

2. **Every other Node-capable process owns a local `DiskFileSystemProvider`** and reads/writes disk directly. They do not coordinate with main and they do not coordinate with each other — they hit `fs` and trust the OS for atomicity. The Extension Host's local provider is explicitly justified as a perf shortcut: _"so that certain file operations can execute fast within the extension host without roundtripping."_

3. **Watching is split out of every other process** into a dedicated `utilityProcess` per renderer window. The renderer subscribes via a `MessagePort` to that watcher process. Main explicitly refuses recursive watching with an error, and the Extension Host's local provider explicitly throws on `watch()`. Coordination — when the Extension Host writes a file and the renderer needs to refresh — happens via the watcher fanning the change event back to subscribers, **not** via cross-process FS RPC.

**The mapping for Tau (Topology C):**

| Tau process                                   | Local FS instance?                                                           | FS server?                                                                | FS proxy?                                                                                                                     | Watches?                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Renderer (sandboxed Chromium)                 | no                                                                           | no                                                                        | yes — `fromPort(fsPort)` proxy to main over renderer↔main `MessageChannelMain` (low-cap wire, `wrapElectronCrossProcessPort`) | subscribes via kernel↔renderer port                                                                     |
| Main (Electron)                               | yes — `fromNodeFs(...)`                                                      | yes — `RuntimeFileSystemBridge` server attached to the renderer↔main wire | no                                                                                                                            | no                                                                                                      |
| Kernel-host utility (one per `RuntimeClient`) | yes — `fromNodeFs(...)` (local instance, **no IPC to main on the hot path**) | no (kernel uses local instance directly)                                  | no                                                                                                                            | yes — `FilesystemObserverBridge` for v1; pushes change events to renderer over the kernel↔renderer port |

**Why not push everything through main, like VS Code does for the renderer?** Because Tau's kernel host is itself a Node-capable process — the analog of VS Code's Extension Host, which uses a local instance precisely to avoid IPC roundtrips on its hot path. Tau's kernel render path reads source files, parameter overrides, and dependency manifests on every render; routing that through main would re-introduce the wire that Topology C exists to escape from.

**Why not push everything through the kernel host?** Because the renderer also originates FS work (file tree expansion, project save, parameter-group edits) that has no business waiting on a kernel render. Renderer↔main is the right wire for that traffic — small, control-plane, and main is naturally always running.

**Why not coordinate writes via cross-process RPC?** Because no production Electron-on-heavy-compute architecture does. VS Code does not, and Tau's per-`RuntimeClient` workspace scoping (each utility process is bounded to a single project tree) makes write contention vanishingly rare. The disk plus the watcher fan-out is the coordination mechanism.

**Watcher placement for v1.** VS Code splits watching out only because monorepo workspaces routinely watch tens of thousands of files. Tau's per-project scope is small enough that one less utility process is the right v1 trade-off; we co-locate watching with the kernel host and push change events to the renderer over the existing kernel↔renderer port. We can split it out later by mirroring VS Code's `forceUniversal: true` pattern if a CPU smell appears.

This is **Q1-D** — the fourth option, distinct from the original A/B/C choices, and the resolution adopted by this blueprint.

## Backplane Inventory

A consolidated reference for which backplanes carry what kind of data on which Electron wire. This is the single source of truth that the runtime's capability declarations should honour.

| Wire                                                           | `MessagePort` transfer | `ArrayBuffer` transfer                      | `SharedArrayBuffer` clone | Structured clone (cloneable) | Sync RPC                                   |
| -------------------------------------------------------------- | ---------------------- | ------------------------------------------- | ------------------------- | ---------------------------- | ------------------------------------------ |
| Browser main thread ↔ Web Worker                               | yes                    | yes                                         | yes (with COOP/COEP)      | yes                          | no                                         |
| Browser Web Worker ↔ nested Web Worker                         | yes                    | yes                                         | yes                       | yes                          | no                                         |
| Node main thread ↔ `worker_threads.Worker`                     | yes                    | yes                                         | yes                       | yes                          | no                                         |
| Electron renderer ↔ Web Worker (in renderer)                   | yes                    | yes                                         | yes (with COOP/COEP)      | yes                          | no                                         |
| Electron main ↔ `worker_threads.Worker` (in main)              | yes                    | yes                                         | yes                       | yes                          | no                                         |
| Electron renderer ↔ main via `ipcRenderer.invoke`/`send`       | n/a                    | no (silent failure / null data #34905)      | no (#50291, #25446)       | yes (small)                  | only `sendSync` (deprecated for hot paths) |
| Electron renderer ↔ main via `MessageChannelMain`              | yes (port-only)        | no (#34905, segfault per #37565)            | no                        | yes                          | no                                         |
| Electron main → renderer via `webContents.postMessage`         | yes (port-only)        | **yes** (one-way only)                      | no                        | yes                          | no                                         |
| Electron renderer ↔ renderer via relayed `MessagePort`         | yes                    | **yes**                                     | **yes**                   | yes                          | no                                         |
| Electron renderer ↔ `utilityProcess` via relayed `MessagePort` | yes                    | **yes**                                     | **yes**                   | yes                          | no                                         |
| Electron `utilityProcess` ↔ main via `process.parentPort`      | yes (port-only)        | likely no (same Mojo pipe as renderer↔main) | no                        | yes                          | no                                         |
| `MessagePort` over native addon shared memory                  | n/a                    | yes (zero-copy via mmap)                    | n/a (same memory)         | n/a                          | depends on addon                           |
| WebRTC `RTCDataChannel`                                        | no                     | yes (via separate API)                      | no                        | yes                          | no                                         |

Three rules fall out of the inventory:

1. **The fast cross-process path in Electron is renderer↔renderer and renderer↔utility relayed `MessagePort`s.** Everything else is either copy-only or one-direction.
2. **`SharedArrayBuffer` always works on the fast paths.** It only fails on the renderer↔main wire because main has no Blink context.
3. **Tau's existing capability bits already model this correctly** if the proposed `messagePortTransfer` / `arrayBufferTransfer` / `sharedArrayBufferClone` split (R1) is adopted. The wire adapter declares the truth; the runtime does the right thing.

## Topology Comparison

For each plausible topology, this section evaluates how well it satisfies Tau's stated goals: heavy CAD with native binaries + WASM, heavy simulations, 3D visualization in the renderer, and efficient geometry transport.

### Topology A — Renderer ↔ Main ↔ `worker_threads` kernel (current PoC)

```
┌──────────────┐  MessageChannelMain  ┌──────────────┐  worker_threads  ┌──────────────┐
│  Renderer    │ ────────────────────▶│  Main        │ ────────────────▶│  Kernel      │
│  (UI + 3D)   │ ◀────────────────────│  (relay)     │ ◀────────────────│  (worker_th.)│
└──────────────┘                       └──────────────┘                  └──────────────┘
```

| Aspect                                 | Verdict                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Native binaries                        | OK — main can load addons; kernel runs in a thread of main, also can load addons (through main) |
| WASM kernels                           | OK — Node `worker_threads` runs WASM fine                                                       |
| 3D viz in renderer                     | Forced to copy every render across the broken renderer↔main wire                                |
| SAB-backed geometry pool               | **Broken** — SAB cannot cross renderer↔main per #50291                                          |
| Crash isolation of kernel              | Weak — `worker_threads` crash can destabilise main                                              |
| Main thread responsiveness             | Risky — main process orchestrates EVERY message hop on the hot path                             |
| Topology party count from runtime view | 3 (Renderer is RPC client, Main is wire forwarder, kernel is RPC server)                        |
| Browser parity                         | None                                                                                            |
| Verdict                                | Architecturally weakest; the wire choice is the root cause of the current PoC failure           |

### Topology B — Renderer + in-renderer Web Worker (kernel) | Main as FS authority

```
┌──────────────────────────────────┐  MessageChannelMain  ┌──────────────┐
│  Renderer process                │ ────────────────────▶│  Main        │
│  ┌────────────┐  Web Worker port │ ◀────────────────────│  (FS server) │
│  │  UI + 3D   │◀──── SAB ────────┐                       └──────────────┘
│  └────────────┘                  │
│  ┌──────────────────────────────┐│
│  │  Kernel (Web Worker)         ││
│  └──────────────────────────────┘│
└──────────────────────────────────┘
```

| Aspect                                 | Verdict                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Native binaries                        | **Limited** — Web Workers cannot load Node addons; would need to RPC to main or to a utility process for native ops |
| WASM kernels                           | OK — Web Worker runs WASM fine                                                                                      |
| 3D viz in renderer                     | Excellent — kernel and viewer share a process; SAB pool flows direct                                                |
| SAB-backed geometry pool               | OK — within renderer process                                                                                        |
| Crash isolation of kernel              | Weak — kernel crash can destabilise renderer                                                                        |
| Main thread responsiveness             | OK — main is only on the FS hot path, which is small                                                                |
| Topology party count from runtime view | 2                                                                                                                   |
| Browser parity                         | **Maximal** — same code path as the existing browser topology                                                       |
| Verdict                                | Best for browser parity and SAB; loses native binary access for kernels                                             |

### Topology C — Renderer ↔ `utilityProcess` (kernel) with main-mediated bootstrap (recommended)

```
                  bootstrap  ┌──────────────┐  spawn      ┌─────────────────────┐
                   ─────────▶│  Main        │────────────▶│  utilityProcess     │
                             │  (channel    │             │  (kernel host:      │
                             │   forwarder) │             │   WASM + native     │
                             │              │             │   addons)           │
                             └──────────────┘             └─────────────────────┘
                                    │                            ▲
                                    │ webContents.postMessage    │ direct MessagePort
                                    ▼ port relay (one time)      │ (SAB + ArrayBuffer
┌──────────────────────────────────┐                              │  transfer; bypasses
│  Renderer process                │──────────────────────────────┘  main on hot path)
│  ┌────────────┐                  │
│  │  UI + 3D   │◀──── SAB ────────┐
│  └────────────┘                  │
└──────────────────────────────────┘
```

| Aspect                                 | Verdict                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Native binaries                        | **Excellent** — utility process has full Node API; loads `.node` addons natively                            |
| WASM kernels                           | Excellent — utility process runs Node WASM with no constraint                                               |
| 3D viz in renderer                     | Excellent — SAB pool reaches renderer over the direct relayed `MessagePort`                                 |
| SAB-backed geometry pool               | **Works** — renderer↔utility wire carries SAB end-to-end (Finding 10)                                       |
| Crash isolation of kernel              | Excellent — utility process crash is isolated from main and renderer                                        |
| Main thread responsiveness             | Excellent — main is only on the cold path (bootstrap, lifecycle)                                            |
| Topology party count from runtime view | 2 (Renderer is RPC client, utility process is RPC server; main is invisible to the runtime after bootstrap) |
| Browser parity                         | **Perfect** — runtime sees a 2-party `MessagePort` topology in both browser and Electron                    |
| Verdict                                | **Recommended for Tau.** Matches VS Code's Extension Host architecture; satisfies all four goals            |

### Topology D — Hidden BrowserWindow (kernel host)

```
┌──────────────┐  webContents.postMessage  ┌──────────────────┐
│  Main        │ ◀────────── port ──────── │  Hidden Window   │
└──────────────┘                            │  (kernel)        │
       │ port relay (one time)             │  + Blink         │
       ▼                                    └──────────────────┘
┌──────────────────────────────────┐               ▲
│  Renderer process                │               │ direct MessagePort
│  ┌────────────┐                  │               │ (SAB works)
│  │  UI + 3D   │◀──── SAB ────────────────────────┘
│  └────────────┘                  │
└──────────────────────────────────┘
```

| Aspect                                 | Verdict                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native binaries                        | OK if `nodeIntegration` enabled (security smell)                                                                                                                                                                                |
| WASM kernels                           | OK                                                                                                                                                                                                                              |
| 3D viz in renderer                     | OK — same wire as Topology C                                                                                                                                                                                                    |
| SAB-backed geometry pool               | OK — same wire as Topology C                                                                                                                                                                                                    |
| Crash isolation of kernel              | OK                                                                                                                                                                                                                              |
| Main thread responsiveness             | OK                                                                                                                                                                                                                              |
| Topology party count from runtime view | 2                                                                                                                                                                                                                               |
| Browser parity                         | High                                                                                                                                                                                                                            |
| Memory cost                            | Highest — full Chromium renderer for a kernel that does not need Blink                                                                                                                                                          |
| Verdict                                | Used to be the canonical pattern (VS Code's pre-2022 Extension Host) but `utilityProcess` strictly dominates it now. Only justifiable if the kernel needs Blink-specific APIs (canvas, fetch, audio) which Tau's kernels do not |

### Topology E — Nested Web Workers in browser (Web Worker → sub-Web Worker for kernel)

```
┌────────────────────────────────────────────────────────────────────┐
│  Renderer / Browser tab                                            │
│  ┌────────────┐  port  ┌────────────────┐  port  ┌────────────────┐│
│  │  UI + 3D   │───────▶│  Worker        │───────▶│  Sub-Worker    ││
│  │            │◀──SAB──│  (orchestrator,│◀──SAB──│  (kernel eval) ││
│  └────────────┘        │   RPC server)  │        └────────────────┘│
│                        └────────────────┘                          │
└────────────────────────────────────────────────────────────────────┘
```

| Aspect                                 | Verdict                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser support                        | Yes (Chromium 69+, Safari 16.4+, Firefox)                                                                                                                                                                                                                                        |
| Native binaries                        | No (browser has no native addon path)                                                                                                                                                                                                                                            |
| 3D viz in renderer                     | OK                                                                                                                                                                                                                                                                               |
| SAB                                    | OK — single process                                                                                                                                                                                                                                                              |
| Topology party count from runtime view | 3 if the orchestrator is itself an RPC node, 2 if the orchestrator just forwards                                                                                                                                                                                                 |
| Mirrors Electron parity?               | Only if Electron is Topology A; useless if Electron is Topology C                                                                                                                                                                                                                |
| Verdict                                | **Not worth pursuing**. Adds a worker hop without clear benefit; the kernel-vs-runner split it would create is already handled by the kernel's own internal architecture (kernels can spawn `Worker` instances themselves for parallel evaluation without involving the runtime) |

### Recommendation matrix

| Goal                                          | Topology                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tau on browser today                          | Browser ↔ Web Worker (kernel) — unchanged                                                              |
| Tau on Electron, current PoC                  | A (broken)                                                                                             |
| Tau on Electron, recommended                  | **C** (Renderer ↔ utilityProcess kernel host with main-mediated bootstrap)                             |
| Future Tau native CAD/simulation kernel       | **C** with native addon inside the utility process                                                     |
| Future Tau on a server-rendered headless mode | Renderer-less; runtime client connects directly to utilityProcess host over the same `MessagePort` API |

## Resolved Decisions

A canonical record of the twelve open questions identified after Topology C was adopted, with the resolution that drives the recommendations below. Future planning should treat these as binding unless a follow-up research doc supersedes them.

| OQ    | Question                                                                                                  | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                     | Source     |
| ----- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| OQ-1  | Where does FS authority live in Topology C?                                                               | **Q1-D — VS Code-style layered FS.** Each Node-capable process holds its own local `fromNodeFs(...)` instance; main exposes its instance via `RuntimeFileSystemBridge` over the renderer↔main wire so the sandboxed renderer can drive file-tree/project work; the kernel-host utility uses its local instance for direct hot-path reads/writes; watching co-locates with the kernel host for v1. Disk is the source of truth. | Finding 20 |
| OQ-2  | How do `webWorkerRunner` (R5 in v1) and Topology C (R13 in v1) reconcile?                                 | **Delete the old R5 outright.** `webWorkerRunner` is the runner for browser-only apps; the Electron PoC uses Topology C (utilityProcess) and never touches `webWorkerRunner`.                                                                                                                                                                                                                                                  | Q2         |
| OQ-3  | What does the runtime do when the consumer's adapter declares less than the runtime's default tier wants? | **Throw `MissingCapabilityError` only when the consumer explicitly requested the missing feature.** Otherwise the runtime silently picks the best tier the wire actually supports (e.g. no `sharedArrayBufferClone` → fall back to wire-frame cancel + copy delivery without an error).                                                                                                                                        | Q3         |
| OQ-4  | Where do the Electron port adapters live?                                                                 | **`examples/electron-tau/src/main/electron-port-adapters.ts`** for the PoC. Move into a `@taucad/electron` companion package once the concept is proven (deferred).                                                                                                                                                                                                                                                            | Q4         |
| OQ-5  | How many adapters, and how do they declare capabilities?                                                  | **Two adapters with fixed capabilities, named after the wire kind.** `wrapElectronUtilityPort` (full caps — kernel wire) and `wrapElectronCrossProcessPort` (low caps — any renderer↔main FS / control-plane wire). Capabilities are hard-coded constants, not negotiated.                                                                                                                                                     | Q5         |
| OQ-6  | How many `utilityProcess`es per renderer?                                                                 | **One `utilityProcess` per `RuntimeClient`.** Tau spawns multiple `RuntimeClient`s when multiple `cad.machine` instances render concurrently (one per geometry-unit pane), so this is "one utility per pane" in practice. Optimise later if the per-window memory cost becomes a problem.                                                                                                                                      | Q6         |
| OQ-7  | What happens to the kernel utility on crash?                                                              | **Defer.** Surface `child.on('exit')` to the runtime as a typed disconnect event for v1; respawn/retry policy is out of PoC scope.                                                                                                                                                                                                                                                                                             | Q7         |
| OQ-8  | Where does the kernel-host script live?                                                                   | **`examples/electron-tau/src/main/kernel-host.ts`** for the PoC. Same package-extraction follow-up as OQ-4.                                                                                                                                                                                                                                                                                                                    | Q8         |
| OQ-9  | When do we add native N-API CAD addons?                                                                   | **Defer.** Tau has no native addons today; Topology C is sized so a future native kernel host slots in unchanged (Finding 18 stays canonical, but R-list demotes to follow-up).                                                                                                                                                                                                                                                | Q9         |
| OQ-10 | What is the conformance-test fidelity for the new wires?                                                  | **Both.** Vitest unit tests for the runtime's capability-gating logic against mock `Port`s with each capability bit toggled (T5), AND a Playwright e2e test that drives the real Electron PoC end-to-end against `wrapElectronUtilityPort` + `wrapElectronCrossProcessPort` (T6).                                                                                                                                              | Q10        |
| OQ-11 | What if a peer omits `lh.d.capabilities` at handshake?                                                    | **Hard reject** the connection with `IncompatibleHandshakeError`. No backwards-compat fallback. The capability ledger is mandatory once R1 lands.                                                                                                                                                                                                                                                                              | Q11        |
| OQ-12 | How does the `PortCapabilities` rename roll out?                                                          | **Hard break in one PR.** Rename `transfer → arrayBufferTransfer`, `sab → sharedArrayBufferClone`, delete the old keys, no aliases, no deprecation warnings. All call sites migrated atomically.                                                                                                                                                                                                                               | Q12        |

## The Eigenquestion

> **What is the smallest invariant the runtime can express such that, for every transport a consumer could plausibly plug in, the runtime always picks a delivery tier the wire actually supports — without the runtime ever knowing the transport's name?**

Restated as a contract: _the runtime's behaviour must be a pure function of `Port.capabilities`._ Anything that is not a function of `Port.capabilities` is, by definition, a hidden environmental assumption that will eventually break in a transport the runtime does not yet know about.

This collapses three superficially-distinct questions into one:

1. "How do we make the Electron PoC work?" → declare Electron's true capabilities and the runtime stops trying to push SAB and ArrayBuffer through `MessageChannelMain`.
2. "How do we keep the browser/Node topologies fast?" → those Ports declare richer capabilities and the runtime keeps using SAB pooling and zero-copy transfer.
3. "How do we add a future remote/network transport?" → it declares its capabilities (likely `{}` — no SAB, no transfer), the runtime falls back to fully cloneable wire, the consumer pays the copy cost knowingly.

The runtime is the same code in all three cases.

## Recommendations

The recommendations are grouped by the role they play in the blueprint. **PoC Required** items must all land before the Topology C e2e PoC can be declared green; **PoC Hardening** items raise the PoC from working to production-quality; **Deferred** items are explicitly out of PoC scope and captured here so the design absorbs them later without breaking.

### PoC Required (P0 — must land for green Topology C e2e)

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Effort | Resolves   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| R1  | **Hard-rename `PortCapabilities` keys in one PR, no aliases.** Replace `transfer` with `arrayBufferTransfer`, replace `sab` with `sharedArrayBufferClone`, add `messagePortTransfer`. Each key is `readonly bool \| undefined`. Migrate every call site atomically — the field set is the new contract. JSDoc each key with its precise semantic and the single Electron upstream issue it tracks.                                                                                                                                                                                                                                                                                                                                                 | M      | OQ-12      |
| R2  | **Capability gating with explicit-request semantics in `RuntimeWorkerClient.initialize()`.** Read `this.channel.port.capabilities` (post-handshake — see R3) and assemble `memoryHandle`/`transferables` strictly from what the wire supports. Throw `MissingCapabilityError(feature, requestedBy)` only when the consumer explicitly requested the feature (e.g. passed `sharedMemory: { geometry: { capacity } }` on a wire with `sharedArrayBufferClone: false`); otherwise silently fall back to the next-best tier and surface the choice via the `descriptor` for telemetry.                                                                                                                                                                 | M      | OQ-3       |
| R3  | **Mandatory handshake capability advertisement.** `lh.d` adopts the normative shape `{ peer?: string; capabilities: PortCapabilities }` — the `capabilities` field is required. `RuntimeWorkerClient` AND-merges local (`port.capabilities`) and remote (`lh.d.capabilities`) into a single negotiated `Port.capabilities` exposed as `channel.port.capabilities` for the rest of the runtime to read. If either side omits `lh.d.capabilities` at handshake, reject `channel.ready` with `IncompatibleHandshakeError`. Land alongside R1 so peers cannot mismatch on the rename.                                                                                                                                                                  | M      | OQ-11      |
| R4  | **`wrapElectronUtilityPort` adapter** in `examples/electron-tau/src/main/electron-port-adapters.ts`. Wraps a `MessagePort` whose far end is a `utilityProcess` (renderer side via main-mediated relay; utility side via `process.parentPort`). Declares the fixed capability set `{ messagePortTransfer: true, arrayBufferTransfer: true, sharedArrayBufferClone: true, signalSlot: true, pool: true }` — identical to a browser `Worker` `MessagePort`.                                                                                                                                                                                                                                                                                           | S      | OQ-4, OQ-5 |
| R5  | **`wrapElectronCrossProcessPort` adapter** in the same file. Wraps any renderer↔main `MessagePort` (FS bridge, future control planes). Declares the fixed capability set `{ messagePortTransfer: true, arrayBufferTransfer: false, sharedArrayBufferClone: false, signalSlot: false, pool: false }`. Used exclusively for control-plane traffic; the runtime's gating logic (R2) automatically prevents bulk geometry from being scheduled here.                                                                                                                                                                                                                                                                                                   | S      | OQ-4, OQ-5 |
| R6  | **Adopt Topology C as the only Electron kernel placement Tau ships.** Kernel runs inside a `utilityProcess` spawned by main; renderer↔kernel traffic crosses a main-mediated `MessageChannelMain`; main is on the hot path for zero messages after bootstrap. **One `utilityProcess` per `RuntimeClient`** — Tau spawns multiple clients when multiple `cad.machine` instances render concurrently (one per geometry-unit pane), so each pane gets its own utility process. Per-`RuntimeClient` lifecycle ties the utility to `client.disconnect()`.                                                                                                                                                                                               | M      | OQ-6       |
| R7  | **VS Code-style layered FS (Q1-D).** Stand up three FS instances per `RuntimeClient`: (a) main holds a local `fromNodeFs(...)` exposed to the renderer via `RuntimeFileSystemBridge` server attached to a renderer↔main `MessageChannelMain` wrapped by `wrapElectronCrossProcessPort`; (b) the kernel-host utility process holds its own local `fromNodeFs(...)` instance and the kernel reads/writes via this local instance with zero IPC hops on the render hot path; (c) the renderer holds a `fromPort(fsPort)` proxy that talks to main. **No cross-process FS RPC for state coordination** — disk is the source of truth.                                                                                                                  | M      | OQ-1       |
| R8  | **`createElectronKernelChannel({ window, scriptPath })` bootstrap helper** in `examples/electron-tau/src/main/create-electron-kernel-channel.ts`. Per call: `utilityProcess.fork(scriptPath)`, await `'spawn'`, create one `MessageChannelMain` for the kernel wire and one for the FS wire, post the kernel utility-side port to the child via `child.postMessage({ type: 'kernel-port' }, [port1])`, post the kernel renderer-side port via `window.webContents.postMessage('kernel-port', null, [port2])`, post the FS renderer-side port via `window.webContents.postMessage('fs-port', null, [fsPort])`, attach the `RuntimeFileSystemBridge` server to the FS main-side port. Returns `{ child }`; lifecycle is bound to `child.on('exit')`. | S      | OQ-1, OQ-7 |
| R9  | **Kernel-host script** at `examples/electron-tau/src/main/kernel-host.ts`. Uses `process.parentPort.once('message', e => e.ports[0])` to acquire the kernel `MessagePortMain`, wraps it via the runtime's `wrapMessagePort`, instantiates a local `fromNodeFs(...)`, and calls `createKernelWorkerHost({ port, fileSystem })`. The script ends as a long-running Node process owned by the utility.                                                                                                                                                                                                                                                                                                                                                | S      | OQ-1, OQ-8 |
| R10 | **Watching co-located with the kernel-host utility for v1.** Reuse the existing `FilesystemObserverBridge` from `packages/filesystem`; expose change events to the renderer over the kernel↔renderer port (the runtime already has the protocol surface for this). Document `forceUniversal: true`-style splitting into a dedicated watcher utility as a follow-up trigger if a CPU smell emerges.                                                                                                                                                                                                                                                                                                                                                 | S      | OQ-1       |
| R11 | **Preload relay update.** Preload listens for `webContents.postMessage` on `'kernel-port'` and `'fs-port'`, then re-emits via `window.postMessage(tag, '*', [port])` so the renderer main world receives genuine `MessagePort` objects (Electron #27024 workaround, already in PoC). Renderer awaits both tags, calls `port.start()` on each, and constructs the `RuntimeClient` with both ports.                                                                                                                                                                                                                                                                                                                                                  | S      | OQ-1       |

### PoC Hardening (P1 — must land before declaring the PoC production-ready)

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Effort | Resolves |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| R12 | **Vitest unit conformance row T5.** `packages/rpc/src/topology-conformance.test.ts` adds a row that constructs mock `Port`s with each capability bit toggled (16 combinations of the 5 bits, pruned to the 7 reachable ones) and asserts the runtime's tier selection, error path, and descriptor reporting are correct. Runs in regular CI.                                                                                                                | M      | OQ-10    |
| R13 | **Playwright e2e conformance row T6.** New e2e in `examples/electron-tau` that drives the real Topology C bootstrap end-to-end against `wrapElectronUtilityPort` + `wrapElectronCrossProcessPort`, asserts `client.connect()` resolves, asserts a render produces SAB-pooled geometry that the renderer materialises, and asserts an FS write through the renderer is observed by the kernel host via the watcher. Gated on `pnpm nx e2e example-electron`. | M      | OQ-10    |
| R14 | **Capability-negotiation prose** in `docs/architecture/rpc-wire-spec.md`. Document the post-R3 normative `lh.d` shape, the AND-merge semantic, and the `IncompatibleHandshakeError` failure mode. Cross-link from `runtime-channel-blueprint-v5.md`.                                                                                                                                                                                                        | S      | OQ-11    |
| R15 | **Capability-driven gating policy.** Fold the rule "all runtime decisions that depend on transport capability MUST be a pure function of `Port.capabilities`; no environment sniffing" into `docs/policy/library-api-policy.md`. Reference the eigenquestion section of this doc.                                                                                                                                                                           | S      | OQ-3     |
| R16 | **Topology decision matrix** in `docs/research/electron-ipc-gap-analysis.md` so future contributors find the decision tree without re-reading this 1k-line doc. Six rows: A/B/C/D/E plus the Tau choice.                                                                                                                                                                                                                                                    | S      | —        |

### Deferred (P3 — explicitly out of PoC scope, captured for follow-up planning)

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                         | Trigger to revisit                                                         | Resolves   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------- |
| R17 | **Move adapters and bootstrap helper into `@taucad/electron` companion package.** Once Topology C is proven by green Playwright e2e, extract `wrapElectronUtilityPort`, `wrapElectronCrossProcessPort`, `createElectronKernelChannel`, and `kernel-host.ts` into a versioned package consumable by third-party Electron+Tau apps. Until then, they live in `examples/electron-tau`.                                                            | After R12+R13 pass in CI                                                   | OQ-4, OQ-8 |
| R18 | **Lifecycle respawning for the kernel `utilityProcess`.** v1 surfaces `child.on('exit')` to the runtime as a typed disconnect event; the consumer's `RuntimeClient` reports a terminal `'errored'` lifecycle state and the user must reload. Defer auto-respawn / crash-bounded retry until a real crash is observed.                                                                                                                          | First production crash report                                              | OQ-7       |
| R19 | **Native N-API CAD kernel host.** Build a future native OCCT (or other) kernel as an N-API addon, vendor per-platform prebuilds under `packages/<kernel>/native/<platform-arch>/<addon>.node`, add to `asarUnpack` in the consumer's `electron-builder` config, `require()` from the kernel-host script. The runtime needs zero changes — same `defineKernel` contract. Document under `docs/research/native-cad-kernel-host.md` when started. | Native-binary kernel prioritised                                           | OQ-9       |
| R20 | **`OffscreenCanvas` 3D viewer.** Move Three.js animation-frame work off the renderer main thread by `transferControlToOffscreen()`-ing the canvas to a dedicated viewer worker. Independent of transport; affects renderer-side rendering only. Track in `docs/research/offscreen-canvas-3d-viewer.md` when prioritised.                                                                                                                       | UI thread cost shows up in profiles                                        | —          |
| R21 | **Browser-side nested workers (Topology E).** Explicit non-goal: kernel-internal parallelism is the kernel's concern, not the runtime's. The kernel can spawn `Worker` instances inside its host process without involving the runtime. Add as a normative non-goal to `docs/policy/xstate-policy.md` (or runtime conventions doc).                                                                                                            | Never (unless a future kernel demands runtime visibility into sub-workers) | —          |
| R22 | **Dedicated `file-watcher` utility process** mirroring VS Code's `forceUniversal: true` pattern. Trigger only if the kernel-host utility's CPU profile shows watching dominating render-eval time, or if a future feature needs cross-window watch coalescing.                                                                                                                                                                                 | Watching CPU > 10% of utility budget                                       | OQ-1       |

## PoC Scope

A concrete checklist for "Topology C PoC complete". The PoC is declared green when every box below ships and `pnpm nx e2e example-electron` runs end-to-end without flake on the matrix `{ macOS-arm64, macOS-x64, Linux-x64, Windows-x64 }`.

### Runtime layer (`@taucad/rpc` + `@taucad/runtime`)

- [ ] R1 — `PortCapabilities` renamed in one PR; all call sites migrated; tsgo green; tests passing
- [ ] R2 — `RuntimeWorkerClient.initialize()` consults negotiated `port.capabilities`; `MissingCapabilityError` thrown only on explicit-request mismatch; otherwise silent fallback with descriptor reporting
- [ ] R3 — `lh.d.capabilities` mandatory; AND-merge in handshake; `IncompatibleHandshakeError` on omission

### Consumer wiring (`examples/electron-tau`)

- [ ] R4 — `wrapElectronUtilityPort` adapter in `electron-port-adapters.ts`
- [ ] R5 — `wrapElectronCrossProcessPort` adapter in `electron-port-adapters.ts`
- [ ] R6 — Topology C: one `utilityProcess` spawned per `RuntimeClient`; lifecycle bound to `client.disconnect()`
- [ ] R7 — Layered FS: main holds local `fromNodeFs` exposed via `RuntimeFileSystemBridge`; kernel-host utility holds its own local `fromNodeFs` for direct disk access; renderer holds `fromPort(fsPort)` proxy
- [ ] R8 — `createElectronKernelChannel({ window, scriptPath })` bootstrap helper opens both kernel and FS `MessageChannelMain` pairs and relays both ports to the renderer via preload
- [ ] R9 — Kernel-host script `kernel-host.ts` acquires `MessagePortMain` from `process.parentPort`, wraps with `wrapMessagePort`, instantiates local `fromNodeFs`, calls `createKernelWorkerHost`
- [ ] R10 — `FilesystemObserverBridge` co-located with kernel host; change events propagate to renderer over the kernel↔renderer port
- [ ] R11 — Preload `window.postMessage` relay forwards both `'kernel-port'` and `'fs-port'`; renderer calls `port.start()` on both before `client.connect()`

### Conformance & docs

- [ ] R12 — Vitest T5 row: capability-bit matrix in `topology-conformance.test.ts`
- [ ] R13 — Playwright T6 row: real Electron e2e drives connect → render → SAB-pooled geometry → renderer materialise → FS write → watcher fan-out
- [ ] R14 — `docs/architecture/rpc-wire-spec.md` updated with `lh.d.capabilities` normative shape and AND-merge semantic
- [ ] R15 — Capability-driven gating policy added to `docs/policy/library-api-policy.md`
- [ ] R16 — Topology matrix in `docs/research/electron-ipc-gap-analysis.md`

### Explicitly NOT in PoC scope

- Lifecycle respawn (R18): exit → terminal `'errored'`; user reloads
- Native N-API kernel (R19): no native binaries planned for v1
- `OffscreenCanvas` 3D viewer (R20)
- Nested workers in browser (R21): explicit non-goal
- Dedicated watcher utility process (R22): co-locate with kernel host until a CPU smell appears
- `@taucad/electron` companion package (R17): adapters and helpers stay in `examples/electron-tau` until the PoC is green

## Trade-offs

### Where to host the Electron kernel (final)

| Placement                                                     | SAB scope                                                                        | Native binaries                              | Crash isolation                 | Hot path                                  | Decision                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `utilityProcess` (Topology C)                                 | utility + its workers + reaches renderer over relayed `MessagePort` (Finding 10) | full Node API + N-API addons                 | excellent (separate OS process) | Renderer ↔ utility direct after bootstrap | **adopted** — sole shipped placement                                                                                                              |
| Renderer Web Worker (Topology B)                              | renderer + worker                                                                | none (no Node addons)                        | weak (crash hits renderer)      | Renderer ↔ Web Worker                     | rejected — blocks future native binaries (Finding 18); browser parity is preserved by the runtime layer, not by reusing the same OS-thread layout |
| Main `worker_threads` (Topology A, original PoC)              | main + thread; **does not reach renderer**                                       | yes via main's addons                        | weak                            | Renderer ↔ main ↔ thread                  | rejected — root cause of the original PoC failure (Finding 7)                                                                                     |
| Hidden BrowserWindow (Topology D)                             | window + its workers; reaches renderer over relayed `MessagePort`                | only with `nodeIntegration` (security smell) | OK                              | Renderer ↔ hidden window                  | rejected — strictly dominated by Topology C since Electron 22 (Finding 11)                                                                        |
| Renderer-spawned nested Web Worker (Topology E, browser-only) | shared with renderer                                                             | none                                         | weak                            | Renderer ↔ Web Worker ↔ Sub-Worker        | rejected — explicit non-goal (R21)                                                                                                                |

### Where the FS authority lives (final, Q1-D)

| Strategy                    | How it routes a renderer file read                                           | How it routes a kernel file read                                   | How it routes a renderer file write            | How writes propagate                                                 | Verdict                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Q1-D layered (adopted)**  | Renderer → main `RuntimeFileSystemBridge` → main's local `fromNodeFs` → disk | Kernel host's local `fromNodeFs` → disk (zero IPC hops)            | Renderer → main → disk                         | Watcher in kernel-host utility fans events to renderer               | matches VS Code's pattern; minimises latency on the kernel hot path; renderer pays for sandboxing as it must          |
| Q1-A naive: FS only in main | Renderer → main → disk                                                       | Kernel host → renderer↔main → main → disk (two cross-process hops) | Renderer → main → disk                         | Watcher in main fans to renderer and to kernel via separate channels | rejected — kernel render path pays IPC for every source-file read; defeats the point of moving the kernel out of main |
| Q1-B FS only in kernel host | Renderer → renderer↔main → main → renderer↔kernel → kernel → disk            | Kernel local                                                       | Renderer → kernel via similarly multi-hop path | Watcher in kernel                                                    | rejected — file-tree UI traffic blocks on renders; renderer↔kernel wire is high-cap but is also the geometry hot path |
| Q1-C multiplexed            | Renderer multiplexes FS over geometry channel                                | Same                                                               | Same                                           | Custom                                                               | rejected — couples FS and geometry lifecycles, contention on the channel, no precedent                                |

### Where capability declaration lives

| Strategy                                                                  | Pros                                                                                                                                    | Cons                                                                                                                           | Decision         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Adapter-declared with fixed constants per wire kind (R4/R5)               | Single source of truth at the `Port` boundary; runtime stays declarative; type system enforces no drift between wire and capability set | Authors of new adapters must declare honestly                                                                                  | **adopted** — Q5 |
| Adapter-declared with consumer-supplied capabilities at construction time | Flexible                                                                                                                                | Easy to get out of sync with the actual wire; duplicates the contract; no compile-time signal that the wire and the bits agree | rejected         |
| Auto-detected per call via probe message                                  | Always correct                                                                                                                          | Expensive (extra roundtrip per initialize); fails-late if the probe is racy                                                    | rejected         |

### Capability negotiation strategy

| Strategy                                                        | Pros                                                                                                                                                                                  | Cons                                                                                         | Decision                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Client-only (pre-R3 baseline)                                   | Simple; no protocol changes                                                                                                                                                           | Server's true capabilities invisible to client; over-eager tier picks fail late and silently | rejected — already biting in the current PoC |
| Handshake AND-merge with mandatory `lh.d.capabilities` (R3)     | Both sides agree on the lowest common denominator before a single payload moves; surfaces mismatches at `channel.ready` rejection with a typed error; honest descriptor for telemetry | Requires `lh.d.capabilities` to become normative; one minor protocol bump                    | **adopted** — Q11                            |
| Handshake with optional `lh.d.capabilities` and silent fallback | Backwards compatible                                                                                                                                                                  | Reintroduces the silent-mismatch failure mode the rename is meant to eliminate               | rejected — Q11                               |

### Capability mismatch error policy

| Strategy                                | Pros                                                                                                                                                                                                             | Cons                                                                                                                                                          | Decision         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Throw only on explicit request** (R2) | The runtime defaults remain "best effort": if the consumer didn't ask for SAB pooling, a wire without `sharedArrayBufferClone` just falls back. If the consumer explicitly asked, the failure is loud and typed. | Consumers must distinguish "I want this if available" from "I require this" — captured by whether they pass the corresponding option to `createRuntimeClient` | **adopted** — Q3 |
| Always throw on any mismatch            | Maximally explicit                                                                                                                                                                                               | Overzealous: pulls every consumer into transport-awareness even when they would happily accept the lower tier                                                 | rejected         |
| Always silently fall back               | Maximally permissive                                                                                                                                                                                             | Hides genuine misconfiguration (consumer asked for SAB on a wire that cannot carry it; render perf collapses without an error)                                | rejected         |

### Adapter package location

| Strategy                                                                       | Pros                                                                                                          | Cons                                                                                 | Decision                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| `examples/electron-tau` for the PoC, extract to `@taucad/electron` later (R17) | Keeps the package surface small; lets the API stabilise against the only consumer (the PoC) before publishing | Third-party Electron+Tau apps cannot install a stable adapter until extraction lands | **adopted** — Q4, Q8               |
| `@taucad/electron` companion package now                                       | Available to third parties immediately                                                                        | Premature API freeze; revisions break consumers that don't exist yet                 | rejected                           |
| Inside `@taucad/runtime`                                                       | One install for consumers                                                                                     | Pulls Electron type definitions into the runtime; violates transport-agnosticism     | rejected — eigenquestion violation |

### Watching placement (v1)

| Strategy                                       | Pros                                                                                                                              | Cons                                                                                         | Decision                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| Co-locate with kernel-host utility (R10)       | One fewer process; the kernel host already needs the change events for parameter-file invalidation; minimal architectural surface | If watching becomes CPU-dominant, render eval competes with watcher work in the same V8 heap | **adopted** for v1 — Q1-D          |
| Dedicated `file-watcher` utility process (R22) | Mirrors VS Code; perfectly isolated CPU budget                                                                                    | Adds a third process per RuntimeClient with its own bootstrap dance and IPC                  | deferred to v2; trigger documented |

## Code Examples

All sketches below match the resolved blueprint. Type imports omitted for brevity except where they carry semantic weight.

### `PortCapabilities` final shape (R1)

```typescript
// packages/rpc/src/port.ts
export type PortCapabilities = {
  /** Wire can transfer `MessagePort` objects via the second postMessage arg without nulling data. */
  readonly messagePortTransfer?: boolean;
  /** Wire can transfer detached `ArrayBuffer` via the second postMessage arg. */
  readonly arrayBufferTransfer?: boolean;
  /** Wire delivers `SharedArrayBuffer` instances with shared (not copied) semantics. */
  readonly sharedArrayBufferClone?: boolean;
  /** Channel supports cooperative SAB-backed signal slot for cross-thread abort. */
  readonly signalSlot?: boolean;
  /** Pool-backed geometry delivery tier: peer can read by handle from a shared pool. */
  readonly pool?: boolean;
};

// Old keys are deleted in the same PR. No aliases.
// `transfer` → `arrayBufferTransfer`
// `sab`      → `sharedArrayBufferClone`
```

### Handshake `lh.d` normative shape (R3)

```typescript
// packages/rpc/src/wire.ts
export type LinkHelloPayload = {
  readonly peer?: string;
  readonly capabilities: PortCapabilities; // required, not optional
};

// In Channel handshake:
if (incoming.kind === 'lh') {
  if (!incoming.d || typeof incoming.d.capabilities !== 'object') {
    throw new IncompatibleHandshakeError(
      'Peer omitted lh.d.capabilities; both sides must declare their PortCapabilities at handshake.',
    );
  }
  this._negotiatedCapabilities = andMerge(this.port.capabilities, incoming.d.capabilities);
}
```

`andMerge(local, remote)` returns the bit-AND of every capability key — the wire can do something only if both sides agree it can.

### Runtime-side capability gating with explicit-request semantics (R2)

```typescript
// packages/runtime/src/framework/runtime-worker-client.ts
public async initialize(input: InitializeInput): Promise<void> {
  const caps = this.channel.port.capabilities; // negotiated, post-handshake

  const memoryHandle: InitializeMemoryHandle = {};
  const transferables: Transferable[] = [];
  const tierReport: DeliveryTierReport = {};

  // FS port: gated on messagePortTransfer
  if (this.fileSystemPort) {
    if (caps.messagePortTransfer === true) {
      memoryHandle.fileSystemPort = this.fileSystemPort;
      transferables.push(this.fileSystemPort);
      tierReport.fileSystem = 'port';
    } else if (this.options.fileSystem.requested === 'port') {
      throw new MissingCapabilityError(
        'messagePortTransfer',
        'fileSystem requested via port but the wire cannot transfer MessagePort',
      );
    } else {
      // not explicitly requested → silently fall back to inline FS bridge
      tierReport.fileSystem = 'inline';
    }
  }

  // Signal slot: gated on sharedArrayBufferClone
  if (caps.sharedArrayBufferClone === true) {
    memoryHandle.signalBuffer = this.allocateSignalBuffer();
    tierReport.cancel = 'sab';
  } else if (this.options.signalSlot === 'required') {
    throw new MissingCapabilityError(
      'sharedArrayBufferClone',
      'signalSlot was required but the wire cannot share SAB',
    );
  } else {
    tierReport.cancel = 'wire-frame';
  }

  // Geometry pool: same shape — gated on (pool && sharedArrayBufferClone)
  // …

  const args = { ...input, memoryHandle };
  const callArgs = transferables.length > 0 ? { value: args, transferables } : args;
  const result = await this.channel.call('initialize', callArgs);
  this._tierReport = tierReport; // surfaced via descriptor for telemetry
}
```

`MissingCapabilityError` is thrown only on `requested === 'port'` / `required` — i.e. the consumer asked. Otherwise the runtime silently picks the next-best tier and reports the choice via `descriptor`.

### Consumer-side Electron adapters (R4 + R5) — `examples/electron-tau/src/main/electron-port-adapters.ts`

```typescript
import type { Port, PortCapabilities } from '@taucad/rpc';
import type { MessagePortMain } from 'electron';

const wrapMain = <T>(port: MessagePortMain | MessagePort, capabilities: PortCapabilities): Port<T> => {
  // Branch on which side we are by feature-detect; both sides expose the same wire surface.
  const isElectronMain = typeof (port as MessagePortMain).on === 'function';
  return {
    capabilities,
    postMessage(data, transfer) {
      // MessagePortMain.postMessage accepts MessagePortMain[] only;
      // MessagePort.postMessage accepts any Transferable[]. Capability set guards what we pass.
      port.postMessage(data, transfer as never);
    },
    onMessage(handler) {
      if (isElectronMain) {
        const listener = (event: { data: T }) => handler(event.data);
        (port as MessagePortMain).on('message', listener);
        return () => (port as MessagePortMain).off('message', listener);
      }
      const listener = (event: MessageEvent<T>) => handler(event.data);
      (port as MessagePort).addEventListener('message', listener);
      return () => (port as MessagePort).removeEventListener('message', listener);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
};

/**
 * High-capability adapter for a renderer↔utilityProcess `MessagePort` whose
 * far end is a Tau kernel host. Both sides hold the same Mojo pipe; SAB and
 * ArrayBuffer transfer flow end-to-end (Finding 10).
 */
export const wrapElectronUtilityPort = <T>(port: MessagePort | MessagePortMain): Port<T> =>
  wrapMain<T>(port, {
    messagePortTransfer: true,
    arrayBufferTransfer: true,
    sharedArrayBufferClone: true,
    signalSlot: true,
    pool: true,
  });

/**
 * Low-capability adapter for any renderer↔main `MessagePort` (FS bridge,
 * future control planes). The renderer↔main wire is uniquely broken for
 * SAB and ArrayBuffer transfer (Findings 3, 10) — control plane only.
 */
export const wrapElectronCrossProcessPort = <T>(port: MessagePort | MessagePortMain): Port<T> =>
  wrapMain<T>(port, {
    messagePortTransfer: true,
    arrayBufferTransfer: false,
    sharedArrayBufferClone: false,
    signalSlot: false,
    pool: false,
  });
```

Capabilities are fixed constants per wire kind. There is no constructor option to tune them — the adapter name IS the capability declaration.

### Bootstrap helper (R8) — `examples/electron-tau/src/main/create-electron-kernel-channel.ts`

```typescript
import { utilityProcess, MessageChannelMain, type BrowserWindow, type UtilityProcess } from 'electron';
import { fromNodeFs } from '@taucad/runtime/filesystem/node';
import { createRuntimeFileSystemBridgeServer } from '@taucad/runtime/filesystem';
import { wrapElectronUtilityPort, wrapElectronCrossProcessPort } from './electron-port-adapters';

export const createElectronKernelChannel = async (params: {
  window: BrowserWindow;
  scriptPath: string;
  workspaceRoot: string;
}): Promise<{ child: UtilityProcess }> => {
  const { window, scriptPath, workspaceRoot } = params;

  const child = utilityProcess.fork(scriptPath, [], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('exit', (code) => reject(new Error(`utilityProcess exited before spawn: code ${code}`)));
  });

  // Channel 1 — kernel hot path. Renderer ↔ utility direct (after main relays the port).
  const kernelChannel = new MessageChannelMain();
  child.postMessage({ type: 'kernel-port' }, [kernelChannel.port1]);
  window.webContents.postMessage('kernel-port', null, [kernelChannel.port2]);

  // Channel 2 — FS bridge. Renderer ↔ main, served by main's local fromNodeFs.
  const fsChannel = new MessageChannelMain();
  const mainFs = fromNodeFs({ root: workspaceRoot });
  createRuntimeFileSystemBridgeServer({
    port: wrapElectronCrossProcessPort(fsChannel.port1),
    fileSystem: mainFs,
  });
  window.webContents.postMessage('fs-port', null, [fsChannel.port2]);

  // Lifecycle: surface utility exit as a typed event for the runtime/UI to react.
  child.on('exit', (code) => window.webContents.send('kernel-exit', { code }));

  return { child };
};
```

One `utilityProcess` per `RuntimeClient`. The caller decides how many to spawn; the helper does not multiplex.

### Kernel-host script (R9) — `examples/electron-tau/src/main/kernel-host.ts`

```typescript
import { fromNodeFs } from '@taucad/runtime/filesystem/node';
import { createKernelWorkerHost } from '@taucad/runtime/host';
import { wrapElectronUtilityPort } from './electron-port-adapters';

const handshake = (): Promise<MessagePort> =>
  new Promise((resolve) => {
    process.parentPort.once('message', (event) => {
      const [port] = event.ports;
      resolve(port as unknown as MessagePort);
    });
  });

const main = async () => {
  const port = await handshake();
  port.start();

  // Local FS instance — the kernel reads/writes via this directly, no IPC to main.
  // VS Code's ExtHostDiskFileSystemProvider analog (Finding 20).
  const fileSystem = fromNodeFs({ root: process.cwd() });

  await createKernelWorkerHost({
    port: wrapElectronUtilityPort(port),
    fileSystem,
  });
};

main().catch((err) => {
  console.error('[kernel-host] fatal', err);
  process.exit(1);
});
```

The kernel host has no awareness of Electron beyond `process.parentPort` for the handshake. After the wrap, the rest of the codebase sees a `Port` with the full browser-equivalent capability set.

### Renderer wiring — `examples/electron-tau/src/renderer/app.tsx` (excerpt)

```typescript
import { createRuntimeClient } from '@taucad/runtime/client';
import { fromPort } from '@taucad/runtime/filesystem';
import { portRunner } from '@taucad/runtime/runner';
import { wrapElectronUtilityPort, wrapElectronCrossProcessPort } from './electron-port-adapters';

const awaitRelayedPort = (tag: string): Promise<MessagePort> =>
  new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data === tag && event.ports[0]) {
        window.removeEventListener('message', listener);
        resolve(event.ports[0]);
      }
    };
    window.addEventListener('message', listener);
  });

const bootstrap = async () => {
  const [kernelPort, fsPort] = await Promise.all([awaitRelayedPort('kernel-port'), awaitRelayedPort('fs-port')]);
  kernelPort.start();
  fsPort.start();

  const client = createRuntimeClient({
    runner: portRunner({ port: wrapElectronUtilityPort(kernelPort) }),
    fileSystem: fromPort(wrapElectronCrossProcessPort(fsPort)),
    sharedMemory: { geometry: { capacity: 32 * 1024 * 1024 } },
  });

  await client.connect(); // negotiates capabilities, picks tiers, ready to render
};
```

The runtime sees two `Port`s: the kernel port reports full browser-equivalent capabilities, the FS port reports a low-cap surface. R2's gating logic puts SAB + pool tier on the kernel channel and inline cloneable RPC on the FS channel — automatically, without any code branching on "are we in Electron".

### FS topology summary (Q1-D)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Renderer                                                                     │
│  ─ no fs ─                                                                    │
│  fs proxy: fromPort(wrapElectronCrossProcessPort(fsPort))                     │
│  used for: file tree, project save, parameter group edits                     │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ renderer↔main MessageChannelMain (low-cap)
               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Main                                                                         │
│  fs: fromNodeFs({ root: workspaceRoot })   ◄── local instance                 │
│  fsServer: createRuntimeFileSystemBridgeServer({ port, fileSystem: mainFs })  │
└──────────────────────────────────────────────────────────────────────────────┘
                              ┌────────────────┐
                              │     disk       │   ◄── source of truth
                              └────────────────┘
                                     ▲
                                     │ direct fs access; zero IPC hops on hot path
┌──────────────────────────────────────────────────────────────────────────────┐
│  Kernel-host utilityProcess (one per RuntimeClient)                           │
│  fs: fromNodeFs({ root: workspaceRoot })   ◄── local instance                 │
│  watcher: FilesystemObserverBridge → push events to renderer over kernel port │
│  kernel reads source/parameter files and writes artifacts via local fs        │
└──────────────────────────────────────────────────────────────────────────────┘
```

No cross-process FS RPC for state coordination. Each Node-capable process holds its own `fromNodeFs`. Coordination happens via the disk + the watcher fan-out — the same pattern as VS Code's Extension Host (Finding 20).

## Diagrams

### Original PoC topology (kernel in main `worker_threads`; SAB cannot reach renderer — broken)

```
┌──────────────────────────────────┐                       ┌──────────────────────────────────┐
│  Renderer process                │                       │  Main process                    │
│                                  │                       │                                  │
│  React UI ──► RuntimeClient      │  MessageChannelMain   │  electron-tau main               │
│              │                   │  (port pair)          │              │                   │
│              │ initialize {      ├───────────────────────┤              │                   │
│              │   memoryHandle: { │  ✗ data goes null     │  RuntimeHost ─► nodeWorkerRunner │
│              │     SAB,          │     when SAB+port     │              │   spawns         │
│              │     fsPort        │     packed together   │              ▼                   │
│              │   }               │                       │           worker_threads kernel  │
│              │ }                 │                       │           (SAB only with main)   │
│              ▼                   │                       │                                  │
│           Channel                │                       │           Channel                │
└──────────────────────────────────┘                       └──────────────────────────────────┘
```

This is the rejected starting point. The next diagram is the blueprint.

### Topology C — Renderer ↔ utilityProcess kernel host with layered FS (the blueprint)

```
                                  ┌─────────────────────────────────────────┐
                                  │  Main process (cold path after bootstrap)│
                                  │                                          │
                                  │  utilityProcess.fork(kernelHost)         │
                                  │  MCM #1 { kp1, kp2 }  (kernel wire)      │
                                  │  MCM #2 { fp1, fp2 }  (fs wire)          │
                                  │                                          │
                                  │  child.postMessage(_, [kp1])             │
                                  │  webContents.postMessage('kernel', [kp2])│
                                  │  webContents.postMessage('fs',    [fp2]) │
                                  │                                          │
                                  │  fs (local): fromNodeFs({ root })        │
                                  │  fsServer: bridge attached to fp1        │
                                  │           (wrapElectronCrossProcessPort) │
                                  └─────────────────────────────────────────┘
                                            │  │            │
                              kp1 over Mojo │  │ kp2/fp2    │ fp1 stays in main
                                            │  │ over Mojo  │
                                            ▼  ▼            │
┌──────────────────────────────────────────────────┐         │
│  utilityProcess  (one per RuntimeClient)         │         │
│                                                  │         │
│  process.parentPort.once('message', e=>e.ports[0])         │
│  → MessagePortMain                               │         │
│  wrapped via wrapElectronUtilityPort             │         │
│                                                  │         │
│  fs (local): fromNodeFs({ root })  ◄──direct fs──┼──► disk │
│  watcher: FilesystemObserverBridge               │         │
│                                                  │         │
│  RuntimeWorkerDispatcher                         │         │
│  ├─ WASM kernels (Replicad, JSCAD, OpenSCAD, …)  │         │
│  └─ (future) native N-API addons (R19)           │         │
└──────────────────────────────────────────────────┘         │
                       ▲                                     │
                       │ kp1 ↔ kp2 direct MessagePort        │
                       │ SAB + ArrayBuffer transfer end-to-end (Finding 10)
                       │                                     │
                       │                                     │
┌────────────────────────────────────────────────────────────┴─────┐
│  Renderer process                                                 │
│                                                                   │
│  preload relays both ports to main world via window.postMessage   │
│                                                                   │
│  React UI ──► RuntimeClient                                       │
│             │  runner: portRunner({                               │
│             │    port: wrapElectronUtilityPort(kernelPort)        │
│             │  })                  ◄── kernel hot path            │
│             │                                                     │
│             │  fileSystem: fromPort(                              │
│             │    wrapElectronCrossProcessPort(fsPort)             │
│             │  )                   ◄── file tree, project save    │
│             │                                                     │
│             │  sharedMemory: { geometry: { capacity: 32 MB } }    │
│             ▼                                                     │
│         Channel ──── SAB pool ─── Three.js viewer ──── canvas     │
└───────────────────────────────────────────────────────────────────┘

After bootstrap, main is on the hot path for zero messages.
Renderer ↔ utility kernel wire: full browser-Worker capabilities.
Renderer ↔ main FS wire: control plane only, port-transfer + cloneable bytes.
Topology party count from the runtime's perspective: 2.
```

### Capability-driven gating decision tree (R2 + R3)

```
client.connect({ port, fileSystem, sharedMemory? })
            │
            ▼
   handshake: send lh.d.capabilities; receive remote lh.d.capabilities
            │
            ▼
   if remote omits lh.d.capabilities → throw IncompatibleHandshakeError (Q11)
            │
            ▼
   caps = andMerge(local, remote)   ◄── exposed as channel.port.capabilities
            │
            ▼
   ┌────────┴───────────────────────────────────────────────────────────────┐
   │ FS via port?                                                            │
   │   caps.messagePortTransfer === true                                     │
   │     → push fileSystemPort into transferables; tier = 'port'             │
   │   else if consumer requested fileSystem.kind === 'port' explicitly      │
   │     → throw MissingCapabilityError('messagePortTransfer', …)            │
   │   else                                                                  │
   │     → silent fallback: use inline FS bridge over the channel; tier='inline'
   ├─────────────────────────────────────────────────────────────────────────┤
   │ Signal slot for cooperative cancel?                                     │
   │   caps.sharedArrayBufferClone === true                                  │
   │     → allocate signalBuffer SAB; tier = 'sab'                           │
   │   else if consumer set signalSlot: 'required'                           │
   │     → throw MissingCapabilityError('sharedArrayBufferClone', …)         │
   │   else                                                                  │
   │     → silent fallback: wire-frame 'rc' cancel; tier = 'wire-frame'      │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ Geometry pool?                                                          │
   │   caps.pool && caps.sharedArrayBufferClone                              │
   │     → allocate geometryPoolBuffer SAB; tier = 'pool'                    │
   │   else if caps.arrayBufferTransfer                                      │
   │     → tier = 'transfer'                                                 │
   │   else if consumer passed sharedMemory.geometry explicitly              │
   │     → throw MissingCapabilityError('pool', …)                           │
   │   else                                                                  │
   │     → tier = 'copy' (silent fallback)                                   │
   └─────────────────────────────────────────────────────────────────────────┘
            │
            ▼
   descriptor.deliveryTier = tierReport  ◄── visible to telemetry / UI
```

## References

- [Electron — MessagePorts in Electron](https://www.electronjs.org/docs/latest/tutorial/message-ports)
- [Electron — `MessagePortMain` API](https://www.electronjs.org/docs/latest/api/message-port-main)
- [Electron — `utilityProcess` API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron — `contextBridge` API](https://www.electronjs.org/docs/api/context-bridge)
- [electron/electron #27024 — Using MessagePorts (+ Transferables) over ContextBridge](https://github.com/electron/electron/issues/27024)
- [electron/electron #34905 — MessagePort to MessagePortMain cannot transfer transferable resources](https://github.com/electron/electron/issues/34905)
- [electron/electron #37565 — Crash when attempting to transfer binary data objects through `MessagePortMain`](https://github.com/electron/electron/issues/37565)
- [electron/electron #50291 — Passing SharedArrayBuffer from Renderer to Main results in "An object could not be cloned"](https://github.com/electron/electron/issues/50291)
- [electron/electron #25446 — Send `SharedArrayBuffer` and communicate using Atomics?](https://github.com/electron/electron/issues/25446)
- [electron/electron #10409 — How to send `SharedArrayBuffer` from main process to Window processes](https://github.com/electron/electron/issues/10409)
- [electron/electron #22404 — feat: MessagePorts in the main process (PR introducing `MessagePortMain`, contains the worked SAB-over-relayed-port example)](https://github.com/electron/electron/pull/22404)
- [electron/electron #34980 — feat: UtilityProcess API (PR contributed by the VS Code team)](https://github.com/electron/electron/pull/34980)
- [electron/electron #45034 — Read-only shared buffer (`ArrayBuffer`) shared from main to renderer (with detailed analysis of WebView2's shared-buffer feature and the current Electron gap)](https://github.com/electron/electron/issues/45034)
- [VS Code blog — Migrating VS Code to Process Sandboxing (2022) — origin of the `utilityProcess` pattern](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [VS Code Internals: The Three-Process Model](https://roopik.com/blog/vscode-internals-architecture-101)
- [VS Code Internals: The Extension Host Explained — `extHost.protocol.ts` RPC pattern](https://roopik.com/blog/vscode-internals-extension-host)
- [VS Code architecture: Electron Main Process](https://microsoft-vscode-15.mintlify.app/architecture/electron-main-process)
- [Figma Blog — Figma Rendering: Powered by WebGPU (C++ → WASM, in-renderer architecture)](https://www.figma.com/blog/figma-rendering-powered-by-webgpu)
- [Figma's Rendering Architecture (deep dive)](https://kaelan.fyi/research/figma-architecture/)
- [Figma Blog — Introducing BrowserView for Electron](https://figma.com/blog/introducing-browserview-for-electron)
- [`electron-direct-ipc` — community library demonstrating renderer↔renderer and renderer↔utility SAB / `ArrayBuffer` transfer over relayed `MessagePort`](https://github.com/jjeff/electron-direct-ipc)
- [`shm-typed-array` — IPC shared memory native addon for Node (System V / POSIX)](https://github.com/ukrbublik/shm-typed-array)
- [`@fayzanx/mmap-io` — Node.js `mmap` bindings for file-backed shared memory](https://www.npmjs.com/package/@fayzanx/mmap-io)
- [coldfusion-example.blogspot.com — Electron Performance: Optimizing contextBridge and IPC for 60FPS UI (2026) — `webContents.postMessage` ArrayBuffer transfer pattern](https://coldfusion-example.blogspot.com/2026/01/electron-performance-optimizing.html)
- [coldfusion-example.blogspot.com — Unblocking the UI: Optimizing Large Data IPC Transfer in Electron (2025)](https://coldfusion-example.blogspot.com/2025/12/unblocking-ui-optimizing-large-data-ipc.html)
- [JavaScriptBit — Transferable Objects in JavaScript: Zero-Copy postMessage](https://javascriptbit.com/javascript-transferable-objects-postmessage/)
- [Stack Overflow — Nested Web Worker in Chrome (Chromium 69+ support)](https://stackoverflow.com/questions/54858891/nested-web-worker-in-chrome)
- [WebKit/WebKit PR #4349 — Implement nested Dedicated Workers (Safari support)](https://github.com/WebKit/WebKit/pull/4349)
- [Chromium issue #41483010 — `requestAnimationFrame` not supported in nested workers](https://issues.chromium.org/issues/41483010)
- [Three.js manual — OffscreenCanvas (worker-rendered 3D)](https://threejs.org/manual/en/offscreencanvas.html)
- [`@react-three/offscreen` — R3F worker-rendered scenes](https://github.com/pmndrs/react-three-offscreen)
- [Evil Martians — Faster WebGL/Three.js with OffscreenCanvas and Web Workers](https://evilmartians.com/chronicles/faster-webgl-three-js-3d-graphics-with-offscreencanvas-and-web-workers.md)
- [`occt-wasm` — modern OCCT WASM build with `OcctWorker` Comlink wrapper](https://github.com/andymai/occt-wasm)
- Related: `docs/research/runtime-channel-blueprint-v5.md`
- Related: `docs/research/runtime-worker-bundling-strategy.md`
- Related: `docs/research/electron-ipc-gap-analysis.md`
- Related: `docs/research/runtime-transport-implementation-blueprint-v4.md`
- Related: `docs/research/shared-memory-geometry-pipeline.md`

## Appendix

### A.1 Inventory: every `@taucad/rpc` import in `packages/runtime/src/`

| File                                     | Imports                                                                                      | Role                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `framework/runtime-worker-client.ts`     | `createChannelClient`, `Channel`, `Port`, `WithTransferables`                                | Builds `Channel<RuntimeProtocol>`; assembles `initialize` payload + transferables.     |
| `framework/runtime-worker-dispatcher.ts` | `createChannelServer`, `ChannelServer`, `ChannelServerHandle`, `Port`, `WithTransferables`   | Server side; reads `port.capabilities.{pool,transfer}` to pick geometry delivery tier. |
| `framework/runtime-filesystem-bridge.ts` | `createChannelClient`, `createChannelServer`, `wrapMessagePort`, `Port`, `WithTransferables` | FS RPC sub-protocol on `sessionKey: 'fs'`.                                             |
| `framework/runtime-message-adapter.ts`   | `Port` (type)                                                                                | Worker-side `Port` constructor declaring `{ sab, signalSlot, transfer }`.              |
| `framework/kernel-worker-host.ts`        | `wrapMessagePort`, `Port`                                                                    | `MessageChannel` setup; wraps both ports with `wrapMessagePort`.                       |
| `framework/geometry-materialiser.ts`     | `Channel` (type)                                                                             | Generic over `Channel<RuntimeProtocol>`.                                               |
| `types/runtime-protocol.types.ts`        | `WithTransferables` (type)                                                                   | Documents geometry transport notify shapes.                                            |

### A.2 Wire kinds in `@taucad/rpc` (for cross-reference)

`rq` request, `rs` response (`o:1` ok / `o:0` error), `rc` request-cancel, `nt` notify, `ss` stream subscribe, `sn` stream next, `sc` stream complete, `se` stream error, `su` stream unsubscribe, `lh` link-hello (the `lh.d` payload is the proposed home for capability advertisement, R8), `lb` link-bye, `fa`/`fw` reserved flow-control (warn-drop in v1).

### A.3 Why this is a runtime change, not an Electron polyfill

A polyfill that hides Electron's gap (e.g. detect SAB and silently copy instead) violates the eigenquestion: it requires the runtime to know it is running inside Electron. The same runtime would have to re-learn for every constrained transport. The capability-driven design instead admits transport limits as a first-class input — the consumer's adapter declares them once, and the runtime branches accordingly. Future transports (network sockets, BroadcastChannel, RTCDataChannel) compose the same way: declare what they can carry, get the right tier.

### A.4 Adapter-to-capability cheat sheet (final)

| Adapter (where it lives)                                        | `messagePortTransfer` | `arrayBufferTransfer` | `sharedArrayBufferClone` | `signalSlot` | `pool` | Use for                                                                                                                       |
| --------------------------------------------------------------- | --------------------- | --------------------- | ------------------------ | ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `wrapMessagePort` (browser/Node, in `@taucad/rpc`)              | ✓                     | ✓                     | ✓                        | ✓            | ✓      | Web Worker, `worker_threads`, Electron renderer-spawned Web Worker, Electron `utilityProcess` side of the kernel wire         |
| `wrapElectronUtilityPort` (R4, in `examples/electron-tau`)      | ✓                     | ✓                     | ✓                        | ✓            | ✓      | Renderer ↔ `utilityProcess` kernel wire — the only high-cap cross-process Electron wire                                       |
| `wrapElectronCrossProcessPort` (R5, in `examples/electron-tau`) | ✓                     | ✗                     | ✗                        | ✗            | ✗      | Renderer ↔ main FS wire and any future renderer↔main control plane — bulk data is automatically excluded by R2's gating logic |
| `wrapBroadcastChannel` (future)                                 | ✗                     | ✗                     | ✗                        | ✗            | ✗      | Pub/sub fan-out across BroadcastChannel — small messages only                                                                 |
| `wrapWebSocket` / `wrapDataChannel` (future)                    | ✗                     | ✗                     | ✗                        | ✗            | ✗      | Network transparency — capabilities all false; runtime falls back to wire-frame copy                                          |

The runtime never inspects the adapter type or the environment. It reads negotiated bits, picks tiers, calls `Channel`. New adapters extend the matrix; runtime stays unchanged. Capabilities are fixed constants per adapter; consumers cannot tune them at construction time (Q5).

### A.5 Topology decision flow

```
Building an Electron front-end for Tau?
├─ yes ─► Topology C — Renderer ↔ utilityProcess kernel host with main-mediated bootstrap
│         + Q1-D layered FS (per-process local fromNodeFs; main exposes its instance to the renderer)
│         + one utilityProcess per RuntimeClient
│
└─ no, browser only ─► Browser ↔ Web Worker (kernel) — unchanged from current
                       FS via fromMemoryFS / fromOPFS / fromIDB / etc; no main process
```

Tau ships exactly two transport topologies: browser-Worker and Electron-Topology-C. Every other plausible topology (A, B, D, E) is documented above with its rejection rationale and is not re-implemented per consumer.

### A.6 Loading native binaries inside `utilityProcess` (deferred — R19 future-work recipe)

When a native CAD or simulation kernel is prioritised:

1. **Build the addon** with `node-addon-api` against the Electron Node ABI (use `electron-rebuild` or `prebuild`/`prebuild-install`).
2. **Vendor the prebuild** into the package (per-platform, per-arch). Typical layout:
   ```
   packages/<kernel>/native/
     darwin-arm64/<addon>.node
     darwin-x64/<addon>.node
     linux-x64/<addon>.node
     win32-x64/<addon>.node
   ```
3. **`asarUnpack`** the native folder in the consumer's `electron-builder.yml`:
   ```yaml
   asarUnpack:
     - 'packages/<kernel>/native/**'
   ```
4. **Resolve at runtime** inside the kernel-host script:
   ```typescript
   const platformDir = `${process.platform}-${process.arch}`;
   const addonPath = path.join(__dirname, '..', 'native', platformDir, '<addon>.node');
   const addon = require(addonPath);
   ```
5. **Wrap in a kernel** that implements the same `defineKernel` contract as the WASM Replicad path — single source of truth for the runtime.
6. **Register** the kernel via `RuntimeClient`'s plugin array. The runtime sees one more `KernelId` in the `CapabilitiesManifest`; nothing else changes.

This is exactly how VS Code language servers ship with their per-platform native bins, and it composes cleanly with Topology C without any runtime changes.

### A.7 Failure-mode quick reference

| Symptom                                                          | Cause                                                                                                | Resolution                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event.data === null` at main-process port handler               | Renderer packed a `MessagePort` and another non-port transferable into one message (Electron #34905) | R2 + R6 + R5: Topology C puts kernel traffic on the high-cap utility wire; FS port goes through the low-cap `wrapElectronCrossProcessPort` adapter and the runtime never schedules SAB or ArrayBuffer onto it |
| `An object could not be cloned` on `ipcRenderer.postMessage`     | `SharedArrayBuffer` in payload (Electron #50291)                                                     | R2: capability-gating prevents SAB packing on a wire with `sharedArrayBufferClone: false`                                                                                                                     |
| Renderer parks at `lifecycleState === 'connecting'`              | `Channel.ready` never resolves because peer never received the `initialize` request                  | R3: AND-merged handshake fails fast with `IncompatibleHandshakeError` if either side mis-declares; R2 gates assembly so the message is always sendable on the wire                                            |
| `port.addEventListener is not a function` in renderer main world | `MessagePort` was returned through `contextBridge.exposeInMainWorld` (Electron #27024)               | R11: preload uses `window.postMessage('tag', '*', [port])` relay                                                                                                                                              |
| Renderer effects fire twice in dev (PoC discovery)               | React 19 `StrictMode` double-invocation of effects                                                   | Consumer-side: drop `StrictMode` for IPC-bootstrap effects or move IPC out of effects (already done in PoC)                                                                                                   |
| Kernel render path stalls on FS reads                            | Kernel reads source/parameter files via main-side FS instead of local                                | R7 Q1-D: kernel-host utility holds its own `fromNodeFs`; reads/writes hit disk directly with zero IPC hops                                                                                                    |
| File written by kernel host not visible in renderer file tree    | Watcher events not propagating                                                                       | R10: `FilesystemObserverBridge` co-located with kernel host pushes change events to renderer over the kernel↔renderer port                                                                                    |
| Multiple panes share one kernel utility (slow renders)           | Single utility multiplexed across `RuntimeClient`s                                                   | R6: spawn one `utilityProcess` per `RuntimeClient`; lifecycle ties to `client.disconnect()`                                                                                                                   |
| Kernel utility crashes; renderer hangs                           | No exit handling in v1                                                                               | R8: `child.on('exit')` surfaces a typed disconnect; runtime moves to terminal `'errored'`; user reloads (R18 future: auto-respawn)                                                                            |

### A.8 Q&A resolution log

The twelve open questions identified after Topology C was adopted are answered in the [Resolved Decisions](#resolved-decisions) section above. This appendix subsection records the resolutions verbatim for archival cross-referencing from future planning docs. Format: `OQ-N → answer (recommendation that implements it)`.

| OQ    | Answer (verbatim)                                                                                                                                                                                                                                                                      | Implementing recommendation |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| OQ-1  | Q1-D — VS Code-style layered FS: per-process local `fromNodeFs` instances; main exposes its instance via `RuntimeFileSystemBridge`; kernel-host utility uses local instance for direct hot-path reads/writes; watching co-located with kernel host for v1; disk is the source of truth | R7, R10                     |
| OQ-2  | Delete the old R5 outright; `webWorkerRunner` is browser-only                                                                                                                                                                                                                          | (deletion)                  |
| OQ-3  | Throw `MissingCapabilityError` only on explicit request; silently fall back to best available tier otherwise                                                                                                                                                                           | R2                          |
| OQ-4  | Adapters in `examples/electron-tau` for the PoC; extract to `@taucad/electron` companion package later                                                                                                                                                                                 | R4, R5, R17                 |
| OQ-5  | Two adapters with fixed capabilities, named after the wire kind: `wrapElectronUtilityPort` (full caps) and `wrapElectronCrossProcessPort` (low caps)                                                                                                                                   | R4, R5                      |
| OQ-6  | One `utilityProcess` per `RuntimeClient` (Tau spawns multiple `RuntimeClient`s when multiple `cad.machine` instances render concurrently)                                                                                                                                              | R6                          |
| OQ-7  | Defer lifecycle respawning; v1 surfaces `child.on('exit')` as terminal disconnect                                                                                                                                                                                                      | R8, R18                     |
| OQ-8  | Kernel-host script in `examples/electron-tau` for now; same extraction follow-up as OQ-4                                                                                                                                                                                               | R9, R17                     |
| OQ-9  | Defer native N-API CAD addons; no native binaries needed for v1                                                                                                                                                                                                                        | R19                         |
| OQ-10 | Both Vitest unit conformance AND Playwright e2e against real Electron                                                                                                                                                                                                                  | R12, R13                    |
| OQ-11 | Hard reject with `IncompatibleHandshakeError` if `lh.d.capabilities` is omitted                                                                                                                                                                                                        | R3                          |
| OQ-12 | Hard rename `transfer → arrayBufferTransfer` and `sab → sharedArrayBufferClone` in one PR; no aliases                                                                                                                                                                                  | R1                          |
