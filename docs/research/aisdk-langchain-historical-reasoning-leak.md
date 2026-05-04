---
title: '`@ai-sdk/langchain` Historical Reasoning Leak — Nuanced Fix'
description: "Root cause + architecturally correct fix for prior-turn reasoning blocks leaking into subsequent assistant messages via the `case 'values'` re-emission path, mirroring upstream PR #11417 instead of deleting the path entirely."
status: draft
created: '2026-05-03'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/reasoning-duration-display.md
  - docs/research/cross-provider-thinking-block-portability.md
  - docs/research/aisdk-langchain-empty-reasoning-emission.md
---

# `@ai-sdk/langchain` Historical Reasoning Leak — Nuanced Fix

Root-cause analysis of why an earlier blanket-delete patch of `case 'values'` historical reasoning emission still produces incomplete "Thinking…" cards in some flows, and the architecturally correct fix that mirrors upstream PR [vercel/ai#11417](https://github.com/vercel/ai/pull/11417) (the analogous fix for tool calls).

## Executive Summary

The first iteration of the patch (`patches/@ai-sdk__langchain@2.0.147.patch`, commit pinned to `2.0.147`) removed the entire historical reasoning re-emission block from `case 'values'` because its gate (`!hasToolCalls`) collapsed to "always emit prior-turn final-answer reasoning", producing `Thought briefly` cards on every subsequent GPT-5 / OpenAI Responses API turn. The deletion fixes that primary bug (regression test `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts` passes), but it is **too coarse**: it also kills two legitimate flows — HITL-resumed messages whose reasoning was set in state but never streamed this request, and the trailing AIMessage of a turn whose reasoning content arrives only in `response_metadata.output` rather than as streaming `additional_kwargs.reasoning.summary` deltas.

The architecturally correct fix mirrors PR #11417 exactly: where that PR added a `completedToolCallIds` first pass to the values event so historical tool calls are skipped while current-turn ones still emit, this fix adds an analogous **two-axis gate for reasoning**:

1. **Persistent `streamedReasoningMessageIds: Set<string>`** in `LangGraphEventState`, populated in `case 'messages'` when a reasoning chunk is processed. Replaces the broken `wasStreamedThisRequest = !!messageSeen[msgId]` (always `false` because the cleanup loop above clears `messageSeen`).
2. **Trailing-message detection** in `case 'values'` per request — an AIMessage is "completed" iff any message follows it in the `messages` array (ToolMessage = response, HumanMessage = next turn, second AIMessage = next ReAct step). Only the trailing AIMessage is eligible for historical re-emission.

The combined gate becomes:

```text
shouldEmitReasoning =
  reasoningId &&
  !emittedReasoningIds.has(reasoningId) &&            // already streamed this request → skip
  isTrailingAssistantMessage(msgId) &&                // historical (responded to) → skip
  (streamedReasoningMessageIds.has(msgId) || !hasToolCalls)  // HITL-paused with tool calls → skip
```

This restores upstream's documented intent (see the JSDoc that was deleted in the prior patch) while making it actually work, prevents the prior-turn leak, and unblocks legitimate trailing-message reasoning. The fix is local-patch-only; an upstream issue + PR is filed separately so the patch can be dropped once a fix lands.

## Problem Statement

After `patches/@ai-sdk__langchain@2.0.147.patch` (commit `<this-PR>`) deleted the historical reasoning emission block, the original bug — `Thought briefly` leaks on every subsequent GPT-5.5 turn — is gone. But a second-order regression appears: in some streaming flows, the first reasoning of an in-progress assistant message renders as a sub-second "Thinking…" card that never advances to "Thinking for Ns" or flips to a final "Thought for Ns" duration. Subsequent reasoning blocks in the same message close cleanly (e.g. "Thought for 4s", "Thought for 3s"), but the leading one stays visually incomplete.

User-reported: live GPT-5.5 chat, mid-stream, multi-step ReAct turn (reasoning → `edit_file` → reasoning → `read_file` → reasoning → `edit_file`). Top-most reasoning shows "Thinking…" indefinitely while later reasonings render correctly.

## Methodology

Source-level investigation across:

- `node_modules/@ai-sdk/langchain/src/utils.ts` (the patched package, version `2.0.147`).
- `node_modules/.pnpm/ai@6.0.141_zod@4.3.6/node_modules/ai/dist/index.mjs` (`processUIMessageStream` reducer).
- `apps/api/app/api/chat/chat.controller.ts` (UI message stream pipeline + `createReasoningTimingTransform` insertion site).
- `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` (per-stream `Map<reasoningId, startedAtMs>`).
- `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` (header label state machine + `useReasoningStopwatch`).
- `apps/ui/app/utils/format-reasoning-duration.ts` (`<1000ms` ⇒ `"Thinking…"` / `"Thought briefly"`).
- Upstream tool-call analog: [`vercel/ai` PR #11417](https://github.com/vercel/ai/pull/11417) (added `completedToolCallIds` two-pass to `case 'values'`).
- Existing patches: `patches/@ai-sdk__langchain@2.0.147.patch` (the local patch under review) and `patches/@langchain__openai@1.4.0.patch`.
- Regression coverage: `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts` (passing — locks in the prior-turn no-leak invariant).

The trace below was reconstructed by reading the streaming path end-to-end; no live traffic capture was needed because the data flow is deterministic per chunk type.

## Findings

### Finding 1: The deleted block had two intended purposes — only one was buggy

The original block in `case 'values'` (deleted by `patches/@ai-sdk__langchain@2.0.147.patch:118`) carried this docstring:

```text
Check for reasoning content that wasn't streamed
Use reasoning block ID for deduplication as it's consistent across streaming and values.

IMPORTANT: Handle two cases differently:
1. Message has reasoning WITHOUT tool_calls → emit reasoning (pure reasoning case)
2. Message has reasoning WITH tool_calls → only emit if streamed this request
   (When resuming from HITL interrupt, historical messages have both reasoning
   AND tool_calls. We skip those to avoid duplicate reasoning entries.)
```

The implementation used:

```typescript
const wasStreamedThisRequest = !!messageSeen[msgId]; // <- always false
const hasToolCalls = toolCalls && toolCalls.length > 0;
const shouldEmitReasoning =
  reasoningId && !emittedReasoningIds.has(reasoningId) && (wasStreamedThisRequest || !hasToolCalls);
```

The bug: by the time this branch runs, the cleanup loop above (`for (const [id, seen] of Object.entries(messageSeen))`) has already `delete`d every entry — so `wasStreamedThisRequest` is always `false`, and the gate degenerates to `!hasToolCalls`. Every prior-turn final-answer message (no tool calls) replays as a synthetic `reasoning-start → delta → end` triplet, which the AI SDK reducer attaches to the **current** message's `parts` array because the chunk-id-keyed state lookup sees no matching active reasoning part for that historical id.

Deleting the entire block fixes the headline regression but discards the legitimate Case 1 path (pure-reasoning current-turn message whose content arrives only in `response_metadata.output`) and the Case 2 path's HITL guard.

### Finding 2: Where streaming reasoning gets a `reasoning-end` (and why the leading block can stall)

In the LangGraph code path (`processLangGraphEvent`):

- `case 'messages'` (utils.ts:1212-1239) emits `reasoning-start` + `reasoning-delta` chunks and sets `messageSeen[msgId].reasoning = true`. **It never emits `reasoning-end`.**
- `case 'values'` first loop (utils.ts:1300-1332) is the **sole** path that emits `reasoning-end` for streamed reasoning:

```typescript
for (const [id, seen] of Object.entries(messageSeen)) {
  if (seen.text) controller.enqueue({ type: 'text-end', id });
  // …
  if (seen.reasoning) {
    controller.enqueue({ type: 'reasoning-end', id });
  }
  delete messageSeen[id];
  // …
}
```

This is preserved by the current patch — the deletion is downstream, in the per-message historical block. So the leading-block stall is **not** a missing `reasoning-end` for properly streamed content.

The stall most likely scenario: the leading block's content was sent only via `response_metadata.output` on the values event (no `additional_kwargs.reasoning.summary` deltas during streaming) — `messageSeen[msgId].reasoning` was never set to `true`, so the first loop emits nothing for it, and the deleted block was the only path that would have emitted a synthetic triplet. Without it, the AI SDK reducer never sees any chunks for that block — so why does the UI render a "Thinking…" card at all?

Because **a different upstream chunk** still triggered the reasoning-start path. Specifically: `case 'messages'` (utils.ts:1196-1204) calls `extractReasoningId(msg)` on every chunk and unconditionally adds the id to `emittedReasoningIds`, even when `extractReasoningFromContentBlocks(msg)` returns `undefined`. If a downstream chunk in the same step finally has content, `messageSeen[msgId].reasoning` is set and `reasoning-start` fires. If no further content arrives but the values event runs, the first loop closes nothing (the entry was never set). The card appears in the UI only when at least one `reasoning-start` was emitted during streaming — i.e. the model did produce _some_ delta text before stalling on the rest.

Either way, the fix is the same: re-introduce the historical re-emission with a correct gate so values can be the ground-truth fallback for content that didn't fully stream as deltas, while continuing to suppress the prior-turn replay.

### Finding 3: Why the screenshot's "Thinking…" persists across multiple downstream tool calls

`apps/ui/app/utils/format-reasoning-duration.ts:23` renders `'Thinking…'` only when `durationMs < 1000` and `verb === 'Thinking'`. The component (`chat-message-reasoning.tsx:96-98, 247-251`) computes:

```typescript
const reasoningStartedAtMs = getReasoningStartedAtMs(part);
const finalReasoningDurationMs = getReasoningDurationMs(part);
const isReasoningStreaming = isMessageActive && finalReasoningDurationMs === undefined;
const liveReasoningElapsed = useReasoningStopwatch(reasoningStartedAtMs, isReasoningStreaming);
const reasoningLabel = isReasoningStreaming
  ? formatReasoningDuration(liveReasoningElapsed, { verb: 'Thinking' })
  : finalReasoningDurationMs === undefined
    ? 'Thought briefly'
    : formatReasoningDuration(finalReasoningDurationMs);
```

Because `useReasoningStopwatch` (`apps/ui/app/utils/use-reasoning-stopwatch.ts:42-44`) returns `0` when `startedAtMs === undefined`, a part with no `providerMetadata.common.reasoningStartedAtMs` displays "Thinking…" indefinitely while `isMessageActive === true`.

When does `reasoningStartedAtMs` end up `undefined`? `createReasoningTimingTransform` (lines 86-95) **always** stamps it on `reasoning-start`. So this only happens when:

| Scenario                                                                                        | Result                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning-start` fired through the timing transform                                            | `startedAtMs` is set                                                                                                                                             |
| `reasoning-delta` fires later carrying `providerMetadata` from upstream that **lacks** `common` | AI SDK reducer **replaces** `providerMetadata` (`ai/dist/index.mjs:5473`), dropping `common.reasoningStartedAtMs` (Finding 8 of `reasoning-duration-display.md`) |
| Reasoning part was created from a checkpoint replay that bypassed the transform                 | Persisted part has no `common` namespace at all                                                                                                                  |

The `case 'messages'` LangGraph path enqueues `reasoning-delta` chunks **without** `providerMetadata` (utils.ts:1232-1236), so they leave the start timestamp intact. The deleted historical block, however, enqueued raw triplets without `providerMetadata` — when the timing transform re-stamped the synthetic `reasoning-start` and `reasoning-end` with sub-millisecond timestamps, the reducer's replace-on-write semantics meant any prior-turn metadata was overwritten with `(t≈now, t≈now)`, producing `durationMs ≈ 0` and a "Thought briefly" leak. Removing the block fixed that side. But the trailing block needs the same path (with proper gating) to fall back to values content when streaming fell short — without falling into the same `t≈now/t≈now` collapse for prior-turn replay.

### Finding 4: The architecturally correct fix mirrors PR #11417 exactly

Upstream PR [vercel/ai#11417](https://github.com/vercel/ai/pull/11417) addressed the **tool-call** analog of this exact bug: prior-turn tool calls were being re-emitted on every values event because there was no guard against historical replay. The PR added a **two-pass** in `case 'values'`:

```typescript
// First pass — collect tool_call IDs that have already been responded to
const completedToolCallIds = new Set<string>();
for (const msg of messages) {
  if (isToolMessageType(msg)) {
    completedToolCallIds.add(toolCallId);
  }
}

// Second pass — emit tool events only for NEW tool calls
if (toolCall.id && !emittedToolCalls.has(toolCall.id) && !completedToolCallIds.has(toolCall.id)) {
  // emit tool-input-start / tool-input-available
}
```

(See utils.ts:1342-1485 for the live code.)

The reasoning branch a few lines below was never extended with the analogous logic. The architectural symmetry says: do the same for reasoning. The completion criterion for reasoning differs slightly because reasoning is attached to AIMessages (not tool calls) — an AIMessage is "completed" iff a downstream message follows it in the `messages` array:

- A ToolMessage after an AIMessage = response to that step's tool call → completed.
- A HumanMessage after an AIMessage = next user turn → completed.
- A second AIMessage after an AIMessage = next ReAct step → completed.

In all three cases, the AIMessage is no longer the head of the conversation, so its reasoning has already been finalised in a prior values event (or a prior request entirely). Only the **trailing AIMessage** of the messages array is eligible for historical re-emission.

| Axis               | Current upstream gate (broken)                                | PR #11417 tool-call equivalent           | Proposed reasoning gate                                                     |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Already emitted    | `!emittedReasoningIds.has(reasoningId)`                       | `!emittedToolCalls.has(toolCall.id)`     | `!emittedReasoningIds.has(reasoningId)` (kept)                              |
| Historical replay  | _(missing)_                                                   | `!completedToolCallIds.has(toolCall.id)` | `isTrailingAssistantMessage(msgId)` (new)                                   |
| Streamed-this-turn | `!!messageSeen[msgId]` (always false because of cleanup loop) | _(N/A — tool calls have explicit ids)_   | `streamedReasoningMessageIds.has(msgId)` (new — persistent set)             |
| HITL pause         | `!hasToolCalls` (correct fallback)                            | _(N/A)_                                  | `streamedReasoningMessageIds.has(msgId) \|\| !hasToolCalls` (kept, working) |

### Finding 5: Persistent `streamedReasoningMessageIds` is required because `messageSeen` is intentionally per-step

The cleanup loop at the top of `case 'values'` (utils.ts:1329-1331) deletes `messageSeen[id]` for every entry that fired a `reasoning-end` / `text-end` / tool finalisation. This is correct: `messageSeen` tracks the streaming-burst state since the last values event so the FIRST values event after a step can flush per-step state cleanly. But it means any read of `messageSeen[msgId]` **after** the cleanup loop is guaranteed to be `undefined`, which is exactly why upstream's `wasStreamedThisRequest = !!messageSeen[msgId]` was a no-op.

The fix is to add a parallel, request-lifetime-scoped set to `LangGraphEventState`:

```typescript
// libs/types: extend LangGraphEventState
interface LangGraphEventState {
  // … existing fields …
  /** msgIds whose reasoning was emitted via `case 'messages'` for the lifetime of this stream. */
  streamedReasoningMessageIds: Set<string>;
}
```

…populated in `case 'messages'` whenever `reasoning-start` is enqueued (utils.ts:1213-1215):

```typescript
if (!messageSeen[msgId]?.reasoning) {
  controller.enqueue({ type: 'reasoning-start', id: msgId });
  messageSeen[msgId] ??= {};
  messageSeen[msgId].reasoning = true;
  streamedReasoningMessageIds.add(msgId); // <- new, persistent
}
```

…and read in the restored historical block. This persistent set is bounded by the number of distinct AIMessages in one HTTP stream (typically 1–5 per ReAct turn) and dies with the stream, so memory cost is negligible.

### Finding 6: The persistent set is cheap; the trailing-message check is `O(messages.length)` — both fine for our scale

The `messages` array on a values event is the full LangGraph state for the current thread. After context compaction (`apps/api/app/api/chat/middleware/`), this is bounded to ≲ 60 messages by policy. A single linear scan to find the trailing AIMessage is `O(n)`; building `completedAssistantMessageIds` if we want full PR #11417 symmetry is `O(n)`. Both run once per values event (~ 3-10 per turn). No measurable impact on streaming throughput.

### Finding 7: The fix preserves Tau's regression test and adds two new ones

- **Existing test** (`apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts`): a turn-2 LangGraph stream with a prior-turn `lc_prior_checkpoint` AIMessage in `data.messages` — must still emit exactly **one** `reasoning-start` (`lc_current` only). Under the proposed fix, the trailing-message gate rejects `lc_prior_checkpoint` (not the trailing AIMessage in the array; a downstream `User2` message follows it), so the test continues to pass without modification.
- **New test 1 — HITL-paused trailing AIMessage with tool_calls**: state is `[User, AIMessage(reasoning, tool_calls)]` from a prior request that paused for HITL approval. On resume, no `case 'messages'` event fires for AIMessage's reasoning (it was streamed in the prior request and is in checkpoint state). The trailing AIMessage check passes, but `streamedReasoningMessageIds.has(msgId)` is `false` and `hasToolCalls` is `true` — so `wasStreamedThisRequest || !hasToolCalls` is `false`. Correct outcome: no re-emission, no duplicate reasoning card on the resumed turn.
- **New test 2 — Trailing-message reasoning that arrives only in `response_metadata.output`**: state is `[User, AIMessage(reasoning_in_response_metadata, no_tool_calls, no_streamed_deltas)]`. `messageSeen[msgId]` was never populated; `streamedReasoningMessageIds` is empty for this msgId; `hasToolCalls` is `false`. The gate becomes `!emittedReasoningIds.has(reasoningId) && isTrailing && (false || true) = true`. The block fires once, emitting a synthetic triplet with the values-derived content. The reasoning-timing transform stamps `reasoningStartedAtMs ≈ reasoningEndedAtMs ≈ now`, producing a `durationMs ≈ 0` "Thought briefly" — which is the **honest** rendering for content that wasn't streamed (we have no way to know how long the model actually spent thinking). The card has correct text content, just a sub-second timestamp.

### Finding 8: Out of scope — root cause of "leading block stalls without ever streaming any deltas"

If a reasoning block produces no `additional_kwargs.reasoning.summary` deltas at all but appears in `response_metadata.output` (Finding 2), there is a separate question of _why_ the model only surfaces it in the final state. This depends on OpenAI Responses API behaviour around encrypted reasoning, summary mode `auto`/`detailed`, and per-block summary suppression — orthogonal to this fix. Once the historical re-emission is restored with a correct gate, those blocks will surface as "Thought briefly" cards with correct content (Finding 7, test 2). A follow-up investigation can decide whether to instrument the timing transform to detect "values-only-derived" emission and render a different label (e.g. `"Reasoned"` without a duration), but that is a UX polish, not a correctness fix.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                          | Priority | Effort        | Impact                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- | -------------------------------------------------------------------------- |
| R1  | Update `patches/@ai-sdk__langchain@2.0.147.patch`: add `streamedReasoningMessageIds: Set<string>` to `LangGraphEventState` (in `src/types.ts` + `dist/index.mjs` + `dist/index.js`); populate it in `case 'messages'` when `reasoning-start` is enqueued                                                                                        | P0       | Low (~20 LOC) | High — primitive for the gate                                              |
| R2  | Restore the historical reasoning emission block with the corrected gate (`!emittedReasoningIds.has(reasoningId) && isTrailingAssistantMessage(msgId) && (streamedReasoningMessageIds.has(msgId) \|\| !hasToolCalls)`) — and only run the values-derived `extractReasoningFromValuesMessage(msg)` extraction when `shouldEmitReasoning === true` | P0       | Low (~30 LOC) | High — primary deliverable                                                 |
| R3  | Add `isTrailingAssistantMessage(msgId, messages)` helper (linear scan, returns `true` only when no later message in `messages` is past the AIMessage). Reuses existing `getMessageId` / `AIMessage.isInstance` / `AIMessageChunk.isInstance` from utils.ts                                                                                      | P0       | Low           | High — encapsulates the symmetry with PR #11417                            |
| R4  | Extend the existing regression test (`aisdk-langchain-values-reasoning-leak.test.ts`) — keep the prior-turn no-leak assertion; **add** the two new test cases from Finding 7 (HITL-paused, values-only trailing reasoning)                                                                                                                      | P0       | Low           | High — locks in the nuanced behaviour                                      |
| R5  | Re-run `pnpm install` to re-apply the updated patch; spot-check `node_modules/@ai-sdk/langchain/dist/index.mjs` contains `streamedReasoningMessageIds` and the restored `shouldEmitReasoning` block                                                                                                                                             | P0       | Trivial       | High — avoids stale `*patch_hash*` directories per workspace pnpm guidance |
| R6  | Manual verification on GPT-5.5 + GPT-5.3 Codex: 3-turn conversation, multi-step ReAct, confirm: (a) no leaked "Thought briefly" on subsequent turns, (b) trailing reasoning of every step closes to "Thought for Ns", (c) leading reasoning never stalls at "Thinking…" once streaming ends                                                     | P0       | Manual        | High — the user-observable acceptance criterion                            |
| R7  | File upstream issue + PR against `vercel/ai` referencing PR #11417 as precedent: the same two-pass pattern, applied to reasoning. The local patch can be dropped once merged                                                                                                                                                                    | P1       | Medium        | Medium — long-term maintenance hygiene                                     |
| R8  | (Polish, optional) Detect "values-only-derived" reasoning in the timing transform and emit a distinct label (e.g. `"Reasoned"`) so users don't see a misleading "Thought briefly" duration for content the model never streamed                                                                                                                 | P3       | Medium        | Low — UX nuance only                                                       |

## Architecture

### Data Flow After R1+R2

```
LangGraph stream
   │
   │  case 'messages' → reasoning-start { id: msgId }, reasoning-delta { id: msgId, … }
   │     ◇ adds msgId to streamedReasoningMessageIds   ← R1
   │     ◇ adds reasoningId to emittedReasoningIds
   │
   │  case 'values'  ────────────────────────────────────
   │     ┌─ first loop (preserved):
   │     │     for each messageSeen[id]:
   │     │        emit reasoning-end { id }
   │     │        delete messageSeen[id]   ← cleared, that's WHY R1's persistent set is needed
   │     │
   │     ├─ tool-call two-pass (PR #11417, preserved):
   │     │     completedToolCallIds = ToolMessages in messages
   │     │     for each msg, emit only NEW tool calls
   │     │
   │     └─ historical reasoning re-emission (R2):
   │           messagesArr = data.messages
   │           trailingAssistantId = last AIMessage with no downstream message
   │           for each msg in messagesArr:
   │              reasoningId = extractReasoningId(msg)
   │              gate = reasoningId
   │                  && !emittedReasoningIds.has(reasoningId)
   │                  && msg.id === trailingAssistantId
   │                  && (streamedReasoningMessageIds.has(msg.id) || !hasToolCalls)
   │              if gate:
   │                 emit reasoning-start { id: msg.id }
   │                 emit reasoning-delta { id, delta: extractReasoningFromValuesMessage(msg) }
   │                 emit reasoning-end   { id }
   │                 emittedReasoningIds.add(reasoningId)
   ▼
createReasoningTimingTransform → stamps providerMetadata.common.{startedAtMs, endedAtMs}
   ▼
... rest of pipeline ...
   ▼
processUIMessageStream reducer → MyUIMessage with reasoning parts
   ▼
ChatMessageReasoning → "Thought for Ns" / "Thought briefly" / "Thinking for Ns"
```

### Code Examples

**Patch hunk for `src/types.ts`** (and mirror into `dist/index.mjs` / `dist/index.js`):

```diff
 export interface LangGraphEventState {
   // … existing fields …
   /** Maps tool call key (name:argsJson) to tool call ID for HITL interrupt handling */
   emittedToolCallsByKey: Map<string, string>;
   /** Tracks the last-seen summary_index per message ID for newline injection at index boundaries */
   messageSummaryIndices: Record<string, number>;
+  /** msgIds whose reasoning was emitted via `case 'messages'` for the lifetime of this HTTP stream. Persistent counterpart to the per-step `messageSeen[msgId]` flag (which is cleared in `case 'values'`'s first loop). */
+  streamedReasoningMessageIds: Set<string>;
 }
```

**Patch hunk for `src/utils.ts` `case 'messages'`** (and dist mirrors):

```diff
   if (!messageSeen[msgId]?.reasoning) {
     controller.enqueue({ type: 'reasoning-start', id: msgId });
     messageSeen[msgId] ??= {};
     messageSeen[msgId].reasoning = true;
+    streamedReasoningMessageIds.add(msgId);
   }
```

**Patch hunk for `src/utils.ts` `case 'values'` (replacing the comment we left after deletion):**

```diff
-            // Tau patch: historical reasoning re-emission removed — see package src/utils.ts (`case 'values'`).
+            // Tau patch (mirroring vercel/ai#11417 for reasoning):
+            // Re-emit reasoning ONLY for the trailing AIMessage whose reasoning
+            // didn't fully stream as deltas. Prior-turn AIMessages are filtered
+            // out by the trailing-message check; HITL-paused AIMessages with
+            // tool calls are filtered by `streamedReasoningMessageIds || !hasToolCalls`.
+            const reasoningId = extractReasoningId(msg);
+            const isTrailing = msgId === trailingAssistantMessageId;
+            const wasStreamedThisRequest = streamedReasoningMessageIds.has(msgId);
+            const hasToolCalls = toolCalls && toolCalls.length > 0;
+            const shouldEmitReasoning =
+              reasoningId &&
+              !emittedReasoningIds.has(reasoningId) &&
+              isTrailing &&
+              (wasStreamedThisRequest || !hasToolCalls);
+
+            if (shouldEmitReasoning) {
+              const reasoning = extractReasoningFromValuesMessage(msg);
+              if (reasoning) {
+                controller.enqueue({ type: 'reasoning-start', id: msgId });
+                controller.enqueue({ type: 'reasoning-delta', delta: reasoning, id: msgId });
+                controller.enqueue({ type: 'reasoning-end', id: msgId });
+                emittedReasoningIds.add(reasoningId);
+              }
+            }
```

The `trailingAssistantMessageId` is computed once per values event before the per-message loop:

```typescript
let trailingAssistantMessageId: string | undefined;
for (let i = messages.length - 1; i >= 0; i--) {
  const m = messages[i];
  if (!m || typeof m !== 'object') continue;
  const isAI =
    AIMessageChunk.isInstance(m) ||
    AIMessage.isInstance(m) ||
    (isPlainMessageObject(m) &&
      ((m as { type?: string }).type === 'ai' ||
        (Array.isArray((m as { id?: unknown }).id) &&
          ((m as { id: string[] }).id.includes('AIMessageChunk') ||
            (m as { id: string[] }).id.includes('AIMessage')))));
  if (isAI) {
    // The trailing AIMessage is the one with no later message in the array.
    if (i === messages.length - 1) {
      trailingAssistantMessageId = getMessageId(m);
    }
    break;
  }
}
```

(Equivalent: any AIMessage with `i < messages.length - 1` is "completed". The implementation finds the trailing one and compares by id.)

### Edge Cases

| Case                                                                                                                      | Handling                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty `messages` array (initial state)                                                                                    | `trailingAssistantMessageId` is `undefined`; gate's `isTrailing` term is `false` for every msg → no emission, same as today                                                                                                                         |
| Trailing message is a `HumanMessage` (start of a new turn before any AIMessage streamed)                                  | No AIMessage matches `trailingAssistantMessageId`; gate falls through cleanly                                                                                                                                                                       |
| Trailing AIMessage has reasoning that DID stream as deltas                                                                | `emittedReasoningIds.has(reasoningId)` is `true` → skipped; first-loop `reasoning-end` already closed it cleanly                                                                                                                                    |
| Trailing AIMessage with `additional_kwargs.reasoning.summary` chunks streamed but no `response_metadata.output` reasoning | `extractReasoningFromValuesMessage(msg)` returns `undefined` → no emission. First-loop `reasoning-end` already closed the deltas-derived part                                                                                                       |
| Trailing AIMessage from HITL-paused prior request                                                                         | `wasStreamedThisRequest === false` and `hasToolCalls === true` → skipped, matches upstream's documented intent                                                                                                                                      |
| `additional_kwargs.reasoning.id` is missing on every chunk (model didn't surface IDs)                                     | `extractReasoningId` returns `undefined` → gate is `false` → no emission. Matches today's behaviour                                                                                                                                                 |
| Streaming aborted mid-block (no `reasoning-end`)                                                                          | First loop never runs (no values event); part stays at `state: 'streaming'`, `reasoningEndedAtMs` undefined; UI's `isMessageActive` flips to `false` when chat ends → falls through to `'Thought briefly'` per `chat-message-reasoning.tsx:249-251` |
| Subgraph reasoning aggregated in parent values event                                                                      | If subgraph state's trailing AIMessage is also the parent's trailing AIMessage and reasoning ID wasn't streamed, the gate fires once cleanly                                                                                                        |
| Multiple reasoning IDs on one trailing AIMessage (interleaved reasoning)                                                  | The block iterates per `msg`, not per reasoning ID. As today, only one synthetic triplet per AIMessage. Acceptable: streaming path handles inter-block separators via `messageSummaryIndices`                                                       |

## Trade-offs

| Approach                                                                                               | Pros                                                                                                                                                                                        | Cons                                                                                                                                                                                        | Verdict                                             |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Restore historical block with PR #11417-style two-axis gate (R1+R2+R3)**                             | Mirrors upstream's working tool-call pattern; preserves Case 1 (pure-reasoning trailing AIMessage) and Case 2 (HITL guard); existing regression test still passes; upstream-mergeable as-is | Adds one persistent `Set<string>` (≲ a few entries / stream); slightly larger patch surface than the current blanket-delete                                                                 | **Adopt**                                           |
| Keep the blanket-delete and rely on streaming + `messageSeen` finalisation alone                       | Smallest patch; current state                                                                                                                                                               | Drops Case 1 and Case 2 silently; produces stuck "Thinking…" cards when content arrives only in `response_metadata.output`; can't be merged upstream because it removes legit functionality | Reject — the user-reported regression is real       |
| Rebuild the gate against `messageSeen` only, accepting the existing `wasStreamedThisRequest` behaviour | Smallest possible diff over current state                                                                                                                                                   | `wasStreamedThisRequest` is permanently broken (cleanup loop above); equivalent to the original buggy gate                                                                                  | Reject — same bug                                   |
| Move the reasoning re-emission into a **post-stream** finalize step (after the iterator drains)        | Avoids interleaving with first-loop emission                                                                                                                                                | Loses real-time UX (reasoning surfaces only after the entire turn ends); architecturally divergent from PR #11417's per-event approach                                                      | Reject — wrong layer                                |
| Drop `streamMode: ['values']` entirely from `agent.graph.stream`                                       | No values event = no replay path                                                                                                                                                            | Loses tool-input-available emission for non-streamed tool calls (PR #11417's path), state finalisation (`reasoning-end` / `text-end`); breaking change for many flows                       | Reject — used elsewhere                             |
| File only the upstream PR (no local patch update)                                                      | Long-term maintenance ideal                                                                                                                                                                 | Local users see the regression for the upstream PR cycle (weeks-to-months); the current patch is already a deliberate local-fix per the previous plan                                       | Reject as standalone — combine with R1-R6 (do both) |

## References

- [vercel/ai PR #11417 — "Skip already-completed historical tool calls in `case 'values'`"](https://github.com/vercel/ai/pull/11417) (the architectural precedent for this fix)
- `patches/@ai-sdk__langchain@2.0.147.patch` (the local patch under revision)
- `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts` (existing regression test — extend per R4)
- `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` (downstream consumer of the start/end timestamps)
- `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` (label state machine)
- `apps/ui/app/utils/format-reasoning-duration.ts` (`<1000ms` → `'Thinking…'` / `'Thought briefly'`)
- Related Tau research: [`docs/research/reasoning-duration-display.md`](./reasoning-duration-display.md) (Finding 8 — replace-on-write `providerMetadata` semantics)
- Related Tau research: [`docs/research/cross-provider-thinking-block-portability.md`](./cross-provider-thinking-block-portability.md) (cross-provider reasoning shape rules)

## Appendix: Implementation Plan (Sequenced)

Concrete order of operations to land R1–R6. Track in a separate plan file under `/Users/rifont/.cursor/plans/` per workspace convention; do not re-author here.

1. Open the working patch directory: reuse the existing `node_modules/.pnpm_patches/@ai-sdk/langchain@2.0.147` (the previous patch's workspace, still on disk per the previous plan's audit notes), or re-run `pnpm patch @ai-sdk/langchain@2.0.147` if it was cleared.
2. Edit `src/types.ts`: add `streamedReasoningMessageIds: Set<string>` to `LangGraphEventState`.
3. Edit `src/utils.ts` `toUIMessageStream` initialiser: add `streamedReasoningMessageIds: new Set<string>()` to the state literal.
4. Edit `src/utils.ts` `processLangGraphEvent` destructuring: pull `streamedReasoningMessageIds` from `state`.
5. Edit `src/utils.ts` `case 'messages'` reasoning branch: add `streamedReasoningMessageIds.add(msgId)` immediately after setting `messageSeen[msgId].reasoning = true`.
6. Edit `src/utils.ts` `case 'values'`:
   - Compute `trailingAssistantMessageId` once per event (linear scan).
   - Replace the current `// Tau patch: historical reasoning re-emission removed …` comment with the gated emission block from the patch hunk in [Code Examples](#code-examples).
7. Mirror all source edits into `dist/index.mjs` and `dist/index.js` (verbatim — no logic divergence).
8. `pnpm patch-commit <workspace-dir>` to refresh `patches/@ai-sdk__langchain@2.0.147.patch`. Confirm `package.json`'s `patchedDependencies` still references the same path.
9. `pnpm install` → spot-check `node_modules/@ai-sdk/langchain/dist/index.mjs` contains `streamedReasoningMessageIds` and the restored `shouldEmitReasoning` block.
10. Update `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts`:
    - Keep the existing single-`reasoning-start` assertion (Finding 7).
    - Add a HITL-paused test (Finding 7, test 1).
    - Add a values-only trailing reasoning test (Finding 7, test 2).
11. Run `pnpm nx typecheck api` and `pnpm nx test api ./app/testing/aisdk-langchain-values-reasoning-leak.test.ts ./app/api/chat/interrupted-tool-roundtrip.test.ts ./app/api/chat/chat.service.test.ts --watch=false`.
12. Manual verification per R6 on GPT-5.5 + GPT-5.3 Codex.
13. Commit + push the updated patch and tests on the same branch as the original deletion.
14. Open the upstream issue + PR per R7 (track separately so the local patch's lifetime is not gated on upstream review).
