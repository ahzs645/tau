/**
 * Kernel Worker Types
 *
 * Types specific to kernel worker implementation, middleware, and internal operations.
 * These types are used by kernel developers and middleware authors.
 *
 * For shared result/error types used across the codebase, see kernel.types.ts.
 */

import type { PartialDeep } from 'type-fest';
import type { ExportFormat, FileStat } from '#types/file.types.js';
import type { LogLevel } from '#types/logger.types.js';
import type { CreateGeometryResult, ExportGeometryResult, GetParametersResult } from '#types/kernel.types.js';

// =============================================================================
// Dependency Types
// =============================================================================

/**
 * A file dependency representing a source file or font file.
 * The contentHash is a SHA-256 hash of the file's contents.
 */
export type FileDependency = {
  type: 'file';
  /** Path to the file relative to the build directory */
  path: string;
  /** SHA-256 hash of the file contents */
  contentHash: string;
};

/**
 * A middleware dependency representing a middleware in the chain.
 * The index preserves the execution order in the chain.
 */
export type MiddlewareDependency = {
  type: 'middleware';
  /** Name of the middleware */
  name: string;
  /** Version of the middleware */
  version: string;
  /** Position in the middleware chain (0-indexed) */
  index: number;
};

/**
 * A framework dependency representing the Tau framework version.
 */
export type FrameworkDependency = {
  type: 'framework';
  /** Framework name (always 'tau') */
  name: 'tau';
  /** Version string from package.json */
  version: string;
};

/**
 * An option dependency representing a kernel configuration option.
 * Used to track mesh tolerances, backend arguments, etc.
 */
export type OptionDependency = {
  type: 'option';
  /** Option key (e.g., 'meshConfiguration', 'arguments') */
  key: string;
  /** Option value (serialized to JSON for hashing) */
  value: unknown;
};

/**
 * A parameter dependency representing user-provided parameter values.
 * Used to invalidate cache when parameter values change.
 */
export type ParameterDependency = {
  type: 'parameter';
  /** SHA-256 hash of serialized parameters */
  parametersHash: string;
};

/**
 * An asset dependency representing a bundled asset (font, WASM, etc.).
 * Used to invalidate cache when assets change between deployments.
 */
export type AssetDependency = {
  type: 'asset';
  /** Asset identifier (e.g., 'font:Geist-Regular.ttf', 'wasm:opencascade') */
  name: string;
  /** SHA-256 hash of the asset content */
  contentHash: string;
};

/**
 * Discriminated union of all dependency types.
 * Used for cache key computation to ensure all factors affecting
 * the output are captured.
 */
export type Dependency =
  | FileDependency
  | MiddlewareDependency
  | FrameworkDependency
  | OptionDependency
  | ParameterDependency
  | AssetDependency;

// =============================================================================
// Kernel Method Types
// =============================================================================

/**
 * Logger options for kernel and middleware logging methods.
 */
export type KernelLogOptions = {
  /** Additional data to include in the log */
  data?: unknown;
};

/**
 * Logger interface for kernel methods and middleware.
 * Provides convenience methods that automatically inject the component name.
 */
export type KernelLogger = {
  /** Log an info-level message */
  log: (message: string, options?: KernelLogOptions) => void;
  /** Log a debug-level message */
  debug: (message: string, options?: KernelLogOptions) => void;
  /** Log a trace-level message */
  trace: (message: string, options?: KernelLogOptions) => void;
  /** Log a warning-level message */
  warn: (message: string, options?: KernelLogOptions) => void;
  /** Log an error-level message */
  error: (message: string, options?: KernelLogOptions) => void;
  /**
   * Log a message with a dynamic log level.
   * Useful for kernels like OpenSCAD that determine log level at runtime.
   */
  custom: (level: LogLevel, message: string, options?: KernelLogOptions) => void;
};

/**
 * Unified filesystem interface for kernel workers.
 * All paths are absolute - callers use helper methods to construct paths.
 */
export type KernelFilesystem = {
  // ---- Read operations (all absolute paths) ----
  /** Read file as text */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** Read file as binary */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Check if path exists */
  exists(path: string): Promise<boolean>;
  /** List directory entries */
  readdir(path: string): Promise<string[]>;

  // ---- Write operations (all absolute paths) ----
  /** Write file */
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  /** Create directory */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Delete file */
  unlink(path: string): Promise<void>;
  /** Ensure directory exists, creating parents as needed */
  ensureDirectoryExists(path: string): Promise<void>;

  // ---- Directory operations (all absolute paths) ----
  /** Get directory contents as map of relative paths to content */
  getDirectoryContents(path: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  /** Get file stats for directory recursively */
  getDirectoryStat(path: string): Promise<FileStat[]>;
};

/**
 * Runtime services provided to kernel methods.
 */
export type KernelRuntime = {
  /** Filesystem interface (all paths are absolute) */
  filesystem: KernelFilesystem;
  /** Logger with kernel name pre-configured */
  logger: KernelLogger;
};

/**
 * Input for kernel getParameters method.
 */
export type GetParametersInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
};

/**
 * Input for kernel createGeometry method.
 */
export type CreateGeometryInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
  /** User-provided parameters */
  parameters: Record<string, unknown>;
};

/**
 * Input for kernel getDependencies method.
 */
export type GetDependenciesInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
};

/**
 * Input for kernel canHandle method.
 */
export type CanHandleInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
  /** File extension (without dot) */
  extension: string;
};

/**
 * Input for kernel initialize method.
 */
export type InitializeInput<Options = Record<string, unknown>> = {
  /** Worker options */
  options: Options;
};

/**
 * Input for kernel exportGeometry method.
 */
export type ExportGeometryInput = {
  /** Export file format */
  fileType: ExportFormat;
  /** Optional mesh configuration for tessellation */
  meshConfig?: { linearTolerance: number; angularTolerance: number };
};

/**
 * Type-safe state for middleware to persist data during an operation.
 *
 * The state is scoped to a single middleware and persists for the duration of
 * one operation (e.g., one createGeometry call). In wrap-style hooks, state
 * can be updated before calling handler() and read after it returns.
 *
 * @template T - The state schema type inferred from Zod. Must be an object type.
 */
export type MiddlewareState<T extends Record<string, unknown>> = {
  /**
   * Current state value.
   * Type is PartialDeep<T> since update() may be called with partial data
   * or not called at all.
   */
  readonly value: PartialDeep<T>;

  /**
   * Update the state with partial data.
   * Values are validated against the Zod schema before being merged.
   *
   * @param partial - Partial data to merge into the state
   */
  update: (partial: Partial<T>) => void;
};

/**
 * Runtime context provided to middleware wrap hooks.
 * Contains services and utilities available during hook execution.
 *
 * @template State - The state type inferred from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type KernelMiddlewareRuntime<State extends Record<string, unknown> = {}> = {
  /** Logger with middleware name pre-configured as the component */
  logger: KernelLogger;
  /** Filesystem for all file operations (uses absolute path methods for middleware) */
  filesystem: KernelFilesystem;
  /** Type-safe state for persisting data during the wrap hook execution */
  state: MiddlewareState<State>;
  /**
   * Dependencies for cache key computation.
   * Includes file dependencies (source files, fonts), middleware signatures,
   * framework version, and kernel options.
   */
  dependencies: readonly Dependency[];
  /**
   * Pre-computed SHA-256 hash of all dependencies.
   * Can be used as a cache key or unique geometry identifier.
   * This is a 64-character hex string.
   */
  dependencyHash: string;
};

// =============================================================================
// Middleware Handler Types (Wrap-Style Hooks)
// =============================================================================

/**
 * Handler function for createGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 * Uses internal geometry types (without hash) - hash is added by kernel-worker.ts.
 */
export type CreateGeometryHandler = (input: CreateGeometryInput) => Promise<CreateGeometryResult>;

/**
 * Handler function for exportGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 */
export type ExportGeometryHandler = (input: ExportGeometryInput) => Promise<ExportGeometryResult>;

/**
 * Handler function for getParameters.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Runtime is captured in the handler's closure, so middleware only passes input.
 */
export type GetParametersHandler = (input: GetParametersInput) => Promise<GetParametersResult>;

// =============================================================================
// Middleware Wrap Hook Types
// =============================================================================

/**
 * Wrap-style hook for createGeometry.
 * Provides full control over execution: can short-circuit, transform input/output,
 * or add pre/post processing. Code after handler() runs on the "return journey"
 * (onion model), so short-circuited results still flow through upstream middleware.
 *
 * Arguments: (input, handler, runtime)
 * - input: what to process (destructure what you need)
 * - handler: call to continue the chain (always used)
 * - runtime: services like logger/filesystem (only destructure if needed)
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 *
 * @example
 * ```typescript
 * async wrapCreateGeometry({ basePath }, handler, { logger, filesystem, dependencyHash }) {
 *   // PRE: Check cache
 *   const cached = await checkCache(basePath, dependencyHash);
 *   if (cached) return cached;  // Short-circuit
 *
 *   // EXECUTE: Call downstream (just pass input)
 *   const result = await handler(input);
 *
 *   // POST: Transform result (runs even if upstream short-circuited)
 *   return transform(result);
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapCreateGeometryHook<State extends Record<string, unknown> = {}> = (
  input: CreateGeometryInput,
  handler: CreateGeometryHandler,
  runtime: KernelMiddlewareRuntime<State>,
) => Promise<CreateGeometryResult>;

/**
 * Wrap-style hook for exportGeometry.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapExportGeometryHook<State extends Record<string, unknown> = {}> = (
  input: ExportGeometryInput,
  handler: ExportGeometryHandler,
  runtime: KernelMiddlewareRuntime<State>,
) => Promise<ExportGeometryResult>;

/**
 * Wrap-style hook for getParameters.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapGetParametersHook<State extends Record<string, unknown> = {}> = (
  input: GetParametersInput,
  handler: GetParametersHandler,
  runtime: KernelMiddlewareRuntime<State>,
) => Promise<GetParametersResult>;
