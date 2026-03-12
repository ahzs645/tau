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
import type { ExportFormat, LogLevel, GeometryResponse, FileStat, FileStatEntry } from '@taucad/types';
import type { ExportGeometryResult, GetParametersResult, KernelIssue } from '#types/kernel.types.js';
import type { KernelSpanTracer } from '#types/kernel-tracer.types.js';
import type { ExecuteResult, KernelBundler } from '#types/kernel-bundler.types.js';

// =============================================================================
// Kernel Logging
// =============================================================================

/**
 * Logger options for kernel and middleware logging methods.
 * @public
 */
export type KernelLogOptions = {
  /** Additional data to include in the log */
  data?: unknown;
};

/**
 * Logger interface for kernel methods and middleware.
 * Provides convenience methods that automatically inject the component name.
 * @public
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
 * Base filesystem interface -- 11 Node.js `fs.promises`-compatible primitives.
 * All paths are absolute. This is the minimal surface that filesystem backends
 * must implement (e.g. fromFsLike, fromMemoryFS, fromNodeFS).
 * @public
 */
export type KernelFileSystemBase = {
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
  /** Remove an empty directory. */
  rmdir(path: string): Promise<void>;
  /** Rename / move a file or directory. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Get file or directory metadata. */
  stat(path: string): Promise<FileStat>;
  /** Get file or directory metadata without following symlinks. */
  lstat(path: string): Promise<FileStat>;
  /** Check if path exists. */
  exists(path: string): Promise<boolean>;

  /**
   * Subscribe to filesystem change events for the given paths.
   * Returns an unsubscribe function. Events are filtered server-side.
   */
  watch?(request: KernelWatchRequest, handler: (event: KernelWatchEvent) => void): () => void;
};

/**
 * Watch request for kernel filesystem subscriptions.
 * Mirrors the full WatchRequest contract but is self-contained
 * within the kernels package (no dependency on the UI app types).
 * @public
 */
export type KernelWatchRequest = {
  paths: string[];
  recursive?: boolean;
  includes?: string[];
  excludes?: string[];
  filter?: KernelWatchEventFilter;
  correlationId?: string;
};

/**
 * Filter for selecting which filesystem event types to receive in a watch subscription.
 * @public
 */
export type KernelWatchEventFilter = {
  added?: boolean;
  updated?: boolean;
  deleted?: boolean;
  renamed?: boolean;
};

/**
 * Discriminated union of filesystem watch events emitted by the watch subscription.
 * @public
 */
export type KernelWatchEvent =
  | { type: 'change'; path: string; correlationId?: string }
  | { type: 'delete'; path: string; correlationId?: string }
  | { type: 'rename'; oldPath: string; newPath: string; correlationId?: string }
  | { type: 'reset'; correlationId?: string }
  | { type: 'overflow'; correlationId?: string };

/**
 * Enhanced filesystem interface for kernel workers.
 * Extends the 11 base primitives with higher-level helper methods that have
 * default implementations built from the primitives (via `createKernelFileSystem`).
 * Backends may supply optimized overrides for any of the enhanced methods.
 * @public
 */
export type KernelFileSystem = KernelFileSystemBase & {
  /** Batch-read multiple files as binary. Default: `Promise.all(paths.map(readFile))`. */
  readFiles(paths: string[]): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  /** Read all file contents in a directory (skips subdirectories). */
  readdirContents(directoryPath: string): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
  /** Get stat information for all entries in a directory. */
  readdirStat(directoryPath: string): Promise<FileStatEntry[]>;
  /** Ensure a directory exists, creating parents as needed. Default: `mkdir(path, { recursive: true })`. */
  ensureDir(path: string): Promise<void>;
};

// =============================================================================
// Kernel Runtime
// =============================================================================

/**
 * Runtime services provided to kernel methods.
 * The bundler and execute services are lazily initialised -- kernels that
 * never call them (OpenSCAD, Tau) pay zero cost.
 * @public
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
 * @public
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
 * File and project path identifying the active document for parameter extraction.
 * @public
 */
export type GetParametersInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
};

/**
 * File path, parameters, and tessellation settings for geometry evaluation.
 * @public
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
 * File and project path identifying the active document for dependency resolution.
 * @public
 */
export type GetDependenciesInput = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
};

/**
 * File path and extension used to determine whether a kernel supports a given file.
 * @public
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
 * Validated options passed to a kernel during worker initialization.
 * @public
 */
export type InitializeInput<Options = Record<string, unknown>> = {
  /** Worker options */
  options: Options;
};

/**
 * Export format, tessellation, and native geometry handle for file export operations.
 *
 * @template NativeHandle - Kernel-specific native geometry representation, injected by the framework
 * @public
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
 * Tessellated geometry and opaque native handle produced by a kernel evaluation.
 * The geometry array is transferred to the main thread for rendering, while the
 * native handle is retained in the worker for subsequent export operations.
 *
 * @template NativeHandle - Kernel-specific type for the native geometry representation
 * @public
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
 * All three type parameters are inferred automatically:
 * - Context from the return type of initialize()
 * - NativeHandle from the nativeHandle field of createGeometry()'s return
 * - Options from optionsSchema (when provided)
 *
 * @template Context - Kernel-specific context type, inferred from initialize() return
 * @template NativeHandle - Kernel-specific native geometry representation, inferred from createGeometry() return
 * @template Options - Validated options type, inferred from optionsSchema when provided
 * @public
 */
export type KernelDefinition<
  Context = unknown,
  NativeHandle = unknown,
  Options extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Human-readable kernel name, used in logs and error messages */
  name: string;
  /** Semantic version string for cache-key computation and diagnostics */
  version: string;

  /** Zod schema for validating and typing kernel options. Options type is inferred from this schema. */
  optionsSchema?: z.ZodType<Options>;

  /** Initialize kernel with typed options. Options type is inferred from optionsSchema. */
  initialize(options: Options, runtime: KernelRuntime): Promise<Context>;

  /** Optional guard that determines whether this kernel can process a given file. Called during kernel selection. */
  canHandle?(input: CanHandleInput, runtime: KernelRuntime, context: Context): Promise<boolean>;

  /** Return absolute paths of all files the active file depends on, used for change-detection and cache invalidation. */
  getDependencies(input: GetDependenciesInput, runtime: KernelRuntime, context: Context): Promise<string[]>;
  /** Extract user-facing parameters (and their JSON Schema) from the active file. */
  getParameters(input: GetParametersInput, runtime: KernelRuntime, context: Context): Promise<GetParametersResult>;
  /** Evaluate the active file and produce tessellated geometry plus a native handle for export. */
  createGeometry(
    input: CreateGeometryInput,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<CreateGeometryOutput<NativeHandle>>;
  /** Convert a previously created native geometry handle into one or more export file blobs. */
  exportGeometry(
    input: ExportGeometryInput<NativeHandle>,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<ExportGeometryResult>;

  /** Tear down kernel resources (WASM instances, temp files, etc.) when the worker is disposed. */
  cleanup?(context: Context): Promise<void>;
};

/**
 * Define a kernel module with full type inference.
 * All type parameters are inferred automatically -- no explicit type arguments needed:
 * - Context from initialize() return type
 * - NativeHandle from createGeometry() return type (nativeHandle field)
 * - Options from optionsSchema (when provided)
 *
 * @param definition - The kernel definition object implementing all required lifecycle methods
 * @returns The same definition, typed as {@link KernelDefinition}
 *
 * @public
 *
 * @example <caption>Registering a custom kernel</caption>
 * ```typescript
 * import { defineKernel } from '@taucad/kernels';
 *
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
 *     return { success: true, data: { defaultParameters: {}, jsonSchema: {} }, issues: [] };
 *   },
 *   async createGeometry(input, runtime, context) {
 *     return { geometry: [], nativeHandle: {} };
 *   },
 *   async exportGeometry(input, runtime, context) {
 *     return { success: true, data: [], issues: [] };
 *   },
 * });
 * ```
 */
export function defineKernel<Context, NativeHandle, Options extends Record<string, unknown> = Record<string, unknown>>(
  definition: KernelDefinition<Context, NativeHandle, Options>,
): KernelDefinition<Context, NativeHandle, Options> {
  return definition;
}
