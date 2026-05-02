---
title: 'Cross-Provider Content Contract Policy'
description: 'Persistence and API rules for LangChain V1 standard assistant content blocks across model providers'
status: active
created: '2026-05-02'
updated: '2026-05-02'
related:
  - docs/policy/interrupted-tool-call-contract.md
  - docs/research/cross-provider-thinking-block-portability.md
  - docs/policy/testing-policy.md
---

# Cross-Provider Content Contract Policy

Prescriptive rules for how the Tau API represents assistant reasoning and other structured content when users switch between LLM providers mid-thread.

## Rationale

Provider-native content blocks (for example Anthropic extended-thinking `thinking`, `redacted_thinking`, and cache-control `compaction` payloads) are valid only at that provider's HTTP boundary. LangGraph checkpoints serialize whatever shape the active `BaseChatModel` emitted. Without a single interchange format, replaying history to another provider causes hard failures (for example Google Gemini rejecting `type: "thinking"` during message formatting).

LangChain 1.x defines **V1 standard content blocks** (`{ type: "reasoning", reasoning, signature? }`, tool-call blocks, multimodal blocks). With `outputVersion: "v1"`, models persist portable reasoning; each provider's formatter re-emits native shapes only when appropriate.

This policy binds the API to that regime and names the one middleware repair surface for legacy checkpoints.

## Rules

### 1. Prefer V1 standard outputs on every supported chat model

All chat model classes constructed in `apps/api/app/api/providers/provider.service.ts` MUST set `outputVersion: "v1"` once the provider's LangChain integration supports the V1 translator for that stack.

**Why**: New turns land in Postgres checkpoints in a shape every other provider adapter understands.

### 2. `createCrossProviderContentNormalizerMiddleware` is the sole legacy repair site

Inbound `wrapModelCall` MUST normalize persisted foreign shapes before provider formatting:

- Anthropic-native `thinking` → V1 `reasoning` (preserve `signature` only when the **target** provider is Anthropic).
- `redacted_thinking` and Anthropic `compaction` blocks → `{ type: "non_standard", value: <original> }`.
- Strip non-portable `signature` / `thoughtSignature` fields from `reasoning` blocks when the target provider is not Anthropic.

**Why**: Checkpoints written before Rule 1 shipped, or emitted by providers still on v0 shapes, must not wedge a thread. Centralizing repair avoids scattering provider switches across UI or tools.

### 3. No provider-shape branching in UI or agent tools

Clients render AI SDK / `MyUIMessage` parts only. They MUST NOT attempt to rewrite LangChain provider-native blocks or heal cross-provider errors.

**Why**: Correctness is owned by the API pipeline (normalizer + sanitizers + LangChain formatters). Duplicating logic in the UI guarantees drift.

### 4. Signatures stay provider-symmetric

Thinking signatures are opaque to other providers. The normalizer preserves them **only** when the active target model is Anthropic; otherwise they are omitted from `reasoning` blocks.

**Why**: Matches upstream `_formatStandardContent` gating and avoids leaking unusable cryptographic material across vendors.

### 5. Reasoning traces are dropped on cross-provider hops, not text-downgraded

When switching away from a provider that produced reasoning, downstream requests MUST NOT synthesize fake user-visible prose from reasoning payloads. Portable `reasoning` blocks may be ignored or mapped to provider-specific thought channels by the active formatter.

**Why**: Prevents accidental disclosure patterns and keeps telemetry/tool semantics honest.

## Scope

**In scope**: `apps/api` chat agent construction, LangChain middleware ordering, provider configuration.

**Out of scope**: UI persistence of `MyUIMessage` parts (already normalized by API responses), offline checkpoint migrations (normalizer handles reads), upstream LangChain releases.

## Verification

- Unit: `apps/api/app/api/chat/middleware/cross-provider-content-normalizer.middleware.test.ts`
- Optional real-LLM: `apps/api/app/testing/cross-provider-thinking.integration.test.ts` (`describe.skip` in CI)

## References

- Investigation: `docs/research/cross-provider-thinking-block-portability.md`
- LangChain V1 standard content overview: [LangChain standard message content](https://blog.langchain.com/standard-message-content/)
- Related persistence contract: `docs/policy/interrupted-tool-call-contract.md`
