---
title: 'Reasoning Duration Display ("Thought for Xs")'
description: 'Architecture for capturing and rendering per-reasoning-block duration via AI SDK providerMetadata, plumbed from a LangChain stream transform.'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
revision: 5
category: architecture
related:
  - docs/research/chat-rendering-audit.md
  - docs/research/agentic-chat-input-architecture.md
---

# Reasoning Duration Display ("Thought for Xs")

How to capture per-reasoning-block duration in the LangChain.js → AI SDK pipeline and surface it in `ChatMessageReasoning` as "Thought for 2s" / "Thought briefly".

## Executive Summary

The Vercel AI SDK exposes `providerMetadata` on every `reasoning-*` chunk and threads it onto the assembled `ReasoningUIPart`, and Tau's chat schema accepts a namespaced JSON shape inside `providerMetadata` (`libs/chat/src/schemas/message-provider.schema.ts:15`). The cleanest plumbing is a **minimal-state server-side `TransformStream`** placed in the `chat.controller.ts` pipeline (mirroring `createNewlineTrimTransform`) that:

1. On `reasoning-start`: stamps `providerMetadata.common.reasoningStartedAtMs = Date.now()`, **stores the value in a per-`TransformStream`-instance `Map<reasoningId, startedAtMs>`**, and re-emits the chunk.
2. On every `reasoning-delta`: pure pass-through — **no buffering, no async work, no metadata mutation** — preserving full token-level streaming throughput.
3. On `reasoning-end`: looks up the matching `startedAtMs` from the map, stamps **both** `reasoningStartedAtMs` (carried forward) and `reasoningEndedAtMs = Date.now()` onto `providerMetadata.common`, deletes the map entry, and re-emits the chunk.

The map carries the start timestamp forward to the end chunk because the AI SDK reducer **replaces** rather than merges `providerMetadata` across chunks of the same reasoning part — see [Finding 8: AI SDK reducer replaces `providerMetadata` across reasoning chunks](#finding-8-ai-sdk-reducer-replaces-providermetadata-across-reasoning-chunks). Without carrying it forward, the start timestamp is silently dropped at `reasoning-end` time and the client cannot derive a duration. The map's lifetime is the HTTP request stream (seconds), bounded by the number of concurrent reasoning blocks within one response (typically 1–2), and dies with the stream — see [Finding 7: Minimal-state server design](#finding-7-minimal-state-server-design).

The `common` namespace is reserved for non-provider-specific metadata Tau attaches to AI SDK parts. Keys are scoped by feature prefix (here, `reasoning…`) so the namespace can host other shared concerns without clashing.

The shape is declared as a typed Zod schema (`commonReasoningMetadataSchema`) and **narrowed into the reasoning part schema in `uiMessagesSchema`**, so `MyUIMessage`'s reasoning-part `providerMetadata` carries the strongly-typed `common` namespace through the `MyUIMessage` mechanics — UI readers consume it without `as unknown` or `as Record<string, …>` casts.

The final duration `reasoningDurationMs` is **derived client-side** as `reasoningEndedAtMs - reasoningStartedAtMs` rather than computed server-side. This is a deliberate choice (see [Finding 7: Minimal-state server design](#finding-7-minimal-state-server-design)) — it keeps the wire format the source of truth and lets the same data round-trip through persistence without re-instrumenting the server.

The UI uses a `useReasoningStopwatch(startedAtMs, enabled)` hook that anchors **directly on the server-stamped `reasoningStartedAtMs`** for the live counter and ticks at 1Hz via `setInterval`. Server time is treated as authoritative on both sides of the wire; tiny browser/server clock skew is accepted as a known limitation in exchange for a substantially simpler client implementation (see [Finding 7](#finding-7-minimal-state-server-design) for the trade-off rationale).

See [Finding 6: Streaming non-blocking verification](#finding-6-streaming-non-blocking-verification) for the chain-by-chain proof that this pipeline does not stall reasoning deltas.

`wrapModelCall` middleware is the wrong layer: it measures the entire model call (which includes tool calls and post-reasoning text) and cannot attribute time to individual reasoning blocks under the AI SDK's interleaved-reasoning model (see [Trade-offs](#trade-offs)).

## Problem Statement

`apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` currently renders a static "Thought process" label for every reasoning part. We want a per-block duration suffix:

- `< 1s` → **"Thought briefly"**
- `≥ 1s` → **"Thought for {humanReadable}"** (e.g. `2s`, `45s`, `1m 12s`)
- While streaming → **"Thinking for {Ns}"** with a live ticking counter (≥ 1Hz update), transitioning seamlessly to the final "Thought for Ns" once `reasoning-end` arrives.

Constraints:

- Must round-trip through message persistence (durations survive page reload / session restore).
- Must work across all reasoning-emitting models (Claude extended thinking, GPT-5 reasoning summaries, DeepSeek-R1, Gemini Flash Thinking).
- Must respect AI SDK 5's interleaved reasoning semantics — reasoning can resume after text tokens, so timing must be per-block, not per-message.
- **Must NOT block reasoning streaming.** Reasoning deltas must continue to arrive at the client at the same cadence as without the transform — the live counter cannot be implemented by buffering reasoning until the block closes.
- Should reuse Tau's existing middleware/transform conventions (LangChain `createMiddleware`, `pipeThrough` chain in `chat.controller.ts`).

## Methodology

Source-level investigation across:

- **Tau backend pipeline**: `apps/api/app/api/chat/chat.controller.ts`, `apps/api/app/api/chat/middleware/*.ts`, `apps/api/app/api/chat/utils/*-transform.ts`.
- **AI SDK upstream**: `repos/ai/packages/ai/src/ui-message-stream/ui-message-chunks.ts`, `repos/ai/packages/ai/src/ui/process-ui-message-stream.ts`, `repos/ai/packages/langchain/src/utils.ts`.
- **Issue tracker**: [vercel/ai #4798 "Add reasoning time"](https://github.com/vercel/ai/issues/4798) (closed 2025-05-22, recommendation = `messageMetadata` / `providerMetadata`).
- **Prior art (read-only)**: `repos/claude-code/src/components/Spinner.tsx` & `Spinner/SpinnerAnimationRow.tsx`, `repos/codex/codex-rs/tui/src/status_indicator_widget.rs` & `chatwidget.rs` & `history_cell.rs`, `repos/cline/webview-ui/src/components/chat/RequestStartRow.tsx`, `repos/zoo-modeling-app/src/components/Thinking.tsx` & `PromptCard.tsx`.

## Findings

### Finding 1: AI SDK preserves `providerMetadata` from `reasoning-end` onto the assembled part

`repos/ai/packages/ai/src/ui-message-stream/ui-message-chunks.ts:97-113` defines three reasoning chunk types — `reasoning-start`, `reasoning-delta`, `reasoning-end` — each carrying an `id` and an optional `providerMetadata: ProviderMetadata`.

The reducer at `repos/ai/packages/ai/src/ui/process-ui-message-stream.ts:386-404` shows that on `reasoning-end` the assembled `ReasoningUIPart.providerMetadata` is set from the chunk's `providerMetadata`, falling back to the most recent `reasoning-delta` value. The merge prefers the chunk on each event, so injecting metadata at `reasoning-end` is the canonical "publish duration when block closes" point.

Tau's chat schema already accepts namespaced metadata: `libs/chat/src/schemas/message-provider.schema.ts:15` defines `providerMetadataSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema))`, so introducing a `common` namespace runtime-validates without changing the loose base schema. To get **strong typing in the UI** we narrow the reasoning part schema in `uiMessagesSchema` (`libs/chat/src/schemas/message.schema.ts:196-201`) to use `providerMetadataSchema.and(z.object({ common: commonReasoningMetadataSchema.optional() }))` for `providerMetadata`. This flows through `z.ZodType<MyUIMessage[]>` and makes `MyMessagePart` (when narrowed to `type === 'reasoning'`) carry the typed `common` namespace — readers don't need `as unknown` casts because `safeParse` accepts `unknown` input directly.

### Finding 2: `wrapModelCall` measures the wrong span

`apps/api/app/api/chat/middleware/llm-timing.middleware.ts` already times the full model call. That span includes:

1. Provider request setup / queueing.
2. Reasoning emission.
3. Text emission.
4. Tool-call argument streaming (where applicable).

For a single reasoning block to be timed, we need the delta between the `reasoning-start` and `reasoning-end` chunks specifically. AI SDK 5 also explicitly allows interleaved reasoning ([vercel/ai#4798 comment by @lgrammel](https://github.com/vercel/ai/issues/4798), 2025-02-10): "_reasoning could resume after several text tokens have been sent_", which means a single model call can contain multiple reasoning blocks separated by text — `wrapModelCall` cannot attribute time among them.

The same issue's resolution (closed by author, 2025-05-22) explicitly recommends the metadata route: "_The metadata feature in AI SDK 5 allows us to attach arbitrary data to messages, which perfectly addresses this use case._"

### Finding 3: Prior art (Claude Code, Codex, Cline, Zoo)

Comparison of how four agentic agents surface "thinking time":

| Agent                | Where computed                                                             | Carrier                                                         | Label format                                                                                   | Streaming UX                                        |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Claude Code**      | Client wall clock (`Date.now()` start/end of `SpinnerMode === 'thinking'`) | In-memory React ref + system message `subtype: 'turn_duration'` | `thought for ${Math.max(1, Math.round(ms/1000))}s` (lowercase, min 1s, **2s minimum display**) | `thinking…` + shimmer after 3s; live counter on row |
| **Codex (TUI)**      | Client wall clock (Rust `Instant::now()` in `StatusIndicatorWidget`)       | Widget state; `FinalMessageSeparator::elapsed_seconds`          | `Worked for {fmt_elapsed_compact}` — only when `> 60s` and tool/exec activity occurred         | Live `(0s • esc to interrupt)` next to spinner      |
| **Cline**            | —                                                                          | —                                                               | "Thinking…" (no duration)                                                                      | Shimmer text only                                   |
| **Zoo Modeling App** | Server timestamps (`started_at`, `updated_at` on `Prompt`)                 | Prompt fields, computed client-side via `ms()` package          | `Worked for {ms(end-start, { long: true })}`                                                   | "Thinking…" placeholder                             |

Key citations:

```167:172:repos/claude-code/src/components/Spinner/SpinnerAnimationRow.tsx
let thinkingText = thinkingStatus === 'thinking' ? `thinking${effortSuffix}` : typeof thinkingStatus === 'number' ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s` : null;
```

```2240:2247:repos/codex/codex-rs/tui/src/history_cell.rs
if let Some(elapsed_seconds) = self
    .elapsed_seconds
    .filter(|seconds| *seconds > 60)
    .map(super::status_indicator_widget::fmt_elapsed_compact)
{
    label_parts.push(format!("Worked for {elapsed_seconds}"));
}
```

```183:187:repos/zoo-modeling-app/src/components/Thinking.tsx
export const ThoughtFor = (props: {
  start: number
}) => {
  return <div>Worked for {ms(props.start - Date.now(), { long: true })}</div>
}
```

**Synthesis**: Claude Code's per-thinking-block client-side timing maps most cleanly to `ReasoningUIPart`. Codex's whole-turn approach is orthogonal (could be a future addition for `data-usage`-style turn metadata). Tau already has a server pipeline, so authoritative server-side timing on `providerMetadata` is preferable to Claude Code's client-only approach (it survives reload and avoids React render-time skew).

### Finding 4: Tau's existing transform chain is the natural insertion point

`apps/api/app/api/chat/chat.controller.ts:162-168` shows the pipeline:

```162:168:apps/api/app/api/chat/chat.controller.ts
const uiMessageStream = toUIMessageStream(stream)
  .pipeThrough(createStaticToolTransform())
  .pipeThrough(createToolOutputTransform())
  .pipeThrough(createNewlineTrimTransform())
  .pipeThrough(createLatexDelimiterTransform())
  .pipeThrough(createErrorTransform())
  .pipeThrough(this.createSseEventCountTransform());
```

`createNewlineTrimTransform` (`apps/api/app/api/chat/utils/newline-trim-transform.ts`) already implements the per-block-id pattern we need: a `Map<string, BlockState>` populated on `reasoning-start` / `text-start`, mutated on `*-delta`, and cleared on `*-end`. Adding `createReasoningTimingTransform` next to it requires ~50 LOC and zero schema changes.

### Finding 5: LangChain reasoning emission is per-content-block, not per-message

`repos/ai/packages/langchain/src/utils.ts:447-494` shows that `@ai-sdk/langchain`'s `toUIMessageStream` extracts reasoning from `contentBlocks` (Anthropic-style) or `additional_kwargs.reasoning` (OpenAI GPT-5) and emits a fresh `reasoning-start` per block, closing it with `reasoning-end` whenever a text token arrives:

```486:494:repos/ai/packages/langchain/src/utils.ts
if (state.reasoningStarted && !state.textStarted) {
  controller.enqueue({
    type: 'reasoning-end',
    id: state.reasoningMessageId ?? state.messageId,
  });
  state.reasoningStarted = false;
}
```

This means the upstream adapter already produces clean start/end boundaries for every reasoning block; we just need to time them.

### Finding 6: Streaming non-blocking verification

The user's hard requirement is that reasoning **must continue to stream** while the live counter is running on the client — the timing transform cannot stall the pipeline. The chain is verifiably non-blocking end-to-end:

#### 6a. LangChain.js emits reasoning chunks per-token, synchronously

Tau invokes the agent with `streamMode: ['values', 'messages', 'custom']`. The `messages` mode in `@langchain/langgraph` streams `(BaseMessageChunk, metadata)` tuples for **every** AI message chunk produced by the underlying model — i.e. one per provider-emitted token (Anthropic's `content_block_delta` for `thinking`, OpenAI's `response.reasoning_summary.delta`, etc.). LangChain's [Streaming docs](https://docs.langchain.com/oss/javascript/langchain/streaming/) and [Reasoning tokens guide](https://docs.langchain.com/oss/javascript/langchain/frontend/reasoning-tokens) confirm token-level granularity for both reasoning and text content blocks.

The `@ai-sdk/langchain` adapter consumes those tuples in `repos/ai/packages/langchain/src/adapter.ts:456-515` inside a `new ReadableStream({ async start() { while (true) { ... } } })` loop that **synchronously calls `controller.enqueue()` per chunk** (no batching, no setTimeout, no microtask coalescing). For LangGraph `messages` mode the dispatch path is `processLangGraphEvent` (`utils.ts:960-1218`); the reasoning emission lives at lines 1198-1218:

```1204:1215:repos/ai/packages/langchain/src/utils.ts
if (!messageSeen[msgId]?.reasoning) {
  controller.enqueue({ type: 'reasoning-start', id: msgId });
  messageSeen[msgId] ??= {};
  messageSeen[msgId].reasoning = true;
}

// Streaming chunks have delta text, emit directly without slicing
controller.enqueue({
  type: 'reasoning-delta',
  delta: reasoning,
  id: msgId,
});
```

A `reasoning-delta` is enqueued **immediately upon receipt** of each `AIMessageChunk` carrying a `reasoning` content block. There is no internal buffer.

#### 6b. WHATWG `TransformStream` with a synchronous `transform` is non-blocking

Per [MDN's `TransformStreamDefaultController.enqueue()` reference](https://developer.mozilla.org/en-US/docs/Web/API/TransformStreamDefaultController/enqueue), `enqueue()` is synchronous and returns `undefined`. A transform whose `transform(chunk, controller)` callback (a) does no `await`, (b) calls `controller.enqueue(chunk)` exactly once, and (c) returns synchronously, has the same throughput characteristics as a no-op pipe. The chunk is forwarded to the readable side and the next chunk is pulled in the same microtask tick.

Our reasoning-timing transform is exactly this on the hot path: `reasoning-delta` chunks fall through to a single `controller.enqueue(chunk)` line. Only the rare `reasoning-start` and `reasoning-end` chunks (one each per reasoning block) do any extra work, and that work is one `Date.now()` call + a shallow object spread — well under 1µs.

The HWM-0 stall pitfall called out by [whatwg/streams#1158](https://github.com/whatwg/streams/issues/1158) does not apply: `TransformStream` defaults to `writableStrategy: { highWaterMark: 1 }`, which is the regime under which synchronous one-in-one-out transforms behave identically to a direct pipe.

#### 6c. The AI SDK's UI-message-stream reducer flushes per chunk

`repos/ai/packages/ai/src/ui/process-ui-message-stream.ts` calls `write()` (i.e. invokes the React state-update callback) at the end of **every** case branch — including `reasoning-start`, `reasoning-delta`, and `reasoning-end`. So as long as our transform forwards `reasoning-start` immediately (it does), the React component receives it on the same network frame as the upstream chunk and can begin its stopwatch right away.

#### 6d. No `smoothStream` on the path

The AI SDK's `smoothStream` text-smoothing transform has known bugs that strip `providerMetadata` from chunked reasoning ([vercel/ai#11689](https://github.com/vercel/ai/issues/11689), [vercel/ai#14373](https://github.com/vercel/ai/issues/14373)). Tau's `chat.controller.ts:162-168` pipeline does **not** include `smoothStream`, so we are not exposed to this regression. Our new transform must itself be careful to spread `chunk.providerMetadata` whenever it re-emits a chunk (the proposed code does this).

#### 6e. No backpressure regression introduced

Our transform never returns a Promise, never awaits, and never holds onto chunks across ticks. It cannot apply backpressure that wasn't already there. The only closure-captured state is the per-stream `Map<reasoningId, startedAtMs>` (see Finding 7) — `Map.get`, `Map.set`, and `Map.delete` are O(1) and synchronous, so they don't introduce backpressure either.

**Conclusion**: The proposed pipeline is provably non-blocking for `reasoning-delta` throughput at every layer (LangChain emit → AI SDK adapter → our transform → other transforms → SSE → AI SDK reducer → React). Live counting is achieved purely on the client side via a `useReasoningStopwatch()` hook anchored on the server-stamped `providerMetadata.common.reasoningStartedAtMs` and ticking at 1Hz via `setInterval`.

### Finding 7: Minimal-state server design

**Decision**: the server-side transform is **minimal-state**. It stamps `reasoningStartedAtMs` on `reasoning-start` and **both** `reasoningStartedAtMs` (carried forward) and `reasoningEndedAtMs` on `reasoning-end`, all under a `common` namespace. The client derives `durationMs = reasoningEndedAtMs - reasoningStartedAtMs`.

The transform holds a single transient `Map<reasoningId, startedAtMs>` whose lifetime is the `TransformStream` instance (i.e. the HTTP request stream). Entries are inserted on `reasoning-start` and **drained on `reasoning-end`**, so the high-water mark is bounded by the number of concurrent reasoning blocks within one response (typically 1–2). The map is garbage-collected with the stream.

#### Concession: the per-stream map is required to work around Finding 8

The original revision of this document (≤ revision 4) proposed a strictly stateless transform that stamped only `reasoningStartedAtMs` on `reasoning-start` and only `reasoningEndedAtMs` on `reasoning-end`. That design assumed the AI SDK reducer would deep-merge `providerMetadata` across the chunks of one reasoning part — i.e. that both keys would land on the assembled `ReasoningUIPart`. **That assumption is wrong**: the reducer replaces `providerMetadata` per chunk (see [Finding 8](#finding-8-ai-sdk-reducer-replaces-providermetadata-across-reasoning-chunks)), so emitting only `reasoningEndedAtMs` on `reasoning-end` discards the start timestamp. The minimum amount of state required to fix this — without forking the SDK — is a per-stream lookup of the matching `reasoningStartedAtMs` so the `reasoning-end` chunk can carry both keys.

#### Alternatives evaluated and rejected

1. **`messageMetadata` keyed by reasoning id.** `messageMetadata` does deep-merge, so it would not have the replace-on-write problem. **But** `ReasoningUIPart` (`ai/dist/index.d.ts:1705-1719`) does not retain the chunk `id` on its persisted shape — there is no join key on the client to correlate a metadata bag back to a specific reasoning part within a message that has multiple reasoning blocks. Rejected.
2. **Patch AI SDK upstream to deep-merge `providerMetadata`.** Would conflict with Anthropic's `thinkingSignature` last-writer semantics (the field needs to be replaced by the latest signature, not merged), is unlikely to be accepted upstream, and forks core type definitions. Rejected.
3. **Client-only timing (Vercel `ai-elements`-style `Reasoning` component).** Works for the live counter but loses server-authoritative duration on persisted/reloaded messages and resets on page reload mid-stream. Rejected.
4. **Stay strictly stateless on the server.** That's the bug. Rejected.

#### Why this design beats a heavier stateful one

1. **Localised failure mode.** An unmatched `reasoning-end` (upstream LangChain bug, transform inserted in the wrong order) emits `reasoningEndedAtMs` but omits `reasoningStartedAtMs`. The client's `getReasoningDurationMs` returns `undefined` and the UI cleanly falls back to "Thought process" — same observable behaviour as a pre-instrumentation part. No fabricated timestamps, no silent off-by-X durations.
2. **Bounded memory by construction.** The map cap is "concurrent reasoning blocks within one HTTP stream", typically 1–2. Each entry is `(string id, number ms)` ≈ 32 bytes. There is no global registry, no LRU, no eviction policy required.
3. **No cross-request leakage.** A new `TransformStream` instance is created per HTTP request, so the map's scope cannot extend beyond a single response stream. Unit-tested via the map-isolation test.
4. **Easier to debug.** Both timestamps land on the wire in the same chunk's `providerMetadata.common`, visible in the DevTools network tab as raw JSON.

#### Simpler data model preserved

`durationMs` is still a _derived_ value from `(reasoningStartedAtMs, reasoningEndedAtMs)` — only the endpoints are on the wire, the formula stays in `getReasoningDurationMs`. Future use cases (relating reasoning to surrounding text/tool events on the same timeline, computing think-vs-act ratios per turn) remain straightforward because the timestamps are first-class values on the persisted part.

#### Why a `common` namespace (not `taucad`)

The metadata isn't Tau-specific — it's a property of every reasoning part across every provider, attached at the AI SDK plumbing layer. A `common` namespace signals that intent: keys here are framework-level facts (start/end timestamps) rather than Tau-product-level extensions. Reasoning-feature keys are prefixed (`reasoningStartedAtMs`, `reasoningEndedAtMs`) so the namespace can host other shared concerns (e.g. `firstTokenAtMs` in the future) without clashing.

#### Strong typing through `MyUIMessage`

The wire shape is declared as a typed Zod schema at `libs/chat/src/schemas/common-reasoning-metadata.schema.ts`:

```typescript
export const commonReasoningMetadataSchema = z.object({
  reasoningStartedAtMs: z.number().int().nonnegative().optional(),
  reasoningEndedAtMs: z.number().int().nonnegative().optional(),
});
export type CommonReasoningMetadata = z.infer<typeof commonReasoningMetadataSchema>;
```

The reasoning part schema in `uiMessagesSchema` (`libs/chat/src/schemas/message.schema.ts`) is narrowed to use this typed `common` namespace inside `providerMetadata`:

```typescript
z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  state: z.enum(['streaming', 'done']).optional(),
  providerMetadata: providerMetadataSchema
    .and(z.object({ common: commonReasoningMetadataSchema.optional() }))
    .optional(),
}),
```

Because `uiMessagesSchema` is typed `z.ZodType<MyUIMessage[]>` (`message.schema.ts:181`) and `MyUIMessage = UIMessage<MyMetadata, MyDataPart, MyTools>` (`libs/chat/src/types/message.types.ts:10`), the typed `common` namespace flows through the existing `MyUIMessage` mechanics. UI readers consume it without type-assertion escape hatches:

```typescript
// part.providerMetadata?.common is typed Record<string, JSONValue> | undefined
// safeParse accepts unknown — no `as` cast required
const parsed = commonReasoningMetadataSchema.safeParse(part.providerMetadata?.common);
const startedAtMs = parsed.success ? parsed.data.reasoningStartedAtMs : undefined;
```

This satisfies the project-wide rule "avoid type assertion escape hatches (`as never`, `as unknown as`, unnecessary `as const`)" by routing all unsafe input through Zod's typed `safeParse`.

#### What the minimal-state design does _not_ try to win

1. **Cross-process resumption.** A single in-flight stream is bound to one process (SSE binds to the Node.js worker for its lifetime). If the server crashes mid-stream, the connection breaks and the entire turn fails — no protocol replays just `reasoning-end` with the old block's ID into a new server. So "the server can be replaced behind a load balancer mid-stream" is **out of scope**, not a regression of this design.
2. **The live counter still needs a `setInterval`.** If the displayed value were `latestKnownTimestamp − reasoningStartedAtMs` and `latestKnownTimestamp` only updated on incoming chunks, the counter would freeze between deltas. Models like Claude extended thinking sometimes emit reasoning in coarse 2–5s chunks, producing a jerky counter that jumps from 0s → 3s → 5s. For a smooth 1Hz UX, the client _must_ have a `setInterval` that recomputes against an anchor on every tick. The hook stays; the anchor is the server-stamped `reasoningStartedAtMs`, used directly with no client-side fallback logic.

#### Clock skew: accepted as a known limitation

Using `Date.now()` (wall clock) instead of `performance.now()` (monotonic) is fine for the **final** duration: both timestamps are taken on the same server within ms-to-minutes, and any NTP adjustment landing in that window is operationally rare (visible in OS logs). `Math.max(0, end - start)` clamps the pathological case.

For the **live counter**, the client computes `Date.now() - reasoningStartedAtMs` on each tick. Browser and server wall clocks can disagree by a few seconds (no NTP sync on most browsers); when the disparity is non-trivial the live counter may start at a small non-zero value or briefly overshoot the final duration when `reasoning-end` lands. **This is accepted** in exchange for a substantially simpler client implementation:

- No client-arrival-time anchor ref.
- No fallback selection logic.
- No two-mode hook contract.
- Server time is treated as authoritative on both sides of the wire (consistent with the rest of the timing-via-`providerMetadata` design).

In practice clock skew is small (<1s on synced systems, occasionally a few seconds on unsynced ones) and only affects the live counter — the persisted final duration is server-authoritative and exact.

#### Why we don't stamp every `reasoning-delta`

Stamping every `reasoning-delta` with `serverTimestampMs` would (a) bloat the wire with hundreds of redundant timestamps per block, (b) not enable any UX improvement beyond the two-endpoint design, and (c) still require a client `setInterval` for smooth ticking (because deltas don't arrive at 1Hz). Two timestamps per block is the right granularity.

#### Final wire contract

| Field                                          | Stamped on                                                                                   | Type                | Role                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `providerMetadata.common.reasoningStartedAtMs` | `reasoning-start` **and re-stamped on** `reasoning-end` (carried forward via per-stream map) | `number` (ms epoch) | Pair-start for derived duration; live-counter anchor                  |
| `providerMetadata.common.reasoningEndedAtMs`   | `reasoning-end`                                                                              | `number` (ms epoch) | Pair-end for derived duration                                         |
| `durationMs` (derived)                         | client-side                                                                                  | `number` (ms)       | `reasoningEndedAtMs - reasoningStartedAtMs` — the final display value |

### Finding 8: AI SDK reducer replaces `providerMetadata` across reasoning chunks

**Source-verified in `node_modules/.pnpm/ai@6.0.141_zod@4.3.6/node_modules/ai/dist/index.js:5530-5570`** (the same logic ships in upstream `repos/ai/packages/ai/src/ui/process-ui-message-stream.ts`). On every chunk that carries a `providerMetadata`, `processUIMessageStream` overwrites `ReasoningUIPart.providerMetadata` rather than deep-merging it:

```javascript
case "reasoning-end":
  reasoningPart.providerMetadata =
    chunk.providerMetadata ?? reasoningPart.providerMetadata;
```

Equivalent assignments live in the `reasoning-start` and `reasoning-delta` branches. This is **the documented contract** for `providerMetadata` — it's designed to carry per-chunk provider state (Anthropic's `thinkingSignature` is the canonical example: it must be replaced wholesale, not merged across deltas).

#### Concrete consequence

A strictly-stateless transform that emits:

- `reasoning-start` → `providerMetadata = { common: { reasoningStartedAtMs: t0 } }`
- `reasoning-delta` → no `providerMetadata`
- `reasoning-end` → `providerMetadata = { common: { reasoningEndedAtMs: t1 } }`

produces a final `ReasoningUIPart.providerMetadata` of `{ common: { reasoningEndedAtMs: t1 } }`. The `reasoningStartedAtMs` from `reasoning-start` is silently overwritten by the `reasoning-end` chunk's `providerMetadata`. `getReasoningDurationMs` returns `undefined` (one endpoint missing) and the UI falls back to "Thought process" — the production bug observed in revision 4.

Note that `reasoning-delta` chunks carrying _no_ `providerMetadata` do not overwrite (the `?? reasoningPart.providerMetadata` fallback guards this), so the start timestamp survives all the deltas — it's only the `reasoning-end` chunk that destroys it.

#### Why we can't fix this with `messageMetadata`

`messageMetadata` _is_ deep-merged on every chunk that supplies it. But the `ReasoningUIPart` (`ai/dist/index.d.ts:1705-1719`) does not retain the chunk `id` on its persisted shape, so there is no join key on the client to correlate metadata back to a specific reasoning part — particularly for messages with multiple reasoning blocks. This was investigated and rejected before settling on the per-stream map.

#### Why we can't fix this in the AI SDK upstream

Changing `providerMetadata` to deep-merge across reasoning chunks would break Anthropic's `thinkingSignature` (and analogous fields from other providers) which rely on last-writer semantics. We treat the SDK behaviour as a contract and adapt around it.

#### Upstream issue search

We searched github.com/vercel/ai for prior reports of this specific behaviour (`providerMetadata` replace-on-write across reasoning chunks) and found none. The closest related issues are [vercel/ai#11689](https://github.com/vercel/ai/issues/11689) and [vercel/ai#14373](https://github.com/vercel/ai/issues/14373), which are about `smoothStream` _stripping_ `providerMetadata` — a different (composition) layer. Vercel's own `ai-elements` `Reasoning` component sidesteps the entire question by doing client-side wall-clock timing instead of relying on server-stamped metadata.

#### Resolution

Carry the `reasoningStartedAtMs` forward to the `reasoning-end` chunk via the per-stream `Map<reasoningId, startedAtMs>` documented in [Finding 7](#finding-7-minimal-state-server-design). After the fix, `reasoning-end` emits `providerMetadata = { common: { reasoningStartedAtMs: t0, reasoningEndedAtMs: t1 } }`, both keys survive the reducer's last-writer-wins replacement, and the assembled `ReasoningUIPart` has both endpoints.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort               | Impact                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| R1  | Add **minimal-state** `createReasoningTimingTransform()` in `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` with a transient per-`TransformStream`-instance `Map<reasoningId, startedAtMs>`. On `reasoning-start`: stamp `providerMetadata.common.reasoningStartedAtMs = Date.now()` and store in the map. On `reasoning-end`: look up the matching `startedAtMs`, stamp **both** `reasoningStartedAtMs` (carried forward — required by Finding 8) and `reasoningEndedAtMs = Date.now()`, then drain the map entry. **Pass-through (zero work) on `reasoning-delta`**. Hot path is one `enqueue` per delta — non-blocking by construction (Finding 6); map is bounded by concurrent reasoning blocks (Finding 7)                                                                                                                   | P0       | Low (~60 LOC + test) | High — primary deliverable                                            |
| R2  | Insert the new transform into `chat.controller.ts:162-168` **immediately after `toUIMessageStream(stream)`**, before any other transform. This guarantees `reasoningStartedAtMs` / `reasoningEndedAtMs` are stamped against the earliest possible timestamps and downstream transforms can see the timing metadata if they need to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P0       | Trivial              | High                                                                  |
| R3  | Add a typed Zod schema in `libs/chat/src/schemas/common-reasoning-metadata.schema.ts` (`commonReasoningMetadataSchema = z.object({ reasoningStartedAtMs: z.number().int().nonnegative().optional(), reasoningEndedAtMs: z.number().int().nonnegative().optional() })`). **Narrow the reasoning part schema in `uiMessagesSchema` (`libs/chat/src/schemas/message.schema.ts`) to type `providerMetadata` as `providerMetadataSchema.and(z.object({ common: commonReasoningMetadataSchema.optional() }))`** so `MyUIMessage` carries the strongly-typed `common` namespace through `MyMessagePart`. Add typed readers `getReasoningStartedAtMs(part)` / `getReasoningEndedAtMs(part)` / `getReasoningDurationMs(part)` (derived: `reasoningEndedAtMs - reasoningStartedAtMs`) using `safeParse` to consume the typed metadata without `as` casts | P0       | Low                  | High — type safety + DX                                               |
| R4  | Update `ChatMessageReasoning` to render the dynamic label via `formatReasoningDuration(ms)`: `< 1000` → `"Thought briefly"`, `< 60_000` → `"Thought for ${seconds}s"`, otherwise `"Thought for ${m}m ${s}s"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P0       | Low                  | High — primary deliverable                                            |
| R5  | Style the suffix in muted color (`text-foreground/60`) like the example screenshot — split label into `<span>Thought</span><span className="text-foreground/60"> for 2s</span>` so the verb stays prominent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1       | Trivial              | Medium — UX polish                                                    |
| R6  | Add unit tests: transform-level (chunk in → chunk out + correct timestamp keys, no metadata loss, **`reasoning-end` carries `reasoningStartedAtMs` matching its paired `reasoning-start`** — locks in the Finding 8 contract, multiple concurrent blocks each get their own start/end stamps without cross-contamination, map isolation across distinct `TransformStream` instances, map drain so memory is bounded) **and** an end-to-end regression test through the publicly-exported `readUIMessageStream` proving both timestamps survive the AI SDK reducer's replace-on-write; plus formatter-level (boundary cases at 999/1000/59999/60000 ms)                                                                                                                                                                                         | P0       | Low                  | High — regression guard                                               |
| R7  | **[Promoted to P0]** Add `useReasoningStopwatch(startedAtMs, enabled)` hook in `apps/ui/app/utils/use-reasoning-stopwatch.ts`. **Anchors directly on the server-stamped `reasoningStartedAtMs`** — no client-arrival ref, no fallback selection. Returns `Math.max(0, Date.now() - startedAtMs)`; while `enabled === true`, schedules a 1Hz `setInterval` to force re-render. Returns `0` when `startedAtMs === undefined` (defensive). Server time is treated as authoritative on both sides of the wire; small browser/server clock skew is accepted as a known limitation per Finding 7                                                                                                                                                                                                                                                     | P0       | Low (~25 LOC + test) | High — required for "Thinking for Ns…" UX without blocking the stream |
| R8  | (Optional, follow-up) Mirror Claude Code's per-turn `"Worked for"` summary in `ChatMessageDataUsage` by adding `turnDurationMs` to `usageDataSchema`, populated from `wrapModelCall` start/end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P3       | Low                  | Low — different UX layer                                              |

## Architecture

### Data Flow

```
[LangChain stream — synchronous per-token enqueue]
       │   reasoning-start(id=R1)
       │   reasoning-delta(id=R1, delta="…")   ← arrives every model token
       │   reasoning-delta(id=R1, delta="…")
       │   …
       │   reasoning-end(id=R1, providerMetadata={anthropic:{…}})
       ▼
toUIMessageStream  (no batching — controller.enqueue per chunk)
       ▼
createReasoningTimingTransform   ── NEW (minimal-state, synchronous, non-blocking)
       │  reasoning-start  → t0 = Date.now()
       │                     map.set(id, t0)
       │                     stamp providerMetadata.common.reasoningStartedAtMs = t0
       │  reasoning-delta  → controller.enqueue(chunk)   ◀── pure pass-through
       │  reasoning-end    → t0 = map.get(id) ; map.delete(id)
       │                     stamp providerMetadata.common.{
       │                       reasoningStartedAtMs: t0,        ◀── carried forward (Finding 8)
       │                       reasoningEndedAtMs:   Date.now()
       │                     }
       │
       │  per-stream Map<id, t0>, drained on reasoning-end, dies with the stream
       ▼
createNewlineTrimTransform / other transforms (synchronous pass-through for non-text/reasoning chunks)
       ▼
SSE → client (per-chunk flush)
       ▼
process-ui-message-stream  ── calls write() per chunk; React re-renders per chunk
       ▼
[uiMessagesSchema narrows providerMetadata.common to commonReasoningMetadataSchema]
       ▼  → MyUIMessage.parts[reasoning].providerMetadata.common is strongly typed
┌─────────────────────────────────────────────────────────────────────┐
│ ChatMessageReasoning                                                │
│   const startedAtMs = getReasoningStartedAtMs(part) // typed, no as  │
│   const isStreaming = part.state === 'streaming'                     │
│   const liveMs = useReasoningStopwatch(startedAtMs, isStreaming)     │
│                                                                      │
│   if (isStreaming) {                                                 │
│     → live "Thinking for 3s…" updated at 1Hz from server anchor     │
│   } else {                                                           │
│     duration = getReasoningDurationMs(part) // derived client-side   │
│     → formatReasoningDuration(duration) → "Thought for 2s"           │
│   }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Code Examples

**`apps/api/app/api/chat/utils/reasoning-timing-transform.ts`** (proposed — minimal-state):

The transform is engineered to be provably non-blocking and minimal-state:

- The `transform` callback is **synchronous** (no `async`, no `await`) — required for sustained per-chunk throughput.
- The `reasoning-delta` branch is a **single `controller.enqueue(chunk)` line** with zero metadata mutation. Throughput == identity pipe.
- A single closure-captured `Map<reasoningId, startedAtMs>` carries the start timestamp from `reasoning-start` to its paired `reasoning-end`. Required because the AI SDK reducer replaces `providerMetadata` per chunk (see [Finding 8](#finding-8-ai-sdk-reducer-replaces-providermetadata-across-reasoning-chunks)) — without it, the start timestamp is silently dropped.
- The map is per-`TransformStream`-instance (a fresh map is allocated per HTTP request) and entries are deleted on `reasoning-end`, so memory is bounded by the number of concurrent reasoning blocks within one response (typically 1–2).
- `chunk.providerMetadata` is spread into the new chunk on `reasoning-start` and `reasoning-end` so any upstream provider metadata (e.g. Anthropic's `thinking` signature) is preserved — see [vercel/ai#11689](https://github.com/vercel/ai/issues/11689) for a real-world bug caused by stripping it.
- The `patch` argument is typed as `Partial<CommonReasoningMetadata>` (the inferred type of the shared Zod schema) so the merge is strongly typed end-to-end without `as` escape hatches.

```typescript
import type { UIMessageChunk } from 'ai';
import type { CommonReasoningMetadata } from '@taucad/chat';

const commonMetadataNamespace = 'common' as const;

const stampCommonMetadata = (
  existing: UIMessageChunk['providerMetadata'] | undefined,
  patch: Partial<CommonReasoningMetadata>,
): NonNullable<UIMessageChunk['providerMetadata']> => ({
  ...(existing ?? {}),
  [commonMetadataNamespace]: {
    ...(existing?.[commonMetadataNamespace] ?? {}),
    ...patch,
  },
});

export const createReasoningTimingTransform = (): TransformStream<UIMessageChunk, UIMessageChunk> => {
  // Per-stream ledger of reasoning-start timestamps, keyed by chunk id.
  // Drained on reasoning-end. Bounded by concurrent reasoning blocks within
  // one HTTP stream (typically 1-2). Dies with the stream.
  // Required by Finding 8: AI SDK's processUIMessageStream reducer replaces
  // ReasoningUIPart.providerMetadata on every chunk that carries one, so
  // emitting only `reasoningEndedAtMs` on reasoning-end would discard the
  // startedAtMs from reasoning-start.
  const startedAtMsById = new Map<string, number>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'reasoning-start') {
        const startedAtMs = Date.now();
        startedAtMsById.set(chunk.id, startedAtMs);
        controller.enqueue({
          ...chunk,
          providerMetadata: stampCommonMetadata(chunk.providerMetadata, {
            reasoningStartedAtMs: startedAtMs,
          }),
        });
        return;
      }

      if (chunk.type === 'reasoning-end') {
        const startedAtMs = startedAtMsById.get(chunk.id);
        startedAtMsById.delete(chunk.id);
        controller.enqueue({
          ...chunk,
          providerMetadata: stampCommonMetadata(chunk.providerMetadata, {
            // Carry the matching start forward so the AI SDK reducer's
            // replace-on-write doesn't drop it. Omitted (not fabricated)
            // for unmatched ends so getReasoningDurationMs cleanly returns
            // undefined and the UI falls back to "Thought process".
            ...(startedAtMs !== undefined ? { reasoningStartedAtMs: startedAtMs } : {}),
            reasoningEndedAtMs: Date.now(),
          }),
        });
        return;
      }

      controller.enqueue(chunk);
    },
  });
};
```

Note: `Date.now()` is used (not `performance.now()`) so the two timestamps are mutually subtractable across the wire — a derived `reasoningEndedAtMs - reasoningStartedAtMs` is the source of truth for the final duration. This trades sub-millisecond precision for cross-process meaning, which is the right trade for a duration whose typical magnitude is seconds-to-minutes. See [Finding 7: Minimal-state server design](#finding-7-minimal-state-server-design) for the full rationale.

**`libs/chat/src/schemas/common-reasoning-metadata.schema.ts`** (proposed):

```typescript
import { z } from 'zod';
import type { ReasoningUIPart } from 'ai';

export const commonReasoningMetadataSchema = z.object({
  reasoningStartedAtMs: z.number().int().nonnegative().optional(),
  reasoningEndedAtMs: z.number().int().nonnegative().optional(),
});

export type CommonReasoningMetadata = z.infer<typeof commonReasoningMetadataSchema>;

/**
 * Read the typed `common` namespace off a reasoning part's providerMetadata.
 *
 * `safeParse` accepts `unknown` directly, so we never need an `as` cast — the
 * loose `Record<string, JSONValue>` shape from AI SDK is funnelled through
 * the typed Zod schema and emerges as `CommonReasoningMetadata | undefined`.
 */
const readCommonReasoningMetadata = (part: ReasoningUIPart): CommonReasoningMetadata | undefined => {
  const result = commonReasoningMetadataSchema.safeParse(part.providerMetadata?.['common']);
  return result.success ? result.data : undefined;
};

export const getReasoningStartedAtMs = (part: ReasoningUIPart): number | undefined =>
  readCommonReasoningMetadata(part)?.reasoningStartedAtMs;

export const getReasoningEndedAtMs = (part: ReasoningUIPart): number | undefined =>
  readCommonReasoningMetadata(part)?.reasoningEndedAtMs;

/**
 * Derived final reasoning duration in milliseconds.
 *
 * Returns the difference `reasoningEndedAtMs - reasoningStartedAtMs` when both
 * are present (i.e. the reasoning block has fully closed and was timed by the
 * server). Returns `undefined` for in-progress blocks or pre-instrumentation
 * parts. The value is *derived*, not transmitted — keeping the wire format
 * minimal and the source-of-truth a function of the two endpoints.
 */
export const getReasoningDurationMs = (part: ReasoningUIPart): number | undefined => {
  const meta = readCommonReasoningMetadata(part);
  if (meta?.reasoningStartedAtMs === undefined || meta.reasoningEndedAtMs === undefined) {
    return undefined;
  }
  return Math.max(0, meta.reasoningEndedAtMs - meta.reasoningStartedAtMs);
};
```

**Schema integration in `libs/chat/src/schemas/message.schema.ts`** — narrow the existing reasoning part to use the typed `common` namespace so `MyUIMessage` carries it through:

```typescript
// existing import block + new:
import { commonReasoningMetadataSchema } from '#schemas/common-reasoning-metadata.schema.js';

// inside uiMessagesSchema's parts union, replace the reasoning entry with:
z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  state: z.enum(['streaming', 'done']).optional(),
  providerMetadata: providerMetadataSchema
    .and(z.object({ common: commonReasoningMetadataSchema.optional() }))
    .optional(),
}),
```

This narrowing flows through `z.ZodType<MyUIMessage[]>` (`message.schema.ts:181`) so the typed `common` namespace is visible on `MyMessagePart` when narrowed to `type === 'reasoning'` — UI consumers get full IntelliSense without writing any cast.

**`apps/ui/app/utils/format-reasoning-duration.ts`** (proposed):

```typescript
const briefThresholdMs = 1000;
const minuteMs = 60_000;

export const formatReasoningDuration = (
  durationMs: number,
  options: { verb?: 'Thought' | 'Thinking' } = {},
): string => {
  const verb = options.verb ?? 'Thought';
  if (durationMs < briefThresholdMs) {
    return verb === 'Thinking' ? 'Thinking…' : 'Thought briefly';
  }
  if (durationMs < minuteMs) {
    const seconds = Math.round(durationMs / 1000);
    return `${verb} for ${seconds}s`;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${verb} for ${minutes}m` : `${verb} for ${minutes}m ${seconds}s`;
};
```

**`apps/ui/app/utils/use-reasoning-stopwatch.ts`** (proposed — required for live counter without blocking the stream):

```typescript
import { useEffect, useState } from 'react';

const tickIntervalMs = 1000;

/**
 * Live elapsed-time stopwatch for streaming reasoning blocks.
 *
 * Anchors directly on the server-stamped `reasoningStartedAtMs` — server time
 * is treated as authoritative on both sides of the wire (consistent with the
 * rest of the timing-via-providerMetadata design). Browser/server clock skew
 * is accepted as a known limitation in exchange for a substantially simpler
 * client implementation; see Finding 7 in
 * docs/research/reasoning-duration-display.md for the trade-off rationale.
 *
 * While `enabled` is true, schedules a 1Hz `setInterval` to force a re-render
 * so the displayed elapsed value advances smoothly between (potentially coarse)
 * reasoning-delta arrivals. The interval clears as soon as `enabled` flips to
 * false (e.g. when `state === 'done'`).
 *
 * Returns 0 when `startedAtMs` is undefined (defensive — pre-instrumentation
 * persisted parts).
 *
 * The hook performs zero work that touches the SSE pipeline — it is purely
 * client-local and orthogonal to the AI SDK reducer that drives streaming.
 */
export const useReasoningStopwatch = (startedAtMs: number | undefined, enabled: boolean): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const intervalId = setInterval(() => setNow(Date.now()), tickIntervalMs);
    return () => clearInterval(intervalId);
  }, [enabled]);

  if (startedAtMs === undefined) return 0;
  return Math.max(0, now - startedAtMs);
};
```

**UI integration** in `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx` (replace the current label span):

```tsx
const startedAtMs = getReasoningStartedAtMs(part);
const finalDurationMs = getReasoningDurationMs(part); // derived: endedAtMs - startedAtMs
const isStreaming = part.state === 'streaming';

const liveElapsedMs = useReasoningStopwatch(startedAtMs, isStreaming);

const label = isStreaming
  ? formatReasoningDuration(liveElapsedMs, { verb: 'Thinking' })
  : finalDurationMs !== undefined
    ? formatReasoningDuration(finalDurationMs, { verb: 'Thought' })
    : 'Thought process';

const [verb, ...rest] = label.split(' ');
const suffix = rest.length > 0 ? ` ${rest.join(' ')}` : '';

<span className='flex min-w-0 items-baseline gap-1'>
  <span>{verb}</span>
  {suffix && <span className='text-foreground/60'>{suffix}</span>}
</span>;
```

Importantly: nothing in the UI blocks the SSE stream. `useReasoningStopwatch` only schedules a `setInterval` on the React side; reasoning deltas continue to land in `process-ui-message-stream` and trigger their own `write()` re-renders independently. The stopwatch and the streaming reducer are completely orthogonal. The final-duration value is derived from the two server-stamped endpoints (`reasoningEndedAtMs - reasoningStartedAtMs`) — the server itself never computes a duration.

### Edge Cases

| Case                                                                                    | Handling                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty reasoning block (no deltas)                                                       | Both `reasoningStartedAtMs` (carried forward via map) and `reasoningEndedAtMs` are still stamped on `reasoning-end`; derived duration is ~0ms; formatter returns "Thought briefly"                                                                                                                                          |
| `reasoning-end` arrives with no matching `reasoning-start` (upstream bug)               | Map lookup misses; transform stamps `reasoningEndedAtMs` only — `reasoningStartedAtMs` is **omitted, not fabricated**. `getReasoningDurationMs` returns `undefined`; UI falls back to "Thought process" — same observable behaviour as a pre-instrumentation part. Documented in code                                       |
| Multiple concurrent reasoning blocks (interleaved)                                      | Each chunk carries its own `id`; the map keys by `id`, so each `reasoning-end` looks up the correct paired `reasoning-start`. Cross-block contamination is impossible (locked in by the interleaved-blocks test)                                                                                                            |
| Server restart mid-stream                                                               | Connection breaks, turn fails. Same as today. The map dies with the `TransformStream` instance, so no entries can leak across requests                                                                                                                                                                                      |
| Server is replaced behind a load balancer between `reasoning-start` and `reasoning-end` | **Out of scope** — SSE binds the stream to a single Node.js worker for its lifetime. There is no protocol that would replay just `reasoning-end` into a new server, so the question doesn't arise in practice                                                                                                               |
| Two reasoning blocks reusing the same `id` within one stream (defensive)                | Second `reasoning-start` overwrites the map entry with its own `startedAtMs`; second `reasoning-end` consumes that latest value. Out-of-spec input but non-crashing and covered by the map-drain test                                                                                                                       |
| Reasoning never closes (stream aborted before `reasoning-end`)                          | No `reasoningEndedAtMs` is emitted; UI keeps showing live "Thinking for Ns…" until the part is unmounted. The map entry is freed when the `TransformStream` is garbage-collected at end-of-stream — no per-process leak                                                                                                     |
| Anthropic provider already supplies its own `providerMetadata`                          | Spread merge preserves it; `common` namespace is additive                                                                                                                                                                                                                                                                   |
| Browser/server clock skew (small, typical)                                              | Final duration is unaffected — both timestamps are taken on the same server. Live counter may start at a small non-zero value (e.g. browser clock 1s ahead) or briefly overshoot when `reasoning-end` lands. **Accepted as a known limitation per Finding 7** in exchange for a substantially simpler client implementation |
| Browser/server clock skew (pathological, e.g. 10+ seconds)                              | Live counter starts at ~10s. Cosmetic; the persisted final duration is server-authoritative and exact, so the post-completion label is correct                                                                                                                                                                              |
| NTP backwards jump on the server between start and end                                  | Theoretical risk only — operationally rare (visible in OS logs). Worst case yields a negative `reasoningEndedAtMs - reasoningStartedAtMs`; `Math.max(0, …)` clamps it. Formatter renders "Thought briefly"                                                                                                                  |
| Persisted message reloaded after `state === 'done'`                                     | `reasoningStartedAtMs` and `reasoningEndedAtMs` are persisted on the part — `getReasoningDurationMs` works deterministically without any client-side ticking                                                                                                                                                                |
| Persisted message reloaded mid-stream (rare; depends on persistence model)              | `useReasoningStopwatch` continues to anchor on `reasoningStartedAtMs` — counter resumes from approximately the right value (modulo clock skew) until `reasoningEndedAtMs` lands                                                                                                                                             |
| Future `smoothStream` adoption                                                          | If we ever insert `smoothStream` in the pipeline, it must be placed **after** `createReasoningTimingTransform` and the `providerMetadata`-stripping bugs ([vercel/ai#11689](https://github.com/vercel/ai/issues/11689), [vercel/ai#14373](https://github.com/vercel/ai/issues/14373)) must be patched first                 |

## Trade-offs

| Approach                                                                                                                                                                                                                                                                                                               | Pros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Cons                                                                                                                                                                                                                                                                                                                                                                                               | Verdict                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Minimal-state TransformStream: per-stream `Map<id, startedAtMs>`, stamps both `common.reasoningStartedAtMs` (carried forward) and `common.reasoningEndedAtMs` on `reasoning-end` + typed Zod schema narrowed in `uiMessagesSchema` + client-derived duration + client stopwatch anchored on server time (R1+R3+R7)** | Per-block accuracy; round-trips through persistence; provider-agnostic; **provably non-blocking — single `enqueue` per delta**; map is bounded by concurrent reasoning blocks within one stream (typically 1–2) and dies with the stream; cleanly handles unmatched ends by omitting (not fabricating) `reasoningStartedAtMs`; debuggable (timestamps visible on the wire as raw JSON); **strongly typed end-to-end via `MyUIMessage` — no `as` casts in UI readers**; works with the AI SDK's documented replace-on-write `providerMetadata` semantics rather than against them | Server holds a tiny per-request map (≈ 32 bytes per concurrent block, drained on `reasoning-end`); final duration is derived client-side rather than transmitted (one extra subtraction); uses `Date.now()` (ms precision) not `performance.now()` (sub-ms) — irrelevant at the magnitudes that matter; live counter exposed to small browser/server clock skew (cosmetic, accepted per Finding 7) | **Adopt**                                                                             |
| Strictly stateless TransformStream — only stamps `reasoningStartedAtMs` on `reasoning-start` and only `reasoningEndedAtMs` on `reasoning-end` (the original revision-4 design)                                                                                                                                         | No closure-captured state at all; symmetric in shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Doesn't work** — AI SDK's `processUIMessageStream` reducer replaces `ReasoningUIPart.providerMetadata` per chunk (Finding 8), so the start timestamp is silently overwritten when `reasoning-end` lands. `getReasoningDurationMs` returns `undefined` and the UI falls back to "Thought process"                                                                                                 | Reject — produces the production bug observed in revision 4                           |
| Stateful TransformStream with per-id `Map<string, number>` ledger + `performance.now()` + server-computed `reasoningDurationMs`                                                                                                                                                                                        | Sub-ms precision (immaterial in practice); single derived value on the wire instead of two endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Putting the derived value on the wire makes future timeline use cases (think-vs-act ratios, relating reasoning to surrounding events) require re-instrumenting the server; harder to debug because the source values aren't visible in DevTools                                                                                                                                                    | Reject — same map cost as the chosen design with strictly less downstream flexibility |
| Client-arrival anchor for the live counter (with `startedAtMs` as fallback)                                                                                                                                                                                                                                            | Avoids any visible clock-skew artifact when the live counter starts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Two-mode hook contract (anchor selection logic, fallback ref); diverges from the "server is authoritative" model used everywhere else; doesn't help the persisted-mid-stream case anyway (still falls back to `startedAtMs`); skew on most synced systems is sub-second and visually undetectable                                                                                                  | Reject — complexity not justified by the cosmetic improvement                         |
| `wrapModelCall` middleware                                                                                                                                                                                                                                                                                             | Co-located with other timing middleware                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Wrong granularity (whole call ≠ one reasoning block); blind to interleaved blocks                                                                                                                                                                                                                                                                                                                  | Reject                                                                                |
| `BaseCallbackHandler.handleLLMNewToken`                                                                                                                                                                                                                                                                                | Reuses existing `TtftCallbackHandler` infrastructure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Cannot distinguish reasoning tokens from text tokens (`handleLLMNewToken` is content-agnostic in LangChain.js)                                                                                                                                                                                                                                                                                     | Reject                                                                                |
| Custom `data-reasoning-timing` part via `runtime.writer()`                                                                                                                                                                                                                                                             | Decouples from `providerMetadata` shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | New schema, new render path, doesn't naturally attach to its reasoning part                                                                                                                                                                                                                                                                                                                        | Reject                                                                                |
| `messageMetadata` callback on `toUIMessageStreamResponse`                                                                                                                                                                                                                                                              | Officially documented AI SDK 5 path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Message-level, not block-level — fails on interleaved reasoning                                                                                                                                                                                                                                                                                                                                    | Reject                                                                                |
| **Server-side live counter via `runtime.writer({ type: 'reasoning-tick', elapsedMs })`** at e.g. 1Hz                                                                                                                                                                                                                   | Server is authoritative for the live counter too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Doubles SSE event volume during reasoning**; introduces a new transient data part; ticks must be debounced per-block; still client-rendered anyway                                                                                                                                                                                                                                               | Reject — client `setInterval` achieves the same visual result with zero server cost   |
| Server-side `async` transform with `await new Promise(setImmediate)` between deltas                                                                                                                                                                                                                                    | Could in principle smooth backpressure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Would block reasoning streaming** — exactly what we prohibited                                                                                                                                                                                                                                                                                                                                   | Reject                                                                                |
| Stamping `serverTimestampMs` on every `reasoning-delta`                                                                                                                                                                                                                                                                | Per-token timeline available on the client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Bloats wire format with hundreds of redundant timestamps per block; doesn't enable any UX improvement over the two-endpoint design; still requires a client `setInterval` for smooth ticking                                                                                                                                                                                                       | Reject                                                                                |
| Client-only `useEffect` stopwatch with no server `startedAtMs`/`endedAtMs`                                                                                                                                                                                                                                             | Zero server work; matches Claude Code's client-only pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No server-authoritative final duration; counter resets to zero on page reload mid-stream; no anchor in persisted history                                                                                                                                                                                                                                                                           | Reject — server stamps cost nothing and unlock persistence + history rendering        |

## References

- [vercel/ai #4798 — "Add reasoning time"](https://github.com/vercel/ai/issues/4798) (closed; recommends metadata system)
- [vercel/ai #11689 — `smoothStream` strips `providerMetadata` from `reasoning-delta`](https://github.com/vercel/ai/issues/11689) (regression to avoid in our transform)
- [vercel/ai #14373 — `smoothStream` drops `providerMetadata` from chunked stream parts](https://github.com/vercel/ai/issues/14373)
- [AI SDK Streaming Custom Data docs](https://sdk.vercel.ai/docs/ai-sdk-ui/streaming-data)
- [AI SDK Message Metadata docs](https://sdk.vercel.ai/docs/ai-sdk-ui/message-metadata)
- LangChain.js [Streaming guide](https://docs.langchain.com/oss/javascript/langchain/streaming/) and [Reasoning tokens guide](https://docs.langchain.com/oss/javascript/langchain/frontend/reasoning-tokens) (per-token streaming for reasoning blocks)
- LangGraph.js [Streaming modes](https://docs.langchain.com/oss/javascript/langgraph/streaming) — `messages` mode emits `(BaseMessageChunk, metadata)` per LLM token
- LangChain.js [`WrapModelCallHook` reference](https://reference.langchain.com/javascript/langchain/index/WrapModelCallHook)
- [MDN — `TransformStreamDefaultController.enqueue()`](https://developer.mozilla.org/en-US/docs/Web/API/TransformStreamDefaultController/enqueue) (synchronous, non-blocking)
- [whatwg/streams #1158](https://github.com/whatwg/streams/issues/1158) — HWM-0 stall pitfall (does not apply to default `highWaterMark: 1`)
- Tau internal: `apps/api/app/api/chat/middleware/llm-timing.middleware.ts`, `apps/api/app/api/chat/middleware/ttft-callback.handler.ts`, `apps/api/app/api/chat/utils/newline-trim-transform.ts`
- Prior art: `repos/claude-code/src/components/Spinner/SpinnerAnimationRow.tsx`, `repos/codex/codex-rs/tui/src/status_indicator_widget.rs`, `repos/zoo-modeling-app/src/components/Thinking.tsx`

## Appendix: Implementation Checklist

Concrete order of operations to land R1–R7:

1. Add `libs/chat/src/schemas/common-reasoning-metadata.schema.ts` exporting `commonReasoningMetadataSchema`, the inferred `CommonReasoningMetadata` type, and the typed readers `getReasoningStartedAtMs` / `getReasoningEndedAtMs` / `getReasoningDurationMs` (the last is **derived** as `reasoningEndedAtMs - reasoningStartedAtMs` with `Math.max(0, …)` clamping). All readers use `safeParse` — no `as` casts.
2. **Narrow the reasoning part schema in `libs/chat/src/schemas/message.schema.ts`** to type its `providerMetadata` as `providerMetadataSchema.and(z.object({ common: commonReasoningMetadataSchema.optional() }))`. This is the linchpin step that makes the typing flow through `MyUIMessage` to all UI consumers.
3. Add the barrel export from `libs/chat/src/index.ts` for the new schema/readers/type.
4. Add `libs/chat/src/schemas/common-reasoning-metadata.schema.test.ts`: assert `getReasoningDurationMs` returns `undefined` when either endpoint is missing; assert clamping when `reasoningEndedAtMs < reasoningStartedAtMs` (NTP-jump edge case); assert ignored when `providerMetadata.common` has unrelated keys; assert the typed reader emits the expected `CommonReasoningMetadata` shape.
5. Create `apps/api/app/api/chat/utils/reasoning-timing-transform.ts` (**minimal-state** transform: synchronous, per-`TransformStream`-instance `Map<reasoningId, startedAtMs>`, `stampCommonMetadata` helper typed as `Partial<CommonReasoningMetadata>`, stamps `reasoningStartedAtMs` on `reasoning-start` and **both** carried-forward `reasoningStartedAtMs` plus `reasoningEndedAtMs` on `reasoning-end`).
6. Create `apps/api/app/api/chat/utils/reasoning-timing-transform.test.ts` (vitest):
   - **End-to-end through the AI SDK reducer (Finding 8 regression)**: pipe `start → delta → end` through `createReasoningTimingTransform()` and then `readUIMessageStream({ stream })` from `ai`; assert the assembled `ReasoningUIPart.providerMetadata.common` carries **both** `reasoningStartedAtMs` and `reasoningEndedAtMs` as numbers. This is the primary regression guard.
   - **`reasoning-end` carries the matching `reasoningStartedAtMs`**: the new contract — locked in at the transform level too.
   - **Pass-through identity for `reasoning-delta`**: deltas emerge byte-for-byte identical to input (locks in non-blocking guarantee — no metadata mutation, no rewrap).
   - **`reasoningStartedAtMs` stamping on `reasoning-start`**: positive integer.
   - **`reasoningEndedAtMs` ≥ `reasoningStartedAtMs`** on the matching `reasoning-end`.
   - **Concurrent blocks**: interleaved `reasoning-start(id=A) … reasoning-start(id=B) … reasoning-end(id=A) … reasoning-end(id=B)` — each `reasoning-end` carries the `reasoningStartedAtMs` of its matching `reasoning-start`, no cross-contamination.
   - **Provider metadata preservation**: existing `providerMetadata.anthropic` (and any other namespace) preserved when adding `common` on both start and end.
   - **Unmatched `reasoning-end`**: gets `reasoningEndedAtMs` only; `reasoningStartedAtMs` is omitted (not fabricated).
   - **Map isolation across distinct `TransformStream` instances**: a `reasoning-start` on one instance does not leak to a `reasoning-end` on another instance.
   - **Map drain**: pumping start+end for the same `id` twice in the same stream — each `reasoning-end` carries the `startedAtMs` of its **matching** start (the second pair gets the second start's timestamp, not the first's).
   - **Non-reasoning chunks** (text-delta, tool-input-delta, finish, etc.) pass through unchanged.
7. Wire transform into `apps/api/app/api/chat/chat.controller.ts` immediately after `toUIMessageStream(stream)`, before any other transform.
8. Add `apps/ui/app/utils/format-reasoning-duration.ts` + matching `.test.ts` for boundary cases (0, 999, 1000, 1500, 59999, 60000, 60500, 125000 ms) covering both `verb: 'Thought'` and `verb: 'Thinking'` modes.
9. Add `apps/ui/app/utils/use-reasoning-stopwatch.ts` + matching `.test.ts` (using `vi.useFakeTimers()`):
   - Anchors directly on `startedAtMs` (no client-arrival ref, no fallback selection).
   - Returns `Math.max(0, Date.now() - startedAtMs)` on each render.
   - Re-renders every 1000ms while `enabled === true`.
   - Stops ticking when `enabled` flips to `false`.
   - Returns `0` when `startedAtMs === undefined`.
10. Update `apps/ui/app/routes/projects_.$id/chat-message-reasoning.tsx`:
    - Import `getReasoningDurationMs`, `getReasoningStartedAtMs`, `formatReasoningDuration`, `useReasoningStopwatch`.
    - Replace the static `Thought process` label with the dynamic three-state label (live "Thinking for Ns", final "Thought for Ns", legacy "Thought process" fallback).
    - Apply two-tone verb/suffix styling.
    - Verify (in editor IntelliSense, not just at runtime) that the typed `common` namespace is visible on the narrowed `MyMessagePart` — no `as` casts should be needed in the component.
11. Run `pnpm nx lint api ui chat`, `pnpm nx typecheck api ui chat`, `pnpm nx test api ui chat --watch=false`.
12. (Manual) Open a chat with a reasoning model (Claude/GPT-5/Gemini Flash Thinking) and verify:
    - "Thinking for 1s, 2s, 3s…" updates live while reasoning streams.
    - Reasoning text continues to stream into the expanded section while the counter ticks.
    - On block completion, the label flips to "Thought for Ns" using the derived `reasoningEndedAtMs - reasoningStartedAtMs`.
    - Page reload restores "Thought for Ns" from persisted `providerMetadata.common.{reasoningStartedAtMs, reasoningEndedAtMs}`.
