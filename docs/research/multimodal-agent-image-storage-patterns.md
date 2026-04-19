---
title: 'Multimodal Agent Image Storage Patterns'
description: 'Cross-ecosystem analysis of how open-source multi-modal agentic systems store, reference, and manage images — mining Cline, Aider, Open Interpreter, bolt.diy, and LangGraph to identify best practices for Tau.'
status: draft
created: '2026-04-16'
updated: '2026-04-16'
category: comparison
related:
  - docs/research/image-storage-architecture.md
  - docs/research/image-context-management-gap-analysis.md
  - docs/policy/context-engineering-policy.md
---

# Multimodal Agent Image Storage Patterns

Cross-ecosystem comparison of image storage, referencing, and lifecycle management across five open-source multi-modal agentic systems, evaluating architectural patterns applicable to Tau's image storage migration.

## Executive Summary

Every major open-source multi-modal agent surveyed (Cline, Aider, Open Interpreter, bolt.diy, plus published patterns from production CLI coding agents) stores images as **inline base64** in conversation state and re-transmits them on every API call. None implement content-addressable storage, provider Files API integration, or checkpoint externalization. The industry-wide pattern is a simple pipe: paste → base64 → inline in messages → re-send every turn. The only differentiation is **where** the base64 lives between turns (React state, JSON files on disk, IndexedDB, or process memory) and **how aggressively** old images are pruned. Aider's path-based referencing (images stay on disk, re-read and base64-encoded per turn) and Open Interpreter's aggressive N-most-recent image pruning are the two patterns most worth adapting. The LangGraph JS checkpoint layer uses per-channel blob storage in PostgreSQL (`checkpoint_blobs` table) which partially mitigates full-state duplication, but does not externalize image content. Provider Files APIs (Anthropic `file_id`, OpenAI `file_id`) remain unused by all surveyed systems, representing a significant optimization opportunity.

## Methodology

1. Cloned and deep-mined 4 open-source repos via `pnpm repos add --clone`:
   - `repos/cline` (Cline — IDE AI agent, 49.8k stars)
   - `repos/aider` (Aider — CLI AI pair programmer, 42.8k stars)
   - `repos/open-interpreter` (Open Interpreter — multimodal code executor, 57k stars)
   - `repos/bolt.diy` (bolt.diy — browser AI web dev agent, 19k stars)
2. Surveyed published image-pipeline patterns from production CLI coding agents (per-session disk caches, dual-track disk-plus-inline storage, paste-ID indexing, terminal hyperlink UX)
3. Mined `repos/langgraphjs` (already tracked) for checkpoint serialization internals
4. Deployed 4 parallel subagents for source-level exploration with file:line evidence
5. Researched Anthropic Files API, OpenAI Uploads API, and Vercel AI SDK multimodal patterns
6. Cross-referenced findings against Tau's proposed architecture in `docs/research/image-storage-architecture.md`

## Findings

### Finding 1: Universal Inline Base64 — No Agent Externalizes Images

Every surveyed system stores images as inline base64 strings in conversation messages:

| System                | Image storage format                           | Where stored                         | Re-sent per turn?          |
| --------------------- | ---------------------------------------------- | ------------------------------------ | -------------------------- |
| **Cline**             | `source: { type: "base64", media_type, data }` | React state + task JSON files        | Yes (full API history)     |
| **Aider**             | `image_url: { url: "data:...;base64,..." }`    | Disk paths; re-read per turn         | Yes (re-encoded each time) |
| **Open Interpreter**  | `image_url: { url: "data:...;base64,..." }`    | In-memory LMC messages               | Yes (surviving images)     |
| **bolt.diy**          | `FileUIPart { data: <base64> }`                | React state + IndexedDB              | Yes (until context sliced) |
| **CLI coding agents** | `source: { type: "base64", data }`             | Process memory + disk cache          | Yes                        |
| **Tau**               | `file: { url: "data:...;base64,..." }`         | React state + IndexedDB + PostgreSQL | Yes (full history)         |

**Evidence** — `repos/cline/src/core/prompts/responses.ts:351-367`: `formatImagesIntoBlocks` parses data URLs to Anthropic `ImageBlockParam` with inline `base64` source.

**Evidence** — `repos/aider/aider/coders/base_coder.py:817-857`: `get_images_message` reads file bytes, base64-encodes, and builds `image_url` data URLs every call to `format_messages()`.

**Evidence** — `repos/open-interpreter/interpreter/core/llm/utils/convert_to_openai_messages.py:153-213`: Builds `data:image/{ext};base64,...` for `image_url` parts.

**Tau alignment**: Tau follows the universal pattern. No competitive disadvantage here, but no competitive advantage either. The proposed content-addressable architecture (R1–R4 in image-storage-architecture.md) would make Tau the **first** in this cohort to externalize images.

### Finding 2: Aider's Path-Based Referencing — Closest to Content-Addressable

Aider is the only system that **separates image identity from image bytes**:

1. Images are **filesystem paths** in `Coder.abs_fnames` / `abs_read_only_fnames`
2. Base64 encoding happens lazily in `get_images_message()` when building API messages
3. The `/paste` command writes clipboard images to **temp files** and tracks the path
4. Images are never stored as base64 in conversation history — they're re-read from disk

**Evidence** — `repos/aider/aider/commands.py:1278-1326`: `/paste` uses `ImageGrab.grabclipboard()` → `tempfile.mkdtemp()` → writes PNG/JPEG → adds path to `abs_fnames`.

**Evidence** — `repos/aider/aider/coders/base_coder.py:836-840`: On every `format_messages()` call, files are re-read from disk and base64-encoded fresh.

**Tau alignment**: Aider's pattern is conceptually close to R1/R2 (store blobs externally, reference by identity). The key difference: Aider uses **filesystem paths** (fragile, no dedup), while Tau's proposed architecture uses **content hashes** (stable, deduplicated). Aider validates that path-based referencing is viable — users don't notice the indirection.

**Limitation**: No deduplication. Same image pasted twice = two temp files. No content hashing.

### Finding 3: Open Interpreter's N-Most-Recent Image Pruning

Open Interpreter is the only system with **dedicated image lifecycle management** beyond simple context trimming:

1. **Non-OS mode**: Keep **first + last 2 images**, remove middle images when > 3 total
2. **OS mode**: Keep only the **last 2 images** (more aggressive)
3. **Computer-use demo**: `_maybe_filter_to_n_most_recent_images` trims old screenshot tool results

**Evidence** — `repos/open-interpreter/interpreter/core/llm/llm.py:149-166`:

```python
if self.interpreter.os:
    images_to_keep = images[-2:]  # Keep last 2
else:
    images_to_keep = images[:1] + images[-2:]  # Keep first + last 2
```

**Evidence** — `repos/open-interpreter/interpreter/computer_use/loop.py:239-285`: `_maybe_filter_to_n_most_recent_images` — Anthropic's recommended pattern for computer-use screenshot lifecycle.

**Tau alignment**: Tau's `stripExcessMedia(messages, 100)` handles the upper bound but doesn't implement recency-based pruning. Open Interpreter's approach is worth adapting — keeping only the N most recent images while preserving the first (establishes visual context) is a sensible heuristic. This complements R9 in image-storage-architecture.md (cleanup/GC for orphaned images).

### Finding 4: Production CLI Agents Maintain Dual-Track Storage (Disk + Inline)

Production CLI coding agents that target a terminal UI typically maintain **two representations** of every image:

1. **Disk**: Written to a per-session directory (e.g., `<config-dir>/image-cache/<sessionId>/<pasteId>.<ext>`) with restrictive permissions (`0o600`) and an `fsync()`-class durability guarantee on write
2. **Inline**: Full base64 in API message content for the LLM

**Architectural rationale**: The disk cache is **not** an API-cost optimization — the LLM still receives full base64 every turn. Its purpose is **user-facing**:

- The terminal UI surfaces `file://` hyperlinks (via `pathToFileURL(imagePath).href`) so the user can open the original asset in any image viewer
- The agent can reference the disk path in context for follow-up filesystem operations (e.g., "edit this image with command X")
- Pasted images survive across crashes/restarts of the agent process

**Tau alignment**: Tau's proposed IndexedDB blob store (R1) serves the same dual purpose — local display without re-decoding, and future image gallery UI (R8). The dual-track pattern validates that users benefit from a persistent, browseable image store even when the LLM still receives base64. The web equivalent of "open in image viewer" is "render in a gallery panel," and the equivalent of "reference path in agent context" is "reference content hash in agent context."

### Finding 5: LangGraph JS Uses Per-Channel Blob Storage (Not Per-Message)

The `@langchain/langgraph-checkpoint-postgres` package already separates heavy state from checkpoint metadata:

1. **`checkpoints` table**: Stores `channel_versions` (lightweight JSON mapping channel→version)
2. **`checkpoint_blobs` table**: Stores serialized channel state as `BYTEA`, keyed by `(thread_id, checkpoint_ns, channel, version)`
3. Each channel (e.g., `messages`) is serialized once per version via `JsonPlusSerializer.dumpsTyped()`

**Evidence** — `repos/langgraphjs/libs/checkpoint-postgres/src/migrations.ts:23-31`: `checkpoint_blobs` DDL.

**Evidence** — `repos/langgraphjs/libs/checkpoint-postgres/src/index.ts:226-254`: `_dumpBlobs` stores each changed channel's serialized value as a separate blob row.

**Key nuance**: This is **channel-level** dedup, not **image-level** dedup. If the `messages` channel gains one new message (text-only), the entire serialized messages array (including all images) is re-stored as a new blob version. The `DO NOTHING` on conflict helps when the same version is written twice, but doesn't help when messages grow.

**Tau alignment**: This partially mitigates the checkpoint bloat described in image-storage-architecture.md F3, but does not eliminate it. The messages channel still contains full base64 image data. Tau's proposed checkpoint externalization (R4) would replace image blocks with hash pointers **before** channel serialization, reducing the blob size dramatically.

### Finding 6: Cline Stores Full Conversation History as JSON Files

Cline persists conversations to disk as JSON — including all embedded base64 image data:

1. **`api_conversation_history.json`**: Full API message history with Anthropic `ImageBlockParam` blocks
2. **`ui_messages.json`**: UI message history with `images: string[]` (data URLs)

**Evidence** — `repos/cline/src/core/storage/disk.ts:44-47`: `GlobalFileNames.apiConversationHistory` = `'api_conversation_history.json'`.

**Evidence** — `repos/cline/src/shared/ExtensionMessage.ts:118-125`: `ClineMessage` has `images?: string[]` for data URLs.

**Context management**: Cline's `ContextManager` removes **entire message ranges** from the middle of the conversation, including any images in those messages. Character accounting for images uses **base64 string length** (`block.source.data.length`), not vision-token estimates.

**Evidence** — `repos/cline/src/core/context/context-management/ContextManager.ts:1257-1260`: `totalCharCount += block.source.data.length` for image blocks.

**Tau alignment**: Cline's approach is the most wasteful of all surveyed systems — full base64 in JSON files on disk, with no compression, no dedup, and character-based (not token-based) accounting. Tau's vision-aware `IMAGE_TOKEN_ESTIMATE = 2000` (already implemented) is superior. Cline validates the urgency of moving away from inline base64 for persistence.

### Finding 7: bolt.diy Uses Aggressive Context Slicing to Manage Images

bolt.diy handles image lifecycle through **server-side message slicing** rather than image-specific logic:

1. **Build mode**: If `contextOptimization` + `summary` + `messageSliceId`: keep only last 3 messages
2. **Fallback**: Keep only the last message (most aggressive)
3. **Summary generation**: `extractTextContent` pulls only text — images are silently dropped from summaries

**Evidence** — `repos/bolt.diy/app/lib/.server/llm/stream-text.ts:186-193`: `processedMessages = processedMessages.slice(messageSliceId)` or `processedMessages.slice(-1)`.

**Evidence** — `repos/bolt.diy/app/lib/.server/llm/create-summary.ts:97-100`: Only text content extracted for summary prompts.

**Tau alignment**: bolt.diy's slicing is too aggressive for Tau's use case (CAD conversations often reference images from many turns ago). However, the pattern of **extracting text-only for summarization** (already implemented in Tau via `toMorphFormat`) is validated as industry standard.

### Finding 8: No System Uses Provider Files APIs

None of the six surveyed systems use Anthropic's Files API (`file_id`), OpenAI's Uploads API, or any upload-once-reference-many pattern:

| System            | Anthropic Files API | OpenAI Uploads API | Any file_id ref |
| ----------------- | ------------------- | ------------------ | --------------- |
| Cline             | No                  | No                 | No              |
| Aider             | No                  | No                 | No              |
| Open Interpreter  | No                  | No                 | No              |
| bolt.diy          | No                  | No                 | No              |
| CLI coding agents | No                  | N/A                | No              |
| Tau               | No                  | No                 | No              |

This is a significant gap across the entire ecosystem. The Anthropic Files API (beta since April 2025) enables:

- Upload once, reference by `file_id` in subsequent turns
- 30-day retention with access-based refresh
- Eliminates re-transmission of base64 per turn
- Supported on all Claude 3+ models

**Tau alignment**: Implementing provider Files API integration (R5 in image-storage-architecture.md) would make Tau the **first** multi-modal agent to use this optimization, providing a measurable cost and latency advantage.

### Finding 9: Vercel AI SDK v5 Standardizes File Parts (Deprecates experimental_attachments)

The Vercel AI SDK (used by both Tau and bolt.diy) is migrating from `experimental_attachments` to native `file` parts on user messages in v5:

1. **v4**: Images require `experimental_attachments` parameter on `append()`; file parts are filtered during message conversion
2. **v5**: File parts (`type: 'file'`, `url`, `mediaType`) are first-class message parts, rendered in `useChat` directly

**Tau alignment**: Tau already uses the v5 `file` parts pattern (`MyUIMessage.parts[].type === 'file'`), which is forward-compatible. The proposed `img:<hash>` reference scheme (R2) would need a custom resolution step before the AI SDK processes messages, but the part structure is compatible.

### Finding 10: Open Interpreter's Image Compression Loop

Open Interpreter implements a runtime compression loop for oversized images:

**Evidence** — `repos/open-interpreter/interpreter/core/llm/utils/convert_to_openai_messages.py:155-203`:

```python
if shrink_images and sys.getsizeof(str(content)) > 5_000_000:
    # PIL resize loop: up to 10 iterations, targeting < 5 MB
    while sys.getsizeof(str(content)) > 5_000_000:
        img = Image.open(io.BytesIO(base64.b64decode(content)))
        img.thumbnail((img.width // 2, img.height // 2))
        # re-encode and check
```

**Tau alignment**: Tau already implements this pattern more efficiently via client-side Canvas resize (`resizeImageForChat` with quality ladder and dimension cap). Open Interpreter's approach validates the need but uses a less efficient halving loop. Tau's implementation is architecturally superior — resize happens at the source (browser, before network), not at the API layer.

## Storage Strategy Matrix

| Capability                 | CLI coding agents | Cline                 | Aider        | Open Interpreter | bolt.diy      | Tau (current) | Tau (proposed)      |
| -------------------------- | ----------------- | --------------------- | ------------ | ---------------- | ------------- | ------------- | ------------------- |
| Client-side resize         | Sharp (Node)      | No                    | No           | PIL (API layer)  | No            | Canvas API    | Canvas API          |
| External image store       | Disk cache        | No                    | Temp files   | No               | No            | No            | IndexedDB blobs     |
| Content-addressable        | No                | No                    | No           | No               | No            | No            | SHA-256 hash        |
| Reference in messages      | Paste IDs         | Inline                | Paths        | Inline           | Inline        | Inline        | `img:<hash>`        |
| Deduplication              | No                | No                    | No           | No               | No            | No            | Hash-based          |
| Provider Files API         | No                | No                    | No           | No               | No            | No            | Anthropic + OpenAI  |
| Checkpoint externalization | N/A               | N/A                   | N/A          | N/A              | N/A           | No            | Hash pointers       |
| Image token estimation     | Flat 2000         | char length           | OpenAI tiles | No estimation    | No estimation | Flat 2000     | Flat 2000           |
| Image lifecycle pruning    | Compaction strip  | Message range removal | Manual /drop | N-most-recent    | Context slice | 100-media cap | N-most-recent + cap |
| Image gallery UI           | Terminal links    | No                    | No           | No               | No            | No            | Planned (R8)        |

## Recommendations

| #   | Action                                                                                                           | Priority | Effort | Impact | Source finding |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | -------------- |
| R1  | Adopt Aider's path-reference pattern for client-side: images stored as blobs, referenced by hash in messages     | P0       | Medium | High   | F2             |
| R2  | Implement Open Interpreter's N-most-recent image pruning (keep first + last N, strip middle)                     | P1       | Low    | Medium | F3             |
| R3  | Be the first agent to integrate Anthropic Files API (`file_id` references)                                       | P1       | Medium | High   | F8             |
| R4  | Implement checkpoint-level image externalization (hash pointers in serialized messages)                          | P1       | Medium | High   | F5             |
| R5  | Add image gallery UI leveraging IndexedDB blob store (web-equivalent of the dual-track disk-cache pattern in F4) | P2       | Medium | Medium | F4, F6         |
| R6  | Integrate OpenAI Uploads API for `file_id` references                                                            | P2       | Low    | Medium | F8             |
| R7  | Add per-conversation image budget (not just per-request cap) — configurable N-most-recent                        | P2       | Low    | Medium | F3             |

## Trade-offs

| Approach                   | Adopted by           | Pros                                                     | Cons                                              | Tau fit                                               |
| -------------------------- | -------------------- | -------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Inline base64 everywhere   | All surveyed systems | Simple, universal                                        | Wasteful at every layer                           | Current — migrate away                                |
| Disk cache + inline API    | CLI coding agents    | Local file links, user UX                                | Still sends base64 to API                         | **Adapt** — IndexedDB blobs instead of disk           |
| Path-based re-read         | Aider                | No base64 in history                                     | Re-reads disk per turn, no dedup                  | **Adapt** — hash-based, not path-based                |
| N-most-recent pruning      | Open Interpreter     | Simple, effective context management                     | Loses older visual context                        | **Adopt** — complement existing 100-media cap         |
| Context slicing            | bolt.diy             | Aggressive context reduction                             | Too aggressive for CAD conversations              | **Reference** — already surpassed by Tau's compaction |
| Provider Files API         | None (opportunity)   | Eliminates re-transmission, provider-managed retention   | Beta, provider-specific, adds upload step         | **Adopt** — first-mover advantage                     |
| Checkpoint blob separation | LangGraph Postgres   | Reduces per-superstep duplication for unchanged channels | Still stores full messages array including images | **Adapt** — add image-level externalization on top    |

## Diagrams

### Ecosystem Image Storage Comparison

```
                    ┌─────────────────────────────────────────┐
                    │         IMAGE STORAGE SPECTRUM           │
                    │                                         │
    SIMPLE ◄────────┤                                         ├────────► OPTIMAL
                    │                                         │
  All inline        │  Disk cache    Path refs   Hash refs    │  Provider
  base64            │  + inline      + re-read   + blob       │  file_id
                    │                            store        │
  ┌──────────┐      │  ┌──────────┐  ┌────────┐  ┌────────┐  │  ┌────────┐
  │ Cline    │      │  │ CLI      │  │ Aider  │  │ Tau    │  │  │ Tau    │
  │ bolt.diy │      │  │ coding   │  │        │  │(target)│  │  │(future)│
  │ Open Int.│      │  │ agents   │  │        │  │        │  │  │        │
  │ Tau(now) │      │  │          │  │        │  │        │  │  │        │
  └──────────┘      │  └──────────┘  └────────┘  └────────┘  │  └────────┘
                    │                                         │
                    └─────────────────────────────────────────┘
```

### Recommended Migration Path (Phased)

```
Phase 1 (P0)                Phase 2 (P1)              Phase 3 (P2)
─────────────               ──────────────            ──────────────
IndexedDB blob store        Anthropic Files API       OpenAI Uploads API
  + SHA-256 hash              file_id integration       file_id integration
  + img:<hash> refs           Checkpoint hash          Image gallery UI
  + N-most-recent             externalization          Cross-chat reuse
    pruning                   Server image store       Cleanup/GC
```

## Code Examples

### N-Most-Recent Image Pruning (Adapted from Open Interpreter)

```typescript
function pruneImagesToMostRecent(messages: BaseMessage[], maxImages: number = 5): BaseMessage[] {
  const imageIndices: Array<{ msgIdx: number; blockIdx: number }> = [];

  for (let m = 0; m < messages.length; m++) {
    const content = messages[m].content;
    if (!Array.isArray(content)) continue;
    for (let b = 0; b < content.length; b++) {
      if (isImageBlock(content[b])) {
        imageIndices.push({ msgIdx: m, blockIdx: b });
      }
    }
  }

  if (imageIndices.length <= maxImages) return messages;

  // Keep first image (establishes context) + last (maxImages - 1)
  const keepFirst = imageIndices[0];
  const keepLast = imageIndices.slice(-(maxImages - 1));
  const keepSet = new Set([keepFirst, ...keepLast]);
  const removeSet = new Set(imageIndices.filter((idx) => !keepSet.has(idx)));

  return messages.map((msg, mIdx) => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((_, bIdx) => !removeSet.has({ msgIdx: mIdx, blockIdx: bIdx }));
    if (filtered.length === msg.content.length) return msg;
    return new msg.constructor({ ...msg, content: filtered });
  });
}
```

## Appendix: Mined Repo File Index

### Cline (image pipeline)

| File                                                    | Key function                      | Line |
| ------------------------------------------------------- | --------------------------------- | ---- |
| `webview-ui/src/components/chat/ChatTextArea.tsx`       | `handlePaste` (data URL creation) | 824  |
| `src/core/prompts/responses.ts`                         | `formatImagesIntoBlocks`          | 351  |
| `src/core/storage/disk.ts`                              | JSON file persistence             | 44   |
| `src/core/context/context-management/ContextManager.ts` | Image char counting, truncation   | 1257 |
| `src/core/api/transform/openai-format.ts`               | OpenAI `image_url` formatting     | 80   |

### Aider (image pipeline)

| File                         | Key function                            | Line |
| ---------------------------- | --------------------------------------- | ---- |
| `aider/commands.py`          | `/paste` → temp file → abs_fnames       | 1278 |
| `aider/coders/base_coder.py` | `get_images_message` (re-read + base64) | 817  |
| `aider/models.py`            | `token_count_for_image` (tile math)     | 657  |
| `aider/io.py`                | `read_image` (file → base64)            | 435  |

### Open Interpreter (image pipeline)

| File                                                       | Key function                            | Line |
| ---------------------------------------------------------- | --------------------------------------- | ---- |
| `interpreter/core/llm/llm.py`                              | N-most-recent image pruning             | 149  |
| `interpreter/core/llm/utils/convert_to_openai_messages.py` | Compression loop, data URL building     | 153  |
| `interpreter/computer_use/loop.py`                         | `_maybe_filter_to_n_most_recent_images` | 239  |
| `interpreter/terminal_interface/utils/find_image_path.py`  | Path detection from user input          | 5    |

### bolt.diy (image pipeline)

| File                                    | Key function                           | Line     |
| --------------------------------------- | -------------------------------------- | -------- |
| `app/components/chat/BaseChat.tsx`      | `handlePaste`, `handleFileUpload`      | 315, 292 |
| `app/components/chat/Chat.client.tsx`   | `uploadedFiles`, `imageDataList` state | 90       |
| `app/lib/.server/llm/stream-text.ts`    | Context slicing                        | 186      |
| `app/lib/.server/llm/create-summary.ts` | Text-only extraction for summaries     | 97       |

### LangGraph JS (checkpoint internals)

| File                                         | Key function                             | Line |
| -------------------------------------------- | ---------------------------------------- | ---- |
| `libs/checkpoint-postgres/src/migrations.ts` | `checkpoint_blobs` DDL                   | 23   |
| `libs/checkpoint-postgres/src/index.ts`      | `_dumpBlobs` (per-channel serialization) | 226  |
| `libs/checkpoint/src/serde/jsonplus.ts`      | `JsonPlusSerializer` (JSON + reviver)    | 126  |
| `libs/checkpoint-postgres/src/sql.ts`        | Blob join query                          | 62   |

## References

- Related: `docs/research/image-storage-architecture.md`
- Related: `docs/research/image-context-management-gap-analysis.md`
- Policy: `docs/policy/context-engineering-policy.md`
- Source: `repos/cline/` (Cline — cline/cline)
- Source: `repos/aider/` (Aider — Aider-AI/aider)
- Source: `repos/open-interpreter/` (Open Interpreter — OpenInterpreter/open-interpreter)
- Source: `repos/bolt.diy/` (bolt.diy — stackblitz-labs/bolt.diy)
- Source: `repos/langgraphjs/` (LangGraph JS — langchain-ai/langgraphjs)
- External: [Anthropic Files API](https://docs.anthropic.com/en/docs/build-with-claude/files)
- External: [OpenAI Uploads API](https://developers.openai.com/api/reference/resources/uploads)
- External: [LangGraph Checkpoint Bloat](https://azguards.com/distributed-systems/the-checkpoint-bloat-mitigating-write-amplification-in-langgraph-postgres-savers/)
- External: [Vercel AI SDK v5 file parts](https://github.com/vercel/ai/issues/6623)
