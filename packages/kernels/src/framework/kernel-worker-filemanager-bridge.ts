/**
 * FileManager MessagePort Bridge
 *
 * Creates a MessageChannel-based bridge between a FileManager (or Comlink Remote<FileManager>)
 * and a kernel worker. Replaces Comlink's `createEndpoint` + `wrap` pattern for the
 * kernel↔file-manager communication path.
 *
 * Production: the bridge proxies calls from kernel worker → Comlink Remote<FileManager> → FM worker.
 * Tests: the bridge proxies calls from kernel worker → in-process fileManager directly.
 */

/**
 * Portable FileManager interface for kernel worker communication.
 * Self-contained -- does not import the UI app's FileManager class.
 * Any object that implements these methods can be bridged to a kernel worker.
 */
export type KernelFileManager = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  writeFiles(files: Record<string, { content: Uint8Array<ArrayBuffer> }>): Promise<void>;
  mkdir(path: string, options?: { mode?: number; recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  batchExists(paths: string[]): Promise<Record<string, boolean>>;
  ensureDirectoryExists(path: string): Promise<void>;
  getDirectoryStat(
    path: string,
  ): Promise<Array<{ path: string; name: string; type: 'file' | 'dir'; size: number; mtimeMs: number }>>;
  getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  duplicateFile(src: string, dst: string): Promise<void>;
  copyDirectory(src: string, dst: string): Promise<void>;
  getZippedDirectory(path: string): Promise<Blob>;
  reconfigure(backend: string): Promise<void>;
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;
  readBackendFileTree(
    backend: string,
    handle?: FileSystemDirectoryHandle,
  ): Promise<Array<{ path: string; content: Uint8Array<ArrayBuffer> }>>;
};

type FileManagerPortable = {
  [K in keyof KernelFileManager]: (...args: never[]) => Promise<unknown> | void;
};

type BridgeRequest = {
  id: number;
  method: string;
  args: unknown[];
};

type BridgeResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

/**
 * Create a MessagePort that bridges to a FileManager instance.
 *
 * Sets up a MessageChannel. On port1, incoming `{ id, method, args }` messages
 * are dispatched to the fileManager and responded to with `{ id, result }` or `{ id, error }`.
 * Returns port2, which the kernel worker uses via `createFileManagerProxy()`.
 *
 * @param fileManager - A FileManager or Comlink Remote<FileManager> (all methods are async-compatible)
 * @returns MessagePort to pass to the kernel worker
 */
export function createFileManagerPort(fileManager: FileManagerPortable): MessagePort {
  const channel = new MessageChannel();

  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  channel.port1.onmessage = async (event: MessageEvent<BridgeRequest>): Promise<void> => {
    const { id, method, args } = event.data;

    const fn = fileManager[method as keyof KernelFileManager] as
      | ((...fnArgs: unknown[]) => Promise<unknown>)
      | undefined;
    if (!fn) {
      channel.port1.postMessage({ id, error: `Unknown method: ${method}` } satisfies BridgeResponse);
      return;
    }

    try {
      const result: unknown = await fn.apply(fileManager, args);
      channel.port1.postMessage({ id, result } satisfies BridgeResponse);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      channel.port1.postMessage({ id, error: message } satisfies BridgeResponse);
    }
  };

  return channel.port2;
}

/**
 * Create a FileManager proxy backed by a MessagePort.
 *
 * Each method call sends a `{ id, method, args }` message and waits for
 * the matching `{ id, result }` or `{ id, error }` response.
 *
 * Used inside the kernel worker to replace `wrap<FileManager>(port)` from Comlink.
 *
 * @param port - MessagePort connected to a FileManager bridge
 * @returns FileManager interface backed by the port
 */
export function createFileManagerProxy(port: MessagePort): KernelFileManager {
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = (event: MessageEvent<BridgeResponse>): void => {
    const { id, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }

    pending.delete(id);
    if (error === undefined) {
      entry.resolve(result);
    } else {
      entry.reject(new Error(error));
    }
  };

  // Node.js MessagePort requires explicit unref to avoid keeping the process alive
  if ('unref' in port && typeof port.unref === 'function') {
    (port as unknown as { unref: () => void }).unref();
  }

  async function call(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, method, args } satisfies BridgeRequest);
    });
  }

  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding) {
      return call('readFile', [path, encoding]) as Promise<string>;
    }

    return call('readFile', [path]) as Promise<Uint8Array<ArrayBuffer>>;
  }

  return {
    readFile,
    readFiles: async (paths: string[]) =>
      call('readFiles', [paths]) as Promise<Record<string, Uint8Array<ArrayBuffer>>>,
    writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string) =>
      call('writeFile', [path, data]) as Promise<void>,
    writeFiles: async (files: Record<string, { content: Uint8Array<ArrayBuffer> }>) =>
      call('writeFiles', [files]) as Promise<void>,
    mkdir: async (path: string, options?: { mode?: number; recursive?: boolean }) =>
      call('mkdir', [path, options]) as Promise<void>,
    readdir: async (path: string) => call('readdir', [path]) as Promise<string[]>,
    stat: async (path: string) =>
      call('stat', [path]) as Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>,
    rename: async (oldPath: string, newPath: string) => call('rename', [oldPath, newPath]) as Promise<void>,
    unlink: async (path: string) => call('unlink', [path]) as Promise<void>,
    rmdir: async (path: string) => call('rmdir', [path]) as Promise<void>,
    exists: async (path: string) => call('exists', [path]) as Promise<boolean>,
    batchExists: async (paths: string[]) => call('batchExists', [paths]) as Promise<Record<string, boolean>>,
    ensureDirectoryExists: async (path: string) => call('ensureDirectoryExists', [path]) as Promise<void>,
    getDirectoryStat: async (path: string) =>
      call('getDirectoryStat', [path]) as ReturnType<KernelFileManager['getDirectoryStat']>,
    getDirectoryContents: async (path: string) =>
      call('getDirectoryContents', [path]) as Promise<Record<string, Uint8Array<ArrayBuffer>>>,
    duplicateFile: async (src: string, dst: string) => call('duplicateFile', [src, dst]) as Promise<void>,
    copyDirectory: async (src: string, dst: string) => call('copyDirectory', [src, dst]) as Promise<void>,
    getZippedDirectory: async (path: string) => call('getZippedDirectory', [path]) as Promise<Blob>,
    reconfigure: async (backend: string) => call('reconfigure', [backend]) as Promise<void>,
    setDirectoryHandle(handle: FileSystemDirectoryHandle) {
      void call('setDirectoryHandle', [handle]);
    },
    readBackendFileTree: async (backend: string, handle?: FileSystemDirectoryHandle) =>
      call('readBackendFileTree', [backend, handle]) as ReturnType<KernelFileManager['readBackendFileTree']>,
  };
}
