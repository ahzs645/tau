import type { FileEntry, FileStatEntry, FileSystemBackend, FileStat } from '@taucad/types';
import type { FileTreeNode } from '@taucad/filesystem';
import { FileSystemObserverBridge } from '@taucad/filesystem';
import type { FileContentService, ContentChangeEvent } from '#file-content-service.js';
import type { FileSystemClient } from '#file-system-client.js';
import type { WorkerChangeChannel, WorkerRelativeRenameEvent } from '#worker-change-channel.js';
import type { WorkspacePathResolver } from '#workspace-path-resolver.js';
import type { VisibilityProvider } from '#visibility-provider.js';
import { joinPath } from '@taucad/utils/path';

/** Milliseconds. */
const defaultRefreshDebounce = 100;
/** Milliseconds. */
const watchIntervalFocused = 2000;
/** Milliseconds. */
const watchIntervalBlurred = 10_000;

/**
 * Lightweight file listing entry for search / complete-tree snapshots.
 *
 * @public
 */
export type FileItem = {
  path: string;
  size: number;
};

/**
 * Stat-enriched directory entry returned by
 * {@link FileTreeService.readDirectoryEntriesWithStats}.
 *
 * @public
 */
export type DirectoryEntryWithStat = {
  name: string;
  type: 'file' | 'dir';
  /** File size in bytes, or `0` for directories. */
  size: number;
  /** Last-modified timestamp in milliseconds since the Unix epoch. */
  mtimeMs: number;
};

type FileTreeServiceInit = {
  proxy: FileSystemClient;
  paths: WorkspacePathResolver;
  channel: WorkerChangeChannel;
  visibility: VisibilityProvider;
  initialEntries?: FileEntry[];
  /** Debounce window between subsequent tree-refresh fires. Milliseconds. */
  refreshDebounce?: number;
};

/**
 * Single tree/metadata authority on the main thread.
 * All tree reads, directory listings, existence checks, and stat operations
 * go through this service. Owns the fileTree Map.
 *
 * @public
 * @example <caption>Construct a file tree service for tests</caption>
 * ```typescript
 * import { FileTreeService } from '@taucad/fs-client/file-tree-service';
 * import { WorkerChangeChannel } from '@taucad/fs-client/worker-change-channel';
 * import { WorkspacePathResolver } from '@taucad/fs-client/workspace-path-resolver';
 * import { headlessVisibilityProvider } from '@taucad/fs-client/visibility-provider';
 * import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
 * import type { WorkerChangeChannelTransport } from '@taucad/fs-client/worker-change-channel';
 * export function createExampleFileTreeService(
 *   proxy: FileSystemClient,
 *   listen: WorkerChangeChannelTransport['listen'],
 * ): FileTreeService {
 *   const paths = new WorkspacePathResolver('/project');
 *   const channel = new WorkerChangeChannel({ transport: { listen }, paths });
 *   return new FileTreeService({
 *     proxy,
 *     paths,
 *     channel,
 *     visibility: headlessVisibilityProvider,
 *   });
 * }
 * ```
 */
export class FileTreeService {
  private _tree: Map<string, FileEntry>;
  private readonly proxy: FileSystemClient;
  private readonly paths: WorkspacePathResolver;
  private readonly visibility: VisibilityProvider;
  private readonly treeSubscribers = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRefreshPath = '';
  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private visibilityUnsub: (() => void) | undefined;
  private contentUnsubscribe: (() => void) | undefined;
  /** Milliseconds. */
  private readonly refreshDebounce: number;
  private _observerBridge: FileSystemObserverBridge | undefined;
  private _refreshAbortController: AbortController | undefined;
  private _cachedCompleteTree: FileItem[] | undefined;
  private _completeTreeVersion = 0;
  private _searchIndexWarmed = false;
  private readonly _resolvedDirectories = new Set<string>();
  private readonly unsubscribeChannel: Array<() => void>;

  public constructor(init: FileTreeServiceInit) {
    this.proxy = init.proxy;
    this.paths = init.paths;
    this.visibility = init.visibility;
    this.refreshDebounce = init.refreshDebounce ?? defaultRefreshDebounce;
    this._tree = new Map();
    if (init.initialEntries) {
      for (const entry of init.initialEntries) {
        this._tree.set(entry.path, entry);
      }
      this._resolvedDirectories.add('');
    }
    this.unsubscribeChannel = [
      init.channel.onFileWritten({
        interestedIn: (relativePath) => this._resolvedDirectories.has(this.paths.parentOf(relativePath)),
        handler: (event) => {
          this.handleFileWrittenRelative(event.path);
        },
      }),
      init.channel.onFileDeleted({
        handler: (event) => {
          this.handleFileDeletedRelative(event.path);
        },
      }),
      init.channel.onFileRenamed({
        interestedIn: (relativePath) => this._resolvedDirectories.has(this.paths.parentOf(relativePath)),
        handler: (event) => {
          this.handleFileRenamedRelative(event);
        },
      }),
      init.channel.onDirectoryChanged({
        interestedIn: (relativeDirectory) => this._resolvedDirectories.has(relativeDirectory),
        handler: (event) => {
          this.handleDirectoryChangedRelative(event.path);
        },
      }),
      init.channel.onBackendChanged(() => {
        this.scheduleRefresh('');
      }),
    ];
  }

  // === Tree Access (sync, from cache) ===

  /**
   * Returns the current tree Map. Stable reference when unchanged.
   * Required by `useSyncExternalStore`.
   * @returns Mutable backing map of {@link FileEntry} records keyed by path.
   */
  public getTreeSnapshot(): Map<string, FileEntry> {
    return this._tree;
  }

  /**
   * Monotonically increasing counter that increments on every tree change.
   * Consumers can use this to cheaply detect staleness.
   * @returns Current tree revision counter.
   */
  public get completeTreeVersion(): number {
    return this._completeTreeVersion;
  }

  /**
   * Return a cached list of all file entries currently in the lazy tree.
   * Derives synchronously from `_tree` — no worker RPC. The list grows
   * progressively as directories are expanded via `loadDirectory`.
   * @returns Lightweight {@link FileItem} records for all known files.
   */
  public getCachedFileItems(): FileItem[] {
    this._cachedCompleteTree ??= [...this._tree.values()]
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.path, size: entry.size }));
    return this._cachedCompleteTree;
  }

  /**
   * Get a single entry by path. Tree-first O(1), then proxy.stat fallback.
   * @param path - User or workspace-relative path string.
   * @returns Cached or freshly-stated {@link FileEntry}, or `undefined` when absent.
   */
  public async getEntry(path: string): Promise<FileEntry | undefined> {
    const relativeKey = this.relativeKeyFromUserPath(path);
    const cached = this._tree.get(path) ?? this._tree.get(relativeKey);
    if (cached) {
      return cached;
    }
    try {
      const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
      const stat = await this.proxy.stat(absolutePath);
      return {
        path,
        name: path.split('/').pop() ?? path,
        type: stat.type,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isLoaded: false,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Check if a path exists. Tree-first O(1), then proxy.stat fallback.
   * @param path - User or workspace-relative path string.
   * @returns `true` when the path resolves to an on-disk object.
   */
  public async exists(path: string): Promise<boolean> {
    const relativeKey = this.relativeKeyFromUserPath(path);
    if (this._tree.has(path) || this._tree.has(relativeKey)) {
      return true;
    }
    try {
      const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
      await this.proxy.stat(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  // === Metadata Operations (async, proxy) ===

  /**
   * List directory contents from the cached tree. Falls back to proxy
   * if tree appears stale or empty.
   * @param path - Directory path relative to workspace conventions.
   * @returns Child names within the directory when known to the lazy tree or worker.
   */
  public async readdir(path: string): Promise<string[]> {
    const relativeKey = this.relativeDirectoryKeyFromUserPath(path);
    const prefix = relativeKey === '' ? '' : relativeKey.endsWith('/') ? relativeKey : `${relativeKey}/`;
    const results: string[] = [];

    for (const [entryPath, entry] of this._tree) {
      if (prefix === '') {
        if (!entryPath.includes('/')) {
          results.push(entry.name);
        }
      } else if (entryPath.startsWith(prefix)) {
        const remainder = entryPath.slice(prefix.length);
        if (!remainder.includes('/')) {
          results.push(entry.name);
        }
      }
    }

    if (results.length > 0) {
      return results;
    }

    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    return this.proxy.readdir(absolutePath);
  }

  /**
   * Get file stat via proxy.
   * @param path - Resolvable path string (workspace-relative forms allowed).
   * @returns Worker-backed {@link FileStat}.
   */
  public async stat(path: string): Promise<FileStat> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    return this.proxy.stat(absolutePath);
  }

  /**
   * Get all file stats in a directory recursively via proxy.
   * @param path - Directory path to enumerate.
   * @returns Recursive listing from the worker index.
   */
  public async getDirectoryStat(path: string): Promise<FileStatEntry[]> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    return this.proxy.getDirectoryStat(absolutePath);
  }

  /**
   * Return full FileTreeNode[] for a directory via proxy.readDirectory.
   * Centralizes directory listing with consistent path resolution.
   * @param path - Directory whose children should be loaded.
   * @returns Parsed tree nodes from the worker listing.
   */
  public async readDirectoryEntries(path: string): Promise<FileTreeNode[]> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    return this.proxy.readDirectory(absolutePath);
  }

  /**
   * Stat-aware companion to {@link readDirectoryEntries}. Returns one entry
   * per immediate child with real `size` / `mtimeMs` populated by per-child
   * `proxy.stat` calls, fanned out in parallel.
   *
   * Used by the chat RPC `readdir` adapter so `list_directory` /
   * `glob_search` surface authoritative byte counts to the agent instead of
   * a synthetic `0`. Stat failures (entry deleted between readDirectory and
   * stat) fall back to `size: 0`/`mtimeMs: 0` so the listing still resolves.
   * @param path - Directory whose children require authoritative stat metadata.
   * @returns Stat-enriched entries for immediate children.
   */
  public async readDirectoryEntriesWithStats(path: string): Promise<DirectoryEntryWithStat[]> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    const nodes = await this.proxy.readDirectory(absolutePath);
    return Promise.all(
      nodes.map(async (node) => {
        const inferredType: 'file' | 'dir' = node.children === undefined ? 'file' : 'dir';
        try {
          const childAbsolute = joinPath(absolutePath, node.name);
          const childStat = await this.proxy.stat(childAbsolute);
          return {
            name: node.name,
            type: childStat.type,
            size: childStat.size,
            mtimeMs: childStat.mtimeMs,
          };
        } catch {
          return { name: node.name, type: inferredType, size: 0, mtimeMs: 0 };
        }
      }),
    );
  }

  /**
   * Search files on the worker's InMemoryFileTree. Returns only matching results.
   * The main thread never holds the full file index for interactive filtering.
   * @param query - Free-text search string understood by the worker search index.
   * @param options - Optional cap / directory inclusion flags forwarded to the proxy.
   * @returns Matching {@link FileStatEntry} records from the worker.
   */
  public async searchFiles(
    query: string,
    options?: { maxResults?: number; includeDirectories?: boolean },
  ): Promise<FileStatEntry[]> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath('');
    if (!this._searchIndexWarmed) {
      await this.proxy.getDirectoryStat(absolutePath);
      this._searchIndexWarmed = true;
    }
    return this.proxy.searchFiles(absolutePath, query, options);
  }

  /**
   * Read shallow directory for files route.
   * @param path - Directory to read shallowly on the requested backend.
   * @param backend - Filesystem backend identifier for disambiguation.
   * @returns Immediate children as {@link FileTreeNode} stubs.
   */
  public async readShallowDirectory(path: string, backend: FileSystemBackend): Promise<FileTreeNode[]> {
    return this.proxy.readShallowDirectory(path, backend);
  }

  /**
   * Remove a directory via proxy.
   * @param path - Workspace-relative directory to remove (must be empty per worker semantics).
   */
  public async rmdir(path: string): Promise<void> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    await this.proxy.rmdir(absolutePath);
  }

  /**
   * Recursively delete a directory and all its contents via the worker.
   * The worker has complete filesystem knowledge; the lazy UI tree does not.
   * @param path - Directory to delete recursively.
   */
  public async deleteDirectory(path: string): Promise<void> {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    const relativeKey = this.relativeDirectoryKeyFromUserPath(path);
    const entries = await this.proxy.getDirectoryStat(absolutePath);

    const subdirs = new Set<string>();
    for (const entry of entries) {
      const entryPath = entry.path.startsWith('/') ? entry.path : joinPath(absolutePath, entry.path);
      // oxlint-disable-next-line no-await-in-loop -- sequential deletes required
      await this.proxy.unlink(entryPath);

      // Derive intermediate directories between absolutePath and the file
      const relativePart = entry.path.startsWith('/') ? entryPath.slice(absolutePath.length + 1) : entry.path;
      const parts = relativePart.split('/');
      for (let i = 1; i < parts.length; i++) {
        subdirs.add(joinPath(absolutePath, parts.slice(0, i).join('/')));
      }
    }

    // Rmdir subdirectories deepest-first, then the top-level directory
    const sortedSubdirs = [...subdirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const directory of sortedSubdirs) {
      // oxlint-disable-next-line no-await-in-loop -- deepest-first ordering required
      await this.proxy.rmdir(directory);
    }
    await this.proxy.rmdir(absolutePath);

    const prefix = relativeKey === '' ? '' : relativeKey.endsWith('/') ? relativeKey : `${relativeKey}/`;
    const newTree = new Map(this._tree);
    newTree.delete(relativeKey);
    newTree.delete(path);
    for (const key of newTree.keys()) {
      if (key.startsWith(prefix)) {
        newTree.delete(key);
      }
    }
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  // === Refresh Control ===

  /**
   * Debounce tree refresh. Multiple calls coalesce to common ancestor.
   * @param path - Path hint whose refresh should be merged with pending work.
   */
  public scheduleRefresh(path: string): void {
    if (this.pendingRefreshPath === '' || path === '') {
      this.pendingRefreshPath = path;
    } else {
      const currentParts = this.pendingRefreshPath.split('/');
      const newParts = path.split('/');
      const commonParts: string[] = [];
      for (let i = 0; i < Math.min(currentParts.length, newParts.length); i++) {
        if (currentParts[i] === newParts[i]) {
          commonParts.push(currentParts[i]!);
        } else {
          break;
        }
      }
      this.pendingRefreshPath = commonParts.join('/');
    }

    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.executeRefresh(this.pendingRefreshPath);
      this.pendingRefreshPath = '';
    }, this.refreshDebounce);
  }

  // === Change Detection (Observer preferred, polling fallback) ===

  /**
   * Whether the observer is actively monitoring changes.
   * @returns `true` when a native {@link FileSystemObserverBridge} session is active.
   */
  public get isObserving(): boolean {
    return this._observerBridge?.isObserving ?? false;
  }

  /**
   * Start observing via FileSystemObserver (Chrome 133+).
   * Returns `true` if the observer was started, `false` if unavailable.
   * When observer is active, polling is stopped to eliminate double work.
   * @param handle - Native directory handle supplied by the host picker.
   * @returns `true` when observation started successfully.
   */
  public async startObserving(handle: FileSystemDirectoryHandle): Promise<boolean> {
    this.stopPolling();

    this._observerBridge = new FileSystemObserverBridge((event) => {
      const path = 'path' in event ? event.path : '';
      this.scheduleRefresh(path);
    });

    const started = await this._observerBridge.observe(handle);
    if (!started) {
      this._observerBridge = undefined;
      return false;
    }
    return true;
  }

  /**
   * Stop observing. Allows polling to be started again.
   * @returns `void` after tearing down the observer bridge, if any.
   */
  public stopObserving(): void {
    if (this._observerBridge) {
      this._observerBridge.disconnect();
      this._observerBridge = undefined;
    }
  }

  /**
   * Unified entry point for external change detection.
   * Tries FileSystemObserver first; falls back to polling.
   * @param handle - Optional host handle enabling native observation.
   */
  public async startChangeDetection(handle?: FileSystemDirectoryHandle): Promise<void> {
    if (handle) {
      const observerStarted = await this.startObserving(handle);
      if (observerStarted) {
        return;
      }
    }
    this.startPolling();
  }

  /**
   * Stop all change detection (observer + polling).
   * @returns `void` once timers/observer subscriptions are cleared.
   */
  public stopChangeDetection(): void {
    this.stopObserving();
    this.stopPolling();
  }

  /**
   * Begin polling the worker on a visibility-aware interval when observers are unavailable.
   */
  public startPolling(): void {
    if (this.isObserving) {
      return;
    }

    this.stopPolling();

    const poll = (): void => {
      const pollInterval = this.visibility.isVisible() ? watchIntervalFocused : watchIntervalBlurred;
      this.pollingTimer = setTimeout(() => {
        this.scheduleRefresh('');
        poll();
      }, pollInterval);
    };

    poll();

    this.visibilityUnsub = this.visibility.onVisibilityChange(() => {
      this.stopPolling();
      poll();
    });
  }

  /**
   * Tear down polling timers and visibility subscriptions.
   */
  public stopPolling(): void {
    if (this.pollingTimer !== undefined) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.visibilityUnsub !== undefined) {
      this.visibilityUnsub();
      this.visibilityUnsub = undefined;
    }
  }

  // === Content Change Subscription ===

  /**
   * Subscribe to content changes from FileContentService.
   * Skips tree refresh for `source === 'editor'` (editor typing doesn't
   * change tree structure). Otherwise applies optimistic update + schedules
   * debounced refresh.
   * @param contentService - Live content authority emitting mutation events.
   */
  public connectToContentService(contentService: FileContentService): void {
    this.contentUnsubscribe?.();
    this.contentUnsubscribe = contentService.onDidContentChange((event) => {
      this.handleContentChange(event);
    });
  }

  // === Tree Subscriptions (useSyncExternalStore) ===

  /**
   * Subscribe to tree mutations for `useSyncExternalStore` consumers.
   * @param callback - Invoked after the internal Map snapshot changes.
   * @returns Unsubscribe function removing `callback`.
   */
  public subscribeTree(callback: () => void): () => void {
    this.treeSubscribers.add(callback);
    return () => {
      this.treeSubscribers.delete(callback);
    };
  }

  // === Lifecycle ===

  /**
   * Reset tree caches when the workspace root or bootstrap entries change.
   * @param rootDirectory - New worker root path.
   * @param initialEntries - Optional seed entries for eagerly known files.
   */
  public reset(rootDirectory: string, initialEntries?: FileEntry[]): void {
    this.paths.reset(rootDirectory);
    this._refreshAbortController?.abort();
    this._refreshAbortController = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingRefreshPath = '';
    this._searchIndexWarmed = false;
    this._resolvedDirectories.clear();

    const newTree = new Map<string, FileEntry>();
    if (initialEntries) {
      for (const entry of initialEntries) {
        newTree.set(entry.path, entry);
      }
    }
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  /**
   * Load a directory's immediate children from the worker. Patches the tree
   * Map at this level only (no recursive walk). Idempotent — safe to call
   * for already-loaded directories.
   * @param path - Directory path to hydrate into {@link FileTreeService.getTreeSnapshot}.
   */
  public async loadDirectory(path: string): Promise<void> {
    try {
      const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
      const relativeDirectory = this.relativeDirectoryKeyFromUserPath(path);
      const entries = await this.proxy.readDirectory(absolutePath);
      this.patchDirectoryEntries(relativeDirectory, entries);
    } catch (error) {
      console.error('[FileTreeService] loadDirectory failed:', error);
    }
  }

  /**
   * Check whether a directory's children have been loaded into the tree.
   * @param path - Directory key to query in the resolved-directory ledger.
   * @returns `true` when lazy loading previously completed for `path`.
   */
  public hasChildrenLoaded(path: string): boolean {
    return this._resolvedDirectories.has(path);
  }

  /**
   * Dispose worker subscriptions, timers, and in-flight refresh controllers.
   */
  public dispose(): void {
    for (const unsubscribe of this.unsubscribeChannel) {
      unsubscribe();
    }
    this.stopChangeDetection();
    this._refreshAbortController?.abort();
    this._refreshAbortController = undefined;
    this.contentUnsubscribe?.();
    this.contentUnsubscribe = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.treeSubscribers.clear();
    this._resolvedDirectories.clear();
  }

  private relativeKeyFromUserPath(path: string): string {
    const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
    return this.paths.toRelativePath(absolutePath) ?? '';
  }

  /**
   * Workspace-relative directory key for {@link patchDirectoryEntries} and tree-prefix scans.
   * @param path - User-supplied path (any alias accepted by {@link WorkspacePathResolver.toAbsoluteWorkspacePath}).
   * @returns Workspace-relative directory key used for lazy-tree bookkeeping.
   */
  private relativeDirectoryKeyFromUserPath(path: string): string {
    return this.relativeKeyFromUserPath(path);
  }

  // === Private: Worker Event Handlers (workspace-relative paths) ===

  private handleFileWrittenRelative(relativePath: string): void {
    const parentPath = this.paths.parentOf(relativePath);
    if (this._resolvedDirectories.has(parentPath)) {
      this.optimisticAdd(relativePath, 0);
    }
  }

  private handleFileDeletedRelative(relativePath: string): void {
    this.optimisticDelete(relativePath);
  }

  private handleFileRenamedRelative(event: WorkerRelativeRenameEvent): void {
    const oldRelative = event.oldPath;
    const newRelative = event.newPath;
    if (oldRelative !== undefined && newRelative !== undefined) {
      this.optimisticRename(oldRelative, newRelative);
      return;
    }
    if (oldRelative !== undefined) {
      this.optimisticDelete(oldRelative);
      return;
    }
    if (newRelative !== undefined) {
      const parentPath = this.paths.parentOf(newRelative);
      if (this._resolvedDirectories.has(parentPath)) {
        this.optimisticAdd(newRelative, 0);
      }
    }
  }

  private handleDirectoryChangedRelative(relativePath: string): void {
    if (this._resolvedDirectories.has(relativePath)) {
      this.scheduleRefresh(relativePath);
    }
  }

  private notifyTreeSubscribers(): void {
    this._cachedCompleteTree = undefined;
    this._completeTreeVersion++;
    for (const callback of this.treeSubscribers) {
      callback();
    }
  }

  private handleContentChange(event: ContentChangeEvent): void {
    switch (event.type) {
      case 'written': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticAdd(event.path, event.data.byteLength);
        this.scheduleRefreshForParent(event.path);
        break;
      }
      case 'deleted': {
        if (event.source === 'editor') {
          return;
        }
        this.optimisticDelete(event.path);
        this.scheduleRefreshForParent(event.path);
        break;
      }
      case 'renamed': {
        this.optimisticRename(event.oldPath, event.newPath);
        this.scheduleRefreshForParent(event.oldPath);
        this.scheduleRefreshForParent(event.newPath);
        break;
      }
      case 'batchWritten': {
        for (const path of event.paths) {
          this.scheduleRefreshForParent(path);
        }
        break;
      }
      case 'read': {
        break;
      }
    }
  }

  private optimisticAdd(path: string, size: number): void {
    const parts = path.split('/');
    const name = parts.at(-1) ?? path;
    const newTree = new Map(this._tree);
    newTree.set(path, { path, name, type: 'file', size, mtimeMs: Date.now(), isLoaded: false });
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private optimisticDelete(path: string): void {
    if (!this._tree.has(path)) {
      return;
    }
    const newTree = new Map(this._tree);
    newTree.delete(path);
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private optimisticRename(oldPath: string, newPath: string): void {
    const entry = this._tree.get(oldPath);
    if (!entry) {
      return;
    }
    const parts = newPath.split('/');
    const name = parts.at(-1) ?? newPath;
    const newTree = new Map(this._tree);
    newTree.delete(oldPath);
    newTree.set(newPath, { ...entry, path: newPath, name });
    this._tree = newTree;
    this.notifyTreeSubscribers();
  }

  private scheduleRefreshForParent(path: string): void {
    this.scheduleRefresh(this.paths.parentOf(path));
  }

  private async executeRefresh(path: string): Promise<void> {
    this._refreshAbortController?.abort();
    const controller = new AbortController();
    this._refreshAbortController = controller;

    try {
      const absolutePath = this.paths.toAbsoluteWorkspacePath(path);
      const relativeDirectory = this.relativeDirectoryKeyFromUserPath(path);
      const entries = await this.proxy.readDirectory(absolutePath);
      if (controller.signal.aborted) {
        return;
      }
      this.patchDirectoryEntries(relativeDirectory, entries);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('[FileTreeService] refresh failed:', error);
    }
  }

  /**
   * Patch the tree Map with fresh entries from a single-level `readDirectory`.
   * Removes stale direct children at this level, adds fresh entries.
   * @param path - Workspace-relative directory key (`''` for root-level listing).
   * @param entries - Immediate child nodes returned by the worker.
   */
  private patchDirectoryEntries(path: string, entries: FileTreeNode[]): void {
    const newTree = new Map(this._tree);
    const prefix = path === '' ? '' : path.endsWith('/') ? path : `${path}/`;

    for (const key of newTree.keys()) {
      if (prefix === '') {
        if (!key.includes('/')) {
          newTree.delete(key);
        }
      } else if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        newTree.delete(key);
      }
    }

    for (const entry of entries) {
      const entryPath = prefix ? `${prefix}${entry.name}` : entry.name;
      newTree.set(entryPath, {
        path: entryPath,
        name: entry.name,
        type: entry.children === undefined ? 'file' : 'dir',
        size: 0,
        mtimeMs: Date.now(),
        isLoaded: false,
      });
    }

    this._tree = newTree;
    this._resolvedDirectories.add(path);
    this.notifyTreeSubscribers();
  }
}
