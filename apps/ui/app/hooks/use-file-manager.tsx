import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { SnapshotFrom } from 'xstate';
import type { FileTreeEntry, FileSystemBackend, FileStatEntry, FileStat } from '@taucad/types';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileWriteSource, FileManagerRef, FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileTreeNode, MountOptions } from '@taucad/filesystem';
import { getStoredDirectoryHandle } from '#filesystem/handle-store.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import type { FileContentService } from '#lib/file-content-service.js';
import type { FileTreeService } from '#lib/file-tree-service.js';

type FileManagerSnapshot = SnapshotFrom<typeof fileManagerMachine>;

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

function assertNotErrorState(snapshot: FileManagerSnapshot, fallbackMessage: string): void {
  if (snapshot.matches('error')) {
    throw new Error(snapshot.context.error?.message ?? fallbackMessage);
  }
}

type WriteFileOptions = {
  source: FileWriteSource;
};

type DeleteFileOptions = {
  source: FileWriteSource;
};

type FileManagerContextType = {
  fileManagerRef: FileManagerRef;
  backendType: FileSystemBackend;
  contentService: FileContentService | undefined;
  treeService: FileTreeService | undefined;
  writeFile: (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions) => Promise<void>;
  writeFiles: (files: Record<string, { content: Uint8Array<ArrayBuffer> }>) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  duplicateFile: (sourcePath: string, destinationPath: string) => Promise<void>;
  deleteFile: (path: string, options: DeleteFileOptions) => Promise<void>;
  stat: (path: string) => Promise<FileStat>;
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  getDirectoryStat: (path: string) => Promise<FileStatEntry[]>;
  getZippedDirectory: (path: string) => Promise<Blob>;
  copyDirectory: (sourcePath: string, destinationPath: string) => Promise<void>;
  mount: (prefix: string, backend: FileSystemBackend, options?: MountOptions) => Promise<void>;
  unmount: (prefix: string) => void;
  connectedDirectoryName: string | undefined;
  readShallowDirectory: (path: string, backend: FileSystemBackend) => Promise<FileTreeNode[]>;
};

const FileManagerContext = createContext<FileManagerContextType | undefined>(undefined);

const SharedWorkerContext = createContext<Worker | undefined>(undefined);

/**
 * Gate component that defers rendering until the parent FileManagerProvider's
 * worker is available via SharedWorkerContext. Prevents nested
 * FileManagerProviders from creating duplicate workers during the window
 * between root mount and root worker initialization.
 */
export function SharedWorkerGate({ children }: { readonly children: ReactNode }): React.ReactNode | undefined {
  const worker = useContext(SharedWorkerContext);

  if (!worker) {
    return undefined;
  }

  return children;
}

export function FileManagerProvider({
  children,
  rootDirectory,
  projectId,
  shouldInitializeOnStart = true,
}: {
  readonly children: ReactNode;
  readonly rootDirectory: string;
  readonly projectId?: string;
  readonly shouldInitializeOnStart?: boolean;
}): React.JSX.Element {
  const [backendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FileSystemBackend);
  const parentWorker = useContext(SharedWorkerContext);

  const fileManagerRef = useActorRef(fileManagerMachine, {
    input: {
      rootDirectory,
      shouldInitializeOnStart,
      initialBackend: backendCookie,
      projectId,
      sharedWorker: parentWorker,
    },
  });

  const rootDirectoryRef = useRef(rootDirectory);
  rootDirectoryRef.current = rootDirectory;

  useEffect(() => {
    fileManagerRef.send({ type: 'setRoot', path: rootDirectory, projectId });
  }, [fileManagerRef, rootDirectory, projectId]);

  const contentService = useSelector(fileManagerRef, (state) => state.context.contentService);
  const treeService = useSelector(fileManagerRef, (state) => state.context.treeService);
  const backendType = useSelector(fileManagerRef, (state) => state.context.backendType);

  /**
   * Wait for machine ready and return proxy. Used for admin operations
   * (mount, unmount, readShallowDirectory) that are not file I/O.
   */
  const getReadiedProxy = useCallback(async (): Promise<FileManagerProxy> => {
    const snapshot = await waitFor(
      fileManagerRef,
      createErrorAwareWaitPredicate((state) => state.matches('ready')),
    );

    assertNotErrorState(snapshot, 'File manager initialization failed');

    const { proxy } = snapshot.context;
    if (!proxy) {
      throw new Error('File manager worker not initialized');
    }

    return proxy;
  }, [fileManagerRef]);

  const writeFile = useCallback(
    async (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions): Promise<void> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.write(path, data, options.source);
    },
    [contentService],
  );

  const writeFiles = useCallback(
    async (files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.writeFiles(files, 'machine');
    },
    [contentService],
  );

  const readFile = useCallback(
    async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      return contentService.resolveBytes(path);
    },
    [contentService],
  );

  const renameFile = useCallback(
    async (oldPath: string, newPath: string): Promise<void> => {
      if (oldPath === newPath) {
        return;
      }
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.rename(oldPath, newPath);
    },
    [contentService],
  );

  const duplicateFile = useCallback(
    async (sourcePath: string, destinationPath: string): Promise<void> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.duplicate(sourcePath, destinationPath);
    },
    [contentService],
  );

  const deleteFile = useCallback(
    async (path: string, options: DeleteFileOptions): Promise<void> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.delete(path, options.source);
    },
    [contentService],
  );

  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      if (!treeService) {
        throw new Error('Tree service not initialized');
      }
      return treeService.exists(path);
    },
    [treeService],
  );

  const readdir = useCallback(
    async (path: string): Promise<string[]> => {
      if (!treeService) {
        throw new Error('Tree service not initialized');
      }
      return treeService.readdir(path);
    },
    [treeService],
  );

  const stat = useCallback(
    async (path: string): Promise<FileStat> => {
      if (!treeService) {
        throw new Error('Tree service not initialized');
      }
      return treeService.stat(path);
    },
    [treeService],
  );

  const getDirectoryStat = useCallback(
    async (path: string): Promise<FileStatEntry[]> => {
      if (!treeService) {
        throw new Error('Tree service not initialized');
      }
      return treeService.getDirectoryStat(path);
    },
    [treeService],
  );

  const getZippedDirectory = useCallback(
    async (path: string): Promise<Blob> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      return contentService.getZippedDirectory(path);
    },
    [contentService],
  );

  const copyDirectory = useCallback(
    async (sourcePath: string, destinationPath: string): Promise<void> => {
      if (!contentService) {
        throw new Error('Content service not initialized');
      }
      await contentService.copyDirectory(sourcePath, destinationPath);
    },
    [contentService],
  );

  const mount = useCallback(
    async (prefix: string, backend: FileSystemBackend, options?: MountOptions): Promise<void> => {
      const proxy = await getReadiedProxy();
      await proxy.mount(prefix, backend, options);
    },
    [getReadiedProxy],
  );

  const unmount = useCallback(
    (prefix: string): void => {
      void (async () => {
        const proxy = await getReadiedProxy();
        proxy.unmount(prefix);
      })();
    },
    [getReadiedProxy],
  );

  const [connectedDirectoryName, setConnectedDirectoryName] = useState<string | undefined>(undefined);

  const readShallowDirectory = useCallback(
    async (path: string, backend: FileSystemBackend): Promise<FileTreeNode[]> => {
      if (!treeService) {
        throw new Error('Tree service not initialized');
      }
      const handle = backend === 'webaccess' ? await getStoredDirectoryHandle() : undefined;
      if (handle) {
        const proxy = await getReadiedProxy();
        return proxy.readShallowDirectory(path, backend, handle);
      }
      return treeService.readShallowDirectory(path, backend);
    },
    [treeService, getReadiedProxy],
  );

  useEffect(() => {
    const resolveDirectoryName = async (): Promise<void> => {
      try {
        const handle = await getStoredDirectoryHandle();
        if (handle) {
          setConnectedDirectoryName(handle.name);
        }
      } catch {
        // Handle store might not be available (e.g., private browsing)
      }
    };

    void resolveDirectoryName();
  }, []);

  const value = useMemo<FileManagerContextType>(
    () => ({
      fileManagerRef,
      backendType,
      contentService,
      treeService,
      writeFile,
      writeFiles,
      readFile,
      renameFile,
      duplicateFile,
      deleteFile,
      stat,
      exists,
      readdir,
      getDirectoryStat,
      getZippedDirectory,
      copyDirectory,
      mount,
      unmount,
      connectedDirectoryName,
      readShallowDirectory,
    }),
    [
      fileManagerRef,
      backendType,
      contentService,
      treeService,
      writeFile,
      writeFiles,
      readFile,
      renameFile,
      duplicateFile,
      deleteFile,
      stat,
      exists,
      readdir,
      getDirectoryStat,
      getZippedDirectory,
      copyDirectory,
      mount,
      unmount,
      connectedDirectoryName,
      readShallowDirectory,
    ],
  );

  const isRoot = parentWorker === undefined;
  const workerForChildren = useSelector(fileManagerRef, (state) => state.context.worker);

  const provider = <FileManagerContext.Provider value={value}>{children}</FileManagerContext.Provider>;

  if (isRoot) {
    return <SharedWorkerContext.Provider value={workerForChildren}>{provider}</SharedWorkerContext.Provider>;
  }

  return provider;
}

export function useFileManager(): FileManagerContextType {
  const context = useContext(FileManagerContext);
  if (context === undefined) {
    throw new Error('useFileManager must be used within a FileManagerProvider');
  }

  return context;
}

/**
 * Non-throwing variant of `useFileManager`. Returns `undefined` when called
 * outside a `FileManagerProvider` instead of throwing. Used by components
 * that optionally read from the file manager context (e.g. `FileSelector`).
 */
export function useOptionalFileManager(): FileManagerContextType | undefined {
  return useContext(FileManagerContext);
}

/**
 * Hook to get the current file tree as an array of file entries.
 * This is used to provide context to the LLM about the project structure.
 *
 * @returns Array of file entries, or undefined if the file manager is not ready
 */
export function useFileTree(): FileTreeEntry[] | undefined {
  const { treeService } = useFileManager();

  if (!treeService) {
    return undefined;
  }

  const tree = treeService.getTreeSnapshot();
  if (tree.size === 0) {
    return undefined;
  }

  return [...tree.values()].map(({ path, name, type, size }) => ({
    path,
    name,
    type,
    size,
  }));
}
