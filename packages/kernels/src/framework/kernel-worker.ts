import deepmerge from 'deepmerge';
import { logLevels } from '@taucad/types/constants';
import { joinPath } from '@taucad/utils/path';
import type { ExportFormat, GeometryFile, OnWorkerLog } from '@taucad/types';
import type {
  HashedGeometryResult,
  CreateGeometryResult,
  ExportGeometryResult,
  GetParametersResult,
  MiddlewareRegistrations,
  BundlerRegistration,
} from '#types/kernel.types.js';
import type {
  KernelFileSystem,
  KernelRuntime,
  KernelLogger,
  Tessellation,
  InitializeInput,
  GetParametersInput,
  CreateGeometryInput,
  GetDependenciesInput,
  CanHandleInput,
  ExportGeometryInput,
} from '#types/kernel-worker.types.js';
import type {
  KernelMiddlewareRuntime,
  CreateGeometryHandler,
  ExportGeometryHandler,
  GetParametersHandler,
} from '#types/kernel-middleware.types.js';
import type {
  KernelBundler,
  BuiltinModule,
  BundleResult,
  ExecuteResult,
  BundlerDefinition,
} from '#types/kernel-bundler.types.js';
import type {
  Dependency,
  FileDependency,
  MiddlewareDependency,
  FrameworkDependency,
  OptionDependency,
  ParameterDependency,
  AssetDependency,
} from '#types/kernel-dependency.types.js';
import type { PerformanceEntryData, RenderPhase } from '#types/kernel-protocol.types.js';
import { createFileSystemProxy } from '#framework/kernel-filesystem-bridge.js';
import { createKernelError } from '#framework/kernel-helpers.js';
import { hashBytes, hashString } from '#utils/hash.utils.js';
import { readFiles as fsReadFiles } from '#framework/filesystem-helpers.js';
import { KernelTracer } from '#framework/kernel-tracer.js';
import { WorkerTelemetryCollector } from '#framework/worker-telemetry.js';
import type { KernelMiddleware } from '#middleware/kernel-middleware.js';
import { createMiddlewareRuntime } from '#middleware/kernel-middleware.js';

const tauVersion = '0.1.0';

/**
 * A resolved middleware instance paired with its parsed options.
 */
export type ResolvedMiddleware = {
  middleware: KernelMiddleware;
  options: Record<string, unknown>;
  url: string;
  enabled: boolean;
};

/** Base class for kernel workers providing lifecycle, middleware, bundler, and caching infrastructure. */
export abstract class KernelWorker<Options extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * The supported export formats for the worker.
   */
  protected static readonly supportedExportFormats: ExportFormat[] = [];

  /**
   * Extract the file extension from a filename.
   * Returns the extension without the leading dot, or empty string if no extension.
   *
   * @param filename - The filename to extract the extension from.
   * @returns The file extension (e.g., 'ts', 'scad', 'kcl') or empty string.
   */
  protected static getFileExtension(filename: string): string {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
      return '';
    }

    return filename.slice(lastDotIndex + 1).toLowerCase();
  }

  /**
   * Extract the basename (filename without directory path) from a full path.
   *
   * @param filename - The full filename path (e.g., 'public/kcl-samples/bottle/main.kcl')
   * @returns Just the basename (e.g., 'main.kcl')
   */
  protected static getBasename(filename: string): string {
    const lastSlashIndex = filename.lastIndexOf('/');
    return lastSlashIndex === -1 ? filename : filename.slice(lastSlashIndex + 1);
  }

  /**
   * Convert an absolute path to a path relative to the project root.
   *
   * @param absolutePath - The full absolute path (e.g., '/projects/myproject/src/main.scad')
   * @param basePath - The project root path (e.g., '/projects/myproject')
   * @returns The relative path (e.g., 'src/main.scad')
   */
  protected static resolveToRelative(absolutePath: string, basePath: string): string {
    // Ensure basePath ends without a trailing slash for consistent behavior
    const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

    if (absolutePath.startsWith(`${normalizedBase}/`)) {
      return absolutePath.slice(normalizedBase.length + 1);
    }

    // If the path doesn't start with the base, return as-is
    return absolutePath;
  }

  /**
   * Resolve a path relative to the project root to an absolute path.
   *
   * @param relativePath - Path relative to project root
   * @param basePath - The project root path
   * @returns Absolute path
   */
  protected static resolveFromRoot(relativePath: string, basePath: string): string {
    return joinPath(basePath, relativePath);
  }

  /**
   * Framework-managed native geometry handle from the last successful createGeometry call.
   * Opaque to the framework -- typed by each kernel subclass.
   * Passed to exportGeometry so exports work regardless of cache state.
   */
  protected nativeHandle: unknown;

  /** Fully initialized bundlers keyed by file extension. Shared context across extensions of the same bundler. */
  protected loadedBundlers = new Map<string, { definition: BundlerDefinition; ctx: unknown }>();

  /**
   * The name of the worker.
   *
   * @example ReplicadWorker, TauWorker, ZooWorker.
   */
  protected abstract readonly name: string;

  /**
   * Pending bundler definitions awaiting context initialization, keyed by extension.
   * Definitions are loaded eagerly (during ensureLoadedBundler) but context creation
   * is deferred until first use, when the project path is known (after setBasePath).
   */
  private readonly pendingBundlerInits = new Map<
    string,
    { definition: BundlerDefinition; extensions: string[]; options?: Record<string, unknown> }
  >();

  /**
   * The options passed to the worker. These are specific to the kernel provider.
   * Private - concrete kernels receive options via initialize() input parameter.
   */
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Ensuring options is always available, useful for testing.
  private options: Options = {} as Options;

  /**
   * The function to call when a log is emitted.
   */
  private onLog: OnWorkerLog;

  /**
   * The base path for relative file operations.
   * Set via setBasePath() before performing operations that need relative path resolution.
   */
  private basePath = '';

  /**
   * The full relative path of the active file being processed.
   * Used for error locations to ensure FileLink can navigate correctly.
   * Set via setBasePath() from the original file.filename.
   */
  private activeFilePath = '';

  /**
   * The file manager instance.
   * Initialized via initialize() during worker setup.
   * Backed by a MessagePort bridge to the file-manager worker.
   * Private - use the filesystem property for all filesystem operations.
   */
  private fileManager: KernelFileSystem | undefined;

  /**
   * Internal filesystem instance.
   * Initialized via initialize() when fileSystemPort is provided.
   */
  private _filesystem: KernelFileSystem | undefined;

  /**
   * Internal logger instance.
   * Initialized via initialize() after onLog is set.
   */
  private _logger: KernelLogger | undefined;

  /**
   * Cache for asset content hashes to avoid repeated fetches.
   * Maps asset URL to its SHA-256 content hash.
   */
  private readonly assetHashCache = new Map<string, string>();

  private readonly fileHashCache = new Map<string, string>();
  private readonly fileContentCache = new Map<string, Uint8Array<ArrayBuffer> | string>();

  /**
   * Dynamically loaded middleware instances with their resolved configs.
   * Populated during initialize() and updated via configureMiddleware().
   */
  private resolvedMiddleware: ResolvedMiddleware[] = [];

  /**
   * Cache of already-imported middleware modules keyed by URL.
   * Prevents redundant network requests when reconfiguring middleware.
   */
  private readonly middlewareModuleCache = new Map<string, KernelMiddleware>();

  /**
   * Cached middleware loggers, keyed by middleware name.
   * Loggers are stateless closures -- safe to reuse across operations.
   */
  private readonly middlewareLoggerCache = new Map<string, KernelLogger>();

  /** Cached KernelRuntime instance -- invalidated on setBasePath */
  private cachedRuntime: KernelRuntime | undefined;

  /** Cached project root path -- invalidated on setBasePath */
  private cachedProjectRoot: string | undefined;

  /** Cached log origin object -- recreated only when activeFilePath changes */
  private cachedLogOrigin: { component: string; file: string } | undefined;
  private cachedLogOriginFile = '';

  /** Telemetry collector instance -- created on first use when setTelemetrySend is called */
  private telemetryCollector?: WorkerTelemetryCollector;

  /** Span tracer for hierarchical telemetry with explicit parent-child IDs */
  private readonly tracer = new KernelTracer();

  /** Progress callback set during render, used by entry methods to emit phase transitions */
  private onProgress?: (phase: RenderPhase) => void;

  /** Per-render bundle result cache. Cleared at the start of each render cycle. */
  private readonly bundleResultCache = new Map<string, BundleResult>();

  /** Per-render dependency computation cache. Cleared at the start of each render cycle. */
  private renderDependencyCache?: { hash: string; dependencies: Dependency[] };

  /** Cached KernelBundler facade exposed via KernelRuntime */
  private cachedBundlerFacade: KernelBundler | undefined;

  /** Pending module registrations queued before the bundler is loaded */
  private readonly pendingModuleRegistrations = new Map<string, BuiltinModule>();

  /** In-flight bundler initializations to coalesce concurrent callers for the same extension */
  private readonly bundlerInitInProgress = new Map<string, Promise<{ definition: BundlerDefinition; ctx: unknown }>>();

  /**
   * Unified filesystem interface for kernel workers.
   * Provides three path resolution contexts:
   * - Relative to basePath (current file's directory)
   * - Relative to project root (for dependency resolution)
   * - Absolute paths (for cache/middleware operations)
   *
   * @throws Error if accessed before initialize() completes with fileSystemPort
   */
  private get filesystem(): KernelFileSystem {
    if (!this._filesystem) {
      throw new Error('filesystem not available - initialize must complete first with fileSystemPort');
    }

    return this._filesystem;
  }

  /**
   * Logger interface for kernel workers.
   * Provides convenience methods that automatically inject the component name.
   *
   * @throws Error if accessed before initialize() completes
   */
  protected get logger(): KernelLogger {
    if (!this._logger) {
      throw new Error('logger not available - initialize must complete first');
    }

    return this._logger;
  }

  /**
   * The constructor for the worker.
   */
  public constructor() {
    this.onLog = () => {
      throw new Error('onLog must be initialized before use');
    };
  }

  /**
   * Entry point for initializing the worker. This is called once when the worker is created.
   * Handles common initialization logic and then calls the protected initialize method.
   *
   *
   * @param input - Initialization input containing callbacks, transferables, options, and middleware entries
   * @param input.callbacks - Object containing callback functions (proxied)
   * @param input.callbacks.onLog - The function to call when a log is emitted
   * @param input.transferables - Object containing transferable resources like MessagePorts
   * @param input.transferables.fileSystemPort - Optional MessagePort for direct communication with file-manager worker
   * @param input.options - The options passed to the worker, specific to the kernel provider
   * @param input.middlewareEntries - Ordered array of middleware registrations to load dynamically
   */
  public async initialize(input: {
    callbacks: { onLog: OnWorkerLog };
    transferables: { fileSystemPort?: MessagePort };
    options: Options;
    middlewareEntries: MiddlewareRegistrations;
  }): Promise<void> {
    this.onLog = input.callbacks.onLog;
    this.options = input.options;

    // Create logger (depends on onLog being set)
    this._logger = this.createLogger();

    // Register file manager and create filesystem if port is provided
    if (input.transferables.fileSystemPort) {
      this.fileManager = createFileSystemProxy(input.transferables.fileSystemPort);
      this._filesystem = this.createFilesystem();
    }

    const bootstrapSpan = this.tracer.startSpan('kernel.bootstrap');
    await this.loadMiddleware(input.middlewareEntries);

    const initSpan = this.tracer.startSpan('kernel.init', { kernel: this.constructor.name });
    await this.onInitialize({ options: this.options }, this.createRuntime());
    initSpan.end();
    bootstrapSpan.end();
  }

  /**
   * Get the supported export formats for the worker.
   *
   *
   * @returns The supported export formats.
   */
  public getExportFormats(): ExportFormat[] {
    return (this.constructor as typeof KernelWorker).supportedExportFormats;
  }

  /**
   * Entry point for cleaning up the worker. This is called when the worker is destroyed.
   * Handles common cleanup logic and then calls the protected cleanup method.
   *
   */
  /**
   * Set the telemetry send callback. Called by the dispatcher to wire up
   * telemetry before initialization. Creates the PerformanceObserver-based collector.
   */
  public setTelemetrySend(send: (entries: PerformanceEntryData[]) => void): void {
    this.telemetryCollector = new WorkerTelemetryCollector(send);
  }

  /** Flush any buffered telemetry entries to the main thread. */
  public flushTelemetry(): void {
    this.telemetryCollector?.flush();
  }

  /** Clean up worker state, native handles, and telemetry collector. */
  public async cleanup(): Promise<void> {
    this.assetHashCache.clear();
    this.nativeHandle = undefined;
    this.telemetryCollector?.dispose();
    this.telemetryCollector = undefined;
    await this.onCleanup();
  }

  /**
   * Entry point for checking if this worker can handle the given file.
   *
   *
   * @param file - The geometry file to check.
   * @returns True if this worker can handle the file, false otherwise.
   */
  public async canHandle(file: GeometryFile): Promise<boolean> {
    this.setBasePath(file);
    const basename = KernelWorker.getBasename(file.filename);
    const extension = KernelWorker.getFileExtension(basename);

    const input: CanHandleInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
      extension,
    };

    return this.onCanHandle(input, this.createRuntime());
  }

  /**
   * Entry point for extracting parameters from a file.
   * Handles base path setup, timing, and middleware application using onion model.
   *
   *
   * @param file - The geometry file to extract parameters from.
   * @returns The extracted parameters.
   */
  public async getParameters(file: GeometryFile): Promise<GetParametersResult> {
    this.setBasePath(file);
    const start = performance.now();

    const input: GetParametersInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
    };

    const resolvedArray = this.getMiddleware();

    this.onProgress?.('resolvingDeps');
    const depsSpan = this.tracer.startSpan('kernel.resolve-deps', { phase: 'resolvingDeps' });
    const dependencies = await this.computeDependencies({ resolvedMiddleware: resolvedArray });
    const dependencyHash = this.computeDependencyHash(dependencies);
    depsSpan.end();

    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const { middleware, options: middlewareOptions, enabled } of resolvedArray) {
      if (enabled && middleware.wrapGetParameters) {
        runtimes.set(
          middleware.name,
          createMiddlewareRuntime({
            onLog: this.onLog,
            middlewareName: middleware.name,
            filesystem: this.filesystem,
            dependencies,
            dependencyHash,
            stateSchema: middleware.stateSchema,
            options: middlewareOptions,
            logger: this.getMiddlewareLogger(middleware.name),
          }),
        );
      }
    }

    this.onProgress?.('extractingParams');
    const { tracer } = this;
    let chain: GetParametersHandler = async (handlerInput: GetParametersInput) => {
      const parametersSpan = tracer.startSpan('kernel.extract-params', { phase: 'extractingParams' });
      const result = await this.onGetParameters(handlerInput, this.createRuntime());
      parametersSpan.end();
      return result;
    };

    for (let i = resolvedArray.length - 1; i >= 0; i--) {
      const { middleware, enabled } = resolvedArray[i]!;
      if (enabled && middleware.wrapGetParameters) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapGetParameters;

        chain = async (handlerInput: GetParametersInput) => {
          const span = tracer.startSpan(`middleware.wrap(${middlewareName})`, {
            middleware: middlewareName,
          });
          try {
            const result = await wrapHook(handlerInput, inner, runtime);
            span.end();
            return result;
          } catch (error) {
            span.end();
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Middleware failed', { data: { name: middlewareName, error: errorMessage } });
            return createKernelError([
              {
                message: `Middleware error in ${middlewareName}: ${errorMessage}`,
                type: 'kernel',
                severity: 'error',
              },
            ]);
          }
        };
      }
    }

    const result = await chain(input);

    this.logger.debug('getParameters completed', { data: { ms: performance.now() - start } });

    return result;
  }

  /**
   * Entry point for computing geometry from a file.
   * Handles base path setup, timing, and middleware application using onion model.
   *
   * Middleware wraps around each other (onion model), so:
   * - Code before handler() runs on the "request journey" (outside-in)
   * - Code after handler() runs on the "response journey" (inside-out)
   * - Short-circuited results still flow through upstream middleware post-processing
   *
   *
   * @param entry - The geometry entry containing file, parameters, and optional tessellation
   * @param entry.file - The geometry file to compute geometry from
   * @param entry.parameters - The parameters to use when computing geometry
   * @param entry.tessellation - Optional tessellation quality for preview rendering
   * @returns The computed geometry.
   */
  public async createGeometry(entry: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    tessellation?: Tessellation;
  }): Promise<HashedGeometryResult> {
    this.setBasePath(entry.file);
    const start = performance.now();

    const input: CreateGeometryInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
      parameters: entry.parameters,
      tessellation: entry.tessellation,
    };

    const resolvedArray = this.getMiddleware();

    const geoDepsSpan = this.tracer.startSpan('kernel.resolve-deps', { phase: 'resolvingDeps' });
    const dependencies = await this.computeDependencies({
      parameters: entry.parameters,
      resolvedMiddleware: resolvedArray,
    });
    const dependencyHash = this.computeDependencyHash(dependencies);
    geoDepsSpan.end();

    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const { middleware, options: middlewareOptions, enabled } of resolvedArray) {
      if (enabled && middleware.wrapCreateGeometry) {
        runtimes.set(
          middleware.name,
          createMiddlewareRuntime({
            onLog: this.onLog,
            middlewareName: middleware.name,
            filesystem: this.filesystem,
            dependencies,
            dependencyHash,
            stateSchema: middleware.stateSchema,
            options: middlewareOptions,
            logger: this.getMiddlewareLogger(middleware.name),
          }),
        );
      }
    }

    this.onProgress?.('computingGeometry');
    const { tracer } = this;
    let chain: CreateGeometryHandler = async (handlerInput: CreateGeometryInput) => {
      const computeSpan = tracer.startSpan('kernel.compute');
      const result = await this.onCreateGeometry(handlerInput, this.createRuntime());
      computeSpan.end();
      return result;
    };

    for (let i = resolvedArray.length - 1; i >= 0; i--) {
      const { middleware, enabled } = resolvedArray[i]!;
      if (enabled && middleware.wrapCreateGeometry) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapCreateGeometry;

        chain = async (handlerInput: CreateGeometryInput) => {
          const span = tracer.startSpan(`middleware.wrap(${middlewareName})`, {
            middleware: middlewareName,
          });
          try {
            const result = await wrapHook(handlerInput, inner, runtime);
            span.end();
            return result;
          } catch (error) {
            span.end();
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Middleware failed', { data: { name: middlewareName, error: errorMessage } });
            return createKernelError([
              {
                message: `Middleware error in ${middlewareName}: ${errorMessage}`,
                type: 'kernel',
                severity: 'error',
              },
            ]);
          }
        };
      }
    }

    const internalResult = await chain(input);

    this.onProgress?.('postProcessing');
    // Dependency hash + index is sufficient for unique React keys
    const result: HashedGeometryResult = internalResult.success
      ? {
          ...internalResult,
          data: internalResult.data.map((geometry, index) => ({
            ...geometry,
            hash: `${dependencyHash}-${index}`,
          })),
        }
      : internalResult;

    this.logger.debug('createGeometry completed', { data: { ms: performance.now() - start } });

    // Transferable extraction is handled by the dispatcher (extractGltfTransferables)
    return result;
  }

  /**
   * Entry point for exporting geometry.
   * Handles timing and middleware application using onion model.
   *
   * Middleware wraps around each other (onion model), so:
   * - Code before handler() runs on the "request journey" (outside-in)
   * - Code after handler() runs on the "response journey" (inside-out)
   * - Short-circuited results still flow through upstream middleware post-processing
   *
   * @param fileType - The file type to export the geometry as.
   * @param tessellation - Optional tessellation quality for export meshing.
   * @returns The exported geometry.
   */
  public async exportGeometry(fileType: ExportFormat, tessellation?: Tessellation): Promise<ExportGeometryResult> {
    const exportSpan = this.tracer.startSpan('kernel.export', { format: fileType });

    const input: ExportGeometryInput = {
      fileType,
      tessellation,
      nativeHandle: this.nativeHandle,
    };

    const resolvedArray = this.getMiddleware();
    const activeMiddleware = resolvedArray.filter(
      ({ middleware, enabled }) => enabled && middleware.wrapExportGeometry,
    );

    let result: ExportGeometryResult;

    if (activeMiddleware.length === 0) {
      const computeSpan = this.tracer.startSpan('kernel.export-compute');
      result = await this.onExportGeometry(input, this.createRuntime());
      computeSpan.end();
    } else {
      const depsSpan = this.tracer.startSpan('kernel.resolve-deps', { phase: 'resolvingDeps' });
      const dependencies = await this.computeDependencies({ resolvedMiddleware: resolvedArray });
      const dependencyHash = this.computeDependencyHash(dependencies);
      depsSpan.end();

      const runtimes = new Map<string, KernelMiddlewareRuntime>();
      for (const { middleware, options: middlewareOptions } of activeMiddleware) {
        runtimes.set(
          middleware.name,
          createMiddlewareRuntime({
            onLog: this.onLog,
            middlewareName: middleware.name,
            filesystem: this.filesystem,
            dependencies,
            dependencyHash,
            stateSchema: middleware.stateSchema,
            options: middlewareOptions,
            logger: this.getMiddlewareLogger(middleware.name),
          }),
        );
      }

      const { tracer } = this;
      let chain: ExportGeometryHandler = async (handlerInput: ExportGeometryInput) => {
        const computeSpan = tracer.startSpan('kernel.export-compute');
        const exportResult = await this.onExportGeometry(handlerInput, this.createRuntime());
        computeSpan.end();
        return exportResult;
      };

      for (let index = activeMiddleware.length - 1; index >= 0; index--) {
        const { middleware } = activeMiddleware[index]!;
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapExportGeometry!;

        chain = async (handlerInput: ExportGeometryInput) => {
          const span = tracer.startSpan(`middleware.wrap(${middlewareName})`, {
            middleware: middlewareName,
          });
          try {
            const chainResult = await wrapHook(handlerInput, inner, runtime);
            span.end();
            return chainResult;
          } catch (error) {
            span.end();
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error('Middleware failed', { data: { name: middlewareName, error: errorMessage } });
            return createKernelError([
              {
                message: `Middleware error in ${middlewareName}: ${errorMessage}`,
                type: 'kernel',
                severity: 'error',
              },
            ]);
          }
        };
      }

      result = await chain(input);
    }

    exportSpan.end();

    return result;
  }

  /**
   * Get the resolved middleware array for this worker.
   * Override in subclasses to customize middleware (e.g., for testing).
   *
   *
   * @returns Array of resolved middleware with their configs
   */
  public getMiddleware(): ResolvedMiddleware[] {
    return this.resolvedMiddleware;
  }

  /**
   * Reconfigure middleware at runtime without re-importing already loaded modules.
   * New URLs are imported, removed URLs are dropped, existing URLs get config updates.
   *
   *
   * @param entries - New middleware configuration to apply
   */
  public async configureMiddleware(entries: MiddlewareRegistrations): Promise<void> {
    await this.loadMiddleware(entries);
    this.logger.debug('Middleware reconfigured', { data: { count: this.resolvedMiddleware.length } });
  }

  /**
   * Unified render entry point that combines parameter extraction and geometry computation
   * in a single call. This eliminates redundant dependency computation, bundling, and hashing
   * between the two operations.
   *
   * @param input - Render input containing file, parameters, and optional callbacks
   * @param input.file - The geometry file to render
   * @param input.parameters - User-provided parameters
   * @param input.onParametersResolved - Optional callback to stream parameters back while geometry computes
   * @param input.onProgress - Optional callback for render phase progress
   * @param input.tessellation - Optional tessellation quality override
   * @returns The computed geometry
   */
  public async render(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: (phase: RenderPhase) => void;
    tessellation?: Tessellation;
  }): Promise<HashedGeometryResult> {
    this.tracer.reset();
    const renderSpan = this.tracer.startSpan('kernel.render', { file: input.file.filename });
    this.onProgress = input.onProgress;
    this.renderDependencyCache = undefined;
    this.setBasePath(input.file);

    const parametersResult = await this.getParameters(input.file);
    input.onParametersResolved?.(parametersResult);

    let mergedParameters = input.parameters;
    if (parametersResult.success) {
      const extracted = parametersResult.data as { defaultParameters?: Record<string, unknown> };
      if (extracted.defaultParameters) {
        mergedParameters = deepmerge(extracted.defaultParameters, input.parameters);
      }
    }

    const result = await this.createGeometry({
      file: input.file,
      parameters: mergedParameters,
      tessellation: input.tessellation,
    });
    this.onProgress = undefined;
    renderSpan.end();
    return result;
  }

  /**
   * Selectively invalidate file caches for changed paths.
   * Called by the kernel machine before render operations when files have changed.
   *
   * @param changedPaths - Absolute paths of files that changed
   */
  public async notifyFileChanged(changedPaths: string[]): Promise<void> {
    for (const path of changedPaths) {
      this.fileHashCache.delete(path);
      this.fileContentCache.delete(path);
      this.fileContentCache.delete(`utf8:${path}`);
    }

    for (const [entryPath, result] of this.bundleResultCache) {
      if (result.dependencies.some((dep) => changedPaths.includes(dep))) {
        this.bundleResultCache.delete(entryPath);
      }
    }

    this.onFileChanged(changedPaths);
  }

  /**
   * Load the bundler definition from its URL (or use a preloaded one).
   * Context initialization is deferred until first use via ensureBundlerContext(),
   * because the project path is not known until setBasePath() runs.
   *
   * @param bundlerEntry - Bundler registration with module URL and extensions
   * @param preloadedDefinition - Optional pre-loaded definition (bypasses dynamic import; used in tests)
   */
  public async ensureLoadedBundler(
    bundlerEntry: BundlerRegistration,
    preloadedDefinition?: BundlerDefinition,
  ): Promise<void> {
    const initSpan = this.tracer.startSpan('kernel.bundler-init');

    try {
      let definition: BundlerDefinition;
      if (preloadedDefinition) {
        definition = preloadedDefinition;
      } else {
        const mod: Record<string, unknown> = (await import(/* @vite-ignore */ bundlerEntry.bundlerModuleUrl)) as Record<
          string,
          unknown
        >;
        definition = (mod['default'] ?? mod) as BundlerDefinition;
      }

      const { extensions } = bundlerEntry;
      for (const ext of extensions) {
        if (!this.loadedBundlers.has(ext) && !this.pendingBundlerInits.has(ext)) {
          this.pendingBundlerInits.set(ext, { definition, extensions, options: bundlerEntry.options });
        }
      }
    } finally {
      initSpan.end();
    }
  }

  /**
   * Whether a bundler is available for the given file extension.
   * Used by subclasses to decide whether bundler-assisted detection is available.
   *
   * @param ext - File extension without dot (e.g. 'ts', 'js')
   */
  protected hasBundlerForExtension(ext: string): boolean {
    return this.loadedBundlers.has(ext) || this.pendingBundlerInits.has(ext);
  }

  /**
   * Whether any bundler has been registered (loaded or pending).
   */
  protected get hasBundlerAvailable(): boolean {
    return this.loadedBundlers.size > 0 || this.pendingBundlerInits.size > 0;
  }

  /**
   * Ensure the bundler for a specific file extension is fully initialized.
   * Call this before any operation that needs the bundler (bundle, execute, detectImports).
   * Must be called after setBasePath() so that getProjectRootPath() returns the correct value.
   *
   * Use this when the file extension is known and the correct bundler must be selected.
   * Use ensureBundlerContext() for extension-agnostic contexts where any bundler will do.
   *
   * @param ext - File extension without dot
   * @returns The loaded bundler for the extension
   */
  protected async ensureBundlerForExtension(ext: string): Promise<{ definition: BundlerDefinition; ctx: unknown }> {
    const existing = this.loadedBundlers.get(ext);
    if (existing) {
      return existing;
    }

    const inFlight = this.bundlerInitInProgress.get(ext);
    if (inFlight) {
      return inFlight;
    }

    const pending = this.pendingBundlerInits.get(ext);
    if (!pending) {
      throw new Error(`No bundler registered for .${ext} files`);
    }

    const promise = this.doInitializeBundler(pending);

    for (const extension of pending.extensions) {
      this.bundlerInitInProgress.set(extension, promise);
    }

    try {
      return await promise;
    } finally {
      for (const extension of pending.extensions) {
        this.bundlerInitInProgress.delete(extension);
      }
    }
  }

  /**
   * Ensure any bundler context is initialized (for extension-agnostic contexts where any bundler will do).
   * Initializes the first pending bundler found.
   *
   * Use this when the file extension is unknown (e.g., the execute() function in createRuntime()).
   * Use ensureBundlerForExtension() when the file extension is known and the correct bundler must be selected.
   */
  protected async ensureBundlerContext(): Promise<void> {
    if (this.loadedBundlers.size > 0) {
      return;
    }

    const firstEntry = this.pendingBundlerInits.entries().next();
    if (firstEntry.done) {
      throw new Error('No bundler loaded - call ensureLoadedBundler() first');
    }

    await this.ensureBundlerForExtension(firstEntry.value[0]);
  }

  /**
   * Hook called after file change notification.
   * Subclasses can override to perform additional invalidation (e.g., selection cache).
   */
  protected onFileChanged(_changedPaths: string[]): void {
    // Default: no-op. KernelRuntimeWorker overrides to clear selectionCache.
  }

  /**
   * Worker-specific initialization. Override this method to add custom initialization logic.
   * No need to call super.initialize() - common initialization is handled by initialize.
   *
   * @param _input - Input containing worker options
   * @param _runtime - Runtime services (filesystem, logger)
   */
  protected async onInitialize(_input: InitializeInput<Options>, _runtime: KernelRuntime): Promise<void> {
    // Base implementation - can be overridden by subclasses
  }

  /**
   * Worker-specific cleanup. Override this method to add custom cleanup logic.
   * No need to call super.cleanup() - common cleanup is handled by cleanup.
   *
   * This can be used to release memory, close connections, etc.
   */
  protected async onCleanup(): Promise<void> {
    // Base implementation - can be overridden by subclasses
  }

  /**
   * Get the absolute path of the active file.
   * Combines project root with activeFilePath.
   */
  private get activeFileAbsolutePath(): string {
    return KernelWorker.resolveFromRoot(this.activeFilePath, this.getProjectRootPath());
  }

  /**
   * Get bundled asset URLs (fonts, WASM, etc.) for cache key computation.
   * Override in kernels that use bundled assets.
   *
   * URLs from Vite ?url imports contain content hashes in production.
   * In development, the asset content is fetched and hashed directly.
   *
   * @returns Array of asset URLs to include in dependency hash
   */
  protected getAssetUrls(): string[] {
    return [];
  }

  /**
   * Get the project root path by stripping the subdirectory from basePath.
   * For basePath '/builds/test/site' with activeFilePath 'site/main.scad',
   * returns '/builds/test'.
   *
   * @returns The project root path
   */
  protected getProjectRootPath(): string {
    if (this.cachedProjectRoot !== undefined) {
      return this.cachedProjectRoot;
    }

    const lastSlash = this.activeFilePath.lastIndexOf('/');
    const subDirectory = lastSlash === -1 ? '' : this.activeFilePath.slice(0, lastSlash);

    this.cachedProjectRoot =
      subDirectory && this.basePath.endsWith(`/${subDirectory}`)
        ? this.basePath.slice(0, -(subDirectory.length + 1))
        : this.basePath;

    return this.cachedProjectRoot;
  }

  /**
   * Check if this kernel can handle a file.
   *
   * @param input - Input containing file path, project root, and extension
   * @param runtime - Runtime services (filesystem, logger)
   * @returns True if the kernel can handle this file
   */
  protected abstract onCanHandle(input: CanHandleInput, runtime: KernelRuntime): Promise<boolean>;

  /**
   * Extract parameters from a file.
   *
   * @param input - Input containing file path and project root
   * @param runtime - Runtime services (filesystem, logger)
   * @returns The extracted parameters.
   */
  protected abstract onGetParameters(input: GetParametersInput, runtime: KernelRuntime): Promise<GetParametersResult>;

  /**
   * Compute geometry from a file.
   *
   * @param input - Input containing file path, project root, parameters, and geometry ID
   * @param runtime - Runtime services (filesystem, logger)
   * @returns The computed geometry.
   */
  protected abstract onCreateGeometry(
    input: CreateGeometryInput,
    runtime: KernelRuntime,
  ): Promise<CreateGeometryResult>;

  /**
   * Export geometry using the framework-stored native handle from the last createGeometry call.
   *
   * @param input - Input containing file type and mesh config
   * @param runtime - Runtime services (filesystem, logger)
   * @param nativeHandle - Opaque native geometry data stored by the framework after createGeometry
   * @returns The exported geometry.
   */
  protected abstract onExportGeometry(
    input: ExportGeometryInput,
    runtime: KernelRuntime,
  ): Promise<ExportGeometryResult>;

  /**
   * Discover all file dependencies for the given entry file.
   * Used for cache key computation to include all imported/included files.
   *
   * @param input - Input containing file path and project root
   * @param runtime - Runtime services (filesystem, logger)
   * @returns Array of absolute file paths that are dependencies (including the entry file)
   */
  protected abstract onGetDependencies(input: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]>;

  /**
   * Perform the actual bundler context initialization.
   * Separated from ensureBundlerForExtension so concurrent callers coalesce on the same promise.
   */
  private async doInitializeBundler(pending: {
    definition: BundlerDefinition;
    extensions: string[];
    options?: Record<string, unknown>;
  }): Promise<{ definition: BundlerDefinition; ctx: unknown }> {
    const { definition, extensions, options: bundlerOptions } = pending;
    const projectPath = this.getProjectRootPath();
    const initSpan = this.tracer.startSpan('kernel.bundler-context-init');

    try {
      const rawOptions = bundlerOptions ?? {};
      const validatedOptions = definition.optionsSchema ? definition.optionsSchema.parse(rawOptions) : rawOptions;

      const ctx = await definition.initialize({ filesystem: this.filesystem, projectPath }, validatedOptions);
      const loaded = { definition, ctx };

      for (const extension of extensions) {
        this.loadedBundlers.set(extension, loaded);
        this.pendingBundlerInits.delete(extension);
      }

      for (const [name, entry] of this.pendingModuleRegistrations) {
        definition.registerModule(name, entry, ctx);
      }

      if (this.pendingBundlerInits.size === 0) {
        this.pendingModuleRegistrations.clear();
      }

      return loaded;
    } finally {
      initSpan.end();
    }
  }

  /**
   * Load middleware modules from URLs and resolve their configs.
   * Uses a module cache to avoid redundant network requests when reconfiguring.
   *
   * @param middlewareEntries - Ordered array of middleware entries
   */
  private async loadMiddleware(middlewareEntries: MiddlewareRegistrations): Promise<void> {
    const middlewareSpan = this.tracer.startSpan('kernel.load-middleware', { count: middlewareEntries.length });

    try {
      const resolved: ResolvedMiddleware[] = [];

      for (const entry of middlewareEntries) {
        // eslint-disable-next-line no-await-in-loop -- Middleware must be loaded sequentially to preserve order
        const middleware = await this.importMiddlewareModule(entry.url);

        const resolvedOptions = middleware.optionsSchema
          ? (middleware.optionsSchema.parse(entry.options ?? {}) as Record<string, unknown>)
          : {};

        const enabled = entry.enabled ?? middleware.enabled ?? true;

        resolved.push({ middleware, options: resolvedOptions, url: entry.url, enabled });
      }

      this.resolvedMiddleware = resolved;
    } finally {
      middlewareSpan.end();
    }
  }

  /**
   * Import a middleware module, using the cache to avoid redundant imports.
   *
   * @param url - URL of the middleware module
   * @returns The middleware instance
   */
  private async importMiddlewareModule(url: string): Promise<KernelMiddleware> {
    const cached = this.middlewareModuleCache.get(url);
    if (cached) {
      return cached;
    }

    const mod: Record<string, unknown> = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    const middleware = this.resolveMiddlewareExport(mod);

    this.middlewareModuleCache.set(url, middleware);
    return middleware;
  }

  /**
   * Resolve the middleware export from a dynamically imported module.
   * Checks for a default export first, then looks for the first export
   * that has a `name` property (duck-typed as KernelMiddleware).
   *
   * @param mod - The imported module
   * @returns The resolved middleware instance
   */
  private resolveMiddlewareExport(mod: Record<string, unknown>): KernelMiddleware {
    if (mod['default'] && typeof mod['default'] === 'object' && 'name' in mod['default']) {
      return mod['default'] as KernelMiddleware;
    }

    for (const value of Object.values(mod)) {
      if (typeof value === 'object' && value !== null && 'name' in value) {
        return value as KernelMiddleware;
      }
    }

    throw new Error('Middleware module does not export a valid KernelMiddleware');
  }

  /**
   * Create the unified filesystem interface.
   * Called during initialize() after fileManager is set up.
   * All methods use absolute paths - callers use helper methods to construct paths.
   *
   * @returns KernelFileSystem instance with the 8 Node.js-compatible primitives
   */
  private createFilesystem(): KernelFileSystem {
    const fileManager = this.fileManager!;
    const { tracer } = this;

    function readFile(path: string, encoding: 'utf8'): Promise<string>;
    function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
    async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
      const span = tracer.startSpan('fs.read', { path });
      const data = encoding ? await fileManager.readFile(path, encoding) : await fileManager.readFile(path);
      span.end();
      return data;
    }

    return {
      readFile,

      async exists(path: string): Promise<boolean> {
        const span = tracer.startSpan('fs.exists', { path });
        const fileExists = await fileManager.exists(path);
        span.end();
        return fileExists;
      },

      async readdir(path: string): Promise<string[]> {
        const span = tracer.startSpan('fs.readdir', { path });
        const entries = await fileManager.readdir(path);
        span.end();
        return entries;
      },

      writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string) => fileManager.writeFile(path, data),
      mkdir: async (path: string, options?: { recursive?: boolean }) => fileManager.mkdir(path, options),
      unlink: async (path: string) => fileManager.unlink(path),
      stat: async (path: string) => fileManager.stat(path),
    };
  }

  /**
   * Compute all dependencies for cache key computation.
   * Gathers file dependencies, middleware signatures, framework version, kernel options,
   * parameters (for geometry computation), and bundled assets.
   *
   * @param input - Input containing optional parameters and resolved middleware for dependency computation
   * @param input.parameters - Optional parameters (included for geometry computation, omitted for parameter extraction)
   * @param input.resolvedMiddleware - Resolved middleware array for dependency signatures
   * @returns Array of all dependencies
   */
  private async computeDependencies(input: {
    parameters?: Record<string, unknown>;
    resolvedMiddleware?: ResolvedMiddleware[];
  }): Promise<Dependency[]> {
    // Use cached base deps within a render cycle (file discovery + hashing is expensive)
    let baseDeps: Dependency[];
    if (this.renderDependencyCache) {
      baseDeps = this.renderDependencyCache.dependencies;
    } else {
      baseDeps = await this.computeBaseDependencies(input.resolvedMiddleware);
      // Cache for reuse by createGeometry within the same render cycle
      this.renderDependencyCache = { hash: '', dependencies: baseDeps };
    }

    if (input.parameters === undefined) {
      return baseDeps;
    }

    // Add parameter dependency for geometry computation
    const parameterDep: ParameterDependency = { type: 'parameter' as const, parameters: input.parameters };
    return [...baseDeps, parameterDep];
  }

  /**
   * Compute all non-parameter dependencies. Factored out so the result
   * can be cached for the duration of a render cycle (shared between
   * getParameters and createGeometry).
   */
  private async computeBaseDependencies(resolvedMiddleware?: ResolvedMiddleware[]): Promise<Dependency[]> {
    // 1. Discover file dependencies from kernel module
    const discoverSpan = this.tracer.startSpan('deps.discover');
    const discoverInput: GetDependenciesInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
    };
    const absolutePaths = await this.onGetDependencies(discoverInput, this.createRuntime());
    discoverSpan.end();

    // 2. Read uncached files
    const uncachedPaths = absolutePaths.filter((p) => !this.fileHashCache.has(p));
    if (uncachedPaths.length > 0) {
      const readSpan = this.tracer.startSpan('deps.read', { fileCount: uncachedPaths.length });
      const contentMap = await fsReadFiles(this.filesystem, uncachedPaths);
      readSpan.end();

      const hashSpan = this.tracer.startSpan('deps.hash', { fileCount: uncachedPaths.length });
      for (const [path, content] of Object.entries(contentMap)) {
        this.fileHashCache.set(path, this.hashContent(content));
        this.fileContentCache.set(path, content);
      }

      hashSpan.end();
    }

    // Contract: getDependencies() must return paths in deterministic order.
    const fileDeps: FileDependency[] = absolutePaths.map((absolutePath) => ({
      type: 'file' as const,
      path: absolutePath,
      contentHash: this.fileHashCache.get(absolutePath)!,
    }));

    // 2. Middleware dependencies (only enabled, index preserves chain order)
    const middleware = resolvedMiddleware ?? this.getMiddleware();
    const middlewareDeps: MiddlewareDependency[] = middleware
      .filter(({ enabled }) => enabled)
      .map(({ middleware: mw, options: mwOptions }, index) => ({
        type: 'middleware' as const,
        name: mw.name,
        version: mw.version ?? '1',
        index,
        options: mwOptions,
      }));

    // 3. Framework dependency
    const frameworkDep: FrameworkDependency = {
      type: 'framework' as const,
      name: 'tau',
      version: tauVersion,
    };

    // 4. Options dependencies (options are stable between renders, no sort needed)
    const optionDeps: OptionDependency[] = Object.entries(this.options).map(([key, value]) => ({
      type: 'option' as const,
      key,
      value,
    }));

    // 5. Asset dependencies (fonts, WASM, etc.)
    const assetUrls = this.getAssetUrls();
    const assetDeps: AssetDependency[] = assetUrls.map((urlOrVersion, index) => ({
      type: 'asset' as const,
      name: `asset-${index}`,
      contentHash: this.hashAssetUrl(urlOrVersion),
    }));

    return [...fileDeps, ...middlewareDeps, frameworkDep, ...optionDeps, ...assetDeps];
  }

  /**
   * Create a KernelLogger for use in kernel methods.
   * The logger automatically injects the kernel name as the component.
   *
   * @returns KernelLogger instance
   */
  private getLogOrigin(): { component: string; file: string } {
    if (!this.cachedLogOrigin || this.cachedLogOriginFile !== this.activeFilePath) {
      this.cachedLogOriginFile = this.activeFilePath;
      this.cachedLogOrigin = { component: this.name, file: this.activeFilePath };
    }

    return this.cachedLogOrigin;
  }

  private createLogger(): KernelLogger {
    return {
      log: (message, options) => {
        this.onLog({
          level: logLevels.info,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
      debug: (message, options) => {
        this.onLog({
          level: logLevels.debug,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
      trace: (message, options) => {
        this.onLog({
          level: logLevels.trace,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
      warn: (message, options) => {
        this.onLog({
          level: logLevels.warn,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
      error: (message, options) => {
        this.onLog({
          level: logLevels.error,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
      custom: (level, message, options) => {
        this.onLog({
          level,
          message,
          origin: this.getLogOrigin(),
          data: options?.data,
        });
      },
    };
  }

  /**
   * Create a KernelBundler facade that routes operations to the correct bundler by extension.
   */
  private createBundlerFacade(): KernelBundler {
    if (this.cachedBundlerFacade) {
      return this.cachedBundlerFacade;
    }

    this.cachedBundlerFacade = {
      bundle: async (entryPath: string): Promise<BundleResult> => {
        const cached = this.bundleResultCache.get(entryPath);
        if (cached) {
          return cached;
        }

        this.onProgress?.('bundling');
        const bundleSpan = this.tracer.startSpan('kernel.bundle', { entryPath, phase: 'bundling' });
        const ext = KernelWorker.getFileExtension(entryPath);
        const bundler = await this.ensureBundlerForExtension(ext);

        const bundleResult = await bundler.definition.bundle({ entryPath }, bundler.ctx);
        bundleSpan.end();
        this.bundleResultCache.set(entryPath, bundleResult);
        return bundleResult;
      },
      resolveDependencies: async (entryPath: string): Promise<string[]> => {
        const ext = KernelWorker.getFileExtension(entryPath);
        const bundler = await this.ensureBundlerForExtension(ext);

        if (bundler.definition.resolveDependencies) {
          return bundler.definition.resolveDependencies({ entryPath }, bundler.ctx);
        }

        const result = await this.createBundlerFacade().bundle(entryPath);
        return result.dependencies;
      },
      registerModule: (name: string, entry: BuiltinModule): void => {
        if (this.loadedBundlers.size > 0) {
          for (const bundler of new Set(this.loadedBundlers.values())) {
            bundler.definition.registerModule(name, entry, bundler.ctx);
          }
        } else {
          this.pendingModuleRegistrations.set(name, entry);
        }
      },
    };

    return this.cachedBundlerFacade;
  }

  /**
   * Create a KernelRuntime for use in kernel methods.
   * Provides filesystem, logger, bundler, and execute services.
   * The bundler is lazily initialised -- kernels that never call it pay zero cost.
   *
   * @returns KernelRuntime instance
   */
  private createRuntime(): KernelRuntime {
    this.cachedRuntime ??= {
      filesystem: this.filesystem,
      logger: this.logger,
      fileContentCache: this.fileContentCache,
      bundler: this.createBundlerFacade(),
      execute: async (code: string): Promise<ExecuteResult> => {
        await this.ensureBundlerContext();

        const executeSpan = this.tracer.startSpan('kernel.execute', { phase: 'computingGeometry' });
        const firstBundler = this.loadedBundlers.values().next().value!;
        const result = await firstBundler.definition.execute(code, firstBundler.ctx);
        executeSpan.end();
        return result;
      },
      tracer: this.tracer,
    };

    return this.cachedRuntime;
  }

  /**
   * Get or create a cached logger for a middleware by name.
   */
  private getMiddlewareLogger(middlewareName: string): KernelLogger {
    let logger = this.middlewareLoggerCache.get(middlewareName);
    if (!logger) {
      logger = {
        log: (message, options) => {
          this.onLog({ level: logLevels.info, message, origin: { component: middlewareName }, data: options?.data });
        },
        debug: (message, options) => {
          this.onLog({ level: logLevels.debug, message, origin: { component: middlewareName }, data: options?.data });
        },
        trace: (message, options) => {
          this.onLog({ level: logLevels.trace, message, origin: { component: middlewareName }, data: options?.data });
        },
        warn: (message, options) => {
          this.onLog({ level: logLevels.warn, message, origin: { component: middlewareName }, data: options?.data });
        },
        error: (message, options) => {
          this.onLog({ level: logLevels.error, message, origin: { component: middlewareName }, data: options?.data });
        },
        custom: (level, message, options) => {
          this.onLog({ level, message, origin: { component: middlewareName }, data: options?.data });
        },
      };
      this.middlewareLoggerCache.set(middlewareName, logger);
    }

    return logger;
  }

  private hashContent(content: Uint8Array<ArrayBuffer>): string {
    return hashBytes(content);
  }

  private hashAssetUrl(url: string): string {
    const cached = this.assetHashCache.get(url);
    if (cached) {
      return cached;
    }

    // Vite ?url imports include a content hash in the URL (production) or a
    // cache-busted path (dev). Hashing the URL string itself is sufficient for
    // cache invalidation and avoids fetching multi-MB WASM/font binaries.
    const hash = hashString(url);
    this.assetHashCache.set(url, hash);
    return hash;
  }

  /**
   * Set the base path for relative file operations based on a GeometryFile.
   * Extracts the directory from the filename and combines it with the path.
   *
   * @param file - The geometry file being processed
   */
  private setBasePath(file: GeometryFile): void {
    if (this.basePath === file.path && this.activeFilePath === file.filename) {
      return;
    }

    this.activeFilePath = file.filename;

    const lastSlashIndex = file.filename.lastIndexOf('/');
    const directory = lastSlashIndex === -1 ? '' : file.filename.slice(0, lastSlashIndex);

    this.basePath = directory ? joinPath(file.path, directory) : file.path;

    this.cachedRuntime = undefined;
    this.cachedProjectRoot = undefined;
  }

  private computeDependencyHash(dependencies: readonly Dependency[]): string {
    const contentHashSpan = this.tracer.startSpan('deps.content-hash');
    const hex = hashString(JSON.stringify(dependencies));
    contentHashSpan.end();
    return hex;
  }
}
