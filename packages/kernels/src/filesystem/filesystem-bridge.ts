/**
 * High-level filesystem bridge wrappers.
 *
 * exposeFileSystem -- worker-side: listens for incoming bridge ports and serves a filesystem.
 * createFileSystemBridge -- main-thread side: creates a MessageChannel and transfers a port to a worker.
 *
 * Together they form an expose/wrap pair for the KernelFileSystem MessagePort bridge protocol.
 */

import type { BridgeHandle } from '#framework/kernel-filesystem-bridge.js';
import { createBridgeServer, catchMessages } from '#framework/kernel-filesystem-bridge.js';

/** Default message type used by exposeFileSystem and createFileSystemBridge. */
const defaultBridgeMessageType = 'connect';

/**
 * Options for filesystem bridge wrappers.
 */
export type FileSystemBridgeOptions = {
  /** Custom message type for the bridge handshake (default: 'connect'). */
  messageType?: string;
};

/**
 * Expose a filesystem to incoming bridge connections.
 *
 * Listens on the worker's global scope for messages with the specified type
 * and a transferred MessagePort. For each received port, buffers any incoming
 * messages via `catchMessages`, sets up a `createBridgeServer`, then replays
 * the buffered messages. This ensures no messages are lost if the caller
 * starts sending before the server is fully wired.
 *
 * Returns a cleanup function that removes the listener.
 *
 * @param handlers - Object whose methods are served over each incoming port
 * @param options - Optional configuration
 * @returns Cleanup function that removes the message listener
 *
 * @example
 * ```typescript
 * import { exposeFileSystem } from '@taucad/kernels/filesystem';
 * import { fileManager } from './file-manager.js';
 *
 * exposeFileSystem(fileManager);
 * ```
 */
export function exposeFileSystem<T extends Record<string, unknown>>(
  handlers: T,
  options?: FileSystemBridgeOptions,
): () => void {
  const messageType = options?.messageType ?? defaultBridgeMessageType;

  const handler = (event: MessageEvent): void => {
    if (event.data?.type === messageType && event.data.port instanceof MessagePort) {
      const port = event.data.port as MessagePort;
      const stopAndReplayMessages = catchMessages(port);
      createBridgeServer(handlers, port);
      stopAndReplayMessages();
    }
  };

  self.addEventListener('message', handler);
  return () => {
    self.removeEventListener('message', handler);
  };
}

/**
 * Create a filesystem bridge to a worker.
 *
 * Creates a MessageChannel, transfers port1 to the target worker via
 * postMessage, and returns port2 for use with `client.connect({ port })`.
 *
 * The main thread is only involved at setup time -- after the bridge is
 * established, the kernel worker and target worker communicate directly.
 *
 * @param worker - Target worker (must have `exposeFileSystem` set up)
 * @param options - Optional configuration
 * @returns BridgeHandle with the consumer port and a dispose function
 *
 * @example
 * ```typescript
 * import { createFileSystemBridge } from '@taucad/kernels/filesystem';
 *
 * const { port, dispose } = createFileSystemBridge(fmWorker);
 * await client.connect({ port });
 * // later...
 * dispose();
 * ```
 */
export function createFileSystemBridge(worker: Worker, options?: FileSystemBridgeOptions): BridgeHandle {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const channel = new MessageChannel();
  worker.postMessage({ type: messageType, port: channel.port1 }, [channel.port1]);
  return {
    port: channel.port2,
    dispose() {
      channel.port2.close();
    },
  };
}
