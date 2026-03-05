---
name: Filesystem Architecture Overhaul
overview: Complete rewrite of the Tau filesystem from a monolithic fileManager object to a layered FileService architecture with provider abstraction, bounded caches, event-driven tree management, lazy loading, and comprehensive testing — matching the target architecture in docs/research/filesystem-architecture.md.
todos:
  - id: types
    content: "Phase 1a: Define FileSystemProvider interface, FileStat, ChangeEvent, and shared types in apps/ui/app/filesystem/types.ts"
    status: pending
  - id: providers
    content: "Phase 1b: Implement IndexedDBProvider, WebAccessProvider, MemoryProvider wrapping ZenFS in apps/ui/app/filesystem/providers/"
    status: pending
  - id: registry
    content: "Phase 1c: Implement ProviderRegistry with instance caching and standalone provider support"
    status: pending
  - id: bounded-cache
    content: "Phase 1d: Implement BoundedFileCache with LRU eviction, max entries/bytes, skip-large-binary"
    status: pending
  - id: write-coordinator
    content: "Phase 2a: Extract WriteCoordinator class from global writeQueue in file-manager.ts"
    status: pending
  - id: tree-cache
    content: "Phase 2b: Implement DirectoryTreeCache with incremental invalidation"
    status: pending
  - id: event-bus
    content: "Phase 2c: Implement ChangeEventBus for push-based change notifications to connected ports"
    status: pending
  - id: file-service
    content: "Phase 2d: Implement FileService class orchestrating providers, write coordinator, tree cache, and event bus"
    status: pending
  - id: worker-entry
    content: "Phase 2e: Rewrite file-manager.worker.ts to instantiate FileService + rewrite file-manager.ts"
    status: pending
  - id: bridge-events
    content: "Phase 3: Extend kernel-filesystem-bridge with listen()/emit() event channel for push notifications"
    status: pending
  - id: machine-overhaul
    content: "Phase 4: Overhaul fileManagerMachine — BoundedFileCache in context, debounced refresh (300ms), incremental tree updates"
    status: pending
  - id: machine-tests
    content: "Phase 4 tests: Comprehensive unit tests for fileManagerMachine state transitions, debounce, eviction, error recovery"
    status: pending
  - id: hook-update
    content: "Phase 5a: Update useFileManager hook — add readShallowDirectory, remove readBackendFileTree, update openFiles accessor"
    status: pending
  - id: consumer-update
    content: "Phase 5b: Update all consumers — MonacoModelService tree subscription, openFiles selectors, rpc-handlers"
    status: pending
  - id: tree-onexpand
    content: "Phase 6a: Add onExpand callback to Tree component via useEffect diff pattern"
    status: pending
  - id: files-route
    content: "Phase 6b: Rewrite files/route.tsx with lazy loading — loadedDirs, inflightRef dedup, targeted invalidation"
    status: pending
  - id: port-lifecycle
    content: "Phase 7: Implement worker port tracking, disconnect protocol, and cleanup in bridge"
    status: pending
  - id: cleanup
    content: "Phase 8: Remove dead code, simplify zenfs-config, remove readBackendFileTree, clean up diagnostic logging"
    status: pending
  - id: unit-tests
    content: "Unit tests for all new components: providers, registry, WriteCoordinator, DirectoryTreeCache, ChangeEventBus, BoundedFileCache"
    status: pending
  - id: integration-tests
    content: "Integration tests: Bridge + FileService over MessageChannel, write → tree invalidation → event pipeline"
    status: pending
isProject: false
---

# Filesystem Architecture Overhaul

## Current vs Target

```mermaid
flowchart LR
    subgraph current ["Current (Monolithic)"]
        FM["fileManager object\n22 methods, 1 file"]
        GQ["Global writeQueue"]
        NoCache["No eviction"]
        FullTree["Full recursive getDirectoryStat\non every mutation"]
    end

    subgraph target ["Target (Layered)"]
        FS["FileService class"]
        PR["ProviderRegistry"]
        WC["WriteCoordinator"]
        DTC["DirectoryTreeCache"]
        CEB["ChangeEventBus"]
        BFC["BoundedFileCache"]
        Providers["IDB / WebAccess / Memory\nProviders"]
    end

    current -->|"rewrite"| target
```



## Files to Create (New)

All new filesystem files live under `apps/ui/app/filesystem/`:

- `types.ts` — `FileSystemProvider`, `ProviderCapabilities`, `FileStat`, `ChangeEvent` types
- `providers/indexeddb-provider.ts` — IndexedDB via ZenFS
- `providers/webaccess-provider.ts` — File System Access API via ZenFS
- `providers/memory-provider.ts` — In-memory via ZenFS
- `provider-registry.ts` — Creates, caches, and routes to providers
- `file-service.ts` — Orchestration class (replaces `fileManager` object)
- `write-coordinator.ts` — Serialization queue (extracted + improved from `file-manager.ts`)
- `directory-tree-cache.ts` — In-memory tree with incremental invalidation
- `change-event-bus.ts` — Notifies connected ports of file changes
- `bounded-file-cache.ts` — LRU cache with max entries + max bytes

Test files alongside each:

- `providers/indexeddb-provider.test.ts`
- `providers/webaccess-provider.test.ts`
- `providers/memory-provider.test.ts`
- `provider-registry.test.ts`
- `file-service.test.ts`
- `write-coordinator.test.ts`
- `directory-tree-cache.test.ts`
- `change-event-bus.test.ts`
- `bounded-file-cache.test.ts`

## Files to Rewrite (Existing)

- `apps/ui/app/machines/file-manager.ts` — Replace monolithic object with `FileService` instantiation
- `apps/ui/app/machines/file-manager.worker.ts` — Update to use `FileService`
- `apps/ui/app/machines/file-manager.machine.ts` — Debounced refresh, BoundedFileCache, tree event subscription
- `apps/ui/app/machines/file-manager.machine.types.ts` — Add `readShallowDirectory`, update protocol
- `apps/ui/app/hooks/use-file-manager.tsx` — Expose `readShallowDirectory`, remove `readBackendFileTree`
- `apps/ui/app/routes/files/route.tsx` — Lazy loading with VS Code patterns
- `apps/ui/app/components/magicui/file-tree.tsx` — Add `onExpand` callback
- `apps/ui/app/filesystem/zenfs-config.ts` — Simplify; backend-specific logic moves to providers

## Files to Update (Consumer Migration)

- `apps/ui/app/lib/monaco-model-service.ts` — Subscribe to `treeChanged` events instead of calling `getDirectoryStat`
- `apps/ui/app/hooks/use-monaco-model-service.tsx` — Pass new tree subscription
- `apps/ui/app/hooks/rpc-handlers.ts` — Update `readdir`/`exists` to use hook instead of `fileTree` context
- All `useSelector` consumers of `fileTree` and `openFiles` — update selectors for new context shape

---

## Phase 1: Foundation — Provider Abstraction + Utilities

### 1a. Define `FileSystemProvider` interface

**File:** `apps/ui/app/filesystem/types.ts`

```typescript
type ProviderCapabilities = {
  readonly persistent: boolean;
  readonly writable: boolean;
  readonly quotaBased: boolean;
};

type FileStat = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
};

type FileSystemProvider = {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  lstat(path: string): Promise<FileStat>;
  dispose(): void;
};
```

Also define `ChangeEvent`, `FileTreeNode` (move from `file-manager.ts`), and `FileSystemBackend` (move from current location).

### 1b. Implement providers

Each provider wraps ZenFS with a specific backend. The ZenFS `configure()` call moves inside the provider constructor/`create()` factory.

`**providers/indexeddb-provider.ts`:**

- Factory: `createIndexedDBProvider(databasePrefix: string): Promise<FileSystemProvider>`
- Calls `resolveMountConfig({ backend: IndexedDB, storeName })` internally
- Implements all methods via ZenFS `fs.promises`
- Also supports creating standalone read-only instances for the files route

`**providers/webaccess-provider.ts`:**

- Factory: `createWebAccessProvider(handle: FileSystemDirectoryHandle): Promise<FileSystemProvider>`
- Wraps ZenFS `WebAccess` backend

`**providers/memory-provider.ts`:**

- Factory: `createMemoryProvider(): Promise<FileSystemProvider>`
- Wraps ZenFS `InMemory` backend
- Used for tests and ephemeral previews

### 1c. ProviderRegistry

**File:** `apps/ui/app/filesystem/provider-registry.ts`

```typescript
class ProviderRegistry {
  private readonly providers = new Map<string, FileSystemProvider>();
  private readonly standaloneProviders = new Map<string, FileSystemProvider>();

  async getProvider(backend: FileSystemBackend): Promise<FileSystemProvider>;
  async getStandaloneProvider(backend: FileSystemBackend): Promise<FileSystemProvider>;
  async switchActiveProvider(backend: FileSystemBackend, handle?: FileSystemDirectoryHandle): Promise<void>;
  disposeAll(): void;
}
```

- Caches provider instances per backend (fixes Known Issue #5: standalone FS created per call)
- `getStandaloneProvider` returns cached read-only instances for the files route
- `switchActiveProvider` replaces `reconfigureFileSystem`

### 1d. BoundedFileCache

**File:** `apps/ui/app/filesystem/bounded-file-cache.ts`

```typescript
class BoundedFileCache {
  constructor(options: { maxEntries: number; maxTotalBytes: number; maxSingleFileBytes: number });
  get(path: string): Uint8Array | undefined;
  set(path: string, data: Uint8Array): void;
  delete(path: string): void;
  rename(oldPath: string, newPath: string): void;
  has(path: string): boolean;
  clear(): void;
  readonly size: number;
  readonly totalBytes: number;
  entries(): IterableIterator<[string, Uint8Array]>;
}
```

- LRU eviction when `maxEntries` or `maxTotalBytes` exceeded
- Files > `maxSingleFileBytes` (1 MB) are not cached (skip large binaries)
- Replaces unbounded `openFiles: Map<string, Uint8Array>` in XState context (fixes Known Issue #2)

---

## Phase 2: Core — FileService + WriteCoordinator + DirectoryTreeCache

### 2a. WriteCoordinator

**File:** `apps/ui/app/filesystem/write-coordinator.ts`

Extracted from the current global `writeQueue` + `serialized()` in [file-manager.ts](apps/ui/app/machines/file-manager.ts) (lines 37-66).

```typescript
class WriteCoordinator {
  async serialized<T>(operation: () => Promise<T>): Promise<T>;
  readonly depth: number;
}
```

- Same global serialization for now (ZenFS TOCTOU still open)
- Clean extraction makes future per-directory queues a drop-in replacement
- Removes dead `serializedQueueDepth` counter (Known Issue #10)

### 2b. DirectoryTreeCache

**File:** `apps/ui/app/filesystem/directory-tree-cache.ts`

```typescript
type TreeEntry = { name: string; type: 'file' | 'directory'; size: number; mtimeMs: number };

class DirectoryTreeCache {
  get(path: string): Map<string, TreeEntry> | undefined;
  set(path: string, entries: Map<string, TreeEntry>): void;
  invalidate(path: string): void;
  invalidateSubtree(path: string): void;
  getFullTree(): Map<string, TreeEntry>;
  clear(): void;
}
```

- In-memory cache of directory listings (names + types + sizes + mtimes)
- `invalidate(parentPath)` clears a single directory — called after writes
- `invalidateSubtree` clears a directory and all descendants — called after rename/rmdir
- Replaces polling-based `getDirectoryStat` (fixes Known Issue #1, #6)

### 2c. ChangeEventBus

**File:** `apps/ui/app/filesystem/change-event-bus.ts`

```typescript
type ChangeEvent =
  | { type: 'fileWritten'; path: string }
  | { type: 'fileDeleted'; path: string }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'directoryChanged'; path: string };

class ChangeEventBus {
  subscribe(port: MessagePort, handler: (event: ChangeEvent) => void): () => void;
  emit(event: ChangeEvent): void;
  dispose(): void;
}
```

- Emits change events to all connected ports
- Main thread subscribes to get tree change notifications (fixes Known Issue #7 by enabling push-based updates)
- Replaces the need for explicit `spawnBackgroundRefresh` after every mutation

### 2d. FileService

**File:** `apps/ui/app/filesystem/file-service.ts`

The central orchestration class. Replaces the monolithic `fileManager` object in [file-manager.ts](apps/ui/app/machines/file-manager.ts).

```typescript
class FileService {
  constructor(options: {
    providerRegistry: ProviderRegistry;
    writeCoordinator: WriteCoordinator;
    treeCache: DirectoryTreeCache;
    eventBus: ChangeEventBus;
  });

  // Read operations (direct to provider, no serialization)
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFiles(paths: string[]): Promise<Record<string, Uint8Array>>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  batchExists(paths: string[]): Promise<Record<string, boolean>>;

  // Write operations (serialized via WriteCoordinator)
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  writeFiles(files: Record<string, { content: Uint8Array | string }>): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;

  // Higher-level operations
  ensureDirectoryExists(path: string): Promise<void>;
  duplicateFile(sourcePath: string, destPath: string): Promise<void>;
  copyDirectory(sourcePath: string, destPath: string): Promise<void>;
  getDirectoryContents(path: string): Promise<Map<string, Uint8Array>>;
  getZippedDirectory(path: string): Promise<Uint8Array>;

  // Tree operations (via DirectoryTreeCache + standalone providers)
  getDirectoryStat(path: string): Promise<FileStatEntry[]>;
  readShallowDirectory(path: string, backend: FileSystemBackend, handle?: FileSystemDirectoryHandle): Promise<FileTreeNode[]>;

  // Backend management
  reconfigure(backend: FileSystemBackend): Promise<void>;
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;

  dispose(): void;
}
```

Write operations:

1. Acquire serialized lock via `WriteCoordinator`
2. Execute on active provider
3. Invalidate affected path in `DirectoryTreeCache`
4. Emit change event via `ChangeEventBus`

`readShallowDirectory` uses `ProviderRegistry.getStandaloneProvider()` — cached per backend (fixes Known Issue #5).

### 2e. Worker entry rewrite

**File:** `apps/ui/app/machines/file-manager.worker.ts`

```typescript
import { exposeFileSystem } from '@taucad/kernels/filesystem';
import { FileService } from '#filesystem/file-service.js';
import { ProviderRegistry } from '#filesystem/provider-registry.js';
import { WriteCoordinator } from '#filesystem/write-coordinator.js';
import { DirectoryTreeCache } from '#filesystem/directory-tree-cache.js';
import { ChangeEventBus } from '#filesystem/change-event-bus.js';

const providerRegistry = new ProviderRegistry();
const writeCoordinator = new WriteCoordinator();
const treeCache = new DirectoryTreeCache();
const eventBus = new ChangeEventBus();

const fileService = new FileService({
  providerRegistry, writeCoordinator, treeCache, eventBus,
});

exposeFileSystem(fileService);
```

### 2f. Update `file-manager.ts`

The current [file-manager.ts](apps/ui/app/machines/file-manager.ts) (542 lines) is replaced. The `fileManager` object's methods are now in `FileService`. The file becomes a thin re-export or is removed entirely since the worker entry now instantiates `FileService` directly.

---

## Phase 3: Bridge Event Channel Extension

**File:** `packages/kernels/src/framework/kernel-filesystem-bridge.ts`

Extend the existing bridge with a `listen()` mechanism alongside `call()`:

```typescript
// In createBridgeCall, add event listener support:
function createBridgeCall(port: MessagePort): {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  listen: (event: string, handler: (data: unknown) => void) => () => void;
  dispose: () => void;
};

// Server side: add emit capability
function createBridgeServer(handlers, port): {
  emit: (event: string, data: unknown) => void;
};
```

Protocol extension: `{ type: 'event', event: string, data: unknown }` messages flow server→client (no response expected). Distinguished from RPC by `type: 'event'` vs `type: undefined` (current `{ id, method, args }` pattern).

The `ChangeEventBus` in `FileService` uses the server `emit()` to push `treeChanged` events.

Tests: Extend `kernel-filesystem-bridge.test.ts` with event channel tests.

---

## Phase 4: XState Machine Overhaul

**File:** `apps/ui/app/machines/file-manager.machine.ts`

Key changes from current implementation (840 lines):

- **Context**: Replace `openFiles: Map<string, Uint8Array>` with `fileCache: BoundedFileCache` instance (created in machine context factory). `fileTree` stays as `Map<string, FileEntry>`.
- **Debounced refresh**: Replace `spawnBackgroundRefresh` (current: immediate spawn on every mutation) with debounced approach:
  - New action `scheduleDebouncedRefresh` — sets a 300ms timer, resets on each mutation
  - After debounce, spawns the refresh actor (fixes Known Issue #1, #7)
  - Guard prevents spawning if one is already in flight
- **Incremental refresh**: `replaceFileTreeFromBackgroundRefresh` should only update the changed parent directory, not replace the entire tree
- **Tree event subscription**: When bridge supports `listen()`, subscribe to `treeChanged` events and update `fileTree` incrementally instead of polling
- **Remove** `readDirectoryActor` invocation in `loadingRootDirectory` — initial tree load moves to the hook (lazy load on demand)
- **Simplify states**: Consider merging `loadingRootDirectory` into `ready` since tree loading is now lazy/event-driven

**File:** `apps/ui/app/machines/file-manager.machine.types.ts`

- Add `readShallowDirectory` to `FileManagerProtocol`
- Update `FileManagerApi` to include tree subscription
- Remove `readBackendFileTree` from protocol (replaced by `readShallowDirectory`)

### Machine tests

**File:** `apps/ui/app/machines/file-manager.machine.test.ts` (new)

Test the XState machine in isolation:

- State transitions: `initializing` → `creatingWorker` → `ready`
- `fileWritten` → debounced refresh (verify 300ms debounce)
- `fileDeleted` → optimistic delete + debounced refresh
- `fileRenamed` → optimistic rename + debounced refresh
- `BoundedFileCache` integration: eviction after max entries
- Error state recovery
- Multiple rapid mutations coalesce into single refresh
- Background refresh doesn't start during `creatingWorker`

Mock the worker proxy via `vi.fn()` for all RPC methods.

---

## Phase 5: Hook + Consumer Updates

### 5a. Update `useFileManager` hook

**File:** `apps/ui/app/hooks/use-file-manager.tsx`

- Add `readShallowDirectory(path, backend)` to context
- Remove `readBackendFileTree` (breaking change — files route migrated in Phase 6)
- Update `openFiles` selector to read from `BoundedFileCache` (via `fileCache.entries()`)
- `fileTree` selector unchanged (still reads from machine context)

### 5b. Update consumers

Every consumer that currently uses `readBackendFileTree` or accesses `openFiles` directly needs updating:

- `**apps/ui/app/routes/files/route.tsx`**: Complete rewrite in Phase 6
- `**apps/ui/app/lib/monaco-model-service.ts`**: Replace `getDirectoryStat('')` background sync with tree change event subscription
- `**apps/ui/app/hooks/use-monaco-model-service.tsx`**: Wire up tree event subscription
- `**openFiles` selectors** in `chat-editor.tsx`, `chat-editor-dockview.tsx`, `chat-editor-file-tree.tsx`: Update to use `fileCache` accessor
- `**fileTree` selectors** remain unchanged (same shape)

---

## Phase 6: Lazy File Tree Loading (Files Route)

This phase implements the plan from [lazy_file_tree_loading.plan.md](/Users/rifont/.cursor/plans/lazy_file_tree_loading_c9a75907.plan.md) using the new `FileService.readShallowDirectory`.

### 6a. Tree component `onExpand`

**File:** `apps/ui/app/components/magicui/file-tree.tsx`

Add `onExpand?: (id: string) => void` prop. Detect newly expanded items via `useEffect` + ref diff (per the existing plan).

### 6b. Files route rewrite

**File:** `apps/ui/app/routes/files/route.tsx`

Complete rewrite per the lazy loading plan:

- Replace `columnTrees` / `columnLoading` with `loadedDirs` Map + `inflightRef` dedup
- `loadDirectory` with synchronous deduplication via `inflightRef`
- `reloadDirectory` for mutation invalidation
- `buildTreeFromDirs` pure function for derived tree
- `handleRefresh` re-fetches only loaded paths
- `invalidateParentDirectory` for targeted mutation response
- Inline loading indicators per folder
- Remove `readBackendFileTree`, `loadColumnTree`, `toTreeViewElements`, recursive `countBuilds`

---

## Phase 7: Worker Port Lifecycle

### 7a. Port tracking in worker

**File:** `packages/kernels/src/filesystem/filesystem-bridge.ts`

Modify `exposeFileSystem` to track active ports:

```typescript
function exposeFileSystem(handlers, options?): { cleanup: () => void; activePorts: Set<MessagePort> } {
  const activePorts = new Set<MessagePort>();
  // On connect: add to set
  // On port close/error: remove from set
  // On cleanup: close all ports
}
```

### 7b. Disconnect protocol

**File:** `packages/kernels/src/framework/kernel-filesystem-bridge.ts`

- `createBridgeProxy.dispose()` sends `{ type: 'disconnect' }` before closing port
- Server side listens for disconnect and removes port from active set
- Fallback: heartbeat timeout (30s) for unclean disconnects

Tests: Add port lifecycle tests to `kernel-filesystem-bridge.test.ts`.

---

## Phase 8: Cleanup + Dead Code Removal

- Remove `serializedQueueDepth` dead code (Known Issue #10)
- Remove `readBackendFileTree` from `FileManagerProtocol` and worker
- Simplify `zenfs-config.ts` — backend-specific config moves to providers; `zenfs-config.ts` becomes a thin coordinator or is absorbed into `ProviderRegistry`
- Remove `ensureReady()` from every method — providers handle their own initialization
- Fix `ensureReady` always passing `'indexeddb'` (Known Issue #11) — provider init is explicit
- Clean up diagnostic logging added during debugging

---

## Testing Strategy

### Unit tests (per component)


| Component            | File                           | Key test cases                                                         |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `BoundedFileCache`   | `bounded-file-cache.test.ts`   | LRU eviction, max bytes, skip large files, rename, delete              |
| `WriteCoordinator`   | `write-coordinator.test.ts`    | Serialization order, error recovery, concurrent ops                    |
| `DirectoryTreeCache` | `directory-tree-cache.test.ts` | Set/get/invalidate, subtree invalidation, getFullTree                  |
| `ChangeEventBus`     | `change-event-bus.test.ts`     | Subscribe/emit, multiple subscribers, dispose cleanup                  |
| `MemoryProvider`     | `memory-provider.test.ts`      | All CRUD ops, exists, stat, readdir                                    |
| `ProviderRegistry`   | `provider-registry.test.ts`    | Caching, standalone instances, switch active, dispose                  |
| `FileService`        | `file-service.test.ts`         | Read/write routing, serialization, tree invalidation, change events    |
| `fileManagerMachine` | `file-manager.machine.test.ts` | State transitions, debounced refresh, BoundedFileCache, error recovery |


### Integration tests


| Test                                                   | Scope                                                  |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Bridge + FileService                                   | End-to-end RPC over MessageChannel with MemoryProvider |
| Bridge event channel                                   | Server emit → client listener over MessageChannel      |
| FileService write → tree invalidation → event emission | Full write pipeline                                    |


### Existing tests to update

- `apps/ui/app/machines/file-manager.test.ts` — Update to test `WriteCoordinator` directly
- `packages/kernels/src/framework/kernel-filesystem-bridge.test.ts` — Add event channel + port lifecycle tests
- `packages/kernels/src/filesystem/filesystem-wrappers.test.ts` — Update if `exposeFileSystem` signature changes

---

## Dependency Graph

```mermaid
flowchart TD
    types["Phase 1a: types.ts"]
    providers["Phase 1b: Providers"]
    registry["Phase 1c: ProviderRegistry"]
    cache["Phase 1d: BoundedFileCache"]
    wc["Phase 2a: WriteCoordinator"]
    dtc["Phase 2b: DirectoryTreeCache"]
    ceb["Phase 2c: ChangeEventBus"]
    fs["Phase 2d: FileService"]
    worker["Phase 2e: Worker entry"]
    bridge["Phase 3: Bridge events"]
    machine["Phase 4: Machine overhaul"]
    hook["Phase 5: Hook + consumers"]
    lazy["Phase 6: Lazy file tree"]
    ports["Phase 7: Port lifecycle"]
    cleanup["Phase 8: Cleanup"]

    types --> providers
    types --> cache
    providers --> registry
    registry --> fs
    wc --> fs
    dtc --> fs
    ceb --> fs
    fs --> worker
    bridge --> machine
    cache --> machine
    worker --> machine
    machine --> hook
    hook --> lazy
    bridge --> ports
    lazy --> cleanup
    ports --> cleanup
```



