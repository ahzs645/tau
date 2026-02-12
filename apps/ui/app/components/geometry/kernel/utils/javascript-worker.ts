/**
 * JavaScriptWorker Base Class
 *
 * Base class for JavaScript/TypeScript kernel workers that provides:
 * - esbuild-wasm bundling with ZenFS filesystem integration
 * - Module resolution with node_modules support
 * - Built-in module registration (replicad, @jscad/modeling)
 * - TypeScript transpilation
 *
 * Concrete implementations (ReplicadWorker, JscadWorker) extend this class
 * and provide kernel-specific functionality.
 */

import type {
  KernelFilesystem,
  KernelIssue,
  KernelErrorResult,
  KernelRuntime,
  InitializeInput,
  GetDependenciesInput,
  KernelStackFrame,
  ErrorLocation,
  FrameContext,
} from '@taucad/types';
import { SourceMapConsumer } from 'source-map-js';
import { KernelWorker } from '#components/geometry/kernel/utils/kernel-worker.js';
import { EsbuildBundler } from '#components/geometry/kernel/utils/esbuild-bundler.js';
import type { BundleResult } from '#components/geometry/kernel/utils/esbuild-bundler.js';
import type { BuiltinModule } from '#components/geometry/kernel/utils/module-manager.js';
// =============================================================================
// Types
// =============================================================================

export type JavaScriptWorkerOptions = Record<string, unknown>;

export type ExecuteResult<T = unknown> =
  | {
      success: true;
      value: T;
    }
  | {
      success: false;
      issues: KernelIssue[];
    };

export type RuntimeModuleExports = {
  /** Main function -- ESM style: (params) or CommonJS style: (replicad, params) */
  default?: (...args: unknown[]) => unknown;
  /** Main function -- ESM style: (params) or CommonJS style: (replicad, params) */
  main?: (...args: unknown[]) => unknown;
  defaultParams?: Record<string, unknown>;
  defaultParameters?: Record<string, unknown>;
  defaultName?: string;
};

// =============================================================================
// Constants
// =============================================================================

/**
 * Registry key for kernel modules on globalThis.
 * Used by runtime-registered modules (replicad, @jscad/modeling) that
 * cannot be pre-bundled due to WASM dependencies.
 */
const kernelModulesKey = '__KERNEL_MODULES__';

// =============================================================================
// JavaScriptWorker Base Class
// =============================================================================

export abstract class JavaScriptWorker<
  Options extends JavaScriptWorkerOptions = JavaScriptWorkerOptions,
> extends KernelWorker<Options> {
  /**
   * Map of built-in modules.
   * Extended by subclasses to register kernel-specific modules.
   */
  protected readonly builtinModules: Map<string, BuiltinModule>;

  /**
   * The esbuild bundler instance.
   * Initialized during worker initialization.
   */
  private bundler: EsbuildBundler | undefined;

  /**
   * Source map JSON from the most recent bundle.
   * Used to resolve stack trace positions back to original source files.
   */
  private lastSourceMap: string | undefined;

  /**
   * Entry filename from the most recent bundle (e.g., 'main.ts').
   * Used as the `//# sourceURL` directive so DevTools shows a readable name.
   */
  private lastEntryName: string | undefined;

  /**
   * Cache of parsed SourceMapConsumer instances for library source maps.
   * Keyed by module name (e.g., 'replicad'). A value of `undefined` means
   * the source map was attempted but unavailable.
   */
  private readonly librarySourceMapCache = new Map<string, SourceMapConsumer | undefined>();

  /**
   * Constructor - initializes the built-in modules map.
   */
  public constructor() {
    super();
    this.builtinModules = new Map();
  }

  /**
   * Initialize the JavaScript worker.
   * Sets up esbuild and registers built-in modules.
   */
  protected override async initialize(input: InitializeInput<Options>, runtime: KernelRuntime): Promise<void> {
    await super.initialize(input, runtime);

    // Register kernel-specific modules (e.g., replicad, @jscad/modeling)
    await this.registerKernelModules();

    // Initialize the bundler (will be done lazily on first bundle call)
    // We don't initialize here to allow subclasses to register their modules first
  }

  /**
   * Register kernel-specific built-in modules.
   * Override in subclasses to register modules like replicad, @jscad/modeling.
   *
   * These modules are registered at runtime because they require WASM
   * initialization and cannot be pre-bundled as static strings.
   */
  protected async registerKernelModules(): Promise<void> {
    // Base implementation - subclasses override to register their modules
  }

  /**
   * Register a runtime module that's been loaded with WASM dependencies.
   *
   * @param name - The module name (e.g., 'replicad')
   * @param version - The module version
   * @param exports - The module's export object
   * @param options - Optional settings:
   *   - globalName: CommonJS global variable name for banner injection
   *   - submodules: List of submodule paths to register as separate builtins
   *     (e.g., ['primitives', 'booleans'] for '@jscad/modeling/primitives')
   */
  protected registerRuntimeModule(
    name: string,
    version: string,
    exports: Record<string, unknown>,
    options?: { globalName?: string; submodules?: string[] },
  ): void {
    // Register on globalThis for the bundled code to access
    const registry = this.getModuleRegistry();
    registry.set(name, exports);

    // Generate root module shim
    const rootCode = this.generateModuleShim(name, exports);
    this.builtinModules.set(name, { code: rootCode, version, globalName: options?.globalName });

    // Generate submodule shims if requested
    if (options?.submodules) {
      for (const subpath of options.submodules) {
        const submoduleName = `${name}/${subpath}`;
        const submoduleExports = exports[subpath];

        if (submoduleExports && typeof submoduleExports === 'object') {
          const subCode = this.generateSubmoduleShim(name, subpath, submoduleExports as Record<string, unknown>);
          // Submodules don't get globalName (not included in CommonJS banner)
          this.builtinModules.set(submoduleName, { code: subCode, version });
        }
      }
    }
  }

  /**
   * Get the list of names to auto-export from CommonJS-style entry files.
   * Override in subclasses to add kernel-specific names.
   * Default: `['main', 'defaultParams']`
   */
  protected getAutoExportNames(): string[] {
    return ['main', 'defaultParams'];
  }

  /**
   * Get the bundler instance, initializing it if needed.
   */
  protected async getBundler(filesystem: KernelFilesystem, projectPath: string): Promise<EsbuildBundler> {
    if (!this.bundler || this.bundler.getProjectPath() !== projectPath) {
      this.bundler = new EsbuildBundler({
        filesystem,
        projectPath,
        builtinModules: this.builtinModules,
        autoExportNames: this.getAutoExportNames(),
      });
      await this.bundler.initialize();
    }

    return this.bundler;
  }

  /**
   * Bundle a file and all its dependencies.
   *
   * @param entryPath - Absolute path to the entry file
   * @param runtime - Kernel runtime with filesystem access
   * @param projectPath - Project root path for module resolution
   * @returns Bundle result with code and any issues
   */
  protected async bundle(entryPath: string, runtime: KernelRuntime, projectPath: string): Promise<BundleResult> {
    const bundler = await this.getBundler(runtime.filesystem, projectPath);
    const bundleResult = await bundler.bundle(entryPath);

    // Store source map and entry name for stack trace resolution
    this.lastSourceMap = bundleResult.sourceMap;
    this.lastEntryName = entryPath.split('/').pop();

    return bundleResult;
  }

  /**
   * Discover all transitive file dependencies for the given entry file.
   * Uses the esbuild bundler to resolve all imports and extract the list of
   * project files from the metafile. This ensures that changes to any imported
   * file correctly invalidate the geometry cache.
   *
   * @param input - Input containing file path and project root
   * @param runtime - Runtime services (filesystem, logger)
   * @returns Absolute paths of all project files that are dependencies (including the entry file)
   */
  protected override async getDependencies(
    { filePath, basePath }: GetDependenciesInput,
    runtime: KernelRuntime,
  ): Promise<string[]> {
    const bundler = await this.getBundler(runtime.filesystem, basePath);
    const bundleResult = await bundler.bundle(filePath);
    return bundleResult.dependencies;
  }

  /**
   * Execute bundled code and extract CAD module exports.
   *
   * Uses isomorphic approach:
   * - Browser: Blob URL for dynamic import
   * - Node.js: Data URL for dynamic import
   *
   * @param bundledCode - The bundled JavaScript code
   * @returns Execute result with the module exports or error
   */
  protected async execute(bundledCode: string): Promise<ExecuteResult<RuntimeModuleExports>> {
    // Detect Node.js environment
    // eslint-disable-next-line n/prefer-global/process, @typescript-eslint/no-unnecessary-condition -- process may be undefined in browser
    const isNodejs = typeof process !== 'undefined' && Boolean(process.versions?.node);

    // Append sourceURL directive so DevTools shows a readable filename
    // instead of a blob UUID or data URL hash
    const sourceUrlSuffix = this.lastEntryName ? `\n//# sourceURL=${this.lastEntryName}` : '';
    const codeWithSourceUrl = bundledCode + sourceUrlSuffix;

    try {
      let url: string;
      let shouldRevoke = false;

      if (isNodejs) {
        // Node.js: Use data URL (blob URLs don't work with import() in Node.js)
        // eslint-disable-next-line @typescript-eslint/naming-convention -- class
        const { Buffer: NodeBuffer } = await import('node:buffer');
        const base64Code = NodeBuffer.from(codeWithSourceUrl).toString('base64');
        url = `data:application/javascript;base64,${base64Code}`;
      } else {
        // Browser: Use blob URL for better memory management
        const blob = new Blob([codeWithSourceUrl], { type: 'application/javascript' });
        url = URL.createObjectURL(blob);
        shouldRevoke = true;
      }

      try {
        // Dynamic import of the bundled module
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- dynamic import
        const module: RuntimeModuleExports = await import(/* @vite-ignore */ url);
        return { success: true, value: module };
      } finally {
        if (shouldRevoke) {
          URL.revokeObjectURL(url);
        }
      }
    } catch (error) {
      return {
        success: false,
        issues: [await this.formatRuntimeError(error)],
      };
    }
  }

  /**
   * Get the module to inject as the first argument for CommonJS-style
   * main functions (arity >= 2). Override in subclasses to specify which
   * built-in module to inject. Default: returns the first registered builtin.
   *
   * @returns The module exports to inject, or undefined if none
   */
  protected getCommonJsInjectedModule(): Record<string, unknown> | undefined {
    const registry = this.getModuleRegistry();
    // Return the first registered module
    const first = registry.values().next();
    return first.done ? undefined : first.value;
  }

  /**
   * Format a runtime error into a KernelIssue.
   * Subclasses may override to handle kernel-specific error types (e.g., OpenCASCADE numeric exceptions).
   *
   * @param error - The error thrown during main function execution
   * @returns A KernelIssue for the error
   */
  protected async formatRuntimeError(error: unknown): Promise<KernelIssue> {
    const stackFrames = await this.applyLibrarySourceMaps(this.parseStackTrace(error));
    const location = this.deriveLocationFromFrames(stackFrames);
    return {
      message: error instanceof Error ? error.message : String(error),
      location,
      type: 'runtime',
      severity: 'error',
      stackFrames,
    };
  }

  /**
   * Run the main function from a CAD module with parameters.
   *
   * Supports two calling conventions:
   * - ESM style: main(params) or default(params) - single parameter
   * - CommonJS style: main(kernelModule, params) - two parameters (legacy)
   *
   * The convention is detected by checking the function's arity (length property).
   *
   * @param module - The CAD module exports
   * @param parameters - Parameters to pass to the main function
   * @returns The result of calling main/default
   */
  protected async runMain<T>(
    module: RuntimeModuleExports,
    parameters: Record<string, unknown>,
  ): Promise<ExecuteResult<T>> {
    try {
      // Find the main function
      const mainFunction = module.default ?? module.main;

      if (!mainFunction || typeof mainFunction !== 'function') {
        return {
          success: false,
          issues: [
            {
              message: 'No main or default export function found',
              type: 'runtime',
              severity: 'error',
            },
          ],
        };
      }

      // Detect CommonJS-style (2 params: kernelModule, params) vs ESM-style (1 param: params)
      // Use function.length to check the expected number of parameters
      const isCommonJsStyle = mainFunction.length >= 2;

      // Execute the main function with appropriate arguments
      const result = isCommonJsStyle
        ? await mainFunction(this.getCommonJsInjectedModule(), parameters)
        : await mainFunction(parameters);

      return { success: true, value: result as T };
    } catch (error) {
      return {
        success: false,
        issues: [await this.formatRuntimeError(error)],
      };
    }
  }

  /**
   * Extract default parameters from a CAD module.
   *
   * @param module - The CAD module exports
   * @returns Default parameters object
   */
  protected extractDefaultParams(module: RuntimeModuleExports): Record<string, unknown> {
    return module.defaultParams ?? module.defaultParameters ?? {};
  }

  /**
   * Extract the default name from a CAD module.
   *
   * @param module - The CAD module exports
   * @returns Default name or undefined
   */
  protected extractDefaultName(module: RuntimeModuleExports): string | undefined {
    return module.defaultName;
  }

  /**
   * Create a KernelErrorResult from an error with stack trace parsing.
   *
   * Consolidates the common pattern of:
   * 1. Extracting the error message
   * 2. Parsing the stack trace into structured frames
   * 3. Finding the first user frame for location
   * 4. Building a KernelErrorResult
   *
   * @param error - The error to convert
   * @param fallbackMessage - Message to use if error is not an Error instance
   * @param fileName - Optional file name for error location
   * @returns A KernelErrorResult with structured issue information
   */
  protected createKernelIssueFromError(error: unknown, fallbackMessage: string, fileName?: string): KernelErrorResult {
    let message = fallbackMessage;
    let stack: string | undefined;
    let stackFrames: KernelStackFrame[] = [];
    let startLineNumber = 0;
    let startColumn = 0;

    if (error instanceof Error) {
      message = error.message;
      stack = error.stack;
      stackFrames = this.parseStackTrace(error);

      // Find the first user frame for location
      const userFrame = stackFrames.find((frame) => frame.context === 'user') ?? stackFrames[0];
      startLineNumber = userFrame?.lineNumber ?? 0;
      startColumn = userFrame?.columnNumber ?? 0;
    } else if (typeof error === 'string') {
      message = error;
    }

    // Include location when fileName is available, defaulting to line 1 of the file.
    // This ensures users can always navigate to the file being rendered,
    // even when the stack trace doesn't contain user-code frames (e.g., missing exports).
    const issue: KernelIssue = {
      message,
      location: fileName
        ? { fileName, startLineNumber: startLineNumber || 1, startColumn: startColumn || 0 }
        : undefined,
      stack,
      stackFrames: stackFrames.length > 0 ? stackFrames : undefined,
      type: 'runtime',
      severity: 'error',
    };

    return { success: false as const, issues: [issue] };
  }

  /**
   * Enrich kernel issues with a fallback location when they don't already have one.
   *
   * When errors from `execute()` or `runMain()` don't contain user-code stack frames
   * (e.g., module loading errors, missing exports), the issues won't have a location.
   * This method adds a fallback location pointing to the first line of the file being
   * rendered, so that the user can still navigate to the file.
   *
   * Issues that already have a location are left unchanged.
   *
   * @param issues - The kernel issues to enrich
   * @param fileName - The file name to use as fallback location (relative to project root)
   * @returns Issues with fallback locations added where missing
   */
  protected enrichIssuesWithFallbackLocation(issues: KernelIssue[], fileName: string): KernelIssue[] {
    return issues.map((issue) => ({
      ...issue,
      location: issue.location ?? { fileName, startLineNumber: 1, startColumn: 0 },
    }));
  }

  /**
   * Parse an error's stack trace into structured stack frames.
   *
   * @param error - The error to parse
   * @param projectPath - Project path for classifying internal vs user frames
   * @returns Array of stack frames
   */
  protected parseStackTrace(error: unknown, projectPath?: string): KernelStackFrame[] {
    if (!(error instanceof Error) || !error.stack) {
      return [];
    }

    const frames: KernelStackFrame[] = [];
    const lines = error.stack.split('\n');

    for (const line of lines) {
      // Match common stack frame formats
      // Chrome: "    at functionName (file:line:column)"
      // Firefox: "functionName@file:line:column"
      const chromeMatch = /^\s*at\s+(?:(.+?)\s+)?\(?(.+):(\d+):(\d+)\)?$/.exec(line);
      const firefoxMatch = /^(.*)@(.+):(\d+):(\d+)$/.exec(line);

      const match = chromeMatch ?? firefoxMatch;
      if (match) {
        const [, functionName, fileName, lineNumber, columnNumber] = match;

        const frame: KernelStackFrame = {
          functionName: functionName ?? '<anonymous>',
          fileName: fileName ?? '',
          lineNumber: Number.parseInt(lineNumber ?? '0', 10),
          columnNumber: Number.parseInt(columnNumber ?? '0', 10),
          context: this.classifyFrame(fileName ?? '', projectPath),
        };

        frames.push(frame);
      }
    }

    // Apply source map resolution to map generated positions back to original source
    return this.applySourceMapToFrames(frames);
  }

  /**
   * Get patterns for identifying library frames.
   * Override in subclasses to register kernel-specific libraries.
   *
   * Each entry maps a path pattern to a module name. The module name
   * is used to look up the library's source map in `builtinModules`.
   *
   * @returns Array of `{ pattern, moduleName }` entries
   */
  protected getLibraryPathPatterns(): Array<{ pattern: string; moduleName: string }> {
    return [];
  }

  /**
   * Classify a stack frame's origin.
   *
   * - `user` -- developer's project code (blob: URLs after bundling)
   * - `library` -- third-party CAD libraries the user imported (replicad, @jscad/modeling)
   * - `framework` -- kernel worker infrastructure (Proxy traps, bundler, kernel code)
   * - `runtime` -- V8/Emscripten/WASM boundary frames, `node:` internals, native code
   *
   * @param fileName - The file name from the stack frame
   * @param projectPath - Project path for comparison
   * @returns The frame's context classification
   */
  protected classifyFrame(fileName: string, projectPath?: string): FrameContext {
    // 1. Blob URLs are bundled user code
    if (fileName.startsWith('blob:')) {
      return 'user';
    }

    // 2. Check library patterns BEFORE generic node_modules check
    const libraryPatterns = this.getLibraryPathPatterns();
    if (libraryPatterns.some((lib) => fileName.includes(lib.pattern))) {
      return 'library';
    }

    // 3. Runtime: engine and native frames
    if (fileName.startsWith('node:') || fileName.startsWith('<') || fileName.startsWith('wasm:')) {
      return 'runtime';
    }

    // 4. Framework: our infrastructure
    if (fileName.includes('/node_modules/') || fileName.startsWith('data:') || fileName.includes('/kernel/')) {
      return 'framework';
    }

    // 5. Outside project path = framework
    if (projectPath && !fileName.startsWith(projectPath)) {
      return 'framework';
    }

    return 'user';
  }

  /**
   * Load the source map JSON string for a library module.
   * Override in subclasses to provide library-specific source maps.
   * Called once per module on first error with library frames; result is cached.
   *
   * @param _moduleName - The library module name (e.g., 'replicad')
   * @returns The source map JSON string, or undefined if unavailable
   */
  protected async loadLibrarySourceMap(_moduleName: string): Promise<string | undefined> {
    return undefined;
  }

  /**
   * Derive an ErrorLocation from the first non-internal stack frame.
   * Returns undefined if no user-code frame with a valid position exists.
   *
   * @param frames - Parsed (and source-mapped) stack frames
   * @returns ErrorLocation for the first user frame, or undefined
   */
  protected deriveLocationFromFrames(frames: KernelStackFrame[]): ErrorLocation | undefined {
    const userFrame = frames.find((frame) => frame.context === 'user');
    if (!userFrame?.fileName || !userFrame.lineNumber) {
      return undefined;
    }

    //
    const startLineNumber = userFrame.lineNumber;
    let startColumn = userFrame.columnNumber ?? 1;
    let endColumn: number | undefined;

    // Use the source map's own mapping data to compute the expression extent.
    // Each mapping segment represents a token/expression boundary as determined
    // by the bundler (esbuild). By collecting all mapped columns on the error's
    // original line, we can determine how far the expression spans without
    // any string parsing or heuristic expression matching.
    if (this.lastSourceMap) {
      try {
        const extent = this.computeExpressionExtentFromSourceMap(userFrame.fileName, startLineNumber, startColumn);
        if (extent) {
          startColumn = extent.startColumn;
          endColumn = extent.endColumn;
        }
      } catch {
        // Fall through with no endColumn on source map errors
      }
    }

    return {
      fileName: userFrame.fileName,
      startLineNumber,
      startColumn,
      endLineNumber: endColumn === undefined ? undefined : startLineNumber,
      endColumn,
    };
  }

  /**
   * Cleanup resources. Disposes the bundler, clears caches, and removes
   * the global module registry to prevent memory leaks.
   */
  protected override async cleanup(): Promise<void> {
    this.bundler?.dispose();
    this.bundler = undefined;
    this.lastSourceMap = undefined;
    this.lastEntryName = undefined;
    this.librarySourceMapCache.clear();

    // Clear global module registry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-dynamic-delete -- globalThis cleanup
    delete (globalThis as any)[kernelModulesKey];
  }

  /**
   * Apply library source maps to resolve library frames to original TS positions.
   *
   * For frames with `context: 'library'`, looks up the library's source map
   * (loaded lazily and cached) and resolves the compiled JS position back to
   * the original TypeScript source file and line number.
   *
   * Falls back gracefully: if the source map is unavailable or has no mapping
   * for a given position, the frame is returned unchanged.
   *
   * @param frames - Stack frames (after bundle source map resolution)
   * @returns Frames with library positions resolved where possible
   */
  protected async applyLibrarySourceMaps(frames: KernelStackFrame[]): Promise<KernelStackFrame[]> {
    const libraryPatterns = this.getLibraryPathPatterns();
    if (libraryPatterns.length === 0) {
      return frames;
    }

    return Promise.all(
      frames.map(async (frame) => {
        if (frame.context !== 'library' || !frame.fileName || !frame.lineNumber) {
          return frame;
        }

        // Find which library this frame belongs to
        const lib = libraryPatterns.find((l) => frame.fileName!.includes(l.pattern));
        if (!lib) {
          return frame;
        }

        // Try source map chaining: resolve compiled JS positions -> original TS positions.
        // This is needed in browsers where Error.stack contains raw compiled paths.
        const consumer = await this.getLibrarySourceMapConsumer(lib.moduleName);
        if (consumer) {
          try {
            const original = consumer.originalPositionFor({
              line: frame.lineNumber,
              column: (frame.columnNumber ?? 1) - 1,
            });

            if (original.source) {
              // Source map chaining succeeded (browser path)
              return {
                ...frame,
                fileName: this.resolveLibrarySourcePath(lib.moduleName, original.source),
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
                lineNumber: original.line ?? frame.lineNumber,
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
                columnNumber: (original.column ?? 0) + 1,
                functionName: original.name ?? frame.functionName,
              };
            }
          } catch {
            // Fall through to path normalization
          }
        }

        // No source map or no mapping found. The frame may already have a resolved
        // TS path (V8/Node.js applies source maps to Error.stack automatically).
        // Just normalize the existing fileName to a clean display path.
        return {
          ...frame,
          fileName: this.resolveLibrarySourcePath(lib.moduleName, frame.fileName),
        };
      }),
    );
  }

  /**
   * Apply source map resolution to parsed stack frames.
   *
   * Maps generated (post-bundle) positions in blob:/data: URLs back to
   * original source file paths and line/column numbers using the inline
   * source map produced by esbuild.
   *
   * @param frames - Parsed stack frames with generated positions
   * @returns Frames with resolved original positions where possible
   */
  private applySourceMapToFrames(frames: KernelStackFrame[]): KernelStackFrame[] {
    if (!this.lastSourceMap) {
      return frames;
    }

    try {
      const rawMap: unknown = JSON.parse(this.lastSourceMap);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- source-map-js accepts parsed JSON
      const consumer = new SourceMapConsumer(rawMap as any);

      return frames.map((frame) => {
        // Only map frames from the bundled code (blob: or data: URLs, or sourceURL name)
        const name = frame.fileName ?? '';
        const isBundledFrame = name.startsWith('blob:') || name.startsWith('data:') || name === this.lastEntryName;

        if (!isBundledFrame) {
          return frame;
        }

        if (!frame.lineNumber) {
          return frame;
        }

        const original = consumer.originalPositionFor({
          line: frame.lineNumber,
          // Source-map uses 0-based columns
          column: (frame.columnNumber ?? 1) - 1,
        });

        if (!original.source) {
          return frame;
        }

        // Convert source path to project-relative path
        const fileName = this.resolveSourcePath(original.source);

        return {
          ...frame,
          fileName,
          // Resolve to original positions; fall back to generated positions
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
          lineNumber: original.line ?? frame.lineNumber,
          // Back to 1-based column
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- source-map-js returns null at runtime despite types saying number
          columnNumber: (original.column ?? 0) + 1,
          functionName: original.name ?? frame.functionName,
          // Mapped user code from the bundle is always user code
          context: 'user',
        };
      });
    } catch {
      // Fall back to unmapped frames on any error
      return frames;
    }
  }

  /**
   * Get or create a cached SourceMapConsumer for a library module.
   * Returns undefined if the source map is unavailable.
   */
  private async getLibrarySourceMapConsumer(moduleName: string): Promise<SourceMapConsumer | undefined> {
    if (this.librarySourceMapCache.has(moduleName)) {
      return this.librarySourceMapCache.get(moduleName);
    }

    try {
      const sourceMapJson = await this.loadLibrarySourceMap(moduleName);
      if (!sourceMapJson) {
        this.librarySourceMapCache.set(moduleName, undefined);
        return undefined;
      }

      const rawMap: unknown = JSON.parse(sourceMapJson);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- source-map-js accepts parsed JSON
      const consumer = new SourceMapConsumer(rawMap as any);
      this.librarySourceMapCache.set(moduleName, consumer);
      return consumer;
    } catch {
      this.librarySourceMapCache.set(moduleName, undefined);
      return undefined;
    }
  }

  /**
   * Resolve a library source map path to a clean display path.
   *
   * Library source maps use relative paths like `../src/sketches/Sketch.ts`.
   * This normalizes them to `{moduleName}/src/sketches/Sketch.ts`.
   *
   * @param moduleName - The library module name (e.g., 'replicad')
   * @param rawSource - The raw source path from the source map
   * @returns Normalized display path
   */
  private resolveLibrarySourcePath(moduleName: string, rawSource: string): string {
    let clean = rawSource;

    // Strip file:// protocol prefix
    if (clean.startsWith('file://')) {
      clean = clean.slice(7);
    }

    // If the path contains a node_modules segment, extract everything after the package root.
    // e.g., "/path/to/node_modules/replicad/src/sketches/Sketch.ts" -> "src/sketches/Sketch.ts"
    const nodeModulesPattern = `node_modules/${moduleName}/`;
    const nodeModulesIndex = clean.indexOf(nodeModulesPattern);
    if (nodeModulesIndex === -1) {
      // Fall back: strip leading '../' and './' segments
      while (clean.startsWith('../')) {
        clean = clean.slice(3);
      }

      while (clean.startsWith('./')) {
        clean = clean.slice(2);
      }
    } else {
      clean = clean.slice(nodeModulesIndex + nodeModulesPattern.length);
    }

    // Normalize separators
    clean = clean.replaceAll('\\', '/').replaceAll(/\/+/g, '/');

    // Prefix with module name
    return `${moduleName}/${clean}`;
  }

  /**
   * Resolve a source map path to a project-relative path.
   *
   * esbuild source maps contain paths prefixed with the namespace (e.g., `zenfs:main.ts`).
   * The plugin uses project-relative paths within the zenfs namespace, so after stripping
   * the namespace prefix the path is already clean. For backwards compatibility, this also
   * handles absolute paths by stripping the project prefix.
   *
   * @param sourcePath - Source path from the source map
   * @returns Project-relative path
   */
  private resolveSourcePath(sourcePath: string): string {
    // Strip esbuild namespace prefix (e.g., "zenfs:main.ts" -> "main.ts")
    const zenfsPrefix = 'zenfs:';
    const cleanPath = sourcePath.startsWith(zenfsPrefix) ? sourcePath.slice(zenfsPrefix.length) : sourcePath;

    // Strip project path prefix for absolute paths (e.g., "/builds/id/main.ts" -> "main.ts")
    const projectPath = this.bundler?.getProjectPath();
    if (projectPath && cleanPath.startsWith(projectPath)) {
      const relative = cleanPath.slice(projectPath.length);
      return relative.startsWith('/') ? relative.slice(1) : relative;
    }

    // Path is already relative (common case with project-relative zenfs paths)
    if (!cleanPath.startsWith('/')) {
      return cleanPath;
    }

    // Fall back to basename for unknown absolute paths
    return cleanPath.split('/').pop() ?? cleanPath;
  }

  /**
   * Compute the expression extent (start/end columns) from source map mapping data.
   *
   * Uses the bundler's own mapping segments to determine how far the expression
   * spans on the original line. Each mapping segment represents a token boundary
   * as determined by esbuild, so this is compiler-driven rather than string-based.
   *
   * Also extends startColumn backward to include a leading '.' for method calls
   * (e.g., `.extrude(0)`) by checking the embedded source content.
   *
   * @param fileName - Resolved source file name (e.g., 'main.ts')
   * @param lineNumber - 1-based line number in original source
   * @param startColumn - 1-based column from the stack frame
   * @returns Adjusted startColumn and endColumn, or undefined
   */
  private computeExpressionExtentFromSourceMap(
    fileName: string,
    lineNumber: number,
    startColumn: number,
  ): { startColumn: number; endColumn: number } | undefined {
    const rawMap: unknown = JSON.parse(this.lastSourceMap!);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- source-map-js accepts parsed JSON
    const consumer = new SourceMapConsumer(rawMap as any);

    // Find the raw source name (e.g., 'zenfs:main.ts') matching the resolved fileName
    let sourceName: string | undefined;
    for (const source of consumer.sources) {
      if (this.resolveSourcePath(source) === fileName) {
        sourceName = source;
        break;
      }
    }

    if (!sourceName) {
      return undefined;
    }

    let adjustedStartColumn = startColumn;

    // Extend startColumn backward to include leading '.' (method call syntax)
    // by checking the embedded source content in the source map.
    const sourceContent = consumer.sourceContentFor(sourceName) ?? undefined;
    if (sourceContent) {
      const lines = sourceContent.split('\n');
      const line = lines[lineNumber - 1];
      if (line && startColumn > 1 && line[startColumn - 2] === '.') {
        adjustedStartColumn = startColumn - 1;
      }
    }

    // Collect all original columns that the bundler mapped on this source line.
    // These represent token/expression boundaries in the compiled output.
    const columnsOnLine: number[] = [];
    consumer.eachMapping((mapping) => {
      if (mapping.source === sourceName && mapping.originalLine === lineNumber && mapping.originalColumn !== null) {
        columnsOnLine.push(mapping.originalColumn); // 0-based
      }
    });

    if (columnsOnLine.length === 0) {
      return undefined;
    }

    // Find the last mapped column at or after our start position.
    // This is the furthest point in the expression that the bundler tracked.
    const start0 = adjustedStartColumn - 1; // Convert to 0-based
    const lastMappedColumn = columnsOnLine
      .filter((col) => col >= start0)
      .sort((a, b) => a - b)
      .pop();

    if (lastMappedColumn === undefined) {
      return undefined;
    }

    // Convert to 1-based exclusive endColumn: +1 for the character at the position, +1 for 1-based
    return { startColumn: adjustedStartColumn, endColumn: lastMappedColumn + 2 };
  }

  /**
   * Generate an ESM shim for a root module.
   * Reads from the globalThis.__KERNEL_MODULES__ registry.
   */
  private generateModuleShim(name: string, exports: Record<string, unknown>): string {
    const isValidIdentifier = (key: string): boolean =>
      key !== '__esModule' && key !== 'default' && /^[a-z_$][\w$]*$/i.test(key);

    const exportNames = Object.keys(exports).filter((element) => isValidIdentifier(element));

    // For CommonJS modules imported via ESM, the actual exports might be on `default`
    // If we have few valid exports but `default` has many, re-export from `default`
    const defaultExports = exports['default'];
    const hasRichDefault =
      defaultExports &&
      typeof defaultExports === 'object' &&
      Object.keys(defaultExports).filter((element) => isValidIdentifier(element)).length > exportNames.length;

    let namedExports: string;
    let defaultExport: string;

    if (hasRichDefault) {
      const defaultKeys = Object.keys(defaultExports).filter((element) => isValidIdentifier(element));
      namedExports = defaultKeys.map((key) => `export const ${key} = __m.default.${key};`).join('\n');
      defaultExport = '\nexport default __m.default;';
    } else {
      namedExports = exportNames.map((key) => `export const ${key} = __m.${key};`).join('\n');
      defaultExport = 'default' in exports ? '\nexport default __m.default;' : '';
    }

    const escapedName = JSON.stringify(name);
    return `const __m = globalThis.${kernelModulesKey}.get(${escapedName});
${namedExports}${defaultExport}
`;
  }

  /**
   * Generate an ESM shim for a submodule.
   * Reads the namespace object from the parent module on globalThis.
   *
   * @param parentName - The parent module name (e.g., '@jscad/modeling')
   * @param subpath - The submodule path (e.g., 'primitives')
   * @param subExports - The submodule's export object (for extracting named exports)
   */
  private generateSubmoduleShim(parentName: string, subpath: string, subExports: Record<string, unknown>): string {
    const isValidIdentifier = (key: string): boolean =>
      key !== '__esModule' && key !== 'default' && /^[a-z_$][\w$]*$/i.test(key);

    const exportNames = Object.keys(subExports).filter((element) => isValidIdentifier(element));
    const escapedParentName = JSON.stringify(parentName);

    const namedExports = exportNames.map((key) => `export const ${key} = __sub.${key};`).join('\n');

    return `const __m = globalThis.${kernelModulesKey}.get(${escapedParentName});
const __sub = __m.${subpath};
${namedExports}
export default __sub;
`;
  }

  /**
   * Get or create the module registry on globalThis.
   */
  private getModuleRegistry(): Map<string, Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis access
    let registry = (globalThis as any)[kernelModulesKey] as Map<string, Record<string, unknown>> | undefined;

    if (!registry) {
      registry = new Map();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- globalThis access
      (globalThis as any)[kernelModulesKey] = registry;
    }

    return registry;
  }
}
