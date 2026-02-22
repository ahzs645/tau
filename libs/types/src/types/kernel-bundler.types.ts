/**
 * Kernel Bundler Types
 *
 * Types for the bundler subsystem: esbuild-wasm integration, module resolution,
 * and the defineBundler() plugin API for kernel framework extensibility.
 */

import type { KernelIssue } from '#types/kernel.types.js';
import type { KernelFilesystem } from '#types/kernel-worker.types.js';

// =============================================================================
// Bundler Result Types
// =============================================================================

/**
 * Result of bundling a file and its dependencies via esbuild.
 * Used by JS/TS kernels through runtime.bundler.
 */
export type BundleResult = {
  /** The bundled code as a string */
  code: string;
  /** Source map (if enabled) */
  sourceMap?: string;
  /** Compilation issues (errors, warnings) */
  issues: KernelIssue[];
  /** Whether bundling succeeded */
  success: boolean;
  /** Absolute paths of all project files that were resolved during bundling (transitive dependencies). */
  dependencies: string[];
};

/**
 * Result of executing bundled code via dynamic import.
 * Used by JS/TS kernels through runtime.execute().
 */
export type ExecuteResult<T = unknown> = { success: true; value: T } | { success: false; issues: KernelIssue[] };

/**
 * A built-in module registered on the bundler for pre-loaded libraries.
 * These modules are served directly from memory without filesystem I/O.
 */
export type BuiltinModuleEntry = {
  /** Pre-bundled ESM code string */
  code: string;
  /** Package version */
  version: string;
  /** Optional CommonJS global variable name for banner injection */
  globalName?: string;
};

/**
 * Bundler service provided to kernel modules via KernelRuntime.
 * Wraps esbuild-wasm with ZenFS filesystem integration and CDN module resolution.
 * Created lazily on first access -- non-JS kernels incur zero cost.
 */
export type KernelBundler = {
  /** Bundle a file and all its transitive dependencies. */
  bundle(entryPath: string): Promise<BundleResult>;
  /**
   * Resolve all transitive dependencies without generating output code.
   * Equivalent to `(await bundle(entryPath)).dependencies`.
   */
  resolveDependencies(entryPath: string): Promise<string[]>;
  /**
   * Register a built-in module that will be served from memory during bundling.
   * Used by JS/TS kernels to register WASM-loaded libraries (replicad, @jscad/modeling).
   * Must be called before the first bundle() call.
   */
  registerModule(name: string, entry: BuiltinModuleEntry): void;
};

// =============================================================================
// defineBundler API Types
// =============================================================================

/**
 * Options provided to a bundler's initialize() method.
 */
export type BundlerInitOptions = {
  /** Filesystem interface for reading project files */
  filesystem: KernelFilesystem;
  /** Base path for the project (e.g., /builds/project) */
  projectPath: string;
};

/**
 * Input for bundler operations (detectImports, bundle, resolveDependencies).
 */
export type BundleInput = {
  /** Absolute path to the entry file */
  entryPath: string;
};

/**
 * Result of detectImports() -- a lightweight pass that discovers which
 * external modules are imported transitively without resolving them.
 */
export type DetectImportsResult = {
  /** Bare specifiers imported transitively (e.g., 'replicad', '@jscad/modeling') */
  detectedModules: string[];
  /** Project file dependencies discovered during detection (reusable by getDependencies) */
  dependencies: string[];
};

/**
 * Definition for a bundler module loaded via defineBundler().
 * Bundler modules are ES modules dynamically imported by the worker runtime.
 * The bundler owns both bundling AND execution because the execution model
 * is inherently tied to the bundler's output format.
 *
 * Detection (detectImports) and production (bundle) are separate operations:
 * - detectImports: discovers what bare specifiers are used (no modules needed)
 * - bundle: produces runnable code (modules must be registered first)
 *
 * This separation eliminates the chicken-and-egg problem: detection runs
 * without modules registered, then the framework selects and initializes
 * the kernel (which registers real modules), then bundle() produces code.
 *
 * @template Context - Bundler-specific context type returned by initialize()
 */
export type BundlerDefinition<Context = unknown> = {
  name: string;
  version: string;

  /** Initialize the bundler (e.g., load esbuild-wasm). */
  initialize(options: BundlerInitOptions): Promise<Context>;

  /**
   * Detect which bare-specifier modules are imported transitively.
   * Resolves relative imports normally but marks bare specifiers as external.
   * Returns detected modules and project dependencies without producing runnable code.
   * This is the primary mechanism for kernel selection -- no module stubs required.
   */
  detectImports(input: BundleInput, context: Context): Promise<DetectImportsResult>;

  /**
   * Produce runnable code with all registered modules resolved.
   * Called AFTER kernel selection and initialization (modules are registered).
   */
  bundle(input: BundleInput, context: Context): Promise<BundleResult>;

  /** Execute bundled code (tied to this bundler's output format). */
  execute(code: string, context: Context): Promise<ExecuteResult>;

  /** Register a builtin module for resolution during bundle(). */
  registerModule(name: string, builtinModule: BuiltinModuleEntry, context: Context): void;

  /**
   * Optional fast-path dependency resolution without full bundling.
   * Falls back to bundle().dependencies when not implemented.
   */
  resolveDependencies?(input: BundleInput, context: Context): Promise<string[]>;

  /** Clean up bundler resources (e.g., esbuild.stop()). */
  cleanup?(context: Context): Promise<void>;
};

/**
 * Helper function to define a bundler module with proper type inference.
 *
 * @example
 * ```typescript
 * export default defineBundler({
 *   name: 'EsbuildBundler',
 *   version: '1.0.0',
 *   async initialize({ filesystem, projectPath }) { ... },
 *   async detectImports({ entryPath }, context) { ... },
 *   async bundle({ entryPath }, context) { ... },
 *   async execute(code, context) { ... },
 *   registerModule(name, module, context) { ... },
 * });
 * ```
 */
export function defineBundler<Ctx>(definition: BundlerDefinition<Ctx>): BundlerDefinition<Ctx> {
  return definition;
}
