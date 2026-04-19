---
title: 'Filesystem & Memory Outstanding Items'
description: 'Consolidated reference of all unresolved filesystem and shared-memory recommendations across research docs, de-duplicated and prioritized into a single actionable backlog'
status: active
created: '2026-04-06'
updated: '2026-04-08'
category: audit
related:
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/shared-worker-fs-architecture.md
  - docs/research/shared-worker-gate-startup-performance.md
  - docs/research/filesystem-gap-analysis.md
  - docs/research/filesystem-mount-overlay-architecture.md
  - docs/research/filesystem-runtime-strategy.md
  - docs/policy/filesystem-policy.md
---

# Filesystem & Memory Outstanding Items

Consolidated reference of every unresolved filesystem and shared-memory recommendation across 6 research documents, de-duplicated by root cause, cross-referenced to source documents, and prioritized into a single actionable backlog.

## Executive Summary

The filesystem and shared-memory research portfolio spans 6 documents containing 60+ individual recommendations. A deep codebase audit (April 2026) confirms that the foundational work is complete: ZenFS replaced by `DirectIdbProvider`, `MountTable` routing active, `@taucad/memory` package scaffolded with generic `SharedPool`, runtime protocol carrying **`geometryPoolBuffer`** and **`filePoolBuffer`** (Pool API tidy-up: no string-keyed `sharedPools` map), and cross-tab coordination via `CrossTabCoordinator`. **17 items remain unresolved** after the P0 items (O1, O2) were resolved. O1/O2 adopted a **two-layer transport type architecture** inspired by the Vercel AI SDK pattern: protocol-level types carry a discriminated `GltfContentDelivery` union (`delivery: 'inline' | 'pooled'`), while consumer-facing types always contain resolved content, with `RuntimeClient` acting as the resolution boundary. The geometry SharedPool read path is now fully wired — `cloneGeometryResult` and `extractGltfTransferables` have been removed. This document serves as the single source of truth for outstanding work, replacing the need to scan multiple research docs for open items.

## Methodology

1. Read all 6 filesystem and shared-memory research documents, extracting every recommendation not marked ✅ RESOLVED
2. Validated each claim against the current codebase via targeted source-code exploration
3. De-duplicated overlapping items (e.g., `.tau/` filtering appears in 3 docs)
4. Re-prioritized based on current architecture state and user-facing impact
5. Cross-referenced each item to its source recommendation(s) for traceability

## Outstanding Items

### ~~P0 — Critical~~ ✅ RESOLVED

| #      | Item                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Source                | Effort | Status |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ | ------ |
| ~~O1~~ | ~~**Wire geometry read path through SharedPool via two-layer transport types**~~ | Two-layer transport type architecture implemented: `GltfContentDelivery` discriminated union (`delivery: 'inline' \| 'pooled'`) at protocol layer — pooled variant is **`{ delivery: 'pooled', key }`** only. `RuntimeClient` as resolution boundary using **`client.geometryPool`**. Dispatcher converts `Geometry` → `GeometryTransport` via `toTransportGeometry()`, sending `delivery: 'pooled'` when the geometry pool has the key. `RuntimeClient.resolveTransportResult()` resolves pool references before emitting to subscribers. `extractGltfTransferables` removed. Consumer types widened to `Uint8Array` (bare, accepting both `ArrayBuffer` and `SharedArrayBuffer` backing). | geometry-pipeline R12 | Medium | ✅     |
| ~~O2~~ | ~~**Ensure SharedPool populated on cache hits with per-geometry keys**~~         | `writeToSharedPool` updated to use per-geometry keys `${cacheKey}-${index}`, guarded by `pool.has(key)`. Called on L1/L2 hit paths in addition to fresh compute. `cloneGeometryResult` removed — no longer needed with pool as canonical store and no geometry buffer transfer.                                                                                                                                                                                                                                                                                                                                                                                                             | geometry-pipeline R13 | Low    | ✅     |

### P1 — High

| #   | Item                                        | Description                                                                                                                                                                                                                                                                                                                                     | Source                                                | Effort |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| O3  | **SharedWorkerGate skeleton UI**            | `SharedWorkerGate` in `use-file-manager.tsx` returns `undefined` when no worker is available. No loading skeleton renders during initialization. Users see nothing until init completes. **Fix**: Render a project skeleton component (file tree placeholder, editor placeholder) instead of `undefined`.                                       | startup-perf R3                                       | Low    |
| O4  | **Filter `.tau/` from file explorer tree**  | `.tau/` directory (cache, parameters, transcripts, artifacts) is visible in the file explorer. Kernel excludes `.tau/cache/**` from watches, and chat @-context suggestions filter via `isTauInternal`, but the explorer tree shows all internal files. **Fix**: Add `.tau/` exclusion filter in `FileTreeService` or explorer rendering layer. | startup-perf R5, gap-analysis R7/F7, mount-overlay R3 | Low    |
| O5  | **Mount MemoryProvider at `.tau/cache/`**   | Geometry and parameter cache writes go to the root IndexedDB provider. These are high-frequency binary blobs that are fully regenerable. Mounting an ephemeral `MemoryProvider` at `.tau/cache/` would reduce IDB write amplification and eliminate contention.                                                                                 | mount-overlay R3                                      | Low    |
| O6  | **Fix duplicate project FM initialization** | Console logs showed two `FileManagerProvider` instances mounting for the same project (+15506ms and +15517ms), each serializing on the worker. Root cause not investigated.                                                                                                                                                                     | startup-perf R6                                       | Low    |

### P2 — Medium

| #   | Item                                               | Description                                                                                                                                                                                                                                                                                                                                                                      | Source                 | Effort |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------ |
| O7  | **Complete worker-first gate opening**             | Root FM now does shallow `readDirectory` (fast), but `SharedWorkerGate` still blocks until init completes. Target: gate opens immediately on worker creation (0.6ms), tree scan runs asynchronously after.                                                                                                                                                                       | startup-perf R1        | Medium |
| O8  | **Port heartbeat and cleanup**                     | No mechanism to detect and clean up stale `MessagePort` connections in `exposeFileSystem`. Long sessions can accumulate ports from crashed kernel workers. **Fix**: Add heartbeat detection, track connected ports via `Set<MessagePort>`, detect stale ports via timeout.                                                                                                       | startup-perf R12       | Medium |
| O9  | **Stream ZIP extraction during import**            | Import worker uses streaming download but accumulates all extracted files in memory before bulk write. Peak memory is ~2× during the extract→write transition. **Fix**: Stream files as they're extracted, writing each to IDB immediately.                                                                                                                                      | startup-perf R13       | Medium |
| O10 | **AbortSignal bridge-to-UI propagation**           | `AbortSignal` exists on `FileService` methods (`readFile`, `readFiles`, `readFileStream`, `readDirectory`, `getDirectoryStat`) but is not wired through the bridge protocol to UI callers. Navigation away during a large scan cannot cancel in-flight work from the main thread.                                                                                                | startup-perf R14       | Low    |
| O11 | **Strengthen cross-tab coordination**              | `CrossTabCoordinator` uses `navigator.locks` for per-file exclusive write locks and `BroadcastChannel` for change notifications. Three enhancements remain: (1) tab-death detection via infinitely-open Web Lock (Notion pattern), (2) active-tab **file pool** invalidation on tab death, (3) sequence-numbered `ChangeNotification` messages for BroadcastChannel reliability. | shared-worker-fs R-SW5 | Medium |
| O12 | **Mount isolated DirectIdbProvider at `/git/`**    | Git operations use path prefix `/git/projects/{projectId}` on the same provider as project files. Isolating git storage prevents git operations from inflating the project tree and competing for write coordinator slots.                                                                                                                                                       | mount-overlay R4       | Medium |
| O13 | **Benchmark mount resolution overhead**            | No formal benchmark exists for `MountTable.resolve()` performance. Target: <0.01ms per resolve for ≤6 mounts.                                                                                                                                                                                                                                                                    | mount-overlay R10      | Low    |
| O14 | **Chunked file storage for large CAD files**       | Large binary CAD files (STEP, STL, GLB up to 100 MB) are stored as single IDB values. Chunked storage (4 KB blocks) would enable partial reads without full-file loads, reduce structured cloning overhead, and improve IDB transaction performance for large files.                                                                                                             | gap-analysis R19       | High   |
| O15 | **Dedicated OPFS worker with sync access handles** | `OPFSProvider` exists and is used for `/node_modules/` mount, but OPFS synchronous access handles (`FileSystemSyncAccessHandle`) — which provide 3–4× faster I/O than IDB — are not used for hot-path operations. A dedicated OPFS worker with sync access handles could serve geometry cache reads, parameter reads, and other latency-sensitive operations.                    | gap-analysis R21       | High   |

### P3 — Future / Deferred

| #   | Item                                          | Description                                                                                                                                                                                                              | Source                | Effort |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------ |
| O16 | **`@react-three/offscreen` worker rendering** | Move R3F rendering to a Web Worker via `@react-three/offscreen`. Zero main-thread GLTF parsing and WebGL work. Requires O1 (geometry pool read path) as prerequisite.                                                    | geometry-pipeline R10 | Medium |
| O17 | **OPFS for general large file content**       | `OPFSProvider` implemented and used for `/node_modules/` mount via `MountTable`, but not extended to general large-file content routing (geometry cache, exports, large CAD files).                                      | startup-perf R18      | High   |
| O18 | **CoW overlay for agentic experimentation**   | Design copy-on-write overlay architecture for agentic CAD experimentation — delta layer + whiteouts + origin mapping. Enables the AI agent to make speculative file changes without modifying the user's project.        | gap-analysis R23      | High   |
| O19 | **OverlayProvider for union read-through**    | Design `OverlayProvider` for union read-through semantics (template overlay). Read from upper (project) first, fall back to lower (templates). Needed for organization-wide defaults like skill templates and AGENTS.md. | mount-overlay R9      | High   |

### Not Assessed / Low Priority

| #   | Item                                 | Description                                                                                                                          | Source           |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| O20 | **Suppress NodeIO browser warnings** | ~60+ `fs`/`path` externalization warnings per session from `NodeIO` usage. Replace with `WebIO` or suppress.                         | startup-perf R16 |
| O21 | **SQL-debuggable FS layer**          | Evaluate inode+dentry+chunked-blob schema as future alternative to flat IDB key-value. Complementary to Turso-style SQLite approach. | gap-analysis R24 |

## Dependency Graph

```
✅ O2 ──► ✅ O1 ──► O16
                     │
                     └── O16 depends on completed O1 pool read path

O5 ──► O4  (.tau/cache mount reduces what .tau/ filter excludes)

O15 ──► O17  (OPFS worker enables general large-file OPFS routing)

O14 ──► O15  (chunked storage benefits most with OPFS sync handles)

O7 ──► O3  (worker-first gate + skeleton = instant perceived startup)
```

**O1 and O2 are resolved.** The two-layer transport type architecture is complete. **O16** (`@react-three/offscreen`) is now unblocked — the render worker can read geometry from the SharedPool via the resolved read path.

## Cross-Reference Matrix

Maps each outstanding item to its source recommendation(s) across research documents.

| Item | geometry-pipeline | shared-worker-fs | startup-perf | gap-analysis | mount-overlay |
| ---- | ----------------- | ---------------- | ------------ | ------------ | ------------- |
| O1   | R12               |                  |              |              |               |
| O2   | R13               |                  |              |              |               |
| O3   |                   |                  | R3           |              |               |
| O4   |                   |                  | R5           | R7           | R3 (related)  |
| O5   |                   |                  |              |              | R3            |
| O6   |                   |                  | R6           |              |               |
| O7   |                   |                  | R1           |              |               |
| O8   |                   |                  | R12          |              |               |
| O9   |                   |                  | R13          |              |               |
| O10  |                   |                  | R14          |              |               |
| O11  |                   | R-SW5            |              |              |               |
| O12  |                   |                  |              |              | R4            |
| O13  |                   |                  |              |              | R10           |
| O14  |                   |                  |              | R19          |               |
| O15  |                   |                  |              | R21          |               |
| O16  | R10               |                  |              |              |               |
| O17  |                   |                  | R18          |              |               |
| O18  |                   |                  |              | R23          |               |
| O19  |                   |                  |              |              | R9            |
| O20  |                   |                  | R16          |              |               |
| O21  |                   |                  |              | R24          |               |

## Resolved Items Summary

For completeness, the following items are ✅ RESOLVED across all docs:

| Domain                          | Count  | Key completions                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ZenFS removal**               | 6      | DirectIdbProvider, ZenFS imports removed, runtime migration, workaround code deleted                                                                                                                                                                                                                                                                    |
| **MountTable**                  | 6      | MountTable, FileService integration, `/node_modules/` OPFS mount, readdir merge, event re-prefixing, cross-mount rename                                                                                                                                                                                                                                 |
| **SharedPool / @taucad/memory** | 11     | Package created, SharedPool refactored, LRU eviction, protocol **`geometryPoolBuffer` / `filePoolBuffer`**, worker **`geometryPool`** + dispatcher transport, GLTFLoader patch, SAB guard removal, geometry pool allocation on `RuntimeClient`, FM-owned **`filePool`**, **two-layer transport types (O1)**, **pool populated on all cache paths (O2)** |
| **Tree & performance**          | 8      | Lazy tree loading, structured events, event coalescing, ResourceQueue, relaxed durability, bounded file cache, streaming reads, AbortSignal on FileService                                                                                                                                                                                              |
| **Cross-tab**                   | 3      | CrossTabCoordinator, navigator.locks, BroadcastChannel                                                                                                                                                                                                                                                                                                  |
| **SharedWorker rejection**      | 4      | All R-SW1–R-SW4 recommendations against action followed                                                                                                                                                                                                                                                                                                 |
| **Total**                       | **38** |                                                                                                                                                                                                                                                                                                                                                         |

## Recommended Implementation Order

Based on dependencies, impact, and effort:

```
Sprint 1 ✅ COMPLETE (P0 — fix active crash via two-layer transport types):
  O2 → O1  Pool populated on all cache paths with per-geometry keys,
            then two-layer transport type architecture wired:
            - GltfContentDelivery discriminated union (protocol layer)
            - RuntimeClient resolution boundary (consumer layer)
            - removed cloneGeometryResult + extractGltfTransferables
            - fixes L1 detach crash, achieves zero-copy on cache hit
            - consumer types widened to bare Uint8Array (ArrayBufferLike default)

Sprint 2 (P1 — user-facing quality):
  O3       SharedWorkerGate skeleton
  O4       .tau/ filtering from explorer
  O6       Duplicate FM investigation

Sprint 3 (P2 — infrastructure):
  O5       MemoryProvider mount at .tau/cache/
  O7       Worker-first gate opening
  O8       Port heartbeat cleanup
  O10      AbortSignal bridge propagation
  O11      Cross-tab coordination strengthening

Sprint 4 (P2 — storage):
  O9       Stream ZIP extraction
  O12      Git isolation mount
  O14      Chunked file storage
  O15      Dedicated OPFS worker

Sprint 5+ (P3 — future):
  O16      @react-three/offscreen
  O17-O21  OPFS routing, CoW, overlay, NodeIO, SQL FS
```

## Architecture Decision: Two-Layer Geometry Transport Types

O1 adopts a **two-layer type architecture** for geometry content delivery, inspired by the Vercel AI SDK pattern where tool call resolution happens at a boundary layer before consumers see results.

### Problem

The original plan proposed checking `byteLength === 0` to detect pooled content — a magic value pattern with no type safety, no compiler enforcement, and no discoverability. Consumers would need undocumented knowledge to distinguish "genuinely empty" from "content lives in a pool."

### Design

**Protocol layer** (`runtime-protocol.types.ts`) — explicit, type-safe:

```
GltfContentDelivery (discriminated union)
├── { delivery: 'inline', bytes: Uint8Array<ArrayBuffer> }   ← traditional postMessage
└── { delivery: 'pooled', key: string }                    ← zero-copy geometry SharedPool read (single geometry pool; no `pool` name field)

GeometryGltfTransport = { format: 'gltf', content: GltfContentDelivery }
GeometryTransport = GeometryResponseTransport & { hash: string }
HashedGeometryResultTransport = KernelResult<GeometryTransport[]>
```

**Consumer layer** (`cad.types.ts`) — always resolved, minimal change:

```
GeometryGltf = { format: 'gltf', content: Uint8Array<ArrayBufferLike> }
```

**Resolution boundary** (`RuntimeClient`) — transforms transport → domain:

```
Dispatcher → GeometryTransport → postMessage → RuntimeWorkerClient
  → RuntimeClient.resolveTransportResult() → HashedGeometryResult → consumers
```

### Why two layers

| Concern                | Transport types                             | Consumer types                                        |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------- |
| **Used by**            | Dispatcher, RuntimeWorkerClient, protocol   | cad.machine.ts, GltfMesh, all UI, middleware          |
| **Content model**      | `GltfContentDelivery` discriminated union   | `Uint8Array<ArrayBufferLike>` (always present)        |
| **Delivery mechanism** | Explicit (`delivery: 'inline' \| 'pooled'`) | Transparent (resolved by RuntimeClient)               |
| **Type safety**        | Exhaustive switch on discriminant           | No branching needed                                   |
| **30+ consumer sites** | Not affected                                | Only type-widened (`ArrayBuffer` → `ArrayBufferLike`) |

### Graceful degradation

When no SharedPool is configured, the dispatcher sends `{ delivery: 'inline', bytes }` — traditional ArrayBuffer transfer. The two-layer architecture does not require pools; it preserves both delivery mechanisms as first-class, type-safe alternatives.

### AI SDK analogy

Just as the AI SDK resolves `ToolCallPart` (wire format with tool call IDs) into typed tool results before exposing them to consumers, `RuntimeClient` resolves `GltfContentDelivery` (wire format with pool keys) into `Uint8Array<ArrayBufferLike>` before emitting geometry events. Consumers never see pool references.

## References

- Geometry pipeline architecture: `docs/research/shared-memory-geometry-pipeline.md`
- SharedWorker assessment: `docs/research/shared-worker-fs-architecture.md`
- Startup performance audit: `docs/research/shared-worker-gate-startup-performance.md`
- Filesystem gap analysis: `docs/research/filesystem-gap-analysis.md`
- Mount & overlay architecture: `docs/research/filesystem-mount-overlay-architecture.md`
- Runtime strategy (✅ complete): `docs/research/filesystem-runtime-strategy.md`
- Filesystem policy: `docs/policy/filesystem-policy.md`
