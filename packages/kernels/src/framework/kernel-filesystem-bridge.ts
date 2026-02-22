/**
 * FileSystem MessagePort Bridge
 *
 * Creates a MessageChannel-based bridge between a KernelFileSystem implementation
 * and a kernel worker. Proxies only the 8 required KernelFileSystem methods.
 *
 * Production: the bridge proxies calls from kernel worker -> file-manager worker.
 * Tests: the bridge proxies calls from kernel worker -> in-process filesystem directly.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';

type FileSystemPortable = {
  [K in keyof KernelFileSystem]: (...args: never[]) => Promise<unknown> | void;
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
 * Maximum time (ms) to wait for a message port call to complete.
 */
const messagePortCallTimeoutMs = 30_000;

/**
 * Serve a KernelFileSystem over a MessagePort.
 *
 * Sets up a message handler on the given port. Incoming `{ id, method, args }`
 * messages are dispatched to the filesystem and responded to with `{ id, result }`
 * or `{ id, error }`. Can run in any context: main thread, worker, or Node.js.
 *
 * @param fileSystem - A KernelFileSystem implementation to serve
 * @param port - MessagePort to listen on
 */
export function createFileSystemServer(fileSystem: FileSystemPortable, port: MessagePort): void {
  // eslint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = async (event: MessageEvent<BridgeRequest>): Promise<void> => {
    const { id, method, args } = event.data;

    const fn = fileSystem[method as keyof KernelFileSystem] as ((...fnArgs: unknown[]) => Promise<unknown>) | undefined;
    if (!fn) {
      port.postMessage({ id, error: `Unknown method: ${method}` } satisfies BridgeResponse);
      return;
    }

    try {
      const result: unknown = await fn(...args);
      port.postMessage({ id, result } satisfies BridgeResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      port.postMessage({ id, error: message } satisfies BridgeResponse);
    }
  };
}

/**
 * Create a MessagePort that bridges to a KernelFileSystem implementation.
 *
 * Convenience wrapper: creates a MessageChannel, serves the filesystem on port1
 * via `createFileSystemServer`, and returns port2 for the consumer.
 *
 * @param fileSystem - A KernelFileSystem implementation (all methods are async-compatible)
 * @returns MessagePort to pass to the kernel worker
 */
export function createFileSystemPort(fileSystem: FileSystemPortable): MessagePort {
  const channel = new MessageChannel();
  createFileSystemServer(fileSystem, channel.port1);
  return channel.port2;
}

/**
 * Create a KernelFileSystem proxy backed by a MessagePort.
 *
 * Each method call sends a `{ id, method, args }` message and waits for
 * the matching `{ id, result }` or `{ id, error }` response.
 *
 * Used inside the kernel worker to consume a filesystem served over a MessagePort.
 *
 * @param port - MessagePort connected to a filesystem bridge
 * @returns KernelFileSystem interface backed by the port
 */
export function createFileSystemProxy(port: MessagePort): KernelFileSystem {
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

  if ('unref' in port && typeof port.unref === 'function') {
    (port as unknown as { unref: () => void }).unref();
  }

  async function call(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`Filesystem call '${method}' timed out`));
        }
      }, messagePortCallTimeoutMs);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
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
    writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string) =>
      call('writeFile', [path, data]) as Promise<void>,
    mkdir: async (path: string, options?: { recursive?: boolean }) => call('mkdir', [path, options]) as Promise<void>,
    readdir: async (path: string) => call('readdir', [path]) as Promise<string[]>,
    unlink: async (path: string) => call('unlink', [path]) as Promise<void>,
    stat: async (path: string) =>
      call('stat', [path]) as Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>,
    exists: async (path: string) => call('exists', [path]) as Promise<boolean>,
  };
}
