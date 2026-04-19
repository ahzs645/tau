---
title: 'Image Storage Architecture'
description: 'Investigation of image storage strategies for LLM chat — comparing Tau inline base64, per-session disk-cache patterns, provider Files APIs, and LangGraph checkpoint externalization to recommend a content-addressable reference architecture.'
status: draft
created: '2026-04-16'
updated: '2026-04-16'
category: architecture
related:
  - docs/research/image-context-management-gap-analysis.md
  - docs/policy/context-engineering-policy.md
  - docs/policy/filesystem-context-policy.md
---

# Image Storage Architecture

Investigation of where and how chat images should be stored, served, and referenced — moving beyond inline base64 to a content-addressable reference architecture that reduces storage bloat, network waste, and checkpoint inflation.

## Executive Summary

Tau currently stores images as inline base64 data URLs at **every layer**: React state (`draftImages[]`), IndexedDB (`Chat.messages`), HTTP POST body (full message history re-sent every turn), LangGraph PostgreSQL checkpoints (serialized per-superstep), and compaction transcripts. A single 800 KB image is duplicated across 4–6 storage locations and re-transmitted on every API call. CLI-style coding agents demonstrate a partial improvement — writing images to a per-session disk cache and referencing them by numeric ID for terminal hyperlinks — but they still send inline base64 to the LLM API on every turn, so the disk cache is a UX feature, not an API-cost optimization. The best-practice architecture for 2026 combines **content-addressable client-side storage** (IndexedDB blob store keyed by SHA-256), **pointer references in messages**, and **provider Files API upload** (Anthropic `file_id`, OpenAI `file_id`) to eliminate re-transmission entirely. This document evaluates five storage strategies, maps Tau's current data flow against each, and recommends a phased migration.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Storage Strategy Comparison](#storage-strategy-comparison)
- [Recommendations](#recommendations)
- [Target Architecture](#target-architecture)
- [Trade-offs](#trade-offs)
- [References](#references)

## Problem Statement

After completing the image context management gap analysis (R1–R11), the compaction loop is resolved. However, the **storage** and **transport** layer remains architecturally wasteful:

1. **IndexedDB bloat**: Every `Chat` object in the `chats` store contains full base64 data URLs inline in `messages[].parts[].url`. A 10-message conversation with 5 images stores ~4 MB of base64 in a single IndexedDB record. Over multiple chats, this degrades browser performance and risks hitting IndexedDB storage quotas.

2. **HTTP re-transmission**: The AI SDK sends the **full `messages[]` array** on every turn via POST to `/v1/chat`. Every image that was ever pasted — even 20 turns ago — is re-transmitted as base64 in the request body. A conversation with 5 images wastes ~4 MB of upload bandwidth per turn.

3. **LangGraph checkpoint inflation**: `PostgresSaver` serializes the full graph state (including `messages` with base64 image content) after every superstep. PostgreSQL's TOAST mechanism splits oversized payloads into ~2 KB chunks, causing write amplification. A 5-image conversation generates ~4 MB per checkpoint × 15 supersteps = ~60 MB of checkpoint data per conversation.

4. **No user-visible image management**: Users cannot see, browse, or manage their pasted images. Once pasted, images become opaque base64 strings trapped inside message JSON. There is no gallery, no disk cache, and no way to reference the same image across multiple chats without re-pasting.

5. **No cross-provider optimization**: Anthropic's Files API (`file_id` references, 30-day retention), OpenAI's Uploads API (`file_id` with `purpose: "vision"`), and Google's Cloud Storage integration all support upload-once-reference-many patterns. Tau sends inline base64 to all providers uniformly, missing significant cost and latency optimization.

## Methodology

1. Surveyed published image-handling patterns in production CLI/desktop coding agents — focusing on disk-cache layout, in-memory indices, eviction, session cleanup, dual representation (disk + inline), input-buffer reference syntax, tool-result image exclusion, and compaction-time image stripping
2. Traced Tau's image lifecycle through 7 layers: `resize-image.ts` → `chat-textarea-types.ts` → `draft.machine.ts` → `use-chat.tsx` → `chat.controller.ts` → LangGraph agent → `PostgresSaver`
3. Analyzed IndexedDB storage schema (`indexeddb-storage.ts`) and Chat type definition (`chat.types.ts`)
4. Researched Anthropic Files API (beta, `anthropic-beta: files-api-2025-04-14`), OpenAI Uploads API, and Google Cloud Storage for Firebase
5. Researched LangGraph checkpoint bloat mitigation via the Pointer State Pattern
6. Reviewed external best-practice references for LLM multimodal image storage (April 2026)

## Findings

### Finding 1: Tau Stores Full Base64 Inline at Every Layer

**Severity**: P1 — Scalability blocker

Tau has no external image storage at any layer. Images flow as inline data URLs through the entire stack:

| Layer                 | Where base64 lives                                         | Duplication              |
| --------------------- | ---------------------------------------------------------- | ------------------------ |
| React state           | `draftImages: string[]` in draft machine context           | 1× per draft             |
| IndexedDB             | `Chat.messages[].parts[].url` and `Chat.draft.parts[].url` | 1× per chat, persisted   |
| HTTP request          | POST `/v1/chat` body contains full `messages[]` array      | 1× per turn (cumulative) |
| LangChain             | `HumanMessage.content[]` with `image_url` blocks           | In-memory on API         |
| LangGraph checkpoint  | `PostgresSaver` serializes full state per superstep        | 1× per graph step        |
| Compaction transcript | JSONL with `[user attached image]` markers (stripped)      | Markers only — resolved  |

**Evidence** — `libs/chat/src/types/chat.types.ts:40-51`:

```typescript
export type Chat = {
  id: string;
  resourceId: string;
  name: string;
  messages: MyUIMessage[]; // Contains full base64 data URLs in file parts
  draft?: MyUIMessage; // Draft also contains full base64
  // ...
};
```

**Evidence** — `apps/ui/app/db/indexeddb-storage.ts:289`:

```typescript
const request = store.put(updatedChat); // Entire Chat with embedded base64
```

### Finding 2: Production CLI Agents Use Per-Session Disk Cache with In-Memory Index

**Severity**: Reference — architectural pattern to adapt

A common pattern in production desktop/CLI coding agents:

1. **Disk storage**: Images written to a per-session directory (e.g., `<config-dir>/image-cache/<sessionId>/<pasteId>.<ext>`) with restrictive permissions (`0o600`)
2. **In-memory index**: `Map<number, string>` maps paste ID → absolute file path (not base64)
3. **LRU eviction**: A bounded cap (e.g., 200 paths) with oldest-first eviction from the in-memory map (files remain on disk)
4. **Session cleanup**: A startup hook removes entire directories belonging to previous sessions
5. **Dual representation**: API calls still embed inline base64; the disk cache exists for terminal hyperlinks and local path references — not for API-cost reduction

**Key insight**: This disk cache exists for **user-facing features** (terminal file links, CLI path references), not for LLM API optimization. The LLM still receives full base64 every turn. The architecture trades upload bandwidth for UX features.

**Limitation**: Numeric paste IDs and per-session directories preclude content-addressable dedup. Identical images pasted twice create two files; nothing is reused across sessions; there is no provider Files API integration to break the per-turn re-transmission cycle.

### Finding 3: LangGraph Checkpoint Bloat Is a Known Production Problem

**Severity**: P1 — Database scaling risk

LangGraph's `PostgresSaver` performs an `INSERT` for every superstep (node execution), storing the **full serialized state** including all messages. When messages contain base64 images:

1. **TOAST activation**: Payloads exceeding ~2 KB trigger PostgreSQL TOAST (out-of-line storage), splitting data into ~2 KB chunks with B-Tree index overhead
2. **Write amplification**: A 15-step graph with 100 KB state generates 1.5 MB per execution; with images this can reach 60+ MB
3. **WAL bloat**: Each TOAST chunk generates independent WAL records, causing replication lag

The **Pointer State Pattern** (documented by Azguards, March 2026) replaces heavy payloads with lightweight pointers (`__ptr__:redis:key`) in the checkpoint, storing actual data in Redis/S3. This reduces per-superstep payload from ~100 KB to ~150 bytes — a 99.8% reduction.

**Tau impact**: With `PostgresSaver.fromConnString(databaseUrl, { schema: 'langgraph' })` and no custom serialization, Tau stores full base64 image data in every checkpoint row. This is currently manageable at low scale but will become a bottleneck as usage grows.

### Finding 4: Provider Files APIs Enable Upload-Once-Reference-Many

**Severity**: P1 — Major optimization opportunity

All three major LLM providers now support file reference patterns:

| Provider  | API              | Reference format                                             | Retention                | Multi-turn reuse |
| --------- | ---------------- | ------------------------------------------------------------ | ------------------------ | ---------------- |
| Anthropic | Files API (beta) | `{ type: "file", source: { type: "file", file_id: "..." } }` | 30 days from last access | Yes              |
| OpenAI    | Uploads API      | `file_id` with `purpose: "vision"`                           | Until deleted (default)  | Yes              |
| Google    | Cloud Storage    | `gs://` URI or inline                                        | Configurable             | Yes              |

**Anthropic Files API** (beta, header `anthropic-beta: files-api-2025-04-14`):

- Upload image once, receive `file_id`
- Reference `file_id` in any subsequent Messages API call
- Accessing resets the 30-day retention timer
- Eliminates re-transmission of base64 on every turn

**Impact for Tau**: A 5-image conversation currently re-sends ~4 MB on every turn. With Files API, the first turn uploads the images (~4 MB) and subsequent turns send only `file_id` references (~200 bytes total). This is a **99.99% reduction** in per-turn upload bandwidth for image-heavy conversations.

### Finding 5: IndexedDB Can Store Blobs Efficiently via Structured Clone

**Severity**: P2 — Client-side optimization

IndexedDB supports the structured clone algorithm, which can store `Blob`, `File`, and `ArrayBuffer` objects natively — far more efficiently than base64 strings:

- A 600 KB JPEG image is ~800 KB as a base64 string (33% overhead from encoding)
- The same image stored as a `Blob` in IndexedDB is 600 KB (no encoding overhead)
- IndexedDB blob storage is backed by the browser's native file system, avoiding JavaScript heap pressure
- Multiple records can reference the same blob via key

**Current Tau pattern**: Full base64 data URLs stored inline in `Chat.messages[]` JSON, inflated by encoding overhead and duplicated per-message.

### Finding 6: Tau Has No Image Gallery or User-Facing Image Management

**Severity**: P2 — UX gap

Users currently have no way to:

- View all images they've pasted across chats
- Delete or replace an image after pasting
- Reuse an image from a previous chat
- See how much storage their images consume
- Download the original full-resolution image (only the resized version exists)

CLI-style coding agents address this partially via the disk-cache pattern from Finding 2: terminal UI surfaces `file://` hyperlinks to the cache, and `[Image #N]` references in the input buffer let users see which images are attached. But none of them ship a true gallery UI, and these textual surfaces translate poorly to a web client.

### Finding 7: HTTP Transport Re-Sends Full History on Every Turn

**Severity**: P1 — Bandwidth waste

The AI SDK's `useChat` sends the complete `messages[]` array on every HTTP POST to `/v1/chat`. With the default transport (`DefaultChatTransport`), this means:

- Turn 1: 1 message (with image) = ~800 KB
- Turn 5: 5 messages (with image in turn 1) = still ~800 KB of image data re-sent
- Turn 20: 20 messages = same image re-sent 20 times

This is independent of LLM token costs — it's pure network waste. The server already has the messages from previous turns (via LangGraph checkpoint), but the AI SDK re-sends everything because it operates statelessly.

**Architecture contrast**: Local CLI/desktop agents run in-process with the user, so re-sending images on every turn costs nothing — the bytes are already in memory and the network hop is to the LLM provider, not to the agent's own backend. Tau's web architecture introduces a second network hop (browser → API server) where every byte of inline base64 is paid twice. This makes the per-turn re-transmission problem fundamentally a web-architecture concern, not an LLM-architecture concern.

## Storage Strategy Comparison

| Strategy                       | Client storage          | API transport                        | Checkpoint storage           | Dedup          | Cross-chat reuse      | Complexity |
| ------------------------------ | ----------------------- | ------------------------------------ | ---------------------------- | -------------- | --------------------- | ---------- |
| **A: Inline base64 (current)** | IndexedDB JSON          | Full base64 every turn               | Full base64 per superstep    | None           | None                  | Trivial    |
| **B: Client blob store**       | IndexedDB blobs by hash | Full base64 every turn               | Full base64 per superstep    | Client-side    | Yes (same hash)       | Low        |
| **C: Server image store**      | Hash refs in messages   | Upload once, hash ref after          | Hash refs in checkpoint      | Full           | Yes                   | Medium     |
| **D: Provider Files API**      | Hash refs in messages   | Upload once, `file_id` after         | `file_id` refs in checkpoint | Provider-level | Yes (within provider) | Medium     |
| **E: Hybrid (B + C + D)**      | IndexedDB blobs by hash | First turn: upload; subsequent: refs | Pointer refs only            | Full           | Yes                   | High       |

### Strategy A: Inline Base64 (Current)

The status quo. Simple but wasteful at scale.

**Pros**: Zero infrastructure, zero complexity, works with all providers
**Cons**: Unbounded storage growth, bandwidth waste, checkpoint bloat, no reuse

### Strategy B: Client-Side Content-Addressable Blob Store

Store images as `Blob` objects in a dedicated IndexedDB object store, keyed by SHA-256 hash. Messages reference images by hash (`img:<hash>`) instead of embedding base64.

**Pros**: Deduplicates identical images, reduces IndexedDB JSON size, no server changes needed
**Cons**: Still sends full base64 to API (must resolve hash → blob → base64 before send), checkpoint still receives base64

### Strategy C: Server-Side Image Store

Upload images to the API server once, store on disk or object storage (S3/R2), reference by content hash. The API resolves hash → image bytes when constructing LLM API calls.

**Pros**: Eliminates re-transmission, enables checkpoint pointer pattern, server-side dedup
**Cons**: Requires server storage infrastructure, adds upload endpoint, increases API surface

### Strategy D: Provider Files API Passthrough

Upload images directly to the LLM provider's Files API, store the returned `file_id` in messages. The API sends `file_id` references instead of base64.

**Pros**: Zero server storage, provider handles retention, optimal for per-provider cost
**Cons**: Provider-specific, requires per-provider upload logic, beta APIs, `file_id` not portable across providers

### Strategy E: Hybrid (Recommended)

Combine B (client blob store for local dedup/UX) + C (server image store for checkpoint optimization) + D (provider Files API for transport optimization where available).

**Pros**: Best-in-class at every layer
**Cons**: Highest implementation complexity, phased rollout needed

## Recommendations

| #   | Action                                                                              | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Client-side content-addressable blob store in IndexedDB                             | P0       | Medium | High   |
| R2  | Message schema migration: `img:<hash>` references instead of inline data URLs       | P0       | Medium | High   |
| R3  | Server-side image upload endpoint (`POST /v1/images`) with content-hash storage     | P1       | Medium | High   |
| R4  | LangGraph checkpoint externalization via image hash pointers                        | P1       | Medium | High   |
| R5  | Anthropic Files API integration for upload-once-reference-many                      | P1       | Medium | High   |
| R6  | OpenAI Uploads API integration                                                      | P2       | Low    | Medium |
| R7  | Server-side image resolution middleware (hash → base64 for non-Files-API providers) | P1       | Low    | High   |
| R8  | Image gallery UI: browseable, deletable, reusable across chats                      | P2       | Medium | Medium |
| R9  | Cleanup/GC for orphaned images (no message references)                              | P2       | Low    | Low    |
| R10 | IndexedDB → blob migration for existing chats (background worker)                   | P2       | Medium | Medium |

### R1: Client-Side Content-Addressable Blob Store

Create a dedicated `images` object store in IndexedDB, keyed by SHA-256 hash of the image binary data. On paste/upload, after `resizeImageForChat()`:

1. Decode the data URL to a `Blob`
2. Compute SHA-256 hash of the blob
3. Store `{ hash, blob, mediaType, width, height, createdAt }` in the `images` store (idempotent — duplicate hashes are no-ops)
4. Return the hash as the image reference

**Why SHA-256**: Content-addressable storage eliminates duplicates automatically. The same screenshot pasted twice produces the same hash. Cross-chat reuse is free.

### R2: Message Schema Migration

Replace inline data URLs in `MyUIMessage.parts[].url` with hash references:

```typescript
// Before
{ type: 'file', url: 'data:image/jpeg;base64,...', mediaType: 'image/jpeg' }

// After
{ type: 'file', url: 'img:sha256-abc123...', mediaType: 'image/jpeg' }
```

The `img:` URI scheme signals that the image must be resolved before display (client) or API submission (server). Resolution is a simple IndexedDB `get(hash)` on the client, or server-side lookup after upload.

### R3: Server-Side Image Upload Endpoint

Add `POST /v1/images` that accepts image binary (or base64), computes SHA-256, and stores in the server's image store (local disk for dev, S3/R2 for production):

```
POST /v1/images
Content-Type: image/jpeg
Body: <binary image data>

Response: { hash: "sha256-abc123...", size: 612345 }
```

The client uploads each unique image hash once. Subsequent turns reference the hash — the server resolves it from its store when constructing LLM API calls.

### R4: LangGraph Checkpoint Externalization

Implement a lightweight middleware or custom `PostgresSaver` subclass that intercepts image content in messages before checkpoint serialization:

1. Before `put()`: Scan `channel_values.messages` for image content blocks
2. Replace image data with hash pointers (`img:sha256-abc123...`)
3. Store the lightweight checkpoint in PostgreSQL
4. On `get_tuple()`: Resolve hash pointers back to image data from the server image store

This is a simplified Pointer State Pattern — instead of Redis, the pointer targets the server's image store which already has the data from R3.

### R5: Anthropic Files API Integration

For Anthropic models, upload images via the Files API and cache the `file_id`:

1. Client uploads image → server stores with hash (R3)
2. Before Anthropic API call, check if hash has a cached `file_id`
3. If not: upload to Files API, cache `file_id` → hash mapping (30-day TTL)
4. Replace `image_url` content blocks with `{ type: "file", source: { type: "file", file_id } }`

This eliminates base64 from the API request entirely for Anthropic calls.

### R7: Server-Side Image Resolution Middleware

A LangChain middleware that runs before the model call, resolving all `img:sha256-...` references to the appropriate format for the target provider:

- **Anthropic with Files API**: `file_id` reference
- **Anthropic without Files API**: Inline base64 from server store
- **OpenAI with Uploads**: `file_id` reference
- **OpenAI without Uploads**: Inline base64
- **Other providers**: Inline base64 (universal fallback)

This middleware is provider-agnostic at the message level — it inspects the resolved model provider and applies the optimal strategy.

## Target Architecture

### Data Flow (After Migration)

```
User paste/upload
    │
    ▼
resizeImageForChat()          ← existing client-side resize
    │
    ▼
SHA-256 hash computation
    │
    ├──► IndexedDB `images` store   ← blob by hash (R1)
    │    (content-addressable)
    │
    ▼
Message part: { url: 'img:<hash>' }  ← reference, not data (R2)
    │
    ├──► IndexedDB `chats` store    ← lightweight JSON, no base64
    │
    ▼
HTTP POST /v1/chat
    │  messages[] with img:<hash> refs
    │
    ├──► POST /v1/images (if new hash)  ← upload once (R3)
    │    server stores blob by hash
    │
    ▼
Image Resolution Middleware (R7)
    │
    ├──► Anthropic: Files API upload → file_id ref (R5)
    ├──► OpenAI: Uploads API → file_id ref (R6)
    └──► Others: hash → base64 from server store (fallback)
    │
    ▼
LLM API call
    │  (file_id refs or resolved base64)
    │
    ▼
LangGraph checkpoint
    │  messages with img:<hash> refs only (R4)
    │  (no base64 in PostgreSQL)
    │
    ▼
PostgreSQL (langgraph schema)
    lightweight JSON, ~150 bytes per image ref
```

### Storage Budget Comparison

| Scenario: 10-turn chat, 5 images @ 800 KB each | Current (inline base64)    | Target (hash refs)                |
| ---------------------------------------------- | -------------------------- | --------------------------------- |
| IndexedDB per chat                             | ~5.3 MB                    | ~50 KB + 4 MB blob store (shared) |
| HTTP upload total (10 turns)                   | ~53 MB (re-sent each turn) | ~4 MB (upload once)               |
| LangGraph checkpoint total (15 supersteps)     | ~80 MB                     | ~75 KB                            |
| PostgreSQL WAL                                 | ~160 MB                    | ~150 KB                           |

## Trade-offs

| Dimension            | Inline base64 (current)                 | Content-addressable refs (proposed)                                                     |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| Simplicity           | Trivial — no infrastructure             | Moderate — blob store, upload endpoint, resolution middleware                           |
| Offline support      | Full — images embedded in messages      | Partial — need blob store populated; server resolution requires connectivity            |
| Provider portability | Universal — all providers accept base64 | Requires per-provider adapter for Files API; base64 fallback always available           |
| Debugging            | Easy — images visible in JSON           | Harder — must resolve hash to see image                                                 |
| Migration            | N/A                                     | Requires background migration of existing chats (R10)                                   |
| Data sovereignty     | All data in user's browser              | Server-side store adds a persistence layer; provider Files API stores on provider infra |

### Why Not `.tau/` Directory Storage?

Storing images in the project's `.tau/` directory was considered but rejected:

1. **Coupling to project scope**: Images belong to chat sessions, not CAD projects. A user might paste a reference image that applies across projects.
2. **Filesystem overhead**: The `.tau/` directory is mounted via the FS worker. Adding image blobs would increase FS worker traffic and complicate the mount table.
3. **User confusion**: Showing image files alongside CAD source files conflates content types. Users expect `.tau/` to contain configuration and metadata, not binary blobs.
4. **No cross-project reuse**: Same image in two projects = two copies in two `.tau/` directories.

The content-addressable blob store in IndexedDB (R1) or a non-project directory (e.g., a global `images` store) avoids all of these issues.

### Why Not a Parent/Non-Project Directory?

A global `~/.tau/images/` directory (outside the project) was considered:

1. **Browser restriction**: Tau runs in the browser. Writing to arbitrary filesystem paths requires the File System Access API or OPFS, both of which have significant UX friction (permission prompts) and cross-browser inconsistency.
2. **IndexedDB is the browser's native blob store**: It already supports structured clone for blobs, has no permission prompts, works cross-browser, and integrates with Tau's existing storage layer.
3. **No benefit over IndexedDB**: Both provide persistent, per-origin storage. IndexedDB is simpler to implement and doesn't require filesystem permission management.

### RPC Image Retrieval (Server-Side Serving)

An RPC-based retrieval capability (e.g., `GET /v1/images/<hash>`) would be needed for:

1. **Server-side LLM API construction**: The image resolution middleware (R7) needs to read image bytes from the server store to construct base64 for non-Files-API providers
2. **Admin/debugging tools**: Viewing conversation images without client access
3. **Cross-device sync**: If a user accesses the same chat from another browser, images must be retrievable from the server

This is naturally provided by R3 (server-side image store) — the upload endpoint doubles as a retrieval endpoint.

### LangGraph Checkpointer: Do We Need to Cache Backend-Side?

**Yes, but only the hash → bytes mapping, not the full message state.**

Currently, LangGraph's `PostgresSaver` stores the entire graph state (including full base64 images) per superstep. With the proposed architecture:

1. The checkpoint stores only `img:<hash>` references (~30 bytes per image)
2. The server image store (R3) serves as the "cache" — it persists image bytes by hash
3. On checkpoint replay (`get_tuple`), image resolution middleware hydrates hash refs back to base64 or `file_id` as needed

This is a simplified Pointer State Pattern without the Redis complexity — the image store is already durable (disk/S3), so no TTL eviction concerns.

## Diagrams

### Current Architecture (Inline Base64)

```
┌──────────────────────────────────────────────────────────────────┐
│                        BROWSER                                   │
│                                                                  │
│  paste → resize → data:image/jpeg;base64,/9j/4AA...             │
│                          │                                       │
│           ┌──────────────┼──────────────┐                        │
│           ▼              ▼              ▼                         │
│     React state    IndexedDB Chat   HTTP POST body               │
│     (draftImages)  (messages.parts)  (full history)              │
│     [800KB string] [800KB per chat]  [800KB × turns]             │
└──────────────────────────────────────────────────────────────────┘
                           │
                    HTTP POST /v1/chat
                    (800KB image × N turns)
                           │
┌──────────────────────────┼───────────────────────────────────────┐
│                        SERVER                                    │
│                          ▼                                       │
│              toBaseMessages() → HumanMessage                     │
│              (image_url block with full base64)                  │
│                          │                                       │
│           ┌──────────────┼──────────────┐                        │
│           ▼              ▼              ▼                         │
│     LLM API call   LangGraph      Compaction                     │
│     (base64)       checkpoint     transcript                     │
│                    (base64 per    ([image] markers)               │
│                     superstep)                                   │
│                    [PostgreSQL]                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Target Architecture (Content-Addressable References)

```
┌──────────────────────────────────────────────────────────────────┐
│                        BROWSER                                   │
│                                                                  │
│  paste → resize → SHA-256 → img:sha256-abc123                   │
│                    │                  │                           │
│                    ▼                  ▼                           │
│           IndexedDB `images`    IndexedDB `chats`                │
│           store (blob by hash)  (messages with refs)             │
│           [600KB blob, deduped] [~30 bytes per ref]              │
│                                       │                          │
│                                HTTP POST /v1/chat                │
│                                (refs only, ~200 bytes)           │
└──────────────────────────────────────────────────────────────────┘
                           │
             ┌─────────────┴──── POST /v1/images (once per hash)
             │                   (600KB upload, one time)
             ▼
┌──────────────────────────────────────────────────────────────────┐
│                        SERVER                                    │
│                          │                                       │
│              Image Store (disk/S3, by hash)                      │
│                          │                                       │
│              Image Resolution Middleware                         │
│              ┌───────────┼───────────┐                           │
│              ▼           ▼           ▼                            │
│         Anthropic    OpenAI     Others                            │
│         file_id      file_id    base64                            │
│         (0 bytes)    (0 bytes)  (from store)                     │
│                          │                                       │
│              LangGraph checkpoint                                │
│              (img:sha256-abc123 refs only)                       │
│              [~30 bytes per image, no TOAST]                     │
└──────────────────────────────────────────────────────────────────┘
```

## Code Examples

### Client-Side Image Store (R1)

```typescript
const IMAGE_STORE_NAME = 'images';

interface StoredImage {
  hash: string; // SHA-256 hex
  blob: Blob; // Binary image data
  mediaType: string; // e.g. 'image/jpeg'
  width: number;
  height: number;
  size: number; // Blob size in bytes
  createdAt: number;
}

async function storeImage(dataUrl: string): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const hash = await computeSha256(blob);

  const db = await getDb();
  const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
  const store = tx.objectStore(IMAGE_STORE_NAME);

  // Idempotent — same hash = no-op
  await store.put({ hash, blob, mediaType: blob.type, size: blob.size, createdAt: Date.now() });

  return `img:${hash}`;
}

async function resolveImage(ref: string): Promise<string> {
  const hash = ref.replace('img:', '');
  const db = await getDb();
  const stored = await db.get(IMAGE_STORE_NAME, hash);
  if (!stored) throw new Error(`Image not found: ${hash}`);
  return blobToDataUrl(stored.blob);
}
```

### Message Reference Format (R2)

```typescript
// In draft.machine.ts buildDraftMessage:
for (const image of images) {
  const ref = await storeImage(image); // Returns 'img:sha256-...'
  parts.push({
    type: 'file',
    url: ref, // Hash reference, not data URL
    mediaType: extractMimeTypeFromDataUrl(image),
  });
}
```

### Image Resolution Middleware (R7)

```typescript
const imageResolutionMiddleware = createMiddleware({
  name: 'ImageResolution',
  async wrapModelCall(request, handler) {
    const resolvedMessages = await Promise.all(
      request.messages.map(async (message) => {
        if (!Array.isArray(message.content)) return message;
        const resolved = await Promise.all(
          message.content.map(async (block) => {
            if (isImageHashRef(block)) {
              return resolveForProvider(block, request.model);
            }
            return block;
          }),
        );
        return new message.constructor({ ...message, content: resolved });
      }),
    );
    return handler({ ...request, messages: resolvedMessages });
  },
});
```

## Reference Patterns from CLI/Desktop Coding Agents

The patterns below appear consistently across production CLI/desktop coding agents. Each row names the pattern, summarizes the architectural intent, and records what Tau should do with it given the web-client constraints from Finding 7.

| Layer                 | Pattern                                                                                         | Tau applicability                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Disk store            | Per-session directory keyed by numeric paste ID, restrictive (`0o600`) permissions              | **Adapt** — use IndexedDB blob store instead of filesystem |
| In-memory index       | `Map<number, string>` paste-ID-to-path lookup; bytes never held in JS heap                      | **Adapt** — use hash-keyed IndexedDB store                 |
| LRU eviction          | Bounded cap (~200 entries) on the in-memory index; evicted entries' files remain on disk        | **Reference** — IndexedDB doesn't need in-memory eviction  |
| Session cleanup       | Startup hook deletes prior-session directories                                                  | **Adapt** — GC orphaned hashes with no message refs (R9)   |
| Dual representation   | Disk copy for UX features + inline base64 to the API                                            | **Skip** — Tau should eliminate inline base64 entirely     |
| Input refs            | `[Image #N]` text tokens in the input buffer                                                    | **Reference** — Tau uses visual chips, not text refs       |
| Tool result exclusion | Image-bearing tool results skip file offload and stay as in-message blocks                      | **Reference** — already implemented in Tau                 |
| Compaction strip      | A dedicated `stripImagesFromMessages` step replaces images with `[image]` markers at compaction | **Reference** — already implemented in Tau                 |

## Appendix: Size Impact Analysis

### Per-Image Storage Cost (800 KB JPEG after resize)

| Storage location                     | Current (base64)                 | Proposed (hash ref) | Reduction |
| ------------------------------------ | -------------------------------- | ------------------- | --------: |
| Data URL string                      | 1,066 KB (33% encoding overhead) | 0 KB                |      100% |
| IndexedDB chat record                | 1,066 KB inline                  | 30 bytes (ref)      |   99.997% |
| IndexedDB blob store                 | N/A                              | 800 KB (one-time)   |         — |
| HTTP POST body (per turn)            | 1,066 KB                         | 30 bytes            |   99.997% |
| LangGraph checkpoint (per superstep) | 1,066 KB                         | 30 bytes            |   99.997% |
| PostgreSQL WAL (per superstep)       | ~2,132 KB (2× for WAL)           | ~60 bytes           |   99.997% |

### 10-Turn Conversation with 5 Images

| Metric                             | Current | Proposed                      |                               Savings |
| ---------------------------------- | ------- | ----------------------------- | ------------------------------------: |
| IndexedDB chat size                | 5.33 MB | 150 bytes + 4 MB blob store   | 1.33 MB net (dedup benefit compounds) |
| Total HTTP upload                  | 53.3 MB | 4 MB (one-time) + 1.5 KB refs |                       49.3 MB (92.5%) |
| LangGraph total checkpoints        | 80 MB   | 750 bytes                     |                               99.999% |
| PostgreSQL disk (inc. WAL + TOAST) | ~160 MB | ~1.5 KB                       |                               99.999% |

## References

- Related: `docs/research/image-context-management-gap-analysis.md`
- Policy: `docs/policy/context-engineering-policy.md`
- External: [Anthropic Files API](https://docs.anthropic.com/en/docs/build-with-claude/files)
- External: [OpenAI Uploads API](https://developers.openai.com/api/reference/resources/uploads)
- External: [The Checkpoint Bloat: Mitigating Write-Amplification in LangGraph Postgres Savers](https://azguards.com/distributed-systems/the-checkpoint-bloat-mitigating-write-amplification-in-langgraph-postgres-savers/)
- External: [Feature: Store images as path references instead of base64](https://github.com/openclaw/openclaw/issues/16358)
- External: [Firebase AI Logic — Cloud Storage for large files](https://firebase.google.com/docs/ai-logic/solutions/cloud-storage)
