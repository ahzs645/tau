---
title: 'Filesystem Gap Analysis'
description: 'Audit of filesystem requirements against post-multi-provider source, identifying 12 gaps plus Turso/AgentFS-derived recommendations for world-class browser FS performance.'
status: active
created: '2026-03-28'
updated: '2026-03-29'
category: audit
related:
  - docs/research/filesystem-architecture.md
  - docs/research/filesystem-runtime-strategy.md
  - docs/research/vscode-fs-performance.md
  - docs/research/shared-worker-gate-startup-performance.md
  - docs/research/large-repo-import-performance.md
  - docs/research/node-vfs-applicability.md
  - docs/research/fs-capabilities.md
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
  - docs/research/turso-fs.md
  - docs/research/shared-worker-fs-architecture.md
---

# Filesystem Gap Analysis

Cross-reference of every filesystem requirement from research documents, architecture blueprints, and policy rules against the current source code after completion of the multi-provider migration plan.

## Executive Summary

The multi-provider plan delivered a clean, native provider layer: `DirectIdbProvider`, `OPFSProvider`, `FileSystemAccessProvider`, and `MemoryProvider` replace ZenFS with direct browser APIs. The storage foundation is solid and well-tested. Subsequent implementation waves (R1–R12, R20, R5/R16–R18/R22, backend wiring fix) resolved all P0 gaps and the vast majority of P1–P2 items. Of the original 12 findings: **10 are RESOLVED**, **1 is DEFERRED** (`.tau/` filtering), and **1 was RESOLVED** (cross-tab coordination). Of 24 total recommendations (R1–R24): **18 COMPLETE**, **1 DEFERRED** (R7), and **5 remain open** (R14 — track `getAllRecords()`; R19 — chunked storage; R21 — dedicated OPFS worker; R23 — CoW overlays; R24 — SQL-debuggable FS).

## Methodology

1. Read all 7 filesystem research documents and the filesystem policy, extracting every numbered finding, recommendation, and rule into a master matrix.
2. Read the multi-provider plan to identify what was explicitly in scope.
3. Searched the source code (`packages/filesystem/`, `apps/ui/app/`, `packages/runtime/`) for evidence of each requirement: grepping for key symbols, reading implementation files, and tracing production wiring paths.
4. Classified each requirement as COMPLETE, PARTIAL, or MISSING based on source-code evidence.

## Findings

### ~~Finding 1: `selectedBackend` Not Wired on Project Creation~~ ✅ RESOLVED

**Severity**: P0 — User-facing feature is broken

**Status**: **RESOLVED** — `selectedBackend` is now passed through `CreateProjectChatOptions.backend` → `createProject()` → `setBuildFileSystemConfig`. The `resolvedBackend` falls back to the cookie default only when no explicit selection is provided. Additionally, the root `FileManagerProvider` is temporarily reconfigured to the `resolvedBackend` before writing project files (ensuring files are persisted to the correct backend), then restored to the previous backend via `try/finally` to maintain normal operation for other flows (e.g., listing all projects). The `backendType` is exposed on `FileManagerContextType` so callers can check the active backend.

**Sources**: Plan Part 6, filesystem-policy Rule 11

### ✅ Finding 2: ZenFS Dead Code Removed

**Severity**: ~~P1 — Stale dependency surface~~ **RESOLVED**

**Sources**: Plan Part 12 (ZenFS removal), filesystem-runtime-strategy.md

**Status**: **RESOLVED** — `apps/ui/app/filesystem/zenfs-config.ts` deleted. All `@zenfs/core` and `@zenfs/dom` imports removed from `apps/ui/` and `packages/runtime/`. No TypeScript/JavaScript import sites remain. Residual references are limited to:

- Root `package.json` still lists `@zenfs/core` and `@zenfs/dom` in dependencies (cleanup deferred — no code imports them)
- Documentation/research docs reference ZenFS historically (correct — they document the migration)
- A few JSDoc comments in `packages/filesystem/` and `libs/` compare to ZenFS for context

### ~~Finding 3: Global Write Serialization Blocks Unrelated Writes~~ ✅ RESOLVED

**Severity**: P0 — Most-recommended performance fix across all research docs

**Status**: **RESOLVED** — Both `WriteCoordinator` (global serializer) and `ResourceWriteQueue` (per-parent-directory, ZenFS artifact) have been replaced by `ResourceQueue` — a VS Code-style per-file-path serialization queue. Same-file writes are serialized (FIFO); different-file writes run in parallel. `file-manager.worker.ts` now constructs `ResourceQueue` and passes it to `FileService`. Additionally, a Throttler write batcher was added to `DirectIdbProvider` that coalesces multiple writes into single IDB transactions with `durability: 'relaxed'`.

**Sources**: filesystem-architecture.md Issue 3 (P0), filesystem-policy Rule 5, shared-worker-gate R4, large-repo R7, vscode-fs-performance F3

### ~~Finding 4: Full Recursive `getDirectoryStat` on Every Tree Refresh~~ ✅ RESOLVED

**Severity**: P0 — Directly impacts startup time and refresh latency

**Status**: **RESOLVED** — `FileTreeService.executeRefresh` now calls `readDirectory` (single-level) instead of recursive `getDirectoryStat`. Initial tree hydration in `initializeWorkerActor` uses `readDirectory` for a single-level root read. Tree expansion is lazy: `loadDirectory` is triggered on-demand when a user expands a folder or when the active file auto-reveal encounters unloaded ancestors. `FileTreeService` exposes `hasChildrenLoaded(path)` for O(1) checks.

**Sources**: filesystem-architecture.md Issue 1 (P0), Issue 4 (P0), Issue 6 (P1), vscode-fs-performance F4, shared-worker-gate F16, large-repo F3, filesystem-policy Rule 1, Rule 29

### ✅ Finding 5: Multi-Stage Event Coalescing — Fully Wired

**Severity**: ~~P1 — Causes excessive tree refreshes during multi-file operations~~ **RESOLVED**

**Sources**: vscode-fs-performance F5, shared-worker-gate R8, large-repo R6, filesystem-policy Rule 21

**Status**: **RESOLVED** — Multi-stage event coalescing is fully wired with distinct windows for each consumption path:

- **Kernel path (75ms)**: `FileService` constructs `WatchRegistry` with `windowMs: 75`, providing fast invalidation for geometry cache and re-render triggers.
- **UI path (500ms)**: `RuntimeFileSystemBridge` wraps `changeEventBus` subscription in an `EventCoalescer` with `windowMs: 500` before fanning out to connected ports, reducing cross-thread event storms for visual-only updates.
- **FileTreeService debounce (100ms)**: Reduced from 300ms to 100ms to provide responsive tree updates after the bridge's 500ms coalescing window delivers batched events.

`EventCoalescer` supports configurable `windowMs` and sliding-window coalescing. `WatchRegistry` passes `windowMs` and `maxQueueDepth` to per-subscription `EventCoalescer` instances. Semantic coalescing (cancel `written→deleted`, collapse `deleted→written` to update, parent-delete suppression) is implemented in `_flush()`.

### ✅ Finding 6: Editor `openFiles` Bounded with LRU Eviction

**Severity**: ~~P1 — Memory grows unbounded in long sessions~~ **RESOLVED**

**Sources**: filesystem-architecture.md Issue 2 (P0), vscode-fs-performance F6/F9, large-repo F4/R5/R11, filesystem-policy Rule 4

**Status**: **RESOLVED** — Editor tabs are now bounded at `MAX_OPEN_FILES = 200`. When a new tab would exceed the cap, LRU eviction removes the least-recently-accessed tab (based on `lastAccessedAt` timestamp on `OpenFile`). Tab access and focus update `lastAccessedAt` for accurate recency tracking.

Additionally, `MonacoModelService` implements reference-counted text models via `acquireModel`/`releaseModel` with `editorHolds: Map<string, number>`, background pool limits (`maxBackgroundModels`), TTL-based eviction (`backgroundModelTtlMs`), and a periodic eviction timer (`evictStaleBackgroundModels`).

### ⏸️ Finding 7: `.tau/` Directory Filtering from File Tree — Deferred

**Severity**: ~~P1~~ **DEFERRED** — Will be assessed via alternative ignore mechanisms (e.g. `.gitignore`)

**Sources**: shared-worker-gate R5 (P1), filesystem-policy Rule 26

The `.tau/` directory (cache, parameters, metadata) is not filtered from the file explorer tree. Kernel code excludes `.tau/cache/**` from its watch set, but the UI tree shows these internal files to the user. Deferred — the extra directories are acceptable for now and will be assessed via alternative ignore mechanisms like `.gitignore` integration.

### ✅ Finding 8: `FileSystemObserver` Bridge Implemented

**Severity**: ~~P2 — Important for File System Access mode~~ **RESOLVED**

**Sources**: filesystem-policy Rule 25, shared-worker-gate R11

**Status**: **RESOLVED** — `FileSystemObserverBridge` implements the `FileSystemObserver` API (Chrome 133+ stable) for detecting external filesystem changes. The bridge maps Chrome observer records to Tau `ChangeEvent` types (`fileWritten`, `fileDeleted`, `fileRenamed`), supports recursive directory observation, and disables polling when the observer is active. Exported from `@taucad/filesystem` as `FileSystemObserverBridge` and `isFileSystemObserverSupported`. Falls back gracefully in browsers without `FileSystemObserver` support.

### ✅ Finding 9: AbortSignal Extended to Core FS Operations

**Severity**: ~~P2 — Matters for large repos and navigation-heavy workflows~~ **RESOLVED**

**Sources**: large-repo R9, vscode-fs-performance F10, shared-worker-gate R14, filesystem-policy Rule 10

**Status**: **RESOLVED** — `AbortSignal` support now extends to all core read operations:

| Method             | Signal support                                                  |
| ------------------ | --------------------------------------------------------------- |
| `readFile`         | `{ signal?: AbortSignal }` on options form                      |
| `readFiles`        | `{ signal?: AbortSignal }` — checked between parallel reads     |
| `readFileStream`   | `FileReadStreamOptions.signal` — pre-abort + passed to provider |
| `readDirectory`    | `{ signal?: AbortSignal }` — early abort check                  |
| `getDirectoryStat` | `{ signal?: AbortSignal }` — propagated through recursive walk  |

Navigating away from a project during a large scan can now abort in-flight work.

### ✅ Finding 10: Streaming Reads Implemented

**Severity**: ~~P3 — Future optimization~~ **RESOLVED**

**Sources**: shared-worker-gate R15 (P3), filesystem-policy Rule 4, fs-capabilities Rec 5

**Status**: **RESOLVED** — `readFileStream` added to the `FilesystemProvider` contract (`FileReadStreamOptions`: `position?`, `length?`, `signal?`) and implemented on `FileService`. The `FileSystemAccessProvider` implements native streaming via `getFile().stream()`. Other providers fall back to `bufferToStream` (reads full file, wraps in `ReadableStream`). Supports `AbortSignal` cancellation and capability routing.

### ✅ Finding 11: `packages/runtime` ZenFS Migration Complete

**Severity**: ~~P2 — Outside multi-provider scope, but a remaining dependency~~ **RESOLVED**

**Sources**: filesystem-runtime-strategy.md Phase 2

**Status**: **RESOLVED** — `@zenfs/core` and `@zenfs/dom` removed from `packages/runtime/package.json`. Test utilities (`kernel-testing.utils.ts`) use `fromMemoryFS` + `createBridgePort` instead of ZenFS. `filesystem-constructors.test.ts` tests `fromMemoryFS` only. Kernel workers use MEMFS + bridge as recommended by the runtime strategy doc.

### ✅ Finding 12: Cross-Tab Filesystem Coordination

**Severity**: P3 — ~~Edge case for production reliability~~ **RESOLVED**

**Sources**: shared-worker-gate R17 (P3)

~~No `SharedWorker` or `navigator.locks` coordination exists for concurrent tab access to the same IDB/OPFS data.~~ **RESOLVED** — `CrossTabCoordinator` (R12) implements per-file exclusive write locks via `navigator.locks` and change notifications via `BroadcastChannel`. SharedWorker was evaluated as an alternative and rejected — see `docs/research/shared-worker-fs-architecture.md` for the full assessment. Key reasons: `SharedArrayBuffer` inaccessible from SharedWorkers (breaks R20), `FileSystemSyncAccessHandle` restricted to dedicated Workers (blocks R21), no Android Chrome support, and lifecycle fragility. The current `navigator.locks` + `BroadcastChannel` approach matches VS Code's architectural choice.

## Requirements Coverage Matrix

| Requirement Source          | ID         | Description                                              | Status                                                                                                                        |
| --------------------------- | ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| filesystem-architecture     | Issue 1    | Full recursive `getDirectoryStat` on every mutation      | ✅ ~~**MISSING**~~ **COMPLETE** (P0-3)                                                                                        |
| filesystem-architecture     | Issue 2    | Unbounded `openFiles` Map                                | ✅ **COMPLETE** (Finding 6 — `MAX_OPEN_FILES = 200` LRU eviction + Monaco ref-counting with background pool limits)           |
| filesystem-architecture     | Issue 3    | Global write queue blocks unrelated writes               | ✅ ~~**MISSING**~~ **COMPLETE** (ResourceQueue)                                                                               |
| filesystem-architecture     | Issue 4    | Files route loads full recursive tree                    | ✅ **COMPLETE** (`readShallowDirectory`)                                                                                      |
| filesystem-architecture     | Issue 5    | Standalone FS per call, not cached                       | ✅ **COMPLETE** (registry caching)                                                                                            |
| filesystem-architecture     | Issue 6    | Duplicate `getDirectoryStat` paths                       | 🚧 **PARTIAL** (in-memory tree mitigates)                                                                                     |
| filesystem-architecture     | Issue 7    | No debounce on background refresh                        | ✅ **COMPLETE** (multi-stage coalescing: 75ms kernel, 500ms UI bridge, 100ms tree debounce)                                   |
| filesystem-architecture     | Issue 8    | Ports accumulate, not closed                             | ✅ **COMPLETE** (bridge cleanup)                                                                                              |
| filesystem-architecture     | Issue 9    | IDB open/close per op                                    | ✅ **COMPLETE** (DirectIdbProvider keeps connection)                                                                          |
| filesystem-architecture     | Issue 10   | `serializedQueueDepth` dead code                         | ✅ **COMPLETE** (removed)                                                                                                     |
| filesystem-architecture     | Issue 11   | Misleading `ensureReady` backend arg                     | ✅ **COMPLETE** (new registry API)                                                                                            |
| filesystem-runtime-strategy | Exec. rec. | Replace ZenFS IDB with direct IDB + OPFS                 | ✅ **COMPLETE**                                                                                                               |
| vscode-fs-performance       | F1         | In-memory tree from `getAllKeys`                         | ✅ **COMPLETE**                                                                                                               |
| vscode-fs-performance       | F2         | Batched IDB writes                                       | ✅ **COMPLETE** (relaxed durability + Throttler write batcher)                                                                |
| vscode-fs-performance       | F3         | Per-URI write queue                                      | ✅ ~~**MISSING**~~ **COMPLETE** (ResourceQueue)                                                                               |
| vscode-fs-performance       | F4         | Lazy `resolveTo` tree                                    | ✅ ~~**MISSING**~~ **COMPLETE** (P0-3 lazy loading)                                                                           |
| vscode-fs-performance       | F5         | Multi-stage event coalescing                             | ✅ **COMPLETE** (Finding 5 — 75ms kernel via WatchRegistry, 500ms UI via bridge EventCoalescer, 100ms tree debounce)          |
| vscode-fs-performance       | F6         | Idle model eviction                                      | ✅ **COMPLETE** (Monaco background eviction with `maxBackgroundModels` + TTL; editor tabs bounded at 200 with LRU)            |
| vscode-fs-performance       | F7         | Disposable leak tracking                                 | 🚧 **PARTIAL** (XState cleanup only)                                                                                          |
| vscode-fs-performance       | F8         | Virtualized explorer tree                                | 🚧 **PARTIAL** (tree data exists; no virtual DOM — explorer uses `@headless-tree`, not virtualized)                           |
| vscode-fs-performance       | F9         | Reference-counted text models                            | ✅ ~~**MISSING**~~ **COMPLETE** (`MonacoModelService` `acquireModel`/`releaseModel` with `editorHolds` ref-counting)          |
| vscode-fs-performance       | F10        | Cancellation tokens on FS I/O                            | ✅ **COMPLETE** (Finding 9 — `AbortSignal` on `readFile`, `readFiles`, `readFileStream`, `readDirectory`, `getDirectoryStat`) |
| shared-worker-gate          | R1         | Split init: worker ready before tree scan                | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R2         | No root `getDirectoryStat('/')`                          | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R3         | Skeleton UI in gate                                      | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R4         | Wire `ResourceWriteQueue` in production                  | ✅ ~~**MISSING**~~ **COMPLETE** (ResourceQueue)                                                                               |
| shared-worker-gate          | R5         | Filter `.tau/` from explorer                             | ⏸️ **DEFERRED** (Finding 7 — will assess via `.gitignore` integration)                                                        |
| shared-worker-gate          | R7         | Build tree from `getAllKeys`                             | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R8         | Multi-stage event coalescing                             | ✅ **COMPLETE** (Finding 5 — multi-stage wiring complete: 75ms/500ms/100ms)                                                   |
| shared-worker-gate          | R9         | Relaxed IDB durability                                   | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R10        | Lazy `resolveTo` tree                                    | ✅ ~~**MISSING**~~ **COMPLETE** (P0-3 lazy loading)                                                                           |
| shared-worker-gate          | R11        | Structured incremental events                            | ✅ **COMPLETE** (`FileSystemObserverBridge` implemented; disables polling when observer active)                               |
| shared-worker-gate          | R12        | Port lifecycle cleanup                                   | ✅ **COMPLETE**                                                                                                               |
| shared-worker-gate          | R14        | Cancel in-flight `getDirectoryStat`                      | ✅ **COMPLETE** (Finding 9 — `AbortSignal` on all core read operations)                                                       |
| shared-worker-gate          | R15        | Streaming reads for large files                          | ✅ **COMPLETE** (Finding 10 — `readFileStream` on `FileService` + `FileSystemAccessProvider`)                                 |
| shared-worker-gate          | R17        | Cross-tab FS coordination                                | ✅ **COMPLETE** (R12 — `navigator.locks` + `BroadcastChannel`; SharedWorker rejected per `shared-worker-fs-architecture.md`)  |
| shared-worker-gate          | R18        | OPFS for large file content                              | ✅ **COMPLETE** (OPFSProvider)                                                                                                |
| large-repo                  | R1         | In-memory tree from keys                                 | ✅ **COMPLETE**                                                                                                               |
| large-repo                  | R2         | Batched IDB writes                                       | ✅ **COMPLETE**                                                                                                               |
| large-repo                  | R5         | Cap background Monaco models                             | ✅ ~~**MISSING**~~ **COMPLETE** (`maxBackgroundModels` + `backgroundModelTtlMs` eviction timer)                               |
| large-repo                  | R6         | Layered event coalescing                                 | ✅ **COMPLETE** (Finding 5 — multi-stage coalescing fully wired)                                                              |
| large-repo                  | R7         | Per-resource write queue                                 | ✅ ~~**MISSING**~~ **COMPLETE** (ResourceQueue)                                                                               |
| large-repo                  | R9         | Cancellation tokens                                      | ✅ **COMPLETE** (Finding 9 — `AbortSignal` on core read operations)                                                           |
| large-repo                  | R11        | Reference-counted models                                 | ✅ ~~**MISSING**~~ **COMPLETE** (`MonacoModelService` acquire/release)                                                        |
| fs-capabilities             | Rec 1      | Transfer list on bridge                                  | ✅ **COMPLETE** (`extractTransferables` used on both request and response paths in `runtime-filesystem-bridge.ts`)            |
| fs-capabilities             | Rec 2      | Batch methods on RuntimeFileSystem                       | ✅ **COMPLETE**                                                                                                               |
| fs-capabilities             | Rec 5      | SAB for sync WASM                                        | ❌ **DEFERRED** (future)                                                                                                      |
| fs-capabilities             | Rec 6      | CopyOnWrite for overlays                                 | ❌ **DEFERRED** (future)                                                                                                      |
| filesystem-policy           | Rule 1     | Shallow reads by default                                 | ✅ ~~**MISSING**~~ **COMPLETE** (P0-3 lazy loading)                                                                           |
| filesystem-policy           | Rule 4     | Size-aware reads; streaming for large files              | ✅ **COMPLETE** (Finding 10 — `readFileStream` with `FileReadStreamOptions`)                                                  |
| filesystem-policy           | Rule 5     | Per-parent write granularity                             | ✅ ~~**MISSING**~~ **COMPLETE** (ResourceQueue — per-file, exceeding per-parent)                                              |
| filesystem-policy           | Rule 10    | Failed expand: retry, don't cache failure                | 🚧 **PARTIAL** (no retry logic; failures logged but not cached)                                                               |
| filesystem-policy           | Rule 21    | Normalize → coalesce → filter → deliver                  | ✅ **COMPLETE** (Finding 5 — full pipeline: normalize → coalesce (75ms/500ms) → filter → deliver)                             |
| filesystem-policy           | Rule 25    | `FileSystemObserver` for external changes                | ✅ **COMPLETE** (Finding 8 — `FileSystemObserverBridge` with graceful fallback)                                               |
| filesystem-policy           | Rule 26    | Exclude `.tau/cache/**` from churn                       | ⏸️ **DEFERRED** (Finding 7 — kernel excludes from watch set; UI tree filtering deferred)                                      |
| filesystem-policy           | Rule 29    | Post-startup updates incremental                         | ✅ ~~**MISSING**~~ **COMPLETE** (P0-3 lazy loading)                                                                           |
| node-vfs                    | R1–R5      | Track `node:vfs`, prototype, tests, Electron, Deno       | ❌ **DEFERRED** (P2–P3, correctly)                                                                                            |
| turso-fs                    | T1         | Shared `WebAssembly.Memory` for FS bridge zero-copy      | ✅ **COMPLETE** (R20 — `SharedArrayBuffer`-based `SharedContentPool` eliminates IPC for cached reads)                         |
| turso-fs                    | T2         | Dedicated OPFS worker with sync access handles           | ❌ **MISSING** (R21)                                                                                                          |
| turso-fs                    | T3         | Chunked file storage for large binary CAD files          | ❌ **MISSING** (R19)                                                                                                          |
| turso-fs                    | T4         | Increase `BoundedFileCache` size (200 entries → dynamic) | ✅ **COMPLETE** (R16 — 500 entries, 128 MB `maxTotalBytes`)                                                                   |
| turso-fs                    | T5         | `readdirPlus` joined queries in `DirectIdbProvider`      | ✅ **COMPLETE** (R17 — `readdirWithStats` on all providers)                                                                   |
| turso-fs                    | T6         | Path resolution LRU dentry cache                         | ✅ **COMPLETE** (R22 — 10K-entry LRU handle cache in `FileSystemAccessProvider`)                                              |
| turso-fs                    | T8         | RAM-first ephemeral data policy                          | ✅ **COMPLETE** (R18 — `MountTable` with OPFS-backed `/node_modules/` mount)                                                  |
| turso-fs                    | T9         | CoW overlay for agentic CAD experimentation              | ❌ **DEFERRED** (P3, confirms fs-capabilities Rec 6)                                                                          |
| turso-fs                    | T10        | SQL-debuggable FS layer evaluation                       | ❌ **DEFERRED** (P3)                                                                                                          |

## Recommendations

| #         | Action                                                                                                                                                                        | Priority | Effort     | Impact     | Findings        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- | --------------- |
| ✅ ~~R1~~ | ~~Wire `selectedBackend` through `createProject` to `setBuildFileSystemConfig`~~                                                                                              | ~~P0~~   | ~~Low~~    | ~~High~~   | ~~F1~~          |
| ✅ ~~R2~~ | ~~Replace global `WriteCoordinator` with VS Code-style `ResourceQueue` (per-file serialization) + Throttler write batcher~~                                                   | ~~P0~~   | ~~Low~~    | ~~High~~   | ~~F3~~          |
| ✅ ~~R3~~ | ~~Replace recursive `getDirectoryStat` in `FileTreeService` with lazy, expand-driven loading~~                                                                                | ~~P0~~   | ~~High~~   | ~~High~~   | ~~F4~~          |
| ✅ R4     | ~~Delete `apps/ui/app/filesystem/zenfs-config.ts` and remaining ZenFS imports/comments~~                                                                                      | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F2~~          |
| ✅ R5     | ~~Implement multi-stage event coalescing (75ms kernel → 500ms UI tree)~~ (WatchRegistry 75ms + bridge EventCoalescer 500ms + FileTreeService 100ms)                           | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F5~~          |
| ✅ R6     | ~~Bound editor `openFiles` with LRU eviction~~ (`MAX_OPEN_FILES = 200`, `lastAccessedAt` LRU eviction)                                                                        | ~~P1~~   | ~~Medium~~ | ~~Medium~~ | ~~F6~~          |
| ⏸️ R7     | ~~Filter `.tau/` from file explorer tree~~ — deferred; will assess via `.gitignore` integration                                                                               | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F7~~          |
| ✅ R8     | ~~Implement `FileSystemObserver` for File System Access API external changes~~ (`FileSystemObserverBridge`)                                                                   | ~~P2~~   | ~~Medium~~ | ~~Medium~~ | ~~F8~~          |
| ✅ R9     | ~~Extend `AbortSignal` to individual FS operations~~ (`readFile`, `readFiles`, `readFileStream`, `readDirectory`, `getDirectoryStat`)                                         | ~~P2~~   | ~~Medium~~ | ~~Low~~    | ~~F9~~          |
| ✅ R10    | ~~Migrate `packages/runtime` off `@zenfs/core`/`@zenfs/dom`~~ (uses `fromMemoryFS` + bridge)                                                                                  | ~~P2~~   | ~~High~~   | ~~Low~~    | ~~F11~~         |
| ✅ R11    | ~~Add `readFileStream` to `FileSystemProvider` contract for large file reads~~ (native streaming on `FileSystemAccessProvider`)                                               | ~~P3~~   | ~~Medium~~ | ~~Low~~    | ~~F10~~         |
| ✅ R12    | `CrossTabCoordinator` — per-file `navigator.locks` write serialization + `BroadcastChannel` change notifications                                                              | P3       | High       | Low        | F12             |
| ✅ R16    | ~~Increase `BoundedFileCache` size for desktop browsers~~ (500 entries, 128 MB `maxTotalBytes`)                                                                               | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~turso-fs T4~~ |
| ✅ R17    | ~~Add `readdirWithStats` to `FileSystemProvider`~~ (implemented on `DirectIdbProvider` with `_fileSizes` cache, `FileSystemAccessProvider` via `entries()`, `MemoryProvider`) | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~turso-fs T5~~ |
| ✅ R18    | ~~RAM-first policy for ephemeral data~~ — `MountTable` with OPFS-backed `/node_modules/` mount, cross-mount rename, readdir merge                                             | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~turso-fs T8~~ |
| ❌ R19    | Implement chunked file storage (4 KB blocks) for large binary CAD files, enabling partial reads without full-file loads                                                       | P2       | High       | Medium     | turso-fs T3     |
| ✅ R20    | `SharedArrayBuffer`-based `SharedContentPool` — zero-IPC cached reads across all threads (main, FM worker, kernel workers)                                                    | P2       | High       | High       | turso-fs T1     |
| ❌ R21    | Dedicated OPFS worker with sync access handles for hot-path file operations, separate from IDB-based file manager                                                             | P2       | High       | High       | turso-fs T2     |
| ✅ R22    | ~~Path resolution caching (LRU dentry cache)~~ — 10K-entry LRU handle cache in `FileSystemAccessProvider._resolveDirectoryHandle` with prefix invalidation                    | ~~P2~~   | ~~Low~~    | ~~Medium~~ | ~~turso-fs T6~~ |
| ❌ R23    | Design CoW overlay architecture for agentic CAD experimentation — delta layer + whiteouts + origin mapping                                                                    | P3       | High       | High       | turso-fs T9     |
| ❌ R24    | Evaluate SQL-debuggable FS layer (inode+dentry+chunked-blob schema) as future alternative to flat IDB key-value                                                               | P3       | High       | Medium     | turso-fs T10    |

## March 2026 Browser Filesystem Landscape Review

A supplementary investigation conducted March 2026 to validate the P0 fix plan against bleeding-edge browser filesystem practices, agentic system patterns, and recent API changes. The goal: identify any gaps in the current plan that are addressed through recent FS architectural recommendations, algorithms, or techniques pertinent to agentic and browser-based systems.

### Methodology

Surveyed the following areas via web research and upstream source analysis:

- IndexedDB API changes (Chrome 121+ relaxed durability, `getAllRecords()` Interop 2026)
- OPFS `FileSystemSyncAccessHandle` performance benchmarks and best practices
- `FileSystemObserver` API shipping status (Chrome 133+)
- Worker bridge transfer patterns (Transferable ArrayBuffers, SharedArrayBuffer, Transferable Streams)
- Agentic filesystem architectures (AgentFS/Turso copy-on-write overlays, AFS)
- Production reference implementations (Notion OPFS SQLite SharedWorker architecture)
- Lazy tree loading patterns for browser file explorers
- Event coalescing patterns beyond simple debouncing

### Finding 13: Chrome 121+ Relaxed IDB Durability Default Validates Throttler Design

**Severity**: Informational — confirms plan alignment

**Source**: [Chrome DevRel blog: IndexedDB durability mode change](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/)

Chrome 121 changed the default IDB `readwrite` durability from `strict` to `relaxed`, aligning with Firefox and Safari. Benchmarks show 3-30x speed improvement and — critically — with relaxed durability, batch size becomes nearly irrelevant to performance (7% difference vs 344% under strict). The P1 Throttler in the plan explicitly uses `{ durability: 'relaxed' }`.

The Throttler's value under relaxed durability is not batch-size optimization but reducing the number of IDB cross-thread round-trips. Each transaction still incurs overhead from the ping-pong between main/storage threads; coalescing 50 writes into 1 transaction eliminates 49 round-trips. `DirectIdbProvider` already uses `{ durability: 'relaxed' }` on all three transaction sites. **No gap.**

### Finding 14: `getAllRecords()` — Interop 2026 Priority

**Severity**: P3 — Future optimization opportunity

**Source**: [Interop 2026 announcement](https://webkit.org/blog/17818/announcing-interop-2026/), [MDN: IDBObjectStore.getAllRecords()](https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAllRecords)

A new `getAllRecords()` method combines `getAllKeys()` + `getAll()` into a single operation with 2x-5x faster reads and supports reverse-order reading and batch pagination via `count`. It is part of Interop 2026 — Chrome ships it now, Firefox and Safari are implementing it throughout 2026.

`DirectIdbProvider._hydratePathIndex()` currently uses `getAllKeys()`, which is correct since hydration only needs keys (paths), not values. `getAllRecords()` would help future operations that need both keys and metadata in a single pass (e.g., bulk stat queries, content-addressed deduplication). **No gap in current plan; track for future bulk-read operations.**

### Finding 15: `FileSystemObserver` API Shipped Stable in Chrome 133+

**Severity**: Informational — validates existing P2 deferral

**Source**: [Chrome DevRel blog: File System Observer API](https://developer.chrome.com/blog/file-system-observer), [Can I use: FileSystemObserver](https://caniuse.com/mdn-api_filesystemobserver)

The `FileSystemObserver` API has shipped to stable Chrome 133+, Edge, and Opera. It provides native, non-polling filesystem change detection for both File System Access API and OPFS handles with recursive directory monitoring. Firefox and Safari do not support it yet.

The gap analysis already tracks this as P2 Finding 8 / R8. The P0-3 lazy tree refresh would benefit from `FileSystemObserver` in the `FileSystemAccessProvider` path — the refresh debounce could be complemented by observer-driven updates (future P2 work). **No gap; existing P2 deferral is correct given cross-browser status.**

### ✅ Finding 16: Transferable ArrayBuffers for Worker Bridge

**Severity**: ~~P1 — Performance optimization for file content transfer~~ **RESOLVED**

**Sources**: [Chrome DevRel: Transferable Objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast), [Structured Clone Tax analysis](https://loke.dev/blog/structured-clone-tax-shared-array-buffer)

**Status**: **RESOLVED** — `extractTransferables` in `runtime-filesystem-bridge.ts` detects `ArrayBuffer` instances (and `ArrayBuffer` backing `TypedArray` views) and passes them as the transfer list on both request and response `postMessage` calls. This enables zero-copy ownership transfer for file content, avoiding the 45x-50x structured clone penalty for large buffers. Combined with R20's `SharedContentPool`, cached reads bypass `postMessage` entirely.

### Finding 17: OPFS SyncAccessHandle — 3-4x Faster Than IDB

**Severity**: Informational — validates existing OPFSProvider

**Sources**: [RxDB OPFS storage benchmarks](https://rxdb.info/rx-storage-opfs.html), [web.dev OPFS article](https://web.dev/articles/origin-private-file-system)

OPFS with `FileSystemSyncAccessHandle` in workers delivers 3-4x faster performance than IndexedDB for file operations. Synchronous read/write methods (since Chromium 108) require `ArrayBuffer` format and are restricted to dedicated Web Workers.

Tau's `OPFSProvider` already exists as a backend option. The multi-provider architecture correctly supports OPFS as a user-selectable backend. **No gap.**

### Finding 18: AgentFS Copy-on-Write Overlay Architecture

**Severity**: P3 — Future architecture for agentic branching/experimentation

**Sources**: [AgentFS overlay filesystem](https://turso.tech/blog/agentfs-overlay), [AgentFS in the Browser](https://turso.tech/blog/agentfs_browser), [AFS paper](https://aigne-io.github.io/afs-paper/)

Turso's AgentFS implements a copy-on-write overlay filesystem for AI agents: a read-only base layer + a writable SQLite-backed delta layer. All agent modifications live in the delta layer, enabling checkpoint, rollback, and audit. The entire agent session lives in a single `.db` file. Path resolution is delta-first with whiteout markers for deletions.

A related project, AFS (Agentic File System), follows an "everything is a file, everything is context" philosophy — presenting memory stores, knowledge graphs, tools, and APIs as mounted filesystem paths.

Both are relevant to Tau's vision of agentic CAD: future "branching" or "experiment" features (running agent tasks in isolation) could use a CoW overlay. The existing `fs-capabilities Rec 6` already tracks "CopyOnWrite for overlays" as DEFERRED. **No gap; confirms existing deferral is correct.**

### Finding 19: Notion's SharedWorker + OPFS SQLite Architecture

**Severity**: P2 — Reference architecture for multi-tab coordination

**Source**: [Notion blog: How we sped up Notion with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)

Notion achieved 20%+ navigation speed improvement using SharedWorker for multi-tab SQLite coordination over OPFS. Their architecture: each tab has a dedicated Web Worker for SQLite, but only one tab is "active" at a time (managed via Web Locks). All queries from any tab route through the SharedWorker to the active tab's worker. Concurrent reads are allowed; writes are serialized.

**Update (R12 implemented)**: Cross-tab coordination is now implemented via `CrossTabCoordinator` using `navigator.locks` (per-file write serialization) + `BroadcastChannel` (change notifications). A full SharedWorker assessment (`docs/research/shared-worker-fs-architecture.md`) concluded that SharedWorker is **not suitable** for Tau's FS worker due to `SharedArrayBuffer` inaccessibility (breaks R20), `FileSystemSyncAccessHandle` restriction (blocks R21), and no Android Chrome support. Notion's SharedWorker serves as a routing-only layer for single-writer SQLite — a fundamentally different constraint than Tau's multi-tab-safe IndexedDB architecture.

### Finding 20: IDB Cursor vs `getAll()` Performance

**Severity**: Informational — confirms existing implementation is optimal

**Source**: [IDB cursor performance analysis](https://loke.dev/blog/indexeddb-cursor-performance-bottleneck)

Standard cursor-based iteration via `openCursor()`/`continue()` incurs 0.5-2ms per hop due to cross-thread round-trips (1,000+ separate event loop tasks for 1,000 items). `getAll()`/`getAllKeys()` collapses this to a single round-trip.

`DirectIdbProvider._hydratePathIndex()` correctly uses `getAllKeys()`. `readFile` uses a single `get()` request. `bulkImport` uses a single transaction with multiple `put()` calls. All three patterns are optimal. **No gap.**

### Finding 21: Event Coalescing — OS-Level + Multi-Stage Patterns

**Severity**: Informational — validates existing P1 deferral of Finding 5

**Source**: [File watcher debouncing analysis](https://medium.com/@impactarchitecture/file-watchers-lie-debounce-throttle-and-coalescing-in-build-loops-8d91cb29f712)

Research confirms that file save operations can trigger 3-12 filesystem events within milliseconds. Best practices: filter by event type first (drop CHMOD/metadata), then debounce, then coalesce by path. The plan's P0-3 directory-scoped refresh naturally reduces the impact of event storms because each refresh is cheap (single-level read). The existing P1 Finding 5 / R5 (multi-stage coalescing) remains the correct next step. **No gap.**

### Landscape Review Summary

| #   | Finding                                        | Relevance                     | Gap? | Action                                 |
| --- | ---------------------------------------------- | ----------------------------- | ---- | -------------------------------------- |
| F13 | Chrome 121+ relaxed IDB durability default     | Validates Throttler design    | No   | None                                   |
| F14 | `getAllRecords()` Interop 2026                 | Future bulk-read optimization | No   | Track for future                       |
| F15 | `FileSystemObserver` stable Chrome 133+        | Validates P2 deferral         | No   | None                                   |
| F16 | Transferable ArrayBuffers (45x bridge speedup) | P1 performance opportunity    | Done | `extractTransferables` (R13)           |
| F17 | OPFS SyncAccessHandle 3-4x faster than IDB     | Validates OPFSProvider        | No   | None                                   |
| F18 | AgentFS CoW overlay architecture               | Future P3 for agent branching | No   | Confirms fs-capabilities Rec 6         |
| F19 | Notion SharedWorker + OPFS SQLite              | Reference for multi-tab (P3)  | Done | R12 implemented; SharedWorker rejected |
| F20 | IDB cursor vs `getAll()`                       | Confirms optimal IDB patterns | No   | None                                   |
| F21 | Event coalescing multi-stage patterns          | Validates P1 Finding 5        | No   | None                                   |

**Conclusion**: The filesystem implementation is well-aligned with March 2026 browser filesystem best practices. The VS Code `ResourceQueue` pattern, IDB write batching via Throttler with relaxed durability, lazy directory-scoped tree loading, `extractTransferables` for zero-copy bridge transfers (F16), `SharedContentPool` for zero-IPC cached reads (R20), `FileSystemObserverBridge` for external change detection (R8), `readFileStream` for large file streaming (R11), multi-stage event coalescing (R5), `readdirWithStats` eliminating N+1 stat calls (R17), `MountTable` with OPFS-backed mounts for multi-backend routing (R18), directory handle LRU caching (R22), and backend reconfigure+restore on project creation (R1) are all consistent with the state-of-the-art. The remaining open items (R14: track `getAllRecords()`; R19: chunked storage; R21: dedicated OPFS worker; R23/R24: CoW overlays and SQL-debuggable FS) are P2–P3 future architecture items.

### Finding 22: Turso Shared WASM Memory — Zero-Copy IO Between Threads

**Severity**: P2 — Architectural opportunity for high-throughput scenarios

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 2

Turso allocates `WebAssembly.Memory({ shared: true })` backed by `SharedArrayBuffer`. Both the main thread and OPFS worker create `Uint8Array` views into the same memory. IO requests pass `{ ptr, len, offset }` via `postMessage` — the worker reads/writes directly into the shared buffer without copying. This eliminates the structured clone overhead identified in F16 entirely, at the cost of requiring COOP/COEP headers (which Tau already deploys).

**Implemented (R20)**: Tau now uses a `SharedArrayBuffer`-based `SharedContentPool` (bump allocator + FNV-1a hashing) that eliminates IPC round-trips for cached file reads. The file manager worker populates the pool on `readFile`, and both the main thread (`FileContentService`) and kernel workers (`createBridgeProxy`) resolve directly from shared memory on cache hits — zero `postMessage`, zero structured clone. The pool degrades gracefully when `SharedArrayBuffer` is unavailable (no COOP/COEP headers). Key components: `SharedMemoryArena` (low-level allocator), `SharedContentPool` (high-level cache), integrated into `FileService`, `RuntimeFileSystemBridge`, `KernelWorker`, and `FileContentService`.

### Finding 23: OPFS Sync Access Handles — Dedicated Worker Pattern

**Severity**: P2 — Performance architecture for persistent storage

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 3

Turso's `OpfsDirectory` class manages `FileSystemSyncAccessHandle` instances in a dedicated worker. Files are **pre-registered** before use (handle opened and cached), then accessed via synchronous `read`/`write`/`flush` calls. This avoids the overhead of opening handles per-operation and provides 3-4x better throughput than IDB.

Tau's `OPFSProvider` exists but is not the primary backend. A dedicated OPFS worker (separate from the IDB-based file manager) could serve as a fast path for hot files — the kernel's geometry cache, parameter cache, and frequently-edited source files.

### Finding 24: AgentFS Chunked Blob Storage — Partial File Reads

**Severity**: P2 — Enables streaming for large CAD files

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 7

AgentFS stores file content as 4 KB chunks in `fs_data(ino, chunk_index, data BLOB)`. `pread(offset, length)` translates to a `SELECT` on the chunk range — only the requested bytes are loaded from storage. This enables reading the header of a 100 MB STEP file without loading the entire file into memory.

Tau currently loads entire files via `readFile`. For large binary CAD files, a chunked storage approach (either at the provider level or as a separate large-file provider) would dramatically reduce memory pressure and enable streaming reads (R11).

### ✅ Finding 25: RAM-First Cache Policy for Browser WASM

**Severity**: ~~P1 — Performance tuning~~ **RESOLVED**

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 6

**Status**: **RESOLVED** — `BoundedFileCache` increased to 500 entries with 128 MB `maxTotalBytes` (R16). The `MountTable` architecture (R18) enables OPFS-backed mount points for persistent caches like `/node_modules/`, keeping ephemeral data in-memory while preserving offline capability for downloaded packages.

Turso uses a 100,000-page (~400 MB) cache with **spill disabled** on WASM builds, compared to 2,000 pages on native. The rationale: OPFS synchronous access is ~10x slower than native `pread`/`pwrite`, so trading RAM for fewer storage round-trips is the correct optimization in the browser.

### Finding 26: AgentFS Copy-on-Write Overlay — Agent Isolation

**Severity**: P3 — Future architecture aligned with Tau vision

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 8

AgentFS implements a full CoW overlay: read-only base layer + writable delta layer + whiteout markers for deletions + origin table for stable inode identity. The entire agent session lives in a single `.db` file that can be snapshotted, shared, or rolled back.

This maps directly to Tau's Phase 3 vision (multi-agent orchestration): an AI agent could modify geometry in a delta layer without affecting the user's project. Human review determines which changes to merge. The `fs-capabilities Rec 6` (CopyOnWrite for overlays) already tracks this; the Turso/AgentFS implementation provides a concrete reference.

### ✅ Finding 27: `readdirPlus` — Eliminating N+1 Stat Calls

**Severity**: ~~P1 — Low-effort optimization~~ **RESOLVED**

**Source**: [docs/research/turso-fs.md](docs/research/turso-fs.md) Finding 7

**Status**: **RESOLVED** — `readdirWithStats` added to the `FileSystemProvider` interface (R17) and implemented on all providers:

- **`DirectIdbProvider`**: Uses an in-memory `_fileSizes` cache populated on write/read, with batched `_idbGet` calls in a single read-only transaction for cache misses.
- **`FileSystemAccessProvider`**: Single `entries()` iteration with `handle.getFile()` for file metadata.
- **`MemoryProvider`**: Reuses existing in-memory data structures.

`FileService.readDirectory` and `readShallowDirectory` prefer `readdirWithStats` when available, falling back to `readdir` + `stat` for providers that don't implement it.

### Turso/AgentFS Landscape Summary

| #   | Finding                                        | Relevance                    | Gap? | Action                                       |
| --- | ---------------------------------------------- | ---------------------------- | ---- | -------------------------------------------- |
| F22 | Shared WASM memory zero-copy IO                | P2 architectural opportunity | Done | `SharedContentPool` (R20)                    |
| F23 | Dedicated OPFS worker with sync handles        | P2 performance architecture  | Yes  | Hot-path OPFS worker (R21)                   |
| F24 | Chunked blob storage for partial reads         | P2 streaming enabler         | Yes  | Chunked file storage (R19)                   |
| F25 | RAM-first cache policy (400 MB vs 200 entries) | P1 tuning opportunity        | Done | R16 (500 entries, 128 MB) + R18 (MountTable) |
| F26 | CoW overlay for agent isolation                | P3 vision alignment          | No   | Confirms fs-capabilities Rec 6               |
| F27 | `readdirPlus` joined queries                   | P1 low-effort optimization   | Done | R17 (`readdirWithStats` on all providers)    |

### Supplementary Recommendations

| #      | Action                                                                                                                                  | Priority | Effort     | Impact     | Findings |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- | -------- |
| ✅ R13 | ~~Use `postMessage` transferables for file content in worker bridge RPC~~ (`extractTransferables` on both req/resp paths)               | ~~P1~~   | ~~Medium~~ | ~~Medium~~ | ~~F16~~  |
| ❌ R14 | Track `getAllRecords()` for future bulk-read operations when cross-browser support lands                                                | P3       | Low        | Low        | F14      |
| ✅ R15 | Cross-tab coordination uses Web Locks (R12 `CrossTabCoordinator`); SharedWorker rejected per assessment                                 | P3       | —          | —          | F19      |
| ✅ R16 | ~~Increase `BoundedFileCache` size~~ (500 entries, 128 MB `maxTotalBytes`)                                                              | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F25~~  |
| ✅ R17 | ~~Add `readdirWithStats` to all providers~~ (`DirectIdbProvider` with `_fileSizes` cache, `FileSystemAccessProvider`, `MemoryProvider`) | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F27~~  |
| ✅ R18 | ~~RAM-first policy~~ — `MountTable` with OPFS-backed `/node_modules/` mount, cross-mount rename, readdir merge                          | ~~P1~~   | ~~Low~~    | ~~Medium~~ | ~~F25~~  |
| ❌ R19 | Chunked file storage (4 KB blocks) for large binary CAD files — enables partial reads                                                   | P2       | High       | Medium     | F24      |
| ✅ R20 | `SharedArrayBuffer`-based `SharedContentPool` — zero-IPC cached reads across all threads                                                | P2       | High       | High       | F22      |
| ❌ R21 | Dedicated OPFS worker with sync access handles for hot-path file operations                                                             | P2       | High       | High       | F23      |
| ✅ R22 | ~~Path resolution caching (LRU dentry cache, 10K entries)~~ in `FileSystemAccessProvider._resolveDirectoryHandle`                       | ~~P2~~   | ~~Low~~    | ~~Medium~~ | ~~F24~~  |
| ❌ R23 | CoW overlay architecture for agentic CAD experimentation (delta + whiteouts + origin mapping)                                           | P3       | High       | High       | F26      |
| ❌ R24 | Evaluate SQL-debuggable FS layer (inode+dentry+chunked-blob) as future IDB alternative                                                  | P3       | High       | Medium     | F24      |

## References

- Plan: `.cursor/plans/multi-provider_fs_architecture_32bb22dc.plan.md`
- Plan: `.cursor/plans/p0_filesystem_gaps_fix_42b7b159.plan.md`
- Policy: `docs/policy/filesystem-policy.md`
- Policy: `docs/policy/vision-policy.md`
- Research: `docs/research/filesystem-architecture.md`
- Research: `docs/research/filesystem-runtime-strategy.md`
- Research: `docs/research/vscode-fs-performance.md`
- Research: `docs/research/shared-worker-gate-startup-performance.md`
- Research: `docs/research/large-repo-import-performance.md`
- Research: `docs/research/node-vfs-applicability.md`
- Research: `docs/research/fs-capabilities.md`
- External: [Chrome IndexedDB relaxed durability](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/)
- External: [Interop 2026 announcement](https://webkit.org/blog/17818/announcing-interop-2026/)
- External: [FileSystemObserver API](https://developer.chrome.com/blog/file-system-observer)
- External: [Chrome Transferable Objects](https://developer.chrome.com/blog/transferable-objects-lightning-fast)
- External: [Structured Clone Tax](https://loke.dev/blog/structured-clone-tax-shared-array-buffer)
- External: [Notion OPFS SQLite architecture](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- External: [AgentFS overlay filesystem](https://turso.tech/blog/agentfs-overlay)
- External: [AgentFS in the Browser](https://turso.tech/blog/agentfs_browser)
- External: [AFS — Agentic File System](https://aigne-io.github.io/afs-paper/)
- External: [IDB cursor performance](https://loke.dev/blog/indexeddb-cursor-performance-bottleneck)
- External: [MDN: getAllRecords()](https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAllRecords)
- External: [File watcher debouncing patterns](https://medium.com/@impactarchitecture/file-watchers-lie-debounce-throttle-and-coalescing-in-build-loops-8d91cb29f712)
- Research: `docs/research/turso-fs.md`
- Source: `repos/turso/` (tursodatabase/turso — Rust SQLite rewrite, WASM browser runtime)
- Source: `repos/agentfs/` (tursodatabase/agentfs — POSIX FS over SQLite)
- External: [Turso in the Browser](https://turso.tech/blog/introducing-turso-in-the-browser)
- External: [Turso v0.5.0](https://turso.tech/blog/turso-0.5.0)
- External: [AgentFS website](https://www.agentfs.ai/)
- External: [AgentFS SPEC.md](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md)
