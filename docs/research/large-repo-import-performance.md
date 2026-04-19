---
title: 'Large Repository Import Performance Audit'
description: 'Audit of filesystem, rendering, and memory issues when importing large repositories (6000+ files)'
status: draft
created: '2026-03-27'
updated: '2026-03-27'
category: audit
related:
  - docs/policy/filesystem-policy.md
  - docs/policy/vision-policy.md
  - docs/research/filesystem-architecture.md
  - docs/research/vscode-fs-performance.md
---

# Large Repository Import Performance Audit

Systematic audit of performance failures, memory leaks, and poor UX observed when importing the Zoo repository (~6265 files) via the GitHub import flow.

## Executive Summary

Importing a large repository triggers a cascade of failures: duplicate file-manager workers cause race conditions, the kernel attempts file reads before import completes, Monaco creates hundreds of TextModels without rate-limiting, recursive `getDirectoryStat` performs O(N) sequential IndexedDB transactions, and multiple WebGL contexts exhaust GPU memory. The root causes are architectural — no import-aware lifecycle, no filesystem readiness gate between import and render, and unbounded eager resource creation.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Appendix: Log Timeline](#appendix-log-timeline)

## Problem Statement

When importing the Zoo repository (a KCL samples collection with ~6265 files) via `/import/*`:

1. **Unable to render**: Kernel worker fails with `No such file or directory` — files not yet written to ZenFS when the kernel tries to read them. WebGL context is lost (`THREE.WebGLRenderer: Context Lost`).
2. **Huge lag / poor first-load UX**: 143-second delay between initial page load and project filesystem becoming available. `getDirectoryStat` takes 2–3 seconds per call, and is called multiple times in parallel.
3. **Memory leaks**: Monaco listener leak warnings escalate from 200 → 600+ listeners. Multiple `TextModel` instances created without awaiting eviction. Duplicate workers and bridge ports accumulate.

## Methodology

- Analyzed two complete console log traces from the import → project load flow
- Source-level audit of: import route, file-manager machine, file-service, file-tree-service, monaco-model-service, cad machine, cad-preview machine, runtime-worker-client, filesystem-bridge, ZenFS provider
- Traced the lifecycle of every worker, bridge port, and WebGL context through the log timeline
- Cross-referenced with VS Code's filesystem architecture (see `docs/research/vscode-fs-performance.md`)

## Findings

### Finding 1: Duplicate FileManager Workers — Race Condition on SharedWorkerContext

**Severity**: Critical | **Impact**: Data races, duplicate I/O, wasted memory

The provider tree nests `FileManagerProvider` at two levels:

- **Root** (`root.tsx`): `rootDirectory='/'`
- **Project** (`projects_.$id/route.tsx`): `rootDirectory='/projects/:id'`

The nested provider uses `SharedWorkerContext` to reuse the root's worker. However, when the project route mounts, the root worker may still be in `creatingWorker` state — `useSelector(state.context.worker)` returns `undefined`, so `SharedWorkerContext` provides `undefined`, and the nested machine falls through to `sharedWorker ?? new FileManagerWorker()`, creating a **second worker**.

**Evidence from logs:**

```
[FileManager] initializeWorkerActor: start +825ms    ← root
[FileManager] initializeWorkerActor: start +843ms    ← nested (second worker)
[FileManager] worker created +0.1ms
[FileManager] worker created +0.0ms
```

Two separate workers means two separate `FileService` instances, two `WriteCoordinator` queues, and two `DirectoryTreeCache` instances — breaking the single-writer assumption documented in `file-manager.worker.ts`.

### Finding 2: Kernel Reads Files Before Import Writes Complete

**Severity**: Critical | **Impact**: Render failure, broken geometry pipeline

The import flow is:

1. Import machine downloads ZIP → extracts → `creating` state invokes `createProjectActor`
2. `createProjectActor` calls `fileManager.writeFiles(projectFiles)` — sequential `await provider.writeFile()` for each file
3. On success → navigate to `/projects/:id`

The `writeFiles` call for 6265 files is a **single serialized batch** — each file written sequentially via `WriteCoordinator.serialized()`. This takes significant time on IndexedDB.

**Verified ZenFS write path** (from source audit of `repos/zenfs/core` and `repos/zenfs/dom`):

Per file, `createZenFsProvider.writeFile` → `exists` (1 IDB tx) → `stat` (1 tx) → `createFile`/`commitNew` for new files (1 tx with 3 `put` ops: inode, data, parent listing) → `handle.write` → `StoreFS.write` (1 tx with get + put) → `handle[Symbol.asyncDispose]` → `sync` → `touch` (1 tx). Plus `_ensureDirectoryExistsInternal` creates **1 `mkdir`/`commitNew` tx per new path segment**.

Each `IndexedDBStore.transaction()` creates `db.transaction('tau-fs', 'readwrite')` — a real browser `IDBTransaction`. For 6265 files, this produces **~25,000–30,000 IDB transactions** (exists + stat + commitNew + write + touch per file, plus mkdir per unique directory). The `IndexedDBStore.cache` (`Map<number, Uint8Array>`) means data reads hit memory, but transaction creation overhead dominates.

Meanwhile, the project page mounts and the CAD machine immediately tries to:

1. `connectKernelActor` → waits for fileManager `ready`
2. Sends `initializeModel` with the main `.kcl` file
3. Kernel worker calls `readFile` via its filesystem bridge port

The kernel's filesystem bridge connects to the **same worker** (by design), but the initial `getDirectoryStat('/')` from the root FileManager already failed with `ENOENT` — the filesystem is empty or partially written. The kernel then hits `No such file or directory` on every `readFile` attempt.

**Evidence:**

```
[FileManager] Initial tree hydration failed (empty filesystem?): Exception: No such file or directory
[Kernel:worker] Failed to wait for promise from engine: JsValue(Exception: No such file or directory
    at StoreFS.findInode ... at Object.readFile ...
```

**Root cause**: Navigation occurs after `writeFiles` resolves, but the **nested** FileManager's `getDirectoryStat` races with the root FileManager that wrote the files. The nested worker (Finding 1) may not see the files because it has a **separate ZenFS mount** over the same IndexedDB — ZenFS's in-memory inode cache may be stale.

### Finding 3: O(N) Sequential IDB Transactions in `getDirectoryStat`

**Severity**: High | **Impact**: 2–3 second blocking tree scan, multiplied by duplicate calls

`FileService.getDirectoryStat` performs a **full recursive walk** where each `stat()` and `readdir()` call creates its own `IDBTransaction`.

**Verified ZenFS internals** (from `repos/zenfs/core` and `repos/zenfs/dom` source audit):

- `StoreFS` maintains an **in-memory `_ids: Map<string, number>`** (path → inode ID), so `findInode` does `_ids.get(path)` then `tx.get(ino)` — **one store read**, not a directory walk. However:
- **Each `StoreFS.stat()` creates a new `WrappedTransaction`**, which calls `IndexedDBStore.transaction()`, which creates `db.transaction('tau-fs', 'readwrite')` — a **new IDB transaction per stat call**
- **Each `StoreFS.readdir()` creates its own IDB transaction** with 2 store reads: `findInode` (1 get) + `tx.get(node.data)` for the directory listing JSON
- **`IndexedDBStore` has a `cache: Map<number, Uint8Array>`** that caches on first `get()`, but the cache is populated during mount preload anyway, so subsequent reads hit the cache. The bottleneck is **IDB transaction creation overhead**, not data reads
- ZenFS uses **numeric keys** (inode IDs), not path strings. Values are `Uint8Array` blobs

For 6265 files across D directories: **D `readdir` transactions + 6265 `stat` transactions** = ~6265+ IDB transactions created sequentially. Even though data comes from the in-memory cache, IDB transaction creation has fixed overhead (~0.1–0.3ms each), producing **~2 seconds for 6265 files**.

**Evidence:**

```
[FileManager] calling getDirectoryStat('/projects/proj_YE9wf6tv5kPJ59O6b6OzG') +275.6ms
[FileManager] getDirectoryStat returned 6265 entries +2039.6ms   ← 2 seconds
[FileManager] calling getDirectoryStat('/projects/proj_YE9wf6tv5kPJ59O6b6OzG') +384.6ms
[FileManager] getDirectoryStat returned 6265 entries +2140.0ms   ← duplicated by second worker
```

Two workers scanning the same 6265-entry tree simultaneously. Each scan takes ~2 seconds of sequential IDB transaction creation overhead.

### Finding 4: Monaco TextModel Listener Leak — Unbounded Creation Before Eviction

**Severity**: High | **Impact**: 600+ leaked event listeners, memory pressure, GC stalls

`MonacoModelService.syncAllInBackground` creates TextModels for every JS-like file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`) in batches of 5 via `requestIdleCallback`. The eviction mechanism (`evictStaleBackgroundModels`) runs on a **60-second interval** and caps at **200 models**.

**The problem**: Between eviction ticks, model creation is **unbounded**. If the Zoo repo contains hundreds of `.kcl` files (not JS-like, so filtered out) but also has JS config/tooling files, or if the repo is a fork with JS sources, hundreds of models can be created in seconds.

The log shows Monaco's internal leak detector firing at 200, 300, 400, 500, 600 listeners — each `TextModel` constructor registers listeners via `LanguageSelection.onDidChange`, and these accumulate faster than eviction can clear them.

**Evidence:**

```
[001] potential listener LEAK detected, having 200 listeners already. MOST frequent listener (1):
    at LanguageSelection._event [as onDidChange]
    at new TextModel
    at ModelService._createModelData
    ...
    at syncBackgroundFile @ monaco-model-service.ts:486
```

The stack shows `processNextBatch → requestIdleCallback → processNextBatch` chains, confirming the idle-time batch processing is creating models faster than eviction.

### Finding 5: FileTreeService Refresh Storms During Import

**Severity**: Medium | **Impact**: Repeated failed full-tree scans, wasted I/O

`FileTreeService` subscribes to `ContentChangeEvent` from `FileContentService`. When `writeFiles` completes, it emits `batchWritten`, which triggers `scheduleRefresh('')` — a **full root-level refresh** calling `getDirectoryStat` again.

During import, the sequence is:

1. Root FileManager init → `getDirectoryStat('/')` → fails (empty FS)
2. Import writes files → `batchWritten` event → `scheduleRefresh('')` → another `getDirectoryStat`
3. Nested FileManager init → `getDirectoryStat('/projects/:id')` → 6265 entries
4. CAD machine → kernel reads → failures trigger more events

Each `executeRefresh` failure is logged but **not retried** — but the refresh may be re-triggered by subsequent events, creating a storm of failed + successful scans.

**Evidence:**

```
[FileTreeService] refresh failed: Exception: No such file or directory  ← repeated 4+ times
```

### Finding 6: WebGL Context Loss from Multiple Concurrent Viewers

**Severity**: High | **Impact**: Complete rendering failure, black viewport

`THREE.WebGLRenderer: Context Lost.` appears twice in the logs. The project page creates multiple CAD viewer instances (one per compilation unit / panel), each with its own Three.js renderer and WebGL context.

The codebase has a `ThreeProvider` with context tracking (`acquire`/`release`) and a `WebglLimitFallback`, but the combination of:

- Multiple CadMachine instances (one per compilation unit + CadPreviewProvider)
- 6MB GLTF geometry data uploaded to GPU
- Context creation before prior contexts are released during re-initialization

...can exceed the browser's WebGL context limit (typically 8–16 contexts per page).

**Evidence:**

```
THREE.WebGLRenderer: Context Lost.
[CadMachine] connectKernelActor: start     ← multiple parallel starts
[CadMachine] connectKernelActor: start     ← second instance
geometry[0] format=gltf contentByteLength=6191404   ← 6MB per context
```

### Finding 7: Duplicate CadMachine Instances Per Project

**Severity**: Medium | **Impact**: Double kernel workers, double geometry processing, double WebGL contexts

The logs show two parallel `connectKernelActor` cycles throughout the session. This arises from:

1. **Two compilation units** in the project (each spawns a `cad` child actor in `project.machine.ts`)
2. **CadPreviewProvider** creating its own independent `cadMachine` via `useActorRef`
3. **React Strict Mode** (dev) causing mount/unmount/remount cycles

Each instance creates its own `RuntimeWorkerClient` → kernel worker, filesystem bridge port, and eventually a WebGL context. For a large repo, this multiplies all resource costs.

### Finding 8: `NodeIO` / glTF-Transform Browser Incompatibility Spam

**Severity**: Low | **Impact**: Console noise, confusing diagnostics

Every kernel initialization triggers repeated `Module "fs"/"path" has been externalized for browser compatibility` warnings — **7 groups of 3 warnings each** per kernel connection cycle. The `OcctLoader` and `GltfExporter` constructors instantiate `NodeIO` from `@gltf-transform/core`, which probes `fs.then`, `path.then`, `fs.promises` during initialization.

With two kernel instances connecting three times each (due to re-initialization), this produces **~60+ warning lines** per session, obscuring real errors.

### Finding 9: `writeFiles` Clones All File Buffers on the Main Thread

**Severity**: Medium | **Impact**: Peak memory 2× file data during import

`FileContentService.writeFiles` creates a `new Uint8Array(file.content)` clone for every file before sending to the worker:

```typescript
for (const [path, file] of Object.entries(files)) {
  const localCopy = new Uint8Array(file.content); // clone for cache
  clones.set(path, localCopy);
  absoluteFiles[joinPath(this.rootDirectory, path)] = file;
}
await this.proxy.writeFiles(absoluteFiles);
```

For the Zoo repo, the import machine holds all extracted files in a `Map<string, { filename, content: Uint8Array }>` in memory. `writeFiles` then clones each buffer for the cache. During the `proxy.writeFiles` call, **both** the original and clone exist in memory — peak memory is 2× the total file size.

### Finding 10: 143-Second Delay Between Initial Load and Project Readiness

**Severity**: Critical | **Impact**: User sees blank/broken UI for over 2 minutes

The log shows:

```
[FileManager] initializeWorkerActor: start +825ms        ← first mount (import page)
[FileManager] initializeWorkerActor: start +143545ms     ← project page (143 seconds later)
```

This 143-second gap represents the time between:

1. Initial page load (import route renders, root FileManager initializes with empty FS)
2. Import completion + navigation to project route (nested FileManager initializes with project path)

During this gap, the user sees the import progress UI, but the actual `writeFiles` for 6265 files via sequential IndexedDB writes is the bottleneck. Each write goes through `WriteCoordinator.serialized()` → `ensureDirectoryExists` + `writeFile`.

**Concrete IDB cost** (verified from ZenFS source): Each file write produces ~5 `IDBTransaction` objects (exists + stat + commitNew + write + touch), plus 1 per new directory segment in `_ensureDirectoryExistsInternal`. For 6265 files, this creates **~25,000–30,000 browser `IDBTransaction` objects** sequentially. Even though `IndexedDBStore.cache` means data reads hit memory (avoiding IDB `get` latency), each `db.transaction('tau-fs', 'readwrite')` call has fixed browser overhead. The `WriteCoordinator` serializes all writes into a single promise chain, so no parallelism is possible.

## Recommendations (VS Code-Informed)

Analysis of VS Code's filesystem architecture (see `docs/research/vscode-fs-performance.md`) reveals proven patterns for every issue identified. The recommendations below combine Tau-specific fixes with VS Code architectural precedent.

| #   | Action                                                                                                                                                                                                  | Priority | Effort | Impact                                | VS Code Precedent                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------- | ------------------------------------------- |
| R1  | **In-memory file tree from `getAllKeys`** — Replace O(N) sequential `getDirectoryStat` with VS Code's pattern: single `objectStore.getAllKeys()` → in-memory tree; `stat`/`readdir` become O(1) lookups | P0       | High   | Eliminates 2s scan, fixes render race | `IndexedDBFileSystemProvider.getFiletree()` |
| R2  | **Batched IDB writes via `Throttler`** — Coalesce `writeFiles` into single IDB transaction using VS Code's `bulkWrite` → `Throttler.queue` → `writeMany` pattern                                        | P0       | High   | Reduces 143s import to seconds        | `IndexedDBFileSystemProvider.writeMany()`   |
| R3  | **Gate kernel on filesystem readiness** — Kernel must not `readFile` until import completes and in-memory tree is populated                                                                             | P0       | Medium | Fixes all render failures             | VS Code's on-demand model creation          |
| R4  | **Eliminate duplicate workers** — Ensure `SharedWorkerContext` provides worker before nested providers mount; use suspend boundary or deferred init                                                     | P0       | Medium | Eliminates race conditions            | VS Code: single provider per scheme         |
| R5  | **Cap background model creation** — Check `backgroundAccessTimes.size >= maxBackgroundModels` before creating models, matching VS Code's on-demand pattern                                              | P1       | Low    | Prevents 600+ listener leak           | `WorkerTextModelSyncClient` idle eviction   |
| R6  | **Layered event coalescing** — Implement VS Code's 4-stage pipeline: 75ms raw → semantic coalesce → throttled emission → 500ms UI batch                                                                 | P1       | Medium | Eliminates refresh storms             | `EventCoalescer` + `ThrottledWorker`        |
| R7  | **Per-resource write queue** — Replace global `WriteCoordinator` with VS Code's `ResourceQueue` pattern: serialize per-URI, parallelize across URIs                                                     | P1       | Medium | Parallelizes independent writes       | `FileService.writeQueue`                    |
| R8  | **Limit concurrent WebGL contexts** — Enforce `ThreeProvider` acquire/release before creating renderers; defer non-visible panels                                                                       | P1       | Medium | Prevents context loss                 | N/A (Tau-specific)                          |
| R9  | **Cancellation tokens for FS ops** — Add `CancellationToken` support to `getDirectoryStat` and long-running FS operations                                                                               | P2       | Low    | Cancels stale work on context change  | `throwIfCancelled(token)` in `io.ts`        |
| R10 | **Stream import writes** — Write files as extracted from ZIP instead of accumulating all in memory                                                                                                      | P2       | High   | Reduces peak memory ~50%              | N/A (Tau-specific)                          |
| R11 | **Reference-counted models** — `acquireModel`/`releaseModel` for all model consumers instead of fire-and-forget creation                                                                                | P2       | Medium | Prevents orphaned models              | `ITextModelService.createModelReference`    |
| R12 | **Suppress `NodeIO` browser warnings** — Use `WebIO` in browser context                                                                                                                                 | P3       | Low    | Cleaner console output                | N/A                                         |

## Detailed Proposals

### R1: In-Memory File Tree for `getDirectoryStat`

**Problem (verified):** ZenFS `StoreFS` already has an in-memory `_ids: Map<string, number>` (path → inode ID), so `findInode` is O(1) lookup + 1 store read. However, `StoreFS.stat()` and `StoreFS.readdir()` each create a **new `IDBTransaction`** via `IndexedDBStore.transaction()` → `db.transaction('tau-fs', 'readwrite')`. `getDirectoryStat` calls these sequentially for every file, producing ~6265+ IDB transactions. The bottleneck is IDB transaction creation overhead, not data reads (the `IndexedDBStore.cache` already serves data from memory after mount preload).

**Approach:** Build an in-memory file tree **at the `FileService` layer** (above ZenFS) from the existing `_ids` map or a single `readdir` of the project root + recursive collect. This tree serves `stat` and `readdir` for metadata queries without creating IDB transactions. ZenFS's `_ids` map already has all paths — the issue is that each `stat()` wraps the lookup in a new IDB transaction unnecessarily.

**VS Code precedent:** `IndexedDBFileSystemProvider.getFiletree()` — single `getAllKeys()` → in-memory `IndexedDBFileSystemNode` tree. But note: VS Code uses path-keyed IDB stores, while ZenFS uses numeric inode IDs. Tau cannot use `getAllKeys()` directly because ZenFS IDB keys are opaque numbers, not file paths. The path information lives in `StoreFS._ids` (in-memory) and in directory listing blobs (JSON `Record<string, number>`).

```typescript
class InMemoryFileTree {
  private root = new TreeNode({ type: 'directory', path: '', children: new Map() });
  private cached: Promise<TreeNode> | undefined;

  async getTree(provider: FileSystemProvider): Promise<TreeNode> {
    if (!this.cached) {
      this.cached = this.buildFromProvider(provider);
    }
    return this.cached;
  }

  stat(path: string): FileStatEntry | undefined {
    return this.root.read(path);
  }

  readdir(path: string): string[] {
    const node = this.root.read(path);
    return node?.type === 'directory' ? [...node.children.keys()] : [];
  }

  onWrite(path: string, size: number): void {
    this.root.add(path, { type: 'file', size });
  }
}
```

The 6265-entry scan goes from ~2 seconds (~6265 IDB transactions) to ~1ms (in-memory tree traversal).

### R2: Batched IDB Writes — Bypassing ZenFS for Bulk Import

**Problem (verified):** ZenFS `createZenFsProvider.writeFile` produces **~5 `IDBTransaction` objects per file**: exists (1 tx via `StoreFS.stat`) → stat (1 tx) → createFile/`commitNew` (1 tx with 3 `put` ops: inode at `ino`, data at `ino+1`, parent listing) → write via `StoreFS.write` (1 tx) → touch on close (1 tx). Plus `_ensureDirectoryExistsInternal` creates 1 `commitNew` tx per new directory segment. For 6265 files: **~25,000–30,000 browser `IDBTransaction` objects**.

**Root cause:** ZenFS's `StoreFS` creates a new `WrappedTransaction` (→ new `IDBTransaction`) for every method call (`stat`, `write`, `commitNew`, `touch`). There is no batch/bulk API in ZenFS. `WrappedTransaction.commit()` only sets `done = true` — it does not control IDB transaction commit timing.

**Approach:** For bulk import, bypass ZenFS entirely and write directly to the `tau-fs` IDB object store. This requires understanding ZenFS's on-disk format:

- **Keys are numeric** (inode IDs, allocated sequentially: inode at `id`, data at `id+1`)
- **Inode values** are packed binary structs (`Inode` class in `@zenfs/core/src/internal/inode.ts`)
- **Directory listings** are UTF-8 JSON: `Record<string, number>` (filename → child inode ID)
- **File contents** are raw `Uint8Array` at key `inode.data`

```typescript
async function bulkImportToIDB(db: IDBDatabase, storeName: string, files: Map<string, Uint8Array>): Promise<void> {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const [path, content] of files) {
    store.put(content, path);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}
```

After bulk write, invalidate `StoreFS._ids` and `IndexedDBStore.cache` (or remount). This reduces 6265 files from ~25,000 IDB transactions to **1 IDB transaction** with ~12,530 `put` requests (inode + data per file, plus directory listings).

**VS Code precedent:** `IndexedDBFileSystemProvider.writeMany()` — coalesces all pending writes into a single `IDBTransaction` via `Throttler.queue`.

### R5: Background Model Creation Cap (VS Code Pattern)

VS Code's `WorkerTextModelSyncClient` creates models **on demand** and evicts idle ones after 60s. Tau should adopt both the cap and the demand-driven approach:

```typescript
// In syncBackgroundFile, before creating the model:
if (this.backgroundAccessTimes.size >= maxBackgroundModels) {
  return; // defer until eviction creates headroom
}
```

Longer-term, move to VS Code's delta-sync model: only sync files to the TypeScript worker when a language service **requests** them, not eagerly for all JS-like files.

### R6: Layered Event Coalescing (VS Code Pattern)

VS Code's 4-stage pipeline prevents event storms. Tau should implement at minimum:

```typescript
// Stage 1: Raw aggregation (75ms)
const rawCoalescer = new RunOnceWorker(75, (events) => {
  // Stage 2: Semantic coalesce
  const coalesced = coalesceEvents(events); // ADD+DELETE → drop, DELETE+ADD → UPDATE
  // Stage 3: Throttled emission
  throttledEmitter.queue(coalesced);
});

// Stage 4: UI batch (500ms)
const uiScheduler = new RunOnceScheduler(() => {
  this.executeRefresh(pendingPath);
}, 500);
```

During import, the coalescing naturally absorbs the `batchWritten` storm into a single UI update after all writes complete.

### R7: Per-Resource Write Queue (VS Code Pattern)

**Problem (verified):** `WriteCoordinator` is a **global FIFO promise chain** (`_writeQueue: Promise<void>`), not per-path. Every `serialized()` call chains onto a single promise — writes to unrelated files wait for each other. The `_depth` counter is only used for diagnostics.

**Why global serialization exists:** ZenFS `StoreFS.commitNew` (used by `mkdir` and `createFile`) reads the parent directory listing, adds the new entry, and writes it back — a classic read-modify-write TOCTOU. Two concurrent `commitNew` calls to the same parent directory can lose entries. This is ZenFS issue zen-fs/core#256.

**What can safely parallelize:** Writes to files in **different** parent directories are independent — their `commitNew` calls touch different directory listing blobs. Only writes to the **same parent directory** need serialization.

```typescript
class ResourceWriteQueue {
  private queues = new Map<string, Queue<void>>();

  async queueFor(path: string, factory: () => Promise<void>): Promise<void> {
    const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
    let queue = this.queues.get(parentDir);
    if (!queue) {
      queue = new Queue();
      this.queues.set(parentDir, queue);
    }
    return queue.queue(factory);
  }
}
```

This allows parallel writes to different directories while serializing writes to files in the same directory — the correct granularity for ZenFS's TOCTOU constraint.

## Vision Alignment

These recommendations directly support the vision policy (`docs/policy/vision-policy.md`):

- **Phase 1 (Geometry/MCAD)**: Large KCL sample repositories (Zoo) must import and render instantly. The filesystem is the data plane for "files are the interface."
- **Phase 2+ (Analysis, ECAD, Firmware)**: Multi-kernel projects will have even more files (schematics, firmware, simulation configs). The filesystem must scale to 50k+ files without degradation.
- **"Browser-native"**: No install, Web Workers for computation. The IDB-backed filesystem is the foundation — it must perform as well as native FS for any repo size.
- **"Everything is pluggable"**: New kernels bring new file types. The filesystem layer cannot have per-extension special cases; it must be generically fast.

The VS Code patterns proven at 100k+ file scale provide the architectural foundation for Tau's ambition as a browser-native engineering platform.

## Appendix: Log Timeline

| Time (relative) | Event                                 | Issue                           |
| --------------- | ------------------------------------- | ------------------------------- |
| +0ms            | `[vite] connecting...`                | Page load                       |
| +825ms          | Root FileManager init (worker 1)      |                                 |
| +843ms          | Nested FileManager init (worker 2)    | **F1**: Duplicate workers       |
| +985ms          | `getDirectoryStat('/')` → ENOENT      | **F2**: Empty FS                |
| ~+1s            | CadMachine connectKernelActor ×2      | **F7**: Duplicate CAD instances |
| ~+2s            | Kernel `readFile` → ENOENT            | **F2**: Files not written       |
| ~+3s            | `geometry[0] gltf 6191404 bytes`      | First CU renders OK             |
| ~+5s            | Second kernel → ENOENT                | **F2**: Second CU fails         |
| ~+5s            | `THREE.WebGLRenderer: Context Lost`   | **F6**: GPU exhaustion          |
| +143545ms       | FileManager re-init for project       | **F10**: 143s delay             |
| +143820ms       | `getDirectoryStat` → 6265 entries ×2  | **F3**: O(N) scan ×2            |
| +144000ms       | CadMachine re-connect, kernel re-init |                                 |
| +144300ms       | Kernel `readFile` → ENOENT again      | **F2**: Still racing            |
| +145000ms       | Monaco listener leak: 200→600+        | **F4**: Unbounded models        |
| +146000ms       | `THREE.WebGLRenderer: Context Lost`   | **F6**: Second context loss     |

## References

- Related: `docs/research/vscode-fs-performance.md` — VS Code filesystem performance patterns
- Related: `docs/research/filesystem-architecture.md`
- Policy: `docs/policy/filesystem-policy.md`
- Policy: `docs/policy/vision-policy.md`
- VS Code IDB provider: `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`
- VS Code file service: `repos/vscode/src/vs/platform/files/common/fileService.ts`
- VS Code model sync: `repos/vscode/src/vs/editor/common/services/textModelSync/textModelSync.impl.ts`
- ZenFS core StoreFS: `repos/zenfs/core/src/backends/store/fs.ts` — `findInode`, `stat`, `readdir`, `write`, `commitNew`, `_ids` map
- ZenFS core store: `repos/zenfs/core/src/backends/store/store.ts` — `WrappedTransaction`, `commit()` semantics
- ZenFS core inode: `repos/zenfs/core/src/internal/inode.ts` — binary inode struct
- ZenFS DOM IDB: `repos/zenfs/dom/src/IndexedDB.ts` — `IndexedDBStore`, `IndexedDBTransaction`, `createDB`, mount preload
- Tau file service: `packages/filesystem/src/file-service.ts`
- Tau ZenFS provider: `packages/filesystem/src/providers/create-zenfs-provider.ts`
- Tau write coordinator: `packages/filesystem/src/write-coordinator.ts`
- Tau Monaco service: `apps/ui/app/lib/monaco-model-service.ts`
