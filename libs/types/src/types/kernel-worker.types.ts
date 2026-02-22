/**
 * Kernel Worker Types
 *
 * Core types for the kernel definition API (defineKernel), runtime services,
 * filesystem, logging, and method input/output shapes.
 *
 * For bundler types, see kernel-bundler.types.ts.
 * For dependency types, see kernel-dependency.types.ts.
 * For middleware types, see kernel-middleware.types.ts.
 * For tracer types, see kernel-tracer.types.ts.
 * For shared result/error types used across the codebase, see kernel.types.ts.
 */

import type { ExportFormat, FileStat } from '#types/file.types.js';
import type { LogLevel } from '#types/logger.types.js';
import type { ExportGeometryResult, GetParametersResult, KernelIssue } from '#types/kernel.types.js';
import type { GeometryResponse } from '#types/cad.types.js';
import type { KernelSpanTracer } from '#types/kernel-tracer.types.js';
import type { ExecuteResult, KernelBundler } from '#types/kernel-bundler.types.js';

// =============================================================================
// Kernel Logging
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

// =============================================================================
// Kernel Filesystem
// =============================================================================

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
  /** Batch read multiple files as binary (single RPC round-trip) */
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
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

// =============================================================================
// Kernel Runtime
// =============================================================================

/**
 * Runtime services provided to kernel methods.
 * The bundler and execute services are lazily initialised -- kernels that
 * never call them (OpenSCAD, Tau) pay zero cost.
 */
export type KernelRuntime = {
  /** Filesystem interface (all paths are absolute) */
  filesystem: KernelFilesystem;
  /** Logger with kernel name pre-configured */
  logger: KernelLogger;
  /** Read-only view of cached file contents (absolute paths), populated during dependency computation */
  fileContentCache: ReadonlyMap<string, Uint8Array<ArrayBuffer> | string>;
  /** Esbuild bundler for JS/TS kernels. Lazily initialised on first access. */
  bundler: KernelBundler;
  /** Span tracer for kernel-authored performance instrumentation */
  tracer: KernelSpanTracer;
  /**
   * Execute bundled JS/TS code via dynamic import and return the module exports.
   * Browser uses Blob URL, Node.js uses data URL.
   */
  execute(code: string): Promise<ExecuteResult>;
};

// =============================================================================
// Kernel Method Input Types
// =============================================================================

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

// =============================================================================
// defineKernel API Types
// =============================================================================

/**
 * Output from a kernel's createGeometry method.
 * Includes both the display geometry (transferred to main thread) and an opaque
 * native handle that the framework stores for export operations.
 *
 * @template NativeHandle - Kernel-specific type for the native geometry representation
 */
export type CreateGeometryOutput<NativeHandle = unknown> = {
  geometry: GeometryResponse[];
  nativeHandle: NativeHandle;
  issues?: KernelIssue[];
};

/**
 * Definition for a kernel module loaded via defineKernel().
 * Kernel modules are ES modules dynamically imported by the worker runtime.
 * The API is designed to be simple (no class inheritance, no `this` binding)
 * with all state managed through the typed context returned by initialize().
 *
 * @template Context - Kernel-specific context type returned by initialize()
 * @template NativeHandle - Kernel-specific type for native geometry representation
 */
export type KernelDefinition<Context = unknown, NativeHandle = unknown> = {
  name: string;
  version: string;

  initialize(options: Record<string, unknown>, runtime: KernelRuntime): Promise<Context>;

  canHandle?(input: CanHandleInput, runtime: KernelRuntime, context: Context): Promise<boolean>;

  getDependencies(input: GetDependenciesInput, runtime: KernelRuntime, context: Context): Promise<string[]>;
  getParameters(input: GetParametersInput, runtime: KernelRuntime, context: Context): Promise<GetParametersResult>;
  createGeometry(
    input: CreateGeometryInput,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<CreateGeometryOutput<NativeHandle>>;
  exportGeometry(
    input: ExportGeometryInput,
    runtime: KernelRuntime,
    context: Context,
    nativeHandle: NativeHandle,
  ): Promise<ExportGeometryResult>;

  cleanup?(context: Context): Promise<void>;
};

/**
 * Helper function to define a kernel module with proper type inference.
 * This is the primary API for kernel authors.
 *
 * @example
 * ```typescript
 * export default defineKernel({
 *   name: 'MyKernel',
 *   version: '1.0.0',
 *   async initialize(options, runtime) {
 *     return { myContext: true };
 *   },
 *   async getDependencies(input, runtime, context) {
 *     return [input.filePath];
 *   },
 *   async getParameters(input, runtime, context) {
 *     return { success: true, data: { defaultParameters: {}, jsonSchema: {} } };
 *   },
 *   async createGeometry(input, runtime, context) {
 *     return { geometry: [...], nativeHandle: myShapes };
 *   },
 *   async exportGeometry(input, runtime, context, nativeHandle) {
 *     return { success: true, data: [{ blob: ... }] };
 *   },
 * });
 * ```
 */
export function defineKernel<Ctx, NativeHandle>(
  definition: KernelDefinition<Ctx, NativeHandle>,
): KernelDefinition<Ctx, NativeHandle> {
  return definition;
}
