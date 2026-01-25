import type { PartialDeep } from 'type-fest';
import type { backendProviders, kernelProviders } from '#constants/kernel.constants.js';
import type { Geometry, GeometryBase } from '#types/cad.types.js';
import type { ExportFormat } from '#types/file.types.js';

export type KernelStackFrame = {
  fileName?: string;
  functionName?: string;
  lineNumber?: number;
  columnNumber?: number;
  source?: string;
};

// Location information for errors that can point to a specific code location
export type ErrorLocation = {
  fileName: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber?: number;
  endColumn?: number;
};

export type KernelIssueType = 'compilation' | 'runtime' | 'kernel' | 'connection' | 'unknown';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type KernelIssue = {
  message: string;
  location?: ErrorLocation;
  stack?: string;
  stackFrames?: KernelStackFrame[];
  type?: KernelIssueType;
  severity: IssueSeverity;
};

// Result pattern types for kernel operations
export type KernelSuccessResult<T> = {
  success: true;
  data: T;
  issues: KernelIssue[];
};

export type KernelErrorResult = {
  success: false;
  issues: KernelIssue[];
};

export type KernelProvider = (typeof kernelProviders)[number];
export type BackendProvider = (typeof backendProviders)[number];

export type KernelResult<T> = KernelSuccessResult<T> | KernelErrorResult;

// Specific result types for different kernel operations

/**
 * Result type for computeGeometry.
 * Used by kernel workers and middleware - geometries don't have hash yet.
 * The hash is added by kernel-worker.ts after the middleware chain.
 */
export type ComputeGeometryResult = KernelResult<GeometryBase[]>;

/**
 * Completed result type for computeGeometry.
 * Returned to consumers - geometries have hash for React keys and caching.
 */
export type ComputeGeometryResultCompleted = KernelResult<Geometry[]>;

export type ExtractParametersResult = KernelResult<{
  defaultParameters: Record<string, unknown>;
  jsonSchema: unknown;
}>;

export type ExtractNameResult = KernelResult<string | undefined>;

export type ExtractSchemaResult = KernelResult<unknown>;

export type ExportGeometryResult = KernelResult<Array<{ blob: Blob; name: string }>>;

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
// Middleware Types
// =============================================================================

/**
 * Input passed to beforeComputeGeometry middleware hooks.
 */
export type ComputeGeometryInput = {
  /** The filename being processed */
  filename: string;
  /** Parameters passed to computeGeometry */
  parameters: Record<string, unknown>;
  /** Optional geometry ID */
  geometryId?: string;
  /** Base path for the build (e.g., "builds/abc123") */
  basePath: string;
};

/**
 * Input passed to beforeExportGeometry middleware hooks.
 */
export type ExportGeometryInput = {
  /** The export format requested */
  fileType: ExportFormat;
  /** Optional geometry ID being exported */
  geometryId?: string;
};

/**
 * Context passed to exportGeometry middleware hooks.
 */
export type ExportGeometryContext = ExportGeometryInput;

/**
 * Input passed to beforeExtractParameters middleware hooks.
 */
export type ExtractParametersInput = {
  /** The filename being processed */
  filename: string;
  /** Base path for the build (e.g., "builds/abc123") */
  basePath: string;
};

/**
 * Context passed to extractParameters middleware hooks.
 */
export type ExtractParametersContext = ExtractParametersInput;

/**
 * Logger options for middleware logging methods.
 */
export type MiddlewareLogOptions = {
  /** Additional data to include in the log */
  data?: unknown;
};

/**
 * Logger interface provided to middleware hooks.
 * Provides convenience methods that automatically inject the middleware name as the component.
 */
export type KernelMiddlewareLogger = {
  /** Log an info-level message */
  log: (message: string, options?: MiddlewareLogOptions) => void;
  /** Log a debug-level message */
  debug: (message: string, options?: MiddlewareLogOptions) => void;
  /** Log a trace-level message */
  trace: (message: string, options?: MiddlewareLogOptions) => void;
  /** Log a warning-level message */
  warn: (message: string, options?: MiddlewareLogOptions) => void;
  /** Log an error-level message */
  error: (message: string, options?: MiddlewareLogOptions) => void;
};

/**
 * Type-safe state for middleware to persist data during an operation.
 *
 * The state is scoped to a single middleware and persists for the duration of
 * one operation (e.g., one computeGeometry call). In wrap-style hooks, state
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
 * File stat information returned by getDirectoryStat.
 */
export type MiddlewareFileStat = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
};

/**
 * File manager interface for middleware filesystem operations.
 * This is a subset of the full FileManager interface available to middleware.
 */
export type MiddlewareFileManager = {
  /** Read a file as string (utf8) or binary */
  readFile(filepath: string, options: 'utf8' | { encoding: 'utf8' }): Promise<string>;
  readFile(filepath: string): Promise<Uint8Array>;
  /** Write content to a file */
  writeFile(filepath: string, data: Uint8Array | string): Promise<void>;
  /** Create a directory */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Check if a path exists */
  exists(path: string): Promise<boolean>;
  /** Ensure a directory exists, creating parent directories as needed */
  ensureDirectoryExists(path: string): Promise<void>;
  /** Get file stats for all files in a directory recursively */
  getDirectoryStat(path: string): Promise<MiddlewareFileStat[]>;
  /** Delete a file */
  unlink(path: string): Promise<void>;
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
  logger: KernelMiddlewareLogger;
  /** File manager for filesystem operations */
  fileManager: MiddlewareFileManager;
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
// Middleware Request Types (Wrap-Style Hooks)
// =============================================================================

/**
 * Request object passed to computeGeometry wrap hooks.
 * Bundles input and runtime together for easy handling and modification.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ComputeGeometryRequest<State extends Record<string, unknown> = {}> = {
  /** The input to computeGeometry */
  input: ComputeGeometryInput;
  /** Runtime services (logger, fileManager, state) */
  runtime: KernelMiddlewareRuntime<State>;
};

/**
 * Request object passed to exportGeometry wrap hooks.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ExportGeometryRequest<State extends Record<string, unknown> = {}> = {
  /** The input to exportGeometry */
  input: ExportGeometryInput;
  /** Runtime services (logger, fileManager, state) */
  runtime: KernelMiddlewareRuntime<State>;
};

/**
 * Request object passed to extractParameters wrap hooks.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ExtractParametersRequest<State extends Record<string, unknown> = {}> = {
  /** The input to extractParameters */
  input: ExtractParametersInput;
  /** Runtime services (logger, fileManager, state) */
  runtime: KernelMiddlewareRuntime<State>;
};

// =============================================================================
// Middleware Handler Types (Wrap-Style Hooks)
// =============================================================================

/**
 * Handler function for computeGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 * Uses internal geometry types (without hash) - hash is added by kernel-worker.ts.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ComputeGeometryHandler<State extends Record<string, unknown> = {}> = (
  request: ComputeGeometryRequest<State>,
) => Promise<ComputeGeometryResult>;

/**
 * Handler function for exportGeometry.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ExportGeometryHandler<State extends Record<string, unknown> = {}> = (
  request: ExportGeometryRequest<State>,
) => Promise<ExportGeometryResult>;

/**
 * Handler function for extractParameters.
 * Called by wrap hooks to continue the middleware chain or execute the main operation.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type ExtractParametersHandler<State extends Record<string, unknown> = {}> = (
  request: ExtractParametersRequest<State>,
) => Promise<ExtractParametersResult>;

// =============================================================================
// Middleware Wrap Hook Types
// =============================================================================

/**
 * Wrap-style hook for computeGeometry.
 * Provides full control over execution: can short-circuit, transform input/output,
 * or add pre/post processing. Code after handler() runs on the "return journey"
 * (onion model), so short-circuited results still flow through upstream middleware.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 *
 * @example
 * ```typescript
 * async wrapComputeGeometry(request, handler) {
 *   // PRE: Check cache
 *   const cached = await checkCache(request.input);
 *   if (cached) return cached;  // Short-circuit
 *
 *   // EXECUTE: Call downstream
 *   const result = await handler(request);
 *
 *   // POST: Transform result (runs even if upstream short-circuited)
 *   return transform(result);
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapComputeGeometryHook<State extends Record<string, unknown> = {}> = (
  request: ComputeGeometryRequest<State>,
  handler: ComputeGeometryHandler<State>,
) => Promise<ComputeGeometryResult>;

/**
 * Wrap-style hook for exportGeometry.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapExportGeometryHook<State extends Record<string, unknown> = {}> = (
  request: ExportGeometryRequest<State>,
  handler: ExportGeometryHandler<State>,
) => Promise<ExportGeometryResult>;

/**
 * Wrap-style hook for extractParameters.
 * Provides full control over execution with onion model semantics.
 *
 * @template State - The state type from the middleware's stateSchema. Must be an object type.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Default represents z.infer<z.object({})>
export type WrapExtractParametersHook<State extends Record<string, unknown> = {}> = (
  request: ExtractParametersRequest<State>,
  handler: ExtractParametersHandler<State>,
) => Promise<ExtractParametersResult>;
