/**
 * FileSystem MessagePort Bridge
 *
 * Creates a MessageChannel-based bridge between a filesystem implementation
 * and a consumer (runtime worker, main thread, git, etc.). The bridge uses a
 * generic `{ id, method, args }` request/response protocol over MessagePort,
 * dispatching to any method on the served object.
 *
 * Wire schema — all messages on a port are one of four discriminated types:
 * - Request (no `type` field): `{ id, method, args }` — client → server
 * - Response (no `type` field): `{ id, result?, error? }` — server → client
 * - Event: `{ type: 'event', event, data }` — server → client (push, no response)
 * - Control: `{ type: 'disconnect' }` — bidirectional
 */

import { safeDispose } from '@taucad/utils/dispose';
import type { RuntimeFileSystemBase, RuntimeWatchRequest, RuntimeWatchEvent } from '#types/runtime-kernel.types.js';
import type { StringKeyedObject } from '#types/bridge.types.js';
import { messagePortCallTimeoutMs } from '#framework/runtime-framework.constants.js';

/**
 * Walk an arbitrarily nested value and collect every unique `ArrayBuffer`
 * that backs a typed array, plus standalone `ArrayBuffer` instances.
 * The returned list is de-duplicated so the same buffer is never
 * transferred twice (which would throw a `DataCloneError`).
 *
 * @param value - Arbitrarily nested value to scan for ArrayBuffers.
 * @returns De-duplicated list of transferable ArrayBuffers.
 * @public
 */
export function extractTransferables(value: unknown): Transferable[] {
  const seen = new Set<ArrayBuffer>();
  function walk(v: unknown): void {
    if (v instanceof ArrayBuffer) {
      seen.add(v);
    } else if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) {
      seen.add(v.buffer);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        walk(item);
      }
    } else if (v !== null && typeof v === 'object') {
      for (const property of Object.values(v)) {
        walk(property);
      }
    }
  }

  walk(value);
  return [...seen];
}

// --- Wire schema types ---

type BridgeRequest = {
  id: number;
  method: string;
  args: unknown[];
};

/**
 * Serializable error representation transmitted over the bridge wire protocol.
 * @public
 */
export type BridgeError = {
  message: string;
  name: string;
  stack?: string;
  code?: string;
  metadata?: Record<string, unknown>;
};

type BridgeResponse = {
  id: number;
  result?: unknown;
  error?: BridgeError;
};

type BridgeEvent = {
  type: 'event';
  event: string;
  data: unknown;
};

type BridgeControl =
  | { type: 'disconnect' }
  | { type: 'watch'; watchId: string; request: RuntimeWatchRequest }
  | { type: 'unwatch'; watchId: string };

type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent | BridgeControl;

// --- Server ---

/**
 * Handle returned by {@link createBridgeServer}, providing an event emitter for server-to-client push messages.
 * @public
 */
export type BridgeServerHandle = {
  emit: (event: string, data: unknown) => void;
};

/**
 * Serve an object's methods over a MessagePort.
 *
 * Returns an `emit` function for pushing events to the client.
 * The server handles three message types:
 * - No `type` field → request/response (existing behavior)
 * - `type: 'event'` → ignored server-side (events flow server→client only)
 * - `type: 'disconnect'` → calls optional onDisconnect callback
 *
 * @param handlers - Object whose methods are exposed over the port.
 * @param port - MessagePort to serve on.
 * @param options - Optional callbacks for disconnect, watch, and unwatch.
 * @returns Handle with emit function for server-to-client push messages.
 * @public
 */
export function createBridgeServer<T extends StringKeyedObject>(
  handlers: T,
  port: MessagePort,
  options?: {
    onDisconnect?: () => void;
    onWatch?: (watchId: string, request: RuntimeWatchRequest) => void;
    onUnwatch?: (watchId: string) => void;
  },
): BridgeServerHandle {
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = async (event: MessageEvent<BridgeMessage>): Promise<void> => {
    const { data } = event;

    if ('type' in data) {
      switch (data.type) {
        case 'disconnect': {
          options?.onDisconnect?.();
          break;
        }
        case 'watch': {
          options?.onWatch?.(data.watchId, data.request);
          break;
        }
        case 'unwatch': {
          options?.onUnwatch?.(data.watchId);
          break;
        }
      }
      return;
    }

    const { id, method, args } = data as BridgeRequest;
    console.debug(`[BridgeServer] request: ${method}(${JSON.stringify(args).slice(0, 100)})`);

    const function_ = (handlers as Record<string, unknown>)[method] as
      | ((...functionArguments: unknown[]) => Promise<unknown>)
      | undefined;
    if (!function_) {
      console.debug(`[BridgeServer] method '${method}' not found on handlers`);
      port.postMessage({
        id,
        error: { message: `Unknown method: ${method}`, name: 'Error' },
      } satisfies BridgeResponse);
      return;
    }

    try {
      const result: unknown = await function_.call(handlers, ...args);
      const response = { id, result } satisfies BridgeResponse;
      const transferables = extractTransferables(result);
      try {
        port.postMessage(response, transferables);
      } catch (postError) {
        console.error(`[BridgeServer] postMessage failed for method '${method}':`, postError);
        port.postMessage({
          id,
          error: {
            message: `Return value for '${method}' could not be cloned`,
            name: 'TypeError',
          },
        } satisfies BridgeResponse);
      }
    } catch (error) {
      const bridgeError: BridgeError = {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.constructor.name : 'Error',
        stack: error instanceof Error ? error.stack : undefined,
        code: (error as NodeJS.ErrnoException).code,
        metadata: (error as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined,
      };
      try {
        port.postMessage({ id, error: bridgeError } satisfies BridgeResponse);
      } catch {
        port.postMessage({
          id,
          error: { message: bridgeError.message, name: bridgeError.name },
        } satisfies BridgeResponse);
      }
    }
  };

  return {
    emit(eventName: string, eventData: unknown): void {
      const message: BridgeEvent = { type: 'event', event: eventName, data: eventData };
      try {
        port.postMessage(message);
      } catch {
        // Port may be closed
      }
    },
  };
}

// --- Client ---

/**
 * Handle returned by {@link createBridgePort}, providing the client-side MessagePort and a dispose function.
 * @public
 */
export type BridgeHandle = {
  port: MessagePort;
  dispose(): void;
};

/**
 * Create a MessagePort that bridges to a filesystem implementation.
 *
 * @param handlers - Object whose methods are served over the bridge.
 * @returns Handle with port and dispose function.
 * @public
 */
export function createBridgePort<T extends Record<string, unknown>>(handlers: T): BridgeHandle {
  const channel = new MessageChannel();
  createBridgeServer(handlers, channel.port1);
  return {
    port: channel.port2,
    dispose() {
      safeDispose(() => {
        channel.port2.postMessage({ type: 'disconnect' });
      });
      safeDispose(() => {
        channel.port1.close();
      });
      safeDispose(() => {
        channel.port2.close();
      });
    },
  };
}

/**
 * Proxy-based filesystem client backed by a MessagePort bridge, with watch subscription and disposal support.
 * @public
 */
export type FileSystemProxy = RuntimeFileSystemBase & {
  watch(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void): () => void;
  dispose(): void;
};

function reconstructError(bridgeError: BridgeError): Error & {
  code?: string;
  metadata?: Record<string, unknown>;
} {
  const error = Object.assign(new Error(bridgeError.message), {
    name: bridgeError.name,
    code: bridgeError.code,
    metadata: bridgeError.metadata,
  });

  if (bridgeError.stack) {
    error.stack = bridgeError.stack;
  }

  return error;
}

/**
 * Create a low-level RPC call/listen/dispose triple backed by a MessagePort.
 *
 * Handles three message types:
 * - No `type` field → response resolution (existing)
 * - `type: 'event'` → dispatch to registered listen() handlers
 * - `type: 'disconnect'` → dispose the call instance
 *
 * @param port - MessagePort for bridge communication.
 * @returns Object with call, listen, watch, and dispose methods.
 * @public
 */
export function createBridgeCall(port: MessagePort): {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  listen: (event: string, handler: (data: unknown) => void) => () => void;
  watch: (request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void) => () => void;
  dispose: () => void;
} {
  type PendingEntry = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  let nextId = 0;
  const pending = new Map<number, PendingEntry>();
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = (event: MessageEvent<BridgeMessage>): void => {
    const { data } = event;

    if ('type' in data) {
      if (data.type === 'event') {
        const eventMessage = data;
        const handlers = eventListeners.get(eventMessage.event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(eventMessage.data);
            } catch (error) {
              console.error(`[BridgeCall] Event listener error for '${eventMessage.event}':`, error);
            }
          }
        }
        return;
      }

      if (data.type === 'disconnect') {
        dispose();
        return;
      }

      return;
    }

    const { id, result, error } = data as BridgeResponse;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }

    pending.delete(id);
    clearTimeout(entry.timer);
    if (error === undefined) {
      entry.resolve(result);
    } else {
      entry.reject(reconstructError(error));
    }
  };

  if ('unref' in port && typeof port.unref === 'function') {
    (port.unref as () => void)();
  }

  function dispose(): void {
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- we set onmessage during setup, so we need to remove it here.
    port.onmessage = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      safeDispose(() => {
        entry.reject(new Error('Bridge proxy closed'));
      });
    }
    pending.clear();
    eventListeners.clear();
    safeDispose(() => {
      port.close();
    });
  }

  let watchIdCounter = 0;

  return {
    async call(method: string, args: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`Bridge call '${method}' timed out`));
          }
        }, messagePortCallTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        const request = { id, method, args } satisfies BridgeRequest;
        const transferables = extractTransferables(args);
        port.postMessage(request, transferables);
      });
    },

    listen(eventName: string, handler: (data: unknown) => void): () => void {
      let handlers = eventListeners.get(eventName);
      if (!handlers) {
        handlers = new Set();
        eventListeners.set(eventName, handlers);
      }
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventListeners.delete(eventName);
        }
      };
    },

    watch(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void): () => void {
      const watchId = `w_${watchIdCounter++}`;
      const eventKey = `watch:${watchId}`;

      let handlers = eventListeners.get(eventKey);
      if (!handlers) {
        handlers = new Set();
        eventListeners.set(eventKey, handlers);
      }
      handlers.add(handler as (data: unknown) => void);

      port.postMessage({ type: 'watch', watchId, request } satisfies BridgeControl);

      let unsubscribed = false;
      return () => {
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;
        handlers.delete(handler as (data: unknown) => void);
        if (handlers.size === 0) {
          eventListeners.delete(eventKey);
        }
        try {
          port.postMessage({ type: 'unwatch', watchId } satisfies BridgeControl);
        } catch {
          // Port may already be closed
        }
      };
    },

    dispose,
  };
}

/**
 * Create a generic `Proxy`-based RPC client backed by a MessagePort.
 *
 * Every property access (except `dispose` and `listen`) returns a function that
 * forwards the call over the bridge as `{ id, method, args }`.
 *
 * @param port - MessagePort for bridge communication.
 * @returns Proxy that forwards method calls over the bridge.
 */
/** @public */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic proxy type must accept any callable shape
export function createBridgeProxy<T extends Record<string, (...args: any[]) => any>>(
  port: MessagePort,
): T & {
  dispose(): void;
  listen(event: string, handler: (data: unknown) => void): () => void;
  watch(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void): () => void;
} {
  const { call, listen, watch, dispose: rawDispose } = createBridgeCall(port);
  let isDisposed = false;

  const dispose = (): void => {
    isDisposed = true;
    port.postMessage({ type: 'disconnect' } satisfies BridgeControl);
    rawDispose();
  };

  return new Proxy(
    {} as T & {
      dispose(): void;
      listen(event: string, handler: (data: unknown) => void): () => void;
      watch(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void): () => void;
    },
    {
      get(_, method: string | symbol) {
        if (method === 'dispose') {
          return dispose;
        }
        if (method === 'listen') {
          return listen;
        }
        if (method === 'watch') {
          return watch;
        }

        if (method === 'then' || method === 'toJSON' || typeof method === 'symbol') {
          return undefined;
        }

        if (isDisposed) {
          throw new Error(`Bridge proxy has been disposed — cannot call '${method}'`);
        }

        return async (...args: unknown[]) => call(method, args);
      },
    },
  );
}

/**
 * Buffer incoming messages on a MessagePort during initialization.
 *
 * @param port - MessagePort to buffer messages from.
 * @returns Flush function that replays buffered messages and removes the buffer.
 * @public
 */
export function catchMessages(port: MessagePort): () => void {
  const buffered: MessageEvent[] = [];
  const handler = (event: MessageEvent): void => {
    buffered.push(event);
  };

  port.addEventListener('message', handler);
  port.start();

  return () => {
    port.removeEventListener('message', handler);
    for (const event of buffered) {
      port.dispatchEvent(new MessageEvent('message', { data: event.data as unknown }));
    }
  };
}
