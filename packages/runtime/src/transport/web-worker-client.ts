/**
 * Web-worker transport — client factory.
 *
 * Owns the consumer-facing client handle, the `Worker` constructor
 * lookup, the SAB pool allocator, the FS bridge plumbing, and the
 * single `new URL('../worker/web.js', import.meta.url)` literal that
 * tells the bundler to emit the bundled worker entry chunk.
 *
 * Per `docs/research/runtime-transport-authoring-simplification.md` (R1):
 * the chunk-emit literal lives **here**, in a file the worker entry
 * never reaches. The host file (`web-worker-host.ts`) is bundled into
 * the worker entry chunk and must remain free of `new URL` literals
 * so Rolldown's chunk planner has no static path back to the
 * chunk-emitter.
 *
 * @public
 */

import { createChannelClient } from '@taucad/rpc';
import type { Channel, Port } from '@taucad/rpc';
import { runtimeProtocolSchemas } from '#types/runtime-protocol.schemas.js';
import type { Geometry } from '@taucad/types';
import type {
  RuntimeInitializeMemoryHandle,
  RuntimeInitializePayload,
  RuntimeTransportClient,
  TransportClientReady,
  TransportDescriptor,
} from '#transport/runtime-transport.types.js';
import { runtimeChannelSessionKey } from '#transport/_internal/runtime-worker-dispatcher.js';
import { isRuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import { materialiseGeometry } from '#transport/_internal/geometry-materialiser.js';
import type { GeometryTransport, RuntimeInitializeResult, RuntimeProtocol } from '#types/runtime-protocol.types.js';
import { allocatePools } from '#transport/_internal/sab-pools.js';
import { triggerAbort } from '#transport/_internal/abort-channel.js';
import { buildHelloPayload } from '#transport/_internal/transport-hello.js';
import { buildFileSystemBridge } from '#transport/_internal/file-system-bridge.js';
import { webWorkerId } from '#transport/_internal/web-worker-id.js';
import type { WebWorkerId } from '#transport/_internal/web-worker-id.js';

/**
 * Default URL of the bundled web-worker entry. Resolved at module-load
 * via `new URL('../worker/web.js', import.meta.url)` so consumers no
 * longer have to write a `new URL('@taucad/runtime/worker/web', ...)`
 * literal at every callsite.
 *
 * The relative `.js` reference is the form `tsModuleUrlBuildPlugin`
 * handles via its synchronous fast path. Hoisting the URL into the
 * runtime package keeps the only `new URL(...)` instance in source we
 * control.
 *
 * @internal
 */
const defaultWebWorkerUrl = new URL('../worker/web.js', import.meta.url);

/**
 * Subset of the DOM `Worker` surface the transport depends on. Tests
 * substitute a stub that exposes the same shape without dragging in
 * `worker_threads`.
 *
 * @public
 */
export type WebWorkerLike = {
  postMessage(value: unknown, transfer?: readonly Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  terminate(): void;
};

/**
 * Options accepted by {@link webWorkerClient}.
 *
 * @public
 */
export type WebWorkerClientOptions = {
  /**
   * URL of the worker module entry. Optional — when omitted the
   * transport defaults to the bundled
   * `@taucad/runtime/worker/web` entry. Override only when hosting a
   * custom worker module that composes `KernelRuntimeWorker` with
   * `webWorkerHost` directly.
   */
  readonly url?: string | URL;
  readonly workerCtor?: typeof Worker;
  readonly sharedMemory?: { readonly geometry?: { readonly bytes: number } };
  readonly fileSystem?: RuntimeFileSystem;
  readonly filePoolBuffer?: SharedArrayBuffer;
};

const wrapWorkerAsPort = (worker: WebWorkerLike, label: string): Port<unknown> => {
  const listeners = new Set<(event: { data: unknown }) => void>();
  let closed = false;
  return {
    postMessage(data, transfer) {
      if (closed) {
        return;
      }
      worker.postMessage(data, transfer);
    },
    onMessage(handler) {
      const listener = (event: { data: unknown }): void => {
        handler(event.data);
      };
      worker.addEventListener('message', listener);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        worker.removeEventListener('message', listener);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const listener of listeners) {
        worker.removeEventListener('message', listener);
      }
      listeners.clear();
      try {
        worker.terminate();
      } catch (error) {
        throw new Error(`${label}: terminate failed`, { cause: error });
      }
    },
  };
};

/**
 * Pure descriptor for bundled web-worker client options — no SAB
 * allocation or worker spawn.
 *
 * @param options - Client options; same shape as {@link webWorkerClient}.
 * @returns Diagnostic {@link TransportDescriptor}.
 * @public
 */
export const webWorkerClientDescribe = (options: WebWorkerClientOptions): TransportDescriptor<WebWorkerId> => {
  const fsKind = options.fileSystem ? 'inline' : 'unbound';
  const sabAvailable = typeof SharedArrayBuffer === 'function';
  const geometryDelivery = sabAvailable && options.sharedMemory?.geometry !== undefined ? 'pool' : 'transfer';
  const fileDelivery = sabAvailable && options.filePoolBuffer !== undefined ? 'pool' : 'transfer';
  const abortSignal = sabAvailable ? 'sab-atomics' : 'wire-notify';

  return {
    id: webWorkerId,
    wire: 'web-worker',
    memory: {
      geometryDelivery,
      fileDelivery,
      abortSignal,
    },
    fileSystem: fsKind,
  };
};

/**
 * Standalone client factory for the web-worker transport.
 * Compose into {@link defineRuntimeTransport} via
 * {@link web-worker-transport.ts}.
 *
 * @param options - Client options; see {@link WebWorkerClientOptions}.
 * @returns The {@link RuntimeTransportClient} fat handle for the web-worker wire.
 * @public
 */
export const webWorkerClient = (
  options: WebWorkerClientOptions,
): RuntimeTransportClient<RuntimeProtocol, Readonly<Record<never, never>>, WebWorkerId> => {
  const ctor: typeof Worker | undefined = options.workerCtor ?? (typeof Worker === 'function' ? Worker : undefined);
  if (typeof ctor !== 'function') {
    throw new TypeError('webWorkerTransport: requires a `Worker` constructor (browser context or `workerCtor` option)');
  }
  if (options.fileSystem !== undefined && !isRuntimeFileSystem(options.fileSystem)) {
    throw new TypeError('webWorkerTransport: `fileSystem` must be produced by a `fromX` factory');
  }

  let pools: ReturnType<typeof allocatePools> | undefined;

  const ensurePools = (): ReturnType<typeof allocatePools> => {
    pools ??= allocatePools({
      geometry: options.sharedMemory?.geometry,
      filePoolBuffer: options.filePoolBuffer,
    });
    return pools;
  };

  let bridge: ReturnType<typeof buildFileSystemBridge>;
  let openPromise: Promise<TransportClientReady> | undefined;
  let worker: WebWorkerLike | undefined;
  let port: Port<unknown> | undefined;
  let channel: Channel<RuntimeProtocol> | undefined;
  let isClosed = false;

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const open = async (): Promise<TransportClientReady> => {
    if (openPromise) {
      return openPromise;
    }
    openPromise = (async () => {
      if (isClosed) {
        throw new Error('webWorkerTransport: client closed before open()');
      }
      void ensurePools();
      const resolvedUrl = options.url ?? defaultWebWorkerUrl;
      const url = typeof resolvedUrl === 'string' ? resolvedUrl : resolvedUrl.href;
      worker = Reflect.construct(ctor, [url, { type: 'module' }]) as WebWorkerLike;
      port = wrapWorkerAsPort(worker, `web-worker:${webWorkerId}`);
      channel = createChannelClient<RuntimeProtocol>({
        port,
        sessionKey: runtimeChannelSessionKey,
        protocolSchemas: runtimeProtocolSchemas,
      });
      // We deliberately do NOT `await channel.ready` here — the fake
      // worker used in unit tests never replies. The runtime client
      // will await readiness before issuing any RPC. Production
      // workers reply with `lh` on module load.
      return {
        channel,
        hello: buildHelloPayload(webWorkerId),
      };
    })();
    return openPromise;
  };

  return {
    id: webWorkerId,
    describe(): TransportDescriptor<WebWorkerId> {
      return webWorkerClientDescribe(options);
    },
    open,
    async initialize(input: RuntimeInitializePayload): Promise<RuntimeInitializeResult> {
      if (!channel) {
        await open();
      }
      if (!channel) {
        throw new Error('webWorkerTransport: channel unavailable after open()');
      }
      bridge ??= buildFileSystemBridge(options.fileSystem);
      const pooled = ensurePools();
      const memoryHandle: RuntimeInitializeMemoryHandle = {
        ...(pooled.signalBuffer ? { signalBuffer: pooled.signalBuffer } : {}),
        ...(pooled.geometryPoolBuffer ? { geometryPoolBuffer: pooled.geometryPoolBuffer } : {}),
        ...(pooled.filePoolBuffer ? { filePoolBuffer: pooled.filePoolBuffer } : {}),
        ...(bridge ? { fileSystemPort: bridge.port } : {}),
      };
      const transferables: Transferable[] = bridge ? [bridge.port] : [];
      const args = { ...input, memoryHandle };
      return channel.call('initialize', transferables.length > 0 ? { value: args, transferables } : args);
    },
    abort(reason): void {
      if (!channel) {
        return;
      }
      triggerAbort(channel, ensurePools().signalBuffer, reason);
    },
    async resolveGeometry(transport: GeometryTransport): Promise<Geometry> {
      return materialiseGeometry(transport, ensurePools().geometryPool);
    },
    async close(reason?: string): Promise<void> {
      if (isClosed) {
        return;
      }
      isClosed = true;
      try {
        channel?.close(reason);
      } catch {
        /* Best-effort */
      }
      try {
        port?.close();
      } catch {
        /* Best-effort */
      }
      try {
        worker?.terminate();
      } catch {
        /* Best-effort */
      }
      try {
        bridge?.dispose();
      } catch {
        /* Best-effort */
      }
      resolveClosed?.();
    },
    closed,
  };
};

webWorkerClient.describe = webWorkerClientDescribe;
