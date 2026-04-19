/**
 * High-level filesystem bridge wrappers.
 *
 * exposeFileSystem -- worker-side: listens for incoming bridge ports and serves a filesystem.
 * createFileSystemBridge -- main-thread side: creates a MessageChannel and transfers a port to a worker.
 *
 * Together they form an expose/wrap pair for the RuntimeFileSystem MessagePort bridge protocol.
 */

import { safeDispose } from '@taucad/utils/dispose';
import type { ChangeEvent } from '@taucad/types';
import type { StringKeyedObject } from '#types/bridge.types.js';
import type { BridgeHandle, BridgeServerHandle } from '#framework/runtime-filesystem-bridge.js';
import type { RuntimeWatchRequest, RuntimeWatchEvent } from '#types/runtime-kernel.types.js';
import { createBridgeServer, catchMessages } from '#framework/runtime-filesystem-bridge.js';
import { workerReadyMessageType } from '#framework/runtime-framework.constants.js';

const defaultBridgeMessageType = 'connect';
const defaultUiCoalescingWindowMs = 500;

/**
 * Minimal interface for an event coalescer that batches ChangeEvents
 * before delivering them. Matches the push/flush/dispose API surface
 * of `EventCoalescer` from `@taucad/filesystem`.
 * @public
 */
export type ChangeEventCoalescer = {
  push(event: ChangeEvent): void;
  flush(): void;
  dispose(): void;
};

/**
 * Factory that creates a {@link ChangeEventCoalescer}.
 *
 * Called by {@link exposeFileSystem} with the delivery callback (broadcasts
 * to all connected bridge ports) and the configured coalescing window.
 * @public
 */
export type CoalescerFactory = (deliver: (events: ChangeEvent[]) => void, windowMs: number) => ChangeEventCoalescer;

/**
 * Minimal interface for a throttled worker that delivers events in chunks.
 * Matches the push/flush/dispose API surface of `ThrottledWorker` from
 * `@taucad/filesystem`.
 * @public
 */
export type ThrottledEventWorker = {
  push(items: ChangeEvent[]): void;
  flush(): void;
  dispose(): void;
};

/**
 * Factory that creates a {@link ThrottledEventWorker}.
 *
 * Called by {@link exposeFileSystem} with a handler that delivers chunks
 * to all connected bridge ports. The factory receives the handler and
 * should return a throttled worker wrapping it.
 * @public
 */
export type ThrottledWorkerFactory = (handler: (chunk: ChangeEvent[]) => void) => ThrottledEventWorker;

/**
 * Options for configuring the filesystem bridge message type.
 * @public
 */
export type FileSystemBridgeOptions = {
  messageType?: string;
  /** Coalescing window for UI-bound fileChanged events (default: 500ms). */
  uiCoalescingWindowMs?: number;
  /**
   * Factory for creating a change event coalescer. When provided, events
   * from `changeEventBus` are batched before broadcasting to bridge clients.
   * When omitted, events pass through without batching.
   */
  createCoalescer?: CoalescerFactory;
  /**
   * Factory for creating a throttled event worker. When provided alongside
   * `createCoalescer`, coalesced batches flow through the throttled worker
   * for chunked delivery to bridge clients.
   */
  createThrottledWorker?: ThrottledWorkerFactory;
};

/**
 * Optional watch handler for bridge servers.
 * When provided, enables watch/unwatch control messages over the bridge.
 * @public
 */
export type BridgeWatchHandler = {
  watch(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void, ownerId?: string): () => void;
  cleanupWatches(ownerId: string): void;
};

/**
 * Minimal event bus interface for broadcasting file change events
 * to all connected bridge clients via `server.emit('fileChanged', event)`.
 * @public
 */
export type BridgeChangeEventBus = {
  subscribe(handler: (event: unknown) => void): () => void;
};

/**
 * Handle returned by {@link exposeFileSystem} for managing bridge connections and cleanup.
 * @public
 */
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
 * @public
 */
export function exposeFileSystem<T extends StringKeyedObject>(
  handlers: T,
  options?: FileSystemBridgeOptions & { watchHandler?: BridgeWatchHandler; changeEventBus?: BridgeChangeEventBus },
): ExposeFileSystemHandle {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const activePorts = new Set<MessagePort>();
  const serverHandles = new Map<MessagePort, BridgeServerHandle>();
  const portWatches = new Map<MessagePort, Map<string, () => void>>();

  const deliverToHandles = (events: ChangeEvent[]): void => {
    for (const event of events) {
      for (const handle of serverHandles.values()) {
        handle.emit('fileChanged', event);
      }
    }
  };

  let throttledWorker: ThrottledEventWorker | undefined;
  if (options?.createThrottledWorker) {
    throttledWorker = options.createThrottledWorker(deliverToHandles);
  }

  const deliverFromCoalescer = throttledWorker
    ? (events: ChangeEvent[]): void => {
        throttledWorker.push(events);
      }
    : deliverToHandles;

  let coalescer: ChangeEventCoalescer | undefined;
  if (options?.createCoalescer) {
    coalescer = options.createCoalescer(
      deliverFromCoalescer,
      options.uiCoalescingWindowMs ?? defaultUiCoalescingWindowMs,
    );
  }

  const unsubscribeEventBus = options?.changeEventBus?.subscribe((event) => {
    if (coalescer) {
      coalescer.push(event as ChangeEvent);
    } else {
      deliverToHandles([event as ChangeEvent]);
    }
  });

  const handler = (event: MessageEvent): void => {
    if (event.data?.type === messageType && event.data.port instanceof MessagePort) {
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
        onWatch(watchId: string, request: RuntimeWatchRequest) {
          if (!options?.watchHandler) {
            return;
          }
          const unsubscribe = options.watchHandler.watch(
            request,
            (watchEvent: RuntimeWatchEvent) => {
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
      coalescer?.dispose();
      throttledWorker?.dispose();
      unsubscribeEventBus?.();
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
 * Wait for a worker to signal that its initialization is complete.
 *
 * Workers post `{ type: workerReadyMessageType }` after `exposeFileSystem`
 * has registered its listener. Callers should await this before sending
 * bridge `connect` messages to avoid the race where the message is dropped.
 *
 * @param worker - Worker to wait for
 * @param signal - Optional AbortSignal to cancel the wait
 * @returns Resolves when the worker posts the ready message
 * @public
 */
export async function waitForWorkerReady(worker: Worker | EventTarget, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (event: Event): void => {
      if ((event as MessageEvent).data?.type === workerReadyMessageType) {
        cleanup();
        resolve();
      }
    };

    const toError = (reason: unknown): Error =>
      reason instanceof Error ? reason : new Error('The operation was aborted.');

    const onAbort = (): void => {
      cleanup();
      reject(toError(signal?.reason));
    };

    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      reject(toError(signal.reason));
      return;
    }

    worker.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a filesystem bridge to a worker.
 *
 * @param worker - Target worker to receive the bridge port
 * @param options - Optional message type configuration
 * @returns Bridge handle with port and dispose
 * @public
 */
export function createFileSystemBridge(worker: Worker, options?: FileSystemBridgeOptions): BridgeHandle {
  const messageType = options?.messageType ?? defaultBridgeMessageType;
  const channel = new MessageChannel();
  worker.postMessage({ type: messageType, port: channel.port1 }, [channel.port1]);
  return {
    port: channel.port2,
    dispose() {
      safeDispose(() => {
        channel.port2.postMessage({ type: 'disconnect' });
      });
      safeDispose(() => {
        channel.port2.close();
      });
    },
  };
}
