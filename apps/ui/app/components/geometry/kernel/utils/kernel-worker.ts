import type {
  CreateGeometryResultCompleted,
  CreateGeometryResult,
  CreateGeometryHandler,
  ExportFormat,
  ExportGeometryResult,
  GetParametersResult,
  GetParametersHandler,
  GeometryFile,
  GeometryResponse,
  KernelMiddlewareRuntime,
  KernelFilesystem,
  KernelRuntime,
  KernelLogger,
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
} from '@taucad/types';
import * as kernelSymbols from '@taucad/types/symbols';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import { version as TAU_VERSION } from 'package.json';
import { logLevels } from '@taucad/types/constants';
import type { FileManager } from '#machines/file-manager.js';
import { joinPath } from '#utils/path.utils.js';
import type { KernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { createMiddlewareRuntime } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { geometryCacheMiddleware } from '#components/geometry/kernel/utils/geometry-cache.middleware.js';
import { gltfCoordinateTransformMiddleware } from '#components/geometry/kernel/utils/gltf-coordinate-transform.middleware.js';
import { gltfEdgeDetectionMiddleware } from '#components/geometry/kernel/utils/gltf-edge-detection.middleware.js';
import { createKernelError } from '#components/geometry/kernel/utils/kernel-helpers.js';
import { parameterCacheMiddleware } from '#components/geometry/kernel/utils/parameter-cache.middleware.js';

/**
 * Static array of middleware to apply to all kernel operations.
 * Middleware uses an onion model - each middleware wraps around the next,
 * so code after handler() runs on the "return journey".
 *
 * Order matters (first middleware is outermost):
 * 1. parameterCacheMiddleware - Caches getParameters results.
 * 2. geometryCacheMiddleware - Checks/writes geometry cache, handles export.
 * 3. gltfCoordinateTransformMiddleware - Transforms GLTF output for UI rendering.
 * 4. gltfEdgeDetectionMiddleware - Adds edge primitives for sharp edge rendering.
 *
 * Note: Edge detection must be innermost (runs first on return) so that
 * the coordinate transform can then transform BOTH mesh and edge primitives.
 */
const kernelMiddleware: KernelMiddleware[] = [
  parameterCacheMiddleware,
  geometryCacheMiddleware,
  gltfCoordinateTransformMiddleware,
  gltfEdgeDetectionMiddleware,
];

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
  private fileManager: Remote<FileManager> | undefined;

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
   */
  public async [kernelSymbols.initializeEntry](
    callbacks: { onLog: OnWorkerLog },
    transferables: { fileManagerPort?: MessagePort },
    options: Options,
  ): Promise<void> {
    this.onLog = callbacks.onLog;
    this.options = options;

    // Create logger (depends on onLog being set)
    this._logger = this.createLogger();

    // Register file manager and create filesystem if port is provided
    if (transferables.fileManagerPort) {
      this.fileManager = wrap<FileManager>(transferables.fileManagerPort);
      this._filesystem = this.createFilesystem();
    }

    // Call worker-specific initialization
    await this.initialize({ options: this.options }, this.createRuntime());
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
  public async [kernelSymbols.cleanupEntry](): Promise<void> {
    this.assetHashCache.clear();
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

    // Compute all dependencies and their hash for cache key computation
    const basename = KernelWorker.getBasename(file.filename);
    const dependencies = await this.computeDependencies(basename);
    const dependencyHash = await this.computeDependencyHash(dependencies);

    // Get middleware array (overridable for testing)
    const middlewareArray = this[kernelSymbols.getMiddleware]();

    // Create runtimes map - one per middleware for the duration of this operation
    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const middleware of middlewareArray) {
      runtimes.set(
        middleware.name,
        createMiddlewareRuntime({
          onLog: this.onLog,
          middlewareName: middleware.name,
          filesystem: this.filesystem,
          dependencies,
          dependencyHash,
          stateSchema: middleware.stateSchema,
        }),
      );
    }

    // Build onion chain: start with innermost (main operation)
    // Handler only takes input - runtime is captured in closure
    let chain: GetParametersHandler = async (handlerInput: GetParametersInput) => {
      const mainStart = performance.now();
      const result = await this.getParameters(handlerInput, this.createRuntime());
      const mainDuration = performance.now() - mainStart;
      this.logger.trace(`Main getParameters completed (${mainDuration.toFixed(2)}ms)`);
      return result;
    };

    // Wrap each middleware from last to first (reverse order builds onion correctly)
    for (const middleware of [...middlewareArray].reverse()) {
      if (middleware.wrapGetParameters) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapGetParameters;

        // New chain captures runtime and creates a handler that only takes input
        chain = async (handlerInput: GetParametersInput) => {
          try {
            const middlewareStart = performance.now();
            // Hook receives (input, handler, runtime) - handler only takes input
            const result = await wrapHook(handlerInput, inner, runtime);
            const middlewareDuration = performance.now() - middlewareStart;
            this.logger.trace(`Middleware ${middlewareName} completed (${middlewareDuration.toFixed(2)}ms)`);
            return result;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Middleware ${middlewareName} failed: ${errorMessage}`);
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

    // Execute chain with input directly
    const result = await chain(input);

    const duration = performance.now() - start;
    this.logger.debug(`getParameters completed (${duration.toFixed(2)}ms)`);

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

    // Compute all dependencies and their hash for cache key computation
    // Pass parameters to include them in the cache key for geometry computation
    const basename = KernelWorker.getBasename(file.filename);
    const dependencies = await this.computeDependencies(basename, parameters);
    const dependencyHash = await this.computeDependencyHash(dependencies);

    // Get middleware array (overridable for testing)
    const middlewareArray = this[kernelSymbols.getMiddleware]();

    // Create runtimes map - one per middleware for the duration of this operation.
    // This ensures the state is shared across the entire wrap hook execution.
    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const middleware of middlewareArray) {
      runtimes.set(
        middleware.name,
        createMiddlewareRuntime({
          onLog: this.onLog,
          middlewareName: middleware.name,
          filesystem: this.filesystem,
          dependencies,
          dependencyHash,
          stateSchema: middleware.stateSchema,
        }),
      );
    }

    // Build onion chain: start with innermost (main operation)
    // Handler only takes input - runtime is captured in closure
    let chain: CreateGeometryHandler = async (handlerInput: CreateGeometryInput) => {
      const mainStart = performance.now();
      const result = await this.createGeometry(handlerInput, this.createRuntime());
      const mainDuration = performance.now() - mainStart;
      this.logger.trace(`Main createGeometry completed (${mainDuration.toFixed(2)}ms)`);
      return result;
    };

    // Wrap each middleware from last to first (reverse order builds onion correctly)
    // After wrapping: middleware[0] is outermost, middleware[n-1] is closest to main operation
    for (const middleware of [...middlewareArray].reverse()) {
      if (middleware.wrapCreateGeometry) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapCreateGeometry;

        // New chain captures runtime and creates a handler that only takes input
        chain = async (handlerInput: CreateGeometryInput) => {
          try {
            const middlewareStart = performance.now();
            // Hook receives (input, handler, runtime) - handler only takes input
            const result = await wrapHook(handlerInput, inner, runtime);
            const middlewareDuration = performance.now() - middlewareStart;
            this.logger.trace(`Middleware ${middlewareName} completed (${middlewareDuration.toFixed(2)}ms)`);
            return result;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Middleware ${middlewareName} failed: ${errorMessage}`);
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

    // Execute chain with input directly
    const internalResult = await chain(input);

    // Transform internal result to external result by adding hash to each geometry
    // Each geometry gets a unique hash by combining the dependencyHash with a content hash
    // This ensures unique React keys when multiple geometries are returned
    const result: CreateGeometryResultCompleted = internalResult.success
      ? {
          ...internalResult,
          data: await Promise.all(
            internalResult.data.map(async (geometry, index) => {
              const contentHash = await this.hashGeometryContent(geometry);
              return { ...geometry, hash: `${dependencyHash}-${index}-${contentHash}` };
            }),
          ),
        }
      : internalResult;

    const duration = performance.now() - start;
    this.logger.debug(`createGeometry completed (${duration.toFixed(2)}ms)`);

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
    // No setBasePath - export doesn't need file context
    const start = performance.now();

    const input: ExportGeometryInput = {
      fileType,
      meshConfig,
    };

    const result = await this.exportGeometry(input, this.createRuntime());

    const duration = performance.now() - start;
    this.logger.debug(`exportGeometry completed (${duration.toFixed(2)}ms)`);

    return result;
  }

  /**
   * Get the middleware array for this worker.
   * Override in subclasses to customize middleware (e.g., for testing).
   *
   * Symbol-keyed to hide from kernel developer autocomplete. Tests can import
   * the symbol from @taucad/types/symbols to override this method.
   *
   * @returns Array of middleware to apply to kernel operations
   */
  public [kernelSymbols.getMiddleware](): KernelMiddleware[] {
    return kernelMiddleware;
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
   * Export geometry.
   *
   * @param input - Input containing file type, geometry ID, and mesh config
   * @param runtime - Runtime services (filesystem, logger)
   * @returns The exported geometry.
   */
  protected abstract exportGeometry(input: ExportGeometryInput, runtime: KernelRuntime): Promise<ExportGeometryResult>;

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
   * Create the unified filesystem interface.
   * Called during initializeEntry() after fileManager is set up.
   * All methods use absolute paths - callers use helper methods to construct paths.
   *
   * @returns KernelFilesystem instance with absolute-only path methods
   */
  private createFilesystem(): KernelFilesystem {
    const fileManager = this.fileManager!;
    // eslint-disable-next-line unicorn/no-this-assignment, @typescript-eslint/no-this-alias -- required for overloads.
    const worker = this;

    // Define readFile with proper overload signatures
    function readFile(path: string, encoding: 'utf8'): Promise<string>;
    function readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
    async function readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array<ArrayBuffer>> {
      const start = performance.now();
      worker.logger.trace(`Reading file: ${path}`);
      const data = await fileManager.readFile(path, encoding);
      const duration = performance.now() - start;
      worker.logger.trace(`Read ${path} (${duration.toFixed(2)}ms)`);
      return data;
    }

    return {
      readFile,

      async exists(path: string): Promise<boolean> {
        const start = performance.now();
        worker.logger.trace(`Checking file exists: ${path}`);
        const fileExists = await fileManager.exists(path);
        const duration = performance.now() - start;
        worker.logger.trace(`File ${fileExists ? 'exists' : 'does not exist'}: ${path} (${duration.toFixed(2)}ms)`);
        return fileExists;
      },

      async readdir(path: string): Promise<string[]> {
        const start = performance.now();
        worker.logger.trace(`Reading directory: ${path}`);
        const entries = await fileManager.readdir(path);
        const duration = performance.now() - start;
        worker.logger.trace(`Read directory ${path}: ${entries.length} entries (${duration.toFixed(2)}ms)`);
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
  private async computeDependencies(_filename: string, parameters?: Record<string, unknown>): Promise<Dependency[]> {
    // 1. Gather file dependencies from worker (includes source files)
    const discoverInput: GetDependenciesInput = {
      filePath: this.activeFileAbsolutePath,
      basePath: this.getProjectRootPath(),
    };
    const absolutePaths = await this.getDependencies(discoverInput, this.createRuntime());
    const fileDeps: FileDependency[] = await Promise.all(
      absolutePaths.map(async (absolutePath) => {
        // DiscoverDependencies returns absolute paths, use directly
        const content = await this.filesystem.readFile(absolutePath);
        const contentHash = await this.hashContent(content);
        return {
          type: 'file' as const,
          path: absolutePath,
          contentHash,
        };
      }),
    );

    // 2. Middleware dependencies (index preserves chain order)
    const middlewareDeps: MiddlewareDependency[] = this[kernelSymbols.getMiddleware]().map((middleware, index) => ({
      type: 'middleware' as const,
      name: middleware.name,
      version: middleware.version ?? '1',
      index,
    }));

    // 3. Framework dependency
    const frameworkDep: FrameworkDependency = {
      type: 'framework' as const,
      name: 'tau',
      version: TAU_VERSION,
    };

    // 4. Options dependencies (from worker options)
    const optionDeps: OptionDependency[] = Object.entries(this.options).map(([key, value]) => ({
      type: 'option' as const,
      key,
      value,
    }));

    // 5. Parameter dependency (only for geometry computation, not parameter extraction)
    const parameterDeps: ParameterDependency[] = [];
    if (parameters !== undefined) {
      const parametersJson = JSON.stringify(parameters);
      const encoder = new TextEncoder();
      const parametersHash = await this.hashContent(encoder.encode(parametersJson));
      parameterDeps.push({
        type: 'parameter' as const,
        parametersHash,
      });
    }

    // 6. Asset dependencies (fonts, WASM, etc.)
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

    return [...fileDeps, ...middlewareDeps, frameworkDep, ...optionDeps, ...parameterDeps, ...assetDeps];
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
   * Create a KernelRuntime for use in kernel methods.
   * Provides filesystem and logger with kernel name pre-configured.
   *
   * @returns KernelRuntime instance
   */
  private createRuntime(): KernelRuntime {
    return {
      filesystem: this.filesystem,
      logger: this.logger,
    };
  }

  /**
   * Hash file content using SHA-256.
   *
   * @param content - The file content as Uint8Array
   * @returns Full SHA-256 hash as hex string (64 characters)
   */
  private async hashContent(content: Uint8Array<ArrayBuffer>): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const hashArray = [...new Uint8Array(hashBuffer)];
    return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Get the project root path by stripping the subdirectory from basePath.
   * For basePath '/builds/test/site' with activeFilePath 'site/main.scad',
   * returns '/builds/test'.
   *
   * @returns The project root path
   */
  private getProjectRootPath(): string {
    const lastSlash = this.activeFilePath.lastIndexOf('/');
    const subDirectory = lastSlash === -1 ? '' : this.activeFilePath.slice(0, lastSlash);

    if (subDirectory && this.basePath.endsWith(`/${subDirectory}`)) {
      return this.basePath.slice(0, -(subDirectory.length + 1));
    }

    return this.basePath;
  }

  /**
   * Hash geometry content to create a unique identifier.
   * Used to ensure each geometry in an array has a unique hash for React keys.
   *
   * @param geometry - The geometry response to hash
   * @returns A 64-character SHA-256 hash of the geometry content
   */
  private async hashGeometryContent(geometry: GeometryResponse): Promise<string> {
    const encoder = new TextEncoder();
    let data: Uint8Array<ArrayBuffer>;

    switch (geometry.format) {
      case 'gltf': {
        // GLTF content is already Uint8Array
        data = geometry.content;
        break;
      }

      case 'svg': {
        // SVG: hash the paths and viewbox
        const svgContent = JSON.stringify({
          paths: geometry.paths,
          viewbox: geometry.viewbox,
          name: geometry.name,
        });
        data = encoder.encode(svgContent);
        break;
      }

      case 'webrtc': {
        // WebRTC: use a random ID since streams aren't hashable. This ensures each geometry has a unique hash.
        data = encoder.encode(crypto.randomUUID());
        break;
      }

      default: {
        const _exhaustiveCheck: never = geometry;
        throw new Error(`Unexpected geometry format: ${String(_exhaustiveCheck)}`);
      }
    }

    return this.hashContent(data);
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

    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const hash = await this.hashContent(new Uint8Array(buffer));

      // Only cache successful fetches
      this.assetHashCache.set(url, hash);
      return hash;
    } catch (error) {
      // Fallback: generate unique UUID to prevent cache poisoning
      // DO NOT cache - next attempt should retry the fetch
      this.logger.warn(`Failed to fetch asset for hashing, using UUID fallback: ${url}`, {
        data: error,
      });
      return crypto.randomUUID();
    }
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

    // Log with just the relative part (strip builds/id prefix for readability)
    const displayPath = directory || file.filename;
    this.logger.debug(`Base path set to: ${displayPath}`);
  }

  /**
   * Compute a SHA-256 hash from all dependencies.
   * This hash is used as a cache key, unique geometry identifier, and React key.
   *
   * @param dependencies - Array of all dependencies
   * @returns A 64-character hex string hash (full SHA-256)
   */
  private async computeDependencyHash(dependencies: readonly Dependency[]): Promise<string> {
    // Sort dependencies for determinism (file discovery order may vary)
    // Middleware order is preserved via the `index` field
    const sorted = [...dependencies].sort((a, b) =>
      `${a.type}:${JSON.stringify(a)}`.localeCompare(`${b.type}:${JSON.stringify(b)}`),
    );

    const input = JSON.stringify(sorted);

    // Compute SHA-256 hash
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    // Convert to full hex string (64 characters)
    const hashArray = [...new Uint8Array(hashBuffer)];
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
