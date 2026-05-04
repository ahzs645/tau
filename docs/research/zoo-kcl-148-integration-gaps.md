---
title: 'Zoo/KCL 0.1.148 Integration Gaps — Why `std::prelude` Fails to Load'
description: 'Root-cause investigation into the prelude/types load failure and the structural shortcomings that remain in the Tau ↔ KCL 0.1.148 engine bridge — validated against upstream zoo-modeling-app (RustContext, KclManager, ConnectionManager).'
status: active
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/zoo-kcl-148-integration-audit.md
  - docs/research/kcl-feature-surface-gaps.md
---

# Zoo/KCL 0.1.148 Integration Gaps — Why `std::prelude` Fails to Load

Root-cause investigation into the runtime "Error loading imported file (std::prelude)" / "Failed to wait for promise from send modeling command" failure that surfaces when loading any non-trivial KCL sample (e.g. `kcl-samples/bottle/main.kcl`) on the latest `@taucad/kcl-wasm-lib@0.1.148` integration. **Updated 2026-05-04** with a second-pass validation against upstream `zoo-modeling-app` (`RustContext`, `KclManager`, `ConnectionManager`, `langHelpers`, `wasm.ts`, `kcl-wasm-lib/src/context.rs`).

## Executive Summary

The user-visible "Error loading imported file (std::prelude)" message is a **red herring**. KCL's stdlib (`std::prelude`, `std::types`, …) is **embedded in the WASM binary** via `include_str!` ([`modules.rs:85-106`](#references)) and never reaches `FileSystemManager`. The wrapper is produced by `exec_ast.rs:987-1006` whenever **any** error bubbles out of executing a stdlib module — the real failure is the second line in the stack trace: **`Failed to wait for promise from send modeling command`**.

That second message is emitted by Rust's [`do_send_modeling_cmd`](#references) (`conn_wasm.rs:233-237`) when the JS-side `Promise` returned by `sendModelingCommandFromWasm` rejects with a value that is **not** a `JSON.stringify`d `FailureWebSocketResponse`. Tau's `ZooEngineBridge` rejects with a `KclError` **object** (`KclError.simple({kind:'engine', message: …})`), so Rust's `serde_json::from_str(&err_str)` always falls through to the generic "Failed to wait for promise…" branch and the engine's actual error code/message is **dropped on the floor**.

That single rejection-shape mismatch (F1) is the smoking gun for the user-visible failure. The validation pass also surfaced **eight additional architectural deltas** vs upstream (no `waitForAllEngineModelingCommands`, no `executionIsStale` reject-queue, discarded `bustCacheAndResetScene` return, no `KclErrorWithOutputs` partial-state recovery, swallowed `clearProgram` errors, …) that, while not the cause of the prelude failure, are durable correctness gaps catalogued below as **F11–F18**.

## Validation pass (2026-05-04)

A second deep audit of `repos/zoo-modeling-app` produced verdicts on the original ten findings and surfaced eight new ones. The notable corrections:

| Finding                                                                         | Status                           | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — bridge rejects with `KclError`, not JSON-string `FailureWebSocketResponse` | ✅ CONFIRMED                     | Smoking gun for the user-visible failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F2 — `fireModelingCommandFromWasm` lacks try/catch                              | ✅ CONFIRMED                     | Loses engine error context on sync throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F3 — `assignRequestId` non-exhaustive switch                                    | ✅ CONFIRMED                     | Currently safe; future-fragile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F4 — `startNewSession` no-op                                                    | 🔄 REFINED                       | Upstream's `responseMap` has **zero read sites** workspace-wide (`connectionManager.ts:90,857,876,909,1170` are all writes). Tau's no-op is **functionally correct**. Document the rationale in code; remove the "time-bomb" framing.                                                                                                                                                                                                                                                                                                                               |
| F5 — first execute skips `bustCacheAndResetScene`                               | 🔄 REFINED (not wrong, narrower) | `zoo.kernel.ts:219` calls `await utilities.clearProgram()` before **every** `executeProgram`, and `clearProgram` (`kcl-utils.ts:651-665`) **always** invokes `bustCacheAndResetScene` when `engineManager?.context` is truthy. The `hasExecutedProgram` flag gates `exportFromMemory` (`kcl-utils.ts:575`), **not** `clearProgram`. The original "skip" claim and the invented `startup_complete` reference are wrong. **Real residual gap**: see F15 (discarded `bustCacheAndResetScene` return → stale `defaultPlanes`) and F17 (`clearProgram` swallows errors). |
| F6 — pre-auth binary frames hazard                                              | 🔄 REFINED                       | `engine-connection.ts:103-114` strictly orders `transport.initialize()` (which only resolves on `modeling_session_data` per `zoo-websocket-transport.ts:337-353`) **before** `openContext()`, so the WASM `Context` never sees pre-auth bytes via the bridge's response pipe. Hazard is narrower: `transport.emitMessage` still fires for any frame that arrives between socket-open and auth-success, but no `Context` exists yet to forward to.                                                                                                                   |
| F7 — `openContext` should assert `transport.connected`                          | 🔄 REFINED → optional defensive  | Redundant under current `engine-connection.ts:103-115` ordering. Keep as a `// invariant` assert if a future refactor permits reordering.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F8 — `apiKey: ''` plumbed but always empty                                      | ✅ CONFIRMED                     | Hygiene only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F9 — `getAllFiles` semantics not asserted                                       | ✅ CONFIRMED                     | Future-proofing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F10 — stdlib embedded in WASM, no Tau gap                                       | ✅ CONFIRMED                     | Doc-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

Loading `kcl-samples/bottle/main.kcl` (and any other sample that exercises the stdlib) in the Tau editor produces this UI error:

```
Error loading imported file (std::prelude). Open it to view more details.
Error loading imported file (std::types).
Failed to wait for promise from send modeling command: JsValueError: engine: Error: engine: …
  at simple (engine-connection-…js)
  at this.handleDecodedMessage (engine-connection-…js)
  at WebSocket.onWebSocketMessage (engine-connection-…js)
```

The bridge rewrite landed under "Zoo/KCL 0.1.148 Integration: Bridge Rewrite" passes every Tau unit and integration test, yet end-to-end execution against the live Zoo engine still fails. The previous integration audit ([`zoo-kcl-148-integration-audit.md`](zoo-kcl-148-integration-audit.md)) closed the ABI rewrite questions but did not cover the **wire-error contract** between WASM ↔ JS, which turns out to be where the regression hides.

Goal: Identify every structural / mechanical mismatch between Tau's `ZooEngineBridge` / `ZooWebSocketTransport` / `ZooEngineSession` and what KCL 0.1.148's Rust `EngineConnection::do_send_modeling_cmd` (and the upstream `ConnectionManager` it was modelled on) actually expects.

## Methodology

1. **Re-read the entire WASM ↔ JS contract** straight from the kcl-lib Rust source in `repos/zoo-modeling-app/rust/kcl-lib/src/engine/conn_wasm.rs` and `fs/wasm.rs`. Treat `wasm-bindgen` `extern "C"` blocks as authoritative.
2. **Re-read the upstream JS implementation** of the engine host (`src/network/connectionManager.ts`, `connection.ts`, `websocketConnection.ts`).
3. **Re-read every line of Tau's bridge / transport / session / fs-manager** (`packages/runtime/src/kernels/zoo/{bridge,transport,session,filesystem-manager.ts}`) plus `kcl-utils.ts` and `zoo.kernel.ts`.
4. **Reconcile the two surfaces** using the published `@taucad/kcl-wasm-lib/kcl_wasm_lib.d.ts` and the generated `kcl_wasm_lib.js` glue to confirm method names crossing the boundary.
5. **Trace the user-visible error string back through the Rust code** (`exec_ast.rs:987-1006` → `conn_wasm.rs:198-238`) to identify which JS rejection shape produces which Rust message.
6. **Inspect `kcl-lib/std/prelude.kcl`** + `read_std()` to confirm the stdlib never touches `FileSystemManager`.
7. **Second-pass validation (2026-05-04)**: re-reviewed `repos/zoo-modeling-app/src/lib/rustContext.ts`, `src/lang/KclManager.ts`, `src/lang/langHelpers.ts`, `src/lang/wasm.ts`, `rust/kcl-wasm-lib/src/context.rs`, and `rust/kcl-lib/src/{frontend/api.rs, execution/mod.rs}` to validate every original finding (F1–F10) and surface any architectural delta not yet captured. Workspace-wide grep on `responseMap` and `startup_complete` was used to falsify the original F4/F5 framings. Net result: F1/F2/F3/F8/F9/F10 confirmed; F4/F6/F7 narrowed; F5 refined and split into F15+F17; eight new findings added (F11–F18).

## Findings

### Finding 1: Bridge rejects with `KclError` objects; Rust expects JSON-string `FailureWebSocketResponse` (P0 — root cause)

`do_send_modeling_cmd` (`conn_wasm.rs:198-238`) decodes the JS rejection value with **three** progressively-fallback branches:

```rust
let value = crate::wasm::JsFuture::from(promise).await.map_err(|e| {
    let err_str = e.as_string().unwrap_or_default();
    if let Ok(FailureWebSocketResponse { errors, .. }) = serde_json::from_str(&err_str) {
        // (1) e is a STRING containing JSON of FailureWebSocketResponse
        KclError::new_engine(KclErrorDetails::new(errors.iter().map(|e| e.message.clone()).join("\n"), …))
    } else if let Ok(data) = serde_json::from_str::<Vec<FailureWebSocketResponse>>(&err_str) {
        // (2) e is a STRING containing JSON of Vec<FailureWebSocketResponse>
        …
    } else {
        // (3) Fallthrough — raw JsValue debug
        KclError::new_engine(KclErrorDetails::new(format!("Failed to wait for promise from send modeling command: {:?}", e), …))
    }
});
```

Upstream `ConnectionManager` (modeling-app) honors this contract:

```ts
} catch (e) {
  if (isArray(e) && e.length > 0) {
    return Promise.reject(JSON.stringify(e[0]))   // STRING containing FailureWebSocketResponse JSON
  }
  return Promise.reject(JSON.stringify(e))        // STRING
}
```

([`connectionManager.ts:1348-1365`](#references))

Tau's bridge violates the contract everywhere it rejects:

```ts
// packages/runtime/src/kernels/zoo/bridge/zoo-engine-bridge.ts:161-166
} else {
  const errorMessage = message.errors
    .map((error) => `${error.error_code}: ${error.message}`)
    .join(', ');
  pending.reject(KclError.simple({ kind: 'engine', message: errorMessage }));
}
```

`KclError` is a class instance, not a string. When Rust calls `e.as_string()` it returns `None`, `unwrap_or_default()` produces `""`, both `serde_json::from_str` calls fail, and the fallthrough emits the generic "Failed to wait for promise from send modeling command" message — **with the engine's actual error code and message thrown away**.

Because every prelude module (`std::types`, `std::sketch`, `std::math`, …) executes engine commands during load (default planes, entity creation, etc.), the very first failure inside any stdlib module triggers `exec_ast.rs:987-1006` to wrap it as `Error loading imported file (std::prelude)`. The combined symptom is exactly what the user reports.

**This is the single highest-leverage fix.** Replacing object rejections with `JSON.stringify(message)` (or `JSON.stringify(failureResponse)` constructed from synthetic errors) gives the user — and the rest of the kcl-lib error pipeline — the **real** engine error text instead of the unhelpful wrapper.

| Rejection site (file:line)                                                  | Current value                                                                    | Required value                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bridge/zoo-engine-bridge.ts:165` (engine returned `success:false`)         | `KclError.simple({kind:'engine', message: errorMessage})`                        | `JSON.stringify(message)` — `message` is already `FailureWebSocketResponse`                                       |
| `bridge/zoo-engine-bridge.ts:88-95` (timeout)                               | `KclError.simple({kind:'engine', message:'Timed out…'})`                         | `JSON.stringify({success:false, request_id:id, errors:[{error_code:'timeout', message:'Timed out…'}]})`           |
| `bridge/zoo-engine-bridge.ts:122` (`dispose()` rejects pending)             | `KclError.simple({kind:'io', message:'Bridge disposed'})`                        | `JSON.stringify({success:false, errors:[{error_code:'bridge_disposed', message:'Bridge disposed'}]})`             |
| `bridge/zoo-engine-bridge.ts:43` (transport `socketClosed` rejects pending) | `KclError.simple({kind:'io', message:'WebSocket closed'})`                       | `JSON.stringify({success:false, errors:[{error_code:'connection_problem', message:'WebSocket closed'}]})`         |
| `bridge/zoo-engine-bridge.ts:71-76` (transport not connected before `send`) | `throw KclError.simple({kind:'io', message:'WebSocket not connected — call …'})` | Convert to async `Promise.reject(JSON.stringify({success:false, errors:[{error_code:'connection_problem', …}]}))` |

> Upstream uses literal `error_code: 'connection_problem'` for the connection-not-ready / rejected-too-early case ([`connectionManager.ts:1112-1124`](#references)) — Tau should mirror it for parity with kcl-lib's lookup tables.

### Finding 2: `fireModelingCommandFromWasm` parses JSON synchronously without `try`/`catch` (P1)

```ts
public fireModelingCommandFromWasm(id, _rangeStr, commandStr, _idToRangeStr): void {
  const envelope = JSON.parse(commandStr) as WebSocketRequest;   // throws synchronously
  assignRequestId(envelope, id);
  log.req(`fire ${JSON.stringify(envelope)}`);
  this.transport.sendRaw(envelope);                              // also throws if !connected
}
```

Rust's `wasm-bindgen` extern is `Result<(), js_sys::Error>` ([`conn_wasm.rs:32-39`](#references)) — any thrown JS error is converted to `js_sys::Error` and surfaced as `KclError::new_engine`. That path works, but the resulting message is `e.to_string()` of a generic JS error — again losing the actionable engine-error context.

Recommended: wrap the body in `try`/`catch` and **return** an `Error` instance whose `.message` is a JSON-encoded `FailureWebSocketResponse` so Rust's downstream parser can reach it (mirrors the upstream `fireModelingCommandFromWasm` behaviour at `connectionManager.ts:1278-1308`).

### Finding 3: `assignRequestId` does not cover all envelope variants (P2)

`@kittycad/lib`'s `WebSocketRequest_type` ([`models.d.ts:3095-3120`](#references)) has eight variants:

| Variant                  | ID field   | Tau handled? |
| ------------------------ | ---------- | ------------ |
| `modeling_cmd_req`       | `cmd_id`   | ✅           |
| `modeling_cmd_batch_req` | `batch_id` | ✅           |
| `trickle_ice`            | (none)     | n/a          |
| `sdp_offer`              | (none)     | n/a          |
| `ping`                   | (none)     | n/a          |
| `metrics_response`       | (none)     | n/a          |
| `debug`                  | (none)     | n/a          |
| `headers`                | (none)     | n/a          |

The current coverage is correct **today**, but the `else if` chain in `assignRequestId` silently drops the `id` parameter for any future variant the kittycad type adds. Convert to an exhaustive switch with `assertNever` to surface schema drift at compile time.

### Finding 4: `startNewSession` is a no-op (P3 — intentional, not a hazard)

`ZooEngineBridge.startNewSession()` and `MockEngineConnection.startNewSession()` both return `Promise.resolve()` with `/* intentionally empty */` comments. Upstream's implementation clears the response map:

```ts
async startNewSession() {
  this.responseMap = {}
  EngineDebugger.addLog({ … })
}
```

([`connectionManager.ts:1169-1175`](#references))

**Validation correction (2026-05-04)**: A workspace-wide grep across `repos/zoo-modeling-app/src/**` confirms `responseMap` has **zero read sites** — the only references are five **writes** (`connectionManager.ts:90,857,876,909,1170`). The map is debug bookkeeping for `EngineDebugger`; the engine never re-reads from it. Rust's `clear_scene_post_hook` calling `startNewSession` is a hygiene callback, not a state contract. Tau's no-op is **functionally correct** and remains so for the foreseeable future.

Recommended: keep the no-op but **replace the bare `/* intentionally empty */` comment** with a doc comment that cites the upstream write-only behaviour, so the next reader doesn't reopen this question. No test or implementation change required.

### Finding 5: `bustCacheAndResetScene` return value is discarded; errors are swallowed (P1 — narrowed from "first-execute skip")

**Validation correction (2026-05-04)**: The original framing of this finding was inaccurate. `KclUtilities.clearProgram` (`kcl-utils.ts:651-665`) **always** invokes `context.bustCacheAndResetScene` whenever `engineManager?.context` is truthy — there is no `hasExecutedProgram` early-return on that path (the `hasExecutedProgram` flag exists at line 288 but only guards `exportFromMemory` at line 575). And `zoo.kernel.ts:219` calls `await utilities.clearProgram()` before every `executeProgram`, so the bust runs on the first execution too. The previous reference to `connectionManager.modelingSend({type:'startup_complete'})` in the upstream flow was invented — `startup_complete` does not appear in `repos/zoo-modeling-app/src/**`. The smoking-gun "every fresh `Context` starts dirty" claim is **wrong**.

The real residual gaps in the scene-clear flow are two **smaller** but real issues:

1. **The return value of `bustCacheAndResetScene` is discarded** (`kcl-utils.ts:657`). Upstream `RustContext.clearSceneAndBustCache` consumes the returned outcome and feeds `outcome.defaultPlanes` into `setDefaultPlanes()` so subsequent operations have fresh plane IDs (`rustContext.ts:230-258`). Tau never reads back the new `defaultPlanes`, so any code path that tries to anchor sketches/cameras to a default plane after a bust is using **stale** plane IDs from the prior scene.

2. **`clearProgram` swallows all errors** via `catch (error) { log.warn(…) }` (`kcl-utils.ts:662-664`). If the bust fails (engine refusal, transport drop, schema mismatch), the very next `executeProgram` runs against an unknown scene state with no signal to the caller. Upstream propagates the error.

Recommended: capture the bust outcome, normalise it via `normalizeKclExecutionResult` (or just pull `defaultPlanes` from it), expose it on `KclUtilities` so callers can use the fresh plane IDs, and propagate errors instead of swallowing them. See R3 (revised) and the new R12.

### Finding 6: Pre-auth bridge frames — narrower hazard than originally documented (P3)

**Validation correction (2026-05-04)**: `engine-connection.ts:103-114` strictly orders `transport.initialize()` (which only resolves on `modeling_session_data` per `zoo-websocket-transport.ts:337-353`) **before** `openContext()`. The `Context` is therefore not constructed — and `transport.onMessage` is not yet subscribed by the session — until after auth-success. The bridge's `handleDecodedMessage` path is wired to `transport.onDecodedMessage` (separate channel), so the original "binary frames reach the bridge before `isConnected = true`" framing overstates the risk.

Residual hazard: `transport.emitMessage` still fires for **every** decoded frame regardless of `isConnected`, including any pre-auth status frames. Today no consumer subscribes before auth, so the frames are dropped on the floor — but a future refactor that subscribes earlier (e.g. for diagnostics) would inherit the gap.

Recommended: gate `transport.emitMessage` on `connected` and queue pre-auth frames for replay, OR add a unit test asserting the current ordering invariant. Lower priority than originally rated.

### Finding 7: `ZooEngineSession.openContext()` does not assert `transport.connected` (P3 — defensive only)

```ts
public async openContext(): Promise<void> {
  if (this.context) { return; }
  this.context = await new this.wasmModule.Context(this.bridge, this.fileSystemManager);
  this.unsubscribeResponsePipe = this.transport.onMessage((raw) => { … });
}
```

`Context::new` (`context.rs:30-59`) eagerly constructs the rayon thread pool, sets up `EngineConnection`, and registers the `ProjectManager`. None of that requires the WebSocket. Under current `engine-connection.ts:103-115` ordering, `openContext` is only called after `transport.initialize()` resolves, so the assertion would always pass. Keep as a `// invariant: caller must have completed transport.initialize()` defensive assert if a future refactor permits reordering — not a functional bug today.

### Finding 8: `apiKey: ''` literal is plumbed through but never reachable from consumers (P3, design tightening)

`zoo.kernel.ts:110` hard-codes `apiKey: ''` because the Tau API proxy injects the real bearer server-side. This is **architecturally correct** but creates four dead-code carriers:

| Owner                                   | Field                                                   | Real value used in prod                         |
| --------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `KclUtilities`                          | `apiKey`                                                | empty string                                    |
| `EngineConnection`                      | `apiKey`                                                | empty string                                    |
| `ZooWebSocketTransport`                 | `apiKey`                                                | empty string                                    |
| `ZooWebSocketTransport.onWebSocketOpen` | sends `Authorization: Bearer ` (literal trailing space) | dropped by proxy (`kernels.service.ts:264-273`) |

Send-side dead headers are mostly harmless because the proxy strips them, but they are confusing on the wire (visible in `wireshark`/`flyctl logs`) and create the wrong impression for anyone diagnosing a future direct-to-Zoo deploy. Recommended: drop `apiKey` from the bridge/transport/utilities entirely, drop the `headers` frame on connect, and let the Tau API proxy own auth. If Tau ever ships a "bring-your-own-Zoo-key" mode, reintroduce `apiKey` as an opt-in option on `zoo()`.

### Finding 9: `getAllFiles` JSDoc / Rust contract is documented but Tau's `KernelFileSystem.readdir` semantics aren't asserted (P2)

`FileSystemManager.getAllFiles` returns `JSON.stringify(files)` per the kcl-lib decoding contract (`fs/wasm.rs:115-128`, `value.as_string` + `serde_json::from_str`). Tau's implementation is correct, but `KernelFileSystem.readdir` is typed as `Promise<string[]>` and there is **no test** asserting that the returned strings are bare filenames (not full paths). If a future filesystem backend (OPFS, FsAccess, FUSE shim) returns full paths, KCL's relative-import resolution breaks silently because the prelude/types lookup uses bare names.

Recommended: add an assertion in `FileSystemManager.getAllFiles` that every returned entry is a single path segment, and add a test that mounts `kcl-samples/bottle/` and verifies `getAllFiles` returns exactly the bottle's siblings.

### Finding 10: Stdlib loading is fully embedded; `kcl-import-resolver.ts` does not need to walk `std::*` imports (✅, already correct)

`read_std()` ([`modules.rs:85-106`](#references)) is the sole source for `std::prelude`, `std::types`, etc., backed by `include_str!` against `repos/zoo-modeling-app/rust/kcl-lib/std/*.kcl`. None of these go through `FileSystemManager`. Tau's `kcl-import-resolver.ts` already skips std imports (`kcl-import-resolver.ts:29` and `:57`). No change needed — but worth documenting that **any** UI message claiming "std::prelude" was loaded from disk is a wrapper around an unrelated runtime error.

### Finding 11: No `waitForAllEngineModelingCommands` after `Context.execute` (P1 — added 2026-05-04)

Upstream `langHelpers.ts:78-82` awaits `rustContext.waitForAllEngineModelingCommands()` after **every** `rustContext.execute` / `executeMock` call. The implementation flushes all non-scene pending `sendCommand` promises (`connectionManager.ts:1368-1377`):

```ts
async waitForAllModelingCommands(): Promise<void> {
  const pendingPromises = Array.from(this.pendingCommands.values())
    .filter(c => !c.isSceneCommand)
    .map(c => c.promise)
  await Promise.allSettled(pendingPromises)
}
```

Tau's `KclUtilities.executeProgram` (`kcl-utils.ts:482-493`) returns as soon as the WASM `Context.execute` promise resolves. The kcl-lib executor only blocks on the modeling commands it explicitly awaits internally — any **fire-and-forget** modeling command (e.g. via `fireModelingCommandFromWasm`, scene cleanup batches) that the executor schedules but does not await may still be in flight when Tau's caller proceeds to the next operation (export, screenshot, parameter read). Symptom: intermittent races between `executeProgram` and the next call.

Recommended: expose `transport.waitForAllPendingCommands()` from `ZooWebSocketTransport` (or `ZooEngineBridge.flushPending()`) and await it at the end of `KclUtilities.executeProgram` and `executeProgramWithSceneDelta`.

### Finding 12: No execute serialization / `executionIsStale` / reject-pending-on-cancel (P1 — added 2026-05-04)

Upstream `KclManager` serializes `executeAst`: if a new request arrives while one is in flight, it sets `executeIsStale` and calls `connectionManager.rejectAllModelingCommands(EXECUTE_AST_INTERRUPT_ERROR_MESSAGE)` (`connectionManager.ts:1385-1396`), which rejects every pending `pendingCommands.promise` with a known interrupt sentinel. The Rust `do_send_modeling_cmd` parses that and propagates `KclError::interrupted`. After the in-flight execute returns, the queued execute replays.

Tau has no equivalent. `KclUtilities.executeProgram` is **not mutex-guarded**; concurrent calls (e.g. user changes a parameter mid-render) will interleave `sendModelingCommandFromWasm` invocations on the same bridge, with `request_id` collisions or out-of-order resolution. Failure mode: `pendingCommands.get(message.request_id)` may resolve the wrong call's promise, producing silently mismatched results.

Recommended: serialize executions via a single in-flight token on `KclUtilities`; on overlap, either queue (simple) or implement upstream's reject-and-replay (correct). Either way, also expose a `cancel()` method that calls `bridge.rejectAllPending('execute_interrupted')`.

### Finding 13: No `KclErrorWithOutputs` partial-state recovery (P1 — added 2026-05-04)

Upstream's `errFromErrWithOutputs` (`wasm.ts`) parses thrown values and **preserves** `variables`, `operations`, `artifactGraph`, `filenames`, `defaultPlanes`, `nonFatal` from the failure payload — the UI renders partial program state for recovery (e.g. the parameter panel keeps last-known values, the artifact tree keeps last-good IDs). Upstream calls this from both `RustContext.execute`'s catch and `langHelpers.handleExecuteError`.

Tau's catch in `KclUtilities.executeProgram` (`kcl-utils.ts:494-506`) only inspects the error via `extractWasmKclError` (`kcl-utils.ts:62-64`, then re-throws as `KclWasmError`). The `KclErrorWithOutputs` shape's payload (`{error, filenames, variables, operations, artifactGraph, defaultPlanes}`) is recognised by `extractWasmKclError` for the inner `error` field, but the surrounding partial state is **dropped**.

Recommended: extend `extractWasmKclError` (or add `extractKclErrorWithOutputs`) to capture the full payload, and expose it on `KclWasmError` (e.g. `error.partialOutcome?: KclExecutionResult`). UI clients (parameters panel, viewer artifact tree) can then continue to function on partial state instead of going blank on every failure.

### Finding 14: No interrupt classification (`isInterrupted`) (P2 — added 2026-05-04)

Upstream `handleExecuteError` (`langHelpers.ts`) classifies thrown errors as **interrupted** when the message matches any of `EXECUTE_AST_INTERRUPT_ERROR_STRING`, `Failed to wait for promise from send modeling command`, tear-down sentinels, or `rejected too early`. Interrupted runs are not surfaced as user-visible errors and don't update diagnostics — they just trigger the queued replay.

Tau has no notion of an interrupt vs a real failure. After fixing F1 (so the interrupt message text actually carries through), Tau should add a typed `KclInterruptedError` and avoid surfacing it to the UI.

Recommended: add `KclErrorKind: 'interrupted'`, detect either by matching the upstream sentinel strings or (better) by adding a typed `error_code: 'execution_interrupted'` field on the `FailureWebSocketResponse` we synthesise from `cancel()`.

### Finding 15: `bustCacheAndResetScene` outcome is discarded — see refined Finding 5 (P1)

Promoted as the real residual of the original F5. Upstream `RustContext.clearSceneAndBustCache` consumes the returned outcome and feeds `outcome.defaultPlanes` into `setDefaultPlanes()` so subsequent operations have fresh plane IDs (`rustContext.ts:230-258`). Tau discards the return value (`kcl-utils.ts:657`), so any code path that anchors sketches/cameras to a default plane after a bust is using **stale** plane IDs from the prior scene. Fix bundled with R12.

### Finding 16: `executeMock` `use_prev_memory` defaults differ from upstream (P3 — informational)

Tau's `executeMockKcl` passes `false` as the fourth argument to `Context.executeMock` (`kcl-utils.ts:429`); upstream's `RustContext.executeMock` defaults `use_prev_memory = true`. The semantic difference: upstream allows mock execution to inherit the prior program-memory snapshot (useful for incremental sketch tooling); Tau always discards prior memory.

For Tau's only `executeMock` use case (parameter extraction from a fresh module), `false` is **correct** — a fresh extraction should not inherit prior state. Document the divergence as intentional rather than mirror upstream.

### Finding 17: `KclExecutionResult` collapses `issues` into `errors` (P3 — added 2026-05-04)

Rust `ExecOutcome` (`execution/mod.rs:259-291`, `#[serde(rename_all = "camelCase")]`) exposes `issues` as warnings/non-fatal diagnostics distinct from the fatal `KCLError` list. Tau's `normalizeKclExecutionResult` (`kcl-utils.ts:66-88`) maps `issues || errors` to a single `errors` field, conflating warnings with failures.

Recommended: add `warnings: KclIssue[]` to `KclExecutionResult`, populate it from `execOutcome.issues` (with the `severity` field from the Rust schema), and surface them in the UI as a non-blocking diagnostic stripe.

### Finding 18: `executeProgram` discards `newGraph` / `newObjects` / `invalidatesIds` from the scene delta (P3)

`SceneGraphDelta` (`api.rs:54-61`, snake_case at the outer wrapper) carries incremental change data — `new_graph`, `new_objects`, `invalidates_ids` — alongside the inner `exec_outcome`. Tau preserves these in `executeProgramWithSceneDelta` (`kcl-utils.ts:515-560`), but **drops** them in the more common `executeProgram` path (`kcl-utils.ts:482-493`, returns only `normalizeKclExecutionResult(delta.execOutcome)`).

For Tau's render pipeline this is fine today (the kernel re-fetches GLB bytes each render), but any future incremental-update consumer (sketch UI, artifact tree diffing) needs the delta. Recommended: keep both APIs but consider returning the full delta from `executeProgram` and letting consumers project to `KclExecutionResult` if they don't need the incremental data.

### Finding summary

| #   | Title                                                                            | Severity | Failure mode if unfixed                                                                                              |
| --- | -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| F1  | Bridge rejection shape is `KclError`, not JSON-string `FailureWebSocketResponse` | **P0**   | Every engine-side error surfaces as the generic "Failed to wait for promise…" — actual error text lost (root cause)  |
| F2  | `fireModelingCommandFromWasm` lacks `try`/`catch`                                | P1       | Sync throws in the bridge surface as opaque `js_sys::Error.toString()` text                                          |
| F3  | `assignRequestId` only handles two of eight envelope variants                    | P2       | Future `WebSocketRequest_type` additions silently drop the `id`                                                      |
| F4  | `startNewSession` is no-op                                                       | P3       | None — `responseMap` is write-only upstream; documented intentional no-op                                            |
| F5  | (Refined) Original "first-execute skip" claim was wrong; promoted to F15 + F17   | P1       | See F15 (stale `defaultPlanes`) + F17 (silent bust failure)                                                          |
| F6  | Pre-auth bridge frames — narrower than originally rated                          | P3       | No bug today; future earlier-subscriber refactor inherits the gap                                                    |
| F7  | `openContext` doesn't assert `transport.connected`                               | P3       | None today; defensive only                                                                                           |
| F8  | `apiKey: ''` is plumbed end-to-end but always empty                              | P3       | Wire pollution + maintainer confusion; no functional break under proxy                                               |
| F9  | `KernelFileSystem.readdir` semantics not asserted                                | P2       | Future FS backend returning full paths breaks KCL relative-import resolution silently                                |
| F10 | Stdlib loading is in-WASM (no Tau gap)                                           | ✅       | Already correct — but worth a doc note so future debugging doesn't chase ghost FS calls                              |
| F11 | No `waitForAllEngineModelingCommands` after `Context.execute`                    | P1       | Fire-and-forget engine commands may still be in flight when caller proceeds — race with export/screenshot/parameters |
| F12 | No execute serialization / `executionIsStale` / cancel path                      | P1       | Concurrent `executeProgram` calls interleave on the same bridge — `request_id` collisions, mismatched results        |
| F13 | No `KclErrorWithOutputs` partial-state recovery                                  | P1       | UI loses last-good `variables` / `operations` / `artifactGraph` on every failure — full reset instead of partial     |
| F14 | No interrupt classification (`isInterrupted`)                                    | P2       | After F12 lands, interrupt rejections are surfaced as user-visible errors; UX divergence from KittyCAD app           |
| F15 | `bustCacheAndResetScene` outcome discarded → stale `defaultPlanes`               | P1       | Sketches/cameras anchored to default planes use stale IDs from prior scene after a bust                              |
| F16 | `executeMock` `use_prev_memory` defaults differ from upstream                    | ✅       | Intentional — Tau wants fresh parameter extraction; document divergence                                              |
| F17 | `clearProgram` swallows bust errors via `log.warn`                               | P2       | Failed bust runs silently; next `executeProgram` runs against unknown scene state                                    |
| F18 | `executeProgram` discards `newGraph`/`newObjects`/`invalidatesIds`               | P3       | No bug today; future incremental-update consumers (sketch UI, artifact diffing) need the delta                       |

## Recommendations

| #   | Action                                                                                                                                                                                                                                   | Priority | Effort | Impact   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------- |
| R1  | Fix all five `pending.reject(KclError.simple(…))` sites in `ZooEngineBridge` to reject with `JSON.stringify(failureResponse)` — see Finding 1 table                                                                                      | **P0**   | S      | **High** |
| R2  | Wrap `fireModelingCommandFromWasm` body in `try`/`catch`; return `new Error(JSON.stringify(failureResponse))` so Rust's parser reaches the engine error                                                                                  | P1       | S      | High     |
| R3  | (Revised) Capture the `bustCacheAndResetScene` return value in `KclUtilities.clearProgram`, expose fresh `defaultPlanes`, and **propagate** errors instead of `log.warn`                                                                 | P1       | S      | High     |
| R4  | Convert `assignRequestId`'s `if/else if` chain to an exhaustive `switch` with `assertNever`                                                                                                                                              | P2       | XS     | Med      |
| R5  | Gate `transport.emitMessage` on `connected`; queue + replay any pre-auth frames (or document the ordering invariant with a unit test)                                                                                                    | P3       | S      | Low      |
| R6  | Add a `// invariant` assertion `transport.connected` at the top of `ZooEngineSession.openContext()`                                                                                                                                      | P3       | XS     | Low      |
| R7  | Assert each `getAllFiles` entry is a single path segment; add a `kcl-samples/bottle/` integration test                                                                                                                                   | P2       | S      | Med      |
| R8  | Delete `apiKey` field from `KclUtilities` / `EngineConnection` / `ZooWebSocketTransport`; stop sending the `headers` frame; rely on the Tau API proxy for auth                                                                           | P3       | M      | Low      |
| R9  | Add a `engine-rejection-roundtrip.test.ts` that mocks an engine `FailureWebSocketResponse`, drives the bridge, and asserts Rust receives the structured error (use `wasm-context-contract.test.ts` style)                                | P0       | M      | High     |
| R10 | Backfill `docs/policy/kcl-engine-bridge-policy.md` capturing the JSON-string `Promise.reject` contract so future bridge changes can't regress                                                                                            | P2       | S      | Med      |
| R11 | Expose `ZooEngineBridge.flushPending()` (or `transport.waitForAllPendingCommands()`) and `await` it at the end of `executeProgram` / `executeProgramWithSceneDelta`                                                                      | P1       | S      | High     |
| R12 | Serialize `KclUtilities.executeProgram` via an in-flight token; add `KclUtilities.cancel()` that calls `bridge.rejectAllPending('execution_interrupted')` and reject with the upstream sentinel string `'kcl execution was interrupted'` | P1       | M      | High     |
| R13 | Extend `extractWasmKclError` to capture the full `KclErrorWithOutputs` payload; expose `partialOutcome?: KclExecutionResult` on `KclWasmError`                                                                                           | P1       | M      | High     |
| R14 | Add `KclErrorKind: 'interrupted'` and either match the upstream sentinel strings in `mapErrorToKclError` or add a typed `error_code: 'execution_interrupted'` field on synthetic `FailureWebSocketResponse`                              | P2       | S      | Med      |
| R15 | Add `warnings: KclIssue[]` to `KclExecutionResult`; populate from `execOutcome.issues` (with `severity` from the Rust schema); surface as non-blocking diagnostic in the UI                                                              | P3       | S      | Med      |
| R16 | Replace `/* intentionally empty */` in `startNewSession` with a doc comment citing the upstream write-only `responseMap` behaviour (closes F4 cleanly)                                                                                   | P3       | XS     | Low      |

## Code Examples

### R1 — fix the bridge rejection shape (smoking-gun fix)

```ts
// packages/runtime/src/kernels/zoo/bridge/zoo-engine-bridge.ts

private rejectAllPending(reason: { error_code: string; message: string }): void {
  for (const [requestId, pending] of this.pendingCommands) {
    clearTimeout(pending.timeoutTimer);
    const failure: WebSocketResponse = {
      success: false,
      request_id: requestId,
      errors: [reason],
    };
    pending.reject(JSON.stringify(failure));
  }
  this.pendingCommands.clear();
}

private handleDecodedMessage(message: WebSocketResponse): void {
  if (!message.success && message.errors[0]?.error_code === 'auth_token_missing') {
    return;
  }

  if (message.request_id) {
    const pending = this.pendingCommands.get(message.request_id);
    if (pending) {
      clearTimeout(pending.timeoutTimer);
      this.pendingCommands.delete(message.request_id);

      if (message.success) {
        switch (message.resp.type) {
          case 'export':
          case 'modeling':
          case 'modeling_batch':
            pending.resolve(msgpackEncode(message));
            break;
          default:
            log.warn('Unknown response type:', message.resp.type);
            pending.resolve(msgpackEncode(message));
        }
      } else {
        // CRITICAL: reject with JSON STRING so Rust's serde_json::from_str(&err_str)
        // reaches the FailureWebSocketResponse arm of conn_wasm.rs:198-238.
        pending.reject(JSON.stringify(message));
      }
    }
  }
  // batch handling unchanged…
}
```

### R3 — pre-execute scene clear

```ts
// packages/runtime/src/kernels/zoo/kcl-utils.ts

public async initializeEngine(): Promise<void> {
  if (this.isEngineInitialized) return;
  await this.initializeWasm();
  this.engineManager = await this.createEngineManager();
  await this.engineManager.initialize();

  // Always start from a known-clean engine scene. Upstream relies on the
  // user reloading the page to get this; Tau workers are long-lived per
  // tab, so we run it explicitly after every fresh engine attach.
  const ctx = this.engineManager.context;
  if (ctx) {
    const settings = JSON.stringify(this.buildKclSettings());
    await ctx.bustCacheAndResetScene(settings, undefined);
  }

  this.isEngineInitialized = true;
}
```

## Diagrams

### Error path that produces "Error loading imported file (std::prelude)"

```
KCL execute()
  └─ Rust: ProgramExecutor.run_module("std::prelude")
        ├─ read_std("prelude")   ← in-WASM include_str! (always succeeds)
        └─ exec_outcome = exec_module(prelude_ast, …)
              └─ inner_send_modeling_cmd(ENGINE_CMD)
                    └─ JS: ZooEngineBridge.sendModelingCommandFromWasm(id, …)
                          └─ transport.sendRaw(envelope)  ← OK
                          └─ wait for response  ← engine returns FailureWebSocketResponse
                                └─ JS bridge rejects with `KclError` instance  ❌
                                      └─ Rust: e.as_string() → None
                                            → unwrap_or_default() → ""
                                                  → both serde_json::from_str fail
                                                        → fallthrough message:
                                                          "Failed to wait for promise from send modeling command: …"
        └─ exec_module returns Err(KclError::engine(…))
        └─ Rust: exec_ast.rs:987-1006 wraps as
                 KclError::semantic("Error loading imported file (std::prelude)…")
```

After R1 + R2, the bottom of the chain becomes:

```
JS bridge rejects with `JSON.stringify({success:false, errors:[…]})`  ✅
  → Rust serde_json::from_str succeeds
        → KclError::engine carries the engine's actual error_code + message
              → exec_ast wrapper still adds "Error loading imported file (…)" prefix
                    → user sees the REAL underlying engine error, not the generic wrapper
```

## References

### Upstream Rust (kcl-lib 0.1.148)

- `repos/zoo-modeling-app/rust/kcl-lib/src/engine/conn_wasm.rs:24-51` — `extern "C"` engine host signature (4-arg `fire`/`send`, `startNewSession`)
- `repos/zoo-modeling-app/rust/kcl-lib/src/engine/conn_wasm.rs:139-258` — `do_fire_modeling_cmd` / `do_send_modeling_cmd` (rejection-shape decoding)
- `repos/zoo-modeling-app/rust/kcl-lib/src/engine/conn_wasm.rs:291-314` — `clear_scene_post_hook` (calls `startNewSession`)
- `repos/zoo-modeling-app/rust/kcl-lib/src/engine/mod.rs:165-250` — `EngineManager` trait (`get_default_planes`, `clear_scene`, batch flow)
- `repos/zoo-modeling-app/rust/kcl-lib/src/fs/wasm.rs:13-128` — `extern "C"` FS host signature + decode contract
- `repos/zoo-modeling-app/rust/kcl-lib/src/modules.rs:85-106, 182-198` — embedded stdlib via `read_std()`
- `repos/zoo-modeling-app/rust/kcl-lib/src/execution/exec_ast.rs:987-1006` — "Error loading imported file" wrapper

### Upstream JS (zoo-modeling-app)

- `repos/zoo-modeling-app/src/network/connectionManager.ts:90, 857, 876, 909, 1170` — every write of `responseMap` (no reads workspace-wide → confirms F4 no-op is correct)
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1168-1175` — `startNewSession` clears `responseMap`
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1265, 1298-1339` — `executionIsStale` + interrupt-string rejection (F12, F14)
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1272-1308` — `fireModelingCommandFromWasm`
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1311-1366` — `sendModelingCommandFromWasm` (`JSON.stringify(e[0])` rejection shape)
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1368-1377` — `waitForAllModelingCommands` (F11)
- `repos/zoo-modeling-app/src/network/connectionManager.ts:1385-1396` — `rejectAllModelingCommands` (F12)
- `repos/zoo-modeling-app/src/network/connectionManager.ts:699-771` — `sendCommand` envelope
- `repos/zoo-modeling-app/src/network/websocketConnection.ts:180-340` — auth + `ice_server_info` + `sdp_answer` flow
- `repos/zoo-modeling-app/src/network/connection.ts:924-952` — `Connection.send` JSON-stringify + WebSocket fan-out (modeling commands ride WS, not WebRTC)
- `repos/zoo-modeling-app/src/lib/rustContext.ts:134-258` — `RustContext.execute` / `executeMock` / `clearSceneAndBustCache` (F11, F13, F15) — note `setDefaultPlanes(outcome.defaultPlanes)` after every successful execute/bust
- `repos/zoo-modeling-app/src/lang/langHelpers.ts:68-113` — `executeAst` + `waitForAllEngineModelingCommands` + `handleExecuteError` (F11, F13, F14)
- `repos/zoo-modeling-app/src/lang/wasm.ts` — `parse`, `execStateFromRust`, `errFromErrWithOutputs` (F13)
- `repos/zoo-modeling-app/src/lang/KclManager.ts:1825-1851` — `executeAst` serialization + replay (F12)
- `repos/zoo-modeling-app/rust/kcl-wasm-lib/src/context.rs:62-71, 91-133, 205-221` — `Context::new`, `execute`, `bust_cache_and_reset_scene`, `export`
- `repos/zoo-modeling-app/rust/kcl-lib/src/frontend/api.rs:54-61` — `SceneGraphDelta` (snake_case wrapper, F18)
- `repos/zoo-modeling-app/rust/kcl-lib/src/execution/mod.rs:259-291` — `ExecOutcome` (camelCase, F17 — `issues` field)
- `repos/zoo-modeling-app/src/lang/std/fileSystemManager.ts:99-109` — upstream `getAllFiles` (TS return type `string[]` is a docstring bug; Rust expects JSON-string)

### Tau (current)

- `packages/runtime/src/kernels/zoo/bridge/zoo-engine-bridge.ts:50-167` — `ZooEngineBridge` (rejection sites)
- `packages/runtime/src/kernels/zoo/transport/zoo-websocket-transport.ts:165-364` — `ZooWebSocketTransport`
- `packages/runtime/src/kernels/zoo/session/zoo-engine-session.ts:32-74` — `ZooEngineSession`
- `packages/runtime/src/kernels/zoo/engine-connection.ts:67-125` — `EngineConnection` facade (initialize ordering)
- `packages/runtime/src/kernels/zoo/filesystem-manager.ts:26-51` — Tau's FS adapter
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:66-88` — `normalizeKclExecutionResult` (F17 — collapses `issues` into `errors`)
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:288, 575` — `hasExecutedProgram` flag (gates `exportFromMemory` only, not `clearProgram`)
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:401-447` — `executeMockKcl` (F16: `use_prev_memory: false`)
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:459-507` — `executeProgram` (F11, F12, F13, F18)
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:515-560` — `executeProgramWithSceneDelta` (preserves the delta wrapper)
- `packages/runtime/src/kernels/zoo/kcl-utils.ts:651-665` — `clearProgram` (F5 refined: always busts when context exists; F15 discards return; F17 swallows error)
- `packages/runtime/src/kernels/zoo/types/kcl-scene-graph-delta.ts:25-38` — `normalizeSceneGraphDelta`
- `packages/runtime/src/kernels/zoo/kcl-errors.ts` + `error-mappers.ts` — error taxonomy (F13, F14)
- `packages/runtime/src/kernels/zoo/source-range-utils.ts` — line/column from `SourceRange`
- `packages/runtime/src/kernels/zoo/zoo.kernel.ts:108-114, 218-228` — `apiKey: ''` literal; `createGeometry` calls `clearProgram()` before every `executeProgram`
- `packages/runtime/src/kernels/zoo/zoo.schemas.ts:15-17` — `zooOptionsSchema`
- `apps/api/app/api/kernels/kernels.service.ts:104-349` — Tau API proxy (server-side bearer auth, `headers` frame interception)
- `apps/ui/app/constants/kernel-worker.constants.ts:23` — UI wires `zoo({ baseUrl: \`${ENV.TAU_WEBSOCKET_URL}/v1/kernels/zoo\` })`

### Type definitions

- `node_modules/@kittycad/lib/dist/types/src/models.d.ts:3095-3131` — `WebSocketRequest_type` / `WebSocketResponse_type` / `FailureWebSocketResponse_type`
- `node_modules/@taucad/kcl-wasm-lib/kcl_wasm_lib.d.ts:11-121` — `Context` API (constructor takes only `(engine_manager, fs_manager)`)
- `node_modules/@taucad/kcl-wasm-lib/kcl_wasm_lib.js:1494-1770` — wasm-bindgen glue confirming the three engine + three FS extern method names
