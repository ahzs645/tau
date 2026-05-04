---
title: '`@ai-sdk/langchain` Empty Reasoning Streaming Emission'
description: 'Root cause of empty reasoning UI parts when OpenAI Responses API sends structural summary deltas with empty text.'
status: draft
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/aisdk-langchain-historical-reasoning-leak.md
  - docs/research/reasoning-duration-display.md
---

# `@ai-sdk/langchain` Empty Reasoning Streaming Emission

Symptomatic investigation: Tau chat showed nested "Thinking..." / "Thought briefly" rows with no body during GPT-style runs (`empty <thinking>` in exported transcripts). Evidence tied the symptom to `reasoning-start` being emitted without any non-empty `reasoning-delta`.

## Problem Statement

- **Symptom**: Empty reasoning collapsibles appear amid tool/file activity; exported markdown contains `<thinking>` blocks with nothing between tags.
- **Trigger**: GPT-5 family via OpenAI Responses API can emit reasoning metadata where `additional_kwargs.reasoning.summary` carries items like `{ type: 'summary_text', text: '', index: 0 }` as structural markers without user-visible prose.
- **Impact**: AI SDK persists a reasoning part with empty `text`; [`chat-message-reasoning.tsx`](../../apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx) renders the no-text branch (`Thinking...` / `Thought briefly`).

## Executive Summary

`extractReasoningFromContentBlocks` (streaming path) pushed empty strings into its accumulator and returned a truthy `{ text: '', summaryIndex? }` after a refactor that replaced string returns with structured objects. Callers gate on `if (reasoningResult)`, so `{ text: '' }` incorrectly drives `reasoning-start` plus an empty delta. The non-streaming helper `extractReasoningFromValuesMessage` already skips empty summary text (`typeof text === 'string' && text`). Aligning the streaming extractor eliminates spurious reasoning parts without UI hacks.

## Findings

### Finding 1: Truthy `{ text: '' }` passes the emitter gate

`processLangGraphEvent` (`case 'messages'`) emits when `extractReasoningFromContentBlocks` returns any object:

```typescript
const reasoningResult = extractReasoningFromContentBlocks(msg);
if (reasoningResult) {
  controller.enqueue({ type: 'reasoning-start', id: msgId });
  controller.enqueue({
    type: 'reasoning-delta',
    delta: reasoningResult.text,
    id: msgId,
  });
}
```

An empty `summary` delta produces `delta: ''`, which Materialises as an empty `ReasoningUIPart`.

### Finding 2: Regression from string-to-object refactor

Historical behaviour returned a bare string from the extractor such that `''` was falsy and no emission occurred. Returning `{ text: '' }` removed that implicit filter.

### Finding 3: `processModelChunk` nullish-coalescing lost fallback

Using `reasoningResult?.text ?? extractReasoningFromValuesMessage(chunk)` prevents fallback when `.text === ''`, because empty string is not nullish.

## Recommendations

| #   | Action                                                                                           | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | In `extractReasoningFromContentBlocks`, skip pushes for empty reasoning/thinking/summary strings | P0       | Low    | High   |

## References

- Related: [`docs/research/aisdk-langchain-historical-reasoning-leak.md`](./aisdk-langchain-historical-reasoning-leak.md)
- Transcript exemplar (user export): `<thinking>` with no inner content between `list_directory` and `read_file` tool rounds.
