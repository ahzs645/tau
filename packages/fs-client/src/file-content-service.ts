import { BoundedFileCache } from '@taucad/filesystem';
import { PathSubscriberRegistry } from '#path-subscriber-registry.js';
import type { RefreshGenerationGuard } from '#refresh-generation-guard.js';
import type { WorkerChangeChannel, WorkerRelativeRenameEvent } from '#worker-change-channel.js';
import type { WorkspacePathResolver } from '#workspace-path-resolver.js';
import type { SharedPool } from '@taucad/memory';
import { joinPath } from '@taucad/utils/path';
import type { FileSystemClient } from '#file-system-client.js';
import type { FileWriteSource } from '#file-write-source.js';
import { headSniffByteLength, seemsBinary } from '#seems-binary.js';
import { BinaryFileError, FileNotFoundError, FileTooLargeError } from '#file-content-errors.js';

/**
 * Content-side mutation / read notifications for subscribers.
 *
 * @public
 */
export type ContentChangeEvent =
  | { type: 'written'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'read'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'renamed'; oldPath: string; newPath: string }
  | { type: 'deleted'; path: string; source: FileWriteSource }
  | { type: 'batchWritten'; paths: string[]; source: FileWriteSource };

/**
 * Discriminated outcome of a content resolve.
 * The hook + render layer route on `kind` instead of guessing from cache state.
 *
 * @public
 */
export type FileContentResult =
  | { kind: 'loading' }
  | { kind: 'text'; content: Uint8Array<ArrayBuffer> }
  | { kind: 'binary'; size: number; head: Uint8Array<ArrayBuffer> }
  | { kind: 'too-large'; size: number; limit: number }
  | { kind: 'orphaned' }
  | { kind: 'error'; cause: unknown };

/**
 * Options for {@link FileContentService.resolve}.
 *
 * @public
 */
export type ResolveOptions = {
  /** Bypass binary sniff and treat the bytes as text regardless. */
  readonly forceText?: boolean;
  /** Override the open-time size limit for this resolve only. */
  readonly sizeLimit?: number;
};

/**
 * Outcome publication event for `useSyncExternalStore` consumers.
 *
 * @public
 */
export type OutcomeChangeEvent = { path: string; result: FileContentResult };

type FileContentServiceInit = {
  proxy: FileSystemClient;
  paths: WorkspacePathResolver;
  channel: WorkerChangeChannel;
  refreshGuard: RefreshGenerationGuard;
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

/**
 * Orphan state transition for editor routing.
 *
 * @public
 */
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
 *
 * @public
 * @example <caption>Wire FileContentService with a worker change channel</caption>
 * ```typescript
 * import { FileContentService } from '@taucad/fs-client/file-content-service';
 * import { RefreshGenerationGuard } from '@taucad/fs-client/refresh-generation-guard';
 * import { WorkerChangeChannel } from '@taucad/fs-client/worker-change-channel';
 * import { WorkspacePathResolver } from '@taucad/fs-client/workspace-path-resolver';
 * import type { FileSystemClient } from '@taucad/fs-client/file-system-client';
 * import type { WorkerChangeChannelTransport } from '@taucad/fs-client/worker-change-channel';
 * export function createExampleFileContentService(
 *   proxy: FileSystemClient,
 *   listen: WorkerChangeChannelTransport['listen'],
 * ): FileContentService {
 *   const paths = new WorkspacePathResolver('/projects/p1');
 *   const channel = new WorkerChangeChannel({ transport: { listen }, paths });
 *   return new FileContentService({
 *     proxy,
 *     paths,
 *     channel,
 *     refreshGuard: new RefreshGenerationGuard(),
 *   });
 * }
 * ```
 */
export class FileContentService {
  private readonly cache: BoundedFileCache;
  private readonly proxy: FileSystemClient;
  private readonly filePool: SharedPool | undefined;
  private readonly openSizeBytes: number;
  private readonly paths: WorkspacePathResolver;
  private readonly refreshGuard: RefreshGenerationGuard;
  private readonly pendingResolves = new Map<string, Promise<FileContentResult>>();
  private readonly outcomes = new Map<string, FileContentResult>();
  private readonly pathNotifyRegistry = new PathSubscriberRegistry();
  private readonly contentChangeRegistry = new PathSubscriberRegistry<ContentChangeEvent>();
  private readonly orphanedPaths = new Set<string>();
  private readonly orphanSubscribers = new Set<(event: OrphanChangeEvent) => void>();
  private readonly outcomeSubscribers = new Set<(event: OutcomeChangeEvent) => void>();
  private readonly unsubscribeChannel: Array<() => void>;

  public constructor(init: FileContentServiceInit) {
    this.proxy = init.proxy;
    this.paths = init.paths;
    this.refreshGuard = init.refreshGuard;
    this.filePool = init.filePool;
    this.openSizeBytes = init.openSizeBytes ?? defaultOpenSizeBytes;
    this.cache = new BoundedFileCache({
      maxEntries: init.cacheOptions?.maxEntries ?? defaultMaxEntries,
      maxTotalBytes: init.cacheOptions?.maxTotalBytes ?? defaultMaxTotalBytes,
      maxSingleFileBytes: init.cacheOptions?.maxSingleFileBytes ?? defaultMaxSingleFileBytes,
    });
    this.unsubscribeChannel = [
      init.channel.onFileWritten({
        handler: (event) => {
          this.onWorkerFileWritten(event.path);
        },
      }),
      init.channel.onFileDeleted({
        handler: (event) => {
          this.onWorkerFileDeleted(event.path);
        },
      }),
      init.channel.onFileRenamed({
        handler: (event) => {
          this.onWorkerFileRenamed(event);
        },
      }),
      init.channel.onDirectoryChanged({
        handler: (event) => {
          this.refreshOpenPathsUnderDirectory(event.path);
        },
      }),
      init.channel.onBackendChanged(() => {
        this.onWorkerBackendChanged();
      }),
    ];
  }

  /**
   * Resolve file content, returning a discriminated outcome that captures
   * the binary/too-large/orphaned/error decision inside the read pipeline.
   * Cache hit short-circuits the read and re-uses the cached `text` outcome.
   * @param path - Workspace-relative path.
   * @param options - Optional resolve overrides (`forceText`, `sizeLimit`).
   * @returns Latest discriminated {@link FileContentResult} for the path.
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
   * @param path - Workspace-relative path.
   * @param options - Optional resolve overrides (`forceText`, `sizeLimit`).
   * @returns Raw UTF-8 bytes when the outcome is representable as text.
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
   * @param path - Workspace-relative path.
   * @returns Referentially stable {@link FileContentResult} snapshot (may be the shared loading sentinel).
   */
  public peekOutcome(path: string): FileContentResult {
    return this.outcomes.get(path) ?? loadingOutcome;
  }

  /**
   * Write file content. Clones buffer before transfer to prevent detachment.
   * @param path - Workspace-relative path.
   * @param data - Bytes to persist (copied before crossing the worker boundary).
   * @param source - Provenance tag for downstream refresh heuristics.
   */
  public async write(path: string, data: Uint8Array<ArrayBuffer>, source: FileWriteSource): Promise<void> {
    const localCopy = new Uint8Array(data);
    const absolutePath = joinPath(this.paths.root, path);
    await this.proxy.writeFile(absolutePath, data);
    this.cache.set(path, localCopy);
    this.setOrphaned(path, false);
    this.publishOutcome(path, { kind: 'text', content: localCopy });
    this.notifyGlobalSubscribers({ type: 'written', path, data: localCopy, source });
  }

  /**
   * Write multiple files. Clones each buffer before transfer.
   * @param files - Map of relative paths to file payloads.
   * @param source - Provenance tag for downstream refresh heuristics.
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
      absoluteFiles[joinPath(this.paths.root, path)] = file;
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
   * @param oldPath - Previous workspace-relative path.
   * @param newPath - Target workspace-relative path.
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    const absoluteOldPath = joinPath(this.paths.root, oldPath);
    const absoluteNewPath = joinPath(this.paths.root, newPath);
    await this.proxy.rename(absoluteOldPath, absoluteNewPath);
    this.cache.rename(oldPath, newPath);
    const oldOutcome = this.outcomes.get(oldPath);
    if (oldOutcome) {
      this.outcomes.delete(oldPath);
      this.publishOutcome(newPath, oldOutcome);
    }
    this.pathNotifyRegistry.notifyPath(oldPath, undefined);
    this.notifyGlobalSubscribers({ type: 'renamed', oldPath, newPath });
  }

  /**
   * Delete a file. Removes from cache and notifies subscribers.
   * @param path - Workspace-relative path.
   * @param source - Provenance tag for downstream refresh heuristics.
   */
  public async delete(path: string, source: FileWriteSource): Promise<void> {
    const absolutePath = joinPath(this.paths.root, path);
    await this.proxy.unlink(absolutePath);
    this.cache.delete(path);
    this.setOrphaned(path, true);
    this.publishOutcome(path, { kind: 'orphaned' });
    this.notifyGlobalSubscribers({ type: 'deleted', path, source });
  }

  /**
   * Duplicate a file. Reads source via resolveBytes, writes dest via write.
   * @param sourcePath - Existing workspace-relative file path.
   * @param destinationPath - Destination workspace-relative file path.
   */
  public async duplicate(sourcePath: string, destinationPath: string): Promise<void> {
    const data = await this.resolveBytes(sourcePath);
    await this.write(destinationPath, data, 'user');
  }

  /**
   * Copy a directory. Proxy pass-through, no content caching.
   * Fires batchWritten so FileTreeService refreshes.
   * @param source - Source directory (worker-resolved path form expected by proxy).
   * @param destination - Destination directory for the copy operation.
   */
  public async copyDirectory(source: string, destination: string): Promise<void> {
    await this.proxy.copyDirectory(source, destination);
    this.notifyGlobalSubscribers({ type: 'batchWritten', paths: [], source: 'user' });
  }

  /**
   * Get a zipped archive of a directory. Proxy pass-through.
   * @param path - Absolute or workspace-relative path accepted by the worker proxy.
   * @returns Blob containing the archive bytes from the worker.
   */
  public async getZippedDirectory(path: string): Promise<Blob> {
    return this.proxy.getZippedDirectory(path);
  }

  /**
   * Read cached content without LRU promotion. Safe for React renders.
   * @param path - Workspace-relative path.
   * @returns Cached bytes, or `undefined` when nothing is cached.
   */
  public peek(path: string): Uint8Array<ArrayBuffer> | undefined {
    return this.cache.peek(path);
  }

  /**
   * Check if content is cached for the given path.
   * @param path - Workspace-relative path.
   * @returns `true` when an entry exists in the bounded file cache.
   */
  public has(path: string): boolean {
    return this.cache.has(path);
  }

  /**
   * Sync check of cached orphan flag. A file is orphaned when a resolve
   * attempt fails with ENOENT or after an explicit delete.
   * @param path - Workspace-relative path.
   * @returns `true` when the path is currently marked orphaned.
   */
  public isOrphaned(path: string): boolean {
    return this.orphanedPaths.has(path);
  }

  /**
   * Subscribe to orphan state transitions. Fires when a path transitions
   * between orphaned and non-orphaned.
   * @param handler - Called with `{ path, orphaned }` on transitions.
   * @returns Unsubscribe function removing `handler`.
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
   * @param handler - Called with `{ path, result }` whenever an outcome changes.
   * @returns Unsubscribe function removing `handler`.
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
   * @param path - Workspace-relative path, or `undefined` for global invalidation taps.
   * @param callback - Invoked whenever matching content notifications fire.
   * @returns Unsubscribe function removing this subscription.
   */
  public subscribe(path: string | undefined, callback: () => void): () => void {
    if (path === undefined) {
      return this.contentChangeRegistry.subscribeGlobal((_event: ContentChangeEvent) => {
        callback();
      });
    }
    return this.pathNotifyRegistry.subscribePath(path, () => {
      callback();
    });
  }

  /**
   * Subscribe to all content change events.
   * Used by MonacoModelService, FileTreeService, toast notifications.
   * @param handler - Invoked for every {@link ContentChangeEvent}.
   * @returns Unsubscribe function removing `handler`.
   */
  public onDidContentChange(handler: (event: ContentChangeEvent) => void): () => void {
    return this.contentChangeRegistry.subscribeGlobal(handler);
  }

  /**
   * Reset the service for a new root directory (e.g., project change).
   * @param rootDirectory - New absolute project root used by {@link WorkspacePathResolver}.
   */
  public reset(rootDirectory: string): void {
    this.paths.reset(rootDirectory);
    this.cache.clear();
    this.pendingResolves.clear();
    this.orphanedPaths.clear();
    this.outcomes.clear();
    this.refreshGuard.reset();
  }

  /**
   * Release workers, caches, and subscriptions owned by this service.
   */
  public dispose(): void {
    for (const unsubscribe of this.unsubscribeChannel) {
      unsubscribe();
    }
    this.cache.clear();
    this.pendingResolves.clear();
    this.pathNotifyRegistry.clear();
    this.contentChangeRegistry.clear();
    this.orphanedPaths.clear();
    this.orphanSubscribers.clear();
    this.outcomes.clear();
    this.outcomeSubscribers.clear();
    this.refreshGuard.reset();
  }

  private shouldRecompute(options?: ResolveOptions): boolean {
    return Boolean(options?.forceText) || options?.sizeLimit !== undefined;
  }

  private onWorkerFileWritten(relativePath: string): void {
    this.setOrphaned(relativePath, false);
    if (this.shouldRefreshWorkerPath(relativePath)) {
      // async-iife: bootstrap
      // oxlint-disable-next-line promise/prefer-await-to-then -- fire-and-forget refresh
      void this.refreshOutcomeInPlace(relativePath).catch(() => undefined);
    } else {
      this.cache.delete(relativePath);
    }
  }

  private onWorkerFileDeleted(relativePath: string): void {
    this.cache.delete(relativePath);
    this.setOrphaned(relativePath, true);
    this.publishOutcome(relativePath, { kind: 'orphaned' });
  }

  private onWorkerFileRenamed(event: WorkerRelativeRenameEvent): void {
    const { oldPath, newPath } = event;
    if (oldPath !== undefined) {
      this.cache.delete(oldPath);
      this.refreshGuard.reset(oldPath);
      this.setOrphaned(oldPath, true);
      this.publishOutcome(oldPath, { kind: 'orphaned' });
    }
    if (newPath !== undefined) {
      this.cache.delete(newPath);
      this.setOrphaned(newPath, false);
      if (this.shouldRefreshWorkerPath(newPath)) {
        // async-iife: bootstrap
        // oxlint-disable-next-line promise/prefer-await-to-then -- fire-and-forget refresh
        void this.refreshOutcomeInPlace(newPath).catch(() => undefined);
      }
    }
  }

  private onWorkerBackendChanged(): void {
    const pathsToRefresh = new Set<string>([...this.outcomes.keys(), ...this.pathNotifyRegistry.subscribedPaths()]);
    for (const [path] of this.cache.entries()) {
      pathsToRefresh.add(path);
    }
    this.cache.clear();
    this.orphanedPaths.clear();
    for (const path of pathsToRefresh) {
      // async-iife: bootstrap
      // oxlint-disable-next-line promise/prefer-await-to-then -- fire-and-forget refresh
      void this.refreshOutcomeInPlace(path).catch(() => undefined);
    }
  }

  /**
   * Re-run in-place refresh for every open path under a workspace-relative
   * directory prefix (from `directoryChanged`).
   * @param relativeDirectory - Workspace-relative directory key (possibly `''` for root).
   */
  private refreshOpenPathsUnderDirectory(relativeDirectory: string): void {
    const directoryPrefix =
      relativeDirectory === '' ? '' : relativeDirectory.endsWith('/') ? relativeDirectory : `${relativeDirectory}/`;
    const toRefresh = new Set<string>();
    for (const path of this.outcomes.keys()) {
      if (directoryPrefix === '' || path === relativeDirectory || path.startsWith(directoryPrefix)) {
        toRefresh.add(path);
      }
    }
    for (const [path] of this.cache.entries()) {
      if (directoryPrefix === '' || path === relativeDirectory || path.startsWith(directoryPrefix)) {
        toRefresh.add(path);
      }
    }
    for (const path of this.pathNotifyRegistry.subscribedPaths()) {
      if (directoryPrefix === '' || path === relativeDirectory || path.startsWith(directoryPrefix)) {
        toRefresh.add(path);
      }
    }
    for (const path of toRefresh) {
      // async-iife: bootstrap
      // oxlint-disable-next-line promise/prefer-await-to-then -- fire-and-forget refresh
      void this.refreshOutcomeInPlace(path).catch(() => undefined);
    }
  }

  private shouldRefreshWorkerPath(relative: string): boolean {
    return (
      this.outcomes.has(relative) || this.cache.has(relative) || this.pathNotifyRegistry.hasPathSubscribers(relative)
    );
  }

  /**
   * Re-run read + binary / size classification for `path` and publish when
   * this refresh is still the newest for the path (interleaved worker events).
   * @param path - Workspace-relative file path.
   */
  private async refreshOutcomeInPlace(path: string): Promise<void> {
    const generation = this.refreshGuard.begin(path);
    const data = await this.readBytes(path);
    if (!this.refreshGuard.isCurrent(path, generation)) {
      return;
    }
    if (data === undefined) {
      return;
    }

    const limit = this.openSizeBytes;

    if (seemsBinary(data)) {
      const head = data.slice(0, headSniffByteLength);
      const outcome: FileContentResult = { kind: 'binary', size: data.byteLength, head };
      if (!this.refreshGuard.isCurrent(path, generation)) {
        return;
      }
      this.cache.delete(path);
      this.publishOutcome(path, outcome);
      return;
    }

    if (data.byteLength > limit) {
      const outcome: FileContentResult = { kind: 'too-large', size: data.byteLength, limit };
      if (!this.refreshGuard.isCurrent(path, generation)) {
        return;
      }
      this.cache.delete(path);
      this.publishOutcome(path, outcome);
      return;
    }

    if (!this.refreshGuard.isCurrent(path, generation)) {
      return;
    }
    this.cache.set(path, data);
    const outcome: FileContentResult = { kind: 'text', content: data };
    this.publishOutcome(path, outcome);
    this.notifyGlobalSubscribers({ type: 'read', path, data });
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
      const absolutePath = joinPath(this.paths.root, path);
      const poolData = this.filePool.resolveCopy(absolutePath);
      if (poolData) {
        this.setOrphaned(path, false);
        return poolData;
      }
    }

    const absolutePath = joinPath(this.paths.root, path);
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
    this.pathNotifyRegistry.notifyPath(path, undefined);
  }

  private notifyGlobalSubscribers(event: ContentChangeEvent): void {
    this.contentChangeRegistry.notifyGlobal(event);
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
