import {
  assign,
  assertEvent,
  setup,
  fromPromise,
  fromCallback,
  enqueueActions,
  emit,
  spawnChild,
  stopChild,
} from 'xstate';
import type { OutputFrom, DoneActorEvent, AnyEventObject } from 'xstate';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import type { FileEntry, FilesystemBackend } from '@taucad/types';
import FileManagerWorker from '#machines/file-manager.worker.js?worker';
import type { FileManager as FileWorker } from '#machines/file-manager.js';
import { getStoredDirectoryHandle, getBuildFilesystemConfig, checkHandlePermission } from '#filesystem/handle-store.js';
import { assertActorDoneEvent } from '#lib/xstate.js';
import { normalizePath, joinPath } from '#utils/path.utils.js';
import type { FileWriteSource, FileManagerEmitted } from '#machines/file-manager.machine.types.js';

/**
 * Polling interval for file watching (in milliseconds).
 * Uses a shorter interval when the tab is focused for responsive updates,
 * and a longer interval when blurred to conserve resources.
 */
const watchIntervalFocusedMs = 2000;
const watchIntervalBlurredMs = 10_000;

/**
 * Context for the file manager machine.
 * Simplified to focus on lifecycle and reactive state only.
 */
type FileManagerContext = {
  worker: Worker | undefined;
  wrappedWorker: Remote<FileWorker> | undefined;
  fileTree: Map<string, FileEntry>;
  openFiles: Map<string, Uint8Array<ArrayBuffer>>;
  error: Error | undefined;
  rootDirectory: string;
  shouldInitializeOnStart: boolean;
  /** Whether file watching (polling) is active for the webaccess backend */
  isWatching: boolean;
  /** Current filesystem backend type */
  backendType: FilesystemBackend;
  /** Whether the webaccess handle exists but needs a user gesture to re-grant permission */
  webAccessNeedsPermission: boolean;
  /** Build ID for per-build backend config resolution */
  buildId: string | undefined;
};

// ============ Lifecycle Actors (kept) ============

const initializeWorkerActor = fromPromise<
  | {
      type: 'workerInitialized';
      configuredBackend: FilesystemBackend;
      webAccessNeedsPermission: boolean;
    }
  | { type: 'workerInitializationFailed'; error: Error },
  { context: FileManagerContext }
>(async ({ input }) => {
  const { context } = input;

  // Clean up any existing worker
  if (context.worker) {
    context.worker.terminate();
  }

  try {
    const worker = new FileManagerWorker({ name: `fm-${context.rootDirectory}` });
    const wrappedWorker = wrap<FileWorker>(worker);

    // Store references
    context.worker = worker;
    context.wrappedWorker = wrappedWorker;

    // Resolve the backend -- if buildId is provided, read per-build config
    let backend = context.backendType;
    if (context.buildId) {
      const buildBackend = await getBuildFilesystemConfig(context.buildId);
      // Legacy builds (created before per-build configs) have no entry;
      // they historically used indexeddb, so default to that rather than
      // falling through to the cookie-driven backendType.
      backend = buildBackend ?? 'indexeddb';
    }

    // OPFS is disabled due to file corruption issues -- fall back to indexeddb
    if (backend === 'opfs') {
      backend = 'indexeddb';
    }

    if (backend === 'webaccess') {
      // Retrieve the workspace handle
      const workspaceHandle = await getStoredDirectoryHandle();
      if (workspaceHandle) {
        const permission = await checkHandlePermission(workspaceHandle);
        if (permission === 'granted') {
          // Use workspace root directly -- no per-build scoping.
          // Path-level isolation via /builds/{buildId}/ prefix handles build separation,
          // consistent with how indexeddb and opfs backends work.
          await wrappedWorker.setDirectoryHandle(workspaceHandle);
          await wrappedWorker.reconfigure('webaccess');
          return { type: 'workerInitialized', configuredBackend: 'webaccess', webAccessNeedsPermission: false };
        }
      }

      // Handle missing or needs permission -- fall back to indexeddb
      return { type: 'workerInitialized', configuredBackend: 'indexeddb', webAccessNeedsPermission: true };
    }

    // For non-default backends (opfs, memory), reconfigure the worker
    if (backend !== 'indexeddb') {
      await wrappedWorker.reconfigure(backend);
    }

    return { type: 'workerInitialized', configuredBackend: backend, webAccessNeedsPermission: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to initialize worker';
    return {
      type: 'workerInitializationFailed',
      error: new Error(errorMessage),
    };
  }
});

const readDirectoryActor = fromPromise<
  { type: 'directoryRead'; entries: FileEntry[] } | { type: 'directoryReadFailed'; error: Error },
  { context: FileManagerContext; path: string }
>(async ({ input }) => {
  const { context, path } = input;

  if (!context.wrappedWorker) {
    return {
      type: 'directoryReadFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    // Empty path means root directory
    const absolutePath = path === '' ? normalizePath(context.rootDirectory) : joinPath(context.rootDirectory, path);
    const fileStats = await context.wrappedWorker.getDirectoryStat(absolutePath);
    const entries: FileEntry[] = [];

    for (const fileStat of fileStats) {
      // FileStat.path is relative to the directory we scanned
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to read directory';
    return {
      type: 'directoryReadFailed',
      error: new Error(errorMessage),
    };
  }
});

/**
 * Callback actor that periodically sends pollFileSystem events.
 * Adapts polling interval based on document visibility state.
 * Used to detect external file changes when using the webaccess backend.
 */
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
    // Immediately poll when tab becomes visible for responsive updates
    if (document.visibilityState === 'visible') {
      sendBack({ type: 'pollFileSystem' });
    }
  };

  // Start polling and listen for visibility changes
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Cleanup on stop
  return () => {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }

    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
});

// Only lifecycle actors - I/O actors removed (operations now call worker directly)
const fileManagerActors = {
  initializeWorkerActor,
  readDirectoryActor,
  fileWatcherActor,
} as const;

/**
 * Promise-based actor names used for deriving done event types.
 * The fileWatcherActor is a callback actor (no output) and is excluded.
 */
type PromiseActorNames = 'initializeWorkerActor' | 'readDirectoryActor';

// ============ Events ============

// Lifecycle events
type FileManagerEventLifecycle =
  | { type: 'initialize' }
  | { type: 'setRoot'; path: string; buildId?: string }
  | { type: 'setBackendType'; backendType: FilesystemBackend }
  | { type: 'startWatching' }
  | { type: 'stopWatching' }
  | { type: 'pollFileSystem' };

// Consolidated mutation events - single event per operation
// Hook calls worker directly, then sends ONE event to machine
// Machine updates context, emits UI event, spawns background refresh
type FileManagerEventMutation =
  | { type: 'fileWritten'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'fileRead'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource }
  | { type: 'filesWritten'; paths: string[] };

type FileManagerEventInternal = FileManagerEventLifecycle | FileManagerEventMutation;

type FileManagerEventExternal = OutputFrom<(typeof fileManagerActors)[PromiseActorNames]>;
type FileManagerEventExternalDone = DoneActorEvent<FileManagerEventExternal, PromiseActorNames>;

type FileManagerEvent = FileManagerEventExternalDone | FileManagerEventInternal;

type FileManagerInput = {
  rootDirectory: string;
  shouldInitializeOnStart?: boolean;
  /** Which filesystem backend to use on initialization. Defaults to 'indexeddb'. */
  initialBackend?: FilesystemBackend;
  /** Build ID for per-build backend config resolution. */
  buildId?: string;
};

/**
 * File Manager Machine (Lifecycle-Only Pattern with Background Refresh)
 *
 * This machine manages the file-manager WebWorker lifecycle only:
 * - Initializes the worker
 * - Loads the initial file tree
 * - Stays in 'ready' state once initialized
 *
 * File I/O operations (read, write, delete, rename) are performed by calling
 * the worker directly via the hook, not through state transitions.
 * This allows concurrent operations without blocking.
 *
 * Consolidated mutation events (fileWritten, fileRenamed, etc.) are sent after
 * worker operations complete. The machine then:
 * 1. Updates context (openFiles) immediately
 * 2. Emits UI events for consumers (toasts, Monaco, etc.)
 * 3. Spawns a background actor to refresh the file tree (eventual consistency)
 *
 * This eliminates the race condition where events were dropped during
 * the loadingRootDirectory state transition.
 */
export const fileManagerMachine = setup({
  types: {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    context: {} as FileManagerContext,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    events: {} as FileManagerEvent,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    input: {} as FileManagerInput,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate setup
    emitted: {} as FileManagerEmitted,
  },
  actors: fileManagerActors,
  actions: {
    // ============ Lifecycle Actions ============

    setError: assign({
      error({ event }) {
        assertActorDoneEvent(event);
        if ('error' in event.output && event.output.error instanceof Error) {
          return event.output.error;
        }

        return undefined;
      },
    }),

    clearError: assign({
      error: undefined,
    }),

    destroyWorker({ context }) {
      if (context.worker) {
        context.worker.terminate();
        context.worker = undefined;
        context.wrappedWorker = undefined;
      }
    },

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
      openFiles: () => new Map(),
      error: undefined,
      isWatching: false,
    }),

    // Update backend type and permission status from init actor output
    updateBackendFromInit: assign({
      backendType({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'workerInitialized');
        return event.output.configuredBackend;
      },
      webAccessNeedsPermission({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'workerInitialized');
        return event.output.webAccessNeedsPermission;
      },
    }),

    // Set the backend type (used when reconfiguring from the hook)
    updateBackendType: assign({
      backendType({ event }) {
        assertEvent(event, 'setBackendType');
        return event.backendType;
      },
    }),

    // ============ File Tree Actions ============

    updateFileTreeFromActor: assign({
      fileTree({ context, event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'directoryRead');

        const newTree = new Map(context.fileTree);

        for (const entry of event.output.entries) {
          newTree.set(entry.path, entry);
        }

        return newTree;
      },
    }),

    // Replaces tree with entries from background refresh (full re-read)
    replaceFileTreeFromBackgroundRefresh: assign({
      fileTree({ event }) {
        assertActorDoneEvent(event);
        assertEvent(event.output, 'directoryRead');

        const newTree = new Map<string, FileEntry>();

        for (const entry of event.output.entries) {
          newTree.set(entry.path, entry);
        }

        return newTree;
      },
    }),

    // ============ Background Refresh Actions ============

    // Stop any existing background refresh and spawn a new one
    // Consolidated to ensure we always stop before spawning
    spawnBackgroundRefresh: enqueueActions(({ enqueue }) => {
      enqueue(stopChild('backgroundRefresh'));
      enqueue(
        spawnChild('readDirectoryActor', {
          id: 'backgroundRefresh',
          input: ({ context }) => ({ context, path: '' }),
        }),
      );
    }),

    // ============ Consolidated Mutation Actions ============

    // Update openFiles when a file is written
    updateOpenFileFromWritten: assign({
      openFiles({ context, event }) {
        assertEvent(event, 'fileWritten');
        const newMap = new Map(context.openFiles);
        newMap.set(event.path, event.data);
        return newMap;
      },
    }),

    // Update openFiles when a file is read
    updateOpenFileFromRead: assign({
      openFiles({ context, event }) {
        assertEvent(event, 'fileRead');
        const newMap = new Map(context.openFiles);
        newMap.set(event.path, event.data);
        return newMap;
      },
    }),

    // Optimistically update paths in file tree and open files when renamed
    optimisticRenameInContext: assign({
      fileTree({ context, event }) {
        assertEvent(event, 'fileRenamed');
        const { oldPath, newPath } = event;

        const newTree = new Map<string, FileEntry>();
        const prefix = `${oldPath}/`;

        for (const [path, entry] of context.fileTree.entries()) {
          if (path === oldPath) {
            // Exact match - file rename
            const newName = newPath.split('/').pop() ?? newPath;
            newTree.set(newPath, { ...entry, path: newPath, name: newName });
          } else if (path.startsWith(prefix)) {
            // Nested paths - directory rename
            const relativePath = path.slice(oldPath.length);
            const newFilePath = `${newPath}${relativePath}`;
            newTree.set(newFilePath, { ...entry, path: newFilePath });
          } else {
            newTree.set(path, entry);
          }
        }

        return newTree;
      },
      openFiles({ context, event }) {
        assertEvent(event, 'fileRenamed');
        const { oldPath, newPath } = event;

        const newMap = new Map<string, Uint8Array<ArrayBuffer>>();
        const prefix = `${oldPath}/`;

        for (const [path, content] of context.openFiles.entries()) {
          if (path === oldPath) {
            newMap.set(newPath, content);
          } else if (path.startsWith(prefix)) {
            const relativePath = path.slice(oldPath.length);
            const newFilePath = `${newPath}${relativePath}`;
            newMap.set(newFilePath, content);
          } else {
            newMap.set(path, content);
          }
        }

        return newMap;
      },
    }),

    // Optimistically remove path from file tree and open files when deleted
    optimisticDeleteInContext: assign({
      fileTree({ context, event }) {
        assertEvent(event, 'fileDeleted');
        const newTree = new Map(context.fileTree);
        newTree.delete(event.path);
        return newTree;
      },
      openFiles({ context, event }) {
        assertEvent(event, 'fileDeleted');
        if (context.openFiles.has(event.path)) {
          const newMap = new Map(context.openFiles);
          newMap.delete(event.path);
          return newMap;
        }

        return context.openFiles;
      },
    }),

    // ============ Emit Actions ============

    emitFileWritten: emit(({ event }) => {
      assertEvent(event, 'fileWritten');
      return {
        type: 'fileWritten' as const,
        path: event.path,
        data: event.data,
        source: event.source,
      };
    }),

    emitFileRead: emit(({ event }) => {
      assertEvent(event, 'fileRead');
      return {
        type: 'fileRead' as const,
        path: event.path,
        data: event.data,
      };
    }),

    emitFileRenamed: emit(({ event }) => {
      assertEvent(event, 'fileRenamed');
      return {
        type: 'fileRenamed' as const,
        oldPath: event.oldPath,
        newPath: event.newPath,
      };
    }),

    emitFileDeleted: emit(({ event }) => {
      assertEvent(event, 'fileDeleted');
      return {
        type: 'fileDeleted' as const,
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

    isWorkerInitializationFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'workerInitializationFailed';
    },

    isDirectoryReadFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'directoryReadFailed';
    },

    isDirectoryReadSucceeded({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'directoryRead';
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
    wrappedWorker: undefined,
    fileTree: new Map(),
    openFiles: new Map(),
    error: undefined,
    rootDirectory: input.rootDirectory,
    shouldInitializeOnStart: input.shouldInitializeOnStart ?? true,
    isWatching: false,
    backendType: input.initialBackend ?? 'indexeddb',
    webAccessNeedsPermission: false,
    buildId: input.buildId,
  }),
  initial: 'initializing',
  exit: ['stopFileWatcher', 'destroyWorker'],
  states: {
    initializing: {
      on: {
        initialize: {
          target: 'creatingWorker',
        },
      },
    },

    creatingWorker: {
      entry: ['clearError'],
      on: {
        // Handle rapid navigation: cancel in-progress init and restart with new context
        // Guard prevents destructive self-transition when rootDirectory/buildId are unchanged
        setRoot: {
          target: 'creatingWorker',
          guard: 'isRootChanged',
          actions: ['stopFileWatcher', 'destroyWorker', 'updateRootAndReset'],
        },
      },
      invoke: {
        id: 'initializeWorkerActor',
        src: 'initializeWorkerActor',
        input({ context }) {
          return { context };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isWorkerInitializationFailed',
            actions: ['setError'],
          },
          {
            target: 'loadingRootDirectory',
            actions: ['updateBackendFromInit'],
          },
        ],
      },
    },

    loadingRootDirectory: {
      on: {
        // Handle rapid navigation: cancel in-progress directory read and restart
        // Guard prevents destructive self-transition when rootDirectory/buildId are unchanged
        setRoot: {
          target: 'creatingWorker',
          guard: 'isRootChanged',
          actions: ['stopFileWatcher', 'destroyWorker', 'updateRootAndReset'],
        },
      },
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          return { context, path: '' };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: ['updateFileTreeFromActor'],
          },
        ],
      },
    },

    ready: {
      // Auto-start file watcher when entering ready with webaccess backend
      entry: enqueueActions(({ enqueue, context }) => {
        if (context.backendType === 'webaccess' && !context.isWatching) {
          enqueue('startFileWatcher');
        }
      }),
      // Machine stays in 'ready' state - no I/O transitions
      // Consolidated mutation events: update context + emit + spawn background refresh
      on: {
        // Lifecycle events
        setRoot: {
          target: 'creatingWorker',
          actions: ['stopFileWatcher', 'destroyWorker', 'updateRootAndReset'],
        },

        // Update backend type tracking (used by hook after reconfigure)
        setBackendType: {
          actions: ['updateBackendType'],
        },

        // Consolidated mutation events (single event per operation)
        // Each uses an array of actions: update context, emit UI event, spawn background refresh
        fileWritten: {
          actions: ['updateOpenFileFromWritten', 'emitFileWritten', 'spawnBackgroundRefresh'],
        },
        fileRead: {
          actions: ['updateOpenFileFromRead', 'emitFileRead'],
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

        // ============ File Watching Events ============

        // Start periodic file system polling (used by webaccess backend)
        startWatching: {
          actions: ['startFileWatcher'],
        },

        // Stop periodic file system polling
        stopWatching: {
          actions: ['stopFileWatcher'],
        },

        // Periodic poll triggered by the file watcher - triggers a background refresh
        // to detect external file changes
        pollFileSystem: {
          actions: ['spawnBackgroundRefresh'],
        },

        // Handle background refresh completion (spawned actor done)
        // Only update file tree on success - silently ignore failures (eventual consistency)
        // eslint-disable-next-line @typescript-eslint/naming-convention -- xstate convention for spawned actor done events
        'xstate.done.actor.backgroundRefresh': {
          guard: 'isDirectoryReadSucceeded',
          actions: ['replaceFileTreeFromBackgroundRefresh'],
        },
      },
    },

    error: {
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
