/**
 * FromProxy -- wraps a proxy-like object as a KernelFileSystem.
 *
 * Each method is wrapped in a plain arrow function to prevent Proxy traps
 * (e.g. `.apply()` / `.bind()`) from intercepting calls and causing
 * serialization failures when the bridge dispatches via `fn(...args)`.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';

/**
 * Minimal interface for an object that can be wrapped as a KernelFileSystem.
 * Matches both plain objects and RPC proxy objects.
 */
type FileSystemLike = {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>;
  exists(path: string): Promise<boolean>;
};

/**
 * Create a KernelFileSystem from a proxy-like object.
 *
 * Wraps each method in a plain arrow function, isolating the call from
 * Proxy traps that would otherwise intercept `.apply()` or `.bind()`.
 * Use this when bridging an RPC proxy through the main-thread relay path.
 *
 * For direct worker-to-worker communication, prefer `createFileSystemBridge`
 * instead -- it removes the main thread from the hot path entirely.
 *
 * @param target - An object implementing the KernelFileSystem methods
 * @returns KernelFileSystem with plain arrow-function methods
 *
 * @example
 * ```typescript
 * import { fromProxy } from '@taucad/kernels/filesystem';
 *
 * const fileSystem = fromProxy(remoteFileManager);
 * await client.connect({ fileSystem });
 * ```
 */
export function fromProxy(target: FileSystemLike): KernelFileSystem {
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
    if (encoding) {
      return target.readFile(path, encoding);
    }

    return target.readFile(path);
  }

  return {
    readFile,
    writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void> =>
      target.writeFile(path, data),
    mkdir: async (path: string, options?: { recursive?: boolean }): Promise<void> => target.mkdir(path, options),
    readdir: async (path: string): Promise<string[]> => target.readdir(path),
    unlink: async (path: string): Promise<void> => target.unlink(path),
    stat: async (path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }> => target.stat(path),
    exists: async (path: string): Promise<boolean> => target.exists(path),
  };
}
