/**
 * RuntimeClient -- high-level, Promise-based facade for CAD kernel operations.
 *
 * Wraps a RuntimeWorkerClient with lazy initialization, event subscription,
 * and plugin configuration. This is the primary API for consumers.
 */

import type { FileExtension, Geometry, GeometryFile, ExportFile, LogEntry } from '@taucad/types';
import type {
  HashedGeometryResult,
  GetParametersResult,
  KernelResult,
  KernelIssue,
  CapabilitiesManifest,
  ExportRoute,
} from '#types/runtime.types.js';
import type { RuntimeFileSystemBase } from '#types/runtime-kernel.types.js';
import type {
  PerformanceEntryData,
  RenderPhase,
  WorkerState,
  GeometryTransport,
  HashedGeometryResultTransport,
} from '#types/runtime-protocol.types.js';
import { RuntimeWorkerClient } from '#framework/runtime-worker-client.js';
import type { BridgeHandle } from '#framework/runtime-filesystem-bridge.js';
import { createBridgePort } from '#framework/runtime-filesystem-bridge.js';
import { fromMemoryFS } from '#filesystem/from-memory-fs.js';
import { createWorkerTransport } from '#transport/worker-transport.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';
import type {
  KernelPlugin,
  MiddlewarePlugin,
  BundlerPlugin,
  TranscoderPlugin,
  CollectKernelIds,
  CollectRenderOptions,
  ExportFormatsFor,
  ExportOptionsFor,
  KnownTargetFormats,
} from '#plugins/plugin-types.js';
import { SharedPool } from '@taucad/memory';
import type { SharedPoolOptions } from '@taucad/memory';

// =============================================================================
// RenderInput Types
// =============================================================================

/**
 * Detects whether a type is a union (more than one member).
 * Used internally to determine if a code object has multiple keys.
 */
type IsUnion<T, U = T> = T extends U ? ([U] extends [T] ? false : true) : never;

/**
 * Inline code input for `render()`.
 *
 * `code` is a filename-to-content map. When only a single key exists,
 * `file` is optional (the runtime picks the only key). When multiple keys
 * exist (or when `T` is a wide `Record<string, string>`), `file` is required
 * to specify the entry point.
 * @public
 */
export type CodeInput<T extends Record<string, string>> = {
  /** Inline source code as a filename-to-content map. */
  code: T;
  /** Parameters for the model's main function. @default \{\} */
  parameters?: Record<string, unknown>;
  /** Kernel-specific render options. */
  options?: Record<string, unknown>;
  /** Not applicable in inline mode (client auto-manages). @internal */
  changedPaths?: never;
} & (string extends keyof T
  ? {
      /** Entry point filename. Required when key count is unknown at compile time. */ file: string;
    }
  : true extends IsUnion<keyof T>
    ? {
        /** Entry point filename. Required for multi-file code. */ file: keyof T;
      }
    : {
        /** Entry point filename. Optional for single-file code (inferred from the only key). */ file?: keyof T;
      });

/**
 * Filesystem-based input for `render()`.
 *
 * Renders from a connected filesystem. `file` can be a string shorthand
 * (e.g., `'/src/main.ts'`) or a `GeometryFile` object.
 * @public
 */
export type FileInput = {
  /** Prevents mixing code with file-mode rendering. @internal */
  code?: never;
  /** File to render from the connected filesystem. */
  file: string | GeometryFile;
  /** Parameters for the model's main function. @default \{\} */
  parameters?: Record<string, unknown>;
  /** Kernel-specific render options. */
  options?: Record<string, unknown>;
};

/**
 * Consumer-facing export result with a single `ExportFile` (unwrapped).
 *
 * Internally, the kernel pipeline produces `ExportFile[]`, but every current
 * kernel produces exactly one file. The client unwraps the first element for
 * a cleaner consumer API: `result.data.bytes` instead of `result.data[0].bytes`.
 * @public
 */
export type ExportResult = KernelResult<ExportFile>;

/**
 * Resolve a string file path into a `GeometryFile`.
 *
 * - `'main.ts'` --> `{ path: '/', filename: 'main.ts' }`
 * - `'/src/model.ts'` --> `{ path: '/src', filename: 'model.ts' }`
 * - `'/projects/test/bench.ts'` --> `{ path: '/projects/test', filename: 'bench.ts' }`
 *
 * @param file - file path string to resolve
 * @returns geometry file with separated path and filename
 */
function resolveFileString(file: string): GeometryFile {
  const lastSlash = file.lastIndexOf('/');
  if (lastSlash === -1) {
    return { path: '/', filename: file };
  }

  const path = file.slice(0, lastSlash) || '/';
  return {
    path: path.startsWith('/') ? path : `/${path}`,
    filename: file.slice(lastSlash + 1),
  };
}

/**
 * Rank export fidelity for tiebreak: lower wins. `brep` outranks `mesh`.
 * @param fidelity - Route fidelity classification
 * @returns 0 for brep, 1 for mesh
 */
function fidelityRank(fidelity: ExportRoute['fidelity']): number {
  return fidelity === 'brep' ? 0 : 1;
}

/**
 * Rank route directness for tiebreak: direct (no transcoder) outranks transcoded.
 * @param route - Candidate export route
 * @returns 0 for direct routes, 1 for transcoded routes
 */
function directnessRank(route: ExportRoute): number {
  return route.transcoderId === undefined ? 0 : 1;
}

/**
 * Configuration for a shared-memory pool.
 * @public
 */
export type SharedMemoryConfig = SharedPoolOptions & {
  /** Size of the SharedArrayBuffer to allocate in bytes. */
  bytes: number;
};

/**
 * Options for creating a RuntimeClient.
 *
 * Generic over kernel and transcoder plugin tuples to preserve phantom type
 * information through option building and client creation.
 *
 * @template Kernels - Kernel plugin tuple type (preserves FormatMap and RenderOptions phantoms)
 * @template Transcoders - Transcoder plugin tuple type (preserves EdgeMap phantoms)
 * @public
 */
// oxlint-disable @typescript-eslint/no-explicit-any -- variance: default accepts any plugin generic
export type RuntimeClientOptions<
  Kernels extends KernelPlugin<any, any, any>[] = KernelPlugin[],
  Transcoders extends TranscoderPlugin<any, any, any>[] = TranscoderPlugin[],
> = {
  /** Kernel plugins to register (order determines selection priority). */
  kernels: [...Kernels];
  /** Middleware plugins (order determines onion-model wrapping). */
  middleware?: MiddlewarePlugin[];
  /** Bundler plugins (multiple supported, routed by file extension). */
  bundlers?: BundlerPlugin[];
  /** Transcoder plugins for bytes-to-bytes format conversion. */
  transcoders?: [...Transcoders];
  /** Custom transport. Defaults to a Web Worker transport using the built-in worker URL. */
  transport?: RuntimeTransport;
  /**
   * Default RuntimeFileSystemBase, used when `connect()` is not called explicitly.
   * For browser apps that need deferred connection, use `client.connect()` instead.
   */
  fileSystem?: RuntimeFileSystemBase;
  /**
   * Wall-clock render timeout in seconds. 0 disables the timeout.
   * Enforced by the main-thread RuntimeWorkerClient via SharedArrayBuffer — the
   * worker's cooperative abort proxy throws when the timeout fires.
   */
  renderTimeout?: number;
  /**
   * Shared memory configuration for zero-IPC geometry data exchange.
   * Allocates a SharedArrayBuffer and creates a SharedPool on both the main thread and the worker.
   *
   * File pool SABs are owned by the file manager (domain-driven allocation) and
   * passed through via `connect({ filePoolBuffer })`.
   */
  sharedMemory?: {
    /** Geometry pool for zero-copy geometry data transfer between worker and main thread. */
    geometry?: SharedMemoryConfig;
  };
};
// oxlint-enable @typescript-eslint/no-explicit-any

/**
 * Connection options for `RuntimeClient.connect()`.
 *
 * - `{ fileSystem }` -- main-thread relay: the client creates a MessagePort bridge internally.
 * - `{ port }` -- direct bridge: pass a pre-existing MessagePort (e.g., from `createFileSystemBridge`).
 *
 * `filePoolBuffer` is an optional SharedArrayBuffer allocated by the file manager for
 * zero-IPC file content caching. When provided, it is forwarded to the kernel worker
 * so the filesystem bridge can resolve file reads from shared memory.
 * @public
 */
export type ConnectOptions =
  //
  | { fileSystem: RuntimeFileSystemBase; filePoolBuffer?: SharedArrayBuffer }
  | { port: MessagePort; filePoolBuffer?: SharedArrayBuffer };

type EventHandlers = {
  log: Set<(entry: LogEntry) => void>;
  progress: Set<(phase: RenderPhase, detail?: Record<string, unknown>) => void>;
  telemetry: Set<(entries: PerformanceEntryData[]) => void>;
  parametersResolved: Set<(result: GetParametersResult) => void>;
  geometry: Set<(result: HashedGeometryResult) => void>;
  state: Set<(state: WorkerState, detail?: string) => void>;
  error: Set<(issues: KernelIssue[]) => void>;
  capabilities: Set<(manifest: CapabilitiesManifest) => void>;
  activeKernel: Set<(kernelId: string | undefined) => void>;
};

/**
 * High-level runtime client interface.
 * Lazy, Promise-based, event-subscribable.
 *
 * The `Kernels` and `Transcoders` generics flow through as a top-level type
 * bag from {@link createRuntimeClient}. Each leaf method (`routesFor`,
 * `bestRouteFor`, `render`, `export`, `on('capabilities')`,
 * `on('activeKernel')`) projects narrow types out of the bag via the
 * `Known*` / `CollectKernelIds` / `CollectRenderOptions` / `MergeExportMap`
 * helpers. Wide defaults preserve today's `FileExtension`/`Record<string,
 * unknown>`/`string` shape so consumers without typed plugins still
 * type-check.
 *
 * @template Kernels - Tuple of registered `KernelPlugin`s (carries `FormatMap`/`RenderOptions`/`Id`)
 * @template Transcoders - Tuple of registered `TranscoderPlugin`s (carries `EdgeMap`/`Id`)
 * @public
 */
// oxlint-disable @typescript-eslint/no-explicit-any -- variance: default accepts any plugin generic
export type RuntimeClient<
  Kernels extends readonly KernelPlugin<any, any, any>[] = KernelPlugin[],
  Transcoders extends readonly TranscoderPlugin<any, any, any>[] = TranscoderPlugin[],
> = {
  /** Shared memory pool for zero-IPC geometry data exchange. Populated during connect(). */
  readonly geometryPool: SharedPool | undefined;

  /** Capabilities manifest from the worker, available after initialization. */
  readonly capabilities: CapabilitiesManifest<Kernels, Transcoders> | undefined;

  /** Active kernel ID from the worker, available after the first render selects a kernel. */
  readonly activeKernelId: CollectKernelIds<Kernels> | undefined;

  /**
   * Returns every {@link ExportRoute} from the current capabilities manifest
   * whose `targetFormat` matches `format`, preserving manifest order.
   *
   * Returns an empty array when no manifest has been received yet or when no
   * route matches the requested format. Consumers building format pickers
   * should subscribe to `'capabilities'` to refresh derived UI state.
   */
  routesFor(format: KnownTargetFormats<Kernels, Transcoders>): ReadonlyArray<ExportRoute<Kernels, Transcoders>>;

  /**
   * Selects the best {@link ExportRoute} for `format` using the framework
   * tiebreak rules:
   *
   * 1. When `kernelId` is supplied, prefer routes for that kernel; fall back
   *    to the manifest-order routes when no candidate matches.
   * 2. Prefer `brep` fidelity over `mesh` fidelity.
   * 3. Prefer direct routes (`transcoderId === undefined`) over transcoded
   *    routes.
   * 4. Otherwise return the first manifest-order match.
   *
   * Returns `undefined` when no route matches the requested format or when
   * the manifest has not yet been received.
   */
  bestRouteFor(
    format: KnownTargetFormats<Kernels, Transcoders>,
    kernelId?: CollectKernelIds<Kernels>,
  ): ExportRoute<Kernels, Transcoders> | undefined;

  /**
   * Connect to the runtime worker and initialize with a filesystem.
   *
   * @param options - Connection options: `{ fileSystem }` for main-thread relay, `{ port }` for direct bridge
   */
  connect(options: ConnectOptions): Promise<void>;

  /**
   * Render geometry from inline code.
   *
   * `code` is a filename-to-content map. When only a single key exists,
   * `file` is optional (inferred from the only key). When multiple keys
   * exist, `file` is required to specify the entry point.
   *
   * Auto-creates an in-memory filesystem, writes code, connects, and renders.
   * Cannot be used with a port-based connection.
   */
  render<T extends Record<string, string>>(
    input: CodeInput<T> & { options?: CollectRenderOptions<Kernels> },
  ): Promise<HashedGeometryResult>;

  /**
   * Render geometry from the connected filesystem.
   *
   * `file` can be a string shorthand (e.g., `'/src/main.ts'`) or a `GeometryFile`.
   * Cache invalidation is handled automatically by the worker's filesystem watch subscription.
   */
  render(input: FileInput & { options?: CollectRenderOptions<Kernels> }): Promise<HashedGeometryResult>;

  /**
   * Export geometry from inline code (self-rendering).
   *
   * Internally renders the code first, then exports.
   */
  export<T extends Record<string, string>>(
    format: KnownTargetFormats<Kernels, Transcoders>,
    input: CodeInput<T>,
  ): Promise<ExportResult>;

  /**
   * Export geometry from the connected filesystem (self-rendering).
   *
   * Internally renders the file first, then exports.
   */
  export(format: KnownTargetFormats<Kernels, Transcoders>, input: FileInput): Promise<ExportResult>;

  /**
   * Export geometry from the last render in the specified format.
   *
   * When `Kernels`/`Transcoders` carry type information (from typed plugins),
   * the options are type-checked against the declared per-format schemas
   * via {@link MergeExportMap}.
   *
   * @param format - Export format identifier (e.g., 'stl', 'step', '3mf')
   * @param options - Per-call format-specific options
   * @returns Export result with a single ExportFile
   */
  export<F extends ExportFormatsFor<Kernels, Transcoders>>(
    format: F,
    options?: ExportOptionsFor<Kernels, Transcoders, F>,
  ): Promise<ExportResult>;

  /**
   * Set the active file for autonomous rendering (filesystem mode).
   * The worker will immediately render and then watch for file changes.
   *
   * @param file - File path string or GeometryFile
   * @param parameters - Parameters for the model
   * @param options - Optional kernel-specific render options
   */
  setFile(
    file: string | GeometryFile,
    parameters?: Record<string, unknown>,
    options?: CollectRenderOptions<Kernels>,
  ): void;

  /**
   * Update parameters for autonomous rendering (filesystem mode).
   * The worker debounces and re-renders with the new parameters.
   *
   * @param parameters - Updated parameters for the model
   */
  setParameters(parameters: Record<string, unknown>): void;

  /**
   * Set the wall-clock render timeout enforced by the main-thread RuntimeWorkerClient.
   * When the timer fires, the abort generation is incremented via SharedArrayBuffer
   * and the abort reason is set to `timeout`, causing the worker's cooperative
   * abort proxy to throw.
   *
   * @param seconds - Timeout in seconds. 0 disables the timeout.
   */
  setRenderTimeout(seconds: number): void;

  /**
   * Proactive cache invalidation without triggering a render.
   * Used by inline code mode. In filesystem mode, the worker's watch
   * subscription handles invalidation automatically.
   *
   * @param paths - Changed file paths
   */
  notifyFileChanged(paths: string[]): void;

  /**
   * Subscribe to client events. Returns an unsubscribe function.
   * Subscribable at any time during the client lifecycle.
   *
   * @param event - Event name
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  on(event: 'geometry', handler: (result: HashedGeometryResult) => void): () => void;
  on(event: 'state', handler: (state: WorkerState, detail?: string) => void): () => void;
  on(event: 'log', handler: (entry: LogEntry) => void): () => void;
  on(event: 'progress', handler: (phase: RenderPhase, detail?: Record<string, unknown>) => void): () => void;
  on(event: 'telemetry', handler: (entries: PerformanceEntryData[]) => void): () => void;
  on(event: 'parametersResolved', handler: (result: GetParametersResult) => void): () => void;
  on(event: 'error', handler: (issues: KernelIssue[]) => void): () => void;
  on(event: 'capabilities', handler: (manifest: CapabilitiesManifest<Kernels, Transcoders>) => void): () => void;
  on(event: 'activeKernel', handler: (kernelId: CollectKernelIds<Kernels> | undefined) => void): () => void;

  /**
   * Terminate the worker and clean up all resources.
   */
  terminate(): void;
};
// oxlint-enable @typescript-eslint/no-explicit-any

/**
 * Create a high-level runtime client.
 *
 * The client lazily creates the Worker and Transport on first `connect()` or `render()` call.
 * Plugin factory functions are used to configure kernels, middleware, and bundlers.
 *
 * @param options - Client configuration with plugin selections
 * @returns RuntimeClient instance
 *
 * @public
 *
 * @example <caption>Browser setup</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad, openscad } from '@taucad/runtime/kernels';
 * import { geometryCache } from '@taucad/runtime/middleware';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad(), openscad()],
 *   middleware: [geometryCache()],
 *   bundlers: [esbuild()],
 * });
 * ```
 *
 * @example <caption>Node.js / test setup with in-process transport</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 * import { createInProcessTransport } from '@taucad/runtime/transport';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: createInProcessTransport(),
 * });
 *
 * const result = await client.render({
 *   code: { '/main.ts': 'import { draw } from "replicad";\nexport default () => draw();' },
 * });
 * ```
 */
// oxlint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-restricted-types -- variance + empty-tuple default
export function createRuntimeClient<
  const Kernels extends KernelPlugin<any, any, any>[],
  const Transcoders extends TranscoderPlugin<any, any, any>[] = [],
>(options: RuntimeClientOptions<Kernels, Transcoders>): RuntimeClient<Kernels, Transcoders>;
// oxlint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-restricted-types
// SAFETY (R7 — see docs/research/runtime-type-bag-propagation.md):
// The implementation signature returns the wide-default `RuntimeClient`
// (= `RuntimeClient<KernelPlugin[], TranscoderPlugin[]>`) because the worker
// physically emits a wide `CapabilitiesManifest` over `postMessage` — no
// generic information survives the wire. The public overload narrows the
// return to `RuntimeClient<Kernels, Transcoders>`. This is a *witness*
// narrowing, not a structural lie: every concrete value the worker emits is
// already a member of the narrower carrier, so the seam is sound by
// construction. Compile-time proof lives in `define-plugin.test-d.ts`
// (`describe('Worker boundary witness narrowing (R7)')`).
// oxlint-disable-next-line tau-lint/require-public-export-jsdoc -- false positive
export function createRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  const { kernels, middleware = [], bundlers = [], transcoders = [] } = options;

  let workerClient: RuntimeWorkerClient | undefined;
  let transport: RuntimeTransport | undefined;
  let fileSystemBridge: BridgeHandle | undefined;
  let connected = false;
  let connectedViaPort = false;
  let managedFileSystem: RuntimeFileSystemBase | undefined;

  let _geometryPool: SharedPool | undefined;
  let _geometryPoolBuffer: SharedArrayBuffer | undefined;
  let poolsInitialized = false;
  let _capabilities: CapabilitiesManifest | undefined;
  let _activeKernelId: string | undefined;

  const handlers: EventHandlers = {
    log: new Set(),
    progress: new Set(),
    telemetry: new Set(),
    parametersResolved: new Set(),
    geometry: new Set(),
    state: new Set(),
    error: new Set(),
    capabilities: new Set(),
    activeKernel: new Set(),
  };

  function getWorkerUrl(): string {
    return new URL('../framework/kernel-runtime-worker.js', import.meta.url).href;
  }

  async function ensureConnected(connectOptions?: ConnectOptions): Promise<RuntimeWorkerClient> {
    if (workerClient && connected) {
      return workerClient;
    }

    const resolvedOptions = connectOptions ?? (options.fileSystem ? { fileSystem: options.fileSystem } : undefined);

    if (!resolvedOptions) {
      throw new Error('RuntimeClient.connect() must be called with a fileSystem or port before rendering');
    }

    transport = options.transport ?? createWorkerTransport(getWorkerUrl());

    workerClient = new RuntimeWorkerClient(
      transport,
      (entry) => {
        for (const handler of handlers.log) {
          handler(entry);
        }
      },
      {
        onTelemetry(entries) {
          for (const handler of handlers.telemetry) {
            handler(entries);
          }
        },
        onStateChanged(state, detail) {
          for (const handler of handlers.state) {
            handler(state, detail);
          }
        },
        onGeometryComputed(transportResult) {
          emitGeometry(resolveTransportResult(transportResult, _geometryPool));
        },
        onParametersResolved(result) {
          for (const handler of handlers.parametersResolved) {
            handler(result);
          }
        },
        onProgress(phase, detail) {
          for (const handler of handlers.progress) {
            handler(phase, detail);
          }
        },
        onError(issues) {
          for (const handler of handlers.error) {
            handler(issues);
          }
        },
        onActiveKernelChanged(kernelId) {
          _activeKernelId = kernelId;
          for (const handler of handlers.activeKernel) {
            handler(kernelId);
          }
        },
        onCapabilitiesUpdated(capabilities) {
          _capabilities = capabilities;
          for (const handler of handlers.capabilities) {
            handler(capabilities);
          }
        },
      },
    );

    const kernelModules = kernels.map((k) => ({
      id: k.id,
      moduleUrl: k.moduleUrl,
      extensions: k.extensions,
      detectImport: k.detectImport?.source,
      builtinModuleNames: k.builtinModuleNames,
      options: k.options,
    }));

    const middlewareEntries = middleware.map((m) => ({
      url: m.moduleUrl,
      options: m.options,
    }));

    const bundlerEntries = bundlers.map((b) => ({
      bundlerModuleUrl: b.moduleUrl,
      extensions: b.extensions,
      options: b.options,
    }));

    const transcoderModules = transcoders.map((t) => ({
      id: t.id,
      moduleUrl: t.moduleUrl,
      options: t.options,
    }));

    let fileSystemPort: MessagePort;
    if ('port' in resolvedOptions) {
      fileSystemPort = resolvedOptions.port;
      connectedViaPort = true;
    } else {
      fileSystemBridge = createBridgePort(resolvedOptions.fileSystem);
      fileSystemPort = fileSystemBridge.port;
    }

    if (!poolsInitialized && options.sharedMemory) {
      try {
        const { geometry } = options.sharedMemory;
        if (geometry) {
          _geometryPoolBuffer = new SharedArrayBuffer(geometry.bytes);
          _geometryPool = new SharedPool(_geometryPoolBuffer, {
            maxEntries: geometry.maxEntries,
            maxEntryBytes: geometry.maxEntryBytes,
            eviction: geometry.eviction,
          });
        }
      } catch {
        // SAB unavailable (non-secure context or missing COEP/COOP headers).
        // All geometry transport falls back to inline postMessage delivery.
      }
      poolsInitialized = true;
    }

    await workerClient.initialize({
      options: { kernelModules },
      fileSystemPort,
      middlewareEntries,
      bundlerEntries,
      transcoderModules: transcoderModules.length > 0 ? transcoderModules : undefined,
      geometryPoolBuffer: _geometryPoolBuffer,
      filePoolBuffer: resolvedOptions.filePoolBuffer,
    });

    _capabilities = workerClient.capabilities;
    if (_capabilities) {
      for (const handler of handlers.capabilities) {
        handler(_capabilities);
      }
    }

    if (options.renderTimeout !== undefined) {
      workerClient.setRenderTimeout(options.renderTimeout * 1000);
    }

    connected = true;
    return workerClient;
  }

  function resolveGeometry(geo: GeometryTransport, geometryPool: SharedPool | undefined): Geometry {
    if (geo.format !== 'gltf') {
      return geo;
    }

    const { content, hash } = geo;
    if (content.delivery === 'inline') {
      return { format: 'gltf', content: content.bytes, hash };
    }

    const view = geometryPool?.resolveCopy(content.key);
    if (!view) {
      throw new Error(`SharedPool entry not found: key=${content.key}`);
    }
    return { format: 'gltf', content: view, hash };
  }

  function resolveTransportResult(
    transport: HashedGeometryResultTransport,
    geometryPool: SharedPool | undefined,
  ): HashedGeometryResult {
    if (!transport.success) {
      return transport;
    }

    return {
      ...transport,
      data: transport.data.map((geo) => resolveGeometry(geo, geometryPool)),
    };
  }

  function emitGeometry(result: HashedGeometryResult): void {
    for (const handler of handlers.geometry) {
      handler(result);
    }
  }

  async function executeRender(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
    client: RuntimeWorkerClient;
  }): Promise<HashedGeometryResult> {
    const transportResult = await input.client.render({
      file: input.file,
      parameters: input.parameters,
      onParametersResolved(parametersResult) {
        for (const handler of handlers.parametersResolved) {
          handler(parametersResult);
        }
      },
      onProgress(phase, detail) {
        for (const handler of handlers.progress) {
          handler(phase, detail);
        }
      },
      options: input.options,
    });
    const resolved = resolveTransportResult(transportResult, _geometryPool);
    emitGeometry(resolved);
    return resolved;
  }

  return {
    async connect(connectOptions: ConnectOptions): Promise<void> {
      await ensureConnected(connectOptions);
    },

    async render(input: CodeInput<Record<string, string>> | FileInput): Promise<HashedGeometryResult> {
      if (workerClient) {
        try {
          workerClient.cancelPendingRender();
        } catch {
          // Suppressed: the cancelled render's rejection is expected
        }
      }

      const { options } = input;
      const parameters = input.parameters ?? {};

      if (input.code) {
        if (connectedViaPort) {
          throw new Error(
            'Inline code rendering is not supported with port-based connections. Use file-mode rendering with a connected filesystem instead.',
          );
        }

        const { code } = input;
        const keys = Object.keys(code);

        const entryFile = (input as { file?: string }).file ?? keys[0]!;

        managedFileSystem ??= fromMemoryFS();

        const writeOperations = Object.entries(code).map(([filename, content]) => {
          const absolutePath = filename.startsWith('/') ? filename : `/${filename}`;
          return { absolutePath, content };
        });

        const absolutePaths = writeOperations.map(({ absolutePath }) => absolutePath);
        await Promise.all(
          writeOperations.map(async ({ absolutePath, content }) => managedFileSystem!.writeFile(absolutePath, content)),
        );

        const client = await ensureConnected({ fileSystem: managedFileSystem });
        client.notifyFileChanged(absolutePaths);

        const resolvedFile = resolveFileString(entryFile.startsWith('/') ? entryFile : `/${entryFile}`);

        return executeRender({
          file: resolvedFile,
          parameters,
          options,
          client,
        });
      }

      const fileInput = input;
      const client = await ensureConnected();

      const resolvedFile = typeof fileInput.file === 'string' ? resolveFileString(fileInput.file) : fileInput.file;

      return executeRender({
        file: resolvedFile,
        parameters,
        options,
        client,
      });
    },

    async export(
      format: FileExtension,
      inputOrOptions?: CodeInput<Record<string, string>> | FileInput | Record<string, unknown>,
    ): Promise<ExportResult> {
      let selfRendered = false;
      if (inputOrOptions && 'code' in inputOrOptions && inputOrOptions.code) {
        await this.render(inputOrOptions as CodeInput<Record<string, string>>);
        selfRendered = true;
      } else if (inputOrOptions && 'file' in inputOrOptions && inputOrOptions.file) {
        await this.render(inputOrOptions as FileInput);
        selfRendered = true;
      }

      const options = selfRendered ? undefined : (inputOrOptions as Record<string, unknown> | undefined);

      const client = await ensureConnected();
      const internalResult = await client.exportGeometry(format, options);
      if (internalResult.success) {
        return {
          success: true,
          data: internalResult.data[0]!,
          issues: internalResult.issues,
        };
      }

      return internalResult;
    },

    setFile(
      file: string | GeometryFile,
      parameters: Record<string, unknown> = {},
      options?: Record<string, unknown>,
    ): void {
      const resolvedFile = typeof file === 'string' ? resolveFileString(file) : file;
      workerClient?.setFile(resolvedFile, parameters, options);
    },

    setParameters(parameters: Record<string, unknown>): void {
      workerClient?.setParameters(parameters);
    },

    setRenderTimeout(seconds: number): void {
      workerClient?.setRenderTimeout(seconds * 1000);
    },

    notifyFileChanged(paths: string[]): void {
      workerClient?.notifyFileChanged(paths);
    },

    on(event: string, handler: (...args: never[]) => void): () => void {
      const set = handlers[event as keyof EventHandlers] as Set<(...args: never[]) => void> | undefined;
      if (!set) {
        throw new Error(`Unknown event: ${event}`);
      }

      set.add(handler);

      if (event === 'capabilities' && _capabilities !== undefined) {
        (handler as (manifest: CapabilitiesManifest) => void)(_capabilities);
      } else if (event === 'activeKernel' && _activeKernelId !== undefined) {
        (handler as (kernelId: string | undefined) => void)(_activeKernelId);
      }

      return () => {
        set.delete(handler);
      };
    },

    routesFor(format: FileExtension): readonly ExportRoute[] {
      if (!_capabilities) {
        return [];
      }
      return _capabilities.routes.filter((route) => route.targetFormat === format);
    },

    bestRouteFor(format: FileExtension, kernelId?: string): ExportRoute | undefined {
      if (!_capabilities) {
        return undefined;
      }
      const matches = _capabilities.routes.filter((route) => route.targetFormat === format);
      if (matches.length === 0) {
        return undefined;
      }

      const kernelMatches = kernelId ? matches.filter((route) => route.kernelId === kernelId) : matches;
      const candidates = kernelMatches.length > 0 ? kernelMatches : matches;

      const indexed = candidates.map((route, index) => ({ route, index }));
      indexed.sort((a, b) => {
        const fidelityDelta = fidelityRank(a.route.fidelity) - fidelityRank(b.route.fidelity);
        if (fidelityDelta !== 0) {
          return fidelityDelta;
        }
        const directnessDelta = directnessRank(a.route) - directnessRank(b.route);
        if (directnessDelta !== 0) {
          return directnessDelta;
        }
        return a.index - b.index;
      });

      return indexed[0]?.route;
    },

    /**
     * Capabilities manifest from the worker, available after initialization.
     *
     * SAFETY (R7): `_capabilities` stores the wide-default
     * `CapabilitiesManifest` emitted over the worker boundary. The public
     * overload of `createRuntimeClient` narrows the return to
     * `CapabilitiesManifest<Kernels, Transcoders>`. The narrowing is a
     * structural witness, not a lie — see the SAFETY block on
     * `createRuntimeClient` and the witness-narrowing tests in
     * `define-plugin.test-d.ts`.
     *
     * @returns Capabilities manifest from the worker
     */
    get capabilities() {
      return _capabilities;
    },

    /** Active kernel ID from the worker, available after the first render selects a kernel.
     * @returns Active kernel ID or undefined if no kernel is selected
     */
    get activeKernelId() {
      return _activeKernelId;
    },

    /**
     * Shared memory pool for zero-IPC geometry data exchange.
     * @returns Shared memory pool for zero-IPC geometry data exchange
     */
    get geometryPool() {
      return _geometryPool;
    },

    terminate(): void {
      workerClient?.cleanup();
      workerClient?.terminate();
      if (fileSystemBridge) {
        fileSystemBridge.dispose();
        fileSystemBridge = undefined;
      }

      for (const set of Object.values(handlers)) {
        set.clear();
      }

      workerClient = undefined;
      transport = undefined;
      managedFileSystem = undefined;
      connected = false;
      connectedViaPort = false;
    },
  };
}
