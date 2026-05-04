---
title: 'KCL Engine Bridge Policy'
description: 'Contracts for the Zoo modeling WebSocket bridge, WASM error extraction, and KCL execute serialization.'
status: active
created: '2026-05-04'
updated: '2026-05-04'
related:
  - docs/research/zoo-kcl-148-integration-gaps.md
---

# KCL Engine Bridge Policy

Internal reference for Tau's Zoo/KCL WASM integration: how modeling commands fail over the wire, how errors are normalized for Rust/`kcl-lib`, and how the runtime serializes engine work.

## Rationale

The KCL WASM module expects engine failures as JSON shaped like `FailureWebSocketResponse` on the JavaScript Promise rejection path. Narrow TypeScript unions from `@kittycad/lib` do not cover every runtime `error_code` the engine emits. Tau keeps wire JSON wide while preserving typed handling at domain boundaries.

## Rules

### 1. JSON-string rejection contract

When rejecting a pending `sendModelingCommandFromWasm` (or synthesizing bridge failures such as timeouts), reject with **`JSON.stringify(...)`** of an object shaped like `FailureWebSocketResponse` (`success: false`, `errors: [{ error_code, message }]`, optional `request_id`).

**Why**: Rust's WASM path parses the string via `serde_json::from_str` into a structured failure; throwing opaque `Error` objects loses the engine diagnostic.

CORRECT:

```typescript
pending.reject(
  JSON.stringify({
    success: false,
    request_id: id,
    errors: [{ error_code: 'timeout', message: 'Timed out waiting…' }],
  }),
);
```

INCORRECT:

```typescript
pending.reject(KclError.simple({ kind: 'engine', message: 'timeout' }));
```

### 2. Assign modeling request IDs only on modeling envelopes

Call sites that assign `cmd_id` / `batch_id` must branch on `WebSocketRequest['type']` for **`modeling_cmd_req`** and **`modeling_cmd_batch_req`** only. All other request types must throw — they must never be passed through the modeling send path.

**Why**: Prevents silent no-ops if WASM ever forwards an unexpected envelope shape.

### 3. `flushPending` after `Context.execute`

After each successful `Context.execute` (engine path), **`await bridge.flushPending()`** so all in-flight modeling round-trips settle before returning `KclExecutionResult` / `KclSceneGraphDelta` to callers.

**Why**: Matches upstream `waitForAllPendingCommands` semantics; avoids racing teardown or follow-up export on a draining bridge.

### 4. Execute serialization

`KclUtilities.executeProgram` / `executeProgramWithSceneDelta` must be **mutually exclusive** — overlapping calls serialize through a single promise chain so only one `Context.execute` runs at a time per utilities instance.

**Why**: WASM/engine state is not safe for arbitrary interleaving of executes from concurrent callers.

### 5. Partial outcome on `KclErrorWithOutputs`

When WASM returns a `KclErrorWithOutputs` payload, extraction must preserve **variables / operations / artifactGraph / filenames / defaultPlanes / nonFatal** into `KclWasmError.partialOutcome` (as `KclExecutionResult` fields where applicable).

**Why**: UI and tooling can surface partial state instead of blanking the viewer/parameters on recoverable failures.

## Anti-Patterns

- **Client-side `Authorization` headers on the modeling WebSocket** — Tau authenticates via the API proxy / same-origin session; do not send `Bearer` API-key frames from the runtime transport.

- **Replaying pre-auth frames to subscribers** — `emitMessage` must not deliver handler callbacks until the transport is **`connected`** (post-`modeling_session_data`).

## Summary Checklist

- [ ] Bridge synthetic failures use JSON-string `FailureWebSocketResponse` rejects.
- [ ] Only modeling command envelopes receive request id assignment.
- [ ] `flushPending` awaited after successful engine execute.
- [ ] Execute paths serialized per `KclUtilities` instance.
- [ ] `KclErrorWithOutputs` maps to `partialOutcome` when present.

## Required test coverage

- **Real WASM `executeMock` path** — At least one integration test per `kcl-wasm-lib` bump must call the actual `Context.executeMock` (or equivalent) on a trivial program so `eval_prelude` and embedded `std::*` modules are exercised. Example: `packages/runtime/src/kernels/zoo/kcl-bottle-sample.integration.test.ts`. Stubbing `Context.execute` with `vi.fn` is fine for bridge / `flushPending` / cancel tests, but must not be the only guard against std-prelude or WASM ABI regressions.
- **Traceability** — Use opt-in worker logging via [`packages/runtime/src/kernels/zoo/zoo-logs.ts`](../../packages/runtime/src/kernels/zoo/zoo-logs.ts) (`ZOO_DEBUG` / log levels) before rebuilding fork WASM for deeper Rust-side investigation (see `docs/research/zoo-kcl-std-prelude-load-failure.md` Finding 11).

## References

- Research: `docs/research/zoo-kcl-148-integration-gaps.md`
