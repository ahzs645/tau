---
title: 'Chat Error Persistence Stale Display'
description: 'Root cause analysis of chat error banner not clearing after a new successful message is sent'
status: resolved
created: '2026-04-15'
updated: '2026-04-20'
category: investigation
related:
  - docs/policy/xstate-policy.md
---

# Chat Error Persistence Stale Display

Investigation into why the chat error banner persists after a new successful message is sent, despite the AI SDK clearing its runtime error state.

## Executive Summary

The `chatPersistenceMachine`'s `errorPersistence` sub-machine has a missing `assign` action on the `clearPersistedError` transition from `idle` state. When a user sends a new message after an error, the AI SDK clears `chat.error` synchronously, but the `persistedError` in the XState machine context is only cleared after an async IndexedDB write completes. The `ChatError` component's selector falls through from the cleared `chat.error` to the still-set `persistedError`, displaying a stale error banner.

## Problem Statement

After a chat error occurs (e.g., credit balance too low, rate limit), sending a new successful message does not clear the error banner. The error remains visible even though the new request is proceeding normally.

## Methodology

Source analysis of the error display pipeline: `ChatError` component selector → `useChatSelector` → `chatPersistenceMachine` error states → AI SDK `useChat` error lifecycle. Traced the event flow from `useChatActions.sendMessage` through the XState machine transitions and AI SDK's `makeRequest` method.

## Findings

### Finding 1: Asymmetric `clearPersistedError` handling across states

The `errorPersistence` sub-machine in `apps/ui/app/hooks/chat-persistence.machine.ts` handles `clearPersistedError` differently depending on the current state:

| Source state | Transition              | Immediate assign?                                 |
| ------------ | ----------------------- | ------------------------------------------------- |
| `idle`       | `idle → clearing`       | **No** — `persistedError` stays in context        |
| `persisting` | `persisting → clearing` | **Yes** — `assign({ persistedError: undefined })` |

The `persisting → clearing` transition (line 278-283) correctly clears `persistedError` from in-memory context immediately. The `idle → clearing` transition (line 248-251) omits this action, deferring the clear until `clearErrorActor` completes asynchronously.

### Finding 2: Two-layer error display with fallthrough

The `ChatError` component (`apps/ui/app/routes/projects_.$id/chat-error.tsx`, line 41-47) uses a two-layer selector:

```typescript
const parsedError = useChatSelector((state) => {
  if (state.error) {
    return parseErrorForPersistence(state.error);
  }
  return state.persistedError;
});
```

- `state.error`: Runtime error from AI SDK's `useChat` — cleared synchronously by `makeRequest` via `setStatus({ status: 'submitted', error: undefined })`
- `state.persistedError`: Persisted error from the XState machine — survives page reload, cleared asynchronously via IndexedDB write

When the AI SDK clears `state.error` (synchronous), the selector falls through to `state.persistedError` which is still set (async clear pending).

### Finding 3: The bug timeline

After an error, the `errorPersistence` sub-machine is typically in `idle` (the `persistErrorActor` has already completed). When the user sends a new message:

1. `useChatActions.sendMessage` sends `clearPersistedError` to the machine
2. Machine transitions `idle → clearing` (no assign — `persistedError` still set)
3. `chat.sendMessage(message)` calls AI SDK's `makeRequest`
4. `makeRequest` synchronously sets `error: undefined` via `setStatus`
5. React re-renders: `state.error = undefined`, falls through to `state.persistedError` (still set)
6. Error banner remains visible
7. Eventually `clearErrorActor` completes → `onDone` assigns `persistedError: undefined`
8. Error banner finally disappears

If the IndexedDB write in step 7 is slow or hangs, the error banner persists indefinitely.

### Finding 4: Existing test gap

The existing test (`apps/ui/app/hooks/chat-persistence.machine.test.ts`, line 274-297) only verifies `persistedError` is `undefined` after `waitFor` completes (i.e., after the async actor finishes). It does not assert that `persistedError` is cleared from context immediately upon receiving the `clearPersistedError` event.

## Recommendations

| #   | Action                                                                                                                                      | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | ~~Add `actions: assign({ persistedError: undefined })` to the `clearPersistedError` transition in `idle` state~~ — superseded by R3         | P0       | Low    | High   |
| R2  | Add test asserting `persistedError` is cleared immediately (before async actor completes)                                                   | P0       | Low    | Medium |
| R3  | Centralize the chat request lifecycle inside `chatPersistenceMachine` so every entry point clears `persistedError` synchronously (Option B) | P0       | Med    | High   |

## Resolution (Option B): `requestLifecycle` parallel state

The asymmetric-clear bug was the smoking gun, but the underlying footgun was deeper: every "request starts" call site (`sendMessage`, `regenerate`, `editMessage`, `retryMessage`) had to remember to dispatch a clear before invoking the AI SDK. `editMessage` and `retryMessage` simply did not. Patching just R1 would have fixed the reported regression but left the same trap for the next entry point.

We instead pulled the entire request lifecycle into a new `requestLifecycle` parallel state on `chatPersistenceMachine` so the synchronous clear happens once, in the only state machine transition that matters.

### Architecture

```
ChatProvider                       chatPersistenceMachine
─────────────                      ──────────────────────
useChatActions.sendMessage(msg) ─► startRequest event
                                   ├─ assign({ persistedError: undefined })  (synchronous)
                                   └─ emit({ type: 'dispatchRequest', request })
                                                              │
                ┌──── persistenceActorRef.on('dispatchRequest', listener) ◄──┘
                │
                ▼
            chat.sendMessage(msg)  (AI SDK clears chat.error synchronously)
```

Both layers (`chat.error` and `persistedError`) clear in the same React frame because:

1. The `assign` runs inside the `startRequest` transition.
2. The `emit` fires synchronously inside that same transition.
3. The listener dispatches the AI SDK call before React re-renders.

`requestLifecycle` is `idle | invoking | stopping`, encoding queue-while-streaming, pure stop, and request resumption directly in the machine instead of `pendingMessageRef` / `queueMicrotask` orchestration in React.

| Substate   | On `startRequest`                                                            | On `stopRequest`             | On `requestFinished`                                                                                                  |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `idle`     | → `invoking`; clear `persistedError`; `dispatchRequest`                      | (ignored)                    | (ignored)                                                                                                             |
| `invoking` | → `stopping`; clear `persistedError`; queue `pendingRequest`; `dispatchStop` | → `stopping`; `dispatchStop` | → `idle`; preserve `persistedError` only when `isError`; `applyFinishedRequest`                                       |
| `stopping` | clear `persistedError`; replace `pendingRequest`                             | (already stopping)           | guard pendingRequest: → `invoking` + `applyResumedRequest` + `dispatchRequest`; else → `idle` + `applyStoppedRequest` |

The `applyStoppedRequest` listener finalizes interrupted tool parts and marks the trailing user message as `cancelled` so loading the chat later does not auto-regenerate.

### Side-effect contract

The machine emits five events; `ChatProvider` subscribes via `persistenceActorRef.on(...)` and translates them into AI SDK calls. The listeners read the live chat through a `chatRef` so the effect never re-subscribes.

| Emit                   | Listener side effect                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `dispatchRequest`      | `chat.sendMessage` / `chat.regenerate` / `setMessages` + `regenerate` (edit/retry)   |
| `dispatchStop`         | `chat.stop()`                                                                        |
| `applyFinishedRequest` | `setMessages(finalizeInterruptedToolParts(messages))` + `queuePersist`               |
| `applyStoppedRequest`  | Sanitize + mark trailing pending user message `cancelled` + `queuePersist`           |
| `applyResumedRequest`  | Sanitize + `queuePersist` (the resumed request fires via the next `dispatchRequest`) |

### Test coverage

The bug is now anchored at two layers:

- **Machine** (`apps/ui/app/hooks/chat-persistence.machine.test.ts`) — `describe('requestLifecycle')` covers all transitions, the synchronous-clear contract, queue-then-resume, pure-stop cancellation, mid-stream error preservation, and `pendingRequest` replacement semantics. Emits are captured via `actor.on(...)`.
- **Provider** (`apps/ui/app/hooks/use-chat.test.tsx`) — Drives `ChatProvider` end-to-end with a fake AI SDK chat, asserting that each `useChatActions` call routes to the right `chat.*` method, that `persistedError` is `undefined` in the same React frame as the action call (no flicker) for `sendMessage` / `editMessage` / `retryMessage`, that queue-while-streaming dispatches the queued request after `onFinish({ isAbort: true })`, and that mid-stream errors survive `requestFinished`.

R2 is closed out by the no-flicker tests, which assert `persistedError` synchronously immediately after the `act(...)` block — there is no async window left for the banner to flash.

## References

- `apps/ui/app/hooks/chat-persistence.machine.ts` — XState machine, including the `requestLifecycle` parallel state
- `apps/ui/app/hooks/chat-persistence.machine.test.ts` — machine-level lifecycle tests with emit capture
- `apps/ui/app/hooks/use-chat.tsx` — `ChatProvider` lifecycle subscriptions; `useChatActions` thin event forwarders
- `apps/ui/app/hooks/use-chat.test.tsx` — provider integration tests, including the no-flicker contract
- `apps/ui/app/routes/projects_.$id/chat-error.tsx` — `ChatError` component with two-layer error selector
- `node_modules/ai/src/ui/chat.ts` — AI SDK `makeRequest` clears error at line 612
