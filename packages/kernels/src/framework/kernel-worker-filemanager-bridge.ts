/**
 * FileManager MessagePort Bridge
 *
 * Creates a MessageChannel-based bridge between a KernelFileSystem implementation
 * and a kernel worker. Proxies only the 8 required KernelFileSystem methods.
 *
 * Production: the bridge proxies calls from kernel worker -> main thread FileManager.
 * Tests: the bridge proxies calls from kernel worker -> in-process fileManager directly.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';

/**
 * Portable FileManager interface for kernel worker communication.
 * Self-contained -- does not import the UI app's FileManager class.
 * Any object that implements these methods can be bridged to a kernel worker.
 */
export type KernelFileManager = KernelFileSystem;

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
 * Create a MessagePort that bridges to a KernelFileSystem implementation.
 *
 * Sets up a MessageChannel. On port1, incoming `{ id, method, args }` messages
 * are dispatched to the fileManager and responded to with `{ id, result }` or `{ id, error }`.
 * Returns port2, which the kernel worker uses via `createFileManagerProxy()`.
 *
 * @param fileManager - A KernelFileSystem implementation (all methods are async-compatible)
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
      const result: unknown = await fn(...args);
      channel.port1.postMessage({ id, result } satisfies BridgeResponse);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      channel.port1.postMessage({ id, error: message } satisfies BridgeResponse);
    }
  };

  return channel.port2;
}

/**
 * Create a KernelFileSystem proxy backed by a MessagePort.
 *
 * Each method call sends a `{ id, method, args }` message and waits for
 * the matching `{ id, result }` or `{ id, error }` response.
 *
 * Used inside the kernel worker to replace `wrap<FileManager>(port)` from Comlink.
 *
 * @param port - MessagePort connected to a FileManager bridge
 * @returns KernelFileSystem interface backed by the port
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
