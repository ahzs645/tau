/**
 * High-level filesystem bridge wrappers.
 *
 * exposeFileSystem -- worker-side: listens for incoming bridge ports and serves a filesystem.
 * createFileSystemBridge -- main-thread side: creates a MessageChannel and transfers a port to a worker.
 *
 * Together they form an expose/wrap pair for the KernelFileSystem MessagePort bridge protocol.
 */

import type { KernelFileSystem } from '#types/kernel-worker.types.js';
import { createFileSystemServer } from '#framework/kernel-filesystem-bridge.js';

/** Default message type used by exposeFileSystem and createFileSystemBridge. */
const defaultBridgeMessageType = 'kernelBridge';

/**
 * Options for filesystem bridge wrappers.
 */
export type FileSystemBridgeOptions = {
  /** Custom message type for the bridge handshake (default: 'kernelBridge'). */
  messageType?: string;
};

/**
 * Expose a KernelFileSystem to incoming kernel bridge connections.
 *
 * Listens on the worker's global scope for messages with the specified type
 * and a transferred MessagePort. For each received port, sets up a
 * `createFileSystemServer` to serve the filesystem over that port.
 *
 * Returns a cleanup function that removes the listener.
 *
 * @param fileSystem - KernelFileSystem implementation to serve
 * @param options - Optional configuration
 * @returns Cleanup function that removes the message listener
 *
 * @example
 * ```typescript
 * import { exposeFileSystem, fromZenFS } from '@taucad/kernels/filesystem';
 * import { fs } from '@zenfs/core';
 *
 * exposeFileSystem(fromZenFS(fs));
 * ```
 */
export function exposeFileSystem(fileSystem: KernelFileSystem, options?: FileSystemBridgeOptions): () => void {
  const messageType = options?.messageType ?? defaultBridgeMessageType;

  const handler = (event: MessageEvent): void => {
    if (event.data?.type === messageType && event.data.port instanceof MessagePort) {
      createFileSystemServer(fileSystem, event.data.port as MessagePort);
    }
  };

  self.addEventListener('message', handler);
  return () => {
    self.removeEventListener('message', handler);
  };
}

/**
 * Create a filesystem bridge to a worker exposing a KernelFileSystem.
 *
 * Creates a MessageChannel, transfers port1 to the target worker via
 * postMessage, and returns port2 for use with `client.connect({ port })`.
 *
 * The main thread is only involved at setup time -- after the bridge is
 * established, the kernel worker and target worker communicate directly.
 *
 * @param worker - Target worker (must have `exposeFileSystem` set up)
 * @param options - Optional configuration
 * @returns MessagePort to pass to `client.connect({ port })`
 *
 * @example
 * ```typescript
 * import { createFileSystemBridge } from '@taucad/kernels/filesystem';
 *
 * const port = createFileSystemBridge(fmWorker);
 * await client.connect({ port });
 * ```
 */
export function createFileSystemBridge(worker: Worker, options?: FileSystemBridgeOptions): MessagePort {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const channel = new MessageChannel();
  worker.postMessage({ type: messageType, port: channel.port1 }, [channel.port1]);
  return channel.port2;
}
