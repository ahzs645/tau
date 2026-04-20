import { BoundedFileCache } from '@taucad/filesystem';
import type { SharedPool } from '@taucad/memory';
import type { FileWriteSource, FileManagerProxy } from '#machines/file-manager.machine.types.js';
import { joinPath } from '@taucad/utils/path';
import { headSniffByteLength, seemsBinary } from '#lib/seems-binary.js';
import { BinaryFileError, FileNotFoundError, FileTooLargeError } from '#lib/file-content-errors.js';

export type ContentChangeEvent =
  | { type: 'written'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'read'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'renamed'; oldPath: string; newPath: string }
  | { type: 'deleted'; path: string; source: FileWriteSource }
  | { type: 'batchWritten'; paths: string[]; source: FileWriteSource };

/**
 * Discriminated outcome of a content resolve.
 * The hook + render layer route on `kind` instead of guessing from cache state.
 */
export type FileContentResult =
  | { kind: 'loading' }
  | { kind: 'text'; content: Uint8Array<ArrayBuffer> }
  | { kind: 'binary'; size: number; head: Uint8Array<ArrayBuffer> }
  | { kind: 'too-large'; size: number; limit: number }
  | { kind: 'orphaned' }
  | { kind: 'error'; cause: unknown };

export type ResolveOptions = {
  /** Bypass binary sniff and treat the bytes as text regardless. */
  readonly forceText?: boolean;
  /** Override the open-time size limit for this resolve only. */
  readonly sizeLimit?: number;
};

export type OutcomeChangeEvent = { path: string; result: FileContentResult };

type FileContentServiceInit = {
  proxy: FileManagerProxy;
  rootDirectory: string;
  cacheOptions?: {
    maxEntries?: number;
    maxTotalBytes?: number;
    maxSingleFileBytes?: number;
  };
  /**
   * Open-time size policy. Files exceeding this limit produce a `too-large`
   * outcome before the bytes are admitted to the cache. Distinct from
   * `cacheOptions.maxSingleFileBytes`, which only bounds memory pressure.
   * Defaults to 50 MiB (matches VS Code's web confirmation limit).
   */
  openSizeBytes?: number;
  /** Reader-side shared file pool for zero-IPC cached reads across threads. */
  filePool?: SharedPool;
};

const defaultMaxEntries = 500;
const defaultMaxTotalBytes = 128 * 1024 * 1024;
const defaultMaxSingleFileBytes = 1024 * 1024;
const defaultOpenSizeBytes = 50 * 1024 * 1024;

/**
 * Shared sentinel for unresolved paths. `peekOutcome` MUST return a
 * referentially-stable value when nothing has changed, otherwise
 * `useSyncExternalStore` consumers re-render in a loop and the
 * surrounding error boundary remounts the project tree (crash-loop).
 */
const loadingOutcome: FileContentResult = { kind: 'loading' };

export type OrphanChangeEvent = { path: string; orphaned: boolean };

/**
 * Single content authority on the main thread.
 * All content operations (read, write, rename, delete, duplicate)
 * go through this service. No consumer ever calls the proxy for
 * content operations directly.
 *
 * `resolve` returns a discriminated `FileContentResult` so that the
 * binary/too-large/orphaned/error decisions are made inside the read
 * pipeline rather than guessed from cache content in the render layer.
 * Callers that just want bytes use `resolveBytes`, which throws typed
 * errors for non-text outcomes.
 */
export class FileContentService {
  private readonly cache: BoundedFileCache;
  private readonly proxy: FileManagerProxy;
  private readonly filePool: SharedPool | undefined;
  private readonly openSizeBytes: number;
  private rootDirectory: string;
  private readonly pendingResolves = new Map<string, Promise<FileContentResult>>();
  private readonly outcomes = new Map<string, FileContentResult>();
  private readonly pathSubscribers = new Map<string, Set<() => void>>();
  private readonly globalSubscribers = new Set<(event: ContentChangeEvent) => void>();
  private readonly orphanedPaths = new Set<string>();
  private readonly orphanSubscribers = new Set<(event: OrphanChangeEvent) => void>();
  private readonly outcomeSubscribers = new Set<(event: OutcomeChangeEvent) => void>();

  public constructor(init: FileContentServiceInit) {
    this.proxy = init.proxy;
    this.rootDirectory = init.rootDirectory;
    this.filePool = init.filePool;
    this.openSizeBytes = init.openSizeBytes ?? defaultOpenSizeBytes;
    this.cache = new BoundedFileCache({
      maxEntries: init.cacheOptions?.maxEntries ?? defaultMaxEntries,
      maxTotalBytes: init.cacheOptions?.maxTotalBytes ?? defaultMaxTotalBytes,
      maxSingleFileBytes: init.cacheOptions?.maxSingleFileBytes ?? defaultMaxSingleFileBytes,
    });
  }

  /**
   * Resolve file content, returning a discriminated outcome that captures
   * the binary/too-large/orphaned/error decision inside the read pipeline.
   * Cache hit short-circuits the read and re-uses the cached `text` outcome.
   */
  public async resolve(path: string, options?: ResolveOptions): Promise<FileContentResult> {
    const cached = this.cache.get(path);
    if (cached !== undefined && !this.shouldRecompute(options)) {
      const existing = this.outcomes.get(path);
      if (existing?.kind === 'text') {
        return existing;
      }
      const refreshed: FileContentResult = { kind: 'text', content: cached };
      this.publishOutcome(path, refreshed);
      return refreshed;
    }

    const pending = this.pendingResolves.get(path);
    if (pending !== undefined && !this.shouldRecompute(options)) {
      return pending;
    }

    const promise = this.computeOutcome(path, options);
    this.pendingResolves.set(path, promise);

    try {
      return await promise;
    } finally {
      this.pendingResolves.delete(path);
    }
  }

  /**
   * Resolve file content as raw bytes, throwing typed errors for
   * non-text outcomes. Use this when the caller expects text bytes
   * (e.g. KCL LSP, RPC handlers, chat-stack-trace).
   */
  public async resolveBytes(path: string, options?: ResolveOptions): Promise<Uint8Array<ArrayBuffer>> {
    const result = await this.resolve(path, options);
    switch (result.kind) {
      case 'text': {
        return result.content;
      }
      case 'binary': {
        throw new BinaryFileError(`File '${path}' is binary and cannot be read as text`, {
          path,
          size: result.size,
        });
      }
      case 'too-large': {
        throw new FileTooLargeError(
          `File '${path}' (${result.size} bytes) exceeds open-time size limit (${result.limit} bytes)`,
          { path, size: result.size, limit: result.limit },
        );
      }
      case 'orphaned': {
        throw new FileNotFoundError(`File '${path}' was not found`, { path });
      }
      case 'error': {
        throw result.cause instanceof Error ? result.cause : new Error(String(result.cause));
      }
      case 'loading': {
        // ComputeOutcome never resolves to 'loading'; this branch is unreachable
        // but keeps the discriminator exhaustive for future kinds.
        throw new Error(`Unexpected 'loading' outcome for '${path}'`);
      }
    }
  }

  /**
   * Sync snapshot of the most recent outcome for a path.
   * Returns `{ kind: 'loading' }` when no outcome has been computed yet.
   * Compatible with `useSyncExternalStore`.
   */
  public peekOutcome(path: string): FileContentResult {
    return this.outcomes.get(path) ?? loadingOutcome;
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
    this.publishOutcome(path, { kind: 'text', content: localCopy });
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
      this.publishOutcome(path, { kind: 'text', content: localCopy });
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
    const oldOutcome = this.outcomes.get(oldPath);
    if (oldOutcome) {
      this.outcomes.delete(oldPath);
      this.publishOutcome(newPath, oldOutcome);
    }
    this.notifyPathSubscribers(oldPath);
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
    this.publishOutcome(path, { kind: 'orphaned' });
    this.notifyGlobalSubscribers({ type: 'deleted', path, source });
  }

  /**
   * Duplicate a file. Reads source via resolveBytes, writes dest via write.
   */
  public async duplicate(sourcePath: string, destinationPath: string): Promise<void> {
    const data = await this.resolveBytes(sourcePath);
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
   * Subscribe to outcome transitions for any path. Fires once per outcome
   * change with the new discriminated result. Mirrors VS Code's
   * `TextFileEditorModelManager.onDidResolve` channel.
   */
  public onDidChangeOutcome(handler: (event: OutcomeChangeEvent) => void): () => void {
    this.outcomeSubscribers.add(handler);
    return () => {
      this.outcomeSubscribers.delete(handler);
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
    this.outcomes.clear();
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
    this.outcomes.clear();
    this.outcomeSubscribers.clear();
  }

  private shouldRecompute(options?: ResolveOptions): boolean {
    return Boolean(options?.forceText) || options?.sizeLimit !== undefined;
  }

  private async computeOutcome(path: string, options?: ResolveOptions): Promise<FileContentResult> {
    const data = await this.readBytes(path);
    if (data === undefined) {
      // ReadBytes already published the orphaned/error outcome.
      return this.outcomes.get(path) ?? { kind: 'orphaned' };
    }

    const limit = options?.sizeLimit ?? this.openSizeBytes;
    const forceText = Boolean(options?.forceText);

    if (!forceText && seemsBinary(data)) {
      const head = data.slice(0, headSniffByteLength);
      const outcome: FileContentResult = { kind: 'binary', size: data.byteLength, head };
      this.publishOutcome(path, outcome);
      return outcome;
    }

    if (data.byteLength > limit) {
      const outcome: FileContentResult = { kind: 'too-large', size: data.byteLength, limit };
      this.publishOutcome(path, outcome);
      return outcome;
    }

    this.cache.set(path, data);
    const outcome: FileContentResult = { kind: 'text', content: data };
    this.publishOutcome(path, outcome);
    this.notifyGlobalSubscribers({ type: 'read', path, data });
    return outcome;
  }

  private async readBytes(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (this.filePool) {
      const absolutePath = joinPath(this.rootDirectory, path);
      const poolData = this.filePool.resolveCopy(absolutePath);
      if (poolData) {
        this.setOrphaned(path, false);
        return poolData;
      }
    }

    const absolutePath = joinPath(this.rootDirectory, path);
    try {
      const data = await this.proxy.readFile(absolutePath);
      this.setOrphaned(path, false);
      return data;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.setOrphaned(path, true);
        this.publishOutcome(path, { kind: 'orphaned' });
        return undefined;
      }
      this.publishOutcome(path, { kind: 'error', cause: error });
      return undefined;
    }
  }

  private publishOutcome(path: string, result: FileContentResult): void {
    const previous = this.outcomes.get(path);
    if (previous && outcomesEqual(previous, result)) {
      return;
    }
    this.outcomes.set(path, result);
    for (const handler of this.outcomeSubscribers) {
      handler({ path, result });
    }
    this.notifyPathSubscribers(path);
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
}

function outcomesEqual(a: FileContentResult, b: FileContentResult): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'loading':
    case 'orphaned': {
      return true;
    }
    case 'text': {
      const other = b as Extract<FileContentResult, { kind: 'text' }>;
      return a.content === other.content;
    }
    case 'binary': {
      const other = b as Extract<FileContentResult, { kind: 'binary' }>;
      return a.size === other.size && a.head === other.head;
    }
    case 'too-large': {
      const other = b as Extract<FileContentResult, { kind: 'too-large' }>;
      return a.size === other.size && a.limit === other.limit;
    }
    case 'error': {
      const other = b as Extract<FileContentResult, { kind: 'error' }>;
      return a.cause === other.cause;
    }
  }
}
