import type { ChangeEvent, FileSystemBackend } from '@taucad/types';
import { normalizePath } from '@taucad/utils/path';
import type { WorkspacePathResolver } from '#workspace-path-resolver.js';

/**
 * Transport surface required to wire worker push events (typically
 * `proxy.listen` from the file manager worker).
 *
 * @public
 */
export type WorkerChangeChannelTransport = {
  listen: (event: string, handler: (data: unknown) => void) => () => void;
};

/**
 * Subscription registered on {@link WorkerChangeChannel} fan-out queues.
 *
 * @public
 */
export type WorkerChangeSubscription<T> = {
  readonly handler: (event: T) => void;
  /** When set, the handler runs only if this returns true for the relative path. */
  readonly interestedIn?: (relativePath: string) => boolean;
};

/**
 * Rename notification with workspace-relative paths (`undefined` when that
 * side of the rename is outside the project root).
 *
 * @public
 */
export type WorkerRelativeRenameEvent = {
  readonly type: 'fileRenamed';
  readonly oldPath: string | undefined;
  readonly newPath: string | undefined;
  readonly backend: FileSystemBackend;
};

function isChangeEvent(value: unknown): value is ChangeEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const { type } = value as { type: unknown };
  return (
    type === 'fileWritten' ||
    type === 'fileDeleted' ||
    type === 'fileRenamed' ||
    type === 'directoryChanged' ||
    type === 'backendChanged'
  );
}

/**
 * Owns a single `fileChanged` subscription and fans out typed, workspace-relative
 * events to facades. Does not suppress self-writes — the runtime bridge already
 * skips the originator.
 *
 * @public
 * @example <caption>Subscribe to file writes with a path filter</caption>
 * ```typescript
 * import { WorkerChangeChannel } from '@taucad/fs-client/worker-change-channel';
 * import { WorkspacePathResolver } from '@taucad/fs-client/workspace-path-resolver';
 * import type { WorkerChangeChannelTransport } from '@taucad/fs-client/worker-change-channel';
 * export function exampleWorkerChannel(listen: WorkerChangeChannelTransport['listen']): WorkerChangeChannel {
 *   const paths = new WorkspacePathResolver('/project');
 *   const channel = new WorkerChangeChannel({ transport: { listen }, paths });
 *   const openPaths = new Set<string>(['a.ts']);
 *   channel.onFileWritten({
 *     interestedIn: (relativePath: string) => openPaths.has(relativePath),
 *     handler: () => undefined,
 *   });
 *   return channel;
 * }
 * ```
 */
export class WorkerChangeChannel {
  private readonly paths: WorkspacePathResolver;
  private readonly unlisten: () => void;
  private readonly fileWrittenSubs: Array<
    WorkerChangeSubscription<{ type: 'fileWritten'; path: string; backend: FileSystemBackend }>
  > = [];
  private readonly fileDeletedSubs: Array<
    WorkerChangeSubscription<{ type: 'fileDeleted'; path: string; backend: FileSystemBackend }>
  > = [];
  private readonly fileRenamedSubs: Array<WorkerChangeSubscription<WorkerRelativeRenameEvent>> = [];
  private readonly directoryChangedSubs: Array<
    WorkerChangeSubscription<{ type: 'directoryChanged'; path: string; backend: FileSystemBackend }>
  > = [];
  private readonly backendChangedSubs: Array<(event: Extract<ChangeEvent, { type: 'backendChanged' }>) => void> = [];

  public constructor(deps: { transport: WorkerChangeChannelTransport; paths: WorkspacePathResolver }) {
    this.paths = deps.paths;
    this.unlisten = deps.transport.listen('fileChanged', (data: unknown) => {
      this.dispatch(data);
    });
  }

  /**
   * Subscribe to normalized `fileWritten` events for this project.
   * @param sub - Handler plus optional path filter.
   * @returns Unsubscribe function removing `sub`.
   */
  public onFileWritten(
    sub: WorkerChangeSubscription<{ type: 'fileWritten'; path: string; backend: FileSystemBackend }>,
  ): () => void {
    this.fileWrittenSubs.push(sub);
    return () => {
      const index = this.fileWrittenSubs.indexOf(sub);
      if (index !== -1) {
        this.fileWrittenSubs.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to normalized `fileDeleted` events for this project.
   * @param sub - Handler plus optional path filter.
   * @returns Unsubscribe function removing `sub`.
   */
  public onFileDeleted(
    sub: WorkerChangeSubscription<{ type: 'fileDeleted'; path: string; backend: FileSystemBackend }>,
  ): () => void {
    this.fileDeletedSubs.push(sub);
    return () => {
      const index = this.fileDeletedSubs.indexOf(sub);
      if (index !== -1) {
        this.fileDeletedSubs.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to rename notifications with workspace-relative path edges.
   * @param sub - Handler plus optional path filter covering either edge.
   * @returns Unsubscribe function removing `sub`.
   */
  public onFileRenamed(sub: WorkerChangeSubscription<WorkerRelativeRenameEvent>): () => void {
    this.fileRenamedSubs.push(sub);
    return () => {
      const index = this.fileRenamedSubs.indexOf(sub);
      if (index !== -1) {
        this.fileRenamedSubs.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to directory mutation summaries coalesced by the worker.
   * @param sub - Handler plus optional prefix filter.
   * @returns Unsubscribe function removing `sub`.
   */
  public onDirectoryChanged(
    sub: WorkerChangeSubscription<{ type: 'directoryChanged'; path: string; backend: FileSystemBackend }>,
  ): () => void {
    this.directoryChangedSubs.push(sub);
    return () => {
      const index = this.directoryChangedSubs.indexOf(sub);
      if (index !== -1) {
        this.directoryChangedSubs.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to backend swap events (IndexedDB ↔ OPFS, etc.).
   * @param handler - Invoked whenever the worker reports a backend transition.
   * @returns Unsubscribe function removing `handler`.
   */
  public onBackendChanged(handler: (event: Extract<ChangeEvent, { type: 'backendChanged' }>) => void): () => void {
    this.backendChangedSubs.push(handler);
    return () => {
      const index = this.backendChangedSubs.indexOf(handler);
      if (index !== -1) {
        this.backendChangedSubs.splice(index, 1);
      }
    };
  }

  /**
   * Detach the underlying `fileChanged` listener and drop subscriber lists.
   */
  public dispose(): void {
    this.unlisten();
    this.fileWrittenSubs.length = 0;
    this.fileDeletedSubs.length = 0;
    this.fileRenamedSubs.length = 0;
    this.directoryChangedSubs.length = 0;
    this.backendChangedSubs.length = 0;
  }

  private dispatch(data: unknown): void {
    if (!isChangeEvent(data)) {
      return;
    }
    switch (data.type) {
      case 'fileWritten': {
        this.dispatchFileWritten(data);
        break;
      }
      case 'fileDeleted': {
        this.dispatchFileDeleted(data);
        break;
      }
      case 'fileRenamed': {
        this.dispatchFileRenamed(data);
        break;
      }
      case 'directoryChanged': {
        this.dispatchDirectoryChanged(data);
        break;
      }
      case 'backendChanged': {
        this.dispatchBackendChanged(data);
        break;
      }
    }
  }

  private dispatchFileWritten(data: Extract<ChangeEvent, { type: 'fileWritten' }>): void {
    const relativePath = this.paths.toRelativePath(data.path);
    if (relativePath === undefined) {
      return;
    }
    for (const sub of this.fileWrittenSubs) {
      if (sub.interestedIn && !sub.interestedIn(relativePath)) {
        continue;
      }
      sub.handler({ type: 'fileWritten', path: relativePath, backend: data.backend });
    }
  }

  private dispatchFileDeleted(data: Extract<ChangeEvent, { type: 'fileDeleted' }>): void {
    const relativePath = this.paths.toRelativePath(data.path);
    if (relativePath === undefined) {
      return;
    }
    for (const sub of this.fileDeletedSubs) {
      if (sub.interestedIn && !sub.interestedIn(relativePath)) {
        continue;
      }
      sub.handler({ type: 'fileDeleted', path: relativePath, backend: data.backend });
    }
  }

  private dispatchFileRenamed(data: Extract<ChangeEvent, { type: 'fileRenamed' }>): void {
    const oldPath = this.paths.toRelativePath(data.oldPath);
    const newPath = this.paths.toRelativePath(data.newPath);
    if (oldPath === undefined && newPath === undefined) {
      return;
    }
    for (const sub of this.fileRenamedSubs) {
      const gate =
        sub.interestedIn === undefined ||
        (oldPath !== undefined && sub.interestedIn(oldPath)) ||
        (newPath !== undefined && sub.interestedIn(newPath));
      if (!gate) {
        continue;
      }
      sub.handler({
        type: 'fileRenamed',
        oldPath,
        newPath,
        backend: data.backend,
      });
    }
  }

  private dispatchDirectoryChanged(data: Extract<ChangeEvent, { type: 'directoryChanged' }>): void {
    const directoryAbsolute = data.path;
    const rootNorm = normalizePath(this.paths.root);
    const directoryNorm = normalizePath(directoryAbsolute);
    const relativeDirectory = directoryNorm === rootNorm ? '' : this.paths.toRelativePath(directoryAbsolute);
    if (relativeDirectory === undefined) {
      return;
    }
    for (const sub of this.directoryChangedSubs) {
      if (sub.interestedIn && !sub.interestedIn(relativeDirectory)) {
        continue;
      }
      sub.handler({ type: 'directoryChanged', path: relativeDirectory, backend: data.backend });
    }
  }

  private dispatchBackendChanged(data: Extract<ChangeEvent, { type: 'backendChanged' }>): void {
    for (const handler of this.backendChangedSubs) {
      handler(data);
    }
  }
}
