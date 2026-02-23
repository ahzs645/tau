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

import type { z } from 'zod';
import type { ExportFormat, LogLevel, GeometryResponse } from '@taucad/types';
import type { ExportGeometryResult, GetParametersResult, KernelIssue } from '#types/kernel.types.js';
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
 * Node.js-compatible filesystem interface for kernel workers.
 * 8 required methods matching `fs.promises.*`. All paths are absolute.
 *
 * The framework builds higher-level operations from these primitives:
 * - `ensureDirectoryExists(path)` via `mkdir(path, { recursive: true })`
 * - `readFiles(paths)` via `Promise.all(paths.map(readFile))`
 * - `getDirectoryContents(dir)` via `readdir(dir)` + `Promise.all(names.map(readFile))`
 * - `getDirectoryStat(dir)` via `readdir(dir)` + `Promise.all(names.map(stat))`
 */
export type KernelFileSystem = {
  /** Read file as text. */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** Read file as binary. */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Write file (text or binary). */
  writeFile(path: string, data: Uint8Array<ArrayBuffer> | string): Promise<void>;
  /** Create directory, optionally recursive. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** List directory entries (file/dir names). */
  readdir(path: string): Promise<string[]>;
  /** Delete file. */
  unlink(path: string): Promise<void>;
  /** Get file or directory metadata. */
  stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>;
  /** Check if path exists. */
  exists(path: string): Promise<boolean>;
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
  filesystem: KernelFileSystem;
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
// Tessellation
// =============================================================================

/**
 * Universal tessellation quality descriptor for geometry meshing.
 * Controls the fidelity of triangulated mesh output from CAD kernels.
 *
 * Each kernel interprets these values according to its meshing algorithm:
 * - Replicad: post-computation mesh tolerance (shape.mesh / shape.meshEdges)
 * - OpenSCAD: mapped to $fs (linearTolerance) and $fa (angularTolerance)
 * - Zoo/JSCAD/Tau: ignored (tessellation controlled externally)
 */
export type Tessellation = {
  /** Maximum deviation between the mesh and the true geometry surface, in model units. */
  linearTolerance: number;
  /** Maximum angular deviation between adjacent mesh facets, in degrees. */
  angularTolerance: number;
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
  /** Optional tessellation quality for preview rendering. Kernel applies its own default when undefined. */
  tessellation?: Tessellation;
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
 *
 * @template NativeHandle - Kernel-specific native geometry representation, injected by the framework
 */
export type ExportGeometryInput<NativeHandle = unknown> = {
  /** Export file format */
  fileType: ExportFormat;
  /** Optional tessellation quality for export. Kernel applies its own default when undefined. */
  tessellation?: Tessellation;
  /** Native geometry handle from the most recent createGeometry call, injected by the framework */
  nativeHandle: NativeHandle;
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
 * When `optionsSchema` is provided, TypeScript infers `Options` from the schema,
 * giving the `initialize` callback type-safe access to validated options.
 *
 * @template Context - Kernel-specific context type returned by initialize()
 * @template NativeHandle - Kernel-specific type for native geometry representation
 * @template Options - Type of validated options, inferred from optionsSchema when provided
 */
export type KernelDefinition<
  Context = unknown,
  NativeHandle = unknown,
  Options extends Record<string, unknown> = Record<string, unknown>,
> = {
  name: string;
  version: string;

  /** Zod schema for validating and typing kernel options. Options type is inferred from this schema. */
  optionsSchema?: z.ZodType<Options>;

  /** Initialize kernel with typed options. Options type is inferred from optionsSchema. */
  initialize(options: Options, runtime: KernelRuntime): Promise<Context>;

  canHandle?(input: CanHandleInput, runtime: KernelRuntime, context: Context): Promise<boolean>;

  getDependencies(input: GetDependenciesInput, runtime: KernelRuntime, context: Context): Promise<string[]>;
  getParameters(input: GetParametersInput, runtime: KernelRuntime, context: Context): Promise<GetParametersResult>;
  createGeometry(
    input: CreateGeometryInput,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<CreateGeometryOutput<NativeHandle>>;
  exportGeometry(
    input: ExportGeometryInput<NativeHandle>,
    runtime: KernelRuntime,
    context: Context,
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
 *   async exportGeometry({ nativeHandle, ...input }, runtime, context) {
 *     return { success: true, data: [{ blob: ... }] };
 *   },
 * });
 * ```
 */
export function defineKernel<Ctx, NativeHandle, Options extends Record<string, unknown> = Record<string, unknown>>(
  definition: KernelDefinition<Ctx, NativeHandle, Options>,
): KernelDefinition<Ctx, NativeHandle, Options> {
  return definition;
}
