import type { FileEntry, FileStatEntry, FileSystemBackend, FileStat } from '@taucad/types';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileTreeNode } from '@taucad/filesystem';
import type { FileContentService, ContentChangeEvent } from '#lib/file-content-service.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- filesystem is lazy-loaded via worker; this service runs on main thread
import { FileSystemObserverBridge } from '@taucad/filesystem';
import { normalizePath, joinPath } from '@taucad/utils/path';

const defaultDebounceMs = 100;
const watchIntervalFocusedMs = 2000;
const watchIntervalBlurredMs = 10_000;

export type FileItem = {
  path: string;
  size: number;
};

type FileTreeServiceInit = {
  proxy: FileManagerProxy;
  rootDirectory: string;
  initialEntries?: FileEntry[];
  debounceMs?: number;
};

/**
 * Single tree/metadata authority on the main thread.
 * All tree reads, directory listings, existence checks, and stat operations
 * go through this service. Owns the fileTree Map.
 */
export class FileTreeService {
  private _tree: Map<string, FileEntry>;
  private readonly proxy: FileManagerProxy;
  private rootDirectory: string;
  private readonly treeSubscribers = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRefreshPath = '';
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private contentUnsubscribe: (() => void) | undefined;
  private visibilityHandler: (() => void) | undefined;
  private readonly debounceMs: number;
  private _observerBridge: FileSystemObserverBridge | undefined;
  private _refreshAbortController: AbortController | undefined;
  private _cachedCompleteTree: FileItem[] | undefined;
  private _completeTreeVersion = 0;

  public constructor(init: FileTreeServiceInit) {
    this.proxy = init.proxy;
    this.rootDirectory = init.rootDirectory;
    this.debounceMs = init.debounceMs ?? defaultDebounceMs;
    this._tree = new Map();
    if (init.initialEntries) {
      for (const entry of init.initialEntries) {
        this._tree.set(entry.path, entry);
      }
    }
  }

  // === Tree Access (sync, from cache) ===

  /**
   * Returns the current tree Map. Stable reference when unchanged.
   * Required by `useSyncExternalStore`.
   */
  public getTreeSnapshot(): Map<string, FileEntry> {
    return this._tree;
  }

  /**
   * Monotonically increasing counter that increments on every tree change.
   * Consumers can use this to cheaply detect staleness.
   */
  public get completeTreeVersion(): number {
    return this._completeTreeVersion;
  }

  /**
   * Return a shared, cached list of all files. Re-fetches from worker only
   * when the cache has been invalidated by a tree change.
   */
  public async getCachedFileItems(): Promise<FileItem[]> {
    if (!this._cachedCompleteTree) {
      const entries = await this.getCompleteFileTree();
      this._cachedCompleteTree = entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => ({ path: entry.path, size: entry.size }));
    }
    return this._cachedCompleteTree;
  }

  /**
   * Get a single entry by path. Tree-first O(1), then proxy.stat fallback.
   */
  public async getEntry(path: string): Promise<FileEntry | undefined> {
    const cached = this._tree.get(path);
    if (cached) {
      return cached;
    }
    try {
      const absolutePath = joinPath(this.rootDirectory, path);
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
   */
  public async exists(path: string): Promise<boolean> {
    if (this._tree.has(path)) {
      return true;
    }
    try {
      const absolutePath = joinPath(this.rootDirectory, path);
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
   */
  public async readdir(path: string): Promise<string[]> {
    const prefix = path === '' ? '' : path.endsWith('/') ? path : `${path}/`;
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

    const absolutePath = joinPath(this.rootDirectory, path);
    return this.proxy.readdir(absolutePath);
  }

  /**
   * Get file stat via proxy.
   */
  public async stat(path: string): Promise<FileStat> {
    const absolutePath = joinPath(this.rootDirectory, path);
    return this.proxy.stat(absolutePath);
  }

  /**
   * Return the complete project file tree from the worker's InMemoryFileTree.
   * Paths are relative to the project root for consistency with the lazy tree.
   * Single RPC call, zero IDB hits when the tree is already built.
   */
  public async getCompleteFileTree(): Promise<FileStatEntry[]> {
    const entries = await this.getDirectoryStat('');
    const prefix = normalizePath(this.rootDirectory);
    const prefixSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return entries.map((entry) => ({
      ...entry,
      path: entry.path.startsWith(prefixSlash) ? entry.path.slice(prefixSlash.length) : entry.path,
    }));
  }

  /**
   * Get all file stats in a directory recursively via proxy.
   */
  public async getDirectoryStat(path: string): Promise<FileStatEntry[]> {
    const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
    return this.proxy.getDirectoryStat(absolutePath);
  }

  /**
   * Return full FileTreeNode[] for a directory via proxy.readDirectory.
   * Centralizes directory listing with consistent path resolution.
   */
  public async readDirectoryEntries(path: string): Promise<FileTreeNode[]> {
    const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
    return this.proxy.readDirectory(absolutePath);
  }

  /**
   * Search files on the worker's InMemoryFileTree. Returns only matching results.
   * The main thread never holds the full file index for interactive filtering.
   */
  public async searchFiles(
    query: string,
    options?: { maxResults?: number; includeDirectories?: boolean },
  ): Promise<FileStatEntry[]> {
    const absolutePath = normalizePath(this.rootDirectory);
    return this.proxy.searchFiles(absolutePath, query, options);
  }

  /**
   * Read shallow directory for files route.
   */
  public async readShallowDirectory(path: string, backend: FileSystemBackend): Promise<FileTreeNode[]> {
    return this.proxy.readShallowDirectory(path, backend);
  }

  /**
   * Remove a directory via proxy.
   */
  public async rmdir(path: string): Promise<void> {
    const absolutePath = joinPath(this.rootDirectory, path);
    await this.proxy.rmdir(absolutePath);
  }

  /**
   * Recursively delete a directory and all its contents via the worker.
   * The worker has complete filesystem knowledge; the lazy UI tree does not.
   */
  public async deleteDirectory(path: string): Promise<void> {
    const absolutePath = joinPath(this.rootDirectory, path);
    const entries = await this.proxy.getDirectoryStat(absolutePath);
    for (const entry of entries) {
      // oxlint-disable-next-line no-await-in-loop -- sequential deletes required
      await this.proxy.unlink(entry.path);
    }
    await this.proxy.rmdir(absolutePath);

    const prefix = path.endsWith('/') ? path : `${path}/`;
    const newTree = new Map(this._tree);
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
    }, this.debounceMs);
  }

  // === Change Detection (Observer preferred, polling fallback) ===

  /** Whether the observer is actively monitoring changes. */
  public get isObserving(): boolean {
    return this._observerBridge?.isObserving ?? false;
  }

  /**
   * Start observing via FileSystemObserver (Chrome 133+).
   * Returns `true` if the observer was started, `false` if unavailable.
   * When observer is active, polling is stopped to eliminate double work.
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

  /** Stop observing. Allows polling to be started again. */
  public stopObserving(): void {
    if (this._observerBridge) {
      this._observerBridge.disconnect();
      this._observerBridge = undefined;
    }
  }

  /**
   * Unified entry point for external change detection.
   * Tries FileSystemObserver first; falls back to polling.
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

  /** Stop all change detection (observer + polling). */
  public stopChangeDetection(): void {
    this.stopObserving();
    this.stopPolling();
  }

  public startPolling(): void {
    if (this.isObserving) {
      return;
    }

    this.stopPolling();

    const poll = (): void => {
      let interval: number;
      if (typeof document === 'undefined') {
        interval = watchIntervalBlurredMs;
      } else {
        interval = document.visibilityState === 'visible' ? watchIntervalFocusedMs : watchIntervalBlurredMs;
      }
      this.pollingTimer = setTimeout(() => {
        this.scheduleRefresh('');
        poll();
      }, interval);
    };

    poll();

    this.visibilityHandler = () => {
      this.stopPolling();
      poll();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  public stopPolling(): void {
    if (this.pollingTimer !== undefined) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.visibilityHandler) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
      }
      this.visibilityHandler = undefined;
    }
  }

  // === Content Change Subscription ===

  /**
   * Subscribe to content changes from FileContentService.
   * Skips tree refresh for `source === 'editor'` (editor typing doesn't
   * change tree structure). Otherwise applies optimistic update + schedules
   * debounced refresh.
   */
  public connectToContentService(contentService: FileContentService): void {
    this.contentUnsubscribe?.();
    this.contentUnsubscribe = contentService.onDidContentChange((event) => {
      this.handleContentChange(event);
    });
  }

  // === Worker Push Events ===

  public handleWorkerFileChanged(_event: unknown): void {
    this.scheduleRefresh('');
  }

  // === Tree Subscriptions (useSyncExternalStore) ===

  public subscribeTree(callback: () => void): () => void {
    this.treeSubscribers.add(callback);
    return () => {
      this.treeSubscribers.delete(callback);
    };
  }

  // === Lifecycle ===

  public reset(rootDirectory: string, initialEntries?: FileEntry[]): void {
    this.rootDirectory = rootDirectory;
    this._refreshAbortController?.abort();
    this._refreshAbortController = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingRefreshPath = '';

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
   */
  public async loadDirectory(path: string): Promise<void> {
    try {
      const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
      const entries = await this.proxy.readDirectory(absolutePath);
      this.patchDirectoryEntries(path, entries);
    } catch (error) {
      console.error('[FileTreeService] loadDirectory failed:', error);
    }
  }

  /**
   * Check whether a directory's children have been loaded into the tree.
   */
  public hasChildrenLoaded(path: string): boolean {
    const prefix = path === '' ? '' : path.endsWith('/') ? path : `${path}/`;
    for (const key of this._tree.keys()) {
      if (prefix === '') {
        if (!key.includes('/')) {
          return true;
        }
      } else if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        return true;
      }
    }
    return false;
  }

  public dispose(): void {
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
        this.optimisticAdd(event.path, event.data.byteLength);
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
    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? path.slice(0, lastSlash) : '';
    this.scheduleRefresh(parentPath);
  }

  private async executeRefresh(path: string): Promise<void> {
    this._refreshAbortController?.abort();
    const controller = new AbortController();
    this._refreshAbortController = controller;

    try {
      const absolutePath = path === '' ? normalizePath(this.rootDirectory) : joinPath(this.rootDirectory, path);
      const entries = await this.proxy.readDirectory(absolutePath);
      if (controller.signal.aborted) {
        return;
      }
      this.patchDirectoryEntries(path, entries);
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
    this.notifyTreeSubscribers();
  }
}
