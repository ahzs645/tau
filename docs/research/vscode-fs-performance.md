---
title: 'VS Code Filesystem Performance at Scale'
description: 'Analysis of how VS Code handles large repositories in browser and desktop, identifying techniques applicable to Tau'
status: draft
created: '2026-03-27'
updated: '2026-03-27'
category: reference
related:
  - docs/research/large-repo-import-performance.md
  - docs/research/filesystem-architecture.md
  - docs/policy/filesystem-policy.md
---

# VS Code Filesystem Performance at Scale

Analysis of VS Code's filesystem architecture, indexing strategies, and performance techniques that enable responsive editing for repositories with 100k+ files — distilled for applicability to Tau's browser-based CAD platform.

## Executive Summary

VS Code achieves scale through six architectural pillars: (1) in-memory file tree from a single `getAllKeys()` IDB call instead of per-file stat, (2) batched IDB writes via `Throttler`-coalesced single transactions, (3) per-resource write queues (not global serialization), (4) lazy tree resolution with `TernarySearchTree`-gated recursion, (5) layered event coalescing from 75ms raw → 500ms UI, and (6) idle-eviction of worker-synced models after 60s. Every technique addresses a specific bottleneck observed in Tau's large-repo import failure.

## Table of Contents

- [Methodology](#methodology)
- [Finding 1: In-Memory File Tree from getAllKeys](#finding-1-in-memory-file-tree-from-getallkeys)
- [Finding 2: Batched IDB Writes via Throttler](#finding-2-batched-idb-writes-via-throttler)
- [Finding 3: Per-Resource Write Queue](#finding-3-per-resource-write-queue)
- [Finding 4: Lazy Tree Resolution with TernarySearchTree](#finding-4-lazy-tree-resolution-with-ternarysearchtree)
- [Finding 5: Layered Event Coalescing Pipeline](#finding-5-layered-event-coalescing-pipeline)
- [Finding 6: Worker Model Sync with Idle Eviction](#finding-6-worker-model-sync-with-idle-eviction)
- [Finding 7: Disposable Infrastructure and Leak Detection](#finding-7-disposable-infrastructure-and-leak-detection)
- [Finding 8: Explorer Virtualization and Async Tree](#finding-8-explorer-virtualization-and-async-tree)
- [Finding 9: Reference-Counted Model Lifecycle](#finding-9-reference-counted-model-lifecycle)
- [Finding 10: Cancellation Tokens for Stale Work](#finding-10-cancellation-tokens-for-stale-work)
- [Applicability to Tau](#applicability-to-tau)

## Methodology

- Source audit of `repos/vscode/src/vs/platform/files/` (providers, service, watchers, IDB)
- Source audit of `repos/vscode/src/vs/editor/common/` (model lifecycle, worker sync)
- Source audit of `repos/vscode/src/vs/workbench/contrib/files/` (explorer, tree UI)
- Source audit of `repos/vscode/src/vs/base/` (async primitives, tree widgets, disposables)
- Cross-referenced with Tau's `large-repo-import-performance.md` findings

## Findings

### Finding 1: In-Memory File Tree from `getAllKeys`

**Source**: `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`

VS Code's `IndexedDBFileSystemProvider` maintains an in-memory `IndexedDBFileSystemNode` tree (nested `Map<string, Node>` by path segment). The tree is built **once** on first access:

```typescript
private getFiletree(): Promise<IndexedDBFileSystemNode> {
  if (!this.cachedFiletree) {
    this.cachedFiletree = (async () => {
      const rootNode = new IndexedDBFileSystemNode({ children: new Map(), path: '', type: FileType.Directory });
      const result = await this.indexedDB.runInTransaction(this.store, 'readonly',
        objectStore => objectStore.getAllKeys());
      const keys = result.map(key => key.toString());
      keys.forEach(key => rootNode.add(key, { type: 'file' }));
      return rootNode;
    })();
  }
  return this.cachedFiletree;
}
```

**Key insight**: One `getAllKeys()` IDB call returns all file paths. The tree is built in-memory from these keys. Subsequent `stat`, `readdir`, and `readFile` operations use the cached tree for metadata — only `readFile` hits IDB again (for content). This means `stat` and `readdir` are **O(1) in-memory lookups**, not IDB transactions.

**Contrast with Tau (verified from ZenFS source):** Tau's `getDirectoryStat` calls `StoreFS.readdir` and `StoreFS.stat` sequentially. ZenFS's `StoreFS` _does_ have an in-memory `_ids: Map<string, number>` (path → inode ID), so `findInode` is O(1) lookup + 1 store read. However, each `stat()` and `readdir()` call creates a **new `IDBTransaction`** via `IndexedDBStore.transaction()` → `db.transaction('tau-fs', 'readwrite')`. The data itself comes from `IndexedDBStore.cache` (populated during mount preload), but IDB transaction creation overhead (~0.1–0.3ms each) accumulates to ~2 seconds for 6265 files. VS Code avoids this by keeping both keys and metadata in-memory — `getAllKeys()` returns path strings (VS Code uses path-keyed IDB, not inode-keyed like ZenFS), so the tree is built without any transaction overhead.

**Key difference:** VS Code uses **path strings as IDB keys** (`objectStore.put(data, path)`), so `getAllKeys()` returns file paths directly. ZenFS uses **numeric inode IDs** as IDB keys — `getAllKeys()` returns opaque numbers, not paths. Tau cannot directly replicate VS Code's `getAllKeys()` → tree pattern; it must build the tree from ZenFS's `_ids` map or from the directory listing blobs.

### Finding 2: Batched IDB Writes via `Throttler`

**Source**: `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`

Writes use a `bulkWrite` → `Throttler.queue` → `writeMany` pattern:

```typescript
private async bulkWrite(files: [URI, Uint8Array][]): Promise<void> {
  files.forEach(([resource, content]) => this.fileWriteBatch.push({ content, resource }));
  await this.writeManyThrottler.queue(() => this.writeMany());
  // update in-memory tree after IDB write
  const fileTree = await this.getFiletree();
  for (const [resource, content] of files) {
    fileTree.add(resource.path, { type: 'file', size: content.byteLength });
  }
}

private async writeMany() {
  if (this.fileWriteBatch.length) {
    const fileBatch = this.fileWriteBatch.splice(0, this.fileWriteBatch.length);
    await this.indexedDB.runInTransaction(this.store, 'readwrite', objectStore =>
      fileBatch.map(entry => objectStore.put(entry.content, entry.resource.path)));
  }
}
```

**Key insight**: Multiple `writeFile` calls are coalesced into a **single IDB transaction** containing multiple `put` requests. The `Throttler` ensures only one `writeMany` runs at a time, draining the batch queue. The `runInTransaction` helper wraps all requests in one `IDBTransaction`, resolving on `transaction.oncomplete`.

**Contrast with Tau (verified from ZenFS source):** Tau's `writeFiles` iterates sequentially: `for (const [path, file]) { await provider.writeFile(path, file.content); }`. Each `provider.writeFile` triggers `exists` (1 IDB tx) → `stat` (1 tx) → `createFile`/`commitNew` (1 tx with 3 `put` ops) → `StoreFS.write` (1 tx) → `touch` on close (1 tx) = **~5 IDB transactions per file**. For 6265 files: **~25,000–30,000 IDB transactions** vs VS Code's **1 transaction** with all `put` requests batched. The `IndexedDBStore.cache` means data reads are fast, but each `db.transaction('tau-fs', 'readwrite')` call has fixed browser overhead.

### Finding 3: Per-Resource Write Queue

**Source**: `repos/vscode/src/vs/platform/files/common/fileService.ts`, `repos/vscode/src/vs/base/common/async.ts`

```typescript
private readonly writeQueue = new ResourceQueue();

// Writes serialize per-URI, not globally
await this.writeQueue.queueFor(resource, async () => {
  await provider.writeFile(resource, content, opts);
});
```

`ResourceQueue` maintains a `Map<string, Queue<void>>` keyed by URI. Operations on the **same** resource serialize; operations on **different** resources proceed in **parallel**.

**Key insight**: This avoids the global serialization bottleneck. Two files can be written simultaneously because they have separate queues.

**Contrast with Tau (verified from ZenFS source):** Tau's `WriteCoordinator` is a **global FIFO promise chain** (`_writeQueue: Promise<void>`, `_depth` counter for diagnostics). All writes serialize behind one lock. The TOCTOU race in ZenFS's `StoreFS.commitNew` affects only writes to the **same parent directory** (the read-modify-write on the parent's directory listing blob `Record<string, number>`). Writes to files in different parent directories are independent and can safely parallelize. Per-parent-directory queues would be the correct granularity.

### Finding 4: Lazy Tree Resolution with `TernarySearchTree`

**Source**: `repos/vscode/src/vs/platform/files/common/fileService.ts`

When resolving file trees, VS Code uses `resolveTo` — a set of target URIs that **must** be resolved. A `TernarySearchTree` is built from these targets, and recursion into subdirectories only happens when the tree matches:

```typescript
let trie: TernarySearchTree<URI, boolean> | undefined;
return this.toFileStat(provider, resource, stat, undefined, !!resolveMetadata, (stat, siblings) => {
  if (!trie) {
    trie = TernarySearchTree.forUris<true>(() => !isPathCaseSensitive);
    trie.set(resource, true);
    if (resolveTo) {
      trie.fill(true, resolveTo);
    }
  }
  if (trie.get(stat.resource) || trie.findSuperstr(stat.resource.with({ query: null, fragment: null }))) {
    return true; // recurse into this directory
  }
  if (stat.isDirectory && resolveSingleChildDescendants) {
    return siblings === 1; // auto-expand single-child chains
  }
  return false; // skip this subtree
});
```

**Key insight**: The explorer never loads the full tree. It resolves only paths needed for the current view. `resolveSingleChildDescendants` auto-expands `src/` → `components/` chains without separate user clicks. Directory children are resolved with `Promises.settled(entries.map(...))` — **parallel**, not sequential.

**Contrast with Tau**: Tau's `getDirectoryStat` always walks the **entire** subtree recursively. There is no `resolveTo` equivalent — the FileTreeService always loads all 6265 entries into a flat `Map`.

### Finding 5: Layered Event Coalescing Pipeline

**Source**: Multiple watcher files under `repos/vscode/src/vs/platform/files/node/watcher/`

VS Code processes file change events through a multi-stage pipeline with increasing delay:

| Stage              | Delay                                              | Purpose                                | Source                                  |
| ------------------ | -------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| Raw aggregation    | **75ms** `RunOnceWorker`                           | Collect burst of FS events             | `nodejsWatcherLib.ts`                   |
| Semantic coalesce  | Inline                                             | ADD+DELETE → drop; DELETE+ADD → UPDATE | `watcher.ts` `EventCoalescer`           |
| Throttled emission | **200ms**, chunk **100** events, buffer **10,000** | Prevent consumer flooding              | `nodejsWatcherLib.ts` `ThrottledWorker` |
| Explorer react     | **500ms** `RunOnceScheduler`                       | Batch UI tree updates                  | `explorerService.ts`                    |

The `EventCoalescer` deduplicates by path: if a file is created then deleted within 75ms, no event is emitted. Recursive Parcel watchers use larger buffers (chunk 500, buffer 30,000).

**Key insight**: Four layers of batching ensure that even a mass import or `git checkout` with thousands of file changes produces a single UI update.

**Contrast with Tau**: Tau's `FileTreeService` has 300ms debounce on `scheduleRefresh`, but `batchWritten` triggers a **full root refresh** with no per-path deduplication. There is no multi-layer coalescing — events go directly from content service to tree service to full `getDirectoryStat`.

### Finding 6: Worker Model Sync with Idle Eviction

**Source**: `repos/vscode/src/vs/editor/common/services/textModelSync/textModelSync.impl.ts`

VS Code syncs text models to language workers (TypeScript, etc.) using a delta protocol:

1. **Initial sync**: Full snapshot via `$acceptNewModel(url, lines, EOL, versionId)`
2. **Incremental updates**: `$acceptModelChanged(IModelChangedEvent)` — character-level deltas
3. **Idle eviction**: Models unused for **60 seconds** (`STOP_SYNC_MODEL_DELTA_TIME_MS`) are **un-synced** from the worker
4. **Size gate**: Models where `isTooLargeForSyncing()` (>50MB) are never synced unless forced

```typescript
constructor(proxy, modelService, keepIdleModels = false) {
  if (!keepIdleModels) {
    const timer = new IntervalTimer();
    timer.cancelAndSet(() => this._checkStopModelSync(), Math.round(STOP_SYNC_MODEL_DELTA_TIME_MS / 2));
    this._register(timer);
  }
}
```

**Key insight**: Models are created **on demand** when needed by a language service, not eagerly for all files. The 60s idle eviction prevents accumulation. Delta sync avoids re-transmitting full file contents.

**Contrast with Tau**: Tau's `syncAllInBackground` eagerly creates TextModels for **all** JS-like files, with no on-demand gate. The 60s eviction interval matches VS Code's constant, but Tau lacks the creation-time cap that prevents overshoot.

### Finding 7: Disposable Infrastructure and Leak Detection

**Source**: `repos/vscode/src/vs/base/common/lifecycle.ts`

VS Code's leak prevention is structural:

- **`DisposableStore`**: Groups related disposables; `add()` after dispose logs a warning
- **`DisposableTracker`**: Optional opt-in tracking with stack traces for every `IDisposable` allocation
- **`GCBasedDisposableTracker`**: Uses `FinalizationRegistry` to detect disposables that are GC'd without being disposed
- **Working copy leak thresholds**: After **256** registered working copies, stacks are tracked; above **512**, `WorkingCopyLeakError` may throw

**Key insight**: Leak detection is built into the infrastructure, not bolted on. The `DisposableStore` pattern ensures that when a parent is disposed, all children are disposed together.

**Contrast with Tau**: Tau uses XState machine exit actions for cleanup, which is correct but lacks the explicit leak detection. The Monaco listener leak (Finding 4 in the performance audit) would be caught by VS Code's tracker infrastructure.

### Finding 8: Explorer Virtualization and Async Tree

**Source**: `repos/vscode/src/vs/base/browser/ui/tree/`, `repos/vscode/src/vs/workbench/contrib/files/browser/views/`

The file explorer uses `WorkbenchCompressibleAsyncDataTree` backed by:

- **`ListView`**: Virtual scrolling engine — only viewport rows get DOM nodes
- **`IndexTreeModel`**: Uses **LCS diff** (`spliceSmart`) when identity providers are available, minimizing DOM mutations on tree updates
- **`AsyncDataTree`**: Lazy `getChildren` per folder — collapsed directories are never resolved
- **Single-child auto-expand**: `resolveSingleChildDescendants` avoids deep click-through for `src/app/components/` chains

**Key insight**: The DOM never has more than ~viewport-height nodes regardless of tree size. Tree updates use smart splicing, not full re-render.

**Contrast with Tau**: Tau stores the full file tree in a `Map<string, FileEntry>` and renders it. For 6265 entries, this means 6265 entries in memory and potentially in the DOM, depending on the tree widget's virtualization.

### Finding 9: Reference-Counted Model Lifecycle

**Source**: `repos/vscode/src/vs/workbench/services/textmodelResolver/common/textModelResolverService.ts`

`ITextModelService.createModelReference` returns an `IReference<IResolvedTextEditorModel>`:

- Calling `ref.dispose()` decrements the count
- When count reaches zero, the model may be disposed (after `canDispose` check)
- `ReferenceCollection` with string key and integer counter manages the lifecycle

**Key insight**: Models are not created and forgotten. Every consumer must explicitly acquire and release references. This prevents orphaned models.

**Contrast with Tau**: Tau's `syncBackgroundFile` creates models and tracks them in `backgroundAccessTimes`, but the tracking is separate from the creation path. There is no reference-counting — background models are created unconditionally and evicted by age.

### Finding 10: Cancellation Tokens for Stale Work

**Source**: `repos/vscode/src/vs/platform/files/common/io.ts`, `repos/vscode/src/vs/base/common/cancellation.ts`

File operations accept `CancellationToken` and check it between chunks:

```typescript
// io.ts readFileIntoStream
throwIfCancelled(token); // before open
// ... in read loop:
throwIfCancelled(token); // between each buffer chunk
throwIfTooLarge(totalBytesRead, options);
```

**Key insight**: Long-running operations (large file reads, save participants) can be aborted mid-flight. When context changes (e.g., user opens a different file), stale work is cancelled rather than completed and discarded.

**Contrast with Tau**: Tau's `syncBackgroundFile` checks `epoch` for staleness, which is functionally similar but coarser — it cannot cancel mid-read. The `getDirectoryStat` recursive walk has no cancellation mechanism at all.

## Applicability to Tau

| VS Code Technique                      | Tau Problem It Solves                      | Adaptation                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-memory tree from `getAllKeys`**   | O(N) `getDirectoryStat` (Finding 3)        | Build tree from ZenFS `_ids` map or directory listing blobs at the `FileService` layer. Note: ZenFS uses numeric IDB keys (not path strings like VS Code), so `getAllKeys()` alone is insufficient |
| **Batched IDB writes via `Throttler`** | 143s sequential `writeFiles` (Finding 10)  | For bulk import, bypass ZenFS and write directly to IDB. ZenFS produces ~5 IDB tx/file (~25k–30k for 6265 files); direct IDB batch = 1 tx                                                          |
| **Per-resource `ResourceQueue`**       | Global `WriteCoordinator` serialization    | Per-parent-directory queues. ZenFS TOCTOU affects parent dir listing blobs only; writes to different parent dirs are independent                                                                   |
| **`resolveTo` + lazy tree**            | Full tree scan on every init               | Only resolve paths visible in explorer + active editor; defer rest                                                                                                                                 |
| **Layered event coalescing**           | FileTreeService refresh storms (Finding 5) | 75ms → semantic coalesce → 500ms UI batch; suppress during import                                                                                                                                  |
| **Idle model eviction**                | Monaco 600+ listener leak (Finding 4)      | Cap creation at `maxBackgroundModels`; on-demand sync, not eager                                                                                                                                   |
| **`DisposableStore` + leak tracker**   | Listener accumulation                      | Wrap all subscriptions in `DisposableStore`; add leak detection in dev                                                                                                                             |
| **Virtual tree + LCS splice**          | Large file tree rendering                  | Use react-virtuoso or similar; splice updates instead of full re-render                                                                                                                            |
| **Reference-counted models**           | Background model accumulation              | `acquireModel`/`releaseModel` pattern for all model consumers                                                                                                                                      |
| **`CancellationToken` on FS ops**      | Stale `getDirectoryStat` during import     | Cancel in-flight tree scans when context changes                                                                                                                                                   |

## References

- Source: `repos/vscode/src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`
- Source: `repos/vscode/src/vs/platform/files/common/fileService.ts`
- Source: `repos/vscode/src/vs/editor/common/services/textModelSync/textModelSync.impl.ts`
- Source: `repos/vscode/src/vs/base/common/async.ts` (`ResourceQueue`, `Throttler`)
- Source: `repos/vscode/src/vs/base/common/lifecycle.ts` (`DisposableStore`, `DisposableTracker`)
- Source: `repos/vscode/src/vs/platform/files/common/watcher.ts` (`EventCoalescer`)
- Related: `docs/research/large-repo-import-performance.md`
- Related: `docs/research/filesystem-architecture.md`
