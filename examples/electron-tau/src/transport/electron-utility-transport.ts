/**
 * `electronUtilityTransport` — v6 transport plugin for Topology C
 * (Renderer ↔ utilityProcess kernel host with main-mediated bootstrap).
 *
 * Architecture (per docs/research/runtime-transport-architecture-v6.md
 * §"Electron utility transport"):
 *
 * ```text
 *   Renderer                          main                          utilityProcess
 *   ────────                          ────                          ──────────────
 *   client({port})                    spawn utility + ports         host()
 *      │                                  │                                  │
 *      │      MessageChannelMain          │                                  │
 *      │  ┌─────────────┐         ┌──────┴───────┐                            │
 *      │  │  port1      │ ◄─ ipc─ │  rendererPort│                            │
 *      │  │ (Web MP)    │         │  utilityPort │ ── utility.postMessage ─►  │
 *      │  └─────────────┘         └──────────────┘                            │
 *      │                                                                     │
 *      └──── Channel<RuntimeProtocol> ◄─── KernelRuntimeWorker dispatcher ───┘
 * ```
 *
 * Two halves:
 *
 * - **Renderer side** (`client({ port })`): wraps the renderer-received
 *   `MessagePort` (WHATWG) and presents a typed
 *   `Channel<RuntimeProtocol>`. Main is responsible for shipping the
 *   port via `webContents.postMessage`; this transport never reads
 *   `ipcRenderer` itself.
 *
 * - **Utility side** (`host()`): inside the utility process, awaits
 *   the `MessagePortMain` from `process.parentPort`, instantiates a
 *   `KernelRuntimeWorker`, and runs `createWorkerDispatcher` over the
 *   wire. The kernel `worker_threads.Worker` runs INSIDE the utility
 *   process — never on Electron main.
 *
 * Wire constraints:
 *
 *   - `MessagePortMain.postMessage(data, transfers)` REJECTS any
 *     transferable that is not a `MessagePortMain` — passing an
 *     `ArrayBuffer` raises "Port at index N is not a valid port"
 *     and aborts the send.
 *   - `SharedArrayBuffer` cannot be structured-cloned across the
 *     boundary; a frame carrying one silently arrives as `null`.
 *
 * The transport therefore advertises `geometryDelivery: 'copy'`,
 * `fileDelivery: 'copy'`, `abortSignal: 'wire-notify'`, and
 * `fileSystem: 'host-local'` so the runtime client never asks the wire
 * to do anything it cannot do. The utility-side host provisions its
 * own in-isolate `RuntimeFileSystem` (`fromMemoryFs()`).
 *
 * Debug logging (gated by `TAU_ELECTRON_DEBUG=1` in the utility env;
 * always-on in renderer) is wired through every boot-sequence seam so
 * Playwright can surface the boot trail in failure output.
 *
 * @public
 */

import { wrapMessagePort, createChannelClient } from '@taucad/rpc';
import { runtimeProtocolSchemas } from '@taucad/runtime/transport';
import type { Channel, ChannelServerHandle, Port, PortCapabilities } from '@taucad/rpc';
import { defineRuntimeTransport } from '@taucad/runtime/transport';
import type {
  EncodedFileBytes,
  EncodedGeometry,
  HostInitializeBindings,
  RuntimeInitializeMemoryHandle,
  RuntimeInitializePayload,
  RuntimeTransportClient,
  RuntimeTransportHost,
  TransportClientReady,
  TransportDescriptor,
  TransportHostReady,
} from '@taucad/runtime/transport';
import type { Geometry } from '@taucad/types';
import type { GeometryTransport, RuntimeInitializeResult, RuntimeProtocol } from '@taucad/runtime';
import { fromMemoryFS, fromMemoryFs } from '@taucad/runtime/filesystem';
import { KernelRuntimeWorker, installWorkerCrashTrap, createWorkerDispatcher } from '@taucad/runtime/worker';

import {
  electronUtilityClientOptionsSchema,
  electronUtilityHostOptionsSchema,
} from './electron-utility-transport.schemas.js';

/* Mirror of the runtime's `abortReason` numeric codes. The wire
 * protocol's `'abort'` notify carries a numeric code (0/1/2), not the
 * `'superseded' | 'timeout'` string `RuntimeTransportClient.abort()`
 * receives. The runtime exports `AbortReason` (string) but not the
 * encoder; we duplicate the small mapping here so the example stays
 * self-contained. */
const abortReasonToCode = (reason: 'superseded' | 'timeout'): 0 | 1 | 2 => (reason === 'timeout' ? 2 : 1);

const electronUtilityId = 'electron-utility';
const sessionKey = 'tau.runtime/v1';

/* Renderer-side debug: when `process` is undefined (browser context)
 * we always log so Playwright captures the boot trail. Utility-side
 * debug is gated by `TAU_ELECTRON_DEBUG=1`. */
// oxlint-disable-next-line n/prefer-global/process -- gated by typeof check below
const DEBUG_ENABLED = typeof process === 'undefined' ? true : process.env['TAU_ELECTRON_DEBUG'] === '1';

const debugLog = (origin: string, message: string, data?: Record<string, unknown>): void => {
  if (!DEBUG_ENABLED) {
    return;
  }
  const payload = data ? ` ${JSON.stringify(data)}` : '';
  // eslint-disable-next-line no-console -- diagnostic seam (gated by TAU_ELECTRON_DEBUG)
  console.log(`[tau-electron:${origin}] ${message}${payload}`);
};

/* ============================================================ *
 * Wire wrapper for Electron `MessagePortMain` (Node side)       *
 * ============================================================ */

type MessagePortMainLike = {
  postMessage(value: unknown, transfer?: readonly unknown[]): void;
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): MessagePortMainLike;
  on(event: 'close', listener: () => void): MessagePortMainLike;
  start(): void;
  close(): void;
};

const wrapMessagePortMain = (port: MessagePortMainLike, label: string): Port<unknown> => {
  let started = false;
  let closed = false;
  const handlers = new Set<(value: unknown) => void>();

  const onPortMessage = (event: { readonly data: unknown }): void => {
    if (closed) {
      return;
    }
    debugLog(label, 'rx-frame');
    for (const handler of handlers) {
      handler(event.data);
    }
  };

  port.on('close', () => {
    debugLog(label, 'underlying-port-closed');
    closed = true;
    handlers.clear();
  });

  /* `Port.capabilities` is a v5 holdover scheduled for removal in
   * Stage 10 once every wire path stops reading it; until then the
   * runtime's `wrapMessagePort` callsite still adds it, so this
   * MessagePortMain wrapper must declare the same surface. Electron
   * `MessagePortMain` only honours MessagePortMain entries in the
   * transfer list — no SAB, no transferable buffers. */
  const capabilities: PortCapabilities = { transfer: true };
  return {
    capabilities,
    postMessage(value, transferables) {
      if (closed) {
        debugLog(label, 'tx-after-close-dropped');
        return;
      }
      const tList = transferables ? [...(transferables as readonly unknown[])] : undefined;
      /* Filter the transfer list down to actual Electron ports. Any
       * ArrayBuffer / TypedArray / SAB present in `transferables`
       * would crash the send with "Port at index N is not a valid
       * port" — Electron's MessagePortMain serializer only honours
       * MessagePortMain in the transfer list. Non-port transferables
       * are still delivered via structured-clone copy on the data
       * path; we just drop them from the transfer list. */
      const portsOnly = tList?.filter(
        (entry): entry is MessagePortMainLike =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as { postMessage?: unknown }).postMessage === 'function' &&
          typeof (entry as { start?: unknown }).start === 'function',
      );
      debugLog(label, 'tx-frame', {
        transferableCount: tList?.length ?? 0,
        portsOnlyCount: portsOnly?.length ?? 0,
      });
      if (portsOnly && portsOnly.length > 0) {
        port.postMessage(value, portsOnly);
      } else {
        port.postMessage(value);
      }
    },
    onMessage(handler) {
      handlers.add(handler);
      if (!started) {
        started = true;
        debugLog(label, 'starting-port');
        port.on('message', onPortMessage);
        port.start();
      }
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      handlers.clear();
      try {
        port.close();
      } catch (error) {
        throw new Error(`${label}: close failed`, { cause: error });
      }
    },
  };
};

/* ============================================================ *
 * Descriptor                                                    *
 * ============================================================ */

const buildDescriptor = (): TransportDescriptor<typeof electronUtilityId> => ({
  id: electronUtilityId,
  wire: 'electron-utility',
  memory: {
    geometryDelivery: 'copy',
    fileDelivery: 'copy',
    abortSignal: 'wire-notify',
  },
  fileSystem: 'host-local',
});

const buildHelloPayload = (): {
  readonly server: 'kernel-runtime-worker';
  readonly runtimeVersion: string;
  readonly transportId: typeof electronUtilityId;
} => ({
  server: 'kernel-runtime-worker',
  runtimeVersion: 'electron-utility',
  transportId: electronUtilityId,
});

/* ============================================================ *
 * Plugin                                                        *
 * ============================================================ */

/**
 * `electronUtilityTransport` — bundled Topology C transport.
 *
 * The plugin is consumed via:
 *
 * - Renderer: `transport: electronUtilityTransport.client({ port })`
 *   on `createRuntimeClient`, where `port` is the WHATWG `MessagePort`
 *   the renderer received from main via the preload relay.
 * - Utility: `transport: electronUtilityTransport.host({})` on
 *   `createRuntimeHost` — no options required; the port arrives over
 *   `process.parentPort`.
 *
 * @public
 */
export const electronUtilityTransport = defineRuntimeTransport({
  id: electronUtilityId,
  clientOptionsSchema: electronUtilityClientOptionsSchema,
  hostOptionsSchema: electronUtilityHostOptionsSchema,

  client(
    clientOptions,
  ): RuntimeTransportClient<RuntimeProtocol, Readonly<Record<never, never>>, typeof electronUtilityId> {
    debugLog('renderer:client', 'constructed');
    /* The Zod schema validates `port` is a MessagePort on construction;
     * here we only re-wrap it for the runtime channel. */
    const { port: receivedPort } = clientOptions;
    const wrappedPort = wrapMessagePort<unknown>(receivedPort, {
      label: 'electron-utility:renderer',
    });
    debugLog('renderer:client', 'port-wrapped');

    let openPromise: Promise<TransportClientReady> | undefined;
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
          throw new Error('electronUtilityTransport.client: closed before open()');
        }
        channel = createChannelClient<RuntimeProtocol>({
          port: wrappedPort,
          sessionKey,
          protocolSchemas: runtimeProtocolSchemas,
        });
        debugLog('renderer:client', 'channel-created');
        await channel.ready;
        debugLog('renderer:client', 'channel-ready');
        return {
          channel,
          hello: buildHelloPayload(),
        };
      })();
      return openPromise;
    };

    return {
      id: electronUtilityId,
      describe(): TransportDescriptor<typeof electronUtilityId> {
        return buildDescriptor();
      },
      open,
      async initialize(input: RuntimeInitializePayload): Promise<RuntimeInitializeResult> {
        if (!channel) {
          await open();
        }
        if (!channel) {
          throw new Error('electronUtilityTransport.client: channel unavailable after open()');
        }
        /* Empty memory handle — Electron utility wire cannot carry SAB,
         * so the host adopts wire-notify abort + copy delivery. */
        const memoryHandle: RuntimeInitializeMemoryHandle = {};
        return channel.call('initialize', { ...input, memoryHandle });
      },
      abort(reason): void {
        if (!channel) {
          return;
        }
        debugLog('renderer:client', 'abort', { reason });
        try {
          channel.notify('abort', { reason: abortReasonToCode(reason) });
        } catch {
          /* Best-effort */
        }
      },
      async resolveGeometry(transport: GeometryTransport): Promise<Geometry> {
        /* Electron utility wire is copy-tier only — `transport.content`
         * always arrives as `{ delivery: 'inline', bytes }`. */
        if (transport.format !== 'gltf') {
          throw new Error(`electronUtilityTransport: unsupported geometry format '${transport.format}'`);
        }
        const content = transport.content as { delivery: 'inline'; bytes: Uint8Array<ArrayBuffer> };
        return { format: 'gltf', content: content.bytes, hash: transport.hash };
      },
      async close(reason?: string): Promise<void> {
        if (isClosed) {
          return;
        }
        isClosed = true;
        debugLog('renderer:client', 'closing', reason ? { reason } : undefined);
        try {
          channel?.close(reason);
        } catch {
          /* Best-effort */
        }
        try {
          wrappedPort.close();
        } catch {
          /* Best-effort */
        }
        resolveClosed?.();
      },
      closed,
    };
  },

  host(_hostOptions): RuntimeTransportHost<RuntimeProtocol, Readonly<Record<never, never>>, typeof electronUtilityId> {
    void _hostOptions;
    debugLog('utility:host', 'constructed');

    let openPromise: Promise<TransportHostReady> | undefined;
    let dispatcherHandle: ChannelServerHandle<RuntimeProtocol> | undefined;
    let isClosed = false;

    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    /* Encoders are inline-only — Electron `MessagePortMain` cannot
     * carry SAB or non-port transferables, so we structured-clone the
     * geometry / file payloads on the wire. */
    const encodeGeometry = (geometry: Geometry): EncodedGeometry => {
      if (geometry.format !== 'gltf') {
        return { value: geometry, transferables: [], tier: 'copy' };
      }
      return {
        value: {
          format: 'gltf',
          content: { delivery: 'inline', bytes: geometry.content },
          hash: geometry.hash,
        },
        transferables: [],
        tier: 'copy',
      };
    };

    // oxlint-disable-next-line enforce-uint8array-arraybuffer/enforce-uint8array-arraybuffer -- v6 binding signature is `Uint8Array` (no ArrayBuffer narrowing)
    const encodeFile = (file: Uint8Array): EncodedFileBytes => {
      return { value: { delivery: 'inline', bytes: file }, transferables: [], tier: 'copy' };
    };

    /* Provision an in-isolate memory filesystem so the kernel worker
     * can stage-and-open inline file payloads received over the wire
     * (the renderer's `client.openFile({ code })` call streams bytes
     * inline; the worker writes them to this FS before invoking the
     * kernel).
     *
     * Two backings of the same in-memory store:
     *   - `utilityFsBase` is the `RuntimeFileSystemBase` consumed by
     *     `createWorkerDispatcher`'s `inlineFileSystem` option.
     *   - `utilityFs` is the opaque `RuntimeFileSystem` returned in
     *     `bindings.fileSystem` for the dispatcher's bindings echo. */
    const utilityFsHandle = fromMemoryFS();
    if (utilityFsHandle.kind !== 'inline') {
      throw new Error('electronUtilityTransport.host: fromMemoryFS() must yield an inline-kind handle');
    }
    const utilityFsBase = utilityFsHandle.fs;
    const utilityFs = fromMemoryFs();

    const open = async (): Promise<TransportHostReady> => {
      if (openPromise) {
        return openPromise;
      }
      openPromise = new Promise<TransportHostReady>((resolve, reject) => {
        if (isClosed) {
          reject(new Error('electronUtilityTransport.host: closed before open()'));
          return;
        }
        /* Electron utilityProcess exposes parentPort on `process`, not
         * on globalThis. Try both for resilience under test stubs. */
        // oxlint-disable-next-line n/prefer-global/process -- guarded
        const procPort = (
          process as unknown as {
            readonly parentPort?: {
              once(event: string, listener: (event: { readonly ports: readonly MessagePortMainLike[] }) => void): void;
            };
          }
        ).parentPort;
        const { parentPort: globalParentPort } = globalThis as unknown as {
          readonly parentPort?: {
            once(event: string, listener: (event: { readonly ports: readonly MessagePortMainLike[] }) => void): void;
          };
        };
        const port = procPort ?? globalParentPort;
        if (!port) {
          const error = new Error(
            'electronUtilityTransport.host: process.parentPort unavailable (must run inside utilityProcess)',
          );
          debugLog('utility:host', 'no-parent-port');
          reject(error);
          return;
        }
        debugLog('utility:host', 'awaiting-parent-port-message');
        port.once('message', (event: { readonly ports: readonly MessagePortMainLike[] }) => {
          const [utilityPort] = event.ports;
          debugLog('utility:host', 'parent-port-message-received', {
            portCount: event.ports.length,
          });
          if (!utilityPort) {
            reject(new Error('electronUtilityTransport.host: hello frame missing MessagePortMain'));
            return;
          }
          try {
            const wireport = wrapMessagePortMain(utilityPort, 'utility:wire');
            debugLog('utility:host', 'wire-port-wrapped');
            const worker = new KernelRuntimeWorker();
            debugLog('utility:host', 'kernel-runtime-worker-instantiated');
            const dispatcher = createWorkerDispatcher(worker, wireport, {
              inlineFileSystem: utilityFsBase,
              encodeGeometry,
              encodeFile,
            });
            dispatcherHandle = dispatcher;
            debugLog('utility:host', 'dispatcher-wired');
            installWorkerCrashTrap(dispatcher);
            debugLog('utility:host', 'crash-trap-installed');
            resolve({
              channel: dispatcher,
              peerHello: buildHelloPayload(),
            });
          } catch (error) {
            debugLog('utility:host', 'dispatcher-init-failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      return openPromise;
    };

    return {
      id: electronUtilityId,
      open,
      adoptInitialize(_handle: RuntimeInitializeMemoryHandle): HostInitializeBindings {
        /* Electron utility wire never carries SAB, so abort is
         * wire-notify-only and delivery tiers are copy. The dispatcher
         * exposes the abort signal to kernel calls; the controller is
         * driven by the wire `'abort'` notify handler installed by the
         * dispatcher. */
        const controller = new AbortController();
        return {
          fileSystem: utilityFs,
          abort: {
            signal: controller.signal,
            strategy: 'wire-notify',
          },
          geometryDelivery: {
            publish(geometry): EncodedGeometry {
              return encodeGeometry(geometry);
            },
            tier: 'copy',
          },
          fileDelivery: {
            publish(file): EncodedFileBytes {
              return encodeFile(file);
            },
            tier: 'copy',
          },
        };
      },
      encodeGeometry,
      encodeFile,
      async close(reason?: string): Promise<void> {
        if (isClosed) {
          return;
        }
        isClosed = true;
        debugLog('utility:host', 'closing', reason ? { reason } : undefined);
        try {
          dispatcherHandle?.dispose();
        } catch {
          /* Best-effort */
        }
        resolveClosed?.();
      },
      closed,
    };
  },
});
