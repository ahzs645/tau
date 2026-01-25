import type {
  ComputeGeometryResultCompleted,
  ComputeGeometryResult,
  ComputeGeometryInput,
  ComputeGeometryRequest,
  ComputeGeometryHandler,
  ExportFormat,
  ExportGeometryResult,
  ExtractParametersResult,
  ExtractParametersInput,
  ExtractParametersRequest,
  ExtractParametersHandler,
  GeometryFile,
  KernelMiddlewareRuntime,
  MiddlewareFileManager,
  Dependency,
  FileDependency,
  MiddlewareDependency,
  FrameworkDependency,
  OptionDependency,
  ParameterDependency,
  AssetDependency,
} from '@taucad/types';
import { wrap } from 'comlink';
import type { Remote } from 'comlink';
import { version as TAU_VERSION } from 'package.json';
import { logLevels } from '#types/console.types';
import type { OnWorkerLog } from '#types/console.types';
import type { FileManager } from '#machines/file-manager.js';
import type { FileReader } from '#components/geometry/kernel/utils/file-reader.js';
import type { KernelMiddleware } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { createMiddlewareRuntime } from '#components/geometry/kernel/utils/kernel-middleware.js';
import { geometryCacheMiddleware } from '#components/geometry/kernel/utils/geometry-cache.middleware.js';
import { gltfCoordinateTransformMiddleware } from '#components/geometry/kernel/utils/gltf-coordinate-transform.middleware.js';
import { parameterCacheMiddleware } from '#components/geometry/kernel/utils/parameter-cache.middleware.js';

/**
 * Static array of middleware to apply to all kernel operations.
 * Middleware uses an onion model - each middleware wraps around the next,
 * so code after handler() runs on the "return journey".
 *
 * Order matters (first middleware is outermost):
 * 1. parameterCacheMiddleware - Caches extractParameters results.
 * 2. geometryCacheMiddleware - Checks/writes geometry cache, handles export.
 * 3. gltfCoordinateTransformMiddleware - Transforms GLTF output for UI rendering.
 */
const kernelMiddleware: KernelMiddleware[] = [
  parameterCacheMiddleware,
  geometryCacheMiddleware,
  gltfCoordinateTransformMiddleware,
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
   * The function to call when a log is emitted.
   */
  protected onLog: OnWorkerLog;

  /**
   * The options passed to the worker. These are specific to the kernel provider.
   */
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Ensuring options is always available, useful for testing.
  protected options: Options = {} as Options;

  /**
   * The base path for relative file operations.
   * Set via setBasePath() before performing operations that need relative path resolution.
   */
  protected basePath = '';

  /**
   * The full relative path of the active file being processed.
   * Used for error locations to ensure FileLink can navigate correctly.
   * Set via setBasePath() from the original file.filename.
   */
  protected activeFilePath = '';

  /**
   * FileReader interface that provides logged filesystem operations relative to basePath.
   * Initialized during initialize() and can be used by kernels that need filesystem access.
   */
  protected fileReader!: FileReader;

  /**
   * The file manager instance.
   * Initialized via registerFileManager() during worker setup.
   * This is a Remote proxy to the file-manager worker.
   */
  protected fileManager!: Remote<FileManager>;

  /**
   * The name of the worker.
   *
   * @example ReplicadWorker, TauWorker, ZooWorker.
   */
  protected abstract readonly name: string;

  /**
   * Cache for asset content hashes to avoid repeated fetches.
   * Maps asset URL to its SHA-256 content hash.
   */
  private readonly assetHashCache = new Map<string, string>();

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
   * @param callbacks - Object containing callback functions (proxied).
   * @param callbacks.onLog - The function to call when a log is emitted.
   * @param transferables - Object containing transferable resources like MessagePorts.
   * @param transferables.fileManagerPort - Optional MessagePort for direct communication with file-manager worker.
   * @param options - The options passed to the worker. These are specific to the kernel provider.
   */
  public async initializeEntry(
    callbacks: { onLog: OnWorkerLog },
    transferables: { fileManagerPort?: MessagePort },
    options: Options,
  ): Promise<void> {
    this.onLog = callbacks.onLog;
    this.options = options;

    // Register file manager if port is provided
    if (transferables.fileManagerPort) {
      this.fileManager = wrap<FileManager>(transferables.fileManagerPort);
    }

    // Initialize fileReader with logged filesystem operations relative to basePath
    this.fileReader = {
      readFile: async (path: string) => this.readFile(path),
      exists: async (path: string) => this.exists(path),
      readdir: async (path: string) => this.readdir(path),
    };

    // Call worker-specific initialization
    await this.initialize();
  }

  /**
   * Get the supported export formats for the worker.
   *
   * @returns The supported export formats.
   */
  public getSupportedExportFormats(): ExportFormat[] {
    return (this.constructor as typeof KernelWorker).supportedExportFormats;
  }

  /**
   * Entry point for cleaning up the worker. This is called when the worker is destroyed.
   * Handles common cleanup logic and then calls the protected cleanup method.
   */
  public async cleanupEntry(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Entry point for checking if this worker can handle the given file.
   *
   * @param file - The geometry file to check.
   * @returns True if this worker can handle the file, false otherwise.
   */
  public async canHandleEntry(file: GeometryFile): Promise<boolean> {
    this.setBasePath(file);
    const basename = this.getBasename(file.filename);
    const extension = KernelWorker.getFileExtension(basename);
    return this.canHandle(basename, extension);
  }

  /**
   * Entry point for extracting parameters from a file.
   * Handles base path setup, timing, and middleware application using onion model.
   *
   * @param file - The geometry file to extract parameters from.
   * @returns The extracted parameters.
   */
  public async extractParametersEntry(file: GeometryFile): Promise<ExtractParametersResult> {
    this.setBasePath(file);
    const start = performance.now();

    const basename = this.getBasename(file.filename);
    const input: ExtractParametersInput = {
      filename: basename,
      basePath: this.basePath,
    };

    // Create file manager adapter for middleware
    const middlewareFileManager = this.createMiddlewareFileManager();

    // Compute all dependencies and their hash for cache key computation
    const dependencies = await this.computeDependencies(basename);
    const dependencyHash = await this.computeDependencyHash(dependencies);

    // Get middleware array (overridable for testing)
    const middlewareArray = this.getMiddleware();

    // Create runtimes map - one per middleware for the duration of this operation
    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const middleware of middlewareArray) {
      runtimes.set(
        middleware.name,
        createMiddlewareRuntime({
          onLog: this.onLog,
          middlewareName: middleware.name,
          fileManager: middlewareFileManager,
          dependencies,
          dependencyHash,
          stateSchema: middleware.stateSchema,
        }),
      );
    }

    // Build onion chain: start with innermost (main operation)
    let chain: ExtractParametersHandler = async (request: ExtractParametersRequest) => {
      const mainStart = performance.now();
      const result = await this.extractParameters(request.input.filename);
      const mainDuration = performance.now() - mainStart;
      this.trace(`Main extractParameters completed (${mainDuration.toFixed(2)}ms)`, {
        operation: 'extractParameters',
      });
      return result;
    };

    // Wrap each middleware from last to first (reverse order builds onion correctly)
    for (const middleware of [...middlewareArray].reverse()) {
      if (middleware.wrapExtractParameters) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapExtractParameters;

        chain = async (request: ExtractParametersRequest) => {
          const middlewareStart = performance.now();
          const result = await wrapHook({ input: request.input, runtime }, inner);
          const middlewareDuration = performance.now() - middlewareStart;
          this.trace(`Middleware ${middlewareName} completed (${middlewareDuration.toFixed(2)}ms)`, {
            operation: 'wrapExtractParameters',
          });
          return result;
        };
      }
    }

    // Execute chain with initial request
    const request: ExtractParametersRequest = {
      input,
      runtime: runtimes.get(middlewareArray[0]?.name ?? '')!,
    };
    const result = await chain(request);

    const duration = performance.now() - start;
    this.debug(`extractParameters completed (${duration.toFixed(2)}ms)`, { operation: 'extractParameters' });

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
   * @param file - The geometry file to compute geometry from.
   * @param parameters - The parameters to use when computing geometry.
   * @param geometryId - The geometry ID to use when computing geometry.
   * @returns The computed geometry.
   */
  public async computeGeometryEntry(
    file: GeometryFile,
    parameters: Record<string, unknown>,
    geometryId?: string,
  ): Promise<ComputeGeometryResultCompleted> {
    this.setBasePath(file);
    const start = performance.now();

    const basename = this.getBasename(file.filename);
    const input: ComputeGeometryInput = {
      filename: basename,
      parameters,
      geometryId,
      basePath: this.basePath,
    };

    // Create file manager adapter for middleware
    const middlewareFileManager = this.createMiddlewareFileManager();

    // Compute all dependencies and their hash for cache key computation
    // Pass parameters to include them in the cache key for geometry computation
    const dependencies = await this.computeDependencies(basename, parameters);
    const dependencyHash = await this.computeDependencyHash(dependencies);

    // Get middleware array (overridable for testing)
    const middlewareArray = this.getMiddleware();

    // Create runtimes map - one per middleware for the duration of this operation.
    // This ensures the state is shared across the entire wrap hook execution.
    const runtimes = new Map<string, KernelMiddlewareRuntime>();
    for (const middleware of middlewareArray) {
      runtimes.set(
        middleware.name,
        createMiddlewareRuntime({
          onLog: this.onLog,
          middlewareName: middleware.name,
          fileManager: middlewareFileManager,
          dependencies,
          dependencyHash,
          stateSchema: middleware.stateSchema,
        }),
      );
    }

    // Build onion chain: start with innermost (main operation)
    let chain: ComputeGeometryHandler = async (request: ComputeGeometryRequest) => {
      const mainStart = performance.now();
      const result = await this.computeGeometry(
        request.input.filename,
        request.input.parameters,
        request.input.geometryId,
      );
      const mainDuration = performance.now() - mainStart;
      this.trace(`Main computeGeometry completed (${mainDuration.toFixed(2)}ms)`, {
        operation: 'computeGeometry',
      });
      return result;
    };

    // Wrap each middleware from last to first (reverse order builds onion correctly)
    // After wrapping: middleware[0] is outermost, middleware[n-1] is closest to main operation
    for (const middleware of [...middlewareArray].reverse()) {
      if (middleware.wrapComputeGeometry) {
        const inner = chain;
        const runtime = runtimes.get(middleware.name)!;
        const middlewareName = middleware.name;
        const wrapHook = middleware.wrapComputeGeometry;

        chain = async (request: ComputeGeometryRequest) => {
          const middlewareStart = performance.now();
          // Pass the runtime for THIS middleware, but chain passes through unchanged
          const result = await wrapHook({ input: request.input, runtime }, inner);
          const middlewareDuration = performance.now() - middlewareStart;
          this.trace(`Middleware ${middlewareName} completed (${middlewareDuration.toFixed(2)}ms)`, {
            operation: 'wrapComputeGeometry',
          });
          return result;
        };
      }
    }

    // Execute chain with initial request
    // Note: Each middleware injects its own runtime, so this initial runtime
    // is only used if there are no middleware (in which case it goes straight to main operation)
    const request: ComputeGeometryRequest = {
      input,
      runtime: runtimes.get(middlewareArray[0]?.name ?? '')!,
    };
    const internalResult = await chain(request);

    // Transform internal result to external result by adding hash to each geometry
    const result: ComputeGeometryResultCompleted = internalResult.success
      ? {
          ...internalResult,
          data: internalResult.data.map((geometry) => ({ ...geometry, hash: dependencyHash })),
        }
      : internalResult;

    const duration = performance.now() - start;
    this.debug(`computeGeometry completed (${duration.toFixed(2)}ms)`, { operation: 'computeGeometry' });

    return result;
  }

  /**
   * Entry point for exporting geometry.
   * Handles timing (no base path needed for export).
   *
   * @param fileType - The file type to export the geometry as.
   * @param geometryId - The geometry ID to export the geometry from.
   * @param meshConfig - The mesh configuration to use when exporting the geometry.
   * @returns The exported geometry.
   */
  public async exportGeometryEntry(
    fileType: ExportFormat,
    geometryId?: string,
    meshConfig?: { linearTolerance: number; angularTolerance: number },
  ): Promise<ExportGeometryResult> {
    // No setBasePath - export doesn't need file context
    const start = performance.now();

    const result = await this.exportGeometry(fileType, geometryId, meshConfig);

    const duration = performance.now() - start;
    this.debug(`exportGeometry completed (${duration.toFixed(2)}ms)`, { operation: 'exportGeometry' });

    return result;
  }

  /**
   * Public method for middleware to access dependency discovery.
   *
   * @param filename - The entry file path (relative to basePath)
   * @returns Array of file paths that are dependencies (including the entry file)
   */
  public async getDependencies(filename: string): Promise<string[]> {
    return this.discoverDependencies(filename);
  }

  /**
   * Worker-specific initialization. Override this method to add custom initialization logic.
   * No need to call super.initialize() - common initialization is handled by initializeEntry.
   */
  protected async initialize(): Promise<void> {
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
   * Log a message.
   *
   * @param message - The message to log.
   * @param options.operation - The current operation being logged.
   * @param options.data - Additional data to log.
   */
  protected log(
    message: string,
    options?: {
      operation?: string;
      data?: unknown;
    },
  ): void {
    this.onLog({
      level: logLevels.info,
      message,
      origin: { component: this.name, operation: options?.operation },
      data: options?.data,
    });
  }

  /**
   * Log a warning message.
   *
   * @param message - The message to log.
   * @param options.operation - The current operation being logged.
   * @param options.data - Additional data to log.
   */
  protected warn(
    message: string,
    options?: {
      operation?: string;
      data?: unknown;
    },
  ): void {
    this.onLog({
      level: logLevels.warn,
      message,
      origin: { component: this.name, operation: options?.operation },
      data: options?.data,
    });
  }

  /**
   * Log an error message.
   *
   * @param message - The message to log.
   * @param options.operation - The current operation being logged.
   * @param options.data - Additional data to log.
   */
  protected error(
    message: string,
    options?: {
      operation?: string;
      data?: unknown;
    },
  ): void {
    this.onLog({
      level: logLevels.error,
      message,
      origin: { component: this.name, operation: options?.operation },
      data: options?.data,
    });
  }

  /**
   * Log a debug message.
   *
   * @param message - The message to log.
   * @param options.operation - The current operation being logged.
   * @param options.data - Additional data to log.
   */
  protected debug(
    message: string,
    options?: {
      operation?: string;
      data?: unknown;
    },
  ): void {
    this.onLog({
      level: logLevels.debug,
      message,
      origin: { component: this.name, operation: options?.operation },
      data: options?.data,
    });
  }

  /**
   * Log a trace message.
   *
   * @param message - The message to log.
   * @param options.operation - The current operation being logged.
   * @param options.data - Additional data to log.
   */
  protected trace(
    message: string,
    options?: {
      operation?: string;
      data?: unknown;
    },
  ): void {
    this.onLog({
      level: logLevels.trace,
      message,
      origin: { component: this.name, operation: options?.operation },
      data: options?.data,
    });
  }

  /**
   * Set the base path for relative file operations based on a GeometryFile.
   * Extracts the directory from the filename and combines it with the path.
   *
   * @param file - The geometry file being processed
   */
  protected setBasePath(file: GeometryFile): void {
    // Store the full relative path for use in error locations
    this.activeFilePath = file.filename;

    // Extract directory from filename (e.g., 'public/kcl-samples/axial-fan/main.kcl' -> 'public/kcl-samples/axial-fan')
    const lastSlashIndex = file.filename.lastIndexOf('/');
    const directory = lastSlashIndex === -1 ? '' : file.filename.slice(0, lastSlashIndex);

    // Combine path with directory to get the full base path
    this.basePath = directory ? `${file.path}/${directory}` : file.path;

    // Log with just the relative part (strip builds/id prefix for readability)
    const displayPath = directory || file.filename;
    this.debug(`Base path set to: ${displayPath}`, { operation: 'setBasePath' });
  }

  /**
   * Get the project root path by stripping the subdirectory from basePath.
   * For basePath '/builds/test/site' with activeFilePath 'site/main.scad',
   * returns '/builds/test'.
   *
   * @returns The project root path
   */
  protected getProjectRootPath(): string {
    const lastSlash = this.activeFilePath.lastIndexOf('/');
    const subDirectory = lastSlash === -1 ? '' : this.activeFilePath.slice(0, lastSlash);

    if (subDirectory && this.basePath.endsWith(`/${subDirectory}`)) {
      return this.basePath.slice(0, -(subDirectory.length + 1));
    }

    return this.basePath;
  }

  /**
   * Read a file relative to the current base path.
   * Resolves the relative path against basePath and logs the operation.
   *
   * @param path - Path relative to the base path
   * @param encoding - Optional encoding ('utf8' for text, omit for binary)
   * @returns The file contents as string (if utf8) or Uint8Array (if binary)
   */
  protected readFile(path: string, encoding: 'utf8'): Promise<string>;
  protected readFile(path: string): Promise<Uint8Array>;
  protected async readFile(path: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    const fullPath = `${this.basePath}/${path}`;
    const start = performance.now();

    this.trace(`Reading file: ${path}`, { operation: 'readFile' });

    const data = await this.fileManager.readFile(fullPath, encoding);

    const duration = performance.now() - start;
    this.trace(`Read ${path} (${duration.toFixed(2)}ms)`, { operation: 'readFile' });

    return data;
  }

  /**
   * Read a file relative to the project root, not basePath.
   * Used for dependency resolution where paths are relative to project root.
   *
   * @param relativePath - Path relative to the project root
   * @param encoding - Optional encoding ('utf8' for text, omit for binary)
   * @returns The file contents as string (if utf8) or Uint8Array (if binary)
   */
  protected readFileFromProjectRoot(relativePath: string, encoding: 'utf8'): Promise<string>;
  protected readFileFromProjectRoot(relativePath: string): Promise<Uint8Array>;
  protected async readFileFromProjectRoot(relativePath: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    const projectRoot = this.getProjectRootPath();
    const fullPath = `${projectRoot}/${relativePath}`;
    return this.fileManager.readFile(fullPath, encoding) as Promise<string | Uint8Array>;
  }

  /**
   * Check if a file exists using a path relative to the current base path.
   * Resolves the relative path against basePath and logs only the relative portion.
   *
   * @param path - Path relative to the base path
   * @returns True if the file exists
   */
  protected async exists(path: string): Promise<boolean> {
    const start = performance.now();
    const fullPath = `${this.basePath}/${path}`;
    this.trace(`Checking file exists: ${path}`, { operation: 'exists' });
    const exists = await this.fileManager.exists(fullPath);
    const duration = performance.now() - start;
    this.trace(`File ${exists ? 'exists' : 'does not exist'}: ${path} (${duration.toFixed(2)}ms)`, {
      operation: 'exists',
    });
    return exists;
  }

  /**
   * Read a directory using a path relative to the current base path.
   * Resolves the relative path against basePath and logs only the relative portion.
   *
   * @param path - Path relative to the base path
   * @returns Array of directory entry names
   */
  protected async readdir(path: string): Promise<string[]> {
    const start = performance.now();
    const fullPath = `${this.basePath}/${path}`;
    this.trace(`Reading directory: ${path}`, { operation: 'readdir' });
    const entries = await this.fileManager.readdir(fullPath);
    const duration = performance.now() - start;
    this.trace(`Read directory ${path}: ${entries.length} entries (${duration.toFixed(2)}ms)`, {
      operation: 'readdir',
    });
    return entries;
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
   * Get the middleware array for this worker.
   * Override in subclasses to customize middleware (e.g., for testing).
   *
   * @returns Array of middleware to apply to kernel operations
   */
  protected getMiddleware(): KernelMiddleware[] {
    return kernelMiddleware;
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
  protected async computeDependencies(filename: string, parameters?: Record<string, unknown>): Promise<Dependency[]> {
    // 1. Gather file dependencies from worker (includes source files)
    const filePaths = await this.discoverDependencies(filename);
    const fileDeps: FileDependency[] = await Promise.all(
      filePaths.map(async (path) => {
        // Use readFileFromProjectRoot since discoverDependencies returns paths relative to project root
        const content = await this.readFileFromProjectRoot(path);
        const contentHash = await this.hashContent(content);
        return {
          type: 'file' as const,
          path,
          contentHash,
        };
      }),
    );

    // 2. Middleware dependencies (index preserves chain order)
    const middlewareDeps: MiddlewareDependency[] = this.getMiddleware().map((middleware, index) => ({
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
   * Create a file manager adapter for middleware.
   * Wraps the Remote<FileManager> to provide the MiddlewareFileManager interface.
   * Override in subclasses for testing without a real FileManager.
   *
   * @returns File manager instance for middleware use
   */
  protected createMiddlewareFileManager(): MiddlewareFileManager {
    const { fileManager } = this;

    // Define readFile with proper overload signatures outside the object literal.
    // This pattern is required because object literals cannot declare overloads directly.
    // See: https://stackoverflow.com/questions/34798989
    function readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
    function readFile(filepath: string): Promise<Uint8Array>;
    async function readFile(filepath: string, options?: 'utf8' | { encoding: 'utf8' }): Promise<string | Uint8Array> {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime guard for overload implementation
      if (options === 'utf8' || (typeof options === 'object' && options.encoding === 'utf8')) {
        return fileManager.readFile(filepath, 'utf8');
      }

      return fileManager.readFile(filepath);
    }

    return {
      readFile,
      async writeFile(filepath: string, data: Uint8Array | string): Promise<void> {
        await fileManager.writeFile(filepath, data);
      },
      async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
        // LightningFS mkdir uses { mode, recursive } - pass the options through
        await fileManager.mkdir(path, { mode: 0o777, ...options });
      },
      async exists(path: string): Promise<boolean> {
        return fileManager.exists(path);
      },
      async ensureDirectoryExists(path: string): Promise<void> {
        await fileManager.ensureDirectoryExists(path);
      },
    };
  }

  /**
   * Check if this worker can handle the given file.
   * This is a lightweight check that should not require heavy initialization.
   *
   * @param params - Object containing path and extension.
   * @returns True if this worker can handle the file, false otherwise.
   */
  protected abstract canHandle(filename: string, extension: string): Promise<boolean>;

  /**
   * Extract parameters from a file.
   *
   * @param path - The file path relative to the base path.
   * @returns The extracted parameters.
   */
  protected abstract extractParameters(path: string): Promise<ExtractParametersResult>;

  /**
   * Compute geometry from a file.
   *
   * @param path - The file path relative to the base path.
   * @param parameters - The parameters to use when computing geometry.
   * @param geometryId - The geometry ID to use when computing geometry.
   * @returns The computed geometry.
   */
  protected abstract computeGeometry(
    path: string,
    parameters: Record<string, unknown>,
    geometryId?: string,
  ): Promise<ComputeGeometryResult>;

  /**
   * Export geometry.
   *
   * @param fileType - The file type to export the geometry as.
   * @param geometryId - The geometry ID to export the geometry from.
   * @param meshConfig - The mesh configuration to use when exporting the geometry.
   * @returns The exported geometry.
   */
  protected abstract exportGeometry(
    fileType: ExportFormat,
    geometryId?: string,
    meshConfig?: { linearTolerance: number; angularTolerance: number },
  ): Promise<ExportGeometryResult>;

  /**
   * Discover all file dependencies for the given entry file.
   * Used for cache key computation to include all imported/included files.
   *
   * @param filename - The entry file path (relative to basePath)
   * @returns Array of file paths that are dependencies (including the entry file)
   */
  protected abstract discoverDependencies(filename: string): Promise<string[]>;

  /**
   * Extract the basename (filename without directory path) from a full path.
   *
   * @param filename - The full filename path (e.g., 'public/kcl-samples/bottle/main.kcl')
   * @returns Just the basename (e.g., 'main.kcl')
   */
  private getBasename(filename: string): string {
    const lastSlashIndex = filename.lastIndexOf('/');
    return lastSlashIndex === -1 ? filename : filename.slice(lastSlashIndex + 1);
  }

  /**
   * Hash file content using SHA-256.
   *
   * @param content - The file content as Uint8Array
   * @returns Full SHA-256 hash as hex string (64 characters)
   */
  private async hashContent(content: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const hashArray = [...new Uint8Array(hashBuffer)];
    return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

    let hash: string;
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      const buffer = await response.arrayBuffer();
      hash = await this.hashContent(new Uint8Array(buffer));
    } catch (error) {
      // Fallback: hash the URL string itself (for tests or network failures)
      this.warn(`Failed to fetch asset for hashing, using URL fallback: ${url}`, {
        operation: 'hashAssetUrl',
        data: error,
      });
      const encoder = new TextEncoder();
      hash = await this.hashContent(encoder.encode(url));
    }

    this.assetHashCache.set(url, hash);
    return hash;
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
