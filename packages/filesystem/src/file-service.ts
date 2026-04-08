import type { FileStat, FileStatEntry, FileSystemBackend } from '@taucad/types';
import type {
  FileTreeNode,
  ProviderFileStat,
  TreeEntry,
  WatchRequest,
  WatchEvent,
  FileReadStreamOptions,
} from '#types.js';
import type { ProviderRegistry } from '#provider-registry.js';
import type { ResourceQueue } from '#resource-queue.js';
import type { DirectoryTreeCache } from '#directory-tree-cache.js';
import type { ChangeEventBus } from '#change-event-bus.js';
import { InMemoryFileTree } from '#in-memory-file-tree.js';
import { WatchRegistry } from '#watch-registry.js';
import { bufferToStream } from '#providers/stream-utils.js';
import { CrossTabCoordinator } from '#cross-tab-coordinator.js';
import type { SharedPool } from '@taucad/memory';
import type { MountTable, MountOptions, MountResolution } from '#mount-table.js';
import { parentDirectory, joinPath, normalizePath } from '@taucad/utils/path';

const kernelCoalescingWindowMs = 75;

function toFileStat(stat: ProviderFileStat): FileStat {
  return {
    type: stat.isDirectory ? 'dir' : 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Options for {@link FileService.mkdir}.
 * @public
 */
export type MkdirOptions = {
  mode?: number;
  recursive?: boolean;
};

/**
 * High-level filesystem service that coordinates reads, writes, caching,
 * and watch subscriptions across pluggable storage providers.
 * @public
 */
export class FileService {
  private readonly _registry: ProviderRegistry;
  private readonly _resourceQueue: ResourceQueue;
  private readonly _treeCache: DirectoryTreeCache;
  private readonly _eventBus: ChangeEventBus;
  private readonly _watchRegistry: WatchRegistry;
  private readonly _crossTabCoordinator: CrossTabCoordinator;
  private _contentPool: SharedPool | undefined;
  private readonly _mountTable: MountTable;
  private readonly _inMemoryTree = new InMemoryFileTree();
  /** Absolute path passed to the first {@link getDirectoryStat} that populated the tree; in-memory paths are relative to this root. */
  private _directoryStatRoot: string | undefined;

  /**
   * Create a FileService with injected dependencies.
   *
   * @param options - Service dependencies injected at construction time.
   */
  public constructor(options: {
    providerRegistry: ProviderRegistry;
    resourceQueue: ResourceQueue;
    treeCache: DirectoryTreeCache;
    eventBus: ChangeEventBus;
    crossTabCoordinator?: CrossTabCoordinator;
    /** Writer-side shared content pool for zero-IPC cached reads across threads. */
    contentPool?: SharedPool;
    /** Mount table for multi-backend path routing. */
    mountTable: MountTable;
  }) {
    this._registry = options.providerRegistry;
    this._resourceQueue = options.resourceQueue;
    this._treeCache = options.treeCache;
    this._eventBus = options.eventBus;
    this._watchRegistry = new WatchRegistry(options.eventBus, { windowMs: kernelCoalescingWindowMs });
    this._crossTabCoordinator = options.crossTabCoordinator ?? new CrossTabCoordinator();
    this._contentPool = options.contentPool;
    this._mountTable = options.mountTable;
  }

  /**
   * Set or replace the shared content pool for zero-IPC cached reads.
   * Enables late binding when the SharedArrayBuffer arrives after construction.
   *
   * @param pool - Writer-side shared content pool.
   */
  public setContentPool(pool: SharedPool): void {
    this._contentPool = pool;
  }

  // --- Read operations (direct to provider, no serialization) ---

  /**
   * Read a single file. Pass `'utf8'` to decode as a string.
   *
   * @param filepath - Absolute path to the file.
   * @param options - Encoding option; omit for raw bytes.
   * @returns File contents as a string or `Uint8Array`.
   */
  public async readFile(
    filepath: string,
    options?: 'utf8' | { encoding?: 'utf8'; signal?: AbortSignal },
  ): Promise<string | Uint8Array<ArrayBuffer>> {
    const signal = typeof options === 'object' ? options.signal : undefined;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const { provider, path: resolvedPath } = this._resolveProvider(filepath);
    const encoding =
      options === 'utf8' || (typeof options === 'object' && options.encoding === 'utf8') ? 'utf8' : undefined;

    if (encoding === 'utf8') {
      return provider.readFile(resolvedPath, 'utf8');
    }
    const data = await provider.readFile(resolvedPath);
    this._contentPool?.store(filepath, data);
    return data;
  }

  /**
   * Read multiple files in parallel, returning a map of path to raw bytes.
   *
   * @param paths - Absolute file paths to read.
   * @param options - Optional abort signal for cancellation.
   * @returns Map from path to file content.
   */
  public async readFiles(
    paths: string[],
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const results = await Promise.all(
      paths.map(async (filepath) => {
        if (options?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const { provider, path: resolvedPath } = this._resolveProvider(filepath);
        const data = await provider.readFile(resolvedPath);
        return [filepath, data] as const;
      }),
    );
    return Object.fromEntries(results);
  }

  /**
   * Stream a file as `ReadableStream<Uint8Array>`.
   * Routes to the provider's native `readFileStream` when available (capability-based),
   * otherwise falls back to wrapping `readFile` output in a chunked stream.
   *
   * @param filepath - Absolute path to the file.
   * @param options - Position, length, and signal for cancellation.
   * @returns Readable stream of file content.
   */
  public async readFileStream(
    filepath: string,
    options?: FileReadStreamOptions,
  ): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const { provider, path: resolvedPath } = this._resolveProvider(filepath);

    if (provider.readFileStream) {
      return provider.readFileStream(resolvedPath, options);
    }

    const buffer = await provider.readFile(resolvedPath);
    return bufferToStream(buffer, options);
  }

  /**
   * List entries in a directory.
   *
   * @param path - Absolute directory path.
   * @returns Array of entry names (not full paths).
   */
  public async readdir(path: string): Promise<string[]> {
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    const entries = await provider.readdir(resolvedPath);

    const childMounts = this._mountTable.getMountsUnder(path);
    for (const mount of childMounts) {
      const mountName = mount.prefix.split('/').pop();
      if (mountName && !entries.includes(mountName)) {
        entries.push(mountName);
      }
    }

    return entries;
  }

  /**
   * Get file or directory metadata.
   *
   * @param path - Absolute path.
   * @returns Stat information (type, size, mtime).
   */
  public async stat(path: string): Promise<FileStat> {
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    return toFileStat(await provider.stat(resolvedPath));
  }

  /**
   * Get file or directory metadata without following symlinks.
   *
   * @param path - Absolute path.
   * @returns Stat information (type, size, mtime).
   */
  public async lstat(path: string): Promise<FileStat> {
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    return toFileStat(await provider.lstat(resolvedPath));
  }

  /**
   * Check whether a file or directory exists.
   *
   * @param path - Absolute path.
   * @returns `true` if the entry exists.
   */
  public async exists(path: string): Promise<boolean> {
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    return provider.exists(resolvedPath);
  }

  /**
   * Check existence of multiple paths in parallel.
   *
   * @param paths - Absolute paths to check.
   * @returns Map from path to existence boolean.
   */
  public async batchExists(paths: string[]): Promise<Record<string, boolean>> {
    const results = await Promise.all(
      paths.map(async (path) => {
        const { provider, path: resolvedPath } = this._resolveProvider(path);
        return { path, exists: await provider.exists(resolvedPath) };
      }),
    );
    const existsMap: Record<string, boolean> = {};
    for (const { path, exists } of results) {
      existsMap[path] = exists;
    }
    return existsMap;
  }

  // --- Write operations (serialized via per-file ResourceQueue) ---

  /**
   * Write data to a file, creating parent directories as needed.
   * Serialized per file path through the {@link ResourceQueue}.
   *
   * @param path - Absolute file path.
   * @param data - File content as raw bytes or a UTF-8 string.
   * @returns Resolves when the write completes.
   */
  public async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
    return this._crossTabCoordinator.withWriteLock(path, async () =>
      this._resourceQueue.queueFor(path, async () => {
        const { provider, path: resolvedPath, backend: resolvedBackend } = this._resolveProvider(path);
        await this._ensureParentDir(provider, resolvedPath);
        await provider.writeFile(resolvedPath, data);

        this._contentPool?.invalidate(path);
        const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
        this._inMemoryTreeAddFile(path, size);
        this._treeCache.invalidate(parentDirectory(path));
        this._eventBus.emit({
          type: 'fileWritten',
          path,
          backend: resolvedBackend,
        });
      }),
    );
  }

  /**
   * Write multiple files atomically within a single serialized operation.
   *
   * @param files - Map of absolute path to content.
   * @returns Resolves when all writes complete.
   */
  public async writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> | string }>): Promise<void> {
    const entries = Object.entries(files);
    if (entries.length === 0) {
      return;
    }

    const resolvedBackend = this._mountTable.resolve('/').backend;
    await Promise.all(
      entries.map(async ([path, file]) =>
        this._resourceQueue.queueFor(path, async () => {
          const { provider, path: resolvedPath } = this._resolveProvider(path);
          await this._ensureParentDir(provider, resolvedPath);
          await provider.writeFile(resolvedPath, file.content);
          const size =
            typeof file.content === 'string'
              ? new TextEncoder().encode(file.content).byteLength
              : file.content.byteLength;
          this._inMemoryTreeAddFile(path, size);
        }),
      ),
    );

    const parentDirectories = new Set(entries.map(([p]) => parentDirectory(p)));
    for (const directory of parentDirectories) {
      this._treeCache.invalidate(directory);
    }
    this._eventBus.emit({
      type: 'directoryChanged',
      path: '/',
      backend: resolvedBackend,
    });
  }

  /**
   * Create a directory, optionally with intermediate directories.
   *
   * @param path - Absolute directory path.
   * @param options - Pass `{ recursive: true }` to create parent directories.
   * @returns Resolves when the directory is created.
   */
  public async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this._resourceQueue.queueFor(path, async () => {
      const { provider, path: resolvedPath, backend: resolvedBackend } = this._resolveProvider(path);
      await provider.mkdir(resolvedPath, options?.recursive ? { recursive: true } : undefined);

      this._inMemoryTreeAddDirectory(path);

      if (options?.recursive) {
        this._treeCache.invalidateAncestors(path);
      } else {
        this._treeCache.invalidate(parentDirectory(path));
      }

      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(path),
        backend: resolvedBackend,
      });
    });
  }

  /**
   * Rename or move a file or directory.
   *
   * @param from - Current absolute path.
   * @param to - New absolute path.
   * @returns Resolves when the rename completes.
   */
  public async rename(from: string, to: string): Promise<void> {
    return this._resourceQueue.queueFor(from, async () => {
      const source = this._resolveProvider(from);
      const target = this._resolveProvider(to);

      if (source.provider === target.provider) {
        await source.provider.rename(source.path, target.path);
      } else {
        console.warn('[FileService] Cross-mount rename: copy+delete', from, '->', to);
        const data = await source.provider.readFile(source.path);
        await target.provider.writeFile(target.path, data);
        await source.provider.unlink(source.path);
      }

      this._contentPool?.invalidate(from);
      this._contentPool?.invalidate(to);
      this._inMemoryTreeRename(from, to);
      this._treeCache.invalidate(parentDirectory(from));
      this._treeCache.invalidate(parentDirectory(to));
      this._treeCache.invalidateSubtree(from);
      this._eventBus.emit({
        type: 'fileRenamed',
        oldPath: from,
        newPath: to,
        backend: source.backend,
      });
    });
  }

  /**
   * Delete a file.
   *
   * @param path - Absolute file path.
   * @returns Resolves when the file is deleted.
   */
  public async unlink(path: string): Promise<void> {
    return this._resourceQueue.queueFor(path, async () => {
      const { provider, path: resolvedPath, backend: resolvedBackend } = this._resolveProvider(path);
      await provider.unlink(resolvedPath);

      this._contentPool?.invalidate(path);
      this._inMemoryTreeRemoveFile(path);
      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'fileDeleted',
        path,
        backend: resolvedBackend,
      });
    });
  }

  /**
   * Remove a directory.
   *
   * @param path - Absolute directory path.
   * @returns Resolves when the directory is removed.
   */
  public async rmdir(path: string): Promise<void> {
    return this._resourceQueue.queueFor(path, async () => {
      const { provider, path: resolvedPath, backend: resolvedBackend } = this._resolveProvider(path);
      await provider.rmdir(resolvedPath);

      this._inMemoryTreeRemoveDirectory(path);
      this._treeCache.invalidateSubtree(path);
      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(path),
        backend: resolvedBackend,
      });
    });
  }

  // --- Higher-level operations ---

  /**
   * Recursively create a directory and all missing parents.
   *
   * @param path - Absolute directory path.
   * @returns Resolves when the directory exists.
   */
  public async ensureDirectoryExists(path: string): Promise<void> {
    return this._resourceQueue.queueFor(path, async () => {
      const { provider, path: resolvedPath } = this._resolveProvider(path);
      await this._ensureDirectoryExistsInternal(provider, resolvedPath);
      this._inMemoryTreeAddDirectory(path);
    });
  }

  /**
   * Copy a single file to a new location, creating parent directories as needed.
   *
   * @param sourcePath - Absolute path of the file to copy.
   * @param destinationPath - Absolute path for the new copy.
   * @returns Resolves when the copy completes.
   */
  public async duplicateFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this._resourceQueue.queueFor(destinationPath, async () => {
      const source = this._resolveProvider(sourcePath);
      const destination = this._resolveProvider(destinationPath);
      const data = await source.provider.readFile(source.path);
      await this._ensureParentDir(destination.provider, destination.path);
      await destination.provider.writeFile(destination.path, data);

      const size = data.byteLength;
      this._inMemoryTreeAddFile(destinationPath, size);
      this._treeCache.invalidate(parentDirectory(destinationPath));
      this._eventBus.emit({
        type: 'fileWritten',
        path: destinationPath,
        backend: destination.backend,
      });
    });
  }

  /**
   * Recursively copy an entire directory tree to a new location.
   *
   * @param sourcePath - Absolute path of the source directory.
   * @param destinationPath - Absolute path for the destination directory.
   * @returns Resolves when the copy completes.
   */
  public async copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
    return this._resourceQueue.queueFor(destinationPath, async () => {
      const source = this._resolveProvider(sourcePath);
      const files = await this._getDirectoryContentsInternal(source.provider, source.path);

      for (const [relativePath, content] of Object.entries(files)) {
        const destinationFile = joinPath(destinationPath, relativePath);
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required
        const destination = this._resolveProvider(destinationFile);
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required
        await this._ensureParentDir(destination.provider, destination.path);
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required
        await destination.provider.writeFile(destination.path, content);
        this._inMemoryTreeAddFile(destinationFile, content.byteLength);
      }

      this._treeCache.invalidate(parentDirectory(destinationPath));
      this._treeCache.invalidateSubtree(destinationPath);
      const destinationResolution = this._resolveProvider(destinationPath);
      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(destinationPath),
        backend: destinationResolution.backend,
      });
    });
  }

  /**
   * Recursively read all files under a directory as raw bytes.
   *
   * @param path - Absolute directory path.
   * @returns Map of relative paths to file contents (empty if directory missing).
   */
  public async getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    const { provider, path: resolvedPath } = this._resolveProvider(path);
    const directoryExists = await provider.exists(resolvedPath);
    if (!directoryExists) {
      return {};
    }
    return this._getDirectoryContentsInternal(provider, resolvedPath);
  }

  /**
   * Package a directory's contents into a ZIP blob.
   *
   * @param path - Absolute directory path.
   * @returns ZIP archive as a `Blob`.
   */
  public async getZippedDirectory(path: string): Promise<Blob> {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- JSZip is the library's class name
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const files = await this.getDirectoryContents(path);
    for (const [relativePath, content] of Object.entries(files)) {
      zip.file(relativePath, content);
    }
    return zip.generateAsync({ type: 'blob' });
  }

  // --- Tree operations ---

  /**
   * Read a directory with read-through cache. Used for incremental tree updates.
   * On cache miss, reads from provider and caches. Returns sorted FileTreeNode array.
   *
   * @param path - Absolute directory path.
   * @param options - Optional abort signal for cancellation.
   * @returns Sorted array of file tree nodes.
   */
  public async readDirectory(path: string, options?: { signal?: AbortSignal }): Promise<FileTreeNode[]> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const cached = this._treeCache.get(path);
    if (cached) {
      return this._treeEntriesToNodes(cached);
    }

    const { provider, path: resolvedPath } = this._resolveProvider(path);
    const entryMap = new Map<string, TreeEntry>();

    try {
      if (provider.readdirWithStats) {
        const statsEntries = await provider.readdirWithStats(resolvedPath);
        for (const entry of statsEntries) {
          entryMap.set(entry.name, {
            name: entry.name,
            type: entry.isDirectory ? 'directory' : 'file',
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          });
        }
      } else {
        const entries = await provider.readdir(resolvedPath);
        for (const entry of entries) {
          const fullPath = joinPath(resolvedPath, entry);
          try {
            // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for tree building
            const stat = await provider.stat(fullPath);
            entryMap.set(entry, {
              name: entry,
              type: stat.isDirectory ? 'directory' : 'file',
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          } catch {
            // Skip entries that can't be stat'd (deleted between readdir and stat)
          }
        }
      }
    } catch {
      return [];
    }

    const childMounts = this._mountTable.getMountsUnder(path);
    for (const mount of childMounts) {
      const mountName = mount.prefix.split('/').pop();
      if (mountName && !entryMap.has(mountName)) {
        entryMap.set(mountName, { name: mountName, type: 'directory', size: 0, mtimeMs: Date.now() });
      }
    }

    this._treeCache.set(path, entryMap);
    return this._treeEntriesToNodes(entryMap);
  }

  /**
   * Recursively collect stat information for every file under a directory.
   *
   * @param path - Absolute directory path to walk.
   * @param options - Optional abort signal for long walks.
   * @returns Flat array of file stat entries with relative paths.
   */
  public async getDirectoryStat(path: string, options?: { signal?: AbortSignal }): Promise<FileStatEntry[]> {
    const normalizedPath = normalizePath(path);

    if (this._inMemoryTree.isBuilt && this._directoryStatRoot !== undefined) {
      const treeRelativePath = this._toTreeRelative(normalizedPath);
      if (treeRelativePath !== undefined) {
        return this._inMemoryTree.getDirectoryStat(treeRelativePath);
      }

      const { provider, path: resolvedPath } = this._resolveProvider(normalizedPath);
      return this._collectDirectoryStatsFromProvider(
        provider,
        { walkPath: resolvedPath, basePath: resolvedPath },
        options,
      );
    }

    const { provider, path: resolvedPath } = this._resolveProvider(normalizedPath);
    const fileStats = await this._collectDirectoryStatsFromProvider(
      provider,
      { walkPath: resolvedPath, basePath: resolvedPath },
      options,
    );

    this._directoryStatRoot = normalizedPath;
    this._inMemoryTree.build(
      fileStats.map((f) => ({
        path: f.path,
        type: 'file',
        size: f.size,
        mtimeMs: f.mtimeMs,
      })),
    );

    return fileStats;
  }

  /**
   * Search the in-memory file tree for entries whose paths contain the query substring.
   * Synchronous — runs entirely against the already-warm {@link InMemoryFileTree}.
   *
   * @param basePath - Absolute root path (must match or be under the scan root).
   * @param query - Case-insensitive substring to match against relative file paths.
   * @param options - Search options: `maxResults` (default 100), `includeDirectories` (default false).
   * @returns Matching entries with paths relative to the tree root.
   */
  public searchFiles(
    basePath: string,
    query: string,
    options?: { maxResults?: number; includeDirectories?: boolean },
  ): FileStatEntry[] {
    if (!this._inMemoryTree.isBuilt) {
      return [];
    }
    const treeRelativePath = this._toTreeRelative(normalizePath(basePath));
    if (treeRelativePath === undefined) {
      return [];
    }
    return this._inMemoryTree.searchFiles(query, options);
  }

  /**
   * Read a single directory level from a specific backend, bypassing the
   * active provider. Used by the `/files` route to show all backends.
   *
   * @param path - Absolute directory path.
   * @param backend - Storage backend to read from.
   * @param handle - Optional directory handle for webaccess backends.
   * @returns Sorted tree nodes (folders first, then alphabetical).
   */
  public async readShallowDirectory(
    path: string,
    backend: FileSystemBackend,
    handle?: FileSystemDirectoryHandle,
  ): Promise<FileTreeNode[]> {
    if (backend === 'memory') {
      return [];
    }

    let provider;
    try {
      provider = await this._registry.getStandaloneProvider(backend, handle);
    } catch {
      return [];
    }

    const nodes: FileTreeNode[] = [];
    try {
      if (provider.readdirWithStats) {
        const statsEntries = await provider.readdirWithStats(path);
        for (const entry of statsEntries) {
          const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
          if (entry.isDirectory) {
            nodes.push({ id: fullPath, name: entry.name, children: [] });
          } else {
            nodes.push({ id: fullPath, name: entry.name });
          }
        }
      } else {
        const entries = await provider.readdir(path);
        for (const entry of entries) {
          const fullPath = path === '/' ? `/${entry}` : `${path}/${entry}`;
          try {
            // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for tree building
            const stat = await provider.stat(fullPath);
            if (stat.isDirectory) {
              nodes.push({ id: fullPath, name: entry, children: [] });
            } else {
              nodes.push({ id: fullPath, name: entry });
            }
          } catch {
            // Skip entries that can't be stat'd
          }
        }
      }
    } catch {
      return [];
    }

    return nodes.sort((a, b) => {
      const aIsFolder = a.children !== undefined;
      const bIsFolder = b.children !== undefined;
      if (aIsFolder && !bIsFolder) {
        return -1;
      }
      if (!aIsFolder && bIsFolder) {
        return 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  // --- Watch API ---

  /**
   * Subscribe to filesystem changes matching the request.
   * Identical requests share one underlying subscription (ref-counted).
   *
   * @param request - paths, recursive, includes/excludes, filter, correlationId
   * @param handler - callback for matching WatchEvents
   * @param ownerId - optional port/session id for lifecycle cleanup
   * @returns unsubscribe function
   */
  public watch(request: WatchRequest, handler: (event: WatchEvent) => void, ownerId?: string): () => void {
    return this._watchRegistry.watch(request, handler, ownerId);
  }

  /**
   * Remove all watches owned by a port/session (disconnect cleanup).
   *
   * @param ownerId - Port or session id whose watches to remove.
   */
  public cleanupWatches(ownerId: string): void {
    this._watchRegistry.cleanupOwner(ownerId);
  }

  /**
   * The underlying watch subscription registry.
   *
   * @returns The watch registry instance.
   */
  public get watchRegistry(): WatchRegistry {
    return this._watchRegistry;
  }

  // --- Backend management ---

  /**
   * Dynamically mount a path prefix on a new provider instance of the given backend.
   * The caller owns the path convention; FileService is domain-agnostic.
   *
   * @param prefix - Absolute path prefix to mount (e.g. `/data`, `/projects/abc`).
   * @param backend - Storage backend for the new mount.
   * @param options - Optional mount options (preservePath, etc.).
   */
  public async mount(prefix: string, backend: FileSystemBackend, options?: MountOptions): Promise<void> {
    const provider = await this._registry.createMountProvider(backend);
    this._mountTable.mount(prefix, provider, { backend, ...options });

    if (prefix === '/') {
      this._watchRegistry.setCaseSensitive(provider.capabilities.caseSensitive ?? true);
    }
  }

  /**
   * Remove a dynamic mount, disposing the provider that backs it.
   *
   * @param prefix - The mount prefix to remove.
   */
  public unmount(prefix: string): void {
    try {
      const { provider } = this._mountTable.resolve(prefix);
      this._mountTable.unmount(prefix);
      provider.dispose();
    } catch {
      this._mountTable.unmount(prefix);
    }
  }

  /**
   * Set the directory handle used by webaccess backends.
   *
   * @param handle - Browser File System Access API directory handle.
   */
  public setDirectoryHandle(handle: FileSystemDirectoryHandle): void {
    this._registry.setDirectoryHandle(handle);
  }

  /**
   * The change event bus for subscribing to filesystem events.
   *
   * @returns The change event bus instance.
   */
  public get eventBus(): ChangeEventBus {
    return this._eventBus;
  }

  /** Release all resources: watches, providers, caches, and event bus. */
  public dispose(): void {
    this._watchRegistry.dispose();
    this._registry.disposeAll();
    this._treeCache.clear();
    this._eventBus.dispose();
  }

  // --- Private helpers ---

  /**
   * Convert an absolute path to a path relative to {@link _directoryStatRoot} (scan root).
   * Used so incremental in-memory updates match paths stored by {@link InMemoryFileTree.build}.
   *
   * @param absolutePath - Normalized absolute filesystem path.
   * @returns Path relative to the scan root, `''` for the root itself, or `undefined` if outside the tree.
   */
  private _toTreeRelative(absolutePath: string): string | undefined {
    if (this._directoryStatRoot === undefined) {
      return undefined;
    }

    const root = normalizePath(this._directoryStatRoot);
    const abs = normalizePath(absolutePath);

    if (abs === root) {
      return '';
    }

    if (root === '/') {
      return abs.startsWith('/') ? abs.slice(1) : abs;
    }

    const rootPrefix = `${root}/`;
    if (abs.startsWith(rootPrefix)) {
      return abs.slice(rootPrefix.length);
    }

    return undefined;
  }

  private async _collectDirectoryStatsFromProvider(
    provider: {
      readdir(path: string): Promise<string[]>;
      stat(path: string): Promise<ProviderFileStat>;
      readdirWithStats?(path: string): Promise<Array<{ name: string } & ProviderFileStat>>;
    },
    scan: { walkPath: string; basePath: string },
    options?: { signal?: AbortSignal },
  ): Promise<FileStatEntry[]> {
    const { walkPath, basePath } = scan;
    const fileStats: FileStatEntry[] = [];

    const collectStats = async (currentPath: string, innerBasePath: string): Promise<void> => {
      if (options?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      if (provider.readdirWithStats) {
        const statsEntries = await provider.readdirWithStats(currentPath);
        for (const entry of statsEntries) {
          if (options?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }

          const fullPath = joinPath(currentPath, entry.name);
          if (entry.isFile) {
            const relativePath = innerBasePath === '/' ? fullPath.slice(1) : fullPath.slice(innerBasePath.length + 1);
            const segments = relativePath.split('/');
            const filename = segments.at(-1) ?? relativePath;
            fileStats.push({
              path: relativePath,
              name: filename,
              type: 'file',
              size: entry.size,
              mtimeMs: entry.mtimeMs,
            });
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for recursive tree walk
            await collectStats(fullPath, innerBasePath);
          }
        }
      } else {
        const entries = await provider.readdir(currentPath);
        for (const entry of entries) {
          if (options?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }

          const fullPath = joinPath(currentPath, entry);
          // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for recursive tree walk
          const stat = await provider.stat(fullPath);
          if (stat.isFile) {
            const relativePath = innerBasePath === '/' ? fullPath.slice(1) : fullPath.slice(innerBasePath.length + 1);
            const segments = relativePath.split('/');
            const filename = segments.at(-1) ?? relativePath;
            fileStats.push({
              path: relativePath,
              name: filename,
              type: 'file',
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for recursive tree walk
            await collectStats(fullPath, innerBasePath);
          }
        }
      }
    };

    await collectStats(walkPath, basePath);
    return fileStats;
  }

  private _inMemoryTreeAddFile(absolutePath: string, size: number): void {
    const treeRelativePath = this._toTreeRelative(normalizePath(absolutePath));
    if (treeRelativePath !== undefined) {
      this._inMemoryTree.addFile(treeRelativePath, size);
    }
  }

  private _inMemoryTreeAddDirectory(absolutePath: string): void {
    const treeRelativePath = this._toTreeRelative(normalizePath(absolutePath));
    if (treeRelativePath !== undefined) {
      this._inMemoryTree.addDirectory(treeRelativePath);
    }
  }

  private _inMemoryTreeRename(from: string, to: string): void {
    const relativeFromPath = this._toTreeRelative(normalizePath(from));
    const relativeToPath = this._toTreeRelative(normalizePath(to));
    if (relativeFromPath !== undefined && relativeToPath !== undefined) {
      this._inMemoryTree.rename(relativeFromPath, relativeToPath);
    }
  }

  private _inMemoryTreeRemoveFile(absolutePath: string): void {
    const treeRelativePath = this._toTreeRelative(normalizePath(absolutePath));
    if (treeRelativePath !== undefined) {
      this._inMemoryTree.removeFile(treeRelativePath);
    }
  }

  private _inMemoryTreeRemoveDirectory(absolutePath: string): void {
    const treeRelativePath = this._toTreeRelative(normalizePath(absolutePath));
    if (treeRelativePath !== undefined) {
      this._inMemoryTree.removeDirectory(treeRelativePath);
    }
  }

  private _treeEntriesToNodes(entries: Map<string, TreeEntry>): FileTreeNode[] {
    const nodes: FileTreeNode[] = [];
    for (const [, entry] of entries) {
      if (entry.type === 'directory') {
        nodes.push({ id: entry.name, name: entry.name, children: [] });
      } else {
        nodes.push({ id: entry.name, name: entry.name });
      }
    }
    return nodes.sort((a, b) => {
      const aIsFolder = a.children !== undefined;
      const bIsFolder = b.children !== undefined;
      if (aIsFolder && !bIsFolder) {
        return -1;
      }
      if (!aIsFolder && bIsFolder) {
        return 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  /**
   * Resolve the provider and provider-relative path for an absolute virtual path
   * via the mount table. Throws immediately if no mount matches.
   *
   * @param path - Absolute virtual path.
   * @returns Resolved provider and provider-relative path.
   */
  private _resolveProvider(path: string): MountResolution {
    return this._mountTable.resolve(path);
  }

  private async _ensureParentDir(
    provider: { mkdir(path: string, options?: { recursive?: boolean }): Promise<void> },
    filePath: string,
  ): Promise<void> {
    const directory = parentDirectory(filePath);
    if (directory !== '/') {
      await this._ensureDirectoryExistsInternal(provider, directory);
    }
  }

  private async _ensureDirectoryExistsInternal(
    provider: {
      mkdir(path: string): Promise<void>;
      exists?(path: string): Promise<boolean>;
    },
    targetPath: string,
  ): Promise<void> {
    const normalized = normalizePath(targetPath);
    const segments = normalized.split('/').filter((s: string) => s.length > 0);

    let currentPath = '';
    for (const segment of segments) {
      currentPath += `/${segment}`;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Sequential mkdir required for recursive creation
        await provider.mkdir(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  private async _getDirectoryContentsInternal(
    provider: {
      readdir(path: string): Promise<string[]>;
      stat(path: string): Promise<ProviderFileStat>;
      readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
    },
    path: string,
  ): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {};

    const collect = async (currentPath: string, basePath: string): Promise<void> => {
      const entries = await provider.readdir(currentPath);
      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry);
        // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for recursive collection
        const stat = await provider.stat(fullPath);
        if (stat.isFile) {
          const relativePath = basePath === '/' ? fullPath.slice(1) : fullPath.slice(basePath.length + 1);
          // oxlint-disable-next-line no-await-in-loop -- Sequential reads required for recursive collection
          files[relativePath] = await provider.readFile(fullPath);
        } else {
          // oxlint-disable-next-line no-await-in-loop -- Sequential traversal required for recursive collection
          await collect(fullPath, basePath);
        }
      }
    };

    await collect(path, path);
    return files;
  }
}
