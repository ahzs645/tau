/**
 * High-level filesystem bridge wrappers.
 *
 * exposeFileSystem -- worker-side: listens for incoming bridge ports and serves a filesystem.
 * createFileSystemBridge -- main-thread side: creates a MessageChannel and transfers a port to a worker.
 *
 * Together they form an expose/wrap pair for the KernelFileSystem MessagePort bridge protocol.
 */

import { safeDispose } from '@taucad/utils/dispose';
import type { StringKeyedObject } from '#types/bridge.types.js';
import type { BridgeHandle, BridgeServerHandle } from '#framework/kernel-filesystem-bridge.js';
import type { KernelWatchRequest, KernelWatchEvent } from '#types/kernel-worker.types.js';
import { createBridgeServer, catchMessages } from '#framework/kernel-filesystem-bridge.js';

const defaultBridgeMessageType = 'connect';

/** Options for configuring the filesystem bridge message type. */
export type FileSystemBridgeOptions = {
  messageType?: string;
};

/**
 * Optional watch handler for bridge servers.
 * When provided, enables watch/unwatch control messages over the bridge.
 */
export type BridgeWatchHandler = {
  watch(request: KernelWatchRequest, handler: (event: KernelWatchEvent) => void, ownerId?: string): () => void;
  cleanupWatches(ownerId: string): void;
};

/** Handle returned by {@link exposeFileSystem} for managing bridge connections and cleanup. */
export type ExposeFileSystemHandle = {
  cleanup: () => void;
  activePorts: Set<MessagePort>;
  serverHandles: Map<MessagePort, BridgeServerHandle>;
};

/**
 * Expose a filesystem to incoming bridge connections.
 *
 * Listens on the worker's global scope for messages with the specified type
 * and a transferred MessagePort. For each received port, buffers any incoming
 * messages via `catchMessages`, sets up a `createBridgeServer`, then replays
 * the buffered messages.
 *
 * Returns a handle with:
 * - `cleanup`: removes the listener
 * - `activePorts`: set of currently connected ports
 * - `serverHandles`: map from port to BridgeServerHandle (with emit())
 *
 * @param handlers - Filesystem handler methods to expose
 * @param options - Optional message type and watch handler
 * @returns Handle with cleanup, activePorts, and serverHandles
 */
export function exposeFileSystem<T extends StringKeyedObject>(
  handlers: T,
  options?: FileSystemBridgeOptions & { watchHandler?: BridgeWatchHandler },
): ExposeFileSystemHandle {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const activePorts = new Set<MessagePort>();
  const serverHandles = new Map<MessagePort, BridgeServerHandle>();
  const portWatches = new Map<MessagePort, Map<string, () => void>>();

  const handler = (event: MessageEvent): void => {
    if (event.data?.type === messageType && event.data.port instanceof MessagePort) {
      console.debug(`[exposeFileSystem] connect received, setting up bridge server`);
      const port = event.data.port as MessagePort;
      const stopAndReplayMessages = catchMessages(port);
      const portId = `port_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      activePorts.add(port);
      portWatches.set(port, new Map());

      const serverHandle = createBridgeServer(handlers, port, {
        onDisconnect() {
          const watches = portWatches.get(port);
          if (watches) {
            for (const unsubscribe of watches.values()) {
              unsubscribe();
            }
            portWatches.delete(port);
          }
          options?.watchHandler?.cleanupWatches(portId);
          activePorts.delete(port);
          serverHandles.delete(port);
          safeDispose(() => {
            port.close();
          });
        },
        onWatch(watchId: string, request: KernelWatchRequest) {
          if (!options?.watchHandler) {
            return;
          }
          const unsubscribe = options.watchHandler.watch(
            request,
            (watchEvent: KernelWatchEvent) => {
              serverHandle.emit(`watch:${watchId}`, watchEvent);
            },
            portId,
          );
          portWatches.get(port)?.set(watchId, unsubscribe);
        },
        onUnwatch(watchId: string) {
          const watches = portWatches.get(port);
          const unsubscribe = watches?.get(watchId);
          if (unsubscribe) {
            unsubscribe();
            watches?.delete(watchId);
          }
        },
      });
      serverHandles.set(port, serverHandle);

      stopAndReplayMessages();
    }
  };

  // Use addEventListener (not self.onmessage) so multiple listeners can coexist
  // on the DedicatedWorkerGlobalScope. Unlike MessagePort, the worker global
  // scope does not require onmessage for implicit start() — addEventListener
  // works identically. Using onmessage would be overwritten by other code
  // (e.g. Vite HMR client) and silently break bridge connections.
  self.addEventListener('message', handler);

  return {
    cleanup() {
      self.removeEventListener('message', handler);
      for (const port of activePorts) {
        safeDispose(() => {
          port.close();
        });
      }
      activePorts.clear();
      serverHandles.clear();
    },
    activePorts,
    serverHandles,
  };
}

/**
 * Create a filesystem bridge to a worker.
 *
 * @param worker - Target worker to receive the bridge port
 * @param options - Optional message type configuration
 * @returns Bridge handle with port and dispose
 */
export function createFileSystemBridge(worker: Worker, options?: FileSystemBridgeOptions): BridgeHandle {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const channel = new MessageChannel();
  worker.postMessage({ type: messageType, port: channel.port1 }, [channel.port1]);
  return {
    port: channel.port2,
    dispose() {
      safeDispose(() => {
        channel.port2.close();
      });
    },
  };
}
