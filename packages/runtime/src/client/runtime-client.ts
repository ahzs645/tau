/**
 * RuntimeClient -- high-level, Promise-based facade for CAD kernel operations.
 *
 * Wraps a RuntimeWorkerClient with lazy initialization, event subscription,
 * and plugin configuration. This is the primary API for consumers.
 */

import type { GeometryFile, ExportFormat, ExportFile, LogOrigin } from '@taucad/types';
import type { HashedGeometryResult, GetParametersResult, KernelResult, KernelIssue } from '#types/runtime.types.js';
import type { RuntimeFileSystemBase, Tessellation } from '#types/runtime-kernel.types.js';
import type { PerformanceEntryData, RenderPhase, WorkerState } from '#types/runtime-protocol.types.js';
import { RuntimeWorkerClient } from '#framework/runtime-worker-client.js';
import type { BridgeHandle } from '#framework/runtime-filesystem-bridge.js';
import { createBridgePort } from '#framework/runtime-filesystem-bridge.js';
import { fromMemoryFS } from '#filesystem/from-memory-fs.js';
import { createWorkerTransport } from '#transport/worker-transport.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

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
  /** Tessellation quality override. */
  tessellation?: Tessellation;
  /** Not applicable in inline mode (client auto-manages). @internal */
  changedPaths?: never;
} & (string extends keyof T
  ? {
      /** Entry point filename. Required when key count is unknown at compile time. */ file: string;
    }
  : true extends IsUnion<keyof T>
    ? {
        /** Entry point filename. Required for multi-file code. */ file: string;
      }
    : {
        /** Entry point filename. Optional for single-file code (inferred from the only key). */ file?: string;
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
  /** Tessellation quality override. */
  tessellation?: Tessellation;
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
 * Options for creating a RuntimeClient.
 * @public
 */
export type RuntimeClientOptions = {
  /** Kernel plugins to register (order determines selection priority). */
  kernels: KernelPlugin[];
  /** Middleware plugins (order determines onion-model wrapping). */
  middleware?: MiddlewarePlugin[];
  /** Bundler plugins (multiple supported, routed by file extension). */
  bundlers?: BundlerPlugin[];
  /** Custom transport. Defaults to a Web Worker transport using the built-in worker URL. */
  transport?: RuntimeTransport;
  /**
   * Default RuntimeFileSystemBase, used when `connect()` is not called explicitly.
   * For browser apps that need deferred connection, use `client.connect()` instead.
   */
  fileSystem?: RuntimeFileSystemBase;
  /**
   * Tessellation quality defaults for preview and export pipelines.
   * When undefined, each kernel applies its own built-in defaults.
   * Per-call overrides via `callOptions.tessellation` take precedence.
   */
  tessellation?: {
    /** Tessellation quality for preview rendering (client.render). */
    preview?: Tessellation;
    /** Tessellation quality for file export (client.export). */
    export?: Tessellation;
  };
};

/**
 * Connection options for `RuntimeClient.connect()`.
 *
 * - `{ fileSystem }` -- main-thread relay: the client creates a MessagePort bridge internally.
 * - `{ port }` -- direct bridge: pass a pre-existing MessagePort (e.g., from `createFileSystemBridge`).
 * @public
 */
export type ConnectOptions =
  //
  { fileSystem: RuntimeFileSystemBase } | { port: MessagePort };

type LogEntry = {
  level: string;
  message: string;
  origin?: LogOrigin;
  data?: unknown;
};

type EventHandlers = {
  log: Set<(entry: LogEntry) => void>;
  progress: Set<(phase: RenderPhase, detail?: Record<string, unknown>) => void>;
  telemetry: Set<(entries: PerformanceEntryData[]) => void>;
  parametersResolved: Set<(result: GetParametersResult) => void>;
  geometry: Set<(result: HashedGeometryResult) => void>;
  state: Set<(state: WorkerState, detail?: string) => void>;
  error: Set<(issues: KernelIssue[]) => void>;
};

/**
 * High-level runtime client interface.
 * Lazy, Promise-based, event-subscribable.
 * @public
 */
export type RuntimeClient = {
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
  render<T extends Record<string, string>>(input: CodeInput<T>): Promise<HashedGeometryResult>;

  /**
   * Render geometry from the connected filesystem.
   *
   * `file` can be a string shorthand (e.g., `'/src/main.ts'`) or a `GeometryFile`.
   * Cache invalidation is handled automatically by the worker's filesystem watch subscription.
   *
   * Tessellation resolution: input.tessellation > options.tessellation.preview > undefined (kernel default).
   */
  render(input: FileInput): Promise<HashedGeometryResult>;

  /**
   * Export geometry from inline code (self-rendering).
   *
   * Internally renders the code first, then exports. The render uses the
   * client-level preview tessellation default; the export uses
   * `input.tessellation` or the client-level export default.
   */
  export<T extends Record<string, string>>(format: ExportFormat, input: CodeInput<T>): Promise<ExportResult>;

  /**
   * Export geometry from the connected filesystem (self-rendering).
   *
   * Internally renders the file first, then exports.
   */
  export(format: ExportFormat, input: FileInput): Promise<ExportResult>;

  /**
   * Export geometry from the last render in the specified format.
   *
   * Tessellation resolution: callOptions.tessellation > options.tessellation.export > undefined (kernel default).
   *
   * @param format - Export format (e.g., 'stl', 'step', '3mf')
   * @param callOptions - Per-call overrides
   * @param callOptions.tessellation - Optional tessellation quality override for this export
   * @returns Export result with a single ExportFile
   */
  export(format: ExportFormat, callOptions?: { tessellation?: Tessellation }): Promise<ExportResult>;

  /**
   * Set the active file for autonomous rendering (filesystem mode).
   * The worker will immediately render and then watch for file changes.
   *
   * @param file - File path string or GeometryFile
   * @param parameters - Parameters for the model
   * @param tessellation - Optional tessellation quality
   */
  setFile(file: string | GeometryFile, parameters?: Record<string, unknown>, tessellation?: Tessellation): void;

  /**
   * Update parameters for autonomous rendering (filesystem mode).
   * The worker debounces and re-renders with the new parameters.
   *
   * @param parameters - Updated parameters for the model
   */
  setParameters(parameters: Record<string, unknown>): void;

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

  /**
   * Terminate the worker and clean up all resources.
   */
  terminate(): void;
};

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
export function createRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  const { kernels, middleware = [], bundlers = [] } = options;

  let workerClient: RuntimeWorkerClient | undefined;
  let transport: RuntimeTransport | undefined;
  let fileSystemBridge: BridgeHandle | undefined;
  let connected = false;
  let connectedViaPort = false;
  let managedFileSystem: RuntimeFileSystemBase | undefined;

  const handlers: EventHandlers = {
    log: new Set(),
    progress: new Set(),
    telemetry: new Set(),
    parametersResolved: new Set(),
    geometry: new Set(),
    state: new Set(),
    error: new Set(),
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
        onGeometryComputed(result) {
          emitGeometry(result);
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

    let fileSystemPort: MessagePort;
    if ('port' in resolvedOptions) {
      fileSystemPort = resolvedOptions.port;
      connectedViaPort = true;
    } else {
      fileSystemBridge = createBridgePort(resolvedOptions.fileSystem);
      fileSystemPort = fileSystemBridge.port;
    }

    await workerClient.initialize({
      options: { kernelModules },
      fileSystemPort,
      middlewareEntries,
      bundlerEntries,
    });

    connected = true;
    return workerClient;
  }

  function emitGeometry(result: HashedGeometryResult): void {
    console.log('[RuntimeClient] emitGeometry', { success: result.success, handlerCount: handlers.geometry.size });
    for (const handler of handlers.geometry) {
      handler(result);
    }
  }

  async function executeRender(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    tessellation: Tessellation | undefined;
    client: RuntimeWorkerClient;
  }): Promise<HashedGeometryResult> {
    const result = await input.client.render({
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
      tessellation: input.tessellation,
    });
    emitGeometry(result);
    return result;
  }

  return {
    async connect(connectOptions: ConnectOptions): Promise<void> {
      await ensureConnected(connectOptions);
    },

    async render(input: CodeInput<Record<string, string>> | FileInput): Promise<HashedGeometryResult> {
      // Auto-cancel any in-flight render (latest-wins semantics)
      if (workerClient) {
        try {
          workerClient.cancelPendingRender();
        } catch {
          // Suppressed: the cancelled render's rejection is expected
        }
      }

      const tessellation = input.tessellation ?? options.tessellation?.preview;
      const parameters = input.parameters ?? {};

      if (input.code) {
        // --- Inline code mode ---
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
          tessellation,
          client,
        });
      }

      // --- Filesystem mode ---
      const fileInput = input;
      const client = await ensureConnected();

      const resolvedFile = typeof fileInput.file === 'string' ? resolveFileString(fileInput.file) : fileInput.file;

      return executeRender({
        file: resolvedFile,
        parameters,
        tessellation,
        client,
      });
    },

    async export(
      format: ExportFormat,
      inputOrOptions?: CodeInput<Record<string, string>> | FileInput | { tessellation?: Tessellation },
    ): Promise<ExportResult> {
      let selfRendered = false;
      if (inputOrOptions && 'code' in inputOrOptions && inputOrOptions.code) {
        await this.render(inputOrOptions);
        selfRendered = true;
      } else if (inputOrOptions && 'file' in inputOrOptions && inputOrOptions.file) {
        await this.render(inputOrOptions);
        selfRendered = true;
      }

      const tessellation = selfRendered
        ? options.tessellation?.export
        : ((inputOrOptions as { tessellation?: Tessellation } | undefined)?.tessellation ??
          options.tessellation?.export);

      const client = await ensureConnected();
      const internalResult = await client.exportGeometry(format, tessellation);
      if (internalResult.success) {
        return {
          success: true,
          data: internalResult.data[0]!,
          issues: internalResult.issues,
        };
      }

      return internalResult;
    },

    setFile(file: string | GeometryFile, parameters: Record<string, unknown> = {}, tessellation?: Tessellation): void {
      const resolvedFile = typeof file === 'string' ? resolveFileString(file) : file;
      const resolvedTessellation = tessellation ?? options.tessellation?.preview;
      workerClient?.setFile(resolvedFile, parameters, resolvedTessellation);
    },

    setParameters(parameters: Record<string, unknown>): void {
      workerClient?.setParameters(parameters);
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
      return () => {
        set.delete(handler);
      };
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
