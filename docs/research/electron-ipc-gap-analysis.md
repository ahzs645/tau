---
title: 'Electron IPC Gap Analysis'
description: 'Stock-take of Half B Electron IPC progress against the runtime transport blueprint v4: filesystem topology pivot, hurdles encountered, open questions, and remaining work to verify the proof of concept.'
status: draft
created: '2026-04-25'
updated: '2026-04-25'
category: audit
related:
  - docs/research/runtime-transport-implementation-blueprint-v4.md
  - docs/research/filesystem-gap-analysis.md
  - docs/research/runtime-cross-origin-isolation-distribution.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/policy/library-api-policy.md
---

# Electron IPC Gap Analysis

Cross-reference of every Half B requirement and unforeseen architectural decision against the current source code, after the renderer↔kernel-host transport landed and the integration test went green. Filesystem topology gets its own deep dive because that is where the original blueprint assumption broke and where the remaining open questions concentrate.

## Executive Summary

Half A of `runtime-transport-implementation-blueprint-v4.md` is complete and certified at T2 conformance. Half B execution then pivoted from the blueprint as written: rather than building an Electron-specific factory (B-R10) and adding a third FS arm wired through `MessagePortMain` (B-R4), we landed a **generic** `createMessagePortTransport` plus `hostKernelOnPort` pair, and added a fourth `RuntimeFileSystem` arm — `host`-kind — to model the Electron reality that `MessagePort` cannot cross a process boundary. An end-to-end Replicad render now passes through an in-memory port pair using a host-owned filesystem, validating the transport architecture without any Electron-specific code. The Electron app shell itself (`examples/electron-tau/`) is **scaffolded as empty directories only** — no `package.json`, no main/preload/renderer source, no Playwright wiring. Of the 14 Half B requirements: **4 RESOLVED** (or sidestepped with explicit rationale), **2 PARTIAL**, **8 NOT STARTED** (7 of those WebSocket-only and out of scope for this milestone). Three Electron-specific gaps remain: (G1) the `code:` shorthand in `RuntimeClient` invariant-throws against `host`-kind FS, (G2) the renderer has no production path to mutate the host-owned filesystem (Monaco edits cannot land), and (G3) renderer UI surfaces (file tree, watcher echoes) are not yet wired to the host-owned FS at all.

## Table of Contents

- [Methodology](#methodology)
- [Half B Requirement Matrix](#half-b-requirement-matrix)
- [Findings — Transport Layer](#findings--transport-layer)
- [Findings — Filesystem Topology](#findings--filesystem-topology)
- [Findings — Memory and Performance](#findings--memory-and-performance)
- [Findings — Example App Shell](#findings--example-app-shell)
- [Open Questions](#open-questions)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Methodology

1. Read the `Half B` section of `docs/research/runtime-transport-implementation-blueprint-v4.md` and the `A-R22` closeout note (the gate Half A had to clear before Half B began).
2. Inventoried current source under `packages/runtime/src/transport/` and `packages/runtime/src/filesystem/` for the new symbols (`createMessagePortTransport`, `hostKernelOnPort`, `fromHost`).
3. Walked the `message-port-integration.test.ts` end-to-end render to confirm what is actually wired versus what is mocked.
4. Read `runtime-client.ts` `connect()` and `openFile({ code })` paths to identify the filesystem invariants that the new `host` arm violates today.
5. Inspected `examples/electron-tau/` to confirm what scaffolding (if any) exists.
6. Checked `transport-conformance.test.ts` to confirm tier coverage for the new transport.
7. Captured all hurdles encountered during implementation, classifying them as resolved, deferred, or still open.

## Half B Requirement Matrix

| Req   | What it specifies                                                    | Status                                                                                       | Notes                                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-R1  | Wire codec for binary frames (msgpack)                               | ⏸ Deferred                                                                                   | WebSocket-only. Electron's `MessageChannelMain` uses native structured cloning + `Transferable[]`, so a custom codec is unnecessary on the desktop path.                                                                               |
| B-R2  | Heartbeat / ping-pong                                                | ⏸ Deferred                                                                                   | WebSocket-only. Process-local IPC has no equivalent liveness concern; renderer crash kills the port pair, which already surfaces as `TransportClosedError`.                                                                            |
| B-R3  | Reconnect state machine                                              | ⏸ Deferred                                                                                   | WebSocket-only.                                                                                                                                                                                                                        |
| B-R4  | FS RPC sub-protocol with chunking (third arm of `RuntimeFileSystem`) | ↪️ **Sidestepped** (different FS topology adopted)                                           | The blueprint's `kind: 'rpc'` arm assumed FS could be tunnelled over the wire. We instead added a `kind: 'host'` arm and route FS calls _inside_ the host process — see Finding 2.                                                     |
| B-R5  | Auth in `createWebSocketTransport`                                   | ⏸ Deferred                                                                                   | WebSocket-only.                                                                                                                                                                                                                        |
| B-R6  | In-flight outcomes → superseded on disconnect                        | ⏸ Deferred                                                                                   | WebSocket-only. Some logic is portable to Electron port-close handling; intentionally not generalised yet to avoid premature abstraction.                                                                                              |
| B-R7  | Sub-channel split for observability                                  | ⏸ Deferred                                                                                   | WebSocket-only.                                                                                                                                                                                                                        |
| B-R8  | WebSocket behavioural implementation                                 | ⏸ Deferred                                                                                   | Whole WebSocket path deferred until WebSocket consumer arrives.                                                                                                                                                                        |
| B-R9  | WebSocket conformance T3+T4+T5                                       | ⏸ Deferred                                                                                   | T3–T5 suites have not been written yet for _any_ transport (see Finding 7).                                                                                                                                                            |
| B-R10 | `createElectronIpcTransport` factory                                 | ✅ Generalised as `createMessagePortTransport`                                               | Electron-specific naming rejected — the same primitive will serve `worker_threads`, `MessageChannel`, `MessageChannelMain`, and any future structured-clone bridge. Electron just wraps `MessagePortMain`.                             |
| B-R11 | `MessagePortMain` channel adapter                                    | 🟡 Adapter shape exists (`RuntimeMessagePort`); no Electron implementation yet               | The `RuntimeMessagePort` interface in `runtime-message-adapter.ts` is the contract; an Electron-specific wrapper around `MessagePortMain` is < 50 LOC and will live in `examples/electron-tau/src/main/` (not in the runtime package). |
| B-R12 | Renderer↔main FS topology                                            | ✅ Architecturally validated; not Electron-wired                                             | `message-port-integration.test.ts` proves a full Tau render survives the in-memory port pair with host-owned FS. Real Electron wiring is gated on the example app (Finding 9).                                                         |
| B-R13 | Conformance promotion: Electron at T5                                | 🟡 T0–T2 only (via `transport-conformance.test.ts` `describe('createMessagePortTransport')`) | T3 (abort parity), T4 (backplanes), T5 (liveness) tiers are not yet written for any transport.                                                                                                                                         |
| B-R14 | `streamId` for multi-tenant                                          | ⏸ Deferred                                                                                   | Out of scope until a real consumer demands it — same posture as the blueprint.                                                                                                                                                         |

## Findings — Transport Layer

### ✅ Finding 1: Generic `createMessagePortTransport` lands instead of Electron-specific factory

**Severity**: Architectural decision — supersedes B-R10.

The blueprint listed `createElectronIpcTransport` as a discrete requirement. Implementation revealed that the _only_ Electron-specific behaviour is wrapping `MessagePortMain` to satisfy the `RuntimeMessagePort` interface. Everything else — command queue, event source, materialised geometry, dispatcher contract — is identical to the existing in-process and worker transports because all three are structured-clone channels.

We therefore landed `packages/runtime/src/transport/message-port-transport.ts` as a generic factory keyed off `RuntimeMessagePort`. The Electron-specific bits (10–20 LOC adapter around `MessagePortMain`) belong in the consumer (the Electron app) and not in the runtime package, which keeps `@taucad/runtime` free of an `electron` peer dependency.

**Source**: `packages/runtime/src/transport/message-port-transport.ts`, `packages/runtime/src/transport/index.ts`.

### ✅ Finding 2: `hostKernelOnPort` server-side helper required (no blueprint analogue)

**Severity**: Architectural decision — fills a gap the blueprint did not anticipate.

A symmetric server-side helper was needed because the existing worker bootstrap in `kernel-runtime-worker.ts` is an IIFE that auto-registers when loaded inside a Web Worker or Node `worker_threads` parent. The Electron main process is _neither_ — it loads the runtime as a regular Node module — so the IIFE never fires. `hostKernelOnPort` provides the explicit, manually-driven mounting point: caller passes a port, helper instantiates `KernelRuntimeWorker`, wires it through `createWorkerDispatcher`, and returns a `dispose()` handle.

`hostKernelOnPort` is also where the host-owned FS gets bridged into the kernel (Finding 5) — a responsibility that has no analogue in the blueprint.

**Source**: `packages/runtime/src/transport/host-kernel-on-port.ts`.

### ✅ Finding 3: T0–T2 conformance covers `createMessagePortTransport`

**Severity**: Test coverage gate.

`transport-conformance.test.ts` includes a `describe('createMessagePortTransport')` block that runs the same shape, ordering, and correlation assertions used for in-process and worker transports, plus a dedicated `message-port-transport.test.ts` (unit) and `message-port-integration.test.ts` (end-to-end Replicad render). T3+T4+T5 tiers are intentionally not yet written for any transport — see Finding 7.

**Source**: `packages/runtime/src/transport/transport-conformance.test.ts:251` (`createMessagePortTransport` section), `packages/runtime/src/transport/message-port-{transport,integration}.test.ts`.

## Findings — Filesystem Topology

The bulk of unforeseen work happened here. Three hurdles fundamentally changed the design from what B-R4 + B-R12 implied.

### ✅ Finding 4: Hurdle — `MessagePort` is process-bound (V8 agent cluster constraint)

**Severity**: P0 architectural blocker.

**Status**: **RESOLVED** by adopting `kind: 'host'` (Finding 5).

The blueprint's B-R4 implicitly assumed the renderer-side FS bridge `MessagePort` could be transferred across the renderer↔main boundary so the kernel worker would receive the FS on its own port. Empirically, this is impossible: V8 agent clusters are process-local, and Electron's `MessageChannelMain` only allows structured-cloneable data and _its own_ port endpoints to cross. A renderer-side `MessagePort` cannot be `transfer`-listed onto a `MessagePortMain.postMessage` and re-emerge in the main process as a usable port. This same constraint applies to Node `worker_threads` boundaries between unrelated agent clusters and to any process-process bridge.

**Resolution**: instead of trying to transfer the FS port across the boundary, the host process _owns_ its own `RuntimeFileSystemBase` and constructs a _local_ bridge port to it. The renderer simply declares "the host owns the FS" via the new `host` arm.

### ✅ Finding 5: New `kind: 'host'` arm of `RuntimeFileSystem`

**Severity**: Architectural addition — replaces blueprint's `kind: 'rpc'`.

**Status**: **RESOLVED** — landed in `packages/runtime/src/filesystem/runtime-filesystem-handle.ts`, exported from `#filesystem/index.ts`, validated by integration test.

The new arm carries no payload at all:

```typescript
| { readonly kind: 'host' }
```

with a matching factory:

```typescript
export const fromHost = (): RuntimeFileSystem => ({ kind: 'host' });
```

Semantically: the renderer is asserting that the kernel host on the other end of the transport will provide its own FS. `createMessagePortTransport.configureMemory()` enforces this by throwing if `request.fileSystem.kind !== 'host'` (rejecting `inline` because its bridge port cannot cross the process boundary, and `channel` for the same reason). On the host side, `hostKernelOnPort({ fileSystem })` intercepts the inbound `'initialize'` command, calls `createBridgePort(options.fileSystem)` to manufacture a local `MessageChannel`, injects the resulting `MessagePort` as `command.memoryHandle.fileSystemPort`, and forwards the enriched command to the kernel worker. The kernel worker is none the wiser — its FS contract is identical to the in-process and worker cases.

This sidesteps B-R4's chunked FS RPC sub-protocol entirely. The renderer never speaks FS over the wire; the wire only carries kernel commands and responses. FS lives where Electron expects it: in the privileged main process, with full Node `fs`/`fs.promises` access.

**Source**: `packages/runtime/src/filesystem/runtime-filesystem-handle.ts`, `packages/runtime/src/filesystem/index.ts:17`, `packages/runtime/src/transport/host-kernel-on-port.ts:97-146`, `packages/runtime/src/transport/message-port-transport.ts:configureMemory`.

### ❌ Finding 6: `RuntimeClient.openFile({ code })` invariant-throws against `host` FS

**Severity**: P0 — DX gap blocking the Monaco-driven inner loop.

**Status**: **OPEN**.

`RuntimeClient.openFile()` accepts two shapes today: `openFile({ file })` and `openFile({ code: { 'main.ts': '…' } })`. The `code:` shorthand is a critical DX convenience for live-coding consumers (the Monaco editor in particular) and for the runtime test harness. Internally it stages the inline code by writing into the _managed_ filesystem the runtime client owns. Today that managed filesystem is hard-assumed to be the `inline` arm:

```typescript
const inlineFs = managedFileSystem.kind === 'inline' ? managedFileSystem.fs : undefined;
if (!inlineFs) {
  throw new Error('Internal invariant: managedFileSystem must be the inline-kind handle from fromMemoryFS().');
}
```

Once `connect({ fileSystem: fromHost() })` is called, this invariant fires whenever the renderer tries `openFile({ code })`. The integration test currently sidesteps the gap by reaching across to the host's filesystem object directly (`hostFsHandle.fs.writeFile('/main.ts', code)` _before_ the client call) — fine for an in-process test that holds both ends, useless for a real Electron app where the renderer cannot touch the main-process FS directly.

This is a renderer↔main coordination problem disguised as a client invariant. Two viable fixes (Recommendation R5):

| Approach                                         | What changes                                                                                                                                        | Trade-off                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Stage-via-FS-bridge command**               | `code:` mode emits a control command on the kernel transport that asks the host to stage `{path → bytes}` onto its own FS before the render starts. | Reuses the existing transport. Adds one new command kind. Keeps the wire surface small and respects "host owns the FS".    |
| **B. Push a write API onto `RuntimeFileSystem`** | Expose `connect()`-time write access from the renderer through a thin RPC; renderer uses it to write inline code directly.                          | Pulls FS RPC back into scope (the thing `host` arm was trying to avoid). Tempting but resurrects the failure mode of B-R4. |

**Recommendation**: Approach A. Treat `code:` mode as a "stage these files on the host, then render" intent. The host already has a `RuntimeFileSystemBase`; staging is `await fs.writeFile(path, bytes)`. The control command is a small addition to the protocol that is symmetric with the existing render command flow.

### ❌ Finding 7: Renderer-side file mutation has no production path

**Severity**: P0 — blocks Monaco editor integration.

**Status**: **OPEN**.

The Monaco editor in the renderer cannot mutate the host's filesystem at all today. There is no IPC for "write this buffer back to disk", "create this new file", "rename this file". Without it, the inner loop the user wants to validate (edit code → live render → see geometry) only works for a one-shot stage from `code:` mode (Finding 6). Editor saves silently lose data.

The same shape that fixes Finding 6 (a host-FS staging command on the transport) extends naturally to the editor save path: each save becomes "stage these bytes". A more ergonomic Electron-native option is a thin `contextBridge`-exposed FS proxy on `window.taucad.fs.writeFile(path, bytes)` that shuttles directly to a main-process IPC handler, _not_ through the kernel transport. Either works; the kernel-transport-based approach is preferable because it keeps the renderer FS API identical regardless of whether the kernel runs in-process, in a Web Worker, or across an Electron boundary.

### ❌ Finding 8: Renderer-side file _observation_ (file tree + watch echoes) has no path

**Severity**: P1 — blocks file-tree UI and watch-driven UX.

**Status**: **OPEN**.

Symmetric to Finding 7. The renderer's file tree, the per-file watch indicators, and any "external change detected" badges all need a stream of `ChangeEvent`s from the host's filesystem. Today the host's `RuntimeFileSystemBase` is bridged _only_ into the kernel worker's local port; there is no second bridge fanning out to the renderer.

Two pieces are needed:

1. A second `createBridgePort(hostFs)` exposed to the renderer through `contextBridge` (or via a dedicated FS sub-channel on the same `MessagePortMain` pair).
2. A renderer-side `RuntimeFileSystemBase` proxy (we already have `createBridgeProxy` in `runtime-filesystem-bridge.ts`) so the file tree, the editor file pickers, and the per-file content viewer can all consume the same FS interface they do in the web app.

Crucially, this is a renderer↔main FS bridge that is **separate** from the kernel transport — the kernel never sees these reads/writes. Co-locating them on the kernel transport is possible but mixes concerns and makes back-pressure analysis harder.

### ✅ Finding 9: Filesystem topology validated end-to-end

**Severity**: Acceptance gate for the transport layer.

**Status**: **RESOLVED** for the transport contract; remaining gaps are renderer-side wiring (Findings 6–8).

`message-port-integration.test.ts` runs a full Replicad cube render through:

- An in-memory `MessageChannel` port pair (no Electron involved — proves the architecture is transport-agnostic).
- Renderer-side `runtimeClient.connect({ fileSystem: fromHost() })`.
- Host-side `hostKernelOnPort(host, { fileSystem: hostFsHandle.fs })` with a `fromMemoryFS()`-backed FS.
- Source code staged on the host FS _before_ the render request (the Finding 6 workaround).
- A real Replicad bundle, geometry hash, and `geometry` event emission.

This proves the kernel-side FS bridge plumbing in `hostKernelOnPort` works correctly and that `createMessagePortTransport` enforces the correct FS-arm contract.

**Source**: `packages/runtime/src/transport/message-port-integration.test.ts`.

## Findings — Memory and Performance

### ⏸ Finding 10: `sharedMemory: false` declared by `createMessagePortTransport`

**Severity**: P1 design constraint — needs benchmarking, may be revisited.

**Status**: **DEFERRED** pending the Electron app integration phase.

`createMessagePortTransport` advertises `capabilities.sharedMemory: false`. `SharedArrayBuffer` cannot cross Electron `MessageChannelMain` (it requires the same agent cluster), so the `SharedPool`-backed geometry transport that the web app uses is not available on the desktop path. Geometry payloads will be `Transferable<ArrayBuffer>` round-trips instead — zero-copy thanks to `MessagePortMain`'s `transferList`, but every payload is "consumed" by the receiver, so re-reads require re-fetch from the host.

Implications:

- Cached geometry on the host (the runtime's geometry-cache middleware) still works — the host re-emits via the wire when the renderer asks again.
- The renderer cannot benefit from `SharedContentPool` (the file content pool from filesystem-gap-analysis F22). Files cross the wire each time they are read.
- Any "two windows reading the same project" scenario pays the cost twice.

**Action**: benchmark in the example app once it lights up; revisit if the cost is material. Not a blocker for the proof of concept.

### ⏸ Finding 11: Kernel runs on the Electron main thread — blocks IPC under load

**Severity**: P1 architectural smell — needs decision before scaling beyond one window.

**Status**: **DEFERRED** — captured for the example-app phase.

`hostKernelOnPort` instantiates `KernelRuntimeWorker` directly in the calling process. In Electron, that means the OCCT/Replicad WASM lives on the main thread, which is also the thread that owns `BrowserWindow`s, the menu, and IPC routing. A long render (multi-second OCCT compute) will stall main-process IPC and freeze the UI.

The clean fix is to host the kernel inside a Node `worker_threads.Worker` spawned from main; `MessagePortMain.port2` can be transferred into the worker via `worker.postMessage(value, [port])`. This keeps the kernel off the main thread without touching the runtime package. The example app should land with the worker-thread topology rather than discover the freeze in production.

## Findings — Example App Shell

### ❌ Finding 12: `examples/electron-tau/` is empty scaffolding only

**Severity**: P0 for the proof of concept; transport work is unblocked.

**Status**: **OPEN**.

`examples/electron-tau/` exists with three empty source directories (`src/main/`, `src/preload/`, `src/renderer/`), an empty `test/` directory, and an empty `resources/` directory. There is **no** `package.json`, **no** `project.json`, **no** Vite config, no electron-builder/electron-forge config, no preload script, no main script, no renderer entrypoint. The pnpm workspace pattern `examples/*` is wired and `.husky/commit-msg` accepts the scope, but the package itself does not yet exist.

This means none of the following has been built or tested yet:

- BrowserWindow with the correct COEP/COOP headers (Recommendation R6).
- Preload `contextBridge` exposing the `MessagePortMain` to the renderer (Recommendation R7).
- A `MessagePortMain` adapter satisfying `RuntimeMessagePort` (Recommendation R8).
- Vite + electron-vite build pipeline.
- The Monaco + Three.js + parameter-form renderer surface (Recommendation R10).
- Playwright `_electron` automated tests (Recommendation R11).

The transport architecture is _ready_ to be consumed; the consumer does not yet exist.

## Open Questions

| #   | Question                                                                                                                                                                  | Owner / proposed resolution                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Does `code:` mode become a control command on the kernel transport, or a separate `window.taucad.fs` IPC?                                                                 | Lean: control command on the transport. Keeps the renderer FS surface uniform across web, worker, and Electron. Decision before R5 lands.                                                                                |
| Q2  | Renderer file-tree FS reads and watch streams: same `MessagePortMain` (multiplexed) or a second port pair dedicated to FS?                                                | Lean: second port pair. Avoids back-pressure coupling between geometry events and bulk FS reads. Costs one extra channel; Electron has no per-process port-count limit that matters here.                                |
| Q3  | Is COEP `require-corp` strictly necessary in Electron when we never use `SharedArrayBuffer` on the renderer?                                                              | Likely no. Electron BrowserWindow ships its own JS context; SAB requirements only matter if we re-enable it. Investigate against `runtime-cross-origin-isolation-distribution.md` and decide before BrowserWindow lands. |
| Q4  | Do we host the kernel in `worker_threads.Worker` from day one, or land single-thread first and migrate?                                                                   | Lean: worker-threads from day one. Migration cost is small; the freeze cost when hit is large. (Finding 11.)                                                                                                             |
| Q5  | Multiple `BrowserWindow`s — one kernel per window, one kernel pool, or one kernel total?                                                                                  | Defer until renderer is wired. Probably one per window for the example, with a documented note about pool patterns for production consumers.                                                                             |
| Q6  | Do we extract the renderer composition (RuntimeClient + Monaco + viewer + parameter form) into `@taucad/react` _before_ or _after_ the Electron app proves it?            | After. The user's brief is explicit: build it in the Electron example, then abstract. Matches the "find the right ergonomics, then extract" approach.                                                                    |
| Q7  | Is there a useful `host` FS variant that carries an _origin hint_ (e.g. project root path) so the renderer can render breadcrumbs without round-tripping?                 | Probably yes — extend `fromHost()` to optionally carry a label/path string. Cheap, no protocol impact. Defer until R10 needs it.                                                                                         |
| Q8  | Should `createMessagePortTransport` ever accept the `inline` arm via a "bridge-locally" escape hatch (for tests or for in-process Electron `nodeIntegration: true` apps)? | Probably not. Tests can use `createInProcessTransport`; production should never enable `nodeIntegration: true`. Keeping the rejection strict prevents a footgun.                                                         |

## Recommendations

| #   | Action                                                                                                                                                                                     | Priority | Effort | Impact | Findings |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ | -------- |
| R1  | Update blueprint v4 Half B section to record the `host`-arm pivot and supersede B-R4                                                                                                       | P0       | Low    | Medium | F4, F5   |
| R2  | Add a "FS topology" diagram to the blueprint showing renderer transport → host-owned FS → local bridge → kernel worker                                                                     | P0       | Low    | Medium | F5, F9   |
| R3  | Bootstrap `examples/electron-tau` package (`package.json`, `project.json`, `electron-vite` config, `tsconfig`, lint config)                                                                | P0       | Medium | High   | F12      |
| R4  | Land main-process kernel host: BrowserWindow with documented COEP decision, `MessageChannelMain`, `hostKernelOnPort` wired to a `fromNodeFS`-backed FS                                     | P0       | Medium | High   | F12      |
| R5  | Extend the kernel transport protocol with a `stageFiles` (or equivalent) control command, then teach `RuntimeClient.openFile({ code })` to use it when `managedFileSystem.kind === 'host'` | P0       | Medium | High   | F6, F7   |
| R6  | Add an Electron-specific `MessagePortMain → RuntimeMessagePort` adapter inside the example (≤ 50 LOC, stays out of the runtime package)                                                    | P0       | Low    | High   | F12      |
| R7  | Preload + `contextBridge`: expose `connectKernel(): Promise<MessagePort>` to the renderer; main responds by transferring `MessagePortMain.port1`                                           | P0       | Low    | High   | F12      |
| R8  | Renderer surface: Monaco editor backed by R5's `code:` path, three.js viewer for geometry, `parameters` form driven by runtime parameter extraction                                        | P1       | High   | High   | F12, F6  |
| R9  | Renderer↔main FS bridge for file tree + editor saves (separate port pair from kernel transport per Q2 lean)                                                                                | P1       | Medium | High   | F7, F8   |
| R10 | Host kernel inside `worker_threads.Worker` from day one to keep WASM compute off the main thread                                                                                           | P1       | Low    | High   | F11      |
| R11 | Add Playwright `_electron` smoke test covering: edit code → render geometry → assert glTF reaches renderer                                                                                 | P1       | Medium | High   | F12      |
| R12 | Conformance T3 tier (abort parity) implemented and run against `createMessagePortTransport`                                                                                                | P2       | Medium | Medium | F3       |
| R13 | Conformance T4 tier (backplanes) implemented and run against `createMessagePortTransport`                                                                                                  | P2       | Medium | Medium | F3       |
| R14 | Conformance T5 tier (liveness on port-close → in-flight → superseded) implemented and run against `createMessagePortTransport`                                                             | P2       | Medium | Medium | F3       |
| R15 | Benchmark per-render geometry transfer cost vs the web-app's `SharedPool` path; revisit `sharedMemory: false` only if cost is material                                                     | P3       | Low    | Low    | F10      |
| R16 | Once the example app stabilises, extract the React surface (RuntimeClient + viewer + Monaco + parameter form) into `@taucad/react` per Q6                                                  | P2       | High   | High   | Q6       |

## Code Examples

### The new `host` arm

```typescript
// packages/runtime/src/filesystem/runtime-filesystem-handle.ts
export type RuntimeFileSystem =
  | { readonly kind: 'inline'; readonly fs: RuntimeFileSystemBase }
  | { readonly kind: 'channel'; readonly worker: Worker }
  | { readonly kind: 'rpc'; readonly rpc: FsRpcHandle }
  | { readonly kind: 'host' };

export const fromHost = (): RuntimeFileSystem => ({ kind: 'host' });
```

### Renderer side — declaring host ownership

```typescript
// In the Electron renderer, after the preload hands us the MessagePort:
import { createRuntimeClient, replicad, esbuild } from '@taucad/runtime';
import { createMessagePortTransport } from '@taucad/runtime/transport';
import { fromHost } from '@taucad/runtime/filesystem';

const port = await window.taucad.connectKernel();
const transport = createMessagePortTransport(port);
const client = createRuntimeClient({ kernels: [replicad()], bundlers: [esbuild()], transport });

await client.connect({ fileSystem: fromHost() });
const outcome = await client.openFile({ file: '/main.ts', parameters: { size: 10 } });
```

### Host side — owning the filesystem and bridging it locally

```typescript
// In the Electron main process:
import { hostKernelOnPort } from '@taucad/runtime/transport';
import { fromNodeFS } from '@taucad/runtime/filesystem/node';
import { MessageChannelMain } from 'electron';

const fsHandle = fromNodeFS({ root: app.getPath('userData') });
if (fsHandle.kind !== 'inline') throw new Error('expected inline');

const { port1, port2 } = new MessageChannelMain();
const host = hostKernelOnPort(adaptElectronPort(port2), { fileSystem: fsHandle.fs });
mainWindow.webContents.postMessage('kernel-port', null, [port1]);
```

### `hostKernelOnPort` — the FS-injection interceptor (excerpt)

See `packages/runtime/src/transport/host-kernel-on-port.ts` for full source.

```typescript
const wrappedPort: RuntimeMessagePort = {
  postMessage(message, transferables) {
    port.postMessage(message, transferables);
  },
  onMessage(handler) {
    port.onMessage((data) => {
      const command = data as RuntimeCommand;
      if (command?.type === 'initialize' && options.fileSystem) {
        if (!bridgeDispose) {
          const bridge = createBridgePort(options.fileSystem as unknown as Record<string, unknown>);
          bridgeDispose = () => bridge.dispose();
          handler({
            ...command,
            memoryHandle: { ...(command.memoryHandle ?? {}), fileSystemPort: bridge.port },
          });
          return;
        }
      }
      handler(command);
    });
  },
  close() {
    /* … */
  },
};
```

## Diagrams

### Renderer ↔ host topology (current architecture)

```
┌─────────────────── Electron Renderer ────────────────────┐    ┌────────────── Electron Main ───────────────┐
│                                                          │    │                                            │
│   Monaco ──── RuntimeClient ──── createMessagePortTransport │   hostKernelOnPort ──── KernelRuntimeWorker   │
│   (editor)         │                       │             │    │       │                       │            │
│                    │                       │             │    │       │ injects local FS port │            │
│   Three.js ◄──── geometry events           │             │    │       ▼                       │            │
│                                            │             │    │   createBridgePort(hostFs)    │            │
│                                            │             │    │            │                  │            │
│                                            ▼             │    │            ▼                  ▼            │
│                                     MessagePort  ◄══════►│ MessagePortMain  ►  fileSystemPort (local!)     │
│                                                          │    │                                            │
└──────────────────────────────────────────────────────────┘    │   fromNodeFS({ root }) ◄── disk            │
                          ▲                                    │                                            │
                          │ open question (Findings 7, 8):     └────────────────────────────────────────────┘
                          └──────  no renderer↔host FS bridge wired yet (separate channel)
```

### What the blueprint originally implied (B-R4)

```
Renderer:  RuntimeClient ── transport ── MessagePortMain ── transport ── kernel worker (in main)
                                                                                  ▲
                                                                                  │ chunked FS RPC
                                                                                  │ multiplexed on the
                                                                                  │ same wire
                                                                                  ▼
                                                                         host FS (in main)
```

This required a chunked FS sub-protocol on the wire (B-R4). It also required the kernel's FS port to somehow originate from the renderer side, which is impossible (Finding 4).

### What we landed instead

```
Renderer:  RuntimeClient ── transport ── MessagePortMain ── transport ──┐
                                                                        │
                                                                        ▼
                                                          hostKernelOnPort intercepts 'initialize',
                                                          attaches fileSystemPort that points to
                                                          a local MessageChannel pointing at a
                                                          host-owned RuntimeFileSystemBase.

                                                          Kernel worker sees the FS as if it were
                                                          in-process. Wire never carries FS calls.
```

## References

- Blueprint: `docs/research/runtime-transport-implementation-blueprint-v4.md`
- Style reference: `docs/research/filesystem-gap-analysis.md`
- COEP: `docs/research/runtime-cross-origin-isolation-distribution.md`, `docs/research/safari-cross-origin-isolation.md`
- Memory architecture: `docs/research/shared-memory-geometry-pipeline.md`
- Source: `packages/runtime/src/transport/message-port-transport.ts`
- Source: `packages/runtime/src/transport/host-kernel-on-port.ts`
- Source: `packages/runtime/src/transport/message-port-integration.test.ts`
- Source: `packages/runtime/src/transport/transport-conformance.test.ts` (`createMessagePortTransport` describe block)
- Source: `packages/runtime/src/filesystem/runtime-filesystem-handle.ts`
- Source: `packages/runtime/src/framework/runtime-filesystem-bridge.ts` (`createBridgePort`)
- Source: `packages/runtime/src/framework/runtime-message-adapter.ts` (`RuntimeMessagePort`)
- External: [Electron `MessageChannelMain`](https://www.electronjs.org/docs/latest/api/message-channel-main)
- External: [V8 agent clusters / structured clone constraints](https://html.spec.whatwg.org/multipage/web-messaging.html#message-channels)
- External: [Playwright Electron testing](https://playwright.dev/docs/api/class-electron)
