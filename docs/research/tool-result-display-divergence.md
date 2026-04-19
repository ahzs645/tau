---
title: 'Tool Result Display Divergence'
description: 'Investigation into how agentic systems separate UI-facing tool outputs from model-facing context, and how Tau can prevent image loss during offloading'
status: draft
created: '2026-04-03'
updated: '2026-04-03'
category: investigation
related:
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
---

# Tool Result Display Divergence

How agentic harnesses separate what the user sees from what the model sees when tool results are trimmed, offloaded, or compacted — and how Tau's current architecture causes image loss.

## Executive Summary

Tau's tool offloading middleware replaces `ToolMessage.content` in `wrapToolCall`, which is the same content streamed to the UI via SSE. When screenshot tool results exceed the ~80KB threshold, base64 `dataUrl` strings are replaced with `[offloaded: N chars]` placeholders, making images un-renderable in the UI. Every major agentic harness studied (Vercel AI SDK, OpenAI Agents SDK, Deep Agents, and CLI-style coding agents that maintain a separate transcript channel) solves this with a **dual-track architecture**: full structured output for display, transformed/trimmed content for the model. Tau's trimmer middleware already implements half of this pattern (model-only trimming in `wrapModelCall`), but the offloading middleware operates at the wrong layer (`wrapToolCall`), conflating model and display concerns.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Finding 1: Tau's Single-Track Architecture](#finding-1-taus-single-track-architecture)
- [Finding 2: The Parallel-Field Dual-Track Pattern](#finding-2-the-parallel-field-dual-track-pattern)
- [Finding 3: Vercel AI SDK's toModelOutput](#finding-3-vercel-ai-sdks-tomodeloutput)
- [Finding 4: OpenAI Agents SDK's ToolOutputTrimmer](#finding-4-openai-agents-sdks-tooloutputtrimmer)
- [Finding 5: Deep Agents' Artifact Preservation](#finding-5-deep-agents-artifact-preservation)
- [Finding 6: Anthropic Context Editing API](#finding-6-anthropic-context-editing-api)
- [Finding 7: Industry Consensus on Context Engineering](#finding-7-industry-consensus-on-context-engineering)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)

## Problem Statement

When the AI agent captures screenshots during a CAD session, the tool result contains base64-encoded `dataUrl` strings (each image can exceed 100KB). The tool offloading middleware fires at the `wrapToolCall` layer and replaces these large strings with `[offloaded: N chars]` placeholders. Since the offloaded `ToolMessage` is what gets persisted in LangGraph state and streamed via `toUIMessageStream()`, the UI receives content where `img.dataUrl` no longer starts with `data:`, causing `ChatMessageToolScreenshot` to render zero images.

The same issue affects any tool that produces large structured output containing display-critical content (images, diffs, previews). The fundamental question: **how should the system separate what the user sees from what the model sees?**

## Methodology

1. **Tau codebase analysis**: Traced the complete tool result flow from handler → offloading middleware → LangGraph state → SSE stream → UI rendering.
2. **Repo exploration**: Examined source code in `repos/ai` (Vercel AI SDK), `repos/langgraphjs`, `repos/deepagentsjs`, plus published source for CLI coding agents that expose a structured display channel separate from model context.
3. **API documentation**: Reviewed Anthropic context editing API, OpenAI Agents SDK ToolOutputTrimmer, and context engineering literature.
4. **Web research**: Surveyed 2026 best practices for agentic tool result management, context engineering, and dual-channel streaming patterns.

## Finding 1: Tau's Single-Track Architecture

Tau processes tool results through a middleware stack where offloading and trimming operate at different layers, but both write to the same `ToolMessage.content`:

```
Tool Handler → ToolMessage (full content)
     ↓
wrapToolCall: ToolOffloading → replaces content with compacted version ← PROBLEM
     ↓
LangGraph State (persisted with offloaded content)
     ↓
toUIMessageStream() → SSE stream → UI (receives offloaded content)
     ↓
wrapModelCall: ToolResultTrimmer → further trims for LLM context ← CORRECT LAYER
```

The offloading middleware (`tool-offloading.middleware.ts`) runs `compactLargeStrings` which replaces any string leaf exceeding 1000 chars with `[offloaded: N chars]`. For screenshot results shaped as `{"images":[{"view":"front","dataUrl":"data:image/png;base64,..."}]}`, the `dataUrl` fields are the first casualties.

**Key gap**: The `screenshot` tool is NOT in the `excludedTools` set (`list_directory`, `glob_search`, `grep`, `read_file`, `edit_file`, `create_file`, `delete_file`). The exclusion list mirrors Deep Agents' rationale (self-truncating tools, re-read loop prevention) but does not account for display-critical content.

**The trimmer middleware is architecturally correct**: It runs in `wrapModelCall`, only affects what the LLM sees, and already handles screenshots specifically — injecting multimodal image blocks for the latest screenshot and replacing older ones with text placeholders. The trimmer never touches what the UI receives.

## Finding 2: The Parallel-Field Dual-Track Pattern

The most explicit separation of display vs. model content seen in production agentic harnesses places **two parallel fields on every tool-result message** — one whose lifecycle is owned by model context management, another whose lifecycle is owned by the UI/transcript renderer:

| Field                                             | Purpose                                                                         | Consumers                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `message.content` (array of `tool_result` blocks) | Model-facing; subject to persistence, budget enforcement, microcompact clearing | LLM API                                      |
| `toolUseResult` (structured `Output` object)      | UI/SDK-facing; never sent to model, never cleared by context management         | Terminal renderer, transcript search, web UI |

The architectural rationale is that **two distinct consumers have two distinct retention requirements**: the model needs the smallest viable representation that preserves task continuity, while the UI needs lossless fidelity for the lifetime of the conversation. Conflating them into one field forces every context-management decision to be a UI-rendering decision and vice versa.

**Behaviors enabled by the split**:

1. **Budget enforcement** can replace `tool_result` block content with `<persisted-output>` wrappers (file path + preview) without clearing the parallel display field — the UI keeps the full content forever.
2. **Time-based microcompact** can replace eligible `tool_result` content with `'[Old tool result content cleared]'` placeholders for the model while the UI transcript shows the original output unchanged.
3. **Cached microcompact** can use API-layer cache-edit primitives to delete old tool results server-side without mutating local messages at all — the local store remains the canonical UI source.
4. **Image handling** can use a `hasImageBlock` precondition that _refuses_ to persist/offload tool results containing images, falling back to in-context truncation instead. The architectural reason: persisting an image to disk and replacing it with a path defeats viewability, since the model cannot re-read an image from a filesystem reference and the UI now has to plumb a separate fetch path. Images must stay in-message or be dropped entirely.
5. **Tool rendering** can pull from the native `Output` type for the UI while a separate mapper produces the model-facing `tool_result` block — neither knows about the other's representation.

**Representative thresholds** observed in production: ~400KB per individual result, ~200K aggregate chars per message, ~2KB preview when the full content is replaced for the model.

## Finding 3: Vercel AI SDK's toModelOutput

The Vercel AI SDK (v5.0, `repos/ai`) provides a built-in mechanism for dual-track tool results.

**Architecture**: Tools can define a `toModelOutput` function that transforms raw execution output into model-specific content:

```
Tool execution → raw output
     ↓                    ↓
UIMessage.parts[].output  →  toModelOutput()  →  ToolResultOutput (for model)
(UI rendering)                                    (sent to provider)
```

**Source**: `repos/ai/packages/ai/src/prompt/create-tool-model-output.ts` — `createToolModelOutput` calls `tool.toModelOutput({ toolCallId, input, output })` if defined, otherwise falls back to string/JSON serialization. `repos/ai/packages/ai/src/ui/convert-to-model-messages.ts` — converts `UIMessage` parts to model messages using `createToolModelOutput`.

**Key insight**: The UI always holds raw `part.output` (the full execution result). The model-facing conversion only happens when building the next API request. This is the cleanest architectural split — the streaming protocol carries full fidelity, transformation happens at the consumption boundary.

**`ToolResultOutput` types**: Supports multimodal content including `image-data`, `image-url`, `file-data`, `file-url`, `file-id`, `text`, and `json`. This means `toModelOutput` can return a text description of an image while the UI renders the actual image.

**Tau does not use `toModelOutput`**: A grep for `toModelOutput` in the Tau codebase returned zero results.

## Finding 4: OpenAI Agents SDK's ToolOutputTrimmer

OpenAI's Agents SDK implements `ToolOutputTrimmer` as a `CallModelInputFilter` — a function that runs at model-call time, not at tool-execution time.

**Architecture**: Sliding window that preserves the last N user messages at full fidelity and trims older tool outputs:

| Parameter          | Default    | Purpose                                                 |
| ------------------ | ---------- | ------------------------------------------------------- |
| `recent_turns`     | 2          | User messages whose surrounding items are never trimmed |
| `max_output_chars` | 500        | Outputs above this are candidates for trimming          |
| `preview_chars`    | 200        | Characters of preview preserved when trimming           |
| `trimmable_tools`  | None (all) | Optional allowlist of tools eligible for trimming       |

**Key design decisions**:

1. **Immutable**: Never mutates the original input list — creates trimmed copies.
2. **Model-call scoped**: Only affects what goes to the model, not what's stored or displayed.
3. **Smart skip**: If the trimmed preview would be longer than the original, skip trimming.
4. **Selective**: Only trims `function_call_output` items — user messages, assistant messages, and `function_call` items (tool name + arguments) are always preserved.

This aligns with Tau's `toolResultTrimmerMiddleware` pattern (model-call scoped), but Tau's offloading middleware breaks this by operating at tool-execution time.

## Finding 5: Deep Agents' Artifact Preservation

Deep Agents (`repos/deepagentsjs`) implements filesystem-backed tool result eviction with explicit artifact preservation.

**Architecture** (`libs/deepagents/src/middleware/fs.ts`):

1. `wrapToolCall`: After tool runs, if `ToolMessage.content` exceeds threshold (20K tokens × 4 chars), writes full content to `/large_tool_results/{sanitizedId}` via backend, replaces content with preview + instructions.
2. **Artifact preservation**: When creating the replacement `ToolMessage`, the eviction path explicitly copies `artifact` and other fields from the original message.
3. **Excluded tools**: `ls`, `glob`, `grep`, `read_file`, `edit_file`, `write_file` — same rationale as Tau.

**LangChain `artifact` concept** (`repos/langgraphjs/libs/sdk/src/types.messages.ts`):

```typescript
artifact?: any;
// "Artifact of the Tool execution which is not meant to be sent to the model.
//  Should only be specified if it is different from the message content"
```

Deep Agents uses this to carry display-critical data alongside the trimmed model content. However, Deep Agents has no image/multimodal handling — a grep for `image_url`, `ImageBlock`, `multimodal`, `base64` under `libs/deepagents` returned no matches.

## Finding 6: Anthropic Context Editing API

Anthropic offers server-side `clear_tool_uses_20250919` strategy that clears old tool results at the API layer before the prompt reaches Claude. This is distinct from client-side processing:

**Key properties**:

1. **Server-side**: Applied before prompt reaches Claude. Client maintains full, unmodified conversation history.
2. **Configurable thresholds**: `trigger_tokens` (when to start clearing), `clear_at_least` (minimum tokens to clear for cache invalidation amortization).
3. **Placeholder preservation**: Cleared results are replaced with placeholder text so Claude knows content was removed.
4. **No image special-casing mentioned**: The API documentation does not address image content preservation specifically.

**Relevance to Tau**: This approach keeps the full conversation on the client while the server manages what the model sees — similar to the dual-track pattern but implemented at the API provider level rather than in the application.

## Finding 7: Industry Consensus on Context Engineering

Across all sources studied, a clear hierarchy emerges for managing large tool results:

1. **Reversible offload** first — store full content externally (files, URLs), keep lightweight pointers in context. The key word is "reversible" — the model can `read_file` to recover content.
2. **Model-boundary trimming** second — transform content at the point of model consumption, not at the point of tool execution.
3. **Summarization** third — lossy compression via LLM summarization (Morph compaction in Tau's case).
4. **Sub-agent isolation** fourth — let long/noisy work happen in separate context windows.

**Critical invariant across all systems**: Display content must not be corrupted by model-context optimization. Every system either:

- Maintains a separate display channel (the parallel-field pattern from Finding 2, AI SDK's `part.output`)
- Operates trimming only at model-call time (OpenAI Agents SDK's `CallModelInputFilter`, Tau's own `toolResultTrimmerMiddleware`)
- Preserves artifact fields through eviction (Deep Agents' artifact copy)

## Recommendations

| #   | Action                                                                                                       | Priority | Effort  | Impact                                     |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- | ------- | ------------------------------------------ |
| R1  | Add `screenshot` to `excludedTools` in offloading middleware                                                 | P0       | Trivial | High — immediate fix for image loss        |
| R2  | Implement `toModelOutput` on screenshot tool to return text description for model while UI keeps full output | P1       | Low     | High — SDK-native dual-track               |
| R3  | Move offloading logic from `wrapToolCall` to `wrapModelCall` so it only affects model context                | P1       | Medium  | High — architectural fix                   |
| R4  | Add image-block detection to offloading middleware (skip any result containing base64 data URLs)             | P1       | Low     | Medium — guards future image-bearing tools |
| R5  | Evaluate Anthropic `clear_tool_uses_20250919` API as replacement for custom compaction of tool results       | P2       | Medium  | Medium — reduces custom middleware         |
| R6  | Adopt `artifact` field on LangChain `ToolMessage` for display-critical data that must survive offloading     | P2       | Medium  | Medium — aligns with LangChain ecosystem   |

### R1: Immediate Fix (excludedTools)

Add `screenshot` to the `excludedTools` set in `tool-offloading.middleware.ts`. This is the minimal change to prevent image loss. Screenshot results are already handled by the trimmer middleware at `wrapModelCall` time, so excluding them from offloading doesn't increase model context.

### R2: Implement toModelOutput (SDK-Native)

The Vercel AI SDK's `toModelOutput` is the cleanest path to dual-track tool results. For the screenshot tool, `toModelOutput` would return a text description (`"Captured 3 screenshots: front, top, isometric"`) while the UI continues to receive and render the full `output` with `dataUrl` fields. This leverages existing SDK infrastructure without new abstractions.

### R3: Move Offloading to wrapModelCall

The architectural root cause is that offloading runs in `wrapToolCall`, which is the persistence/streaming layer. Moving it to `wrapModelCall` would make offloading a model-context-only concern, aligning with the trimmer middleware and every other system studied. The filesystem write (`.tau/offloaded-tool-results/`) can still happen, but the `ToolMessage` in graph state would retain full content for UI streaming.

**Trade-off**: This increases checkpoint storage size, since full tool results are persisted in LangGraph state. Mitigated by the existing trimmer reducing what the model sees, and by the checkpoint TTL eventually reclaiming space.

### R4: Image-Block Detection Guard

Add a guard to the offloading middleware that detects base64 data URLs in JSON content and skips offloading for those results — the same `hasImageBlock` precondition described in Finding 2. This future-proofs against new image-bearing tools without requiring per-tool exclusions, and avoids the architectural dead-end of persisting images to disk where neither the model (no re-read capability) nor the UI (extra fetch plumbing) can recover them cleanly.

## Trade-offs

| Approach                      | Pros                                             | Cons                                                                                   |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **R1: excludedTools**         | Trivial change, immediate fix                    | Per-tool exclusion doesn't scale; new image tools need manual addition                 |
| **R2: toModelOutput**         | SDK-native, clean separation, per-tool control   | Requires `@ai-sdk/langchain` adapter support; each tool needs explicit mapping         |
| **R3: Move to wrapModelCall** | Architectural fix, aligns with industry patterns | Increases checkpoint size; offloaded file path not in graph state for agent re-read    |
| **R4: Image detection**       | Automatic, no per-tool config                    | Heuristic (may miss non-base64 image formats); detection overhead on every tool result |
| **R5: Anthropic API**         | Server-side, no custom middleware needed         | Provider-specific; doesn't work with OpenAI/Ollama; less control over timing           |
| **R6: LangChain artifact**    | Ecosystem-aligned, explicit display data         | Requires UI changes to read from `artifact`; AI SDK adapter may not surface it         |

## Code Examples

### Current Broken Flow

```typescript
// tool-offloading.middleware.ts — wrapToolCall
const content = typeof result.content === 'string'
  ? result.content
  : JSON.stringify(result.content);

if (content.length <= charThreshold) return result;

// compactLargeStrings replaces base64 dataUrls with "[offloaded: N chars]"
const replacementContent = compactJsonContent(content, filePath);

// This ToolMessage is what gets persisted AND streamed to UI
return new ToolMessage({ content: replacementContent, ... });
```

```typescript
// chat-message-tool-screenshot.tsx — UI rendering
const renderableImages = allImages.filter(
  (img) => img.dataUrl.startsWith('data:'), // ← fails: dataUrl is "[offloaded: N chars]"
);
```

### R1 Fix: Add to excludedTools

```typescript
const excludedTools = new Set([
  'list_directory',
  'glob_search',
  'grep',
  'read_file',
  'edit_file',
  'create_file',
  'delete_file',
  'screenshot', // Display-critical: images handled by trimmer in wrapModelCall
]);
```

### R4 Fix: Image-Block Detection

```typescript
function containsBase64Images(content: string): boolean {
  return content.includes('data:image/');
}

// In wrapToolCall, before offloading:
if (containsBase64Images(content)) return result;
```

## References

- Vercel AI SDK source: `repos/ai/packages/ai/src/prompt/create-tool-model-output.ts`, `repos/ai/packages/ai/src/ui/convert-to-model-messages.ts`
- Deep Agents source: `repos/deepagentsjs/libs/deepagents/src/middleware/fs.ts`
- LangGraph SDK types: `repos/langgraphjs/libs/sdk/src/types.messages.ts`
- [Anthropic Context Editing API](https://docs.anthropic.com/en/docs/build-with-claude/context-editing)
- [OpenAI Agents SDK ToolOutputTrimmer](https://openai.github.io/openai-agents-python/ref/extensions/tool_output_trimmer/)
- [Context Engineering for AI Agents](https://langcopilot.com/posts/2026-03-23-context-engineering-ai-agents-offload-summarize-isolate-cache)
- Policy: `docs/policy/context-engineering-policy.md`
- Policy: `docs/policy/filesystem-context-policy.md`
