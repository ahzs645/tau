import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { ActorRefFrom, SnapshotFrom } from 'xstate';
import type { FileTreeEntry } from '@taucad/types';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileWriteSource } from '#machines/file-manager.machine.js';
import { joinPath } from '#utils/path.utils.js';

type FileManagerSnapshot = SnapshotFrom<typeof fileManagerMachine>;

/**
 * Creates a waitFor predicate that throws if the machine enters the error state.
 * This prevents infinite hangs when operations fail.
 */
function createErrorAwareWaitPredicate(
  predicate: (state: FileManagerSnapshot) => boolean,
  errorMessage: string,
): (state: FileManagerSnapshot) => boolean {
  return (state: FileManagerSnapshot) => {
    if (state.matches('error')) {
      const contextError = state.context.error;
      throw new Error(contextError?.message ?? errorMessage);
    }

    return predicate(state);
  };
}

type WriteFileOptions = {
  source: FileWriteSource;
};

type FileManagerContextType = {
  fileManagerRef: ActorRefFrom<typeof fileManagerMachine>;
  loadDirectory: (path: string) => Promise<void>;
  writeFile: (path: string, data: Uint8Array, options: WriteFileOptions) => Promise<void>;
  writeFiles: (files: Record<string, { content: Uint8Array }>) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
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

  useEffect(() => {
    actorRef.send({ type: 'setRoot', path: rootDirectory });
  }, [actorRef, rootDirectory]);

  const loadDirectory = useCallback(
    async (path: string) => {
      // Ensure the actor is ready before loading the directory
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      // Send the load directory event
      actorRef.send({ type: 'loadDirectory', path });
      // Ensure the directory is loaded before returning
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.context.openFiles.has(path), 'Directory load failed'),
      );
    },
    [actorRef],
  );

  const writeFile = useCallback(
    async (path: string, data: Uint8Array, options: WriteFileOptions) => {
      // Ensure the actor is ready before writing the file
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      // Send the write file event
      actorRef.send({ type: 'writeFile', path, data, source: options.source });
      // Ensure the file is written before returning
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.context.openFiles.has(path), 'File write failed'),
      );
    },
    [actorRef],
  );

  const readFile = useCallback(
    async (path: string): Promise<Uint8Array> => {
      // Ensure the actor is ready before reading the file
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      // Send the read file event
      actorRef.send({ type: 'readFile', path });
      // Ensure the file is read before returning
      const snapshot = await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.context.openFiles.has(path), 'File read failed'),
      );
      const file = snapshot.context.openFiles.get(path);

      if (!file) {
        throw new Error(`File not found in open files: ${path}`);
      }

      return file;
    },
    [actorRef],
  );

  const getZippedDirectory = useCallback(
    async (path: string): Promise<Blob> => {
      const snapshot = await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('File manager worker not initialized');
      }

      return worker.getZippedDirectory(path);
    },
    [actorRef],
  );

  const writeFiles = useCallback(
    async (files: Record<string, { content: Uint8Array }>) => {
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      actorRef.send({ type: 'writeFiles', files });
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'Files write failed'),
      );
    },
    [actorRef],
  );

  const copyDirectory = useCallback(
    async (sourcePath: string, destinationPath: string) => {
      const snapshot = await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('File manager worker not initialized');
      }

      await worker.copyDirectory(sourcePath, destinationPath);
      await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'Directory copy failed'),
      );
    },
    [actorRef],
  );

  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      const snapshot = await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('File manager worker not initialized');
      }

      // Join path with rootDirectory to match machine behavior
      const absolutePath = joinPath(snapshot.context.rootDirectory, path);

      return worker.exists(absolutePath);
    },
    [actorRef],
  );

  const readdir = useCallback(
    async (path: string): Promise<string[]> => {
      const snapshot = await waitFor(
        actorRef,
        createErrorAwareWaitPredicate((state) => state.matches('ready'), 'File manager initialization failed'),
      );
      const worker = snapshot.context.wrappedWorker;
      if (!worker) {
        throw new Error('File manager worker not initialized');
      }

      // Join path with rootDirectory to match machine behavior
      const absolutePath = joinPath(snapshot.context.rootDirectory, path);

      return worker.readdir(absolutePath);
    },
    [actorRef],
  );

  const value = useMemo<FileManagerContextType>(() => {
    return {
      fileManagerRef: actorRef,
      loadDirectory,
      writeFile,
      writeFiles,
      readFile,
      exists,
      readdir,
      getZippedDirectory,
      copyDirectory,
    };
  }, [actorRef, loadDirectory, writeFile, writeFiles, readFile, exists, readdir, getZippedDirectory, copyDirectory]);

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
