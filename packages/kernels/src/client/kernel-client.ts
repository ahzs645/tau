/**
 * KernelClient -- high-level, Promise-based facade for CAD kernel operations.
 *
 * Wraps a KernelWorkerClient with lazy initialization, event subscription,
 * and plugin configuration. This is the primary API for consumers.
 */

import type { GeometryFile, ExportFormat, LogOrigin } from '@taucad/types';
import type { HashedGeometryResult, ExportGeometryResult, GetParametersResult } from '#types/kernel.types.js';
import type { KernelFileSystem, Tessellation } from '#types/kernel-worker.types.js';
import type { PerformanceEntryData, RenderPhase } from '#types/kernel-protocol.types.js';
import { KernelWorkerClient } from '#framework/kernel-worker-client.js';
import { createFileSystemPort } from '#framework/kernel-filesystem-bridge.js';
import { createWorkerTransport } from '#transport/worker-transport.js';
import type { KernelTransport } from '#transport/kernel-transport.js';
import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';

/**
 * Options for creating a KernelClient.
 */
export type KernelClientOptions = {
  /** Kernel plugins to register (order determines selection priority). */
  kernels: KernelPlugin[];
  /** Middleware plugins (order determines onion-model wrapping). */
  middleware?: MiddlewarePlugin[];
  /** Bundler plugins (multiple supported, routed by file extension). */
  bundlers?: BundlerPlugin[];
  /** Custom transport. Defaults to a Web Worker transport using the built-in worker URL. */
  transport?: KernelTransport;
  /**
   * Default KernelFileSystem, used when `connect()` is not called explicitly.
   * For browser apps that need deferred connection, use `client.connect()` instead.
   */
  fileSystem?: KernelFileSystem;
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
 * Connection options for `KernelClient.connect()`.
 *
 * - `{ fileSystem }` -- main-thread relay: the client creates a MessagePort bridge internally.
 * - `{ port }` -- direct bridge: pass a pre-existing MessagePort (e.g., from `createFileSystemBridge`).
 */
export type ConnectOptions =
  //
  { fileSystem: KernelFileSystem } | { port: MessagePort };

type LogEntry = { level: string; message: string; origin?: LogOrigin; data?: unknown };

type EventHandlers = {
  log: Set<(entry: LogEntry) => void>;
  progress: Set<(phase: RenderPhase, detail?: Record<string, unknown>) => void>;
  telemetry: Set<(entries: PerformanceEntryData[]) => void>;
  parametersResolved: Set<(result: GetParametersResult) => void>;
};

/**
 * High-level kernel client interface.
 * Lazy, Promise-based, event-subscribable.
 */
export type KernelClient = {
  /**
   * Connect to the kernel worker and initialize with a filesystem.
   *
   * @param options - Connection options: `{ fileSystem }` for main-thread relay, `{ port }` for direct bridge
   */
  connect(options: ConnectOptions): Promise<void>;

  /**
   * Render geometry from a file. Auto-connects if not yet connected.
   * If no kernel can handle the file, returns a result with `success: false`.
   *
   * Tessellation resolution: input.tessellation > options.tessellation.preview > undefined (kernel default).
   *
   * @param input - Render input containing file, parameters, and optional tessellation quality override
   * @param input.file - The geometry file to render
   * @param input.parameters - The parameters for rendering
   * @param input.tessellation - Optional tessellation quality override
   * @returns Completed geometry result
   */
  render(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    tessellation?: Tessellation;
  }): Promise<HashedGeometryResult>;

  /**
   * Export geometry in the specified format.
   *
   * Tessellation resolution: callOptions.tessellation > options.tessellation.export > undefined (kernel default).
   *
   * @param format - Export format (e.g., 'stl', 'step', '3mf')
   * @param callOptions - Per-call overrides
   * @param callOptions.tessellation - Optional tessellation quality override for this export
   * @returns Export result with blob data
   */
  export(format: ExportFormat, callOptions?: { tessellation?: Tessellation }): Promise<ExportGeometryResult>;

  /**
   * Notify the worker that files have changed (for cache invalidation).
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
  on(event: 'log', handler: (entry: LogEntry) => void): () => void;
  on(event: 'progress', handler: (phase: RenderPhase, detail?: Record<string, unknown>) => void): () => void;
  on(event: 'telemetry', handler: (entries: PerformanceEntryData[]) => void): () => void;
  on(event: 'parametersResolved', handler: (result: GetParametersResult) => void): () => void;

  /**
   * Terminate the worker and clean up all resources.
   */
  terminate(): void;
};

/**
 * Create a high-level kernel client.
 *
 * The client lazily creates the Worker and Transport on first `connect()` or `render()` call.
 * Plugin factory functions are used to configure kernels, middleware, and bundlers.
 *
 * @param options - Client configuration with plugin selections
 * @returns KernelClient instance
 *
 * @example
 * ```typescript
 * import { createKernelClient } from '@taucad/kernels';
 * import { replicad, openscad } from '@taucad/kernels/kernels';
 * import { geometryCache } from '@taucad/kernels/middleware';
 * import { esbuild } from '@taucad/kernels/bundler';
 *
 * const client = createKernelClient({
 *   kernels: [replicad(), openscad()],
 *   middleware: [geometryCache()],
 *   bundlers: [esbuild()],
 * });
 *
 * await client.connect({ fileSystem: myFileSystem });
 * const result = await client.render({ file, params });
 * ```
 */
export function createKernelClient(options: KernelClientOptions): KernelClient {
  const { kernels, middleware = [], bundlers = [] } = options;

  let workerClient: KernelWorkerClient | undefined;
  let transport: KernelTransport | undefined;
  let connected = false;

  const handlers: EventHandlers = {
    log: new Set(),
    progress: new Set(),
    telemetry: new Set(),
    parametersResolved: new Set(),
  };

  function getWorkerUrl(): string {
    return new URL('../framework/kernel-runtime-worker.js', import.meta.url).href;
  }

  async function ensureConnected(connectOptions?: ConnectOptions): Promise<KernelWorkerClient> {
    if (workerClient && connected) {
      return workerClient;
    }

    const resolvedOptions = connectOptions ?? (options.fileSystem ? { fileSystem: options.fileSystem } : undefined);

    if (!resolvedOptions) {
      throw new Error('KernelClient.connect() must be called with a fileSystem or port before rendering');
    }

    transport = options.transport ?? createWorkerTransport(getWorkerUrl());

    workerClient = new KernelWorkerClient(
      transport,
      (entry) => {
        for (const handler of handlers.log) {
          handler(entry);
        }
      },
      (entries) => {
        for (const handler of handlers.telemetry) {
          handler(entries);
        }
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

    const fileSystemPort =
      'port' in resolvedOptions ? resolvedOptions.port : createFileSystemPort(resolvedOptions.fileSystem);

    await workerClient.initialize({
      options: { kernelModules },
      fileSystemPort,
      middlewareEntries,
      bundlerEntries,
    });

    connected = true;
    return workerClient;
  }

  return {
    async connect(connectOptions: ConnectOptions): Promise<void> {
      await ensureConnected(connectOptions);
    },

    async render(input: {
      file: GeometryFile;
      parameters: Record<string, unknown>;
      tessellation?: Tessellation;
    }): Promise<HashedGeometryResult> {
      const client = await ensureConnected();
      const tessellation = input.tessellation ?? options.tessellation?.preview;
      return client.render({
        file: input.file,
        parameters: input.parameters,
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
        tessellation,
      });
    },

    async export(format: ExportFormat, callOptions?: { tessellation?: Tessellation }): Promise<ExportGeometryResult> {
      const client = await ensureConnected();
      const tessellation = callOptions?.tessellation ?? options.tessellation?.export;
      return client.exportGeometry(format, tessellation);
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
      workerClient = undefined;
      transport = undefined;
      connected = false;
    },
  };
}
