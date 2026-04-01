// eslint-disable-next-line @nx/enforce-module-boundaries -- filesystem is lazy-loaded via worker; this service runs on main thread
import { BoundedFileCache } from '@taucad/filesystem';
import type { SharedContentPool } from '@taucad/filesystem';
import type { FileWriteSource, FileManagerProxy } from '#machines/file-manager.machine.types.js';
import { joinPath } from '@taucad/utils/path';

export type ContentChangeEvent =
  | { type: 'written'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'read'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'renamed'; oldPath: string; newPath: string }
  | { type: 'deleted'; path: string; source: FileWriteSource }
  | { type: 'batchWritten'; paths: string[]; source: FileWriteSource };

type FileContentServiceInit = {
  proxy: FileManagerProxy;
  rootDirectory: string;
  cacheOptions?: {
    maxEntries?: number;
    maxTotalBytes?: number;
    maxSingleFileBytes?: number;
  };
  /** Reader-side shared content pool for zero-IPC cached reads across threads. */
  contentPool?: SharedContentPool;
};

const defaultMaxEntries = 500;
const defaultMaxTotalBytes = 128 * 1024 * 1024;
const defaultMaxSingleFileBytes = 1024 * 1024;

/**
 * Single content authority on the main thread.
 * All content operations (read, write, rename, delete, duplicate)
 * go through this service. No consumer ever calls the proxy for
 * content operations directly.
 */
export type OrphanChangeEvent = { path: string; orphaned: boolean };

export class FileContentService {
  private readonly cache: BoundedFileCache;
  private readonly proxy: FileManagerProxy;
  private readonly contentPool: SharedContentPool | undefined;
  private rootDirectory: string;
  private readonly pendingResolves = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private readonly pathSubscribers = new Map<string, Set<() => void>>();
  private readonly globalSubscribers = new Set<(event: ContentChangeEvent) => void>();
  private readonly orphanedPaths = new Set<string>();
  private readonly orphanSubscribers = new Set<(event: OrphanChangeEvent) => void>();

  public constructor(init: FileContentServiceInit) {
    this.proxy = init.proxy;
    this.rootDirectory = init.rootDirectory;
    this.contentPool = init.contentPool;
    this.cache = new BoundedFileCache({
      maxEntries: init.cacheOptions?.maxEntries ?? defaultMaxEntries,
      maxTotalBytes: init.cacheOptions?.maxTotalBytes ?? defaultMaxTotalBytes,
      maxSingleFileBytes: init.cacheOptions?.maxSingleFileBytes ?? defaultMaxSingleFileBytes,
    });
  }

  /**
   * Resolve file content. Cache hit returns immediately.
   * Cache miss reads from the worker. Concurrent reads for the same path
   * join via a shared promise (VS Code `joinPendingResolves` pattern).
   */
  public async resolve(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const cached = this.cache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    if (this.contentPool) {
      const absolutePath = joinPath(this.rootDirectory, path);
      const poolData = this.contentPool.resolve(absolutePath);
      if (poolData) {
        const copy = new Uint8Array(poolData);
        this.cache.set(path, copy);
        return copy;
      }
    }

    const pending = this.pendingResolves.get(path);
    if (pending !== undefined) {
      return pending;
    }

    const promise = this.resolveFromWorker(path);
    this.pendingResolves.set(path, promise);

    try {
      return await promise;
    } finally {
      this.pendingResolves.delete(path);
    }
  }

  /**
   * Write file content. Clones buffer before transfer to prevent detachment.
   */
  public async write(path: string, data: Uint8Array<ArrayBuffer>, source: FileWriteSource): Promise<void> {
    const localCopy = new Uint8Array(data);
    const absolutePath = joinPath(this.rootDirectory, path);
    await this.proxy.writeFile(absolutePath, data);
    this.cache.set(path, localCopy);
    this.setOrphaned(path, false);
    this.notifyPathSubscribers(path);
    this.notifyGlobalSubscribers({ type: 'written', path, data: localCopy, source });
  }

  /**
   * Write multiple files. Clones each buffer before transfer.
   */
  public async writeFiles(
    files: Record<string, { content: Uint8Array<ArrayBuffer> }>,
    source: FileWriteSource,
  ): Promise<void> {
    const absoluteFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
    const clones = new Map<string, Uint8Array<ArrayBuffer>>();
    const paths: string[] = [];

    for (const [path, file] of Object.entries(files)) {
      const localCopy = new Uint8Array(file.content);
      clones.set(path, localCopy);
      absoluteFiles[joinPath(this.rootDirectory, path)] = file;
      paths.push(path);
    }

    await this.proxy.writeFiles(absoluteFiles);

    for (const [path, localCopy] of clones) {
      this.cache.set(path, localCopy);
      this.notifyPathSubscribers(path);
    }

    this.notifyGlobalSubscribers({ type: 'batchWritten', paths, source });
  }

  /**
   * Rename a file. Updates cache and notifies subscribers for both old and new paths.
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    const absoluteOldPath = joinPath(this.rootDirectory, oldPath);
    const absoluteNewPath = joinPath(this.rootDirectory, newPath);
    await this.proxy.rename(absoluteOldPath, absoluteNewPath);
    this.cache.rename(oldPath, newPath);
    this.notifyPathSubscribers(oldPath);
    this.notifyPathSubscribers(newPath);
    this.notifyGlobalSubscribers({ type: 'renamed', oldPath, newPath });
  }

  /**
   * Delete a file. Removes from cache and notifies subscribers.
   */
  public async delete(path: string, source: FileWriteSource): Promise<void> {
    const absolutePath = joinPath(this.rootDirectory, path);
    await this.proxy.unlink(absolutePath);
    this.cache.delete(path);
    this.setOrphaned(path, true);
    this.notifyPathSubscribers(path);
    this.notifyGlobalSubscribers({ type: 'deleted', path, source });
  }

  /**
   * Duplicate a file. Reads source via resolve, writes dest via write.
   */
  public async duplicate(sourcePath: string, destinationPath: string): Promise<void> {
    const data = await this.resolve(sourcePath);
    await this.write(destinationPath, data, 'user');
  }

  /**
   * Copy a directory. Proxy pass-through, no content caching.
   * Fires batchWritten so FileTreeService refreshes.
   */
  public async copyDirectory(source: string, destination: string): Promise<void> {
    await this.proxy.copyDirectory(source, destination);
    this.notifyGlobalSubscribers({ type: 'batchWritten', paths: [], source: 'user' });
  }

  /**
   * Get a zipped archive of a directory. Proxy pass-through.
   */
  public async getZippedDirectory(path: string): Promise<Blob> {
    return this.proxy.getZippedDirectory(path);
  }

  /**
   * Read cached content without LRU promotion. Safe for React renders.
   */
  public peek(path: string): Uint8Array<ArrayBuffer> | undefined {
    return this.cache.peek(path);
  }

  /**
   * Check if content is cached for the given path.
   */
  public has(path: string): boolean {
    return this.cache.has(path);
  }

  /**
   * Sync check of cached orphan flag. A file is orphaned when a resolve
   * attempt fails with ENOENT or after an explicit delete.
   */
  public isOrphaned(path: string): boolean {
    return this.orphanedPaths.has(path);
  }

  /**
   * Subscribe to orphan state transitions. Fires when a path transitions
   * between orphaned and non-orphaned.
   */
  public onDidChangeOrphaned(handler: (event: OrphanChangeEvent) => void): () => void {
    this.orphanSubscribers.add(handler);
    return () => {
      this.orphanSubscribers.delete(handler);
    };
  }

  /**
   * Subscribe to changes for a specific path (or all paths if undefined).
   * Compatible with `useSyncExternalStore`.
   */
  public subscribe(path: string | undefined, callback: () => void): () => void {
    if (path === undefined) {
      this.globalSubscribers.add(callback as unknown as (event: ContentChangeEvent) => void);
      return () => {
        this.globalSubscribers.delete(callback as unknown as (event: ContentChangeEvent) => void);
      };
    }

    let subscribers = this.pathSubscribers.get(path);
    if (!subscribers) {
      subscribers = new Set();
      this.pathSubscribers.set(path, subscribers);
    }
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0) {
        this.pathSubscribers.delete(path);
      }
    };
  }

  /**
   * Subscribe to all content change events.
   * Used by MonacoModelService, FileTreeService, toast notifications.
   */
  public onDidContentChange(handler: (event: ContentChangeEvent) => void): () => void {
    this.globalSubscribers.add(handler);
    return () => {
      this.globalSubscribers.delete(handler);
    };
  }

  /**
   * Reset the service for a new root directory (e.g., project change).
   */
  public reset(rootDirectory: string): void {
    this.rootDirectory = rootDirectory;
    this.cache.clear();
    this.pendingResolves.clear();
    this.orphanedPaths.clear();
  }

  /**
   * Clean up all resources.
   */
  public dispose(): void {
    this.cache.clear();
    this.pendingResolves.clear();
    this.pathSubscribers.clear();
    this.globalSubscribers.clear();
    this.orphanedPaths.clear();
    this.orphanSubscribers.clear();
  }

  private setOrphaned(path: string, orphaned: boolean): void {
    const changed = orphaned ? !this.orphanedPaths.has(path) : this.orphanedPaths.has(path);
    if (!changed) {
      return;
    }
    if (orphaned) {
      this.orphanedPaths.add(path);
    } else {
      this.orphanedPaths.delete(path);
    }
    for (const handler of this.orphanSubscribers) {
      handler({ path, orphaned });
    }
  }

  private notifyPathSubscribers(path: string): void {
    const subscribers = this.pathSubscribers.get(path);
    if (subscribers) {
      for (const callback of subscribers) {
        callback();
      }
    }
  }

  private notifyGlobalSubscribers(event: ContentChangeEvent): void {
    for (const handler of this.globalSubscribers) {
      handler(event);
    }
  }

  private async resolveFromWorker(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const absolutePath = joinPath(this.rootDirectory, path);
    try {
      const data = await this.proxy.readFile(absolutePath);
      this.cache.set(path, data);
      this.setOrphaned(path, false);
      this.notifyPathSubscribers(path);
      this.notifyGlobalSubscribers({ type: 'read', path, data });
      return data;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.setOrphaned(path, true);
      }
      throw error;
    }
  }
}
