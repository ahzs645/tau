import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { SnapshotFrom } from 'xstate';
import type { Remote } from 'comlink';
import type { FileTreeEntry, FilesystemBackend, FileStat } from '@taucad/types';
import { fileManagerMachine } from '#machines/file-manager.machine.js';
import type { FileWriteSource, FileManagerRef } from '#machines/file-manager.machine.types.js';
import type { FileManager as FileWorker, FileTreeNode } from '#machines/file-manager.js';
import { storeDirectoryHandle, getStoredDirectoryHandle, requestHandlePermission } from '#filesystem/handle-store.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
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

/**
 * Status of the webaccess (File System Access API) connection.
 * - 'disconnected': No directory handle stored or available
 * - 'connected': Directory handle is available and has permission
 * - 'needs-permission': Directory handle exists but needs user gesture to re-grant permission
 */
export type WebAccessStatus = 'disconnected' | 'connected' | 'needs-permission';

type FileManagerContextType = {
  fileManagerRef: FileManagerRef;
  writeFile: (path: string, data: Uint8Array<ArrayBuffer>, options: WriteFileOptions) => Promise<void>;
  writeFiles: (files: Record<string, { content: Uint8Array<ArrayBuffer> }>) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  deleteFile: (path: string, options: DeleteFileOptions) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  getDirectoryStat: (path: string) => Promise<FileStat[]>;
  getZippedDirectory: (path: string) => Promise<Blob>;
  copyDirectory: (sourcePath: string, destinationPath: string) => Promise<void>;
  reconfigureBackend: (backend: FilesystemBackend) => Promise<void>;
  /** Open a directory picker, store the handle, and reconfigure to webaccess backend. */
  selectDirectory: () => Promise<void>;
  /** Re-request permission on a stored directory handle. Must be called from a user gesture. */
  reconnectDirectory: () => Promise<boolean>;
  /** Current status of the webaccess backend connection. */
  webAccessStatus: WebAccessStatus;
  /** Name of the connected directory (if webaccess is active). */
  connectedDirectoryName: string | undefined;
  /**
   * Read a file tree from a specific backend using a standalone FileSystem instance.
   * Used by the /files grid view to show all backends in parallel without affecting the main mount.
   */
  readBackendFileTree: (backend: FilesystemBackend) => Promise<FileTreeNode[]>;
};

const FileManagerContext = createContext<FileManagerContextType | undefined>(undefined);

export function FileManagerProvider({
  children,
  rootDirectory,
  buildId,
  shouldInitializeOnStart = true,
}: {
  readonly children: ReactNode;
  readonly rootDirectory: string;
  /** When provided, the per-build backend config is read from the config store. */
  readonly buildId?: string;
  readonly shouldInitializeOnStart?: boolean;
}): React.JSX.Element {
  const [backendCookie] = useCookie(cookieName.filesystemBackend, 'indexeddb' as FilesystemBackend);

  // Use per-build config when buildId is provided; resolved async during machine init
  const actorRef = useActorRef(fileManagerMachine, {
    input: {
      rootDirectory,
      shouldInitializeOnStart,
      initialBackend: backendCookie,
      buildId,
    },
  });

  // Store rootDirectory in ref to avoid stale closures
  const rootDirectoryRef = useRef(rootDirectory);
  rootDirectoryRef.current = rootDirectory;

  // Handle root directory or buildId changes (e.g., navigating between builds).
  // The machine's isRootChanged guard ensures same-value events are no-ops,
  // so this is safe to send unconditionally on every render cycle.
  useEffect(() => {
    actorRef.send({ type: 'setRoot', path: rootDirectory, buildId });
  }, [actorRef, rootDirectory, buildId]);

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
   * Get all file stats in a directory recursively.
   */
  const getDirectoryStat = useCallback(
    async (path: string): Promise<FileStat[]> => {
      const worker = await getReadiedWorker();
      const absolutePath = joinPath(rootDirectoryRef.current, path);
      return worker.getDirectoryStat(absolutePath);
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

  /**
   * Reconfigure the filesystem with a different backend.
   * Calls the worker to reconfigure and triggers a file tree refresh.
   */
  const reconfigureBackend = useCallback(
    async (backend: FilesystemBackend): Promise<void> => {
      const worker = await getReadiedWorker();

      // Stop file watching when switching away from webaccess
      if (backend !== 'webaccess') {
        actorRef.send({ type: 'stopWatching' });
      }

      await worker.reconfigure(backend);

      // Track the backend type in the machine context
      actorRef.send({ type: 'setBackendType', backendType: backend });

      // Start file watching when switching to webaccess
      if (backend === 'webaccess') {
        actorRef.send({ type: 'startWatching' });
      }

      // Trigger file tree refresh after reconfiguration
      actorRef.send({ type: 'filesWritten', paths: [] });
    },
    [actorRef, getReadiedWorker],
  );

  // ============ WebAccess (File System Access API) ============

  // Local state for directory name (not tracked in machine)
  const [connectedDirectoryName, setConnectedDirectoryName] = useState<string | undefined>(undefined);

  // Derive webAccessStatus from machine context
  // The machine tracks webAccessNeedsPermission (set during init) and backendType
  const machineWebAccessNeedsPermission = useSelector(actorRef, (state) => state.context.webAccessNeedsPermission);
  const machineBackendType = useSelector(actorRef, (state) => state.context.backendType);

  const webAccessStatus: WebAccessStatus = useMemo(() => {
    if (machineWebAccessNeedsPermission) {
      return 'needs-permission';
    }

    if (machineBackendType === 'webaccess') {
      return 'connected';
    }

    return 'disconnected';
  }, [machineWebAccessNeedsPermission, machineBackendType]);

  /**
   * Open a directory picker dialog, store the selected handle,
   * pass it to the worker, and reconfigure to the webaccess backend.
   * Starts file watching after successful configuration.
   */
  const selectDirectory = useCallback(async (): Promise<void> => {
    // ShowDirectoryPicker must be called from a user gesture
    const handle = await globalThis.window.showDirectoryPicker({ mode: 'readwrite' });

    // Persist the handle for future sessions
    await storeDirectoryHandle(handle);

    // Pass handle to worker and reconfigure
    const worker = await getReadiedWorker();
    await worker.setDirectoryHandle(handle);
    await worker.reconfigure('webaccess');

    // Update directory name and track backend type
    setConnectedDirectoryName(handle.name);
    actorRef.send({ type: 'setBackendType', backendType: 'webaccess' });

    // Start file watching for external change detection
    actorRef.send({ type: 'startWatching' });

    // Trigger file tree refresh
    actorRef.send({ type: 'filesWritten', paths: [] });
  }, [actorRef, getReadiedWorker]);

  /**
   * Re-request permission on a previously stored directory handle.
   * Must be called from a user gesture (e.g., button click).
   *
   * @returns true if permission was granted, false otherwise
   */
  const reconnectDirectory = useCallback(async (): Promise<boolean> => {
    const handle = await getStoredDirectoryHandle();
    if (!handle) {
      return false;
    }

    const granted = await requestHandlePermission(handle);
    if (!granted) {
      return false;
    }

    // Pass handle to worker and reconfigure
    const worker = await getReadiedWorker();
    await worker.setDirectoryHandle(handle);
    await worker.reconfigure('webaccess');

    // Update directory name and track backend type
    setConnectedDirectoryName(handle.name);
    actorRef.send({ type: 'setBackendType', backendType: 'webaccess' });

    // Start file watching
    actorRef.send({ type: 'startWatching' });

    // Trigger file tree refresh
    actorRef.send({ type: 'filesWritten', paths: [] });

    return true;
  }, [actorRef, getReadiedWorker]);

  /**
   * Read the file tree from a specific backend using a standalone FileSystem instance.
   * For webaccess, retrieves the workspace handle from the main-thread handle store
   * and passes it to the worker (Comlink handles structured cloning).
   */
  const readBackendFileTree = useCallback(
    async (backend: FilesystemBackend): Promise<FileTreeNode[]> => {
      const worker = await getReadiedWorker();
      // For webaccess, retrieve the workspace handle on the main thread and pass it
      const handle = backend === 'webaccess' ? await getStoredDirectoryHandle() : undefined;
      return worker.readBackendFileTree(backend, handle);
    },
    [getReadiedWorker],
  );

  /**
   * Resolve the connected directory name on mount.
   * The machine handles backend configuration and permission checking during init,
   * but we need to resolve the human-readable directory name on the main thread.
   */
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
      fileManagerRef: actorRef,
      writeFile,
      writeFiles,
      readFile,
      renameFile,
      deleteFile,
      exists,
      readdir,
      getDirectoryStat,
      getZippedDirectory,
      copyDirectory,
      reconfigureBackend,
      selectDirectory,
      reconnectDirectory,
      webAccessStatus,
      connectedDirectoryName,
      readBackendFileTree,
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
      getDirectoryStat,
      getZippedDirectory,
      copyDirectory,
      reconfigureBackend,
      selectDirectory,
      reconnectDirectory,
      webAccessStatus,
      connectedDirectoryName,
      readBackendFileTree,
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
