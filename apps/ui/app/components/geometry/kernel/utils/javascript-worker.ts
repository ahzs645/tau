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
  KernelStackFrame,
} from '@taucad/types';
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
    return bundler.bundle(entryPath);
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

    try {
      let url: string;
      let shouldRevoke = false;

      if (isNodejs) {
        // Node.js: Use data URL (blob URLs don't work with import() in Node.js)
        // eslint-disable-next-line @typescript-eslint/naming-convention -- class
        const { Buffer: NodeBuffer } = await import('node:buffer');
        const base64Code = NodeBuffer.from(bundledCode).toString('base64');
        url = `data:application/javascript;base64,${base64Code}`;
      } else {
        // Browser: Use blob URL for better memory management
        const blob = new Blob([bundledCode], { type: 'application/javascript' });
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
        issues: [
          {
            message: error instanceof Error ? error.message : String(error),
            type: 'runtime',
            severity: 'error',
            stackFrames: this.parseStackTrace(error),
          },
        ],
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

      // Validate that main() returned something -- a missing return statement
      // is a common mistake and causes cryptic errors downstream
      // eslint-disable-next-line eqeqeq, no-eq-null -- intentional loose equality to catch both null and undefined
      if (result == null) {
        return {
          success: false,
          issues: [
            {
              message: 'The main function did not return a value. Did you forget a return statement?',
              type: 'runtime',
              severity: 'error',
            },
          ],
        };
      }

      return { success: true, value: result as T };
    } catch (error) {
      return {
        success: false,
        issues: [
          {
            message: error instanceof Error ? error.message : String(error),
            type: 'runtime',
            severity: 'error',
            stackFrames: this.parseStackTrace(error),
          },
        ],
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
      const userFrame = stackFrames.find((frame) => !frame.isInternal) ?? stackFrames[0];
      startLineNumber = userFrame?.lineNumber ?? 0;
      startColumn = userFrame?.columnNumber ?? 0;
    } else if (typeof error === 'string') {
      message = error;
    }

    // Only include location if we have a fileName and meaningful position data
    const hasLocation = fileName && (startLineNumber > 0 || startColumn > 0);

    const issue: KernelIssue = {
      message,
      location: hasLocation ? { fileName, startLineNumber, startColumn } : undefined,
      stack,
      stackFrames: stackFrames.length > 0 ? stackFrames : undefined,
      type: 'runtime',
      severity: 'error',
    };

    return { success: false as const, issues: [issue] };
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
          isInternal: this.isInternalFrame(fileName ?? '', projectPath),
        };

        frames.push(frame);
      }
    }

    return frames;
  }

  /**
   * Classify a stack frame as internal or user code.
   *
   * User code runs in `blob:` URLs (bundled code executed in the VM).
   * Everything else (platform kernel code, node_modules, data URIs)
   * is classified as internal/platform frames.
   *
   * @param fileName - The file name from the stack frame
   * @param projectPath - Project path for comparison
   * @returns True if this is an internal frame
   */
  protected isInternalFrame(fileName: string, projectPath?: string): boolean {
    // Blob: URLs are where user's bundled code runs -- always user code
    if (fileName.startsWith('blob:')) {
      return false;
    }

    // Known internal patterns
    if (
      fileName.includes('/node_modules/') ||
      fileName.startsWith('data:') ||
      fileName.startsWith('node:') ||
      fileName.startsWith('<') ||
      fileName.includes('/kernel/')
    ) {
      return true;
    }

    // If we have a project path, anything outside it is internal
    if (projectPath && !fileName.startsWith(projectPath)) {
      return true;
    }

    return false;
  }

  /**
   * Cleanup resources. Disposes the bundler, clears caches, and removes
   * the global module registry to prevent memory leaks.
   */
  protected override async cleanup(): Promise<void> {
    this.bundler?.dispose();
    this.bundler = undefined;

    // Clear global module registry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-dynamic-delete -- globalThis cleanup
    delete (globalThis as any)[kernelModulesKey];
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
