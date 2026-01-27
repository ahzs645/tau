import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect, useRef } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom, SnapshotFrom } from 'xstate';
import type { Remote } from 'comlink';
import type { FileTreeEntry } from '@taucad/types';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileWriteSource } from '#machines/file-manager.machine.js';
import type { FileManager as FileWorker } from '#machines/file-manager.js';
import { joinPath } from '#utils/path.utils.js';

type FileManagerSnapshot = SnapshotFrom<typeof fileManagerMachine>;

/**
 * Creates a waitFor predicate that returns true if either the success condition is met
 * OR the machine enters the error state. This prevents infinite hangs when operations fail.
 */
function createErrorAwareWaitPredicate(
  predicate: (state: FileManagerSnapshot) => boolean,
): (state: FileManagerSnapshot) => boolean {
  return (state: FileManagerSnapshot) => {
    if (state.matches('error')) {
      return true;
    }

    return predicate(state);
  };
}

/**
 * Checks if the snapshot is in error state and throws with the error message.
 */
function assertNotErrorState(snapshot: FileManagerSnapshot, fallbackMessage: string): void {
  if (snapshot.matches('error')) {
    const errorMessage = snapshot.context.error?.message ?? fallbackMessage;
    throw new Error(errorMessage);
  }
}

type WriteFileOptions = {
  source: FileWriteSource;
};

type DeleteFileOptions = {
  source: FileWriteSource;
};

type FileManagerContextType = {
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  writeFile: (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions) => Promise<void>;
  writeFiles: (files: Record<string, { content: Uint8Array<ArrayBuffer> }>) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  deleteFile: (path: string, options: DeleteFileOptions) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  getZippedDirectory: (path: string) => Promise<Blob>;
  copyDirectory: (sourcePath: string, destinationPath: string) => Promise<void>;
};

const FileManagerContext = createContext<FileManagerContextType | undefined>(undefined);

export function FileManagerProvider({
  children,
  rootDirectory,
  shouldInitializeOnStart = true,
}: {
  readonly children: ReactNode;
  readonly rootDirectory: string;
  readonly shouldInitializeOnStart?: boolean;
}): React.JSX.Element {
  const actorRef = useActorRef(fileManagerMachine, {
    input: {
      rootDirectory,
      shouldInitializeOnStart,
    },
  });

  // Store rootDirectory in ref to avoid stale closures
  const rootDirectoryRef = useRef(rootDirectory);
  rootDirectoryRef.current = rootDirectory;

  // Handle root directory changes
  useEffect(() => {
    actorRef.send({ type: 'setRoot', path: rootDirectory });
  }, [actorRef, rootDirectory]);

  /**
   * Wait for the file manager to be ready and return the wrapped worker.
   * This follows the established buildManagerMachine pattern.
   */
  const getReadiedWorker = useCallback(async (): Promise<Remote<FileWorker>> => {
    const snapshot = await waitFor(
      actorRef,
      createErrorAwareWaitPredicate((state) => state.matches('ready')),
    );
    assertNotErrorState(snapshot, 'File manager initialization failed');

    const worker = snapshot.context.wrappedWorker;
    if (!worker) {
      throw new Error('File manager worker not initialized');
    }

    return worker;
  }, [actorRef]);

  /**
   * Write a single file to the filesystem.
   * Calls worker directly, then sends single consolidated event.
   * Machine handles: updating openFiles, emitting UI event, spawning background refresh.
   */
  const writeFile = useCallback(
    async (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions): Promise<void> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);

      // Call worker directly - this is the operation confirmation
      await worker.writeFile(absolutePath, data);

      // Single consolidated event - machine handles context update, emit, and refresh
      actorRef.send({ type: 'fileWritten', path, data, source: options.source });
    },
    [actorRef, getReadiedWorker],
  );

  /**
   * Write multiple files to the filesystem.
   * Uses worker's batch write for efficiency.
   * Machine spawns background refresh to update file tree.
   */
  const writeFiles = useCallback(
    async (files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void> => {
      const worker = await getReadiedWorker();

      // Convert to absolute paths
      const absoluteFiles: Record<string, { content: Uint8Array<ArrayBuffer> }> = {};
      const paths: string[] = [];

      for (const [path, file] of Object.entries(files)) {
        const absolutePath = joinPath(rootDirectoryRef.current, path);
        absoluteFiles[absolutePath] = file;
        paths.push(path);
      }

      // Call worker directly - batch write
      await worker.writeFiles(absoluteFiles);

      // Single consolidated event - machine spawns background refresh
      actorRef.send({ type: 'filesWritten', paths });
    },
    [actorRef, getReadiedWorker],
  );

  /**
   * Read a file from the filesystem.
   * Calls worker directly, then caches in open files.
   * No file tree refresh needed for reads.
   */
  const readFile = useCallback(
    async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);

      // Call worker directly
      const data = await worker.readFile(absolutePath);

      // Single consolidated event - machine updates openFiles and emits
      actorRef.send({ type: 'fileRead', path, data });

      return data;
    },
    [actorRef, getReadiedWorker],
  );

  /**
   * Rename a file or directory.
   * Machine handles optimistic update, emit, and background refresh.
   */
  const renameFile = useCallback(
    async (oldPath: string, newPath: string): Promise<void> => {
      // Skip no-op renames
      if (oldPath === newPath) {
        return;
      }

      const worker = await getReadiedWorker();
      const absoluteOldPath = joinPath(rootDirectoryRef.current, oldPath);
      const absoluteNewPath = joinPath(rootDirectoryRef.current, newPath);

      // Call worker directly
      await worker.rename(absoluteOldPath, absoluteNewPath);

      // Single consolidated event - machine handles optimistic update, emit, and refresh
      actorRef.send({ type: 'fileRenamed', oldPath, newPath });
    },
    [actorRef, getReadiedWorker],
  );

  /**
   * Delete a file from the filesystem.
   * Machine handles optimistic delete, emit, and background refresh.
   */
  const deleteFile = useCallback(
    async (path: string, options: DeleteFileOptions): Promise<void> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);

      // Call worker directly
      await worker.unlink(absolutePath);

      // Single consolidated event - machine handles optimistic delete, emit, and refresh
      actorRef.send({ type: 'fileDeleted', path, source: options.source });
    },
    [actorRef, getReadiedWorker],
  );

  /**
   * Check if a path exists in the filesystem.
   */
  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);
      return worker.exists(absolutePath);
    },
    [getReadiedWorker],
  );

  /**
   * List directory contents.
   */
  const readdir = useCallback(
    async (path: string): Promise<string[]> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);
      return worker.readdir(absolutePath);
    },
    [getReadiedWorker],
  );

  /**
   * Get a zipped archive of a directory.
   */
  const getZippedDirectory = useCallback(
    async (path: string): Promise<Blob> => {
      const worker = await getReadiedWorker();
      return worker.getZippedDirectory(path);
    },
    [getReadiedWorker],
  );

  /**
   * Copy a directory to a new location.
   * Machine spawns background refresh to update file tree.
   */
  const copyDirectory = useCallback(
    async (sourcePath: string, destinationPath: string): Promise<void> => {
      const worker = await getReadiedWorker();
      await worker.copyDirectory(sourcePath, destinationPath);

      // Single consolidated event - machine spawns background refresh
      actorRef.send({ type: 'filesWritten', paths: [] });
    },
    [actorRef, getReadiedWorker],
  );

  const value = useMemo<FileManagerContextType>(
    () => ({
      fileManagerRef: actorRef,
      writeFile,
      writeFiles,
      readFile,
      renameFile,
      deleteFile,
      exists,
      readdir,
      getZippedDirectory,
      copyDirectory,
    }),
    [
      actorRef,
      writeFile,
      writeFiles,
      readFile,
      renameFile,
      deleteFile,
      exists,
      readdir,
      getZippedDirectory,
      copyDirectory,
    ],
  );

  return <FileManagerContext.Provider value={value}>{children}</FileManagerContext.Provider>;
}

export function useFileManager(): FileManagerContextType {
  const context = useContext(FileManagerContext);
  if (context === undefined) {
    throw new Error('useFileManager must be used within a FileManagerProvider');
  }

  return context;
}

/**
 * Hook to get the current file tree as an array of file entries.
 * This is used to provide context to the LLM about the project structure.
 *
 * @returns Array of file entries, or undefined if the file manager is not ready
 */
export function useFileTree(): FileTreeEntry[] | undefined {
  const { fileManagerRef } = useFileManager();

  return useSelector(fileManagerRef, (state) => {
    if (!state.matches('ready')) {
      return undefined;
    }

    const { fileTree } = state.context;
    if (fileTree.size === 0) {
      return undefined;
    }

    // Convert Map to array and exclude isLoaded (client-side state)
    return [...fileTree.values()].map(({ path, name, type, size }) => ({
      path,
      name,
      type,
      size,
    }));
  });
}
