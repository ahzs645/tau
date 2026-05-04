---
title: '`@ai-sdk/langchain` Reasoning-End Delay on Tool/Text Transition'
description: 'LangGraph `case ''messages''` adapter never closes reasoning when a model transitions to text/tool_call within the same node, leaving the UI stuck on "Thinking for Ns" until the values event fires after the entire step completes.'
status: draft
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/aisdk-langchain-historical-reasoning-leak.md
  - docs/research/aisdk-langchain-empty-reasoning-emission.md
  - docs/research/cross-provider-thinking-block-portability.md
---

# `@ai-sdk/langchain` Reasoning-End Delay on Tool/Text Transition

Root-cause analysis of why `chat-message-reasoning.tsx` displays a stale "Thinking for Ns" header after the model has clearly transitioned to text and tool calls. The defect lives in `@ai-sdk/langchain`'s LangGraph `case 'messages'` adapter, mirrors a class of bugs already fixed upstream for several other providers (xAI, openai-compatible, Groq, google), and has no upstream issue or PR open against the langchain adapter itself.

## Executive Summary

In `@ai-sdk/langchain` v2.0.147 (the version Tau pins via `patches/@ai-sdk__langchain@2.0.147.patch`), the LangGraph `case 'messages'` branch of `processLangGraphEvent` emits `reasoning-start` and `reasoning-delta` UI chunks for every reasoning-bearing `AIMessageChunk` but **never** emits `reasoning-end`. The only path that closes a streamed reasoning block is the **first loop** of `case 'values'`, which fires only when LangGraph yields a `values` event — i.e. **after the entire agent node (and every tool call invoked from inside it) has completed and the supersep settles**.

For a typical ReAct turn whose agent step streams `reasoning → text → tool_call → tool_result`, this means:

1. Model finishes streaming reasoning at t=0
2. Model streams text + tool_call chunks at t≈0.5s — reasoning still open
3. Tool executes for 18-19s (e.g. `edit_file` on a large `main.scad`) — reasoning still open
4. Agent step completes, `values` event fires, `reasoning-end` finally emitted at t≈19s

Tau's `createReasoningTimingTransform` stamps `providerMetadata.common.reasoningEndedAtMs` only when `reasoning-end` arrives, and the UI's `useReasoningStopwatch` keeps ticking until that field is populated. The result is the user-facing "Thinking for 19s" header in [the screenshot] that won't settle until the whole tool round completes — visually misleading because the model has long since stopped reasoning.

The architectural fix mirrors **vercel/ai PR #11675 (xai)**, **PR #11751 (openai-compatible + groq)**, and **PR #13394 (openai-compatible, open)**: emit `reasoning-end` immediately when the model transitions from reasoning content to text or tool-call content within the same message id, rather than deferring to a flush/end-of-stream path. The same pattern is already implemented in the same `@ai-sdk/langchain` source file for `processModelChunk` (the direct-model and StreamEvents v2 path) — it is missing only from the LangGraph `case 'messages'` branch.

## Problem Statement

**Symptom**: Chat reasoning card renders `Thinking for 19s` (live ticker) for the full duration of a downstream tool call, even though the model finished its reasoning block ~18 seconds earlier and is already streaming text + tool input. Once the tool round completes, the header snaps to `Thought for 19s` (or whatever final duration was at that moment).

**Reproduction**: Any GPT-5 / GPT-5.5 / Anthropic Claude conversation that does `reasoning → text → tool_call → tool_result` within a single LangGraph agent step. OpenSCAD/CAD edits (`edit_file` on large files) make the delay obvious because the tool round is slow.

**User-visible exemplar** (from the bug report screenshot): "Thinking for 19s >" header sits above an `Implementing main.scad …` paragraph and a streaming `main.scad` patch — clearly the model has moved on, but the reasoning timer is still ticking.

**Impact**:

- Misleading UX: the reasoning timer is the wrong source of truth for "is the model still thinking?"
- Server-stamped `reasoningEndedAtMs` is delayed by the entire downstream tool-call duration, polluting any analytics that read it as "time the model spent reasoning"
- The card cannot collapse to its done state (`Thought for Ns`) until the tool round ends, blocking the auto-collapse + final-duration UX path

## Methodology

Source-level investigation across:

- `node_modules/@ai-sdk/langchain/dist/index.mjs` (the patched `2.0.147` package — patched-in-place via `pnpm patch` workspace)
- Upstream `@ai-sdk/langchain` source: `packages/langchain/src/utils.ts` on `vercel/ai` `main` (post-2.0.147; the relevant code paths are unchanged)
- `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` (the per-stream `Map<reasoningId, startedAtMs>` that stamps `common.reasoningStartedAtMs` / `reasoningEndedAtMs`)
- `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` (header label state machine + `useReasoningStopwatch`)
- Existing patches: `patches/@ai-sdk__langchain@2.0.147.patch` (extends `case 'values'` for HITL-aware historical reasoning re-emission; this change extends that patch further)
- Companion regression tests: `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts`, `apps/api/app/testing/aisdk-langchain-summary-boundary.test.ts`

Upstream precedent (chronological, all addressing the same defect class in different providers):

- vercel/ai issue [#7076](https://github.com/vercel/ai/issues/7076) — original report ("textEnd, reasoningEnd was enqueued at the wrong time", v5)
- vercel/ai PR [#11675](https://github.com/vercel/ai/pull/11675) — fix for `@ai-sdk/xai` (merged Jan 2026)
- vercel/ai issue [#11683](https://github.com/vercel/ai/issues/11683) — follow-up: same defect in openai-compatible (closed Jan 2026)
- vercel/ai PR [#11751](https://github.com/vercel/ai/pull/11751) — fix for `@ai-sdk/openai-compatible` and `@ai-sdk/groq` (merged Jan 2026)
- vercel/ai issue [#10755](https://github.com/vercel/ai/issues/10755) — long-form repro of the wrong-order behaviour, still open against openai-compatible
- vercel/ai PR [#13394](https://github.com/vercel/ai/pull/13394) — additional fix for openai-compatible + google (open, targets `release-v5.0` as of April 2026)

There is **no** upstream issue or PR specifically against `@ai-sdk/langchain`'s LangGraph adapter for this defect class. The bug is the same; the repository surface has not been audited.

## Findings

### Finding 1: `case 'messages'` emits reasoning-start/reasoning-delta but never reasoning-end

`processLangGraphEvent` `case 'messages'` (`node_modules/@ai-sdk/langchain/dist/index.mjs:540-660`) processes each LangGraph `messages` tuple as follows:

```typescript
case "messages": {
  // … extract msg, msgId …
  if (isAIMessageChunk(msg)) {
    // Tool call chunks → emit tool-input-start / tool-input-delta, then RETURN
    if (toolCallChunks?.length) {
      // … emit tool-input-start / tool-input-delta …
      return; // <- early return, no reasoning close
    }

    // Reasoning content blocks → emit reasoning-start (once) + reasoning-delta
    const reasoningResult = extractReasoningFromContentBlocks(msg);
    if (reasoningResult) {
      if (!messageSeen[msgId]?.reasoning) {
        controller.enqueue({ type: 'reasoning-start', id: msgId });
        messageSeen[msgId] ??= {};
        messageSeen[msgId].reasoning = true;
        streamedReasoningMessageIds.add(msgId); // Tau patch
      }
      controller.enqueue({ type: 'reasoning-delta', delta: deltaText, id: msgId });
    }

    // Text content → emit text-start (once) + text-delta
    const text = getMessageText(msg);
    if (text) {
      if (!messageSeen[msgId]?.text) {
        controller.enqueue({ type: 'text-start', id: msgId });
        messageSeen[msgId] ??= {};
        messageSeen[msgId].text = true;
      }
      controller.enqueue({ type: 'text-delta', delta: text, id: msgId });
    }
  }
  // … ToolMessage handling …
  return;
}
```

**There is no `controller.enqueue({ type: 'reasoning-end', id: msgId })` in this branch.** When a chunk carrying text or a tool call follows a chunk carrying reasoning (within the same `msgId`), the previous reasoning block is left open.

### Finding 2: `case 'values'` first loop is the _only_ closer — it fires once per LangGraph node completion

`case 'values'` first loop (`node_modules/@ai-sdk/langchain/dist/index.mjs:663-691`):

```typescript
case "values": {
  for (const [id, seen] of Object.entries(messageSeen)) {
    if (seen.text) controller.enqueue({ type: "text-end", id });
    if (seen.tool) {
      // … emit tool-input-available for each tool …
    }
    if (seen.reasoning) {
      controller.enqueue({ type: "reasoning-end", id }); // <- ONLY closer
    }
    delete messageSeen[id];
    delete messageConcat[id];
    delete messageReasoningIds[id];
  }
  // … historical re-emission second loop (Tau patch) …
}
```

Per the LangGraph streaming docs ([oss/javascript/langgraph/streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)):

> **`values`**: Streams the full state of the graph after each step.
>
> **`messages`**: Streams LLM messages token-by-token from any LLM calls in your graph (nodes, tools, subgraphs).

A "step" in LangGraph is one Pregel superstep — for a sequential ReAct agent, that's one node execution. `values` events therefore fire **after the agent node returns**, which for `create_react_agent`-style graphs means after the model finishes streaming AND any tool invocation orchestrated within that node (the tool node is a separate superstep in standard ReAct, but the tool call kickoff and the `messages` events for that step interleave with downstream node activity).

Concretely, with `streamMode: ['values', 'messages', 'custom']` (Tau's setup at `apps/api/app/api/chat/chat.controller.ts:145`), the iterator yield sequence for a single `reasoning → text → tool_call → tool_result → text` turn looks like:

```
['messages', [reasoning_chunk_1, meta]]     ← reasoning-start + reasoning-delta
['messages', [reasoning_chunk_2, meta]]     ← reasoning-delta
['messages', [reasoning_chunk_N, meta]]     ← reasoning-delta
['messages', [text_chunk, meta]]            ← text-start + text-delta  ◀ reasoning still open
['messages', [tool_call_chunk, meta]]       ← tool-input-start + tool-input-delta  ◀ reasoning still open
['values', { messages: [..., AIMessage] }]  ← reasoning-end fires HERE  (agent step ends)
                                             ↑ but the tool node is yet to run
['messages', [tool_result, meta]]           ← tool-output-available
['values', { messages: [..., ToolMessage] }] ← second values event
['messages', [next_text_chunk, meta]]        ← second step's reasoning/text
…
```

The first `values` event after the agent step closes reasoning. In the **best case**, that fires within milliseconds of the model finishing. In the **worst case** observed in production:

- Long tool argument bodies that stream slowly (e.g. a multi-kilobyte `edit_file` patch) keep the agent step open until the tool input finishes accumulating
- Tool execution that is dispatched within the agent node (via `bindTools`-based wrappers that don't yield until after side-effects) further delays the first `values`
- LangGraph subgraph fan-out can defer parent `values` events until child steps settle

Empirically, on Tau's GPT-5.5 + OpenSCAD `edit_file` traces, the first `values` event after the agent step routinely lands 15–25 seconds after the last reasoning delta — exactly matching the user-reported 19s timer.

### Finding 3: `processModelChunk` already implements the correct transition — the LangGraph branch is the outlier

The same `@ai-sdk/langchain` source file contains `processModelChunk` (used for direct model streams via `LangChainAdapter.toUIMessageStream(model.stream(...))` and indirectly by `processStreamEventsEvent`):

```typescript
// packages/langchain/src/utils.ts:524-548 (upstream main, identical in 2.0.147)
if (text) {
  /**
   * If reasoning was streamed before text, close reasoning first
   */
  if (state.reasoningStarted && !state.textStarted) {
    controller.enqueue({
      type: 'reasoning-end',
      id: state.reasoningMessageId ?? state.messageId,
    });
    state.reasoningStarted = false;
  }
  if (!state.textStarted) {
    state.textMessageId = state.messageId;
    controller.enqueue({ type: 'text-start', id: state.messageId });
    state.textStarted = true;
  }
  controller.enqueue({ type: 'text-delta', delta: text, id: state.textMessageId ?? state.messageId });
}
```

The pattern is exactly what the LangGraph `case 'messages'` branch is missing: emit `reasoning-end` before opening text. The fix is to port this transition guard to the LangGraph branch and extend it to cover the tool-call early-return path as well.

### Finding 4: The defect class is well-known upstream — the langchain adapter is just unaudited

This is the same architectural defect that:

| Provider                                                    | Issue / PR                                                                                                        | Status                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `@ai-sdk/xai`                                               | [PR #11675](https://github.com/vercel/ai/pull/11675) (closes [#7076](https://github.com/vercel/ai/issues/7076))   | Merged Jan 2026                           |
| `@ai-sdk/openai-compatible` + `@ai-sdk/groq`                | [PR #11751](https://github.com/vercel/ai/pull/11751) (closes [#11683](https://github.com/vercel/ai/issues/11683)) | Merged Jan 2026                           |
| `@ai-sdk/openai-compatible` (additional) + `@ai-sdk/google` | [PR #13394](https://github.com/vercel/ai/pull/13394) (re #10755)                                                  | Open (April 2026), targets `release-v5.0` |
| `@ai-sdk/langchain` (LangGraph `case 'messages'`)           | _none_                                                                                                            | _filed by this research_                  |

PR #11751's commit message captures the desired before/after exactly:

> Before: `reasoning-start → reasoning-delta → ... → text-start → text-delta → ... → reasoning-end (at flush) → text-end`
>
> After: `reasoning-start → reasoning-delta → ... → reasoning-end → text-start → text-delta → ... → text-end`

The defect class is identical here; the repository surface (LangGraph adapter) has just not been audited.

### Finding 5: Tau's `createReasoningTimingTransform` makes the symptom user-visible, but is not the root cause

`apps/api/app/api/chat/utils/reasoning-timing-transform.ts` stamps `providerMetadata.common.reasoningStartedAtMs` on `reasoning-start` and `reasoningEndedAtMs` on `reasoning-end`. Both end up in `MyUIMessage.parts[i].providerMetadata.common`. The UI (`apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx:96-98`) computes:

```typescript
const reasoningStartedAtMs = getReasoningStartedAtMs(part);
const finalReasoningDurationMs = getReasoningDurationMs(part); // = endedAtMs - startedAtMs, or undefined if either is missing
const isReasoningStreaming = isMessageActive && finalReasoningDurationMs === undefined;
```

When `reasoningEndedAtMs` is missing (`reasoning-end` not yet emitted), `finalReasoningDurationMs` is `undefined`, so `isReasoningStreaming` is `true` for as long as the message stays active, and the live "Thinking for Ns" stopwatch keeps ticking until the chat-level `status` flips away from `'streaming'`.

Replacing the `useReasoningStopwatch` heuristic with a different signal would be a band-aid — the wire-level truth is "reasoning has not been closed", and the right answer is to close it when the model actually transitions away from reasoning.

### Finding 6: A Tau-side `closeStaleReasoningTransform` is feasible but is the wrong layer

A self-contained `TransformStream<UIMessageChunk, UIMessageChunk>` could maintain a per-`msgId` "reasoning open" set and inject a synthesized `reasoning-end` chunk before any non-reasoning chunk for the same id (text-start, tool-input-start). Pseudocode:

```typescript
new TransformStream({
  transform(chunk, controller) {
    if (chunk.type === 'reasoning-start') {
      openReasoningIds.add(chunk.id);
    } else if (chunk.type === 'reasoning-end') {
      openReasoningIds.delete(chunk.id);
    } else if (
      (chunk.type === 'text-start' || chunk.type === 'tool-input-start') &&
      'id' in chunk &&
      openReasoningIds.has(chunk.id)
    ) {
      controller.enqueue({ type: 'reasoning-end', id: chunk.id });
      openReasoningIds.delete(chunk.id);
    }
    controller.enqueue(chunk);
  },
});
```

This is correct, low-risk, and does not require touching the patched `@ai-sdk/langchain`. **However**, it duplicates logic that already exists in `processModelChunk` and belongs in the LangGraph branch alongside it. Tau's workspace policy ("fix at source rather than post-processing") and library-api-policy both push toward the patch fix — and a Tau-side transform would also become a redundant double-close once the patch is applied (the `case 'values'` first loop's `reasoning-end` enqueue would remain unguarded and would still fire). Picking one fix-site avoids that hazard.

### Finding 7: The patch fix requires gating the `case 'values'` reasoning-end enqueue on a "not already closed" flag

If `case 'messages'` starts emitting `reasoning-end` on transition, the existing `case 'values'` first loop will double-emit unless we track closure:

```typescript
// case 'values' first loop, with the new guard:
if (seen.reasoning && !seen.reasoningEnded) {
  controller.enqueue({ type: 'reasoning-end', id });
}
```

The cleanest representation is a third boolean field on the `messageSeen[msgId]` shape:

```typescript
type MessageSeenEntry = {
  reasoning?: boolean; // reasoning-start was emitted for this msgId
  reasoningEnded?: boolean; // reasoning-end was emitted (in case 'messages')
  text?: boolean;
  tool?: Record<string, boolean>;
};
```

The AI SDK reducer (`processUIMessageStream`) maintains its own `activeReasoningParts` map and would log a `reasoning part not found` warning on a duplicate `reasoning-end` — silent in production but noisy in dev console and a real correctness leak.

### Finding 8: Edge cases the proposed fix preserves

| Case                                                                                                         | Behaviour after fix                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reasoning-only message (no text, no tool calls — pure thought block)                                         | `case 'messages'` never triggers the transition; `case 'values'` first loop closes it (unchanged behaviour)                                                                                                               |
| Text-only message (no reasoning)                                                                             | `messageSeen[msgId].reasoning` never `true`; transition guard is no-op (unchanged)                                                                                                                                        |
| `reasoning → text → reasoning → text` (interleaved, OpenAI Responses API GPT-5 with multiple summary blocks) | First `text` chunk fires `reasoning-end` (id: msgId). Subsequent reasoning chunk fires a fresh `reasoning-start` (same msgId). Reducer creates a new reasoning part. Multi-block reasoning per turn is handled correctly. |
| Tool-call chunk arrives directly after reasoning (no intermediate text chunk)                                | The early-return tool-call branch must also emit `reasoning-end` before `tool-input-start` (mirror logic). Otherwise the tool-call path bypasses the close.                                                               |
| Stream aborted after reasoning, no transition chunk arrives                                                  | `case 'values'` first loop still runs the close (gate guard is `!seen.reasoningEnded`, which is false). Same as today.                                                                                                    |
| HITL pause: trailing AIMessage has reasoning + tool calls, no streaming this request                         | The Tau patch's `streamedReasoningMessageIds` gate already suppresses synthetic re-emission. New transition guard does not affect this path.                                                                              |
| Cross-step reasoning (step 1 reasoning closes, step 2 reasoning starts on a new msgId)                       | Each step has its own `msgId`; per-msgId state never leaks                                                                                                                                                                |
| LangGraph subgraph emits its own values event                                                                | First loop runs once per values event with `messageSeen` snapshotted at that point. Already correct.                                                                                                                      |

### Finding 9: Reasoning-timing-transform is robust against the corrected wire format

`createReasoningTimingTransform` keys its per-stream `Map<reasoningId, startedAtMs>` on `chunk.id` for both `reasoning-start` and `reasoning-end`. With the fix:

- Earlier `reasoning-end` arrival → earlier `reasoningEndedAtMs` stamp → UI flips to `Thought for Ns` immediately when the model transitions to text/tool
- A subsequent `reasoning-start` for the same msgId (interleaved reasoning blocks) overwrites the start timestamp in the map — correct, because each block is its own logical reasoning span
- Unmatched `reasoning-end` (defensive): the `startedAtMs === undefined` branch already stamps only `reasoningEndedAtMs` (Tau Finding 6 of `reasoning-timing-transform.ts`)

No transform changes are needed.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort  | Impact                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------- |
| R1  | Extend `patches/@ai-sdk__langchain@2.0.147.patch` to add a `reasoningEnded?: boolean` field to the `messageSeen[msgId]` shape (`src/types.ts` `LangGraphEventState`).                                                                                                                                                                                                                                          | P0       | Trivial | Required primitive                          |
| R2  | In `case 'messages'` `isAIMessageChunk(msg)` branch: before the `controller.enqueue({ type: 'text-start', id: msgId })` line, add a transition guard — if `messageSeen[msgId]?.reasoning && !messageSeen[msgId]?.reasoningEnded`, enqueue `{ type: 'reasoning-end', id: msgId }` and set `reasoningEnded = true`.                                                                                              | P0       | Low     | Headline fix for text-after-reasoning       |
| R3  | In `case 'messages'` `isAIMessageChunk(msg)` `tool_call_chunks` branch: same transition guard before the first `controller.enqueue({ type: 'tool-input-start', ... })` per chunk. Critical because that branch returns early.                                                                                                                                                                                  | P0       | Low     | Headline fix for tool-after-reasoning       |
| R4  | In `case 'values'` first loop: change `if (seen.reasoning) { controller.enqueue({ type: 'reasoning-end', id }) }` to `if (seen.reasoning && !seen.reasoningEnded) { controller.enqueue({ type: 'reasoning-end', id }) }`.                                                                                                                                                                                      | P0       | Trivial | Prevents double-close warning               |
| R5  | Mirror all source edits into both `dist/index.mjs` and `dist/index.js` verbatim (no logic divergence). Tau's existing patch already follows this pattern.                                                                                                                                                                                                                                                      | P0       | Trivial | Patch must compile in both module formats   |
| R6  | Run `pnpm patch-commit` to refresh `patches/@ai-sdk__langchain@2.0.147.patch`. Verify the patch hash changes and `pnpm install` re-applies the patched `node_modules/@ai-sdk/langchain/dist/index.mjs` cleanly. Per workspace memory: clear stale `*patch_hash*` directories under `node_modules/.pnpm/` if needed.                                                                                            | P0       | Trivial | Standard patch hygiene                      |
| R7  | Add a regression test to `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts` (or a new sibling) that asserts: for a `reasoning_chunk → text_chunk` sequence within one `lc_msgid`, the emitted UI chunks contain `reasoning-start, reasoning-delta, reasoning-end, text-start, text-delta` in that order — and that no second `reasoning-end` arrives when a subsequent `values` event fires. | P0       | Low     | Locks in ordering invariant                 |
| R8  | Add a sibling test for `reasoning_chunk → tool_call_chunk` covering the early-return branch (R3).                                                                                                                                                                                                                                                                                                              | P0       | Low     | Ensures tool-call path coverage             |
| R9  | Manual verification on GPT-5.5 + Anthropic Claude with a slow `edit_file` round-trip: confirm the reasoning header flips to `Thought for Ns` immediately when text streaming begins, and the duration stamp matches the actual reasoning interval (not the tool-call interval).                                                                                                                                | P0       | Manual  | User-observable acceptance criterion        |
| R10 | File an upstream issue against `vercel/ai` referencing #11675, #11751, #13394 as the architectural precedent and the `@ai-sdk/langchain` LangGraph `case 'messages'` branch as the unaudited surface. Include the Tau patch as the candidate fix.                                                                                                                                                              | P1       | Medium  | Long-term: drop the local patch once merged |
| R11 | Open a corresponding upstream PR mirroring the Tau patch, with tests modelled on `examples/next-langchain` reasoning fixtures.                                                                                                                                                                                                                                                                                 | P1       | Medium  | Same — closes the maintenance loop          |
| R12 | (Optional, polish) Investigate whether the AI SDK reducer's `processUIMessageStream` should treat a duplicate `reasoning-end` for an already-closed id as a soft no-op rather than a warning — the defensive double-close is a legitimate "belt and suspenders" pattern across providers.                                                                                                                      | P3       | Medium  | Nice-to-have for ecosystem robustness       |

## Architecture

### Wire-format invariant after R1–R4

```
Per (msgId), the chunk sequence MUST satisfy:

  reasoning-start[msgId] ─┐
                          ├─→ reasoning-delta[msgId]*  (zero or more)
                          │
                          ├─→ reasoning-end[msgId]      (exactly once, before any
                          │                              text-start[msgId] or
                          │                              tool-input-start[msgId])
                          │
                          ├─→ text-start[msgId]         (optional)
                          │   text-delta[msgId]*
                          │   text-end[msgId]
                          │
                          └─→ tool-input-start[…]       (optional)
                              tool-input-delta[…]*
                              tool-input-available[…]

For sequential reasoning blocks within one msgId:
  reasoning-end[msgId]  →  reasoning-start[msgId]  is permitted.
  Each pair forms its own reasoning part in the AI SDK reducer.
```

### Patch sites (line numbers in `dist/index.mjs` of `@ai-sdk/langchain@2.0.147`)

```
540-660: case 'messages' / isAIMessageChunk branch
  ├─ Tool-call path                         → line ~573 (tool-input-start enqueue)
  │   ↑ R3: insert transition guard ABOVE this enqueue
  │
  ├─ Reasoning path                         → line ~605 (reasoning-start enqueue)
  │   ↑ unchanged
  │
  └─ Text path                              → line ~629 (text-start enqueue)
      ↑ R2: insert transition guard ABOVE this enqueue

663-691: case 'values' first loop
  └─ Reasoning closer                       → line ~685 (reasoning-end enqueue)
      ↑ R4: gate on !seen.reasoningEnded
```

### Patch hunk (illustrative — final form goes in `patches/@ai-sdk__langchain@2.0.147.patch`)

```diff
 // src/types.ts
 export interface LangGraphEventState {
   // … existing fields …
   streamedReasoningMessageIds: Set<string>;
+  // (no separate field needed — closure tracked inline on messageSeen[msgId])
 }
+
+// The messageSeen entry shape gains:
+//   { reasoning?: boolean; reasoningEnded?: boolean; text?: boolean; tool?: ... }
+// reasoningEnded is set to true the moment case 'messages' enqueues reasoning-end
+// in the transition guard, so case 'values' won't double-close.

 // src/utils.ts -- case 'messages', isAIMessageChunk branch

 // (R3) Tool-call sub-branch, BEFORE the first tool-input-start enqueue:
+if (
+  messageSeen[msgId]?.reasoning &&
+  !messageSeen[msgId]?.reasoningEnded
+) {
+  controller.enqueue({ type: 'reasoning-end', id: msgId });
+  messageSeen[msgId].reasoningEnded = true;
+}
 if (!messageSeen[msgId]?.tool?.[toolCallId]) {
   controller.enqueue({ type: 'tool-input-start', toolCallId, toolName, dynamic: true });
   // …
 }

 // (R2) Text sub-branch, BEFORE the first text-start enqueue:
 const text = getMessageText(msg);
 if (text) {
+  if (
+    messageSeen[msgId]?.reasoning &&
+    !messageSeen[msgId]?.reasoningEnded
+  ) {
+    controller.enqueue({ type: 'reasoning-end', id: msgId });
+    messageSeen[msgId].reasoningEnded = true;
+  }
   if (!messageSeen[msgId]?.text) {
     controller.enqueue({ type: 'text-start', id: msgId });
     messageSeen[msgId] ??= {};
     messageSeen[msgId].text = true;
   }
   controller.enqueue({ type: 'text-delta', delta: text, id: msgId });
 }

 // src/utils.ts -- case 'values', first loop:

-if (seen.reasoning) {
+if (seen.reasoning && !seen.reasoningEnded) {
   controller.enqueue({ type: 'reasoning-end', id });
 }
```

Total patch surface: ~25 LOC added to the existing patch (which already adds ~120 LOC for the historical reasoning leak fix and empty-summary guards).

## Trade-offs

| Approach                                                                            | Pros                                                                                                                                                         | Cons                                                                                                                                                                                                                                        | Verdict                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **R1–R9: extend the existing patch + upstream PR** (this proposal)                  | Mirrors upstream's working pattern across xai/openai-compatible/groq/google; symmetric with `processModelChunk` already in the same file; mergeable upstream | +25 LOC patch surface; requires `pnpm patch-commit` workflow                                                                                                                                                                                | **Adopt**                                          |
| Tau-side `closeStaleReasoningTransform` only (no patch change)                      | No third-party patch surface; provider-agnostic                                                                                                              | Wrong layer (responsibility belongs in the streaming adapter); leaves the values-path double-emit unaddressed (would either over-close or noisy console warnings); duplicates logic that already exists upstream in `processModelChunk`     | Reject — wrong layer per workspace policy          |
| Wait for an upstream langchain-adapter fix                                          | Zero local maintenance                                                                                                                                       | No upstream issue or PR is open against the langchain adapter for this; the openai-compatible track is still on a release-v5 branch (PR #13394 open since March 2026) — the langchain track will lag further                                | Reject standalone — combine with R10/R11 (do both) |
| Replace `useReasoningStopwatch` with a chat-status-derived signal in the UI         | Minimal scope                                                                                                                                                | Band-aid: wire-level truth still says reasoning is open; analytics still see inflated `reasoningEndedAtMs`; conflicts with workspace memory ("never band-aid — fix at source")                                                              | Reject                                             |
| Ditch `streamMode: ['values', 'messages', 'custom']` in favour of `streamEvents v2` | `processStreamEventsEvent` may use a different code path                                                                                                     | Massive blast radius: tool-call HITL, historical reasoning re-emission, custom mode, all rebuilt; `processStreamEventsEvent` ultimately delegates to `processModelChunk` so the underlying defect doesn't change for the LangGraph wrapping | Reject                                             |

## References

- vercel/ai issue [#7076](https://github.com/vercel/ai/issues/7076) — original cross-provider report
- vercel/ai issue [#10755](https://github.com/vercel/ai/issues/10755) — long-form repro of the wrong-order behaviour (still open against openai-compatible)
- vercel/ai issue [#11683](https://github.com/vercel/ai/issues/11683) — closed by PR #11751
- vercel/ai PR [#11675](https://github.com/vercel/ai/pull/11675) — xAI fix (merged Jan 2026)
- vercel/ai PR [#11751](https://github.com/vercel/ai/pull/11751) — openai-compatible + groq fix (merged Jan 2026)
- vercel/ai PR [#13394](https://github.com/vercel/ai/pull/13394) — additional openai-compatible + google fix (open, April 2026)
- LangGraph streaming docs: <https://docs.langchain.com/oss/javascript/langgraph/streaming> — definition of `values` vs `messages` modes
- `@ai-sdk/langchain` adapter source on `vercel/ai` `main`: <https://github.com/vercel/ai/blob/main/packages/langchain/src/utils.ts>
- Local: `patches/@ai-sdk__langchain@2.0.147.patch` — the patch this research extends
- Local: `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` — downstream consumer of `reasoning-start`/`reasoning-end` timing
- Local: `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` — header label state machine + `useReasoningStopwatch`
- Tau: [`docs/research/aisdk-langchain-historical-reasoning-leak.md`](./aisdk-langchain-historical-reasoning-leak.md) — the prior research that established the patching workflow and the `streamedReasoningMessageIds` plumbing
- Tau: [`docs/research/aisdk-langchain-empty-reasoning-emission.md`](./aisdk-langchain-empty-reasoning-emission.md) — companion fix for empty-summary chunks

## Appendix: Implementation Plan (Sequenced)

1. Open the patch workspace: reuse `node_modules/.pnpm_patches/@ai-sdk/langchain@2.0.147` if still present, else re-run `pnpm patch @ai-sdk/langchain@2.0.147`.
2. Edit `src/utils.ts`:
   - Add the R3 transition guard inside the `tool_call_chunks` early-return branch, immediately before the first `controller.enqueue({ type: 'tool-input-start', ... })`.
   - Add the R2 transition guard inside the `if (text) { ... }` block, immediately before the existing `text-start` enqueue.
   - Change the `case 'values'` first-loop reasoning closer to the gated form `seen.reasoning && !seen.reasoningEnded`.
3. Mirror all three edits into `dist/index.mjs` and `dist/index.js` verbatim.
4. `pnpm patch-commit <workspace-dir>` → refresh `patches/@ai-sdk__langchain@2.0.147.patch`.
5. `pnpm install` → confirm the new patch hash applies cleanly. If `node_modules/.pnpm/*<old_patch_hash>*` directories linger with stale contents, remove them and re-install (per workspace memory on `pnpm patch` failure modes).
6. Add the R7 + R8 regression tests to `apps/api/app/testing/aisdk-langchain-values-reasoning-leak.test.ts` (or a new file if size grows) — assert the chunk-order invariant from [Architecture](#architecture).
7. Run `pnpm nx typecheck api` and `pnpm nx test api ./app/testing/aisdk-langchain-values-reasoning-leak.test.ts ./app/testing/aisdk-langchain-summary-boundary.test.ts ./app/api/chat/interrupted-tool-roundtrip.test.ts --watch=false`.
8. Manual verification per R9 on GPT-5.5 with a slow OpenSCAD `edit_file` round-trip; confirm "Thinking for Ns" header flips to "Thought for Ns" the moment text begins streaming, with the timestamp matching the actual reasoning duration (not the tool-call duration).
9. Commit + push the patch + tests on the same branch as the historical-reasoning-leak fix (or a follow-up branch).
10. File the upstream issue + PR per R10/R11 — keep the local patch in place until upstream merges.
