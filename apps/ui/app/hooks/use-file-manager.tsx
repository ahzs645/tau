import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { SnapshotFrom } from 'xstate';
import type { FileTreeEntry, FileSystemBackend, FileStatEntry, FileStat } from '@taucad/types';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileWriteSource } from '@taucad/fs-client/file-write-source';
import type { FileManagerRef, FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { FileTreeNode, MountOptions } from '@taucad/filesystem';
import { getStoredDirectoryHandle } from '#filesystem/handle-store.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import type { FileContentService } from '@taucad/fs-client/file-content-service';
import type { FileTreeService } from '@taucad/fs-client/file-tree-service';

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

export async function waitForFileManagerServices(
  fileManagerRef: FileManagerRef,
): Promise<{ contentService: FileContentService; treeService: FileTreeService }> {
  const snapshot = fileManagerRef.getSnapshot();
  const { contentService: content, treeService: tree } = snapshot.context;
  if (content && tree) {
    return { contentService: content, treeService: tree };
  }

  const settled = await waitFor(
    fileManagerRef,
    createErrorAwareWaitPredicate(
      (state) => state.context.contentService !== undefined && state.context.treeService !== undefined,
    ),
  );
  assertNotErrorState(settled, 'File manager failed to initialize before services were requested');
  const readyContent = settled.context.contentService;
  const readyTree = settled.context.treeService;
  if (!readyContent || !readyTree) {
    throw new Error('File manager services not available');
  }

  return { contentService: readyContent, treeService: readyTree };
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
  /** Resolves once both content and tree facades are bound (or rejects if the machine enters `error`). */
  whenServicesReady: () => Promise<{ contentService: FileContentService; treeService: FileTreeService }>;
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
 * Carries the root FileManagerProvider's file-pool SharedArrayBuffer down to
 * nested providers. Nested machines reuse this SAB instead of allocating
 * their own 50 MiB pool, avoiding duplicate `postMessage({ type: 'filePool' })`
 * traffic to the shared worker.
 */
const SharedFilePoolBufferContext = createContext<SharedArrayBuffer | undefined>(undefined);

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
  const parentFilePoolBuffer = useContext(SharedFilePoolBufferContext);

  const fileManagerRef = useActorRef(fileManagerMachine, {
    input: {
      rootDirectory,
      shouldInitializeOnStart,
      initialBackend: backendCookie,
      projectId,
      sharedWorker: parentWorker,
      sharedFilePoolBuffer: parentFilePoolBuffer,
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

  const whenServicesReady = useCallback(async () => {
    return waitForFileManagerServices(fileManagerRef);
  }, [fileManagerRef]);

  const writeFile = useCallback(
    async (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions): Promise<void> => {
      const { contentService } = await whenServicesReady();
      await contentService.write(path, data, options.source);
    },
    [whenServicesReady],
  );

  const writeFiles = useCallback(
    async (files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void> => {
      const { contentService } = await whenServicesReady();
      await contentService.writeFiles(files, 'machine');
    },
    [whenServicesReady],
  );

  const readFile = useCallback(
    async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
      const { contentService } = await whenServicesReady();
      return contentService.resolveBytes(path);
    },
    [whenServicesReady],
  );

  const renameFile = useCallback(
    async (oldPath: string, newPath: string): Promise<void> => {
      if (oldPath === newPath) {
        return;
      }
      const { contentService } = await whenServicesReady();
      await contentService.rename(oldPath, newPath);
    },
    [whenServicesReady],
  );

  const duplicateFile = useCallback(
    async (sourcePath: string, destinationPath: string): Promise<void> => {
      const { contentService } = await whenServicesReady();
      await contentService.duplicate(sourcePath, destinationPath);
    },
    [whenServicesReady],
  );

  const deleteFile = useCallback(
    async (path: string, options: DeleteFileOptions): Promise<void> => {
      const { contentService } = await whenServicesReady();
      await contentService.delete(path, options.source);
    },
    [whenServicesReady],
  );

  const exists = useCallback(
    async (path: string): Promise<boolean> => {
      const { treeService } = await whenServicesReady();
      return treeService.exists(path);
    },
    [whenServicesReady],
  );

  const readdir = useCallback(
    async (path: string): Promise<string[]> => {
      const { treeService } = await whenServicesReady();
      return treeService.readdir(path);
    },
    [whenServicesReady],
  );

  const stat = useCallback(
    async (path: string): Promise<FileStat> => {
      const { treeService } = await whenServicesReady();
      return treeService.stat(path);
    },
    [whenServicesReady],
  );

  const getDirectoryStat = useCallback(
    async (path: string): Promise<FileStatEntry[]> => {
      const { treeService } = await whenServicesReady();
      return treeService.getDirectoryStat(path);
    },
    [whenServicesReady],
  );

  const getZippedDirectory = useCallback(
    async (path: string): Promise<Blob> => {
      const { contentService } = await whenServicesReady();
      return contentService.getZippedDirectory(path);
    },
    [whenServicesReady],
  );

  const copyDirectory = useCallback(
    async (sourcePath: string, destinationPath: string): Promise<void> => {
      const { contentService } = await whenServicesReady();
      await contentService.copyDirectory(sourcePath, destinationPath);
    },
    [whenServicesReady],
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
      // async-iife: bootstrap
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
      const { treeService } = await whenServicesReady();
      const handle = backend === 'webaccess' ? await getStoredDirectoryHandle() : undefined;
      if (handle) {
        const proxy = await getReadiedProxy();
        return proxy.readShallowDirectory(path, backend, handle);
      }
      return treeService.readShallowDirectory(path, backend);
    },
    [whenServicesReady, getReadiedProxy],
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
      whenServicesReady,
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
      whenServicesReady,
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
  const filePoolBufferForChildren = useSelector(fileManagerRef, (state) => state.context.filePoolBuffer);

  const provider = <FileManagerContext.Provider value={value}>{children}</FileManagerContext.Provider>;

  if (isRoot) {
    return (
      <SharedWorkerContext.Provider value={workerForChildren}>
        <SharedFilePoolBufferContext.Provider value={filePoolBufferForChildren}>
          {provider}
        </SharedFilePoolBufferContext.Provider>
      </SharedWorkerContext.Provider>
    );
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
