/**
 * FileSystem MessagePort Bridge
 *
 * Creates a MessageChannel-based bridge between a filesystem implementation
 * and a consumer (kernel worker, main thread, git, etc.). The bridge uses a
 * generic `{ id, method, args }` request/response protocol over MessagePort,
 * dispatching to any method on the served object.
 *
 * Production: the bridge proxies calls from kernel worker -> file-manager worker.
 * Tests: the bridge proxies calls from kernel worker -> in-process filesystem directly.
 */

import { safeDispose } from '@taucad/utils/dispose';
import type { KernelFileSystemBase } from '#types/kernel-worker.types.js';

/**
 * Walk an arbitrarily nested value and collect every unique `ArrayBuffer`
 * that backs a typed array, plus standalone `ArrayBuffer` instances.
 * The returned list is de-duplicated so the same buffer is never
 * transferred twice (which would throw a `DataCloneError`).
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

type BridgeRequest = {
  id: number;
  method: string;
  args: unknown[];
};

/**
 * Structured error sent over the bridge. Preserves the worker-side
 * error name, stack trace, errno code, and optional metadata so the
 * main-thread consumer can reconstruct a meaningful Error.
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

/**
 * Maximum time (ms) to wait for a message port call to complete.
 */
const messagePortCallTimeoutMs = 30_000;

/**
 * Serve an object's methods over a MessagePort.
 *
 * Sets up a message handler on the given port. Incoming `{ id, method, args }`
 * messages are dispatched to the served object and responded to with
 * `{ id, result }` or `{ id, error }`. Can run in any context: main thread,
 * worker, or Node.js.
 *
 * Errors are serialized as {@link BridgeError} objects so the consumer can
 * reconstruct the original error with name, stack, errno code, and metadata.
 *
 * @param handlers - Object whose methods are served (e.g. a KernelFileSystemBase or FileManager)
 * @param port - MessagePort to listen on
 */
export function createBridgeServer<T extends Record<string, unknown>>(handlers: T, port: MessagePort): void {
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = async (event: MessageEvent<BridgeRequest>): Promise<void> => {
    const { id, method, args } = event.data;

    const function_ = handlers[method] as ((...functionArguments: unknown[]) => Promise<unknown>) | undefined;
    if (!function_) {
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
        // Last resort: send a minimal error response
        port.postMessage({
          id,
          error: { message: bridgeError.message, name: bridgeError.name },
        } satisfies BridgeResponse);
      }
    }
  };
}

/**
 * Handle returned by bridge creation functions. Provides the consumer-side
 * MessagePort and a `dispose()` method that closes the bridge and releases
 * both ports.
 */
export type BridgeHandle = {
  /** Consumer-side MessagePort for use with createBridgeProxy or client.connect(). */
  port: MessagePort;
  /** Close the bridge and release ports. */
  dispose(): void;
};

/**
 * Create a MessagePort that bridges to a filesystem implementation.
 *
 * Convenience wrapper: creates a MessageChannel, serves the object on port1
 * via `createBridgeServer`, and returns port2 for the consumer.
 *
 * @param handlers - Object whose methods are served (e.g. a KernelFileSystemBase or FileManager)
 * @returns BridgeHandle with the consumer port and a dispose function
 */
export function createBridgePort<T extends Record<string, unknown>>(handlers: T): BridgeHandle {
  const channel = new MessageChannel();
  createBridgeServer(handlers, channel.port1);
  return {
    port: channel.port2,
    dispose() {
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
 * A KernelFileSystemBase proxy backed by a MessagePort, with an explicit dispose
 * method to reject pending calls and detach the message handler.
 */
export type FileSystemProxy = KernelFileSystemBase & {
  dispose(): void;
};

/**
 * Reconstruct an Error from a {@link BridgeError} received over the bridge.
 * Preserves the original error name, stack trace, errno code, and metadata.
 */
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
 * Create a low-level RPC call/dispose pair backed by a MessagePort.
 *
 * Sends `{ id, method, args }` messages and returns promises that resolve with
 * the result or reject with a reconstructed {@link BridgeError}. Used by
 * {@link createBridgeProxy} and application-level proxies that need to call
 * arbitrary methods on a bridge-served object.
 *
 * @param port - MessagePort connected to a {@link createBridgeServer} endpoint
 * @returns Object with a `call` function for RPC invocation and a `dispose` function
 *   that rejects all pending calls and detaches the message handler
 *
 * @example
 * ```typescript
 * import { createBridgeCall, createBridgeServer } from '@taucad/kernels/filesystem';
 *
 * const channel = new MessageChannel();
 * createBridgeServer(myHandlers, channel.port1);
 *
 * const { call, dispose } = createBridgeCall(channel.port2);
 * const entries = await call('readdir', ['/']);
 * dispose();
 * ```
 */
export function createBridgeCall(port: MessagePort): {
  call: (method: string, arguments_: unknown[]) => Promise<unknown>;
  dispose: () => void;
} {
  type PendingEntry = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  let nextId = 0;
  const pending = new Map<number, PendingEntry>();

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage (implicitly calls start(); addEventListener does not)
  port.onmessage = (event: MessageEvent<BridgeResponse>): void => {
    const { id, result, error } = event.data;
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
    (port as unknown as { unref: () => void }).unref();
  }

  return {
    async call(method: string, arguments_: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`Bridge call '${method}' timed out`));
          }
        }, messagePortCallTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        const request = {
          id,
          method,
          args: arguments_,
        } satisfies BridgeRequest;
        const transferables = extractTransferables(arguments_);
        port.postMessage(request, transferables);
      });
    },
    dispose() {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- we set onmessage during setup, so we need to remove it here.
      port.onmessage = null;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        safeDispose(() => {
          entry.reject(new Error('Bridge proxy closed'));
        });
      }

      pending.clear();
      safeDispose(() => {
        port.close();
      });
    },
  };
}

/**
 * Create a generic `Proxy`-based RPC client backed by a MessagePort.
 *
 * Every property access (except `dispose`) returns a function that
 * forwards the call over the bridge as `{ id, method, args }`. This
 * eliminates the need for hand-written per-method stubs.
 *
 * @param port - MessagePort connected to a {@link createBridgeServer} endpoint
 * @returns Proxy whose method calls are forwarded over the bridge
 *
 * @example
 * ```typescript
 * import { createBridgeProxy } from '@taucad/kernels/filesystem';
 *
 * const proxy = createBridgeProxy<FileManagerProtocol>(channel.port2);
 * const entries = await proxy.readdir('/');
 * proxy.dispose();
 * ```
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic proxy type must accept any callable shape
export function createBridgeProxy<T extends Record<string, (...arguments_: any[]) => any>>(
  port: MessagePort,
): T & { dispose(): void } {
  const { call, dispose: rawDispose } = createBridgeCall(port);
  let isDisposed = false;

  const dispose = (): void => {
    isDisposed = true;
    rawDispose();
  };

  return new Proxy({} as T & { dispose(): void }, {
    get(_, method: string | symbol) {
      if (method === 'dispose') {
        return dispose;
      }

      // Guard: properties that must NOT trigger bridge calls.
      // - `then`: prevents thenable coercion (Promise.resolve(proxy) would call
      //   proxy.then(resolve, reject), sending functions over postMessage → DataCloneError)
      // - `toJSON`: prevents accidental serialization (JSON.stringify(proxy))
      // - Symbols: prevents coercion, iteration, and toString traps
      if (method === 'then' || method === 'toJSON' || typeof method === 'symbol') {
        return undefined;
      }

      if (isDisposed) {
        throw new Error(`Bridge proxy has been disposed — cannot call '${method}'`);
      }

      return async (...arguments_: unknown[]) => call(method, arguments_);
    },
  });
}

/**
 * Buffer incoming messages on a MessagePort during initialization.
 *
 * Call this immediately after receiving a port, before the server handler
 * is set up. The returned function stops buffering and replays all
 * captured messages in order, so no requests are lost during the
 * initialization window.
 *
 * Adopted from ZenFS's `catchMessages` pattern.
 *
 * @param port - MessagePort to buffer messages on
 * @returns A function that stops buffering and replays captured messages
 *
 * @example
 * ```typescript
 * const stopAndReplayMessages = catchMessages(port);
 * await initializeFileSystem();
 * createBridgeServer(handlers, port);
 * stopAndReplayMessages();
 * ```
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
