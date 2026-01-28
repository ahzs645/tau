import { assign, assertEvent, setup, fromPromise, enqueueActions, emit, spawnChild, stopChild } from 'xstate';
import type { OutputFrom, DoneActorEvent } from 'xstate';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import type { FileEntry } from '@taucad/types';
import FileManagerWorker from '#machines/file-manager.worker.js?worker';
import type { FileManager as FileWorker } from '#machines/file-manager.js';
import { assertActorDoneEvent } from '#lib/xstate.js';
import { normalizePath, joinPath } from '#utils/path.utils.js';

/**
 * The source of the file write operation.
 * - 'editor': Write originated from user typing in the Monaco editor (special case for recursion prevention)
 * - 'user': Write originated from user action (create file, upload, etc.)
 * - 'machine': Write originated from machine/programmatic source (e.g., chat AI)
 */
type FileWriteSource = 'editor' | 'user' | 'machine';

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
};

// ============ Lifecycle Actors (kept) ============

const initializeWorkerActor = fromPromise<
  { type: 'workerInitialized' } | { type: 'workerInitializationFailed'; error: Error },
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

    return { type: 'workerInitialized' };
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

// Only lifecycle actors - I/O actors removed (operations now call worker directly)
const fileManagerActors = {
  initializeWorkerActor,
  readDirectoryActor,
} as const;
type FileManagerActorNames = keyof typeof fileManagerActors;

// ============ Events ============

// Lifecycle events
type FileManagerEventLifecycle = { type: 'initialize' } | { type: 'setRoot'; path: string };

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

type FileManagerEventExternal = OutputFrom<(typeof fileManagerActors)[FileManagerActorNames]>;
type FileManagerEventExternalDone = DoneActorEvent<FileManagerEventExternal, FileManagerActorNames>;

type FileManagerEvent = FileManagerEventExternalDone | FileManagerEventInternal;

type FileManagerInput = {
  rootDirectory: string;
  shouldInitializeOnStart?: boolean;
};

// Emitted events for UI consumers (toasts, Monaco updates, etc.)
type FileManagerEmitted =
  | { type: 'fileWritten'; path: string; data: Uint8Array<ArrayBuffer>; source: FileWriteSource }
  | { type: 'fileRead'; path: string; data: Uint8Array<ArrayBuffer> }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource };

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
      fileTree: () => new Map(),
      openFiles: () => new Map(),
      error: undefined,
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
  },
  guards: {
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
  }),
  initial: 'initializing',
  exit: ['destroyWorker'],
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
          },
        ],
      },
    },

    loadingRootDirectory: {
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
      // Machine stays in 'ready' state - no I/O transitions
      // Consolidated mutation events: update context + emit + spawn background refresh
      on: {
        // Lifecycle events
        setRoot: {
          target: 'creatingWorker',
          actions: ['destroyWorker', 'updateRootAndReset'],
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
export type { FileManagerEmitted, FileWriteSource };
