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

import type { FileManager } from '#machines/file-manager.js';

type FileManagerPortable = {
  [K in keyof FileManager]: (...args: never[]) => Promise<unknown> | void;
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

  channel.port1.onmessage = (event: MessageEvent<BridgeRequest>) => {
    const { id, method, args } = event.data;

    const fn = fileManager[method as keyof FileManager] as ((...fnArgs: unknown[]) => Promise<unknown>) | undefined;
    if (!fn) {
      channel.port1.postMessage({ id, error: `Unknown method: ${method}` } satisfies BridgeResponse);
      return;
    }

    fn.apply(fileManager, args)
      .then((result: unknown) => {
        channel.port1.postMessage({ id, result } satisfies BridgeResponse);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        channel.port1.postMessage({ id, error: message } satisfies BridgeResponse);
      });
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
export function createFileManagerProxy(port: MessagePort): FileManager {
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  port.onmessage = (event: MessageEvent<BridgeResponse>) => {
    const { id, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }

    pending.delete(id);
    if (error !== undefined) {
      entry.reject(new Error(error));
    } else {
      entry.resolve(result);
    }
  };

  // Node.js MessagePort requires explicit unref to avoid keeping the process alive
  if ('unref' in port && typeof port.unref === 'function') {
    port.unref();
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
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
    readFiles: (paths: string[]) => call('readFiles', [paths]) as Promise<Record<string, Uint8Array<ArrayBuffer>>>,
    writeFile: (path: string, data: Uint8Array<ArrayBuffer> | string) =>
      call('writeFile', [path, data]) as Promise<void>,
    writeFiles: (files: Record<string, { content: Uint8Array<ArrayBuffer> }>) =>
      call('writeFiles', [files]) as Promise<void>,
    mkdir: (path: string, options?: { mode?: number; recursive?: boolean }) =>
      call('mkdir', [path, options]) as Promise<void>,
    readdir: (path: string) => call('readdir', [path]) as Promise<string[]>,
    stat: (path: string) =>
      call('stat', [path]) as Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>,
    rename: (oldPath: string, newPath: string) => call('rename', [oldPath, newPath]) as Promise<void>,
    unlink: (path: string) => call('unlink', [path]) as Promise<void>,
    rmdir: (path: string) => call('rmdir', [path]) as Promise<void>,
    exists: (path: string) => call('exists', [path]) as Promise<boolean>,
    batchExists: (paths: string[]) => call('batchExists', [paths]) as Promise<Record<string, boolean>>,
    ensureDirectoryExists: (path: string) => call('ensureDirectoryExists', [path]) as Promise<void>,
    getDirectoryStat: (path: string) =>
      call('getDirectoryStat', [path]) as ReturnType<FileManager['getDirectoryStat']>,
    getDirectoryContents: (path: string) =>
      call('getDirectoryContents', [path]) as Promise<Record<string, Uint8Array<ArrayBuffer>>>,
    duplicateFile: (src: string, dst: string) => call('duplicateFile', [src, dst]) as Promise<void>,
    copyDirectory: (src: string, dst: string) => call('copyDirectory', [src, dst]) as Promise<void>,
    getZippedDirectory: (path: string) => call('getZippedDirectory', [path]) as Promise<Blob>,
    reconfigure: (backend: string) => call('reconfigure', [backend]) as Promise<void>,
    setDirectoryHandle: (handle: FileSystemDirectoryHandle) => {
      void call('setDirectoryHandle', [handle]);
    },
    readBackendFileTree: (backend: string, handle?: FileSystemDirectoryHandle) =>
      call('readBackendFileTree', [backend, handle]) as ReturnType<FileManager['readBackendFileTree']>,
  };
}
