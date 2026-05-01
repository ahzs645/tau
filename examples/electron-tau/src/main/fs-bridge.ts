/**
 * Electron main-process filesystem authority seam (Phase 11, R8 seam 2,
 * R9).
 *
 * `createFsBridgeHost` plugs a {@link RuntimeFileSystemBase} onto a
 * wire-level {@link Port} (typically the `port1` half of a
 * `MessageChannelMain` whose `port2` was shipped to the renderer) and
 * exposes the {@link FsProtocol} contract. The renderer-side companion
 * is a plain `createChannelClient<FsProtocol>` — no shared bridge proxy
 * machinery, no string-keyed handler bag, no untyped wire envelopes.
 *
 * Three architectural invariants the bridge enforces:
 *
 * 1. **Authority lives in main.** All filesystem reads/writes flow
 *    through the supplied `RuntimeFileSystemBase`. A buggy renderer
 *    cannot bypass the host to touch disk because the wire only speaks
 *    {@link FsProtocol}.
 *
 * 2. **Watches are subscription-scoped.** Every renderer-side
 *    `channel.listen('watch', request)` instantiates a fresh underlying
 *    `fs.watch(...)` subscription on the host. The host's
 *    {@link AsyncIterable} is wired to the abort signal so dropping the
 *    iterator on the renderer immediately tears down the watcher
 *    upstream — no leaked watchers across renderer reload.
 *
 * 3. **Mutations broadcast `fileChanged`.** Whenever a `writeFile` or
 *    `delete` lands on the host, a single `fileChanged` notify fires on
 *    the channel so peer caches (e.g. the kernel-side
 *    `FileContentCache`) can invalidate without subscribing to every
 *    path through `listens.watch`. This mirrors the behaviour the
 *    in-runtime `createBridgeServer` already provides via its untyped
 *    `'broadcast'` channel, but lifted into the typed {@link FsProtocol}
 *    so the renderer never has to dynamically sniff event names.
 */

import type { ChannelServer, Port, WithTransferables } from '@taucad/rpc';
import { createChannelServer } from '@taucad/rpc';
import type { RuntimeFileSystemBase, RuntimeWatchEvent, RuntimeWatchRequest } from '@taucad/runtime';

import { fsProtocolSessionKey } from '#shared/fs-protocol.js';
import type { FsProtocol } from '#shared/fs-protocol.js';

/**
 * Handle returned by {@link createFsBridgeHost}.
 *
 * @public
 */
export type FsBridgeHostHandle = {
  /** Resolves once the channel is fully closed (remote ack or timeout). */
  readonly closed: Promise<void>;
  /** Send the close control message and tear down local state. Idempotent. */
  dispose(reason?: string): void;
};

/* `Uint8Array<ArrayBuffer>` is the runtime convention; the FS provider
 * may also yield `Uint8Array<SharedArrayBuffer>`-like views from a
 * shared pool. The transferable extractor only hoists buffers that
 * structurally match `ArrayBuffer`, so a SAB-backed view is silently
 * passed through by structured clone. */
const wrapBinaryWithTransferables = <T>(value: T): T | WithTransferables<T> => {
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) {
    return { value, transferables: [value.buffer] } satisfies WithTransferables<T>;
  }
  return value;
};

/**
 * Async push queue used by the `listens.watch` server-side iterator.
 * Items pushed before a `next()` call are buffered; `close()` ends the
 * stream cleanly. Mirrors the queue used by the in-runtime FS bridge so
 * the watch-stream contract is identical end-to-end.
 */
type PushQueue<T> = {
  readonly iterable: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
};

const createPushQueue = <T>(): PushQueue<T> => {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const push = (value: T): void => {
    if (closed) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      buffer.push(value);
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (buffer.length > 0) {
            const value = buffer.shift() as T;
            return { value, done: false };
          }
          if (closed) {
            return { value: undefined as unknown as T, done: true };
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return: async (): Promise<IteratorResult<T>> => {
          close();
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };

  return { iterable, push, close };
};

/**
 * Bind an {@link FsProtocol} server to a transport port, backed by the
 * supplied {@link RuntimeFileSystemBase}.
 *
 * @param port - Wire-level transport (e.g. the result of
 *   `adaptElectronMessagePort(channel.port1)`).
 * @param fileSystem - Authoritative filesystem provider that owns the
 *   real disk surface in the host process.
 * @returns A {@link FsBridgeHostHandle}.
 *
 * @public
 */
export function createFsBridgeHost(port: Port<unknown>, fileSystem: RuntimeFileSystemBase): FsBridgeHostHandle {
  /* Track every active watch subscription so a host-side dispose tears
   * them all down even if the channel close handshake races a
   * still-streaming watcher. */
  const activeWatches = new Set<() => void>();

  /* Lazy `notify` reference so the `call` handler can broadcast
   * `fileChanged` mutations through the same channel server we are in
   * the middle of constructing. The typed `notify<N>(name, args)`
   * surface arrives on the handle returned below. The slot is wrapped
   * in a single-property object so the binding itself is `const` (its
   * `current` field is the late-bound function reference). */
  const notifyReference: {
    current: ((name: 'fileChanged', arguments_: FsProtocol['notifies']['fileChanged']['args']) => void) | undefined;
  } = { current: undefined };

  /* Typed dispatch map: each handler is bound to a single call name so
   * its argument and return types are exactly the protocol-declared
   * shapes. The outer `call(name, args)` body is a single map lookup
   * with a generic narrow — TypeScript can derive `CallResult<P, N>`
   * from the indexed lookup type without any `as never` escape hatch.
   *
   * `WithTransferables<T>` is a permitted return covariant on `T`, so
   * the binary `readFile` branch can hoist the underlying `ArrayBuffer`
   * onto the wire's transfer list without losing type safety on the
   * non-binary branches. */
  type CallHandlers = {
    readonly [N in keyof FsProtocol['calls']]: (
      arguments_: FsProtocol['calls'][N]['args'],
    ) => Promise<FsProtocol['calls'][N]['result'] | WithTransferables<FsProtocol['calls'][N]['result']>>;
  };

  const callHandlers: CallHandlers = {
    readFile: async (request) => {
      if (request.encoding === 'utf8') {
        return fileSystem.readFile(request.path, 'utf8');
      }
      const bytes = await fileSystem.readFile(request.path);
      return wrapBinaryWithTransferables(bytes);
    },
    writeFile: async (request) => {
      await fileSystem.writeFile(request.path, request.data);
      notifyReference.current?.('fileChanged', { path: request.path, kind: 'updated' });
    },
    readDir: async (request) => fileSystem.readdir(request.path),
    stat: async (request) => fileSystem.stat(request.path),
    exists: async (request) => fileSystem.exists(request.path),
    delete: async (request) => {
      await fileSystem.unlink(request.path);
      notifyReference.current?.('fileChanged', { path: request.path, kind: 'deleted' });
    },
  };

  const impl: ChannelServer<FsProtocol> = {
    async call(_context, name, arguments_) {
      const handler = callHandlers[name];
      return handler(arguments_);
    },
    // oxlint-disable-next-line max-params -- ChannelServer.listen impl signature is fixed at 4 params (context, eventName, args, signal)
    listen(_context, _event, arguments_, signal) {
      /* `_event` is the listens-name union — narrowed structurally to
       * `'watch'` by the `FsProtocol` declaration. There are no other
       * listens, so an exhaustiveness branch here would be dead code. */
      if (typeof fileSystem.watch !== 'function') {
        throw new TypeError('FileSystem does not implement watch()');
      }
      return subscribeWatch({
        fileSystem,
        request: arguments_ as RuntimeWatchRequest,
        signal,
        activeWatches,
      });
    },
  };

  const handle = createChannelServer<FsProtocol>({
    port,
    sessionKey: fsProtocolSessionKey,
    impl,
  });

  notifyReference.current = (name, arguments_) => {
    handle.notify(name, arguments_);
  };

  return {
    closed: handle.closed,
    dispose(reason?: string): void {
      for (const teardown of activeWatches) {
        teardown();
      }
      activeWatches.clear();
      handle.dispose(reason);
    },
  };
}

type SubscribeWatchInput = {
  readonly fileSystem: RuntimeFileSystemBase;
  readonly request: RuntimeWatchRequest;
  readonly signal: AbortSignal;
  readonly activeWatches: Set<() => void>;
};

const subscribeWatch = ({
  fileSystem,
  request,
  signal,
  activeWatches,
}: SubscribeWatchInput): AsyncIterable<RuntimeWatchEvent> => {
  const queue = createPushQueue<RuntimeWatchEvent>();
  /* `watch` is gated by a runtime `typeof` check on the caller; reach
   * for a non-null assertion here rather than the wide `as NonNullable`
   * cast (lint rule prefers `!` for null/undefined narrowing only). */
  const watchFunction = fileSystem.watch!;
  const unsubscribe = watchFunction.call(fileSystem, request, (event: RuntimeWatchEvent) => {
    queue.push(event);
  });

  const teardown = (): void => {
    unsubscribe();
    queue.close();
    activeWatches.delete(teardown);
  };
  activeWatches.add(teardown);

  if (signal.aborted) {
    teardown();
  } else {
    signal.addEventListener('abort', teardown, { once: true });
  }

  return queue.iterable;
};
