---
title: 'Cross-Provider Thinking Block Portability'
description: 'Root-cause analysis of "Unsupported type thinking" errors when switching model providers mid-conversation, and the architecturally correct fix using LangChain v1 standard content blocks.'
status: active
created: '2026-05-02'
updated: '2026-05-02'
category: investigation
related:
  - docs/policy/cross-provider-content-contract.md
  - docs/research/agent-loop-safeguards.md
  - docs/research/chat-model-cost-forensics.md
  - docs/research/context-summarization-compaction.md
  - docs/policy/interrupted-tool-call-contract.md
---

# Cross-Provider Thinking Block Portability

Root-cause analysis of the user-visible `Unsupported type "thinking" received while converting message to message parts` error and the architecturally correct fix to make persisted reasoning portable across Anthropic, Vertex AI / Gemini, OpenAI, and OpenAI-compatible providers.

## Executive Summary

When a chat thread accumulates Anthropic extended-thinking output (`{type:"thinking", thinking:"…", signature:"…"}` content blocks) and the user then switches the active model to a Gemini / Vertex AI model, the next turn fails inside `@langchain/google-common` with `Unsupported type "thinking" received while converting message to message parts` (gemini.ts L640-L647). The error is fatal — the agent stream dies before the model is invoked, and because the bad block is persisted in the LangGraph PostgreSQL checkpoint, every subsequent turn on a non-Anthropic model in that thread fails the same way.

The smoking gun is that `@langchain/anthropic@1.3.x` emits its native `type:"thinking"` shape into `AIMessage.content` whenever `outputVersion` is not set to `"v1"` (default `"v0"`), and the LangGraph checkpointer faithfully persists that provider-native shape. `@langchain/google-common`'s pre-V1 `messageContentComplexToPart` switch (gemini.ts L611-L652) recognises `text | image_url | media | reasoning | input_audio` and throws on every other type — including the Anthropic-native `"thinking"`.

The architecturally correct fix is **two changes, both upstream-aligned**:

1. **R1 — Pass `outputVersion: "v1"` to every chat model in `ProviderService`.** This makes `BaseChatModel` cast every outgoing `AIMessage` through `convertToV1FromAnthropicMessage` (or each provider's translator) before the message ever reaches the checkpointer, so persisted reasoning is always stored in the standard `{type:"reasoning", reasoning, signature}` shape that all providers' input pipelines understand. (LangChain.js shipped V1 standard content as the canonical interchange in PR #9204 / `langchain` 1.0.) Provider re-emission to native shapes (Anthropic `thinking`, Gemini `thought:true`) happens at request-build time inside each provider's `_formatStandardContent`, gated on `response_metadata.model_provider`.
2. **R2 — Add a `crossProviderContentNormalizer` middleware** that runs before `messageContentSanitizerMiddleware` and rewrites legacy `type:"thinking"` blocks to V1 `type:"reasoning"` blocks (preserving the signature), and drops the signature when the **target** model is not Anthropic. This rescues the existing checkpoint corpus that was written before R1 ships, and serves as a permanent backstop for any provider that still emits provider-native shapes.

Without R1+R2, every Tau chat thread that touched Claude with extended thinking is a one-way door — the user can never switch models on that thread again. With R1+R2, model switching is lossless: thinking traces are normalized to provider-agnostic reasoning blocks, signatures are preserved when (and only when) the next turn goes back to Anthropic.

## Problem Statement

### Symptom

User-visible error rendered in chat history (screenshots attached to the originating session):

```text
Unsupported type "thinking" received while converting message to message parts:
{"index":0,"type":"thinking","thinking":"The user wants me to add an option to display
the assembled enclosure with the top and bottom shells positioned together…",
"signature":"Eo4FCmMlDRgCKkAYfErpEpa3fxrGRWyVYfnTZbr8VXNTntrJplksf7qJwG2AhFc+G…"}
```

The same error is logged on the API side and aborts the LangChain `wrapModelCall` chain before any provider request is issued. The chat composer remains in the streaming state with no recovery path; the user must edit the offending turn or branch a new chat to make further progress.

### Reproduction

1. Open any project chat. Select a Claude model with extended thinking on (e.g. `claude-opus-4.6` with `thinking: { type: "enabled", budget_tokens: ≥1024 }`, which our `ProviderService` does **not** currently configure but which various default model presets in `model.constants.ts` do — see `Model.configuration.thinking`).
2. Send any prompt that elicits a thinking block. Verify in the LangGraph checkpoint that `messages[-1].content` is an array containing `{type:"thinking", thinking:"…", signature:"…"}`.
3. Switch the active model in the chat composer to any non-Anthropic model (Vertex AI Gemini, OpenAI GPT-5, Cerebras, Together AI). Send another prompt.
4. The next request throws inside `messageContentComplexToPart` at the `default` case.

### Why this is a Tau bug, not just an upstream bug

LangChain.js documents the cross-provider portability story explicitly: V1 standard content blocks ([LangChain blog](https://blog.langchain.com/standard-message-content/), [v1 release notes](https://docs.langchain.com/oss/javascript/releases/langchain-v1)) were introduced exactly so that `{type:"thinking"}` and `{type:"reasoning"}` collapse into a single `{type:"reasoning", reasoning, signature?}` standard, and each provider's `_formatStandardContent` re-emits the right native shape at request time. **Tau is not opted into this regime** — `apps/api/app/api/providers/provider.service.ts` constructs every chat model with the default `outputVersion: "v0"`, so we get provider-native shapes in our checkpoints and inherit every cross-provider compatibility hazard the V1 standard was built to eliminate.

## Methodology

1. Grepped `repos/`, `node_modules/.pnpm/`, and `apps/api/` for the literal error string. Located it at `repos/langchainjs/libs/providers/langchain-google-common/src/utils/gemini.ts:640` and the corresponding compiled `dist/utils/gemini.cjs:293` (taucad fork tarball pinned in `package.json` overrides).
2. Traced the call site upward through `messageContentComplexToParts` → `messageContentToParts` → `roleMessageToContent` → `formatMessages` to confirm the full provider-input path for Gemini.
3. Read `repos/langchainjs/libs/providers/langchain-anthropic/src/utils/message_outputs.ts` and `utils/standard.ts` to confirm Anthropic emits `type:"thinking"` natively in v0 and converts `reasoning↔thinking` in v1 via `_formatStandardContent`.
4. Read `repos/langchainjs/libs/langchain-core/src/messages/block_translators/{anthropic,google_genai,google_vertexai}.ts` to inventory the V1 standard translators.
5. Read `repos/langchainjs/libs/langchain-core/src/language_models/chat_models.ts` to confirm `outputVersion` semantics — `castStandardMessageContent` is called on every chunk and every generation result when `outputVersion === "v1"` (lines 362, 558, 717).
6. Surveyed `apps/api/app/api/chat/middleware/` to map the existing pre-model-call sanitization pipeline (`messageContentSanitizerMiddleware`, `latexDelimiterMiddleware`, `newlineTrimmerMiddleware`, `promptCachingMiddleware`).
7. Read external-ecosystem prior art:
   - LangChain.js issue [#9935](https://github.com/langchain-ai/langchainjs/issues/9935) (Gemini emits `thinking` instead of `reasoning` in `contentBlocks`)
   - LangChain.js issue [#9724](https://github.com/langchain-ai/langchainjs/issues/9724) (Gemini `includeThoughts` mixes thinking with text)
   - OpenClaw issues [#37314](https://github.com/openclaw/openclaw/issues/37314) (drop thinking blocks for non-Anthropic providers), [#29618](https://github.com/openclaw/openclaw/issues/29618) (preserve thinking blocks for Anthropic), [#24804](https://github.com/openclaw/openclaw/issues/24804) (downgrade unsigned thinking to text), [#23350](https://github.com/openclaw/openclaw/issues/23350) (Vertex Cloud Code Assist drops signatures)
   - Vercel AI SDK [reasoning capability docs](https://vercel.com/docs/ai-gateway/capabilities/reasoning) (single `reasoning-delta` part shape across all providers; provider-options forwarded natively).

## Root Cause

### The data flow

```text
                                       ┌── outputVersion="v0" (DEFAULT)
                                       │   AIMessage.content kept in
                                       │   provider-native shape
Anthropic API                          ▼
   thinking_delta ── ChatAnthropic ──► AIMessage{ content: [
                                          { type:"thinking", thinking, signature }
                                        ] }
                                          │
                                          │   PostgresSaver.put()
                                          ▼
                                       LangGraph checkpoint (Postgres
                                       langgraph schema, JSONB)
                                          │
       Next turn — user switched to Gemini
                                          │   PostgresSaver.get()
                                          ▼
                                       AIMessage rehydrated as-is
                                          │
   ChatVertexAI.invoke() ─► gemini.ts messageContentComplexToPart(block)
                                          │
                                          ▼
                                switch (block.type) {
                                  case "text":          ✓
                                  case "image_url":     ✓
                                  case "media":         ✓
                                  case "reasoning":     ✓  ← V1 standard
                                  case "input_audio":   ✓
                                  default: throw new Error(
                                    `Unsupported type "thinking"…`
                                  );
                                }
```

The structural hazard is that **every step on the storage path is provider-faithful** — Anthropic emits its native shape, Postgres stores its native shape, the rehydrator returns its native shape. Only at the new provider's input boundary does the type system reject the foreign shape. There is no normalization layer between persistence and re-dispatch.

### Why the error is so loud

The Gemini converter's default branch throws synchronously before the prompt is even sent — it can't fall back to a stringified representation because thinking has no canonical text form. Even more importantly, **the throw happens inside `Promise.all(content.map(messageContentComplexToPart))`**, so a single bad block in any historical assistant message kills the entire request. There is no per-block error containment.

### Why we don't see this on every thread

Three protective conditions hide this from most threads:

1. **Most Tau model presets don't enable Anthropic extended thinking.** `provider.service.ts:81-92` constructs `ChatAnthropic` with the betas `interleaved-thinking-2025-05-14`, `extended-cache-ttl-2025-04-11`, `prompt-caching-scope-2026-01-05` but **does not pass a `thinking` parameter** — only model presets in `model.constants.ts` that explicitly set `configuration.thinking: { type: "enabled" | "adaptive" }` cause thinking blocks to be emitted.
2. **Most users don't switch providers mid-thread.** A thread that stays on Claude round-trips its own thinking blocks happily; a thread that stays on Gemini never produces them.
3. **`messageContentSanitizerMiddleware` accidentally hides one related error class.** When an AI message contains _only_ a reasoning/thinking block (interrupted thinking, no text), the middleware appends a synthetic `{type:"text", text:"[interrupted]"}` block (message-content-sanitizer.middleware.ts:74-87), which keeps the message non-empty for Anthropic. But the middleware does **not** rewrite block `type` values, so it does nothing for the cross-provider case.

The bug therefore manifests precisely at the intersection of "user has access to a thinking-enabled Claude preset" + "user does the natural model-comparison workflow of switching to Gemini/GPT mid-thread to compare answers". This is exactly the workflow the Tau chat composer's model selector encourages.

## Findings

### Finding 1: V1 standard content is the upstream's canonical answer

LangChain.js shipped `langchain` 1.0 around its `chore!!!: replace main with v1 (#9204)` on the release branch. The headline feature is a unified `ContentBlock.Standard` schema (`libs/langchain-core/src/messages/content/index.ts`) and per-provider translator pairs in `libs/langchain-core/src/messages/block_translators/`:

| Provider                                      | Translator                                                | Output behaviour                                                                                           |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Anthropic                                     | `convertToV1FromAnthropicMessage` (`anthropic.ts`)        | `thinking → reasoning` (preserves `signature`); `redacted_thinking → non_standard`; `tool_use → tool_call` |
| Google GenAI                                  | `convertToV1FromChatGoogleMessage` (`google_genai.ts`)    | `thinking → reasoning` (preserves `signature`)                                                             |
| Vertex AI                                     | `convertToV1FromChatVertexMessage` (`google_vertexai.ts`) | both `reasoning` and `thinking` accepted; both yield V1 `reasoning`                                        |
| OpenAI                                        | `convertToV1FromOpenAIMessage`                            | `reasoning_summary → reasoning`                                                                            |
| Bedrock Converse, xAI, Ollama, DeepSeek, Groq | dedicated translators                                     | all converge on `{type:"reasoning", …}`                                                                    |

`BaseChatModel.outputVersion === "v1"` triggers `castStandardMessageContent(message)` on every generation result and every streamed chunk (`chat_models.ts:362, 558, 717`). When set, the `AIMessage` that flows downstream — to the agent loop, to the checkpointer, to UI hydration — already carries V1 standard blocks.

The reverse direction (V1 → provider-native) is owned by each provider's input formatter, which **gates on `response_metadata.model_provider`** so it only re-emits a thinking block when sending back to the same provider that produced it:

```ts
// langchain-anthropic/src/utils/standard.ts:128-133
} else if (block.type === "reasoning" && isAnthropicMessage) {
  result.push({
    type: "thinking",
    thinking: block.reasoning,
    signature: String(block.signature),
  });
}
```

Crucially, when `isAnthropicMessage` is `false`, the reasoning block is **silently dropped** from the Anthropic input — Anthropic refuses to accept thinking blocks signed by a different provider anyway, so dropping is the only correct behaviour. The same gating logic appears in every provider's standard formatter.

This is the architecturally complete answer: persist V1 standard, re-emit native at request boundaries, gate re-emission on provider identity.

### Finding 2: Tau ships the prerequisites but isn't using them

Inventory of what Tau already has:

| Capability                                                                                          | Location                                                  | Currently used?                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `@langchain/core` 1.x with V1 translators                                                           | `node_modules/.pnpm/@langchain+core@1.1.37`               | yes (transitively)                                                  |
| `@langchain/anthropic` 1.3.26 (`_formatStandardContent` ready)                                      | provider service                                          | yes, but `outputVersion` not set                                    |
| `@langchain/google-common` 2.1.32 (taucad fork) — has `standardContentBlockConverter` for V1 inputs | overrides in `package.json:366`                           | yes, but only triggered when blocks pass `isDataContentBlock` check |
| Custom V1 translator for `reasoning` content in Vertex's gemini.ts                                  | upstream (line 628)                                       | partially — only fires when content is already V1-shaped            |
| `messageContentSanitizerMiddleware` (handles interrupted-thinking placeholder)                      | `apps/api/app/api/chat/middleware/`                       | yes                                                                 |
| `transformAiMessageContent` utility (already iterates `text` + `reasoning` blocks)                  | `apps/api/app/api/chat/utils/`                            | yes (latex / newline transforms)                                    |
| `response_metadata.model_provider` set per-provider on AIMessages                                   | upstream (e.g. `message_outputs.ts:25`, `gemini.cjs:674`) | yes                                                                 |

The missing piece is a single configuration switch (`outputVersion: "v1"`) and a one-pass normalizer for legacy persisted blocks. We are **one config flag away** from the upstream's intended behaviour.

### Finding 3: The fork pin lags behind the V1 fix for Gemini

Tau's `@langchain/google-common` pin (`taucad/langchainjs@0f065cb8c363ff95a2fdddfbe28bbac1970068cd`) is on `feat/gemini-streaming-reasoning-parallel-tools` — a working branch focused on streaming reasoning + parallel tool calls — and predates upstream PRs that further harmonize `thinking → reasoning` translation in the Google providers. Notably:

- LangChain.js issue [#9935](https://github.com/langchain-ai/langchainjs/issues/9935) (`ChatGoogleGenerativeAI contentBlocks contains "thinking" and not "reasoning"`) is still open as of the snapshot we hold and reports that even when Gemini _outputs_ a thought, `message.contentBlocks` may surface it as `thinking` rather than `reasoning`. This means simply enabling `outputVersion: "v1"` on the Vertex provider will not fully harmonize Gemini's output shape until upstream lands a fix or we patch our fork.
- Issue [#9724](https://github.com/langchain-ai/langchainjs/issues/9724) reports a related defect — Gemini thinking parts being merged into a single `text` block. The community has shipped pnpm patches; one (referenced in the linked issue) adds the missing `else if (content.type === "reasoning")` branch to `_convertLangChainContentToPart` and the inverse `if (p.thought === true)` branch to `convertResponseContentToChatGenerationChunk`.

The implication for Tau: enabling `outputVersion: "v1"` on Anthropic immediately fixes the cross-provider hazard for _Anthropic-originated_ thinking blocks (which is the documented user-visible bug). Enabling it on Vertex AI is the right _direction_ but requires our fork to merge the open-PR `thinking → reasoning` fix, or to ship a similar patch, before we can rely on `message.contentBlocks` for Gemini-originated thinking. R1 must therefore be staged: Anthropic first, then Vertex once the fork catches up.

### Finding 4: Anthropic signature semantics constrain the signature handling

Anthropic's API contract (documented across multiple OpenClaw incident reports) imposes three rules on persisted thinking blocks that any normalization layer must respect:

1. **Identity preservation in the latest assistant message.** When replaying conversation history to Anthropic, every `thinking` and `redacted_thinking` block in the **most recent assistant message** must be byte-identical to what Anthropic returned, including `signature`. Modifying the block (even spreading-and-deleting a property) yields `messages.N.content.M: thinking … blocks in the latest assistant message cannot be modified.`
2. **Signature required when present.** A `thinking` block sent without a `signature` is rejected with `messages.N.content.0.thinking.signature: Field required`. Some upstream paths (OpenClaw issue #23350: Cloud Code Assist via Vertex AI) drop signatures, producing a permanent 400-loop until session reset.
3. **Signatures are non-portable across providers.** A signature returned by Anthropic-direct does not validate when re-submitted via Vertex AI (different signing key), and vice versa. Sending Anthropic-signed thinking to Gemini is a schema error (the field is unknown), not a signature error — Gemini would reject the block even with no signature.

The upshot is that the right normalization rule is **provider-symmetric, asymmetric on signature**:

| Source provider          | Target provider        | Block shape sent                                                         | Signature                          |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Anthropic                | Anthropic (latest msg) | `{type:"thinking", thinking, signature}`                                 | preserved verbatim                 |
| Anthropic                | Anthropic (prior msgs) | `{type:"thinking", thinking, signature}`                                 | preserved verbatim (also required) |
| Anthropic                | Vertex AI / Gemini     | dropped (or `{type:"text", text:thinking}` if we want to preserve trace) | n/a                                |
| Anthropic                | OpenAI                 | dropped                                                                  | n/a                                |
| Vertex AI Gemini         | Anthropic              | dropped (signature non-portable)                                         | n/a                                |
| Vertex AI Gemini         | Vertex AI Gemini       | `{thought:true, text, thoughtSignature?}`                                | preserved if present               |
| OpenAI reasoning summary | OpenAI                 | `{type:"reasoning", summary, id}`                                        | n/a (reasoning ID only)            |

The "drop on cross-provider hop" rule is what LangChain's `_formatStandardContent` already implements via the `isAnthropicMessage` gate — provided the message is in V1 form. R1 unlocks that for free; R2 generalises it for legacy v0-shaped persisted blocks.

### Finding 5: The error handling is doubly non-graceful

Two compounding gaps in our error path turn a content-shape mismatch into an unrecoverable thread:

1. **The agent stream surfaces the raw provider error.** `apps/api/app/api/chat/utils/error-normalizer.ts` and `error-transform.ts` translate API errors into UI-readable shapes, but the gemini.ts `Error("Unsupported type …")` is thrown **before** the model call — inside LangChain core's message-formatting helpers — so it bypasses our usual provider-error normalization and lands in the chat as the raw `Error.message`, including the full base64 signature payload (the screenshots show 1.5KB of opaque base64 spilled into the chat UI). This is a UX cliff: it leaks an internal value through the user surface and offers no remediation hint.
2. **The checkpoint is not auto-repaired.** Once the bad turn is persisted, every subsequent turn re-reads the same poisoned message and dies the same way. Our `messageContentSanitizerMiddleware` is the natural place to repair it but currently only adds placeholder text — it never rewrites block `type` values. A user has no in-product recovery path other than starting a new chat, which loses context.

R2 closes both gaps by normalizing on every read regardless of how the persisted shape got there.

### Finding 6: Existing similar errors share the same root

Two adjacent failure modes have the same shape and are fixed for free by R1+R2:

- **Anthropic `redacted_thinking` blocks** (returned when Anthropic determines a thinking trace is sensitive). These also throw at gemini.ts L640 with `Unsupported type "redacted_thinking"`. The V1 anthropic translator emits `{type:"non_standard", value:block}` for them, and provider input formatters drop or pass-through `non_standard` blocks. R1 handles this; we should explicitly test it in R2.
- **`compaction` blocks** from Anthropic's prompt-cache compaction beta (`extended-cache-ttl-2025-04-11`), which we have enabled (`provider.service.ts:88`). The V1 anthropic translator routes `compaction → non_standard`. Same fix.
- **Server-tool blocks** (`server_tool_use`, `web_search_tool_result`, `code_execution_tool_result`) when Anthropic's `web_search_20250305` server tool runs, then the user switches to Gemini. The V1 translator emits `{type:"server_tool_call"|"server_tool_call_result"}` — recognized cross-provider when paired with V1 inputs.

Without R1, every one of these is a future production incident waiting to happen. With R1, they all funnel through the same normalization path.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Priority | Effort                                                                                            | Impact                                                                                                     | Risk                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Pass `outputVersion: "v1"` to every chat model in `provider.service.ts` (Anthropic first; Vertex AI after the fork lands the upstream `thinking → reasoning` fix; OpenAI/Cerebras/Together opt-in once their translators are tested).                                                                                                                                                                                                                                                         | **P0**   | Low (1 line per provider + integration tests)                                                     | High — eliminates the originating bug class for _new_ messages                                             | Medium — `outputVersion: "v1"` changes the persisted shape; existing `messageContentSanitizerMiddleware`, `transformAiMessageContent`, `compaction.middleware`, and `transcript.middleware` all read block shapes and need a quick audit pass. |
| R2  | Add `crossProviderContentNormalizerMiddleware` running before `messageContentSanitizerMiddleware`. It rewrites `{type:"thinking", thinking, signature}` → `{type:"reasoning", reasoning:thinking, signature}`, drops `signature` when target provider != source provider (read `response_metadata.model_provider` of the source `AIMessage`, compare against the active model's provider), and converts `{type:"redacted_thinking" \| "compaction"}` to `{type:"non_standard", value:block}`. | **P0**   | Low–Medium (one new middleware + tests)                                                           | High — rescues the existing checkpoint corpus and serves as a permanent backstop.                          | Low — middleware operates on a copy; failure mode is at-worst preserving the legacy shape.                                                                                                                                                     |
| R3  | Wrap the gemini.ts `messageContentComplexToPart` in a typed error in our taucad fork — replace the raw `Error` with a `CrossProviderContentError` whose `.message` does **not** include the full block payload, and surface a hint: "this assistant message contained provider-native content that could not be re-emitted to <provider>; try the same model that produced it, or branch a new chat". Push upstream to langchainjs as a quality-of-life fix.                                  | **P1**   | Low (fork patch + upstream PR)                                                                    | Medium — improves UX for any thread that hits a future cross-provider mismatch before R2 ships everywhere. | Low.                                                                                                                                                                                                                                           |
| R4  | Bump our `@langchain/google-common` fork pin once upstream merges the [#9935](https://github.com/langchain-ai/langchainjs/issues/9935) and [#9724](https://github.com/langchain-ai/langchainjs/issues/9724) fixes (Gemini `thought:true` ↔ `reasoning` symmetry), then enable `outputVersion: "v1"` on `ChatVertexAI`. Track upstream via the `repos` skill workflow.                                                                                                                         | **P2**   | Medium (fork sync + integration tests + dts validation)                                           | Medium — completes V1 coverage for Gemini-originated thinking.                                             | Low.                                                                                                                                                                                                                                           |
| R5  | Add an integration test that simulates the cross-provider hop end-to-end against real provider sandboxes: send a thinking-enabled Claude prompt, capture the persisted message shape, switch to Gemini, send another prompt, assert the request succeeds and the persisted history remains queryable. Add the same coverage for Anthropic→OpenAI and Vertex→Anthropic. Mirror the structure of `apps/api/app/api/chat/interrupted-tool-roundtrip.test.ts`.                                    | **P1**   | Medium (real-provider test infra exists; follow `interrupted-tool-providers.integration.test.ts`) | High — guards regression of any future block shape (server_tool_use, container_upload, multimodal).        | Low (gated on test env credentials).                                                                                                                                                                                                           |
| R6  | Document the contract in `docs/policy/cross-provider-content-contract.md` (analogous to `interrupted-tool-call-contract.md`): "All persisted assistant content lives in V1 standard form; provider-native blocks are an API-edge concern, not a persistence concern; the normalizer middleware is the single repair point."                                                                                                                                                                   | **P2**   | Low                                                                                               | Medium — anchors the architectural rule so future provider integrations don't reintroduce the bug.         | Low.                                                                                                                                                                                                                                           |
| R7  | Add a UI affordance: when the user changes the model picker on a thread that contains thinking blocks from a different provider, surface a one-line tooltip ("switching providers will discard the previous reasoning trace; this is normal"). Keep this **after** R2 ships so the discard is silent and lossless under the hood.                                                                                                                                                             | **P3**   | Low                                                                                               | Low                                                                                                        | Low.                                                                                                                                                                                                                                           |

### Implementation status

**Resolved in Tau (`2026-05-02`)**: V1 `outputVersion` on Anthropic, Vertex AI, OpenAI, and Together in `provider.service.ts`; `createCrossProviderContentNormalizerMiddleware` wired before `messageContentSanitizerMiddleware`; packed fork tarballs under `tarballs/langchain-fork/` with `CrossProviderContentError`, Gemini `thinking` input handling, and `@langchain/google-gauth` pinned via `pnpm.overrides`; policy `docs/policy/cross-provider-content-contract.md`; optional real-LLM coverage in `apps/api/app/testing/cross-provider-thinking.integration.test.ts` (`describe.skip` in CI); composer hover-card hint via `ChatModelSelector`. Source edits remain in the workspace `repos/langchainjs` checkout for maintainers to commit/push to `taucad/langchainjs`. Cerebras and Ollama intentionally remain on default v0 outputs until translator readiness is validated.

### Recommended sequencing

1. R2 first (minutes to ship; rescues every existing thread immediately).
2. R1 for Anthropic (single line; gated behind R2 so even if a stale block slips through, normalization catches it).
3. R3 (fork patch; opportunistic).
4. R5 (lock the contract before R1 expands).
5. R1 for Vertex AI after R4.
6. R6 documents the final state.
7. R7 polish.

### What we deliberately do NOT recommend

- **Do not** strip thinking blocks unconditionally on the storage path. The signature is required when the next turn goes back to the same Anthropic provider (Findings 4 + #24804); blanket-stripping breaks single-provider Anthropic workflows.
- **Do not** add provider-specific branching inside the chat agent or the UI. Provider-shape normalization is a transport-layer concern; surfacing it to UI/agent code violates `library-api-policy` (no model/provider-specific branching in middleware).
- **Do not** convert legacy thinking blocks to `text` blocks (the OpenClaw pi-ai approach in #24804). It pollutes the visible chat history with the assistant's private reasoning, defeating the whole point of separating reasoning from text. Use the standard `non_standard` envelope instead.
- **Do not** wait for upstream to fix gemini.ts. The V1 standard already exists; the fix is configuration on our side. Upstream PR coverage for the legacy v0 path is unlikely to land — the recommended migration is V1.
- **Do not** disable extended thinking on Anthropic to side-step this. Extended thinking is a user-visible product feature and one of the better-quality reasoning traces available; the right answer is normalization, not disablement.

## Trade-offs

### V1 standard vs custom Tau normalizer

| Dimension                             | `outputVersion: "v1"` (R1)                          | Tau-only normalizer (R2)                                       | Both (recommended)                                           |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Coverage of new messages              | Full (every block type LangChain knows)             | Limited to the block types we explicitly handle                | Full                                                         |
| Coverage of legacy persisted messages | None (already stored in v0)                         | Full                                                           | Full                                                         |
| Upstream alignment                    | Maximal — uses the canonical interchange            | Local — divergent from upstream's intended path                | Maximal where possible, local backstop where needed          |
| Maintenance burden                    | Low — upstream owns translator quality              | Medium — every new provider/block type needs a Tau-side update | Bounded — R1 takes the load, R2 is a thin compatibility shim |
| Risk of provider-edge regressions     | Medium — V1 changes the shape every middleware sees | Low — middleware reads the same shape it always did            | Medium for 1 release cycle, then Low                         |

### Drop vs preserve cross-provider thinking

Whether to drop the reasoning trace entirely or downgrade it to a visible `text` block on a cross-provider hop:

| Option                                          | Pros                                                                                        | Cons                                                                                                         | Verdict                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop (mirror upstream `_formatStandardContent`) | Schema-correct; provider-portable; no UX surprise                                           | Loses the reasoning trace context for the next turn                                                          | **Adopt.** The next-turn model reasons fresh; preserving Claude's reasoning to feed into Gemini is rarely the right behaviour and frequently makes Gemini parrot Claude's voice. |
| Downgrade to text                               | Preserves trace context                                                                     | Pollutes visible chat history; the reasoning was meant to be private model state, not a user-visible message | Reject. The original V1 design intentionally separates `reasoning` from `text` for exactly this reason.                                                                          |
| Convert to `non_standard` envelope              | Preserves trace data without rendering it; some provider input formatters can re-extract it | Almost no provider formatter actually re-extracts                                                            | Adopt only for `redacted_thinking` and `compaction` (where we have no other option).                                                                                             |

## Code Examples

### R1 — enable V1 outputs on Anthropic

```ts
// apps/api/app/api/providers/provider.service.ts (excerpt)
anthropic: {
  // …
  createClass: (options) =>
    new ChatAnthropic({
      ...options,
      outputVersion: 'v1',
      betas: [
        // existing betas…
      ],
    }),
},
```

After this change, every `AIMessage` produced by `ChatAnthropic` carries V1 standard blocks at the moment it lands in the agent loop and the checkpointer:

```jsonc
// Before (v0):
{ "type": "thinking", "thinking": "…", "signature": "Eo4FCm…" }

// After (v1):
{ "type": "reasoning", "reasoning": "…", "signature": "Eo4FCm…" }
```

When the next turn goes back to Anthropic, `_formatStandardContent` (anthropic/utils/standard.ts:128-133) re-emits the native shape with the signature intact. When the next turn goes to Gemini/OpenAI, the V1 `reasoning` block hits gemini.ts L628 / openai's reasoning handler and is accepted natively — no error.

### R2 — cross-provider content normalizer middleware

```ts
// apps/api/app/api/chat/middleware/cross-provider-content-normalizer.middleware.ts
import { createMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage, ContentBlock } from '@langchain/core/messages';
import type { ProviderId } from '#api/providers/provider.schema.js';

type RawBlock = ContentBlock & { type?: string; thinking?: string; signature?: string };

/**
 * Normalizes provider-native content blocks (Anthropic `thinking`,
 * `redacted_thinking`, `compaction`) to LangChain V1 standard shapes
 * before the message reaches the active provider's input formatter.
 *
 * Idempotent: V1-shaped blocks pass through unchanged.
 *
 * Drops Anthropic signatures when the target provider is not Anthropic —
 * signatures are non-portable and unrecognized by other providers' schemas.
 */
export const createCrossProviderContentNormalizerMiddleware = (targetProvider: ProviderId) =>
  createMiddleware({
    name: 'CrossProviderContentNormalizer',
    async wrapModelCall(request, handler) {
      const targetIsAnthropic = targetProvider === 'anthropic';

      const normalized = request.messages.map((message: BaseMessage) => {
        if (!AIMessage.isInstance(message) || !Array.isArray(message.content)) {
          return message;
        }

        let modified = false;
        const blocks = (message.content as RawBlock[]).map((block) => {
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            modified = true;
            const { thinking, signature, ...rest } = block;
            return {
              ...rest,
              type: 'reasoning' as const,
              reasoning: thinking,
              ...(targetIsAnthropic && signature ? { signature } : {}),
            };
          }
          if (block.type === 'redacted_thinking' || block.type === 'compaction') {
            modified = true;
            return { type: 'non_standard' as const, value: block };
          }
          return block;
        });

        if (!modified) return message;

        return new AIMessage({
          content: blocks as AIMessage['content'],
          id: message.id,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API
          tool_calls: message.tool_calls,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API
          additional_kwargs: message.additional_kwargs,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API
          response_metadata: message.response_metadata,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API
          usage_metadata: message.usage_metadata,
        });
      });

      return handler({ ...request, messages: normalized });
    },
  });
```

Wire it into the middleware stack **before** `messageContentSanitizerMiddleware` (which assumes V1 shapes when adding placeholders):

```ts
// chat.service.ts (excerpt)
const targetProviderId = this.modelService.getProviderId(modelId);
// …
middleware: [
  // …existing safeguards…
  createCrossProviderContentNormalizerMiddleware(targetProviderId),
  messageContentSanitizerMiddleware,
  newlineTrimmerMiddleware,
  // …
],
```

### R5 — integration test sketch

```ts
// apps/api/app/api/chat/cross-provider-thinking.integration.test.ts
it('round-trips Claude thinking through Gemini without crashing', async () => {
  const session = await chatService.createAgent({ chatId, modelId: 'claude-opus-4.6' /* … */ });
  await invokeWithThinking(session, 'Plan a 3-step build');
  // Persisted state now contains a `thinking` (or v1 `reasoning`) block.

  const switched = await chatService.createAgent({ chatId, modelId: 'gemini-3-pro-preview' /* … */ });
  await expect(invoke(switched, 'Continue with step 1')).resolves.not.toThrow();
});
```

## Diagrams

```text
┌──────────────────────────── Today (v0) ────────────────────────────┐
│                                                                    │
│  Claude API ──► ChatAnthropic ──► AIMessage{ content:[thinking] }  │
│                                              │                     │
│                                              ▼                     │
│                                  PostgresSaver (langgraph schema)  │
│                                              │                     │
│             switch model: Claude → Gemini    │                     │
│                                              ▼                     │
│                                  AIMessage{ content:[thinking] }   │
│                                              │                     │
│                                              ▼                     │
│   ChatVertexAI ── messageContentComplexToPart() ── THROWS ❌       │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

┌────────── Target (R1 only — for new threads) ───────────────────────┐
│                                                                     │
│  Claude API ─► ChatAnthropic{outputVersion:"v1"}                    │
│                          │                                          │
│                          ▼                                          │
│        AIMessage{ content:[reasoning], response_metadata:{          │
│           model_provider:"anthropic" } }                            │
│                          │                                          │
│                          ▼                                          │
│        PostgresSaver  ◄── stores V1 standard                        │
│                          │                                          │
│  switch model: Claude → Gemini                                      │
│                          ▼                                          │
│  ChatVertexAI ─► gemini.ts case "reasoning": ✅ (line 628)          │
│                                                                     │
│  switch model: Claude → Claude                                      │
│  ChatAnthropic ─► _formatStandardContent (gates on                  │
│                   model_provider==="anthropic"): re-emits           │
│                   thinking + signature ✅                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌────── Target (R1 + R2 — covers legacy persisted threads) ────────────┐
│                                                                      │
│  PostgresSaver  ── may contain v0 {thinking,…}                       │
│       │                                                              │
│       ▼                                                              │
│  crossProviderContentNormalizerMiddleware                            │
│       │  rewrite thinking → reasoning                                │
│       │  drop signature when target ≠ anthropic                      │
│       │  redacted_thinking | compaction → non_standard               │
│       ▼                                                              │
│  messageContentSanitizerMiddleware (existing)                        │
│       ▼                                                              │
│  Active provider's input formatter (V1-aware) ✅                     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## References

- [LangChain.js — Standard message content (blog)](https://blog.langchain.com/standard-message-content/)
- [LangChain v1 — JS release notes (`contentBlocks`)](https://docs.langchain.com/oss/javascript/releases/langchain-v1)
- [RFC(v1): standard outputs + new message types — PR #8619](https://github.com/langchain-ai/langchainjs/pull/8619)
- [chore!!!: replace main with v1 — PR #9204](https://github.com/langchain-ai/langchainjs/pull/9204) (the V1 cutover)
- [langchainjs issue #9935 — `ChatGoogleGenerativeAI contentBlocks contains "thinking" and not "reasoning"`](https://github.com/langchain-ai/langchainjs/issues/9935)
- [langchainjs issue #9724 — `includeThoughts: true returns thinking and response mixed together`](https://github.com/langchain-ai/langchainjs/issues/9724)
- [Vercel AI SDK — Reasoning across providers](https://vercel.com/docs/ai-gateway/capabilities/reasoning)
- [Vercel AI SDK — Provider Options reference](https://sdk.vercel.ai/docs/foundations/provider-options)
- OpenClaw incident corpus (cross-provider thinking handling): issues [#37314](https://github.com/openclaw/openclaw/issues/37314), [#29618](https://github.com/openclaw/openclaw/issues/29618), [#24804](https://github.com/openclaw/openclaw/issues/24804), [#23350](https://github.com/openclaw/openclaw/issues/23350), [#8664](https://github.com/openclaw/openclaw/issues/8664).
- Source: `repos/langchainjs/libs/langchain-core/src/messages/block_translators/anthropic.ts`, `google_genai.ts`, `google_vertexai.ts`, `repos/langchainjs/libs/providers/langchain-anthropic/src/utils/standard.ts`, `repos/langchainjs/libs/providers/langchain-google-common/src/utils/gemini.ts`.
- Related: `docs/research/agent-loop-safeguards.md`, `docs/research/chat-model-cost-forensics.md`, `docs/policy/interrupted-tool-call-contract.md`.

## Appendix

### A. Inventory of provider-native block types observed in Tau persistence

| Producer                    | Native block type                                              | V1 mapping (LangChain core translators)        | Action under R1+R2                 |
| --------------------------- | -------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| ChatAnthropic               | `thinking`                                                     | `reasoning` (signature preserved)              | rewritten to `reasoning`           |
| ChatAnthropic               | `redacted_thinking`                                            | `non_standard`                                 | wrapped in `non_standard`          |
| ChatAnthropic               | `compaction` (extended-cache-ttl beta)                         | `non_standard`                                 | wrapped in `non_standard`          |
| ChatAnthropic               | `server_tool_use` (web_search)                                 | `server_tool_call`                             | rewritten by R1                    |
| ChatAnthropic               | `web_search_tool_result`                                       | `server_tool_call_result`                      | rewritten by R1                    |
| ChatAnthropic               | `code_execution_tool_result`                                   | `server_tool_call_result`                      | rewritten by R1                    |
| ChatAnthropic               | `mcp_tool_use` / `mcp_tool_result`                             | `server_tool_call` / `server_tool_call_result` | rewritten by R1                    |
| ChatVertexAI / GoogleGenAI  | `thinking` (Anthropic-style; emitted by some Gemini SDK paths) | `reasoning` (signature preserved)              | rewritten by R2 if target ≠ source |
| ChatVertexAI / GoogleGenAI  | `media`, `inlineData`, `fileData`                              | `image` / `file`                               | passes through                     |
| ChatOpenAI (Responses API)  | `reasoning_summary`                                            | `reasoning`                                    | passes through                     |
| ChatCerebras / ChatTogether | OpenAI-style                                                   | OpenAI translator                              | passes through                     |

### B. File pointers

- Erroring switch: `repos/langchainjs/libs/providers/langchain-google-common/src/utils/gemini.ts:611-652`
- V1 anthropic translator: `repos/langchainjs/libs/langchain-core/src/messages/block_translators/anthropic.ts:288-521`
- V1 vertex translator: `repos/langchainjs/libs/langchain-core/src/messages/block_translators/google_vertexai.ts`
- V1 google_genai translator: `repos/langchainjs/libs/langchain-core/src/messages/block_translators/google_genai.ts`
- Anthropic input formatter (V1-aware): `repos/langchainjs/libs/providers/langchain-anthropic/src/utils/standard.ts:95-278`
- BaseChatModel `outputVersion` plumbing: `repos/langchainjs/libs/langchain-core/src/language_models/chat_models.ts:223-237, 333-365, 469-565, 700-720`
- Tau provider construction: `apps/api/app/api/providers/provider.service.ts:60-141`
- Tau existing sanitization middleware: `apps/api/app/api/chat/middleware/message-content-sanitizer.middleware.ts`
- Tau LangGraph checkpointer: `apps/api/app/api/chat/checkpointer.service.ts`
- Tau fork pin: `package.json:365-367` (overrides for `@langchain/google-common` and `@langchain/google-vertexai`)
