---
title: 'SharedWorkerGate Startup Performance'
description: 'Comprehensive audit of filesystem startup performance: root cause of blank-screen UX, unimplemented architecture recommendations, IndexedDB pitfalls, and prioritized roadmap to world-class browser FS performance'
status: draft
created: '2026-03-28'
updated: '2026-03-28'
category: optimization
related:
  - docs/research/vscode-fs-performance.md
  - docs/research/large-repo-import-performance.md
  - docs/research/filesystem-architecture.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
  - docs/policy/filesystem-context-policy.md
---

# SharedWorkerGate Startup Performance

Comprehensive audit of filesystem startup performance: root cause of the blank-screen UX on page refresh, cross-referenced with all existing filesystem architecture recommendations, VS Code patterns, and IndexedDB performance research. Produces a unified prioritized roadmap to achieve world-class browser filesystem performance aligned with the vision policy's "files are the interface" principle.

## Executive Summary

On page refresh, users see a blank white screen for 12–16 seconds. The root cause is a cascade: (1) root `FileManagerProvider` at `/` scans the entire virtual filesystem (9517 entries, ~12s) via recursive `getDirectoryStat('/')` with per-entry IDB transactions; (2) `SharedWorkerGate` renders nothing until this completes; (3) project routes can't mount until the gate opens. Beyond this immediate issue, cross-referencing the filesystem-architecture.md roadmap, large-repo-import-performance.md audit, VS Code patterns, and IndexedDB performance research reveals 8 unimplemented or partially implemented recommendations that compound into the current bottleneck. This document consolidates all findings into 18 prioritized recommendations.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Part 1: Startup Waterfall Analysis](#part-1-startup-waterfall-analysis)
- [Part 2: Unimplemented Architecture Recommendations](#part-2-unimplemented-architecture-recommendations)
- [Part 3: IndexedDB Performance Analysis](#part-3-indexeddb-performance-analysis)
- [Part 4: .tau Directory Inflation](#part-4-tau-directory-inflation)
- [Consolidated Recommendations](#consolidated-recommendations)
- [Proposed Architecture](#proposed-architecture)
- [References](#references)

## Problem Statement

When a user navigates to or refreshes a project page (`/projects/:id`), the browser shows a completely blank white screen for 12–16 seconds before any UI appears. This violates the vision policy's core principle that "files are the interface" — if the filesystem is slow, the entire platform is unusable. Console logs reveal:

```
[FileManager] initializeWorkerActor: start +3551ms
[FM-Worker] module evaluated in 638.3ms
[FileManager] worker heartbeat received +981.0ms
[FileManager] getDirectoryStat returned 9517 entries +11851.2ms
[FileManager] initializeWorkerActor: success
[FileManager] initializeWorkerActor: start +15506ms  ← project FM #1
[FileManager] initializeWorkerActor: start +15517ms  ← project FM #2
```

## Methodology

- Analyzed console timing logs from a page refresh on a project with 96 files
- Traced the full `SharedWorkerGate` → `FileManagerProvider` → `file-manager.machine.ts` → `FileService.getDirectoryStat` chain
- Audited every recommendation in `filesystem-architecture.md` (Phases 1–8, Appendix A.2 known issues) against current implementation
- Audited all 12 recommendations from `large-repo-import-performance.md` against current implementation
- Audited all 10 VS Code techniques from `vscode-fs-performance.md` "Applicability to Tau" table
- Researched IndexedDB transaction overhead, batching patterns, structured cloning costs, and browser-specific behaviors
- Reviewed `.tau/` directory structure and its impact on scan count
- Cross-referenced with `filesystem-policy.md` performance budgets and `vision-policy.md` requirements

## Part 1: Startup Waterfall Analysis

### Finding 1: Root `FileManagerProvider` Scans All Projects

The app shell in `root.tsx` mounts `FileManagerProvider rootDirectory='/'`. During initialization, `initializeWorkerActor` calls `proxy.getDirectoryStat('/')`, which recursively walks the entire ZenFS store — every file across all projects in IndexedDB. The root FM exists only to share its worker with nested providers via `SharedWorkerContext`. It does not need a tree scan.

### Finding 2: SharedWorkerGate Renders Nothing During Initialization

`SharedWorkerGate` at `use-file-manager.tsx:86–94` returns `undefined` when `useContext(SharedWorkerContext)` is falsy. No skeleton, no spinner. The gate opens only after `initializeWorkerActor` completes (including the 12-second tree scan), because `context.worker` is assigned by `updateBackendFromInit` which fires on `workerInitialized` — the async actor's completion event.

### Finding 3: Serial Initialization Chain

```
t=0ms      → Page load, Vite HMR connects
t=3551ms   → Root FM starts worker creation
t=3552ms   → Worker created + bridge ready (0.6ms)
t=4532ms   → Worker module evaluated (638ms)
t=15402ms  → getDirectoryStat('/') completes (9517 entries, 11851ms)
t=15402ms  → SharedWorkerGate opens → project routes mount
t=15506ms  → Project FM #1 starts (reuses shared worker)
t=15517ms  → Project FM #2 starts (duplicate)
t=16121ms  → Project FM getDirectoryStat (96 entries, 615ms)
t=~18000ms → First geometry rendered
```

The worker is RPC-ready in 0.6ms. The remaining 11.8s is `getDirectoryStat('/')` — wasted work.

### Finding 4: Duplicate Project FM Initialization

Two project FM inits start at +15506ms and +15517ms. Both serialize on the same worker's `FileService`, adding ~600ms each. This is likely caused by two `FileManagerProvider` instances mounting for the same project route (e.g., main route + preview route mounting simultaneously, or a React re-render).

### Finding 5: IDB Transaction Overhead Dominates First Scan

ZenFS `StoreFS` creates a new `IDBTransaction` for each `stat()` and `readdir()` call. With 9517 entries at ~0.2ms per transaction:

```
9517 entries × 2 IDB transactions × 0.2ms ≈ 3800ms transaction overhead
```

The remaining ~8s comes from recursive directory traversal, inode resolution, and GC pressure.

### Finding 6: InMemoryFileTree is Effective After First Scan

After the first `getDirectoryStat`, `FileService` builds `InMemoryFileTree` and subsequent calls for project-scoped paths use in-memory lookups. The problem is exclusively the first full scan. If scoped to `/projects/:id`, the scan would take ~600ms for 96 entries.

### Finding 7: Worker Creation is Fast — Gate Could Open Earlier

Worker + bridge + proxy creation completes in 0.6ms. The gate is tied to the full async actor completion (including tree scan), not worker availability.

## Part 2: Unimplemented Architecture Recommendations

Cross-referencing `filesystem-architecture.md` phases, `large-repo-import-performance.md` R1–R12, and `vscode-fs-performance.md` techniques against the current implementation:

### Fully Implemented

| Source        | Recommendation                       | Status                                                   |
| ------------- | ------------------------------------ | -------------------------------------------------------- |
| Arch Phase 1  | `readShallowDirectory` worker method | Implemented (`FileService.readShallowDirectory`)         |
| Arch Phase 2  | Debounced background refresh (300ms) | Implemented (`FileTreeService.scheduleRefresh`)          |
| Arch Phase 2  | Incremental refresh (parent-scoped)  | Implemented (`FileTreeService.scheduleRefreshForParent`) |
| Arch Phase 3  | Bounded file cache with LRU          | Implemented (`BoundedFileCache`, 200 entries, 50MB)      |
| Arch Phase 4  | Standalone FS instance caching       | Implemented (`ProviderRegistry._standaloneProviders`)    |
| Arch Phase 5  | `DirectoryTreeCache` class           | Implemented with `InMemoryFileTree` integration          |
| Arch Phase 5  | Write ops invalidate tree cache      | Implemented (every write calls `_treeCache.invalidate`)  |
| LargeRepo R1  | In-memory file tree                  | Implemented (`InMemoryFileTree`)                         |
| LargeRepo R2  | Batched IDB writes                   | Implemented (`BulkImportableStoreFS.bulkImport`)         |
| LargeRepo R4  | Eliminate duplicate workers          | Implemented (`SharedWorkerGate` + `SharedWorkerContext`) |
| LargeRepo R5  | Cap background model creation        | Implemented (`maxBackgroundModels = 200`)                |
| LargeRepo R7  | Per-resource write queue             | Implemented (`ResourceWriteQueue`)                       |
| LargeRepo R9  | Cancellation tokens for FS ops       | Implemented (`AbortSignal` on `getDirectoryStat`)        |
| LargeRepo R11 | Reference-counted models             | Implemented (`acquireModel`/`releaseModel`)              |
| VSCode        | Batched IDB writes                   | Implemented (import worker)                              |
| VSCode        | Per-resource queue                   | Implemented                                              |
| VSCode        | Idle model eviction                  | Implemented (TTL + hard cap)                             |
| VSCode        | Reference-counted models             | Implemented                                              |
| VSCode        | CancellationToken on FS ops          | Implemented                                              |

### Partially Implemented (Gaps Remain)

| Source        | Recommendation                                        | Gap                                                                                                                                                                                                                              |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arch Phase 5  | Push-based `fileTreeChanged` event                    | `proxy.listen('fileChanged')` exists but payload is opaque — not structured incremental diffs. Single event type, not the full VS Code-style multi-event channel                                                                 |
| Arch Phase 6  | Per-directory write serialization wired in production | `ResourceWriteQueue` class exists and is tested, but `file-manager.worker.ts` creates `FileService` **without** injecting it. Production still uses global `WriteCoordinator`                                                    |
| Arch Phase 7  | Worker port lifecycle                                 | `WatchRegistry.cleanupOwner()` exists for watch cleanup, but no heartbeat/timeout detection for stale ports, no explicit `Set<MessagePort>` tracking, no per-port disposal handle from `exposeFileSystem`                        |
| LargeRepo R3  | Gate kernel on FS readiness                           | Structural gating via `SharedWorkerGate` + component tree ordering, but no explicit readiness signal. Import worker writes directly to IDB; timing of `FileService` rescan relative to kernel init is implicit                   |
| LargeRepo R6  | Layered event coalescing                              | Single-layer 300ms debounce + path coalescing to common ancestor. Missing VS Code's full pipeline: 75ms raw aggregation → semantic coalesce (ADD+DELETE → drop) → throttled emission (chunk 100, buffer 10,000) → 500ms UI batch |
| LargeRepo R8  | Limit concurrent WebGL contexts                       | `WebglContextTrackerProvider` exists, but no deferred rendering for non-visible panels                                                                                                                                           |
| LargeRepo R10 | Stream import writes                                  | Import worker uses streaming download but accumulates all extracted files in memory before bulk write. Peak memory is ~2x during extract→write transition                                                                        |

### Not Implemented

| Source        | Recommendation                                | Description                                                                     |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| Arch Phase 7  | Port heartbeat/timeout cleanup                | No mechanism to detect and clean up stale ports                                 |
| Arch Phase 8  | Streaming reads for large files               | No `readFileStream`, no chunked bridge protocol, no size-based routing          |
| Arch 6.2      | Collaborative editing (CRDTs)                 | No `BroadcastChannel` or CRDT code                                              |
| Arch 6.3      | Version history / undo                        | No snapshot or diffing infrastructure                                           |
| Arch 6.5      | Server-side persistence (CloudProvider)       | No cloud provider (architecture supports it)                                    |
| Arch 6.6      | Cross-tab FS (SharedWorker + navigator.locks) | No cross-tab coordination. Current `SharedWorkerContext` is intra-tab only      |
| LargeRepo R12 | Suppress NodeIO browser warnings              | No `WebIO` usage; ~60+ warning lines per session                                |
| VSCode        | `resolveTo` + lazy tree resolution            | `getDirectoryStat` still walks entire subtree on first call. No lazy resolution |
| VSCode        | `DisposableStore` + leak tracker              | Uses XState exit actions; no explicit leak detection infrastructure             |
| VSCode        | Virtual tree + LCS splice                     | Tree rendering approach not assessed for virtualization                         |

## Part 3: IndexedDB Performance Analysis

### Finding 8: Transaction Creation is the Dominant Bottleneck

IDB transaction creation triggers `fsync()` to disk. Benchmarks show:

| Scenario                         | Time     | Per-doc |
| -------------------------------- | -------- | ------- |
| 1,000 docs in 1 transaction      | ~80ms    | 0.08ms  |
| 1,000 docs in 1,000 transactions | ~2,000ms | 2.0ms   |

This is a **25x** difference. Tau's ZenFS backend creates ~2 transactions per `stat()`/`readdir()` call. For 9517 entries, this means ~19,000 IDB transactions — explaining the 12-second scan.

### Finding 9: `getAllKeys()` vs Cursor Iteration

| Operation        | 10,000 items | Ratio |
| ---------------- | ------------ | ----- |
| `getAllKeys()`   | 26ms         | 1x    |
| `getAll()`       | 62ms         | 2.4x  |
| Cursor iteration | 12,168ms     | 468x  |

VS Code uses `getAllKeys()` to build its in-memory tree in one IDB call. ZenFS uses numeric inode IDs as keys (not path strings), so `getAllKeys()` returns opaque numbers — the tree cannot be built from keys alone. Building from ZenFS's `_ids: Map<string, number>` (populated during mount preload) would bypass IDB entirely.

### Finding 10: Read/Write Transaction Contention

IDB enforces strict serialization of `readwrite` transactions per object store. Even `readonly` transactions can be blocked behind pending writes. Multiple concurrent `readwrite` transactions on different stores within the same database do not parallelize (browser implementation limitation).

Implication: the global `WriteCoordinator` is not the only serialization bottleneck — IDB itself serializes at the store level. Per-parent-directory write queues (already implemented in `ResourceWriteQueue` but not wired) would help at the application level, but IDB backend serialization remains.

### Finding 11: Chrome is the Performance Floor

| Browser    | 10K individual inserts | Range query per row |
| ---------- | ---------------------- | ------------------- |
| Chrome     | 19,400ms               | 0.038ms             |
| Firefox    | 2,800ms                | 0.009ms             |
| Safari 17+ | —                      | 0.005ms             |

Chrome's LevelDB backend is 2–7x slower than Firefox for bulk operations. Tau should benchmark on Chrome specifically, as it's the likely performance floor for most users.

### Finding 12: Relaxed Durability Eliminates Transaction Overhead

`durability: 'relaxed'` eliminates `fsync()` wait, reducing the performance difference between batched and unbatched writes from 344% to 7%. Chrome 121+ defaults to `relaxed`, but explicit opt-in ensures cross-browser consistency.

ZenFS's `IndexedDBStore.transaction()` should use `{ durability: 'relaxed' }` explicitly.

### Finding 13: Structured Cloning Cost

Every IDB read/write involves structured cloning. `Uint8Array` gets an optimized path; plain arrays and deeply nested objects are significantly slower. File content should be stored as `Uint8Array` (already the case in ZenFS). Separating metadata from content avoids cloning large blobs during tree operations.

### Finding 14: Key Design Matters

Firefox degrades significantly with keys >500 bytes. ZenFS uses numeric inode IDs (short keys — good). For any future custom IDB layer, keep keys under 50 bytes.

## Part 4: .tau Directory Inflation

### Finding 15: Internal `.tau/` Files Inflate Scan Count

The `.tau/` directory contains internal system state that accumulates over time:

| Subdirectory                           | Growth                          |
| -------------------------------------- | ------------------------------- |
| `.tau/artifacts/{toolCallId}.glb`      | One per geometry fetch per chat |
| `.tau/cache/geometry/*.bin`            | One per unique geometry hash    |
| `.tau/cache/parameters/*.json`         | One per parameter config        |
| `.tau/transcripts/{chatId}.jsonl`      | One per chat session            |
| `.tau/offloaded-tool-results/{id}.txt` | One per large tool result       |
| `.tau/parameters.json`                 | One per project                 |

These files are never needed in the file explorer. The `context-suggestion.utils.ts` already has `isTauInternal` to filter them from chat suggestions, and the kernel worker drops `.tau/cache/**` from dependency tracking. But `FileTreeService`, `getDirectoryStat`, and the explorer have **zero filtering** — all `.tau/` files are scanned, stored in the tree, and rendered.

For a project with several chat sessions, `.tau/` can contribute 20–50+ entries to the scan, including large `.glb` artifacts. Across all projects in the root `/` scan, this compounds significantly.

### Finding 16: VS Code Does Not Scan Recursively on Startup

VS Code's explorer never does a full recursive scan. It uses:

1. **Lazy tree resolution** with `resolveTo` — only paths needed for the current view (expanded tree nodes, open editors) are resolved. A `TernarySearchTree` gates recursion.
2. **Per-folder async loading** — collapsed directories are never resolved. Children load on expand via `getChildren()`.
3. **Single `getAllKeys()` for metadata** — in-memory tree from one IDB call, O(1) subsequent lookups.

Tau's `getDirectoryStat` is a full recursive walk — the opposite of VS Code's lazy approach. The `filesystem-architecture.md` blueprint already proposes lazy loading (Phase 1 `readShallowDirectory` for files route; Phase 5 worker-side incremental cache), but the project editor's tree still uses the full recursive scan.

## Consolidated Recommendations

All recommendations from the startup analysis, architecture audit, and IndexedDB research, unified and prioritized:

### P0 — Critical (Startup Blockers)

| #   | Action                                                                                                                                                                                                                                              | Source            | Effort | Impact                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------------------------------------------- |
| R1  | **Split `initializeWorkerActor` into two phases**: Publish `context.worker` immediately after bridge creation (0.6ms). Run `getDirectoryStat` asynchronously after gate opens. `SharedWorkerGate` opens on worker availability, not tree readiness. | Startup Finding 7 | Medium | Reduces blank screen from 12s to <100ms           |
| R2  | **Skip root `/` tree scan entirely**: Root `FileManagerProvider` should create the worker and bridge only — no `getDirectoryStat('/')`. Project FMs do their own scoped scan.                                                                       | Startup Finding 1 | Medium | Eliminates ~12s wasted work                       |
| R3  | **Add loading skeleton to SharedWorkerGate**: Render a project skeleton instead of `undefined` during any remaining initialization time.                                                                                                            | Startup Finding 2 | Low    | Eliminates blank white screen UX                  |
| R4  | **Wire `ResourceWriteQueue` in production**: `file-manager.worker.ts` should inject `ResourceWriteQueue` into `FileService` instead of relying on global `WriteCoordinator`. The class exists and is tested but not wired.                          | Arch Phase 6      | Low    | Unblocks parallel writes to different directories |

### P1 — High (Performance & Correctness)

| #   | Action                                                                                                                                                                                                                                                                                                                                | Source            | Effort | Impact                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------------------------------------------------- |
| R5  | **Filter `.tau/` from file tree**: Exclude `.tau/` entries from `getDirectoryStat` results and the explorer tree. These are internal system files — no user needs to see artifacts, cache, or transcripts in the file explorer. Keep them accessible via chat @-references (already filtered by `isTauInternal` in suggestion utils). | Finding 15        | Low    | Reduces scan count by 20–50+ entries per project        |
| R6  | **Fix duplicate project FM initialization**: Investigate why two `FileManagerProvider` instances mount for the same project (+15506ms and +15517ms). Eliminate the duplicate.                                                                                                                                                         | Finding 4         | Low    | Saves ~600ms startup time                               |
| R7  | **Build tree from ZenFS `_ids` map**: Replace `_collectDirectoryStatsFromProvider` (which does per-entry IDB transactions) with a single read of ZenFS's in-memory `_ids: Map<string, number>`. All file paths are available without any IDB transactions after mount preload.                                                        | Finding 9, VSCode | Medium | Eliminates O(N) IDB transaction overhead entirely       |
| R8  | **Full event coalescing pipeline**: Add VS Code's multi-stage pipeline: 75ms raw aggregation → semantic coalescing (ADD+DELETE → drop, DELETE+ADD → UPDATE) → throttled emission (chunk 100, buffer 10,000) → 500ms UI batch. Current single-layer 300ms debounce is insufficient for mass operations.                                | LargeRepo R6      | Medium | Prevents UI storms during AI code streaming and imports |
| R9  | **Explicit IDB `relaxed` durability**: Ensure ZenFS's `IndexedDBStore.transaction()` uses `{ durability: 'relaxed' }` explicitly for cross-browser consistency. Chrome 121+ defaults to relaxed, but Firefox and Safari may differ.                                                                                                   | Finding 12        | Low    | Up to 3x improvement in transaction-heavy workloads     |

### P2 — Medium (Architecture Improvements)

| #   | Action                                                                                                                                                                                                                                                                                                  | Source                         | Effort    | Impact                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ | --------------------------------------- |
| R10 | **Lazy tree resolution for project editor**: Adopt VS Code's `resolveTo` pattern for the project editor's file tree. Only resolve paths needed for the current view (expanded nodes + open editors). Load children on expand. This replaces the full recursive `getDirectoryStat` for the project tree. | VSCode Finding 4, Arch Phase 1 | High      | Reduces initial tree from N files to viewport-visible nodes                                                                      |
| R11 | **Structured incremental tree events**: Upgrade `proxy.listen('fileChanged')` from opaque payload to structured diffs: `{ type: 'added'                                                                                                                                                                 | 'deleted'                      | 'renamed' | 'changed', path, ... }`. This enables the main thread to update the tree incrementally without calling `getDirectoryStat` again. | Arch Phase 5 | Medium | Eliminates periodic full-tree refreshes |
| R12 | **Port heartbeat and cleanup**: Add heartbeat detection to `exposeFileSystem`. Track connected ports in `Set<MessagePort>`. Detect stale ports via timeout (no RPC in >60s) and clean up associated watches. Return per-port disposal handles.                                                          | Arch Phase 7                   | Medium    | Prevents resource leaks in long sessions                                                                                         |
| R13 | **Stream ZIP extraction during import**: Currently, the import worker accumulates all extracted files in memory before bulk write (peak memory ~2x). Stream files from JSZip to `BulkImportableStoreFS` as they're extracted, keeping memory bounded.                                                   | LargeRepo R10                  | Medium    | Reduces peak memory during large imports                                                                                         |
| R14 | **Cancel stale `getDirectoryStat` on navigation**: If the user navigates away during initialization, cancel the in-flight scan. Currently stale scans run to completion. The `AbortSignal` support exists but is not wired to navigation changes.                                                       | LargeRepo R9                   | Low       | Saves resources on rapid navigation                                                                                              |

### P3 — Low (Future-Looking)

| #   | Action                                                                                                                                                                                                                                                         | Source        | Effort | Impact                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | -------------------------------------------------------- |
| R15 | **Streaming reads for large files**: Add `readFileStream(path)` with chunked bridge protocol and size-based routing (<1MB → `readFile`, >1MB → stream). Required for future large CAD assemblies (100+ MB).                                                    | Arch Phase 8  | High   | Enables large file handling without main-thread blocking |
| R16 | **Suppress `NodeIO` browser warnings**: Replace `NodeIO` with `WebIO` in browser context, or suppress the ~60+ `fs`/`path` externalization warnings per session.                                                                                               | LargeRepo R12 | Low    | Cleaner console output                                   |
| R17 | **Cross-tab FS coordination**: Use `SharedWorker` or `navigator.locks` for cross-tab filesystem access. Currently each tab creates its own worker. Multiple tabs editing the same project can conflict.                                                        | Arch 6.6      | High   | Enables multi-tab editing without conflicts              |
| R18 | **Consider OPFS for large file content**: OPFS is 3–4x faster than IDB for file-oriented workloads (random reads: 4.3x, sequential: 1.4x). Use IDB for metadata/small files, OPFS for content >100KB. Synchronous `read()`/`write()` available in Web Workers. | IDB Research  | High   | Significant performance improvement for large files      |

## Proposed Architecture

```
Current (serial, ~18s total):

  root.tsx                  SharedWorkerGate blocks here
     │                              │
     ▼                              ▼
┌──────────────┐  ┌──────────────┐  ┌────────────┐
│ Root FM:     │  │ Root FM:     │  │ Project FM: │
│ create worker│─▶│ scan / (12s) │─▶│ scan /id    │─▶ CAD
│ (1ms)        │  │ 9517 entries │  │ (600ms)     │
└──────────────┘  └──────────────┘  └────────────┘

Proposed (parallel, ~4s total):

  root.tsx
     │
     ▼
┌──────────────┐  SharedWorkerGate opens immediately (1ms)
│ Root FM:     │       │
│ create worker│       ▼
│ only (1ms)   │  ┌────────────────┐
└──────────────┘  │ Project FM:    │
                  │ scan /id       │─▶ CAD
                  │ 96 entries     │
                  │ (600ms)        │
                  │ .tau/ filtered │
                  └────────────────┘
```

**Estimated improvement**: 18s → ~4s (3.5s module load + 600ms scoped project scan).

With R7 (build tree from `_ids` map) additionally applied, the 600ms project scan drops to <50ms (in-memory map read, zero IDB transactions), bringing total to ~3.6s.

## IndexedDB Best Practices Summary

For reference, key IDB patterns that should guide any filesystem layer changes:

| Pattern                        | Recommendation                                                     | Tau Status                                                                |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Transaction batching           | Batch all writes into fewest transactions possible; 25x difference | Done (import worker); not done for normal writes                          |
| `getAllKeys()` over cursors    | 200–400x faster than cursor iteration                              | Not directly applicable (ZenFS uses numeric keys); use `_ids` map instead |
| `relaxed` durability           | Eliminates 97% of batched vs unbatched perf difference             | Not explicitly set                                                        |
| `Uint8Array` for binary data   | Fastest structured clone path                                      | Done (ZenFS stores `Uint8Array`)                                          |
| Separate metadata from content | Avoids cloning large blobs during tree ops                         | Partially (ZenFS stores inodes separately from data)                      |
| Short keys (<50 bytes)         | Firefox degrades with >500-byte keys                               | Done (ZenFS uses numeric IDs)                                             |
| In-memory cache for reads      | IDB too slow for synchronous stat/readdir                          | Done (`InMemoryFileTree` after first scan)                                |
| OPFS for large files           | 3–4x faster than IDB for >100KB                                    | Not implemented                                                           |
| Chrome is slowest              | Design for Chrome's 2–7x slower performance floor                  | Benchmarking not formalized                                               |

## References

- VS Code patterns: `docs/research/vscode-fs-performance.md`
- Import performance audit: `docs/research/large-repo-import-performance.md`
- Filesystem architecture blueprint: `docs/research/filesystem-architecture.md`
- Filesystem policy: `docs/policy/filesystem-policy.md`
- Vision policy: `docs/policy/vision-policy.md`
- Filesystem context policy: `docs/policy/filesystem-context-policy.md`
