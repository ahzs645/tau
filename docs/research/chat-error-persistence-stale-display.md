---
title: 'Chat Error Persistence Stale Display'
description: 'Root cause analysis of chat error banner not clearing after a new successful message is sent'
status: active
created: '2026-04-15'
updated: '2026-04-15'
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

| #   | Action                                                                                                       | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Add `actions: assign({ persistedError: undefined })` to the `clearPersistedError` transition in `idle` state | P0       | Low    | High   |
| R2  | Add test asserting `persistedError` is cleared immediately (before async actor completes)                    | P0       | Low    | Medium |

## Code Examples

### Before (idle state)

```typescript
clearPersistedError: {
  target: 'clearing',
  guard: 'canPersist',
},
```

### After (idle state, matching persisting state pattern)

```typescript
clearPersistedError: {
  target: 'clearing',
  guard: 'canPersist',
  actions: assign({ persistedError: undefined }),
},
```

## References

- `apps/ui/app/hooks/chat-persistence.machine.ts` — XState machine with `errorPersistence` sub-machine
- `apps/ui/app/hooks/use-chat.tsx` — `ChatProvider` wiring `onError`/`onFinish`/`sendMessage`
- `apps/ui/app/routes/projects_.$id/chat-error.tsx` — `ChatError` component with two-layer error selector
- `node_modules/ai/src/ui/chat.ts` — AI SDK `makeRequest` clears error at line 612
