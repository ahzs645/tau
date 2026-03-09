import JSZip from 'jszip';
import type { FileStat, FileStatEntry, FileSystemBackend } from '@taucad/types';
import type { FileTreeNode, ProviderFileStat, TreeEntry, WatchRequest, WatchEvent } from '#types.js';
import type { ProviderRegistry } from '#provider-registry.js';
import type { WriteCoordinator } from '#write-coordinator.js';
import type { DirectoryTreeCache } from '#directory-tree-cache.js';
import type { ChangeEventBus } from '#change-event-bus.js';
import { WatchRegistry } from '#watch-registry.js';
import { parentDirectory, joinPath, normalizePath } from '@taucad/utils/path';

function toFileStat(stat: ProviderFileStat): FileStat {
  return {
    type: stat.isDirectory ? 'dir' : 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Options for {@link FileService.mkdir}. */
export type MkdirOptions = {
  mode?: number;
  recursive?: boolean;
};

/**
 * High-level filesystem service that coordinates reads, writes, caching,
 * and watch subscriptions across pluggable storage providers.
 */
export class FileService {
  private readonly _registry: ProviderRegistry;
  private readonly _writeCoordinator: WriteCoordinator;
  private readonly _treeCache: DirectoryTreeCache;
  private readonly _eventBus: ChangeEventBus;
  private readonly _watchRegistry: WatchRegistry;

  /**
   * Create a FileService with injected dependencies.
   *
   * @param options - Service dependencies injected at construction time.
   */
  public constructor(options: {
    providerRegistry: ProviderRegistry;
    writeCoordinator: WriteCoordinator;
    treeCache: DirectoryTreeCache;
    eventBus: ChangeEventBus;
  }) {
    this._registry = options.providerRegistry;
    this._writeCoordinator = options.writeCoordinator;
    this._treeCache = options.treeCache;
    this._eventBus = options.eventBus;
    this._watchRegistry = new WatchRegistry(options.eventBus);
    void this._syncCaseSensitivity();
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
    options?: 'utf8' | { encoding: 'utf8' },
  ): Promise<string | Uint8Array<ArrayBuffer>> {
    const provider = await this._registry.getActiveProvider();
    const encoding = options === 'utf8' || (typeof options === 'object' && 'encoding' in options) ? 'utf8' : undefined;

    if (encoding === 'utf8') {
      return provider.readFile(filepath, 'utf8');
    }
    return provider.readFile(filepath);
  }

  /**
   * Read multiple files in parallel, returning a map of path to raw bytes.
   *
   * @param paths - Absolute file paths to read.
   * @returns Map from path to file content.
   */
  public async readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
    const provider = await this._registry.getActiveProvider();
    const results = await Promise.all(
      paths.map(async (filepath) => {
        const data = await provider.readFile(filepath);
        return [filepath, data] as const;
      }),
    );
    return Object.fromEntries(results);
  }

  /**
   * List entries in a directory.
   *
   * @param path - Absolute directory path.
   * @returns Array of entry names (not full paths).
   */
  public async readdir(path: string): Promise<string[]> {
    const provider = await this._registry.getActiveProvider();
    return provider.readdir(path);
  }

  /**
   * Get file or directory metadata.
   *
   * @param path - Absolute path.
   * @returns Stat information (type, size, mtime).
   */
  public async stat(path: string): Promise<FileStat> {
    const provider = await this._registry.getActiveProvider();
    return toFileStat(await provider.stat(path));
  }

  /**
   * Get file or directory metadata without following symlinks.
   *
   * @param path - Absolute path.
   * @returns Stat information (type, size, mtime).
   */
  public async lstat(path: string): Promise<FileStat> {
    const provider = await this._registry.getActiveProvider();
    return toFileStat(await provider.lstat(path));
  }

  /**
   * Check whether a file or directory exists.
   *
   * @param path - Absolute path.
   * @returns `true` if the entry exists.
   */
  public async exists(path: string): Promise<boolean> {
    const provider = await this._registry.getActiveProvider();
    return provider.exists(path);
  }

  /**
   * Check existence of multiple paths in parallel.
   *
   * @param paths - Absolute paths to check.
   * @returns Map from path to existence boolean.
   */
  public async batchExists(paths: string[]): Promise<Record<string, boolean>> {
    const provider = await this._registry.getActiveProvider();
    const results = await Promise.all(
      paths.map(async (path) => ({
        path,
        exists: await provider.exists(path),
      })),
    );
    const existsMap: Record<string, boolean> = {};
    for (const { path, exists } of results) {
      existsMap[path] = exists;
    }
    return existsMap;
  }

  // --- Write operations (serialized via WriteCoordinator) ---

  /**
   * Write data to a file, creating parent directories as needed.
   * Serialized through the {@link WriteCoordinator}.
   *
   * @param path - Absolute file path.
   * @param data - File content as raw bytes or a UTF-8 string.
   * @returns Resolves when the write completes.
   */
  public async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> {
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await this._ensureParentDir(provider, path);
      await provider.writeFile(path, data);

      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'fileWritten',
        path,
        backend: this._registry.activeBackend,
      });
    });
  }

  /**
   * Write multiple files atomically within a single serialized operation.
   *
   * @param files - Map of absolute path to content.
   * @returns Resolves when all writes complete.
   */
  public async writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> | string }>): Promise<void> {
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      const createdDirectories = new Set<string>();

      for (const [path, file] of Object.entries(files)) {
        const directory = parentDirectory(path);
        if (directory !== '/' && !createdDirectories.has(directory)) {
          // oxlint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
          await this._ensureDirectoryExistsInternal(provider, directory);
          createdDirectories.add(directory);
        }
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
        await provider.writeFile(path, file.content);
      }

      const parentDirectories = new Set(Object.keys(files).map((p) => parentDirectory(p)));
      for (const directory of parentDirectories) {
        this._treeCache.invalidate(directory);
      }
      this._eventBus.emit({
        type: 'directoryChanged',
        path: '/',
        backend: this._registry.activeBackend,
      });
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await provider.mkdir(path, options?.recursive ? { recursive: true } : undefined);

      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(path),
        backend: this._registry.activeBackend,
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await provider.rename(from, to);

      this._treeCache.invalidate(parentDirectory(from));
      this._treeCache.invalidate(parentDirectory(to));
      this._treeCache.invalidateSubtree(from);
      this._eventBus.emit({
        type: 'fileRenamed',
        oldPath: from,
        newPath: to,
        backend: this._registry.activeBackend,
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await provider.unlink(path);

      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'fileDeleted',
        path,
        backend: this._registry.activeBackend,
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await provider.rmdir(path);

      this._treeCache.invalidateSubtree(path);
      this._treeCache.invalidate(parentDirectory(path));
      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(path),
        backend: this._registry.activeBackend,
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      await this._ensureDirectoryExistsInternal(provider, path);
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      const data = await provider.readFile(sourcePath);
      await this._ensureParentDir(provider, destinationPath);
      await provider.writeFile(destinationPath, data);

      this._treeCache.invalidate(parentDirectory(destinationPath));
      this._eventBus.emit({
        type: 'fileWritten',
        path: destinationPath,
        backend: this._registry.activeBackend,
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
    return this._writeCoordinator.serialized(async () => {
      const provider = await this._registry.getActiveProvider();
      const files = await this._getDirectoryContentsInternal(provider, sourcePath);

      for (const [relativePath, content] of Object.entries(files)) {
        const destinationFile = joinPath(destinationPath, relativePath);
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
        await this._ensureParentDir(provider, destinationFile);
        // oxlint-disable-next-line no-await-in-loop -- Sequential writes required to prevent ZenFS race condition
        await provider.writeFile(destinationFile, content);
      }

      this._treeCache.invalidate(parentDirectory(destinationPath));
      this._treeCache.invalidateSubtree(destinationPath);
      this._eventBus.emit({
        type: 'directoryChanged',
        path: parentDirectory(destinationPath),
        backend: this._registry.activeBackend,
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
    const provider = await this._registry.getActiveProvider();
    const directoryExists = await provider.exists(path);
    if (!directoryExists) {
      return {};
    }
    return this._getDirectoryContentsInternal(provider, path);
  }

  /**
   * Package a directory's contents into a ZIP blob.
   *
   * @param path - Absolute directory path.
   * @returns ZIP archive as a `Blob`.
   */
  public async getZippedDirectory(path: string): Promise<Blob> {
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
   * @returns Sorted array of file tree nodes.
   */
  public async readDirectory(path: string): Promise<FileTreeNode[]> {
    const cached = this._treeCache.get(path);
    if (cached) {
      return this._treeEntriesToNodes(cached);
    }

    const provider = await this._registry.getActiveProvider();
    let entries: string[];
    try {
      entries = await provider.readdir(path);
    } catch {
      return [];
    }

    const entryMap = new Map<string, TreeEntry>();
    for (const entry of entries) {
      const fullPath = joinPath(path, entry);
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

    this._treeCache.set(path, entryMap);
    return this._treeEntriesToNodes(entryMap);
  }

  /**
   * Recursively collect stat information for every file under a directory.
   *
   * @param path - Absolute directory path to walk.
   * @returns Flat array of file stat entries with relative paths.
   */
  public async getDirectoryStat(path: string): Promise<FileStatEntry[]> {
    const provider = await this._registry.getActiveProvider();
    const fileStats: FileStatEntry[] = [];

    const collectStats = async (currentPath: string, basePath: string): Promise<void> => {
      const entries = await provider.readdir(currentPath);
      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry);
        // oxlint-disable-next-line no-await-in-loop -- Sequential stat required for recursive tree walk
        const stat = await provider.stat(fullPath);
        if (stat.isFile) {
          const relativePath = basePath === '/' ? fullPath.slice(1) : fullPath.slice(basePath.length + 1);
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
          await collectStats(fullPath, basePath);
        }
      }
    };

    await collectStats(path, path);
    return fileStats;
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

    let entries: string[];
    try {
      entries = await provider.readdir(path);
    } catch {
      return [];
    }

    const nodes: FileTreeNode[] = [];
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
   * Switch the active storage backend, clearing caches and emitting a reset.
   *
   * @param backend - Backend to switch to.
   */
  public async reconfigure(backend: FileSystemBackend): Promise<void> {
    await this._registry.switchActiveProvider(backend);
    this._treeCache.clear();
    await this._syncCaseSensitivity();
    this._watchRegistry.emitResetAll();
    this._eventBus.emit({ type: 'backendChanged', backend });
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

  private async _syncCaseSensitivity(): Promise<void> {
    try {
      const provider = await this._registry.getActiveProvider();
      this._watchRegistry.setCaseSensitive(provider.capabilities.caseSensitive ?? true);
    } catch {
      // Fallback: assume case-sensitive
    }
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
