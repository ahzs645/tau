import { assign, assertEvent, setup, fromCallback, enqueueActions, emit, spawnChild, stopChild } from 'xstate';
import type { AnyEventObject } from 'xstate';
import type { FileEntry, FileSystemBackend } from '@taucad/types';
import { createBridgeProxy, createFileSystemBridge } from '@taucad/runtime/filesystem';
import { safeDispose } from '@taucad/utils/dispose';
import { BoundedFileCache } from '@taucad/filesystem';
import FileManagerWorker from '#machines/file-manager.worker.js?worker';
import { getStoredDirectoryHandle, getBuildFileSystemConfig, checkHandlePermission } from '#filesystem/handle-store.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { normalizePath, joinPath } from '@taucad/utils/path';
import type {
  FileWriteSource,
  FileManagerEmitted,
  FileManagerProxy,
  FileManagerProtocol,
} from '#machines/file-manager.machine.types.js';

const watchIntervalFocusedMs = 2000;
const watchIntervalBlurredMs = 10_000;

const fileCacheMaxEntries = 200;
const fileCacheMaxTotalBytes = 50 * 1024 * 1024;
const fileCacheMaxSingleFileBytes = 1024 * 1024;

type FileManagerContext = {
  worker: Worker | undefined;
  proxy: (FileManagerProxy & { listen?: (event: string, handler: (data: unknown) => void) => () => void }) | undefined;
  bridgeDispose?: () => void;
  fileTree: Map<string, FileEntry>;
  fileCache: BoundedFileCache;
  error: Error | undefined;
  rootDirectory: string;
  shouldInitializeOnStart: boolean;
  isWatching: boolean;
  backendType: FileSystemBackend;
  webAccessNeedsPermission: boolean;
  buildId: string | undefined;
  sharedWorker: Worker | undefined;
  /** Unsubscribe function for bridge event listener */
  eventUnsubscribe: (() => void) | undefined;
};

// ============ Lifecycle Actors ============

type WorkerInitializedEvent = {
  type: 'workerInitialized';
  worker: Worker;
  proxy: FileManagerProxy & { listen?: (event: string, handler: (data: unknown) => void) => () => void };
  bridgeDispose: () => void;
  configuredBackend: FileSystemBackend;
  webAccessNeedsPermission: boolean;
  initialEntries: FileEntry[];
};

const initializeWorkerActor = fromSafeAsync<WorkerInitializedEvent, { context: FileManagerContext }>(
  async ({ input, signal }) => {
    const { context } = input;
    const initT0 = performance.now();
    console.debug(`[FileManager] initializeWorkerActor: start +${initT0.toFixed(0)}ms`);

    safeDispose(() => context.proxy?.dispose());
    safeDispose(context.bridgeDispose);

    if (context.worker && !context.sharedWorker) {
      safeDispose(() => context.worker?.terminate());
    }

    const worker = context.sharedWorker ?? new FileManagerWorker({ name: `fm-root` });
    console.debug(`[FileManager] worker created +${(performance.now() - initT0).toFixed(1)}ms`);
    worker.addEventListener('message', (event) => {
      if (event.data?.type === '__worker_ready__') {
        console.debug(`[FileManager] worker heartbeat received +${(performance.now() - initT0).toFixed(1)}ms`);
      }
    });
    worker.addEventListener('error', (error) => {
      console.error(`[FileManager] WORKER ERROR:`, error.message, error.filename, error.lineno);
    });
    const { port, dispose: bridgeDispose } = createFileSystemBridge(worker);
    console.debug(`[FileManager] bridge created, port transferred +${(performance.now() - initT0).toFixed(1)}ms`);
    const proxy = createBridgeProxy<FileManagerProtocol>(port);
    console.debug(`[FileManager] proxy created +${(performance.now() - initT0).toFixed(1)}ms`);

    let backend = context.backendType;
    if (context.buildId) {
      signal.throwIfAborted();
      const buildBackend = await getBuildFileSystemConfig(context.buildId);
      backend = buildBackend ?? 'indexeddb';
    }

    if (backend === 'opfs') {
      backend = 'indexeddb';
    }

    let webAccessNeedsPermission = false;

    if (backend === 'webaccess') {
      const workspaceHandle = await getStoredDirectoryHandle();
      if (workspaceHandle) {
        const permission = await checkHandlePermission(workspaceHandle);
        if (permission === 'granted') {
          proxy.setDirectoryHandle(workspaceHandle);
          await proxy.reconfigure('webaccess');
        } else {
          webAccessNeedsPermission = true;
          backend = 'indexeddb';
        }
      } else {
        webAccessNeedsPermission = true;
        backend = 'indexeddb';
      }
    } else if (backend !== 'indexeddb') {
      await proxy.reconfigure(backend);
    }

    let initialEntries: FileEntry[] = [];
    try {
      const rootPath = context.rootDirectory;
      const absolutePath = normalizePath(rootPath);
      console.debug(
        `[FileManager] calling getDirectoryStat('${absolutePath}') +${(performance.now() - initT0).toFixed(1)}ms`,
      );
      const fileStats = await proxy.getDirectoryStat(absolutePath);
      console.debug(
        `[FileManager] getDirectoryStat returned ${fileStats.length} entries +${(performance.now() - initT0).toFixed(1)}ms`,
      );
      for (const fileStat of fileStats) {
        initialEntries.push({
          path: fileStat.path,
          name: fileStat.name,
          type: fileStat.type,
          size: fileStat.size,
          isLoaded: false,
        });
      }
    } catch (error) {
      console.debug('[FileManager] Initial tree hydration failed (empty filesystem?):', error);
      initialEntries = [];
    }

    console.debug('[FileManager] initializeWorkerActor: success');
    return {
      type: 'workerInitialized',
      worker,
      proxy,
      bridgeDispose,
      configuredBackend: backend,
      webAccessNeedsPermission,
      initialEntries,
    };
  },
);

type DirectoryReadEvent = { type: 'directoryRead'; entries: FileEntry[] };

const readDirectoryActor = fromSafeAsync<DirectoryReadEvent, { context: FileManagerContext; path: string }>(
  async ({ input, signal }) => {
    const { context, path } = input;

    signal.throwIfAborted();

    if (!context.proxy) {
      throw new Error('Worker not initialized');
    }

    const absolutePath = path === '' ? normalizePath(context.rootDirectory) : joinPath(context.rootDirectory, path);
    const fileStats = await context.proxy.getDirectoryStat(absolutePath);
    const entries: FileEntry[] = [];

    for (const fileStat of fileStats) {
      const relativeFilePath = path === '' ? fileStat.path : joinPath(path, fileStat.path);
      entries.push({
        path: relativeFilePath,
        name: fileStat.name,
        type: fileStat.type,
        size: fileStat.size,
        isLoaded: false,
      });
    }

    return { type: 'directoryRead', entries };
  },
);

const fileWatcherActor = fromCallback<AnyEventObject>(({ sendBack }) => {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  const startPolling = (): void => {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    const interval = document.visibilityState === 'visible' ? watchIntervalFocusedMs : watchIntervalBlurredMs;
    intervalId = setInterval(() => {
      sendBack({ type: 'pollFileSystem' });
    }, interval);
  };

  const handleVisibilityChange = (): void => {
    startPolling();
    if (document.visibilityState === 'visible') {
      sendBack({ type: 'pollFileSystem' });
    }
  };

  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
});

const fileManagerActors = {
  initializeWorkerActor,
  readDirectoryActor,
  fileWatcherActor,
} as const;

// ============ Events ============

type FileManagerEventLifecycle =
  | { type: 'initialize' }
  | { type: 'setRoot'; path: string; buildId?: string }
  | { type: 'setBackendType'; backendType: FileSystemBackend }
  | { type: 'startWatching' }
  | { type: 'stopWatching' }
  | { type: 'pollFileSystem' };

type FileManagerEventMutation =
  | {
      type: 'fileWritten';
      path: string;
      data: Uint8Array<ArrayBuffer>;
      source: FileWriteSource;
    }
  | { type: 'fileRead'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource }
  | { type: 'filesWritten'; paths: string[] };

type FileManagerEventInternal = FileManagerEventLifecycle | FileManagerEventMutation;

type FileManagerEvent = FileManagerEventInternal | WorkerInitializedEvent | DirectoryReadEvent;

type FileManagerInput = {
  rootDirectory: string;
  shouldInitializeOnStart?: boolean;
  initialBackend?: FileSystemBackend;
  buildId?: string;
  sharedWorker?: Worker;
};

export const fileManagerMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    context: {} as FileManagerContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    events: {} as FileManagerEvent,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    input: {} as FileManagerInput,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- type assertion required
    emitted: {} as FileManagerEmitted,
  },
  actors: fileManagerActors,
  actions: {
    setError: assign({
      error({ event }) {
        if ('error' in event && event.error instanceof Error) {
          console.error('[ZenFS] File manager error:', event.error);
          return event.error;
        }
        return undefined;
      },
    }),

    clearError: assign({ error: undefined }),

    destroyWorker: assign(({ context }) => {
      safeDispose(() => context.proxy?.dispose());
      safeDispose(context.bridgeDispose);
      safeDispose(context.eventUnsubscribe);

      if (!context.sharedWorker) {
        safeDispose(() => context.worker?.terminate());
      }

      return {
        proxy: undefined,
        bridgeDispose: undefined,
        worker: context.sharedWorker ? context.worker : undefined,
        eventUnsubscribe: undefined,
      };
    }),

    updateRootAndReset: assign({
      rootDirectory({ event }) {
        assertEvent(event, 'setRoot');
        return event.path;
      },
      buildId({ event }) {
        assertEvent(event, 'setRoot');
        return event.buildId;
      },
      fileTree: () => new Map(),
      fileCache: () =>
        new BoundedFileCache({
          maxEntries: fileCacheMaxEntries,
          maxTotalBytes: fileCacheMaxTotalBytes,
          maxSingleFileBytes: fileCacheMaxSingleFileBytes,
        }),
      error: undefined,
      isWatching: false,
    }),

    updateBackendFromInit: assign({
      worker({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.worker;
      },
      proxy({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.proxy;
      },
      bridgeDispose({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.bridgeDispose;
      },
      backendType({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.configuredBackend;
      },
      webAccessNeedsPermission({ event }) {
        assertEvent(event, 'workerInitialized');
        return event.webAccessNeedsPermission;
      },
      fileTree({ event }) {
        assertEvent(event, 'workerInitialized');
        const newTree = new Map<string, FileEntry>();
        for (const entry of event.initialEntries) {
          newTree.set(entry.path, entry);
        }
        return newTree;
      },
    }),

    updateBackendType: assign({
      backendType({ event }) {
        assertEvent(event, 'setBackendType');
        return event.backendType;
      },
    }),

    // ============ File Tree Actions ============

    replaceFileTreeFromBackgroundRefresh: assign({
      fileTree({ event }) {
        assertEvent(event, 'directoryRead');
        const newTree = new Map<string, FileEntry>();
        for (const entry of event.entries) {
          newTree.set(entry.path, entry);
        }
        return newTree;
      },
    }),

    spawnBackgroundRefresh: enqueueActions(({ enqueue }) => {
      enqueue(stopChild('backgroundRefresh'));
      enqueue(
        spawnChild('readDirectoryActor', {
          id: 'backgroundRefresh',
          input: ({ context }) => ({ context, path: '' }),
        }),
      );
    }),

    // ============ File Cache Actions ============

    updateFileCacheFromWritten: assign({
      fileCache({ context, event }) {
        assertEvent(event, 'fileWritten');
        context.fileCache.set(event.path, event.data);
        return context.fileCache;
      },
    }),

    updateFileCacheFromRead: assign({
      fileCache({ context, event }) {
        assertEvent(event, 'fileRead');
        context.fileCache.set(event.path, event.data);
        return context.fileCache;
      },
    }),

    optimisticRenameInContext: assign({
      fileTree({ context, event }) {
        assertEvent(event, 'fileRenamed');
        const { oldPath, newPath } = event;
        const newTree = new Map<string, FileEntry>();
        const prefix = `${oldPath}/`;

        for (const [path, entry] of context.fileTree.entries()) {
          if (path === oldPath) {
            const newName = newPath.split('/').pop() ?? newPath;
            newTree.set(newPath, { ...entry, path: newPath, name: newName });
          } else if (path.startsWith(prefix)) {
            const relativePath = path.slice(oldPath.length);
            const newFilePath = `${newPath}${relativePath}`;
            newTree.set(newFilePath, { ...entry, path: newFilePath });
          } else {
            newTree.set(path, entry);
          }
        }

        return newTree;
      },
      fileCache({ context, event }) {
        assertEvent(event, 'fileRenamed');
        context.fileCache.rename(event.oldPath, event.newPath);
        return context.fileCache;
      },
    }),

    optimisticDeleteInContext: assign({
      fileTree({ context, event }) {
        assertEvent(event, 'fileDeleted');
        const newTree = new Map(context.fileTree);
        newTree.delete(event.path);
        return newTree;
      },
      fileCache({ context, event }) {
        assertEvent(event, 'fileDeleted');
        context.fileCache.delete(event.path);
        return context.fileCache;
      },
    }),

    // ============ Emit Actions ============

    emitFileWritten: emit(({ event }) => {
      assertEvent(event, 'fileWritten');
      return {
        type: 'fileWritten',
        path: event.path,
        data: event.data,
        source: event.source,
      };
    }),

    emitFileRead: emit(({ event }) => {
      assertEvent(event, 'fileRead');
      return {
        type: 'fileRead',
        path: event.path,
        data: event.data,
      };
    }),

    emitFileRenamed: emit(({ event }) => {
      assertEvent(event, 'fileRenamed');
      return {
        type: 'fileRenamed',
        oldPath: event.oldPath,
        newPath: event.newPath,
      };
    }),

    emitFileDeleted: emit(({ event }) => {
      assertEvent(event, 'fileDeleted');
      return {
        type: 'fileDeleted',
        path: event.path,
        source: event.source,
      };
    }),

    // ============ File Watching Actions ============

    startFileWatcher: enqueueActions(({ enqueue }) => {
      enqueue(stopChild('fileWatcher'));
      enqueue(
        spawnChild('fileWatcherActor', {
          id: 'fileWatcher',
        }),
      );
      enqueue(assign({ isWatching: true }));
    }),

    stopFileWatcher: enqueueActions(({ enqueue }) => {
      enqueue(stopChild('fileWatcher'));
      enqueue(assign({ isWatching: false }));
    }),
  },
  guards: {
    isRootChanged({ context, event }) {
      assertEvent(event, 'setRoot');
      return event.path !== context.rootDirectory || event.buildId !== context.buildId;
    },
  },
}).createMachine({
  id: 'fileManager',
  entry: enqueueActions(({ enqueue, context, self }) => {
    if (context.shouldInitializeOnStart) {
      enqueue.sendTo(self, { type: 'initialize' });
    }
  }),
  context: ({ input }) => ({
    worker: undefined,
    proxy: undefined,
    fileTree: new Map(),
    fileCache: new BoundedFileCache({
      maxEntries: fileCacheMaxEntries,
      maxTotalBytes: fileCacheMaxTotalBytes,
      maxSingleFileBytes: fileCacheMaxSingleFileBytes,
    }),
    error: undefined,
    rootDirectory: input.rootDirectory,
    shouldInitializeOnStart: input.shouldInitializeOnStart ?? true,
    isWatching: false,
    backendType: input.initialBackend ?? 'indexeddb',
    webAccessNeedsPermission: false,
    buildId: input.buildId,
    sharedWorker: input.sharedWorker,
    eventUnsubscribe: undefined,
  }),
  initial: 'initializing',
  exit: ['stopFileWatcher', 'destroyWorker'],
  states: {
    initializing: {
      on: {
        initialize: { target: 'creatingWorker' },
      },
    },

    creatingWorker: {
      entry: ['clearError'],
      on: {
        setRoot: {
          target: 'creatingWorker',
          guard: 'isRootChanged',
          actions: ['stopFileWatcher', 'destroyWorker', 'updateRootAndReset'],
        },
        workerInitialized: {
          actions: ['updateBackendFromInit'],
        },
      },
      invoke: {
        id: 'initializeWorkerActor',
        src: 'initializeWorkerActor',
        input({ context }) {
          return { context };
        },
        onDone: 'ready',
        onError: {
          target: 'error',
          actions: ['setError'],
        },
      },
    },

    ready: {
      entry: enqueueActions(({ enqueue, context }) => {
        if (context.backendType === 'webaccess' && !context.isWatching) {
          enqueue('startFileWatcher');
        }
      }),
      on: {
        setRoot: {
          target: 'creatingWorker',
          guard: 'isRootChanged',
          actions: ['stopFileWatcher', 'destroyWorker', 'updateRootAndReset'],
        },

        setBackendType: {
          actions: ['updateBackendType'],
        },

        fileWritten: {
          actions: ['updateFileCacheFromWritten', 'emitFileWritten', 'spawnBackgroundRefresh'],
        },
        fileRead: {
          actions: ['updateFileCacheFromRead', 'emitFileRead'],
        },
        fileRenamed: {
          actions: ['optimisticRenameInContext', 'emitFileRenamed', 'spawnBackgroundRefresh'],
        },
        fileDeleted: {
          actions: ['optimisticDeleteInContext', 'emitFileDeleted', 'spawnBackgroundRefresh'],
        },
        filesWritten: {
          actions: ['spawnBackgroundRefresh'],
        },

        startWatching: {
          actions: ['startFileWatcher'],
        },
        stopWatching: {
          actions: ['stopFileWatcher'],
        },
        pollFileSystem: {
          actions: ['spawnBackgroundRefresh'],
        },

        directoryRead: {
          actions: ['replaceFileTreeFromBackgroundRefresh'],
        },
      },
    },

    error: {
      entry({ context }) {
        console.error('[FileManager] state → error', context.error);
      },
      on: {
        setRoot: {
          target: 'creatingWorker',
          actions: ['destroyWorker', 'updateRootAndReset'],
        },
        initialize: {
          target: 'creatingWorker',
        },
      },
    },
  },
});

export type FileManagerMachine = typeof fileManagerMachine;
