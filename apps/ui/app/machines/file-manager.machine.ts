import { assign, assertEvent, setup, fromPromise, enqueueActions, emit } from 'xstate';
import type { OutputFrom, DoneActorEvent } from 'xstate';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import type { FileEntry } from '@taucad/types';
import FileManagerWorker from '#machines/file-manager.worker.js?worker';
import type { FileWorker } from '#machines/file-manager.worker.js';
import { assertActorDoneEvent } from '#lib/xstate.js';
import { joinPath, normalizePath } from '#utils/path.utils.js';

/**
 * The source of the file write.
 */
/**
 * The source of the file write operation.
 * - 'editor': Write originated from user typing in the Monaco editor
 * - 'file-tree': Write originated from file tree operations (create file, upload, etc.)
 * - 'external': Write originated from external source (e.g., chat AI)
 */
type FileWriteSource = 'editor' | 'file-tree' | 'external';

type FileManagerContext = {
  worker: Worker | undefined;
  wrappedWorker: Remote<FileWorker> | undefined;
  fileTree: Map<string, FileEntry>;
  error: Error | undefined;
  lastWrittenPath: string | undefined;
  lastWrittenData: Uint8Array | undefined;
  lastWriteSource: FileWriteSource | undefined;
  openFiles: Map<string, Uint8Array>;
  lastOpenedPath: string | undefined;
  lastRenamedOldPath: string | undefined;
  lastRenamedNewPath: string | undefined;
  lastDeletedPath: string | undefined;
  lastDeleteSource: FileWriteSource | undefined;
  rootDirectory: string;
  shouldInitializeOnStart: boolean;
};

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
    // Empty path means root directory, otherwise join with rootDirectory
    const absolutePath = path === '' ? normalizePath(context.rootDirectory) : joinPath(context.rootDirectory, path);
    const fileStats = await context.wrappedWorker.getDirectoryStat(absolutePath);
    const entries: FileEntry[] = [];

    for (const fileStat of fileStats) {
      // FileStat.path is relative to the directory we scanned
      const relativeFilePath = path === '' ? fileStat.path : `${path}/${fileStat.path}`;

      entries.push({
        path: relativeFilePath, // Store relative path from root in file tree
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

const writeFileActor = fromPromise<
  { type: 'fileWritten'; path: string } | { type: 'fileWriteFailed'; error: Error },
  { context: FileManagerContext; path: string; data: Uint8Array }
>(async ({ input }) => {
  const { context, path, data } = input;

  if (!context.wrappedWorker) {
    return {
      type: 'fileWriteFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    const absolutePath = joinPath(context.rootDirectory, path);
    await context.wrappedWorker.writeFile(absolutePath, data);
    return { type: 'fileWritten', path };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to write file';
    return {
      type: 'fileWriteFailed',
      error: new Error(errorMessage),
    };
  }
});

const writeFilesActor = fromPromise<
  { type: 'filesWritten'; paths: string[] } | { type: 'filesWriteFailed'; error: Error },
  { context: FileManagerContext; files: Record<string, { content: Uint8Array }> }
>(async ({ input }) => {
  const { context, files } = input;

  if (!context.wrappedWorker) {
    return {
      type: 'filesWriteFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    const absoluteFiles: Record<string, { content: Uint8Array }> = {};
    const paths = Object.keys(files);

    for (const path of paths) {
      const absolutePath = joinPath(context.rootDirectory, path);
      const fileData = files[path];
      if (fileData) {
        absoluteFiles[absolutePath] = fileData;
      }
    }

    await context.wrappedWorker.writeFiles(absoluteFiles);
    return { type: 'filesWritten', paths };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to write files';
    return {
      type: 'filesWriteFailed',
      error: new Error(errorMessage),
    };
  }
});

const readFileActor = fromPromise<
  { type: 'fileRead'; data: Uint8Array } | { type: 'fileReadFailed'; error: Error },
  { context: FileManagerContext; path: string }
>(async ({ input }) => {
  const { context, path } = input;

  if (!context.wrappedWorker) {
    return {
      type: 'fileReadFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    const absolutePath = joinPath(context.rootDirectory, path);
    const data = await context.wrappedWorker.readFile(absolutePath);
    return { type: 'fileRead', data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to read file';
    return {
      type: 'fileReadFailed',
      error: new Error(errorMessage),
    };
  }
});

const renameFileActor = fromPromise<
  { type: 'fileRenamed'; oldPath: string; newPath: string } | { type: 'fileRenameFailed'; error: Error },
  { context: FileManagerContext; oldPath: string; newPath: string }
>(async ({ input }) => {
  const { context, oldPath, newPath } = input;
  const worker = context.wrappedWorker;

  if (!worker) {
    return {
      type: 'fileRenameFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    const absoluteOldPath = joinPath(context.rootDirectory, oldPath);
    const absoluteNewPath = joinPath(context.rootDirectory, newPath);
    await worker.rename(absoluteOldPath, absoluteNewPath);
    return { type: 'fileRenamed', oldPath, newPath };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to rename file';
    return {
      type: 'fileRenameFailed',
      error: new Error(errorMessage),
    };
  }
});

const deleteFileActor = fromPromise<
  { type: 'fileDeleted'; path: string } | { type: 'fileDeleteFailed'; error: Error },
  { context: FileManagerContext; path: string }
>(async ({ input }) => {
  const { context, path } = input;
  const worker = context.wrappedWorker;

  if (!worker) {
    return {
      type: 'fileDeleteFailed',
      error: new Error('Worker not initialized'),
    };
  }

  try {
    const absolutePath = joinPath(context.rootDirectory, path);
    await worker.unlink(absolutePath);
    return { type: 'fileDeleted', path };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete file';
    return {
      type: 'fileDeleteFailed',
      error: new Error(errorMessage),
    };
  }
});

const fileManagerActors = {
  initializeWorkerActor,
  readDirectoryActor,
  writeFileActor,
  writeFilesActor,
  readFileActor,
  renameFileActor,
  deleteFileActor,
} as const;
type FileManagerActorNames = keyof typeof fileManagerActors;

type FileManagerEventInternal =
  | { type: 'initialize' }
  | { type: 'setRoot'; path: string }
  | { type: 'loadDirectory'; path: string }
  | { type: 'writeFile'; path: string; data: Uint8Array; source: FileWriteSource }
  | { type: 'writeFiles'; files: Record<string, { content: Uint8Array }> }
  | { type: 'readFile'; path: string }
  | { type: 'renameFile'; oldPath: string; newPath: string }
  | { type: 'deleteFile'; path: string; source?: FileWriteSource };

type FileManagerEventExternal = OutputFrom<(typeof fileManagerActors)[FileManagerActorNames]>;
type FileManagerEventExternalDone = DoneActorEvent<FileManagerEventExternal, FileManagerActorNames>;

type FileManagerEvent = FileManagerEventExternalDone | FileManagerEventInternal;

type FileManagerInput = {
  rootDirectory: string;
  shouldInitializeOnStart?: boolean;
};

type FileManagerEmitted =
  | { type: 'fileWritten'; path: string; data: Uint8Array; source: FileWriteSource }
  | { type: 'fileRead'; path: string; data: Uint8Array }
  | { type: 'fileRenamed'; oldPath: string; newPath: string }
  | { type: 'fileDeleted'; path: string; source: FileWriteSource };

/**
 * File Manager Machine
 *
 * This machine manages the file-manager WebWorker and filesystem operations:
 * - Initializes the worker and creates a configurable root directory
 * - Reads directory contents lazily on demand
 * - Maintains a file tree in context
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
    setError: assign({
      error({ event }) {
        assertActorDoneEvent(event);

        if (event.output.type === 'workerInitializationFailed') {
          return event.output.error;
        }

        return undefined;
      },
    }),

    clearError: assign({
      error: undefined,
    }),

    updateFileTree: assign({
      fileTree({ context, event }) {
        assertActorDoneEvent(event);

        if (event.output.type === 'directoryRead') {
          const newTree = new Map(context.fileTree);

          for (const entry of event.output.entries) {
            newTree.set(entry.path, entry);
          }

          return newTree;
        }

        return context.fileTree;
      },
    }),

    setDirectoryLoaded: assign({
      fileTree({ context, event }) {
        assertEvent(event, 'loadDirectory');
        const newTree = new Map(context.fileTree);
        const entry = newTree.get(event.path);

        if (entry && entry.type === 'dir') {
          newTree.set(event.path, { ...entry, isLoaded: true });
        }

        return newTree;
      },
    }),

    setLastWrittenPath: assign({
      lastWrittenPath({ event }) {
        assertActorDoneEvent(event);

        if (event.output.type === 'fileWritten') {
          return event.output.path;
        }

        return undefined;
      },
    }),

    setLastWrittenData: assign({
      lastWrittenData({ event }) {
        assertEvent(event, 'writeFile');
        return event.data;
      },
      lastWriteSource({ event }) {
        assertEvent(event, 'writeFile');
        return event.source;
      },
    }),

    updateOpenFileAfterWrite: assign({
      openFiles({ context }) {
        const { lastWrittenPath, lastWrittenData, lastWriteSource, openFiles } = context;

        if (!lastWrittenPath || !lastWrittenData) {
          return openFiles;
        }

        // For file-tree operations, always add to openFiles (user explicitly created the file)
        // For other sources (editor, external), only update if already open
        if (lastWriteSource === 'file-tree' || openFiles.has(lastWrittenPath)) {
          const newMap = new Map(openFiles);
          newMap.set(lastWrittenPath, lastWrittenData);
          return newMap;
        }

        return openFiles;
      },
    }),

    addOpenFile: assign({
      openFiles({ context, event }) {
        assertActorDoneEvent(event);

        if (event.output.type === 'fileRead') {
          const newMap = new Map(context.openFiles);
          const path = context.lastOpenedPath;

          if (path) {
            newMap.set(path, event.output.data);
          }

          return newMap;
        }

        return context.openFiles;
      },
      lastOpenedPath({ context }) {
        return context.lastOpenedPath;
      },
    }),

    setLastOpenedPath: assign({
      lastOpenedPath({ event }) {
        assertEvent(event, 'readFile');
        return event.path;
      },
    }),

    updateRootAndReset: assign({
      rootDirectory({ event }) {
        assertEvent(event, 'setRoot');
        return event.path;
      },
      fileTree: () => new Map(),
      openFiles: () => new Map(),
      lastWrittenPath: undefined,
      lastWrittenData: undefined,
      lastWriteSource: undefined,
      lastOpenedPath: undefined,
      error: undefined,
    }),

    destroyWorker({ context }) {
      if (context.worker) {
        context.worker.terminate();
        context.worker = undefined;
        context.wrappedWorker = undefined;
      }
    },

    emitFileWritten: emit(({ context }) => ({
      type: 'fileWritten' as const,
      path: context.lastWrittenPath ?? '',
      data: context.lastWrittenData ?? new Uint8Array(),
      source: context.lastWriteSource ?? 'editor',
    })),

    emitFileRead: emit(({ context, event }) => {
      assertActorDoneEvent(event);
      if (event.output.type === 'fileRead') {
        return {
          type: 'fileRead' as const,
          path: context.lastOpenedPath ?? '',
          data: event.output.data,
        };
      }

      return {
        type: 'fileRead' as const,
        path: '',
        data: new Uint8Array(),
      };
    }),

    setLastRenamedPaths: assign({
      lastRenamedOldPath({ event }) {
        assertEvent(event, 'renameFile');
        return event.oldPath;
      },
      lastRenamedNewPath({ event }) {
        assertEvent(event, 'renameFile');
        return event.newPath;
      },
    }),

    setLastDeletedPath: assign({
      lastDeletedPath({ event }) {
        assertEvent(event, 'deleteFile');
        return event.path;
      },
      lastDeleteSource({ event }) {
        assertEvent(event, 'deleteFile');
        return event.source ?? 'file-tree';
      },
    }),

    removeDeletedFileFromTree: assign({
      fileTree({ context }) {
        const { lastDeletedPath, fileTree } = context;

        if (!lastDeletedPath) {
          return fileTree;
        }

        const newTree = new Map(fileTree);
        newTree.delete(lastDeletedPath);
        return newTree;
      },
    }),

    removeDeletedFileFromOpenFiles: assign({
      openFiles({ context }) {
        const { lastDeletedPath, openFiles } = context;

        if (!lastDeletedPath) {
          return openFiles;
        }

        if (openFiles.has(lastDeletedPath)) {
          const newMap = new Map(openFiles);
          newMap.delete(lastDeletedPath);
          return newMap;
        }

        return openFiles;
      },
    }),

    // Optimistically transform paths in fileTree and openFiles immediately
    // This provides instant UI feedback before filesystem operation completes
    optimisticRenameInTree: assign({
      fileTree({ context }) {
        const { lastRenamedOldPath, lastRenamedNewPath, fileTree } = context;

        if (!lastRenamedOldPath || !lastRenamedNewPath) {
          return fileTree;
        }

        const newTree = new Map<string, FileEntry>();
        const prefix = `${lastRenamedOldPath}/`;

        for (const [path, entry] of fileTree.entries()) {
          if (path === lastRenamedOldPath) {
            // Exact match - file rename (e.g., test.txt -> test2.txt)
            // Transform to new path with updated name
            const newName = lastRenamedNewPath.split('/').pop() ?? lastRenamedNewPath;
            newTree.set(lastRenamedNewPath, { ...entry, path: lastRenamedNewPath, name: newName });
          } else if (path.startsWith(prefix)) {
            // Nested paths - directory rename (e.g., folder/file.txt -> newFolder/file.txt)
            const relativePath = path.slice(lastRenamedOldPath.length);
            const newFilePath = `${lastRenamedNewPath}${relativePath}`;
            newTree.set(newFilePath, { ...entry, path: newFilePath });
          } else {
            // Unrelated paths - keep as-is
            newTree.set(path, entry);
          }
        }

        return newTree;
      },
      openFiles({ context }) {
        const { lastRenamedOldPath, lastRenamedNewPath, openFiles } = context;

        if (!lastRenamedOldPath || !lastRenamedNewPath) {
          return openFiles;
        }

        const newMap = new Map<string, Uint8Array>();
        const prefix = `${lastRenamedOldPath}/`;

        for (const [path, content] of openFiles.entries()) {
          if (path === lastRenamedOldPath) {
            // Exact match (file rename)
            newMap.set(lastRenamedNewPath, content);
          } else if (path.startsWith(prefix)) {
            // Nested file (directory rename)
            const relativePath = path.slice(lastRenamedOldPath.length);
            const newFilePath = `${lastRenamedNewPath}${relativePath}`;
            newMap.set(newFilePath, content);
          } else {
            // Unrelated path
            newMap.set(path, content);
          }
        }

        return newMap;
      },
    }),

    // Revert optimistic rename when filesystem operation fails
    // This reverses the path transformation to restore consistency with filesystem
    revertOptimisticRename: assign({
      fileTree({ context }) {
        const { lastRenamedOldPath, lastRenamedNewPath, fileTree } = context;

        if (!lastRenamedOldPath || !lastRenamedNewPath) {
          return fileTree;
        }

        // Reverse transformation: newPath -> oldPath
        const revertedTree = new Map<string, FileEntry>();
        const prefix = `${lastRenamedNewPath}/`;

        for (const [path, entry] of fileTree.entries()) {
          if (path === lastRenamedNewPath) {
            // Exact match - revert file rename
            const oldName = lastRenamedOldPath.split('/').pop() ?? lastRenamedOldPath;
            revertedTree.set(lastRenamedOldPath, { ...entry, path: lastRenamedOldPath, name: oldName });
          } else if (path.startsWith(prefix)) {
            // Nested paths - revert directory rename
            const relativePath = path.slice(lastRenamedNewPath.length);
            const oldFilePath = `${lastRenamedOldPath}${relativePath}`;
            revertedTree.set(oldFilePath, { ...entry, path: oldFilePath });
          } else {
            // Unrelated paths - keep as-is
            revertedTree.set(path, entry);
          }
        }

        return revertedTree;
      },
      openFiles({ context }) {
        const { lastRenamedOldPath, lastRenamedNewPath, openFiles } = context;

        if (!lastRenamedOldPath || !lastRenamedNewPath) {
          return openFiles;
        }

        // Reverse transformation: newPath -> oldPath
        const revertedMap = new Map<string, Uint8Array>();
        const prefix = `${lastRenamedNewPath}/`;

        for (const [path, content] of openFiles.entries()) {
          if (path === lastRenamedNewPath) {
            // Exact match - revert file rename
            revertedMap.set(lastRenamedOldPath, content);
          } else if (path.startsWith(prefix)) {
            // Nested file - revert directory rename
            const relativePath = path.slice(lastRenamedNewPath.length);
            const oldFilePath = `${lastRenamedOldPath}${relativePath}`;
            revertedMap.set(oldFilePath, content);
          } else {
            // Unrelated path
            revertedMap.set(path, content);
          }
        }

        return revertedMap;
      },
    }),

    emitFileRenamed: emit(({ context }) => ({
      type: 'fileRenamed' as const,
      oldPath: context.lastRenamedOldPath ?? '',
      newPath: context.lastRenamedNewPath ?? '',
    })),

    emitFileDeleted: emit(({ context }) => ({
      type: 'fileDeleted' as const,
      path: context.lastDeletedPath ?? '',
      source: context.lastDeleteSource ?? 'file-tree',
    })),
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

    isFileWriteFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'fileWriteFailed';
    },

    isFilesWriteFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'filesWriteFailed';
    },

    isFileReadFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'fileReadFailed';
    },

    isFileRenameFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'fileRenameFailed';
    },

    isFileDeleteFailed({ event }) {
      assertActorDoneEvent(event);
      return event.output.type === 'fileDeleteFailed';
    },

    // Guard to skip no-op renames (same path)
    isSamePathRename({ event }) {
      assertEvent(event, 'renameFile');
      return event.oldPath === event.newPath;
    },

    // Guard to check if source and destination directories are different (move vs simple rename)
    isDifferentDirectory({ context }) {
      const { lastRenamedOldPath, lastRenamedNewPath } = context;
      if (!lastRenamedOldPath || !lastRenamedNewPath) {
        return false;
      }

      const getParentDir = (path: string): string => {
        const lastSlashIndex = path.lastIndexOf('/');
        return lastSlashIndex > 0 ? path.slice(0, lastSlashIndex) : '';
      };

      return getParentDir(lastRenamedOldPath) !== getParentDir(lastRenamedNewPath);
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
    error: undefined,
    lastWrittenPath: undefined,
    lastWrittenData: undefined,
    lastWriteSource: undefined,
    openFiles: new Map(),
    lastOpenedPath: undefined,
    lastRenamedOldPath: undefined,
    lastRenamedNewPath: undefined,
    lastDeletedPath: undefined,
    lastDeleteSource: undefined,
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
          // Pass empty string for root directory (will be converted to absolute internally)
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
            actions: ['updateFileTree'],
          },
        ],
      },
    },

    ready: {
      on: {
        setRoot: {
          target: 'creatingWorker',
          actions: ['destroyWorker', 'updateRootAndReset'],
        },
        loadDirectory: {
          target: 'loadingDirectory',
        },
        writeFile: {
          target: 'writingFile',
        },
        writeFiles: {
          target: 'writingFiles',
        },
        readFile: {
          target: 'readingFile',
        },
        renameFile: [
          {
            // Skip no-op rename (same path) - stay in ready
            guard: 'isSamePathRename',
            target: 'ready',
          },
          {
            target: 'renamingFile',
          },
        ],
        deleteFile: {
          target: 'deletingFile',
        },
      },
    },

    writingFile: {
      entry: ['clearError', 'setLastWrittenData'],
      invoke: {
        id: 'writeFileActor',
        src: 'writeFileActor',
        input({ context, event }) {
          assertEvent(event, 'writeFile');
          return { context, path: event.path, data: event.data };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isFileWriteFailed',
            actions: ['setError'],
          },
          {
            target: 'reloadingAfterWrite',
            actions: ['setLastWrittenPath'],
          },
        ],
      },
    },

    reloadingAfterWrite: {
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          // LastWrittenPath is relative, extract parent directory
          let parentPath = '';
          if (context.lastWrittenPath) {
            const lastSlashIndex = context.lastWrittenPath.lastIndexOf('/');
            if (lastSlashIndex > 0) {
              parentPath = context.lastWrittenPath.slice(0, lastSlashIndex);
            }
            // If lastSlashIndex is 0 or -1, parentPath remains '' (root)
          }

          return { context, path: parentPath };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: ['updateFileTree', 'updateOpenFileAfterWrite', 'emitFileWritten'],
          },
        ],
      },
    },

    writingFiles: {
      entry: ['clearError'],
      invoke: {
        id: 'writeFilesActor',
        src: 'writeFilesActor',
        input({ context, event }) {
          assertEvent(event, 'writeFiles');
          return { context, files: event.files };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isFilesWriteFailed',
            actions: ['setError'],
          },
          {
            target: 'reloadingAfterWriteFiles',
          },
        ],
      },
    },

    reloadingAfterWriteFiles: {
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          // Reload root directory since files could be in multiple directories
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
            actions: ['updateFileTree'],
          },
        ],
      },
    },

    readingFile: {
      entry: ['clearError', 'setLastOpenedPath'],
      invoke: {
        id: 'readFileActor',
        src: 'readFileActor',
        input({ context, event }) {
          assertEvent(event, 'readFile');
          return { context, path: event.path };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isFileReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: ['addOpenFile', 'emitFileRead'],
          },
        ],
      },
    },

    loadingDirectory: {
      entry: ['clearError'],
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context, event }) {
          assertEvent(event, 'loadDirectory');
          return { context, path: event.path };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: ['updateFileTree', 'setDirectoryLoaded'],
          },
        ],
      },
    },

    renamingFile: {
      // Optimistically update UI immediately, then verify with filesystem
      entry: ['clearError', 'setLastRenamedPaths', 'optimisticRenameInTree'],
      invoke: {
        id: 'renameFileActor',
        src: 'renameFileActor',
        input({ context, event }) {
          assertEvent(event, 'renameFile');
          return { context, oldPath: event.oldPath, newPath: event.newPath };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isFileRenameFailed',
            // Revert optimistic changes when rename fails
            actions: ['setError', 'revertOptimisticRename'],
          },
          {
            target: 'reloadingSourceAfterRename',
          },
        ],
      },
    },

    reloadingSourceAfterRename: {
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          // Extract parent directory from old path (source directory)
          let parentPath = '';
          if (context.lastRenamedOldPath) {
            const lastSlashIndex = context.lastRenamedOldPath.lastIndexOf('/');
            if (lastSlashIndex > 0) {
              parentPath = context.lastRenamedOldPath.slice(0, lastSlashIndex);
            }
          }

          return { context, path: parentPath };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            // If source and destination are in different directories, reload destination too
            guard: 'isDifferentDirectory',
            target: 'reloadingDestinationAfterRename',
            // Paths already transformed optimistically, just verify with filesystem
            actions: ['updateFileTree'],
          },
          {
            // Same directory (simple rename) - go directly to ready
            target: 'ready',
            // Paths already transformed optimistically, just verify with filesystem
            actions: ['updateFileTree', 'emitFileRenamed'],
          },
        ],
      },
    },

    reloadingDestinationAfterRename: {
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          // Extract parent directory from new path (destination directory)
          let parentPath = '';
          if (context.lastRenamedNewPath) {
            const lastSlashIndex = context.lastRenamedNewPath.lastIndexOf('/');
            if (lastSlashIndex > 0) {
              parentPath = context.lastRenamedNewPath.slice(0, lastSlashIndex);
            }
          }

          return { context, path: parentPath };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            // Paths already transformed optimistically, just verify with filesystem
            actions: ['updateFileTree', 'emitFileRenamed'],
          },
        ],
      },
    },

    deletingFile: {
      entry: ['clearError', 'setLastDeletedPath'],
      invoke: {
        id: 'deleteFileActor',
        src: 'deleteFileActor',
        input({ context, event }) {
          assertEvent(event, 'deleteFile');
          return { context, path: event.path };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isFileDeleteFailed',
            actions: ['setError'],
          },
          {
            target: 'reloadingAfterDelete',
          },
        ],
      },
    },

    reloadingAfterDelete: {
      invoke: {
        id: 'readDirectoryActor',
        src: 'readDirectoryActor',
        input({ context }) {
          // Extract parent directory from deleted path
          let parentPath = '';
          if (context.lastDeletedPath) {
            const lastSlashIndex = context.lastDeletedPath.lastIndexOf('/');
            if (lastSlashIndex > 0) {
              parentPath = context.lastDeletedPath.slice(0, lastSlashIndex);
            }
          }

          return { context, path: parentPath };
        },
        onDone: [
          {
            target: 'error',
            guard: 'isDirectoryReadFailed',
            actions: ['setError'],
          },
          {
            target: 'ready',
            actions: [
              'updateFileTree',
              'removeDeletedFileFromTree',
              'removeDeletedFileFromOpenFiles',
              'emitFileDeleted',
            ],
          },
        ],
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
        loadDirectory: {
          target: 'loadingDirectory',
        },
        // Allow file operations to recover from error state
        writeFile: {
          target: 'writingFile',
        },
        writeFiles: {
          target: 'writingFiles',
        },
        readFile: {
          target: 'readingFile',
        },
        renameFile: [
          {
            guard: 'isSamePathRename',
            target: 'error',
          },
          {
            target: 'renamingFile',
          },
        ],
        deleteFile: {
          target: 'deletingFile',
        },
      },
    },
  },
});

export type FileManagerMachine = typeof fileManagerMachine;
export type { FileManagerEmitted, FileWriteSource };
