---
title: 'Reasoning section newline gap across providers'
description: "Root-cause investigation of missing paragraph breaks between reasoning sections (esp. GPT-5/5.5) and a comprehensive cross-provider fix that preserves correct separators while continuing to trim Gemini's excess newlines."
status: draft
created: '2026-05-04'
updated: '2026-05-04'
category: investigation
related:
  - docs/research/cross-provider-thinking-block-portability.md
  - docs/research/aisdk-langchain-historical-reasoning-leak.md
  - docs/research/aisdk-langchain-empty-reasoning-emission.md
---

# Reasoning section newline gap across providers

Investigation of why GPT-5.5 reasoning blocks render with section headers glued onto the previous paragraph (e.g. `…gather more clarity.**Exploring cactus design options**`) while Anthropic and Gemini reasoning render with correct paragraph breaks, and what the comprehensive cross-provider fix looks like so the existing Gemini excess-newline trimming keeps working.

## Executive Summary

GPT-5/5.5's Responses API emits reasoning as multiple **summary parts**, each addressed by a `summary_index`. The boundary between two summary parts is the only place the model expects the consumer to insert a paragraph break — every part body already contains a leading `**Title**\n\n`. LangChain's V1 conversion (`convertToV1FromResponses`) collapses these parts into a single `contentBlocks` reasoning entry and **drops `summary_index`**. Our existing `patches/@ai-sdk__langchain@2.0.147.patch` already recognises the boundary problem and tries to inject `\n\n` between deltas when `summary_index` transitions, but it only reads `summaryIndex` from the `additional_kwargs.reasoning.summary` **fallback** path, which is skipped whenever the primary `contentBlocks` path matches first (always true under `outputVersion: 'v1'`).

Anthropic streams a single thinking block per turn (no boundaries to lose), and Gemini's potential multi-`thought`-part boundary is still joined with `""` (latent risk, not the visible bug today). The unified fix is small and lives entirely in `patches/@ai-sdk__langchain@2.0.147.patch`: read `summaryIndex` and multi-block joining behaviour from the chunk regardless of which extraction branch produced the text. The downstream `createNewlineTrimTransform` already collapses any `\n{3,}` runs the boundary injection might create when a summary body still has its own trailing newline, so the trim/separate concerns stay cleanly layered.

## Problem Statement

User-supplied transcript (`initial_design_2026-05-03T22-25.md`) shows a GPT-5.5 (`gpt-5.5-extra-high`) reasoning block where each summary heading has been concatenated directly onto the end of the previous paragraph with no separator:

```text
…My first step will be to acknowledge their request and gather more clarity.**Exploring cactus design options**

I'm considering creating a 2.5D cactus silhouette …
```

Anthropic and Gemini reasoning in the same chat surface render with correct paragraph breaks. Gemini occasionally introduces _too many_ leading/trailing newlines (the original motivation for `newline-trim-transform`), so any fix that injects separators must coexist with the existing trimming pipeline rather than fight it.

The visible artifact is a UX/accessibility bug: section titles such as `**Considering cactus drawing request**` lose their heading affordance and the reasoning preview becomes a wall of text.

## Methodology

1. Read the `ChatMessageReasoning` UI component to confirm rendering is verbatim — the bug must be upstream.
2. Read every reasoning-related transform in the API streaming pipeline (`reasoning-timing-transform`, `newline-trim-transform`, `cross-provider-content-normalizer`, `transform-ai-message-content`).
3. Trace how each provider produces reasoning content blocks:
   - `repos/langchainjs/libs/providers/langchain-openai/src/converters/responses.ts` (Responses API event → `AIMessageChunk`).
   - `repos/langchainjs/libs/langchain-core/src/messages/block_translators/openai.ts` (`convertToV1FromResponses`).
   - `repos/langchainjs/libs/providers/langchain-google-common/src/utils/gemini.ts` (Gemini thought parts).
4. Trace `@ai-sdk/langchain`'s `toUIMessageStream` reasoning extraction in `node_modules/@ai-sdk/langchain/dist/index.mjs` and the corresponding `patches/@ai-sdk__langchain@2.0.147.patch`.
5. Verify the existing patch's intent (boundary injection at `summaryIndex` transitions) versus the runtime behaviour observed in the transcript.

## Findings

### Finding 1: GPT-5 Responses API emits reasoning as discrete summary parts

`repos/langchainjs/libs/providers/langchain-openai/src/converters/responses.ts` lines 819–850 show three discrete event types, each tagged with `summary_index`:

- `response.reasoning_summary_part.added` — opens a new summary section (typically with `event.part.text === ''`).
- `response.reasoning_summary_text.delta` — streams the body text for the current section.
- `response.output_item.added (item.type === 'reasoning')` — fires when the whole reasoning item finalises.

Each event becomes an `AIMessageChunk` with two redundant payloads:

```js
additional_kwargs.reasoning = {
  type: 'reasoning',
  summary: [{ text: event.delta, type: 'summary_text', index: event.summary_index }],
};
content.push({ type: 'reasoning', reasoning: event.delta });
```

The `index` (a.k.a. `summary_index`) is the **only** signal that says "this delta belongs to a different summary part than the previous one". OpenAI's UI inserts a paragraph break at every `summary_index` increment.

### Finding 2: V1 conversion drops `summary_index` from `contentBlocks`

`langchain-core/src/messages/block_translators/openai.ts:242–264` (`convertToV1FromResponses`) flattens `additional_kwargs.reasoning.summary` into one V1 reasoning block:

```ts
const summary = message.additional_kwargs.reasoning.summary.reduce<string>(
  (acc, item) => (_isObject(item) && _isString(item.text) ? `${acc}${item.text}` : acc),
  '',
);
yield { type: 'reasoning', reasoning: summary };
```

The V1 `ContentBlock.Reasoning` interface (`langchain-core/src/messages/content/index.ts:91-107`) does declare an `index?: number` field, but `convertToV1FromResponses` **does not populate it**, and the source `summary[].index` is dropped. The chunk's `additional_kwargs.reasoning.summary[0].index` is still present, just orphaned.

### Finding 3: Our `@ai-sdk/langchain` patch only reads `summaryIndex` from the fallback path

`patches/@ai-sdk__langchain@2.0.147.patch` (lines 35–55) modifies `extractReasoningFromContentBlocks` to return `{ text, summaryIndex }`. The first branch (the `contentBlocks` array — what V1 mode populates) returns `{ text }` with **no** `summaryIndex`:

```js
if (Array.isArray(contentBlocks)) {
  const reasoningParts = [];
  for (const block of contentBlocks) {
    if (isReasoningContentBlock(block) && block.reasoning) reasoningParts.push(block.reasoning);
    else if (isThinkingContentBlock(block) && block.thinking) reasoningParts.push(block.thinking);
  }
  if (reasoningParts.length > 0) return { text: reasoningParts.join('') };
}
// only here does the patch read summaryIndex from additional_kwargs.reasoning.summary
```

Because every OpenAI Responses chunk has `contentBlocks` populated under `outputVersion: 'v1'`, the `additional_kwargs` fallback (where the fix actually lives) is **never reached**. The downstream `messageSummaryIndices` boundary injection at `index.mjs:599-604` always sees `reasoningResult.summaryIndex === undefined` and skips the `\n\n` prepend.

The patch is structurally correct; it has a single coverage gap.

### Finding 4: AI SDK joins consecutive reasoning content blocks with `""`

Even without the GPT-5 boundary issue, `extractReasoningFromContentBlocks` joins multiple in-chunk reasoning blocks with the empty string. This matters for Gemini (`langchain-google-common/utils/gemini.ts:951-973`), where every Gemini `part` with `thought: true` becomes its own `{ type: 'reasoning', reasoning: part.text }` block. When a Gemini chunk contains two thought parts, their texts are concatenated with no separator. In practice today Gemini emits a single thought part per chunk, so this is latent rather than visible — but it is the same class of bug and the comprehensive fix should address both.

### Finding 5: Anthropic is not affected

Anthropic streams a single thinking block per turn that the upstream provider already serialises as one continuous text. Our `cross-provider-content-normalizer.middleware.ts` rewrites the `thinking` block type to `reasoning`, preserving the single-block structure. There is no internal boundary to lose. `cross-provider-thinking.integration.test.ts` already covers cross-provider portability of these blocks.

### Finding 6: Gemini excess-newlines are an orthogonal concern

`createNewlineTrimTransform()` in `apps/api/app/api/chat/utils/newline-trim-transform.ts` already handles Gemini's leading/trailing newline noise per reasoning block id and collapses interior runs of three or more newlines to `\n\n`. The boundary-injection fix and the trim transform compose cleanly:

| Source                                 | Injection result                    | Trim-transform pass         | Final wire          |
| -------------------------------------- | ----------------------------------- | --------------------------- | ------------------- |
| `…body 0.` + `**Title 1**\n\nbody 1`   | `…body 0.\n\n**Title 1**\n\nbody 1` | unchanged                   | correctly separated |
| `…body 0.\n` + `**Title 1**\n\nbody 1` | `…body 0.\n\n\n**Title 1**…`        | collapses `\n{3,}` → `\n\n` | correctly separated |
| Gemini `\n\n\nthought…\n\n\n`          | n/a                                 | leading/trailing trimmed    | clean               |

### Finding 7: The historical (replay) path is already fixed

`patches/@ai-sdk__langchain@2.0.147.patch` lines 270–285 change `extractReasoningFromValuesMessage` to join `summary[].text` with `\n\n` instead of `""` — this is the path that re-emits reasoning when LangGraph replays a checkpointed AIMessage on a follow-up turn. It reads from `response_metadata.output[].summary[]` (the raw OpenAI shape preserved by the checkpoint). Today's bug is therefore strictly the **streaming** path; multi-turn replay already separates summary parts.

## Wire-Format Walkthrough

GPT-5.5 producing the cactus reasoning observed in the transcript:

```text
event: response.reasoning_summary_part.added       summary_index: 0
event: response.reasoning_summary_text.delta       summary_index: 0  delta: "**Considering cactus drawing request**"
event: response.reasoning_summary_text.delta       summary_index: 0  delta: "\n\nI need to respond …"
event: response.reasoning_summary_text.delta       summary_index: 0  delta: " gather more clarity."
event: response.reasoning_summary_part.added       summary_index: 1
event: response.reasoning_summary_text.delta       summary_index: 1  delta: "**Exploring cactus design options**"
event: response.reasoning_summary_text.delta       summary_index: 1  delta: "\n\nI'm considering …"
```

Per-stage transform of the seam between summary_index 0 and 1:

| Stage                                               | Boundary text                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| OpenAI events                                       | `…gather more clarity.` / `**Exploring cactus design options**` (separate parts)            |
| `langchain-openai` chunk converter                  | two AIMessageChunks, each carries `additional_kwargs.reasoning.summary[0].index` (0 then 1) |
| `convertToV1FromResponses` (V1 mode)                | `chunk.contentBlocks: [{ type: 'reasoning', reasoning: '<delta>' }]` — `index` dropped      |
| `extractReasoningFromContentBlocks` (current patch) | returns `{ text: '<delta>' }` — `summaryIndex` not surfaced                                 |
| Boundary injector at `index.mjs:599-604`            | `summaryIndex === undefined` → no `\n\n` prepended                                          |
| `reasoning-delta` chunks emitted to UI              | concatenate without separator → `…gather more clarity.**Exploring cactus design options**`  |
| `MarkdownViewerChat`                                | renders verbatim (markdown bold inside a paragraph, no break)                               |

## Why This Slipped the Existing Patch

The patch's author followed the `||` short-circuit pattern in upstream code (`extractReasoningFromContentBlocks(chunk) || extractReasoningFromValuesMessage(chunk)`) and added the `summaryIndex` plumbing inside the function. They placed it on the second branch because that's where `additional_kwargs.reasoning.summary` is read. Crucially, **both branches read summary data from the same chunk** — the first branch reads its own `contentBlocks`, the second reads its own `additional_kwargs.reasoning.summary`, and the function returns at whichever branch matches first. There's no ergonomic reason `summaryIndex` belongs only to the second branch; that's the gap.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                          | Priority | Effort | Impact                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------ |
| R1  | Extend `extractReasoningFromContentBlocks` to **also** peek at `additional_kwargs.reasoning.summary[].index` when the primary `contentBlocks` branch returns text (covers GPT-5.5 streaming bug). Update both `dist/index.js` / `dist/index.mjs` / `src/utils.ts` in `patches/@ai-sdk__langchain@2.0.147.patch`.                                                | P0       | Low    | Fixes the visible OpenAI bug end-to-end; no upstream change required.                                  |
| R2  | Within the same patch, when `contentBlocks` contains **two or more** reasoning/thinking blocks in a single chunk, join with `\n\n` instead of `""` (covers latent Gemini multi-thought boundary).                                                                                                                                                               | P1       | Low    | Defends against future Gemini stream changes that batch multiple thought parts.                        |
| R3  | Add a `newline-trim-transform.test.ts` case asserting that `…body.\n` + boundary `\n\n` + `**Title**` collapses to a single `\n\n` (composition test with the boundary injector).                                                                                                                                                                               | P1       | Low    | Prevents regression of the trim/inject layering.                                                       |
| R4  | Add a unit test on the patched `extractReasoningFromContentBlocks` covering both branches: contentBlocks-only, contentBlocks + additional_kwargs (must surface `summaryIndex`), and additional_kwargs-only.                                                                                                                                                     | P1       | Low    | Locks in the contract before any upstream V1 changes that might rearrange storage.                     |
| R5  | Add a streaming integration test mirroring `apps/api/app/testing/cross-provider-thinking.integration.test.ts` that captures one real GPT-5.5 reasoning stream and asserts every `**…**` heading in the assembled `ReasoningUIPart.text` is preceded by `\n\n` (or message start). Tag as `.integration.test.ts` so it is excluded from the default UI test run. | P2       | Medium | Real-API regression coverage of the user-visible bug.                                                  |
| R6  | Open an upstream langchainjs PR adding `index` (mapped from `summary_index`) to V1 reasoning blocks emitted by `convertToV1FromResponses`. Lets us delete the `additional_kwargs` peek once landed; until then, our patch is correct without it.                                                                                                                | P3       | Medium | Long-term: the V1 `ContentBlock.Reasoning.index?` field becomes the canonical signal across providers. |

### Recommended patch (R1 + R2)

The minimal addition to `extractReasoningFromContentBlocks` (TypeScript shape; mirror byte-for-byte into `dist/index.js` and `dist/index.mjs`):

```ts
export function extractReasoningFromContentBlocks(msg: unknown): { text: string; summaryIndex?: number } | undefined {
  if (msg == null || typeof msg !== 'object') return undefined;
  const msgObj = msg as { kwargs?: Record<string, unknown> } & Record<string, unknown>;
  const kwargs = msgObj.kwargs && typeof msgObj.kwargs === 'object' ? msgObj.kwargs : msgObj;

  // R2: if the V1 contentBlocks branch matches, join multi-block with \n\n.
  const contentBlocks = (kwargs as { contentBlocks?: unknown }).contentBlocks;
  if (Array.isArray(contentBlocks)) {
    const reasoningParts: string[] = [];
    for (const block of contentBlocks) {
      if (isReasoningContentBlock(block) && block.reasoning) reasoningParts.push(block.reasoning);
      else if (isThinkingContentBlock(block) && block.thinking) reasoningParts.push(block.thinking);
    }
    if (reasoningParts.length > 0) {
      // R1: cross-read summary_index from additional_kwargs even when primary text came from contentBlocks.
      const summaryIndex = peekSummaryIndex(kwargs);
      return { text: reasoningParts.join('\n\n'), summaryIndex };
    }
  }

  // existing additional_kwargs branch unchanged …
}

function peekSummaryIndex(kwargs: Record<string, unknown>): number | undefined {
  const reasoning = (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return undefined;
  const summary = (reasoning as { summary?: unknown }).summary;
  if (!Array.isArray(summary)) return undefined;
  for (const item of summary) {
    if (item && typeof item === 'object' && typeof (item as { index?: unknown }).index === 'number') {
      return (item as { index: number }).index;
    }
  }
  return undefined;
}
```

The boundary-injection block at `processLangGraphEvent`'s `case 'messages'` already reacts to `reasoningResult.summaryIndex` and prepends `\n\n` on transitions — no change required there.

### Compatibility with `newline-trim-transform`

`createNewlineTrimTransform()` runs after `createReasoningTimingTransform()` and after the boundary injection inside `@ai-sdk/langchain`. Because trim:

- strips leading newlines per **block id** (one OpenAI reasoning section spans many summary parts but a single block id, so the leading-strip only fires once at the start of the whole block);
- collapses any `\n{3,}` to `\n\n` (so `<body>\n` + injected `\n\n` + `<title>` → `<body>\n\n<title>`);
- buffers trailing newlines and discards them on `reasoning-end` (no change in behaviour);

the two transforms compose without surprises. Gemini's existing trim guarantees stay intact: leading/trailing noise removal is unchanged and the `\n\n` boundary insertion only fires when a `summaryIndex` is present (Gemini chunks have none).

### Per-Provider Behaviour After Fix

| Provider                                        | Streaming structure                      | Pre-fix behaviour                                            | Post-fix behaviour                        |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| OpenAI Responses (GPT-5/5.5)                    | summary parts indexed by `summary_index` | sections concatenate without `\n\n`                          | `\n\n` injected at every index transition |
| Anthropic (extended thinking)                   | single thinking block per turn           | renders correctly                                            | unchanged                                 |
| Gemini (Vertex/GenAI thoughts)                  | one thought part per chunk (today)       | renders correctly; trim handles leading/trailing `\n` excess | unchanged                                 |
| Gemini (multi-thought batched)                  | hypothetical: many thoughts per chunk    | latent: parts join with `""`                                 | parts join with `\n\n` (R2)               |
| Together / OpenAI-compatible                    | same shape as OpenAI Responses           | same as OpenAI                                               | same as OpenAI                            |
| Cerebras / Ollama (no reasoning UI parts today) | n/a                                      | n/a                                                          | unchanged                                 |

## Code References

- `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` — verbatim render through `MarkdownViewerChat`; not the bug.
- `apps/api/app/api/chat/utils/newline-trim-transform.ts` — per-block trim/collapse; composes cleanly with the fix.
- `apps/api/app/api/chat/middleware/cross-provider-content-normalizer.middleware.ts` — Anthropic ↔ V1 reasoning rewrite; not in the bug path.
- `apps/api/app/api/providers/provider.service.ts` — every reasoning-capable provider (OpenAI / Anthropic / Vertex) sets `outputVersion: 'v1'`, which is what makes the `contentBlocks` branch always match.
- `repos/langchainjs/libs/providers/langchain-openai/src/converters/responses.ts:819–850` — emits per-chunk `summary[].index`.
- `repos/langchainjs/libs/langchain-core/src/messages/block_translators/openai.ts:242–264` — V1 conversion drops `summary_index`.
- `node_modules/@ai-sdk/langchain/dist/index.mjs:359–402,599–604` — `extractReasoningFromContentBlocks` and the boundary injector.
- `patches/@ai-sdk__langchain@2.0.147.patch` — current patch with the coverage gap diagnosed in Finding 3.

## References

- Related: `docs/research/aisdk-langchain-historical-reasoning-leak.md`
- Related: `docs/research/aisdk-langchain-empty-reasoning-emission.md`
- Related: `docs/research/cross-provider-thinking-block-portability.md`
- OpenAI Responses streaming events: `response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta`, `response.output_item.added`.
