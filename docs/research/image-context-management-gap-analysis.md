---
title: 'Image Context Management Gap Analysis'
description: 'Audit of Tau image handling pipeline against production-grade multimodal context-management practices, identifying 12 gaps causing context compaction loops and cost inflation, with a prioritized remediation blueprint.'
status: active
created: '2026-04-16'
updated: '2026-04-17'
category: audit
related:
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
  - docs/research/chat-model-cost-forensics.md
---

# Image Context Management Gap Analysis

Cross-reference of Tau's image handling pipeline against production-grade multimodal context-management practices, identifying every gap that contributes to context compaction loops, token waste, and cost inflation.

## Executive Summary

~~Tau has **zero image processing** between user paste and LLM API call.~~ All P0 and P1 gaps have been remediated. The image pipeline now implements an **8-layer defense**: client-side Canvas resize (1568×1568 cap with JPEG quality ladder), base64 size validation (5 MB gate), vision-aware flat 2000-token estimation (the established constant for image content blocks), Morph image stripping (`[image]` markers), `lastQuery` text extraction, screenshot offloading exclusion, per-request 100-media cap, and emergency image stripping on context overflow. Of the original 12 findings: **11 are RESOLVED** and **1 is DEFERRED** (F10 — image deduplication). Of 12 recommendations: **11 COMPLETE** and **1 DEFERRED** (R12 — content hashing). The compaction loop root cause (raw base64 → inflated token estimate → premature trigger → ineffective compaction → re-trigger) is eliminated at all three links: R1 caps image size at source, R2 uses flat token accounting, and R3–R4 strip images from compaction payloads.

## Methodology

1. Surveyed published image-pipeline patterns in production multimodal coding agents — covering image preprocessing (resize/compression), context compaction with multimodal payloads, vision-aware token estimation, per-request media caps, and reactive recovery from media-related API errors
2. Read all Tau chat middleware source files: `compaction.middleware.ts`, `compaction.service.ts`, `tool-result-trimmer.middleware.ts`, `tool-offloading.middleware.ts`, `client-context.middleware.ts`, `prompt-caching.middleware.ts`
3. Traced the full image lifecycle in Tau: paste → `FileReader.readAsDataURL` → draft state → `useChat` → API → `toBaseMessages` → LangChain → provider
4. Cross-referenced Anthropic/OpenAI vision token pricing documentation (April 2026)
5. Analyzed the production transcript (`initial_design_2026-04-16T07-41.md`) showing the compaction loop

## Scope and Non-Goals

**In scope**: User-pasted images, screenshot tool images, image token accounting, compaction behavior with multimodal content, API payload optimization

**Out of scope**: Video/PDF handling, model output image generation, AR/3D viewer screenshots (separate pipeline)

## Findings

### ~~Finding 1: No Client-Side Image Resize or Compression~~ ✅ RESOLVED

**Severity**: ~~P0 — Root cause of compaction loops~~ **RESOLVED**

**Status**: **RESOLVED** — `resizeImageForChat()` in `apps/ui/app/utils/resize-image.ts` implements a Canvas API-based compression pipeline: 1568×1568 dimension cap (Anthropic's internal resize sweet spot), JPEG quality ladder (0.85 → 0.7 → 0.5 → 0.3), 1 MB base64 output enforcement, and last-resort 800px downscale at q=0.3. Wired into all 4 image entry points: `handlePaste`, `handleFileChange`, `handleDrop` in `chat-textarea-types.ts`, and TipTap `handlePaste` in `use-chat-editor.ts`. All entry points use `async/await` with per-file sequential processing. 7 unit tests cover dimension capping, quality ladder, aspect ratio preservation, last-resort downscale, error handling, and passthrough of small images.

**Architecture rationale**: Server-side libvips/Sharp pipelines are the right tool when images enter via CLI file reads (no network hop, image already on disk). Tau's images enter via the browser, making the Canvas API the correct tool: zero dependency, runs synchronously at the source, and crushes payload size _before_ the network transit so neither the API server nor the LLM provider ever sees the oversized bytes.

### ~~Finding 2: No Base64 Size Validation Before API Call~~ ✅ RESOLVED

**Severity**: ~~P0 — Can cause 400 errors and context overflow~~ **RESOLVED**

**Status**: **RESOLVED** — `validateImageParts()` in `apps/api/app/api/chat/utils/validate-image-parts.ts` checks all `file` parts with image `mediaType` against a 5 MB base64 limit (`MAX_BASE64_LENGTH = 5 * 1024 * 1024`). Throws a descriptive error with human-readable size info (e.g., "Image exceeds 5 MB base64 limit (6.0 MB)"). Wired into `chat.controller.ts:prepareMessages` before `toBaseMessages`. 6 unit tests cover valid/invalid sizes, cross-message validation, non-image file passthrough, and error message format.

### ~~Finding 3: Token Estimation Treats Base64 as Text~~ ✅ RESOLVED

**Severity**: ~~P0 — Directly causes false compaction triggers and loops~~ **RESOLVED**

**Status**: **RESOLVED** — `estimateMessageTokens` in `compaction.middleware.ts` now uses `isImageBlock()` from the shared `image-block.utils.ts` module to detect image content blocks and applies a flat `IMAGE_TOKEN_ESTIMATE = 2000` tokens per image instead of `JSON.stringify`-based character counting. Text and reasoning blocks continue to use the `chars / 4` heuristic. The shared helper module (`image-block.utils.ts`) exports `isImageBlock`, `stripImageBlocks`, `countImageBlocks`, and `extractTextFromContent` — reused across 6 tasks (T3–T5, T8, T10–T12). 17 unit tests cover image block detection (all three LangChain image formats), stripping, counting, text extraction, and the token estimate constant.

### ~~Finding 4: Compaction Sends Raw Base64 to Morph~~ ✅ RESOLVED

**Severity**: ~~P1 — Cost and latency amplifier~~ **RESOLVED**

**Status**: **RESOLVED** — `CompactionService.toMorphFormat` now uses `isImageBlock()` to detect image content blocks and replaces them with `[image]` text markers. Text and reasoning blocks are preserved. Messages with only image content produce `[image]` as the entire content string. 5 unit tests cover `image_url` blocks, `file` parts with image mediaType, mixed content, text/reasoning preservation, and image-only messages.

### ~~Finding 5: Compacted Summary Drops All Image Context~~ ✅ RESOLVED

**Severity**: ~~P1 — Loss of visual context after compaction~~ **RESOLVED**

**Status**: **RESOLVED** — `CompactionService.compact()` now counts evicted image blocks via `countImageBlocks()` and passes the count to `parseCompactedOutput`, which includes the count in the summary: `[Compacted conversation history — N image(s) from prior context omitted]`. When no images were evicted, the note is omitted. 3 unit tests cover image count inclusion, zero-count omission, and cross-message counting.

### ~~Finding 6: Transcript Offload Drops Multimodal Blocks~~ ✅ RESOLVED

**Severity**: ~~P2 — History loss~~ **RESOLVED**

**Status**: **RESOLVED** — The `serializeEvictedMessages` helper in `compaction.middleware.ts` now emits `{ role, type: 'image', content: '[user attached image]', timestamp }` JSONL lines for image blocks via `isImageBlock()`, in addition to existing text and reasoning block handling. 2 unit tests cover image marker emission and mixed text/reasoning/image block handling.

### ~~Finding 7: Continuity Instructions Skip Multimodal Messages~~ ✅ RESOLVED

**Severity**: ~~P1 — Post-compaction confusion~~ **RESOLVED**

**Status**: **RESOLVED** — `addContinuityInstructions` in `compaction.middleware.ts` now handles both string and array content. For array content, it appends a `{ type: 'text', text: POST_COMPACTION_CONTINUITY }` block to the content array via `new HumanMessage({ content: [..., textBlock] })`. Non-HumanMessage messages are passed through unchanged. 3 unit tests cover string content, array content, and non-HumanMessage passthrough.

### ~~Finding 8: No Per-Request Media Count Limit~~ ✅ RESOLVED

**Severity**: ~~P1 — Can hit API media limits~~ **RESOLVED**

**Status**: **RESOLVED** — `stripExcessMedia(messages, limit = 100)` in `compaction.middleware.ts` counts all image blocks across all messages, and when the count exceeds the limit, replaces the oldest image blocks with `[image previously attached]` text markers. Wired into `wrapModelCall` before the handler call. 3 unit tests cover passthrough under limit, oldest-first stripping, and text marker replacement.

### ~~Finding 9: Screenshot Tool Images Not Excluded from Offloading~~ ✅ RESOLVED

**Severity**: ~~P1 — Vision capability loss~~ **RESOLVED**

**Status**: **RESOLVED** — `'screenshot'` added to `excludedTools` set in `tool-offloading.middleware.ts` (line 33). Screenshot tool results are now passed through unchanged regardless of size, ensuring the full multimodal image data reaches the model. The existing `tool-result-trimmer` already handles screenshot lifecycle: latest screenshot gets `image_url` blocks injected, older screenshots get replaced with text markers. Updated `it.each` test block to include `'screenshot'` in excluded tools verification.

### ⏸️ Finding 10: No Image Disk Cache or Deduplication — Deferred

**Severity**: ~~P2 — Memory pressure and re-send waste~~ **DEFERRED** — Not blocking for production

Pasted images live as full base64 strings in React state (`draftImages: string[]`). There is no disk cache, no deduplication, and no eviction policy. Re-sending the same image in a new message duplicates the full base64 payload.

**Reference pattern**: A common production pattern is a per-session disk cache with a 200-path LRU in-memory map. Images are written to a per-session directory (mode `0o600`), and prior-session directories are cleaned up at startup. See `docs/research/image-storage-architecture.md` for the full evaluation against Tau's web-client constraints.

**Deferral rationale**: With R1 capping images at ≤1 MB, the memory pressure from base64 strings is manageable. Deduplication via content hashing (R12) is a future optimization — not required for production stability.

### ~~Finding 11: `lastQuery` for Morph Can Be Enormous~~ ✅ RESOLVED

**Severity**: ~~P2 — Morph prompt inflation~~ **RESOLVED**

**Status**: **RESOLVED** — The `lastQuery` extraction in `compaction.middleware.ts` now uses `extractTextFromContent()` from the shared `image-block.utils.ts` module. For multimodal array content, only text parts are extracted and joined; image blocks are excluded entirely. For string content, the behavior is unchanged. 2 unit tests cover multimodal text extraction and image-only messages (empty lastQuery).

### ~~Finding 12: Emergency Compaction Has No Image Budget~~ ✅ RESOLVED

**Severity**: ~~P1 — Tail-heavy images can't be recovered~~ **RESOLVED**

**Status**: **RESOLVED** — The `ContextOverflowError` handler in `compaction.middleware.ts` now applies `stripImageBlocks()` to the emergency retained messages before the retry call. Image blocks are replaced with `[image]` text markers, ensuring the retained tail can fit within the context window even when it contains images. The `tokenEstimationMultiplier` bump is preserved to prevent re-triggering. 3 unit tests cover image stripping, text marker replacement, and multiplier behavior.

## Recommendations

| #          | Action                                                                                    | Priority | Effort      | Impact       | Status                                                          |
| ---------- | ----------------------------------------------------------------------------------------- | -------- | ----------- | ------------ | --------------------------------------------------------------- |
| ✅ ~~R1~~  | ~~Client-side image resize: cap at 1568×1568, JPEG quality ladder, enforce ≤1 MB base64~~ | ~~P0~~   | ~~Medium~~  | ~~Critical~~ | **COMPLETE** — `resizeImageForChat()` + 4 entry points wired    |
| ✅ ~~R2~~  | ~~Vision-aware token accounting: flat 2000-token constant for image blocks~~              | ~~P0~~   | ~~Low~~     | ~~Critical~~ | **COMPLETE** — `IMAGE_TOKEN_ESTIMATE = 2000` + `isImageBlock()` |
| ✅ ~~R3~~  | ~~Strip images before Morph: replace image blocks with `[image]` markers~~                | ~~P0~~   | ~~Low~~     | ~~High~~     | **COMPLETE** — `toMorphFormat` uses `isImageBlock()`            |
| ✅ ~~R4~~  | ~~Strip images from `lastQuery`: extract only text parts~~                                | ~~P0~~   | ~~Low~~     | ~~High~~     | **COMPLETE** — `extractTextFromContent()`                       |
| ✅ ~~R5~~  | ~~Base64 size gate: validate against 5 MB limit before API call~~                         | ~~P1~~   | ~~Low~~     | ~~Medium~~   | **COMPLETE** — `validateImageParts()` in `prepareMessages`      |
| ✅ ~~R6~~  | ~~Exclude screenshots from tool offloading~~                                              | ~~P1~~   | ~~Trivial~~ | ~~Medium~~   | **COMPLETE** — `'screenshot'` in `excludedTools`                |
| ✅ ~~R7~~  | ~~Image markers in compacted summary with evicted count~~                                 | ~~P1~~   | ~~Low~~     | ~~Medium~~   | **COMPLETE** — `parseCompactedOutput` includes image count      |
| ✅ ~~R8~~  | ~~Multimodal continuity instructions for array content~~                                  | ~~P1~~   | ~~Low~~     | ~~Medium~~   | **COMPLETE** — `addContinuityInstructions` handles arrays       |
| ✅ ~~R9~~  | ~~Media count cap: strip oldest media past 100 items~~                                    | ~~P1~~   | ~~Low~~     | ~~Medium~~   | **COMPLETE** — `stripExcessMedia()` in `wrapModelCall`          |
| ✅ ~~R10~~ | ~~Emergency image stripping on ContextOverflowError~~                                     | ~~P1~~   | ~~Low~~     | ~~High~~     | **COMPLETE** — `stripImageBlocks()` on emergency messages       |
| ✅ ~~R11~~ | ~~Transcript image markers for evicted blocks~~                                           | ~~P2~~   | ~~Trivial~~ | ~~Low~~      | **COMPLETE** — `[user attached image]` in JSONL transcript      |
| ⏸️ R12     | Image deduplication: hash base64 on paste, store once, reference by hash                  | P2       | Medium      | Low          | **DEFERRED** — not blocking for production                      |

## Implementation Evidence

### Files Created

| File                                                       | Purpose                                                                                          | Tests    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| `apps/ui/app/utils/resize-image.ts`                        | Client-side Canvas resize with JPEG quality ladder                                               | 7 tests  |
| `apps/ui/app/utils/resize-image.test.ts`                   | —                                                                                                | —        |
| `apps/api/app/api/chat/utils/image-block.utils.ts`         | Shared helpers: `isImageBlock`, `stripImageBlocks`, `countImageBlocks`, `extractTextFromContent` | 17 tests |
| `apps/api/app/api/chat/utils/image-block.utils.test.ts`    | —                                                                                                | —        |
| `apps/api/app/api/chat/utils/validate-image-parts.ts`      | Base64 size validation (5 MB gate)                                                               | 6 tests  |
| `apps/api/app/api/chat/utils/validate-image-parts.test.ts` | —                                                                                                | —        |

### Files Modified

| File                                                                  | Changes                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/ui/app/components/chat/chat-textarea-types.ts`                  | `handlePaste`, `handleFileChange`, `handleDrop` → `resizeImageForChat()` before `addImage()`                                                                                         |
| `apps/ui/app/components/chat/tiptap/use-chat-editor.ts`               | TipTap `handlePaste` → `resizeImageForChat()` before `onImagePasteRef`                                                                                                               |
| `apps/ui/app/hooks/draft.machine.ts`                                  | `buildDraftMessage` → `extractMimeTypeFromDataUrl()` instead of hardcoded `image/png`                                                                                                |
| `apps/ui/app/hooks/use-chat.tsx`                                      | `editMessage` → `extractMimeTypeFromDataUrl()` instead of hardcoded `image/png`                                                                                                      |
| `apps/ui/app/utils/chat.utils.ts`                                     | Exported `extractMimeTypeFromDataUrl`                                                                                                                                                |
| `apps/api/app/api/chat/middleware/compaction.middleware.ts`           | `estimateMessageTokens` (vision-aware), `addContinuityInstructions` (array), `stripExcessMedia`, emergency `stripImageBlocks`, transcript image markers, `lastQuery` text extraction |
| `apps/api/app/api/chat/middleware/compaction.middleware.test.ts`      | 33 tests covering all new compaction behaviors                                                                                                                                       |
| `apps/api/app/api/chat/compaction.service.ts`                         | `toMorphFormat` (image stripping), `parseCompactedOutput` (evicted image count)                                                                                                      |
| `apps/api/app/api/chat/compaction.service.test.ts`                    | 15 tests including Morph stripping and image count                                                                                                                                   |
| `apps/api/app/api/chat/chat.controller.ts`                            | `prepareMessages` → `validateImageParts()` call                                                                                                                                      |
| `apps/api/app/api/chat/middleware/tool-offloading.middleware.ts`      | `'screenshot'` added to `excludedTools`                                                                                                                                              |
| `apps/api/app/api/chat/middleware/tool-offloading.middleware.test.ts` | 22 tests updated for screenshot exclusion                                                                                                                                            |

### Test Coverage Summary

| Project   | Test Files                           | Total Tests   | Status      |
| --------- | ------------------------------------ | ------------- | ----------- |
| UI        | `resize-image.test.ts`               | 7             | ✅ All pass |
| API       | `image-block.utils.test.ts`          | 17            | ✅ All pass |
| API       | `validate-image-parts.test.ts`       | 6             | ✅ All pass |
| API       | `compaction.middleware.test.ts`      | 33            | ✅ All pass |
| API       | `compaction.service.test.ts`         | 15            | ✅ All pass |
| API       | `tool-offloading.middleware.test.ts` | 22            | ✅ All pass |
| **Total** | **6 files**                          | **100 tests** | ✅          |

## Requirements Coverage Matrix

| Finding | Recommendation | Priority | Description                              | Status                                                                                                       |
| ------- | -------------- | -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ~~F1~~  | ~~R1~~         | ~~P0~~   | ~~Client-side image resize/compression~~ | ✅ **COMPLETE** — `resizeImageForChat()` with Canvas API, 1568px cap, JPEG quality ladder, 1 MB output limit |
| ~~F2~~  | ~~R5~~         | ~~P1~~   | ~~Base64 size validation~~               | ✅ **COMPLETE** — `validateImageParts()` with 5 MB gate in `prepareMessages`                                 |
| ~~F3~~  | ~~R2~~         | ~~P0~~   | ~~Vision-aware token estimation~~        | ✅ **COMPLETE** — Flat `IMAGE_TOKEN_ESTIMATE = 2000` via `isImageBlock()` helper                             |
| ~~F4~~  | ~~R3~~         | ~~P0~~   | ~~Strip images before Morph compaction~~ | ✅ **COMPLETE** — `toMorphFormat` replaces images with `[image]` markers                                     |
| ~~F5~~  | ~~R7~~         | ~~P1~~   | ~~Image markers in compacted summary~~   | ✅ **COMPLETE** — `parseCompactedOutput` includes evicted image count                                        |
| ~~F6~~  | ~~R11~~        | ~~P2~~   | ~~Transcript image markers~~             | ✅ **COMPLETE** — `[user attached image]` JSONL lines for evicted image blocks                               |
| ~~F7~~  | ~~R8~~         | ~~P1~~   | ~~Multimodal continuity instructions~~   | ✅ **COMPLETE** — `addContinuityInstructions` handles array content                                          |
| ~~F8~~  | ~~R9~~         | ~~P1~~   | ~~Per-request media count cap~~          | ✅ **COMPLETE** — `stripExcessMedia(messages, 100)` in `wrapModelCall`                                       |
| ~~F9~~  | ~~R6~~         | ~~P1~~   | ~~Screenshot offloading exclusion~~      | ✅ **COMPLETE** — `'screenshot'` in `excludedTools` set                                                      |
| F10     | R12            | P2       | Image deduplication via content hashing  | ⏸️ **DEFERRED** — not blocking; R1 caps images at ≤1 MB                                                      |
| ~~F11~~ | ~~R4~~         | ~~P0~~   | ~~Strip images from `lastQuery`~~        | ✅ **COMPLETE** — `extractTextFromContent()` for multimodal messages                                         |
| ~~F12~~ | ~~R10~~        | ~~P1~~   | ~~Emergency image stripping~~            | ✅ **COMPLETE** — `stripImageBlocks()` on `ContextOverflowError` retained messages                           |

### Additional cleanup (not in original findings)

| Item                               | Description                                                                       | Status                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Hardcoded `mediaType: 'image/png'` | `draft.machine.ts` and `use-chat.tsx` used hardcoded PNG MIME type for all images | ✅ **COMPLETE** — Uses `extractMimeTypeFromDataUrl()` to detect actual MIME after resize |

## Trade-offs

| Approach                            | Pros                                                 | Cons                                                      |
| ----------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Client-side Canvas resize           | Zero server cost, instant, no dependency             | Lossy (JPEG), no Sharp quality, limited to browser Canvas |
| Server-side Sharp resize            | Higher quality, format-aware, server can use libvips | Adds Sharp dependency to API, latency on upload           |
| Hybrid (client rough + server fine) | Best quality + fast UX                               | Complexity, two resize paths                              |

**Verdict**: Client-side Canvas is the right first step. Anthropic's docs confirm their API internally resizes to 1568px anyway — client-side pre-resize just avoids paying to transmit and process oversized data. Server-side Sharp can be added later for screenshot tool images (which are generated server-side).

## Provider Token Pricing Reference (April 2026)

| Provider         | Image Token Formula                | Max Dimensions                      | Max per Request |
| ---------------- | ---------------------------------- | ----------------------------------- | --------------- |
| Anthropic Claude | `(width × height) / 750`           | 8000×8000 (2000×2000 if >20 images) | 100 media items |
| OpenAI GPT-4o    | `85 + 170 × tiles` (512×512 tiles) | Resized to fit 1024×1024            | No hard limit   |
| Google Gemini    | ~258 tokens per image (fixed)      | Varies by model                     | Varies          |

**Key insight**: Anthropic's sweet spot is 1568×1568 — images larger than this are resized server-side with no quality benefit. Pre-resizing saves bandwidth, latency, and cost.

## Reference Pattern Catalogue

The patterns below appear consistently across production multimodal coding agents and define the constants, hooks, and recovery flows that this audit benchmarks Tau against.

| Layer      | Pattern                                       | Architectural rationale                                                                                                                                                                                  |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constants  | 5 MB base64, 2000px dim cap, 100 media/req    | Hard limits chosen to stay well under provider 400/413 thresholds (Anthropic accepts up to 8000×8000 but internally resizes to 1568px) so the client never sends bytes the provider will discard         |
| Resize     | Multi-pass quality-ladder compression         | Achieves a target byte budget (≤1 MB) with the highest quality the budget allows; single-pass resize cannot adapt to wildly different source sizes                                                       |
| Token est. | Flat 2000 per image block                     | Avoids `JSON.stringify(base64)` token-counting catastrophe; the flat constant is a vision-aware approximation that is wrong-but-bounded rather than wrong-by-orders-of-magnitude                         |
| Validation | Pre-send base64 size check                    | Fails fast at the API boundary so oversized payloads never reach the provider; produces a human-readable error instead of an opaque 400                                                                  |
| Compaction | Replace images with `[image]` markers         | A summarization model cannot meaningfully compress base64 — strip first, summarize the surrounding text only                                                                                             |
| Storage    | Per-session disk cache, 200-path LRU          | UX feature (file-link refs) for CLI agents; for a web client the equivalent is content-addressable IndexedDB blob storage (see `image-storage-architecture.md`)                                          |
| Media cap  | Drop oldest media past 100 items              | Mirrors the Anthropic per-request media limit; oldest-first eviction keeps the most contextually relevant images                                                                                         |
| MCP        | 1600-token image estimate, compress overflow  | Tool-result images need the same flat-token treatment as user-pasted images, plus an inline compression fallback when a tool returns oversized content                                                   |
| File read  | Token-budgeted image read with compression    | Tools that read images from disk must respect the same token budget as inline pastes — otherwise a single tool call can blow the context window                                                          |
| Recovery   | Reactive compact strip-retry for media errors | When the provider returns a media-related error (413, "too many images"), the agent must strip media and retry rather than surface the raw error to the user — closes the loop on first-attempt failures |

## Appendix: Observed Compaction Loop Analysis

From the production transcript (`initial_design_2026-04-16T07-41.md`):

1. User pastes a PNG image of a Bambu Lab build plate
2. The image is stored as a raw data URL (estimated 1–3 MB base64)
3. Gemini 3.1 Pro processes 5 turns with web search tool calls
4. Context compaction triggers — showing "Before: 1.4M tokens, After: 1.4M tokens, Reduction: 0%"
5. Compaction achieves 0% reduction because the image base64 dominates the token count
6. The conversation was interrupted by user after the compaction loop

**Root cause chain** (all links now broken):

1. ~~Raw base64 → `JSON.stringify` in `estimateMessageTokens` → massively inflated token estimate~~ ✅ Fixed by R1 (resize to ≤1 MB) + R2 (flat 2000-token estimate)
2. ~~Inflated estimate exceeds 85% threshold → compaction triggers~~ ✅ Fixed by R2 (image counts as 2000 tokens, not 125K–750K)
3. ~~Morph receives the full base64 as text → Morph can't meaningfully compress base64~~ ✅ Fixed by R3 (images replaced with `[image]` markers) + R4 (`lastQuery` stripped)
4. ~~Post-compaction estimate still exceeds threshold → re-triggers on next turn~~ ✅ Fixed by R2 + R3 (compacted messages no longer contain base64 data)
5. ~~Emergency compaction retains tail messages which still contain the image → loop continues~~ ✅ Fixed by R10 (emergency `stripImageBlocks` on retained messages)

**Status**: All five links in the compaction loop chain are broken. R1+R2+R3+R4+R10 provide defense-in-depth — any single fix would have been sufficient to break the loop, but all five together ensure robustness against edge cases.

## References

- Plan: `.cursor/plans/image_context_management_44e4e151.plan.md`
- Research: `docs/research/chat-model-cost-forensics.md`
- Policy: `docs/policy/context-engineering-policy.md`
- Policy: `docs/policy/filesystem-context-policy.md`
- External: [Anthropic Vision documentation](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- External: [OpenAI Vision documentation](https://platform.openai.com/docs/guides/vision)
