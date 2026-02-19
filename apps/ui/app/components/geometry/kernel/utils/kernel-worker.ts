import deepmerge from 'deepmerge';
import type {
  CreateGeometryResultCompleted,
  CreateGeometryResult,
  CreateGeometryHandler,
  ExportFormat,
  ExportGeometryResult,
  GetParametersResult,
  GetParametersHandler,
  GeometryFile,
  KernelMiddlewareRuntime,
  KernelFilesystem,
  KernelRuntime,
  KernelBundler,
  BuiltinModuleEntry,
  KernelLogger,
  BundleResult,
  ExecuteResult,
  InitializeInput,
  GetParametersInput,
  CreateGeometryInput,
  GetDependenciesInput,
  CanHandleInput,
  ExportGeometryInput,
  Dependency,
  FileDependency,
  MiddlewareDependency,
  FrameworkDependency,
  OptionDependency,
  ParameterDependency,
  AssetDependency,
  OnWorkerLog,
  MiddlewareConfig,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/types';
import * as kernelSymbols from '@taucad/types/symbols';
import { version as TAU_VERSION } from 'package.json';
import { logLevels } from '@taucad/types/constants';
import type { FileManager } from '#machines/file-manager.js';
import { joinPath } from '#utils/path.utils.js';
import { createFileManagerProxy } from '#components/geometry/kernel/utils/kernel-worker-filemanager-bridge.js';
import type { KernelMiddleware } from '#components/geometry/kernel/middleware/kernel-middleware.js';
import { createMiddlewareRuntime } from '#components/geometry/kernel/middleware/kernel-middleware.js';
import { createKernelError } from '#components/geometry/kernel/utils/kernel-helpers.js';
import { WorkerTelemetryCollector } from '#components/geometry/kernel/utils/worker-telemetry.js';
import type { EsbuildBundler } from '#components/geometry/kernel/utils/esbuild-bundler.js';
import type { BuiltinModule } from '#components/geometry/kernel/utils/module-manager.js';

// =============================================================================
// Module-level utilities (avoid per-call allocations)
// =============================================================================

const textEncoder = new TextEncoder();

const hexChars = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) {
    hex += hexChars[b]!;
  }

  return hex;
}

async function mapBounded<T, R>(items: T[], function_: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = Array.from<R>({ length: items.length });
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      // eslint-disable-next-line no-await-in-loop -- intentional bounded concurrency
      results[i] = await function_(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * A resolved middleware instance paired with its parsed config.
 */
export type ResolvedMiddleware = {
  middleware: KernelMiddleware;
  config: Record<string, unknown>;
  url: string;
  enabled: boolean;
};

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

  /**
   * The name of the worker.
   *
   * @example ReplicadWorker, TauWorker, ZooWorker.
   */
  protected abstract readonly name: string;

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
   * Initialized via initializeEntry() during worker setup.
   * This is a Remote proxy to the file-manager worker.
   * Private - use the filesystem property for all filesystem operations.
   */
  private fileManager: FileManager | undefined;

  /**
   * Internal filesystem instance.
   * Initialized via initializeEntry() when fileManagerPort is provided.
   */
  private _filesystem: KernelFilesystem | undefined;

  /**
   * Internal logger instance.
   * Initialized via initializeEntry() after onLog is set.
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
   * Populated during initializeEntry() and updated via configureMiddleware().
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

  /** Telemetry collector instance -- created on first use when setTelemetrySend is called */
  private telemetryCollector?: WorkerTelemetryCollector;

  /** Progress callback set during renderEntry, used by entry methods to emit phase transitions */
  private onProgress?: (phase: RenderPhase) => void;

  /** Per-render bundle result cache. Cleared at the start of each render cycle. */
  private bundleResultCache = new Map<string, BundleResult>();

  /** Per-render dependency computation cache. Cleared at the start of each render cycle. */
  private renderDependencyCache?: { hash: string; dependencies: Dependency[] };

  /** Lazily initialised esbuild bundler instance */
  private _bundler: EsbuildBundler | undefined;

  /** Cached KernelBundler facade exposed via KernelRuntime */
  private cachedBundlerFacade: KernelBundler | undefined;

  /** Pending built-in module registrations queued before the bundler is initialised */
  private readonly pendingBuiltinModules = new Map<string, BuiltinModule>();

  /**
   * Unified filesystem interface for kernel workers.
   * Provides three path resolution contexts:
   * - Relative to basePath (current file's directory)
   * - Relative to project root (for dependency resolution)
   * - Absolute paths (for cache/middleware operations)
   *
   * @throws Error if accessed before initializeEntry() completes with fileManagerPort
   */
  private get filesystem(): KernelFilesystem {
    if (!this._filesystem) {
      throw new Error('filesystem not available - initializeEntry must complete first with fileManagerPort');
    }

    return this._filesystem;
  }

  /**
   * Logger interface for kernel workers.
   * Provides convenience methods that automatically inject the component name.
   *
   * @throws Error if accessed before initializeEntry() completes
   */
  private get logger(): KernelLogger {
    if (!this._logger) {
      throw new Error('logger not available - initializeEntry must complete first');
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
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param callbacks - Object containing callback functions (proxied).
   * @param callbacks.onLog - The function to call when a log is emitted.
   * @param transferables - Object containing transferable resources like MessagePorts.
   * @param transferables.fileManagerPort - Optional MessagePort for direct communication with file-manager worker.
   * @param options - The options passed to the worker. These are specific to the kernel provider.
   * @param middlewareConfig - Ordered array of middleware registrations to load dynamically.
   */
  public async [kernelSymbols.initializeEntry](
    callbacks: { onLog: OnWorkerLog },
    transferables: { fileManagerPort?: MessagePort },
    options: Options,
    middlewareConfig: MiddlewareConfig,
  ): Promise<void> {
    this.onLog = callbacks.onLog;
    this.options = options;

    // Create logger (depends on onLog being set)
    this._logger = this.createLogger();

    // Register file manager and create filesystem if port is provided
    if (transferables.fileManagerPort) {
      this.fileManager = createFileManagerProxy(transferables.fileManagerPort);
      this._filesystem = this.createFilesystem();
    }

    await this.loadMiddleware(middlewareConfig);

    performance.mark('tau:kernel:init:start');
    await this.initialize({ options: this.options }, this.createRuntime());
    performance.measure('tau:kernel:init', {
      start: 'tau:kernel:init:start',
      detail: { kernel: this.constructor.name },
    });
  }

  /**
   * Get the supported export formats for the worker.
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @returns The supported export formats.
   */
  public [kernelSymbols.getExportFormats](): ExportFormat[] {
    return (this.constructor as typeof KernelWorker).supportedExportFormats;
  }

  /**
   * Entry point for cleaning up the worker. This is called when the worker is destroyed.
   * Handles common cleanup logic and then calls the protected cleanup method.
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   */
  /**
   * Set the telemetry send callback. Called by the dispatcher to wire up
   * telemetry before initialization. Creates the PerformanceObserver-based collector.
   */
  public setTelemetrySend(send: (entries: PerformanceEntryData[]) => void): void {
    this.telemetryCollector = new WorkerTelemetryCollector(send);
  }

  public async [kernelSymbols.cleanupEntry](): Promise<void> {
    this.assetHashCache.clear();
    this.nativeHandle = undefined;
    this.telemetryCollector?.dispose();
    this.telemetryCollector = undefined;
    await this.cleanup();
  }

  /**
   * Entry point for checking if this worker can handle the given file.
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param file - The geometry file to check.
   * @returns True if this worker can handle the file, false otherwise.
   */
  public async [kernelSymbols.canHandleEntry](file: GeometryFile): Promise<boolean> {
    this.setBasePath(file);
    const basename = KernelWorker.getBasename(file.filename);
    const extension = KernelWorker.getFileExtension(basename);

    const input: CanHandleInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
      extension,
    };

    return this.canHandle(input, this.createRuntime());
  }

  /**
   * Entry point for extracting parameters from a file.
   * Handles base path setup, timing, and middleware application using onion model.
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param file - The geometry file to extract parameters from.
   * @returns The extracted parameters.
   */
  public async [kernelSymbols.getParametersEntry](file: GeometryFile): Promise<GetParametersResult> {
    this.setBasePath(file);
    const start = performance.now();

    const input: GetParametersInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
    };

    const resolvedArray = this[kernelSymbols.getMiddleware]();

    this.onProgress?.('resolvingDeps');
    performance.mark('tau:kernel:deps:start');
    const basename = KernelWorker.getBasename(file.filename);
    const dependencies = await this.computeDependencies(basename, undefined, resolvedArray);
    const dependencyHash = await this.computeDependencyHash(dependencies);
    performance.measure('tau:kernel:deps', { start: 'tau:kernel:deps:start' });

    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const { middleware, config, enabled } of resolvedArray) {
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
            config,
            logger: this.getMiddlewareLogger(middleware.name),
          }),
        );
      }
    }

    this.onProgress?.('extractingParams');
    let chain: GetParametersHandler = async (handlerInput: GetParametersInput) => {
      performance.mark('tau:kernel:params:start');
      const result = await this.getParameters(handlerInput, this.createRuntime());
      performance.measure('tau:kernel:params', { start: 'tau:kernel:params:start' });
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
          const markName = `tau:middleware:wrap:${middlewareName}:start`;
          try {
            performance.mark(markName);
            const result = await wrapHook(handlerInput, inner, runtime);
            performance.measure('tau:middleware:wrap', {
              start: markName,
              detail: { name: middlewareName, phase: 'getParameters' },
            });
            return result;
          } catch (error) {
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
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param file - The geometry file to compute geometry from.
   * @param parameters - The parameters to use when computing geometry.
   * @param geometryId - The geometry ID to use when computing geometry.
   * @returns The computed geometry.
   */
  public async [kernelSymbols.createGeometryEntry](
    file: GeometryFile,
    parameters: Record<string, unknown>,
  ): Promise<CreateGeometryResultCompleted> {
    this.setBasePath(file);
    const start = performance.now();

    const input: CreateGeometryInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
      parameters,
    };

    const resolvedArray = this[kernelSymbols.getMiddleware]();

    performance.mark('tau:kernel:deps:start');
    const basename = KernelWorker.getBasename(file.filename);
    const dependencies = await this.computeDependencies(basename, parameters, resolvedArray);
    const dependencyHash = await this.computeDependencyHash(dependencies);
    performance.measure('tau:kernel:deps', { start: 'tau:kernel:deps:start' });

    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const { middleware, config, enabled } of resolvedArray) {
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
            config,
            logger: this.getMiddlewareLogger(middleware.name),
          }),
        );
      }
    }

    this.onProgress?.('computingGeometry');
    let chain: CreateGeometryHandler = async (handlerInput: CreateGeometryInput) => {
      performance.mark('tau:kernel:compute:start');
      const result = await this.createGeometry(handlerInput, this.createRuntime());
      performance.measure('tau:kernel:compute', { start: 'tau:kernel:compute:start' });
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
          const markName = `tau:middleware:wrap:${middlewareName}:start`;
          try {
            performance.mark(markName);
            const result = await wrapHook(handlerInput, inner, runtime);
            performance.measure('tau:middleware:wrap', {
              start: markName,
              detail: { name: middlewareName, phase: 'createGeometry' },
            });
            return result;
          } catch (error) {
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
    const result: CreateGeometryResultCompleted = internalResult.success
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
   * Handles timing (no base path needed for export).
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param fileType - The file type to export the geometry as.
   * @param geometryId - The geometry ID to export the geometry from.
   * @param meshConfig - The mesh configuration to use when exporting the geometry.
   * @returns The exported geometry.
   */
  public async [kernelSymbols.exportGeometryEntry](
    fileType: ExportFormat,
    meshConfig?: { linearTolerance: number; angularTolerance: number },
  ): Promise<ExportGeometryResult> {
    performance.mark('tau:kernel:export:start');

    const input: ExportGeometryInput = {
      fileType,
      meshConfig,
    };

    const result = await this.exportGeometry(input, this.createRuntime(), this.nativeHandle);

    performance.measure('tau:kernel:export', { start: 'tau:kernel:export:start' });

    return result;
  }

  /**
   * Get the resolved middleware array for this worker.
   * Override in subclasses to customize middleware (e.g., for testing).
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Tests can import
   * the symbol from @taucad/types/symbols to override this method.
   *
   * @returns Array of resolved middleware with their configs
   */
  public [kernelSymbols.getMiddleware](): ResolvedMiddleware[] {
    return this.resolvedMiddleware;
  }

  /**
   * Reconfigure middleware at runtime without re-importing already loaded modules.
   * New URLs are imported, removed URLs are dropped, existing URLs get config updates.
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Framework code imports
   * the symbol from @taucad/types/symbols to access this method.
   *
   * @param config - New middleware configuration to apply
   */
  public async [kernelSymbols.configureMiddleware](config: MiddlewareConfig): Promise<void> {
    await this.loadMiddleware(config);
    this.logger.debug('Middleware reconfigured', { data: { count: this.resolvedMiddleware.length } });
  }

  /**
   * Unified render entry point that combines parameter extraction and geometry computation
   * in a single call. This eliminates redundant dependency computation, bundling, and hashing
   * between the two operations.
   *
   * @param file - The geometry file to render
   * @param parameters - User-provided parameters
   * @param onParametersResolved - Optional callback to stream parameters back while geometry computes
   * @returns The computed geometry
   */
  public async [kernelSymbols.renderEntry](
    file: GeometryFile,
    parameters: Record<string, unknown>,
    onParametersResolved?: (result: GetParametersResult) => void,
    onProgress?: (phase: RenderPhase) => void,
  ): Promise<CreateGeometryResultCompleted> {
    performance.mark('tau:kernel:render:start');
    this.onProgress = onProgress;
    this.bundleResultCache.clear();
    this.renderDependencyCache = undefined;
    this.setBasePath(file);

    const parametersResult = await this[kernelSymbols.getParametersEntry](file);
    onParametersResolved?.(parametersResult);

    let mergedParameters = parameters;
    if (parametersResult.success) {
      const extracted = parametersResult.data as { defaultParameters?: Record<string, unknown> };
      if (extracted.defaultParameters) {
        mergedParameters = deepmerge(extracted.defaultParameters, parameters);
      }
    }

    const result = await this[kernelSymbols.createGeometryEntry](file, mergedParameters);
    this.onProgress = undefined;
    performance.measure('tau:kernel:render', {
      start: 'tau:kernel:render:start',
      detail: { file: file.filename, success: result.success },
    });
    return result;
  }

  /**
   * Selectively invalidate file caches for changed paths.
   * Called by the kernel machine before render operations when files have changed.
   *
   * @param changedPaths - Absolute paths of files that changed
   */
  public async [kernelSymbols.notifyFileChanged](changedPaths: string[]): Promise<void> {
    for (const path of changedPaths) {
      this.fileHashCache.delete(path);
      this.fileContentCache.delete(path);
      this.fileContentCache.delete(`utf8:${path}`);
    }

    this.bundleResultCache.clear();
  }

  /**
   * Worker-specific initialization. Override this method to add custom initialization logic.
   * No need to call super.initialize() - common initialization is handled by initializeEntry.
   *
   * @param input - Input containing worker options
   * @param runtime - Runtime services (filesystem, logger)
   */
  protected async initialize(_input: InitializeInput<Options>, _runtime: KernelRuntime): Promise<void> {
    // Base implementation - can be overridden by subclasses
  }

  /**
   * Worker-specific cleanup. Override this method to add custom cleanup logic.
   * No need to call super.cleanup() - common cleanup is handled by cleanupEntry.
   *
   * This can be used to release memory, close connections, etc.
   */
  protected async cleanup(): Promise<void> {
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
   * Built-in modules for the bundler. Override in subclasses to register
   * kernel-specific modules (replicad, @jscad/modeling).
   * The base implementation merges any modules registered via runtime.bundler.registerModule().
   */
  protected getBuiltinModules(): Map<string, BuiltinModule> {
    return new Map(this.pendingBuiltinModules);
  }

  /**
   * Auto-export names for the bundler. Override in subclasses to specify
   * which names should be auto-exported from CommonJS-style entry files.
   */
  protected getAutoExportNames(): string[] {
    return ['main', 'defaultParams', 'getParameterDefinitions'];
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
  protected abstract canHandle(input: CanHandleInput, runtime: KernelRuntime): Promise<boolean>;

  /**
   * Extract parameters from a file.
   *
   * @param input - Input containing file path and project root
   * @param runtime - Runtime services (filesystem, logger)
   * @returns The extracted parameters.
   */
  protected abstract getParameters(input: GetParametersInput, runtime: KernelRuntime): Promise<GetParametersResult>;

  /**
   * Compute geometry from a file.
   *
   * @param input - Input containing file path, project root, parameters, and geometry ID
   * @param runtime - Runtime services (filesystem, logger)
   * @returns The computed geometry.
   */
  protected abstract createGeometry(input: CreateGeometryInput, runtime: KernelRuntime): Promise<CreateGeometryResult>;

  /**
   * Export geometry using the framework-stored native handle from the last createGeometry call.
   *
   * @param input - Input containing file type and mesh config
   * @param runtime - Runtime services (filesystem, logger)
   * @param nativeHandle - Opaque native geometry data stored by the framework after createGeometry
   * @returns The exported geometry.
   */
  protected abstract exportGeometry(
    input: ExportGeometryInput,
    runtime: KernelRuntime,
    nativeHandle: unknown,
  ): Promise<ExportGeometryResult>;

  /**
   * Discover all file dependencies for the given entry file.
   * Used for cache key computation to include all imported/included files.
   *
   * @param input - Input containing file path and project root
   * @param runtime - Runtime services (filesystem, logger)
   * @returns Array of absolute file paths that are dependencies (including the entry file)
   */
  protected abstract getDependencies(input: GetDependenciesInput, runtime: KernelRuntime): Promise<string[]>;

  /**
   * Load middleware modules from URLs and resolve their configs.
   * Uses a module cache to avoid redundant network requests when reconfiguring.
   *
   * @param middlewareConfig - Ordered array of middleware entries
   */
  private async loadMiddleware(middlewareConfig: MiddlewareConfig): Promise<void> {
    const resolved: ResolvedMiddleware[] = [];

    for (const entry of middlewareConfig) {
      // eslint-disable-next-line no-await-in-loop -- Middleware must be loaded sequentially to preserve order
      const middleware = await this.importMiddlewareModule(entry.url);

      const resolvedConfig = middleware.configSchema
        ? (middleware.configSchema.parse(entry.config ?? {}) as Record<string, unknown>)
        : {};

      const enabled = entry.enabled ?? middleware.enabled ?? true;

      resolved.push({ middleware, config: resolvedConfig, url: entry.url, enabled });
    }

    this.resolvedMiddleware = resolved;
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
   * Called during initializeEntry() after fileManager is set up.
   * All methods use absolute paths - callers use helper methods to construct paths.
   *
   * @returns KernelFilesystem instance with absolute-only path methods
   */
  private createFilesystem(): KernelFilesystem {
    const fileManager = this.fileManager!;

    function readFile(path: string, encoding: 'utf8'): Promise<string>;
    function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
    async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
      const markName = `tau:fs:read:${path}`;
      performance.mark(markName);
      const data = await fileManager.readFile(path, encoding);
      performance.measure('tau:fs:read', { start: markName, detail: { path, binary: encoding !== 'utf8' } });
      return data;
    }

    return {
      readFile,

      async readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>> {
        const markName = 'tau:fs:readBatch:start';
        performance.mark(markName);
        const result = await fileManager.readFiles(paths);
        performance.measure('tau:fs:readBatch', { start: markName, detail: { fileCount: paths.length } });
        return result;
      },

      async exists(path: string): Promise<boolean> {
        const markName = `tau:fs:exists:${path}`;
        performance.mark(markName);
        const fileExists = await fileManager.exists(path);
        performance.measure('tau:fs:exists', { start: markName, detail: { path, exists: fileExists } });
        return fileExists;
      },

      async readdir(path: string): Promise<string[]> {
        const markName = `tau:fs:readdir:${path}`;
        performance.mark(markName);
        const entries = await fileManager.readdir(path);
        performance.measure('tau:fs:readdir', { start: markName, detail: { path, entryCount: entries.length } });
        return entries;
      },

      writeFile: async (path: string, data: Uint8Array<ArrayBuffer> | string) => fileManager.writeFile(path, data),
      mkdir: async (path: string, options?: { recursive?: boolean }) =>
        fileManager.mkdir(path, { mode: 0o777, ...options }),
      unlink: async (path: string) => fileManager.unlink(path),
      ensureDirectoryExists: async (path: string) => fileManager.ensureDirectoryExists(path),
      getDirectoryContents: async (path: string) => fileManager.getDirectoryContents(path),
      getDirectoryStat: async (path: string) => fileManager.getDirectoryStat(path),
    };
  }

  /**
   * Compute all dependencies for cache key computation.
   * Gathers file dependencies, middleware signatures, framework version, kernel options,
   * parameters (for geometry computation), and bundled assets.
   *
   * @param filename - The entry file path (relative to basePath)
   * @param parameters - Optional parameters (included for geometry computation, omitted for parameter extraction)
   * @returns Array of all dependencies
   */
  private async computeDependencies(
    _filename: string,
    parameters?: Record<string, unknown>,
    resolvedMiddleware?: ResolvedMiddleware[],
  ): Promise<Dependency[]> {
    // Use cached base deps within a render cycle (file discovery + hashing is expensive)
    let baseDeps: Dependency[];
    if (this.renderDependencyCache) {
      baseDeps = this.renderDependencyCache.dependencies;
    } else {
      baseDeps = await this.computeBaseDependencies(resolvedMiddleware);
      // Cache for reuse by createGeometryEntry within the same render cycle
      this.renderDependencyCache = { hash: '', dependencies: baseDeps };
    }

    if (parameters === undefined) {
      return baseDeps;
    }

    // Add parameter dependency for geometry computation
    const parameterDep: ParameterDependency = { type: 'parameter' as const, parameters };
    return [...baseDeps, parameterDep];
  }

  /**
   * Compute all non-parameter dependencies. Factored out so the result
   * can be cached for the duration of a render cycle (shared between
   * getParametersEntry and createGeometryEntry).
   */
  private async computeBaseDependencies(resolvedMiddleware?: ResolvedMiddleware[]): Promise<Dependency[]> {
    // 1. Gather file dependencies from worker (includes source files)
    const discoverInput: GetDependenciesInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
    };
    const absolutePaths = await this.getDependencies(discoverInput, this.createRuntime());

    // Determine which files need reading (not in hash cache)
    const uncachedPaths = absolutePaths.filter((p) => !this.fileHashCache.has(p));
    if (uncachedPaths.length > 0) {
      const contentMap = await this.filesystem.readFiles(uncachedPaths);
      await mapBounded(
        Object.entries(contentMap),
        async ([path, content]) => {
          const hash = await this.hashContent(content);
          this.fileHashCache.set(path, hash);
          this.fileContentCache.set(path, content);
        },
        8,
      );
    }

    // Contract: getDependencies() must return paths in deterministic order.
    const fileDeps: FileDependency[] = absolutePaths.map((absolutePath) => ({
      type: 'file' as const,
      path: absolutePath,
      contentHash: this.fileHashCache.get(absolutePath)!,
    }));

    // 2. Middleware dependencies (only enabled, index preserves chain order)
    const middleware = resolvedMiddleware ?? this[kernelSymbols.getMiddleware]();
    const middlewareDeps: MiddlewareDependency[] = middleware
      .filter(({ enabled }) => enabled)
      .map(({ middleware: mw, config }, index) => ({
        type: 'middleware' as const,
        name: mw.name,
        version: mw.version ?? '1',
        index,
        config,
      }));

    // 3. Framework dependency
    const frameworkDep: FrameworkDependency = {
      type: 'framework' as const,
      name: 'tau',
      version: TAU_VERSION,
    };

    // 4. Options dependencies (options are stable between renders, no sort needed)
    const optionDeps: OptionDependency[] = Object.entries(this.options).map(([key, value]) => ({
      type: 'option' as const,
      key,
      value,
    }));

    // 5. Asset dependencies (fonts, WASM, etc.)
    const assetUrls = this.getAssetUrls();
    const assetDeps: AssetDependency[] = await Promise.all(
      assetUrls.map(async (urlOrVersion, index) => {
        const contentHash = await this.hashAssetUrl(urlOrVersion);
        return {
          type: 'asset' as const,
          name: `asset-${index}`,
          contentHash,
        };
      }),
    );

    return [...fileDeps, ...middlewareDeps, frameworkDep, ...optionDeps, ...assetDeps];
  }

  /**
   * Create a KernelLogger for use in kernel methods.
   * The logger automatically injects the kernel name as the component.
   *
   * @returns KernelLogger instance
   */
  private createLogger(): KernelLogger {
    return {
      log: (message, options) => {
        this.onLog({
          level: logLevels.info,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
      debug: (message, options) => {
        this.onLog({
          level: logLevels.debug,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
      trace: (message, options) => {
        this.onLog({
          level: logLevels.trace,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
      warn: (message, options) => {
        this.onLog({
          level: logLevels.warn,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
      error: (message, options) => {
        this.onLog({
          level: logLevels.error,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
      custom: (level, message, options) => {
        this.onLog({
          level,
          message,
          origin: { component: this.name },
          data: options?.data,
        });
      },
    };
  }

  /**
   * Get or create the lazily initialised esbuild bundler.
   * The bundler is re-created when the project path changes.
   */
  private async ensureBundler(): Promise<EsbuildBundler> {
    const projectPath = this.getProjectRootPath();
    if (!this._bundler || this._bundler.getProjectPath() !== projectPath) {
      this._bundler?.dispose();
      const mod = await import('#components/geometry/kernel/utils/esbuild-bundler.js');
      this._bundler = new mod.EsbuildBundler({
        filesystem: this.filesystem,
        projectPath,
        builtinModules: this.getBuiltinModules(),
        autoExportNames: this.getAutoExportNames(),
      });
      await this._bundler.initialize();
    }

    return this._bundler;
  }

  /**
   * Create a lazy KernelBundler facade that initialises esbuild on first call.
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
        performance.mark('tau:kernel:bundle:start');
        const bundler = await this.ensureBundler();
        const bundleResult = await bundler.bundle(entryPath);
        performance.measure('tau:kernel:bundle', {
          start: 'tau:kernel:bundle:start',
          detail: { entryPath, deps: bundleResult.dependencies.length },
        });
        this.bundleResultCache.set(entryPath, bundleResult);
        return bundleResult;
      },
      resolveDependencies: async (entryPath: string): Promise<string[]> => {
        const bundler = await this.ensureBundler();
        const result = await bundler.bundle(entryPath);
        return result.dependencies;
      },
      registerModule: (name: string, entry: BuiltinModuleEntry): void => {
        this.pendingBuiltinModules.set(name, {
          code: entry.code,
          version: entry.version,
          globalName: entry.globalName,
        });
      },
    };

    return this.cachedBundlerFacade;
  }

  /**
   * Execute bundled JS/TS code via dynamic import.
   * Browser uses Blob URL, Node.js uses data URL.
   */
  private async executeCode(code: string): Promise<ExecuteResult> {
    // eslint-disable-next-line n/prefer-global/process, @typescript-eslint/no-unnecessary-condition -- process may be undefined in browser
    const isNodejs = typeof process !== 'undefined' && Boolean(process.versions?.node);

    try {
      let url: string;
      let shouldRevoke = false;

      if (isNodejs) {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- class
        const { Buffer: NodeBuffer } = await import('node:buffer');
        const base64Code = NodeBuffer.from(code).toString('base64');
        url = `data:application/javascript;base64,${base64Code}`;
      } else {
        const blob = new Blob([code], { type: 'application/javascript' });
        url = URL.createObjectURL(blob);
        shouldRevoke = true;
      }

      try {
        const module: unknown = await import(/* @vite-ignore */ url);
        return { success: true, value: module };
      } finally {
        if (shouldRevoke) {
          URL.revokeObjectURL(url);
        }
      }
    } catch (error) {
      return {
        success: false,
        issues: [
          {
            message: error instanceof Error ? error.message : String(error),
            type: 'runtime' as const,
            severity: 'error' as const,
          },
        ],
      };
    }
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
      execute: async (code: string) => this.executeCode(code),
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

  /**
   * Hash file content using SHA-256.
   *
   * @param content - The file content as Uint8Array
   * @returns Full SHA-256 hash as hex string (64 characters)
   */
  private async hashContent(content: Uint8Array<ArrayBuffer>): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    return bufferToHex(hashBuffer);
  }

  /**
   * Hash an asset URL by fetching and hashing its content.
   * Results are cached in memory to avoid repeated network requests.
   *
   * @param url - Asset URL (from Vite ?url import)
   * @returns SHA-256 hash of the asset content
   */
  private async hashAssetUrl(url: string): Promise<string> {
    const cached = this.assetHashCache.get(url);
    if (cached) {
      return cached;
    }

    // Vite ?url imports include a content hash in the URL (production) or a
    // cache-busted path (dev). Hashing the URL string itself is sufficient for
    // cache invalidation and avoids fetching multi-MB WASM/font binaries.
    const hash = await this.hashContent(textEncoder.encode(url));
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
    // Store the full relative path for use in error locations
    this.activeFilePath = file.filename;

    // Extract directory from filename (e.g., 'public/kcl-samples/axial-fan/main.kcl' -> 'public/kcl-samples/axial-fan')
    const lastSlashIndex = file.filename.lastIndexOf('/');
    const directory = lastSlashIndex === -1 ? '' : file.filename.slice(0, lastSlashIndex);

    // Combine path with directory to get the full base path
    this.basePath = directory ? joinPath(file.path, directory) : file.path;

    // Invalidate caches that depend on basePath
    this.cachedRuntime = undefined;
    this.cachedProjectRoot = undefined;

    const displayPath = directory || file.filename;
    this.logger.debug('Base path set', { data: { path: displayPath } });
  }

  /**
   * Compute a SHA-256 hash from all dependencies.
   * This hash is used as a cache key, unique geometry identifier, and React key.
   *
   * @param dependencies - Array of all dependencies
   * @returns A 64-character hex string hash (full SHA-256)
   */
  private async computeDependencyHash(dependencies: readonly Dependency[]): Promise<string> {
    performance.mark('tau:hash:dep:start');
    const data = textEncoder.encode(JSON.stringify(dependencies));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hex = bufferToHex(hashBuffer);
    performance.measure('tau:hash:dep', { start: 'tau:hash:dep:start' });
    return hex;
  }
}
