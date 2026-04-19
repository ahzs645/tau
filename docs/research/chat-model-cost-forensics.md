---
title: 'Chat Model Cost Forensics'
description: 'Forensic analysis of expensive model turns in Tau AI chat, identifying cache invalidation, thinking bloat, and context waste'
status: draft
created: '2026-04-04'
updated: '2026-04-05'
category: investigation
related:
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
---

# Chat Model Cost Forensics

Forensic analysis of $0.25–$0.45 model turns observed in a Claude Opus 4.6 pagoda design session, identifying root causes of excessive token costs and recommending architectural fixes.

## Executive Summary

A 3-message CAD design conversation cost $3.08 ($1.44 + $1.64) with several individual model turns reaching $0.25–$0.45 — 10× the typical per-turn cost. The root cause is a cache invalidation bug in the `toolResultTrimmerMiddleware`: every time a new screenshot is taken, old screenshot content is mutated in-place, breaking the Anthropic prompt cache prefix and forcing full cache re-writes of 40–70K tokens at $6.25/MTok. Secondary causes include untrimmed tool call arguments in AIMessages and missing size budgets on tool results.

The cache invalidation issue is architecturally preventable. The reference architecture (described in [Reference Architecture Patterns](#reference-architecture-patterns) below) uses a stateful content-replacement table that freezes replacement decisions after first processing — content never mutates across turns. The same architecture employs 2-phase cache-break detection, per-tool size caps (50K chars), per-message budgets (200K chars), and a media-count guard (100 items). Notably, the reference architecture uses adaptive thinking with no budget cap for the highest-tier reasoning models, suggesting our original R2 (cap thinking) should be downgraded to monitoring.

## Problem Statement

Observed in a "Japanese Pagoda Design" session using Opus 4.6 (`anthropic-claude-opus-4.6`):

| Assistant Msg | Turns | Total Tokens | Total Cost | Expensive Turns          |
| ------------- | ----- | ------------ | ---------- | ------------------------ |
| 2nd-to-last   | 12    | 500K         | $1.44      | Turns 10–12: ~$0.25 each |
| Last          | 7     | 510K         | $1.64      | Turns 6–7: ~$0.45 each   |

For reference, a "healthy" turn with good cache hits costs $0.02–$0.07. The expensive turns are 5–20× more than expected.

## Methodology

1. Read the full exported conversation transcript (4,100 lines, 3 user messages + 3 assistant messages)
2. Traced the middleware pipeline execution order in `chat.service.ts`
3. Analyzed each middleware for content mutation patterns that would invalidate Anthropic prompt caching
4. Cross-referenced per-turn usage tooltips (Input/Output/CacheRead/CacheWrite) against Opus 4.6 pricing
5. Mapped screenshot tool call positions against cache invalidation events

## Opus 4.6 Pricing Reference

| Token Type               | Cost per MTok |
| ------------------------ | ------------- |
| Input (uncached)         | $5.00         |
| Output (text + thinking) | $25.00        |
| Cache read               | $0.50         |
| Cache write              | $6.25         |

Cache write is **12.5× more expensive** than cache read. Any cache invalidation event that converts reads to writes has an outsized cost impact.

## Findings

### Finding 1: Screenshot Trimming Invalidates Prompt Cache (Root Cause)

**Severity: P0 — directly causes 80%+ of the cost spike**

The `toolResultTrimmerMiddleware` mutates old screenshot content when a new screenshot is taken, breaking the Anthropic cache prefix.

**Mechanism:**

The middleware finds the "last screenshot" ToolMessage and injects its base64 images as multimodal content blocks via `injectScreenshotImages()`. All other (older) screenshots are trimmed via `trimToolMessage()`, replacing image blocks with `[screenshot image - previously captured]`.

```typescript
// tool-result-trimmer.middleware.ts — the cache-busting pattern
const trimmedMessages = messages.map((message, index) => {
  if (index === lastScreenshotIndex) {
    return injectScreenshotImages(message); // images injected
  }
  return trimToolMessage(message); // images replaced with text
});
```

**Cache invalidation trace:**

| Model Call              | Screenshot State                                                                                 | Cache Effect                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Turn 5 (1st screenshot) | Screenshot A: `[{type: 'image_url', image_url: {url: 'data:...'}}]`                              | Cache WRITE for new content                           |
| Turn 6 (no screenshot)  | Screenshot A: `[{type: 'image_url', image_url: {url: 'data:...'}}]`                              | Cache READ (prefix unchanged)                         |
| Turn 8 (2nd screenshot) | Screenshot A: `[{type: 'text', text: '[screenshot image - previously captured]'}]` ← **CHANGED** | Cache INVALIDATED from Screenshot A's position onward |

When Screenshot A's content changes from image blocks to text blocks, Anthropic's prefix-based caching invalidates everything from that byte position onward. For a 44K token context where the screenshot is at position ~10K, that means ~34K tokens of cache WRITE instead of cache READ:

- **Healthy turn**: 44K × $0.50/MTok = $0.022 (all cache read)
- **Invalidated turn**: 10K × $0.50/MTok + 34K × $6.25/MTok = $0.005 + $0.213 = $0.218

This alone explains the jump from $0.02 to $0.25 per turn.

**Evidence from transcript:** The pagoda conversation has 8 screenshots across 3 assistant messages (3 + 3 + 2). Each successive screenshot within a message causes cache invalidation. Each new assistant message inherits the previous message's last screenshot, which gets invalidated on the first new screenshot.

### Finding 2: Thinking Output Compounds the Cost

**Severity: P1 — 20–40% of expensive turn cost**

Opus 4.6 is configured with `thinking: { type: 'adaptive' }` and no budget cap:

```typescript
// model.constants.ts
configuration: {
  thinking: { type: 'adaptive' },
  // No budget_tokens — contrast with Haiku which has budget_tokens: 4000
},
```

The transcript shows extensive thinking blocks — one at lines 2494–2533 runs 40 lines with multiple "I'm reconsidering..." cycles:

> "I'm going to finalize this with code, but first I want to make those upswept corners more dramatic... Let me recalculate... Now I'm reconsidering how the corners should relate to the eave slab itself... Adjusting the upturn positioning... The dimensions check out within the acceptable range, so I'll stop second-guessing the parameters..."

At $25/MTok output rate, a 10K token thinking block costs $0.25 alone. Combined with cache invalidation, this produces the $0.45 turns:

| Component                                  | Tokens | Cost       |
| ------------------------------------------ | ------ | ---------- |
| Cache read (prefix before invalidation)    | ~50K   | $0.025     |
| Cache write (re-cached after invalidation) | ~23K   | $0.144     |
| Thinking output                            | ~10K   | $0.250     |
| Text output                                | ~1K    | $0.025     |
| **Total**                                  |        | **$0.444** |

### Finding 3: Tool Call Arguments Never Trimmed

**Severity: P1 — contributes 15–25K tokens of context waste**

The `toolResultTrimmerMiddleware` trims ToolMessage content (tool results) but NOT AIMessage `tool_calls` arguments. For `create_file`, the `content` argument contains the full file:

```json
{
  "name": "create_file",
  "args": {
    "targetFile": "main.scad",
    "content": "// 424 lines of OpenSCAD code (13,617 chars = ~3,400 tokens)"
  }
}
```

These arguments accumulate across turns. The pagoda session has:

- 1 `create_file` (424 lines = ~3.4K tokens)
- ~~8 `edit_file` calls (~~1–2K tokens each = ~8–16K tokens cumulative)
- Total: ~11–20K tokens of tool call arguments in AIMessages

The compaction middleware's `truncateToolArgs` only truncates these during compaction (when context exceeds 85% of the window), not during regular trimming. For a 200K context window, compaction triggers at ~170K tokens — far above the 44–73K observed.

### Finding 4: User-Attached Images Never Trimmed

**Severity: P2 — ~10–20K tokens of stale image data**

User messages 2 and 3 both include attached webp screenshots:

```
[Attached image (image/webp)]
see img, the roof appears beautiful and we should keep the intent...
```

These HumanMessage images persist in full across all subsequent model calls. Once the model has analyzed and acted on the feedback, the full image data adds no value — only the user's text instruction matters.

Estimated impact: 2 images × ~5–10K tokens each = 10–20K tokens of stale data in every model call.

### Finding 5: Memory/AGENTS.md Injection Overhead

**Severity: P3 — small but measurable overhead**

The `clientContextMiddleware` injects AGENTS.md content as a HumanMessage prepended at position [0]. This is consistent across turns (good for caching) but adds baseline context that grows with learned preferences.

The memory content includes full skills catalog and learned preferences — for mature workspaces, this could be 2–5K tokens. While cacheable, it increases the cache write penalty whenever cache invalidation occurs (Finding 1).

### Finding 6: Redundant Screenshot Calls

**Severity: P2 — each unnecessary screenshot costs $0.05–$0.25**

The transcript shows 3 screenshots per assistant message, often in rapid succession:

```
Turn N:   screenshot(multi_angle) → "looks clean"
Turn N+1: screenshot(single)      → "let me check from another angle"
Turn N+2: screenshot(multi_angle) → "verifying all angles"
```

The `multi_angle` mode already captures 6 views. Taking a `single` screenshot immediately after `multi_angle` is redundant. Each additional screenshot triggers cache invalidation (Finding 1), making the cost compound.

## Original Recommendations

These were the initial recommendations before benchmarking against the reference architecture. See "Revised Recommendations" below for the updated priorities.

| #   | Action                                | Priority | Effort | Impact | Estimated Savings   |
| --- | ------------------------------------- | -------- | ------ | ------ | ------------------- |
| R1  | Fix screenshot cache invalidation     | P0       | Medium | High   | ~$0.60–1.00/session |
| R2  | Add thinking budget to Opus/Sonnet    | P0       | Low    | High   | ~$0.30–0.50/session |
| R3  | Eagerly trim AIMessage tool_call args | P1       | Medium | Medium | ~$0.10–0.20/session |
| R4  | Trim stale user-attached images       | P1       | Medium | Medium | ~$0.05–0.15/session |
| R5  | Reduce redundant screenshot calls     | P2       | Low    | Medium | ~$0.10–0.25/session |

### R1: Fix Screenshot Cache Invalidation

**Approach A (Recommended): Separate screenshot injection from message history**

Never mutate existing message content. Instead:

1. Always store screenshots in trimmed form (metadata only, no images)
2. Inject the latest screenshot's images as a **new message** appended after the ToolMessage, not by modifying the existing ToolMessage content
3. The cache prefix remains stable because no old content changes

```typescript
// Instead of mutating existing messages:
// ❌ messages[oldScreenshot] = trimmed version
// ❌ messages[newScreenshot] = injected images

// Inject images as a separate, additive message:
// ✅ messages[screenshot] = always trimmed (stable for cache)
// ✅ messages.push(new HumanMessage({ content: imageBlocks })) // appended, never changes old content
```

**Approach B: Trim ALL screenshots uniformly, pass images out-of-band**

Always trim all screenshots (including the latest) to just metadata. Pass the latest screenshot's image data via a separate channel (e.g., in the system message's dynamic block, or as a user message injection before the model call).

### R2: Add Thinking Budget to Opus/Sonnet

```typescript
'claude-4.6-opus': {
  configuration: {
    thinking: {
      type: 'adaptive',
      budget_tokens: 16000,  // Cap verbose thinking
    },
  },
},
```

The pagoda session shows thinking blocks of 5–12K tokens that include extensive self-doubt loops ("I'm reconsidering... Actually, let me reconsider... The dimensions check out, so I'll stop second-guessing"). A 16K budget still allows deep reasoning while preventing runaway output costs.

### R3: Eagerly Trim Tool Call Arguments

Extend `toolResultTrimmerMiddleware` to also truncate large tool_call arguments on older AIMessages:

```typescript
// In wrapModelCall, after trimming tool results:
const withTrimmedArgs = trimmedMessages.map((message, index) => {
  if (index >= messages.length - 2) return message; // Keep recent
  if (!isAIMessage(message)) return message;
  return truncateToolCallArgs(message, MAX_ARG_LENGTH);
});
```

This reduces 15–25K tokens of stale file content from accumulating in the conversation.

### R4: Trim Stale User-Attached Images

Add image trimming for HumanMessages, similar to screenshot trimming. After the model has acted on a user-attached image (i.e., after the next assistant response), replace the image with a text placeholder:

```typescript
// In wrapModelCall:
// Find user messages with images that aren't the latest user message
// Replace image blocks with '[user-attached image — previously analyzed]'
```

### R5: Reduce Redundant Screenshot Calls (Prompt-Level)

Add guidance to the system prompt's `<visual_inspection>` section:

```
Use `multi_angle` for comprehensive verification — it captures 6 views.
Do NOT take `single` immediately after `multi_angle` — the front view is already included.
Take a maximum of 2 screenshots per editing cycle.
```

## Cost Model

Estimated per-turn costs for a 50K token context with various configurations:

| Scenario                      | Cache Read           | Cache Write          | Thinking           | Text Out          | Total      |
| ----------------------------- | -------------------- | -------------------- | ------------------ | ----------------- | ---------- |
| Healthy (all cache read)      | 50K × $0.50 = $0.025 | 2K × $6.25 = $0.013  | 2K × $25 = $0.050  | 1K × $25 = $0.025 | **$0.113** |
| Screenshot invalidation       | 20K × $0.50 = $0.010 | 32K × $6.25 = $0.200 | 2K × $25 = $0.050  | 1K × $25 = $0.025 | **$0.285** |
| Screenshot + verbose thinking | 20K × $0.50 = $0.010 | 32K × $6.25 = $0.200 | 10K × $25 = $0.250 | 1K × $25 = $0.025 | **$0.485** |
| After R1+R2 (fixed)           | 50K × $0.50 = $0.025 | 2K × $6.25 = $0.013  | 4K × $25 = $0.100  | 1K × $25 = $0.025 | **$0.163** |

**Expected session savings from R1+R2**: From ~$1.50/assistant message to ~$0.60/assistant message (60% reduction).

## Diagrams

```
Cache Prefix Lifecycle — Screenshot Invalidation

Turn 5 (1st screenshot taken):
  ┌──────────────────────────────────────────────────┐
  │ System │ Memory │ User1 │ AI1..4 │ Screenshot(A) │ ← cache WRITE (cold)
  └──────────────────────────────────────────────────┘

Turn 6 (edit, no screenshot):
  ┌──────────────────────────────────────────────────────────────┐
  │ System │ Memory │ User1 │ AI1..4 │ Screenshot(A) │ AI5 │ T5 │
  │◄──────────── cache READ ──────────────────────►│← WRITE ──►│
  └──────────────────────────────────────────────────────────────┘

Turn 8 (2nd screenshot taken — A mutated to placeholder):
  ┌──────────────────────────────────────────────────────────────────────┐
  │ System │ Memory │ User1 │ AI1..4 │ Screenshot(A') │ ... │ Screen(B) │
  │◄──── cache READ (unchanged) ───►│◄──── cache WRITE (changed) ──────►│
  └──────────────────────────────────────────────────────────────────────┘
                                     ↑ A → A' content changed: INVALIDATION
```

## Reference Architecture Patterns

A production-grade reference architecture for prompt-cache preservation under tool-heavy multimodal workloads provides direct precedent for each of our findings. The patterns below are stated as architectural primitives — the constants and structures are what matter, not where they originated.

### P1: Cache-Stable Content Replacement (validates R1, supersedes it)

A stateful `ContentReplacementState` is the architectural answer to our R1.

**Mechanism**: A stateful replacement tracker carried across turns. When a tool result is first processed, the decision (replace or keep) is frozen via `seenIds`/`replacements` maps. Every subsequent model call re-applies the exact same replacement byte-identically — zero I/O, deterministic.

```typescript
// Cache-stable replacement lifecycle
export type ContentReplacementState = {
  seenIds: Set<string>; // All tool_use_ids ever processed
  replacements: Map<string, string>; // Frozen replacement strings
};
```

Key properties that prevent our screenshot cache bug:

- **Immutable past**: Once content is seen, its form never changes — no "trim old screenshots when a new one arrives" pattern
- **Disk persistence**: Large results (>50K chars) are persisted to disk and replaced with a tagged preview (`<persisted-output>`) — the model can read the file if it needs the full content
- **Resume-safe**: Replacement decisions are written to the transcript as `ContentReplacementRecord`s so they survive session resume byte-identically
- **Per-message budget**: `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000` caps aggregate tool result size within a single turn's tool results — the largest blocks are replaced first

**Contrast with Tau**: Our `toolResultTrimmerMiddleware` re-derives trimming decisions on every model call. When a new screenshot appears, old screenshot content mutates from image blocks to `[screenshot image - previously captured]` text — exactly the pattern this architecture prevents.

**Recommendation adjustment**: R1's approach of "inject images as a separate message" is valid but insufficient. The deeper fix is adopting stateful, frozen replacements — once a tool result is processed, its wire content must never change.

### P2: Prompt Cache Break Detection (new recommendation)

A 2-phase detection system (`promptCacheBreakDetection`) catches cache invalidations the moment they happen, with no equivalent in Tau today.

**Phase 1 (pre-call)** — `recordPromptState()`: Hashes system prompt, tool schemas, cache_control blocks, model name, betas, effort, and extra body params. Diffs against previous state to identify what changed.

**Phase 2 (post-call)** — `checkResponseForCacheBreak()`: Checks if `cache_read_tokens` dropped >5% and >2,000 tokens from the previous call. If yes, explains why using the Phase 1 diff.

```typescript
// Detection thresholds
const MIN_CACHE_MISS_TOKENS = 2_000;
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000;
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000;
```

The pattern tracks 12+ separate causes of cache invalidation: system prompt, tool schemas, model changes, fast mode, cache_control scope/TTL flips, beta headers, effort changes, extra body params, and more. Each cause is independently flagged and logged to analytics.

The pattern also handles legitimate cache drops (compaction, cached microcompact deletions, TTL expiry) by resetting the baseline via `notifyCompaction()` / `notifyCacheDeletion()` to suppress false positives.

**New recommendation**: Add cache break detection to our usage tracking middleware. Even basic monitoring (comparing `cache_read_input_tokens` across turns) would have caught the screenshot invalidation issue before it shipped.

### P3: Media Count Guard (validates R4, adds hard cap)

`stripExcessMediaItems()` enforces a hard cap of 100 media items per API request, dropping the oldest first:

```typescript
// Media cap applied at the API boundary
messagesForAPI = stripExcessMediaItems(
  messagesForAPI,
  API_MAX_MEDIA_PER_REQUEST, // 100
);
```

This is a boundary guard, not a turn-by-turn mutation. Images pass through unchanged until the cap is hit. Crucially, tool results containing images are explicitly exempted from disk persistence (`hasImageBlock` check) — they're never trimmed to text placeholders.

Additionally, `normalizeMessagesForAPI` strips image/document blocks from user messages that triggered API errors (image too large, request too large) — preventing retry loops.

**Contrast with Tau**: We have no media count guard and no API error recovery for oversized images. Our screenshot trimmer actively mutates image content, which is the opposite of the boundary-guard approach.

### P4: Adaptive Thinking is Intentional (revises R2)

The reference architecture uses `adaptive` thinking for the highest-tier reasoning models with **no budget cap**:

```typescript
// Thinking configuration
if (modelSupportsAdaptiveThinking(options.model)) {
  thinking = { type: 'adaptive' };
} else {
  let thinkingBudget = getMaxThinkingTokensForModel(options.model);
  thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget);
  thinking = { budget_tokens: thinkingBudget, type: 'enabled' };
}
```

A `DISABLE_ADAPTIVE_THINKING` env var exists as an escape hatch but is NOT the default. For non-adaptive models, `budget_tokens` is capped at `upperLimit - 1`.

**Revision to R2**: The recommendation to add `budget_tokens: 16000` to Opus adaptive thinking is NOT aligned with the reference architecture. The provider has evidently decided the model's adaptive reasoning is worth the output cost — capping it risks degrading response quality on complex tasks. R2 should be downgraded from P0 to P2 (monitor, don't cap) unless we see thinking routinely exceeding 20K tokens on simple tasks.

### P5: Multi-Layer Compaction Pipeline (validates R3, reveals gaps)

The reference architecture uses three compaction layers:

1. **Per-tool limit** (`DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`): Individual tool results exceeding this are persisted to disk immediately.
2. **Per-message budget** (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`): Aggregate budget within a single turn's tool results. Largest blocks replaced first.
3. **Cached microcompact**: Uses the provider's `cache_edits` API to delete old tool results server-side without modifying local messages — preserves prompt cache.
4. **Time-based microcompact**: When the gap since the last assistant message exceeds 5 minutes (cache TTL expired), content-clears old tool results since cache is cold anyway.
5. **Autocompact**: Full conversation summarization when tokens exceed `contextWindow - 13K`.

**Contrast with Tau**: Our compaction triggers at 85% of context window (~170K for a 200K window). We have no per-tool limit, no per-message aggregate budget, no time-based clearing, and no cached microcompact. Our tool result trimmer removes specific fields but doesn't cap overall size.

### P6: Tool Call Arguments (partially validates R3)

The reference architecture does NOT have an explicit "trim AIMessage tool_call arguments" mechanism. Its per-tool limit (50K chars) and per-message budget (200K chars) catch the result side. Tool call arguments in assistant messages are addressed by compaction.

Our R3 remains valid since we lack both the per-tool cap and the per-message budget that would limit the equivalent tool call argument growth.

## Alignment Summary

| Finding                            | Tau Status                        | Reference Pattern                      | Alignment                                                                                     |
| ---------------------------------- | --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Screenshot cache invalidation (R1) | Mutates old content               | Frozen replacements (P1)               | **Misaligned** — Tau actively breaks cache; the reference pattern prevents it architecturally |
| Thinking budget (R2)               | No cap (adaptive)                 | No cap (adaptive) (P4)                 | **Aligned** — both use adaptive; R2 downgraded                                                |
| Tool call arg trimming (R3)        | Compaction only (85% threshold)   | Per-tool 50K + per-message 200K (P5)   | **Misaligned** — the reference pattern catches it earlier with size budgets                   |
| User image trimming (R4)           | Never trimmed                     | Hard cap at 100, oldest dropped (P3)   | **Misaligned** — the reference pattern has a boundary guard; Tau has none                     |
| Redundant screenshots (R5)         | Prompt guidance only              | N/A (no screenshot tool)               | **N/A**                                                                                       |
| Cache break detection              | None                              | 2-phase hash + token monitoring (P2)   | **Misaligned** — Tau is flying blind                                                          |
| Content replacement state          | Stateless (re-derives every turn) | Stateful (frozen after first decision) | **Misaligned** — fundamental architecture gap                                                 |

## Revised Recommendations

| #   | Action                                                                | Priority | Effort | Impact | Notes                                                         |
| --- | --------------------------------------------------------------------- | -------- | ------ | ------ | ------------------------------------------------------------- |
| R1' | Adopt stateful content replacement (frozen after first decision)      | P0       | High   | High   | Core architecture change; subsumes old R1; see P1             |
| R6  | Add cache break detection (compare cache_read_tokens across turns)    | P0       | Medium | High   | See P2; would have caught the original bug                    |
| R3' | Add per-tool size cap (50K chars) and per-message budget (200K chars) | P1       | Medium | Medium | See P5; catches tool result bloat before compaction threshold |
| R4' | Add media count guard (cap at 100, drop oldest)                       | P1       | Low    | Medium | See P3; boundary guard prevents API errors                    |
| R2' | Monitor thinking output, do NOT cap adaptive by default               | P2       | Low    | Low    | See P4; monitor for regression                                |
| R5  | Reduce redundant screenshot calls (prompt-level)                      | P2       | Low    | Medium | Unchanged                                                     |
| R7  | Time-based tool result clearing (clear when cache is cold anyway)     | P2       | Medium | Medium | See P5 layer 4; reclaim tokens when cache TTL expired         |

## References

- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- Related: `docs/policy/context-engineering-policy.md`
- Related: `docs/policy/filesystem-context-policy.md`
