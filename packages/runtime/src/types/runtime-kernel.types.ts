/**
 * Runtime Worker Types
 *
 * Core types for the kernel definition API (defineKernel), runtime services,
 * filesystem, logging, and method input/output shapes.
 *
 * For bundler types, see runtime-bundler.types.ts.
 * For dependency types, see runtime-dependency.types.ts.
 * For middleware types, see runtime-middleware.types.ts.
 * For tracer types, see runtime-tracer.types.ts.
 * For shared result/error types used across the codebase, see kernel.types.ts.
 */

import type { z } from 'zod';
import type { FileExtension, LogLevel, GeometryResponse, FileStat, FileStatEntry } from '@taucad/types';
import type { ExportGeometryResult, GetParametersResult, KernelIssue } from '#types/runtime.types.js';
import type { RuntimeSpanTracer } from '#types/runtime-tracer.types.js';
import type { ExecuteResult, KernelBundler } from '#types/runtime-bundler.types.js';

// =============================================================================
// Kernel Logging
// =============================================================================

/**
 * Logger options for kernel and middleware logging methods.
 * @public
 */
export type RuntimeLogOptions = {
  /** Additional data to include in the log */
  data?: unknown;
};

/**
 * Logger interface for kernel methods and middleware.
 * Provides convenience methods that automatically inject the component name.
 * @public
 */
export type RuntimeLogger = {
  /** Log an info-level message */
  log: (message: string, options?: RuntimeLogOptions) => void;
  /** Log a debug-level message */
  debug: (message: string, options?: RuntimeLogOptions) => void;
  /** Log a trace-level message */
  trace: (message: string, options?: RuntimeLogOptions) => void;
  /** Log a warning-level message */
  warn: (message: string, options?: RuntimeLogOptions) => void;
  /** Log an error-level message */
  error: (message: string, options?: RuntimeLogOptions) => void;
  /**
   * Log a message with a dynamic log level.
   * Useful for kernels like OpenSCAD that determine log level at runtime.
   */
  custom: (level: LogLevel, message: string, options?: RuntimeLogOptions) => void;
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
export type RuntimeFileSystemBase = {
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
  watch?(request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void): () => void;
};

/**
 * Watch request for runtime filesystem subscriptions.
 * Mirrors the full WatchRequest contract but is self-contained
 * within the runtime package (no dependency on the UI app types).
 * @public
 */
export type RuntimeWatchRequest = {
  paths: string[];
  recursive?: boolean;
  includes?: string[];
  excludes?: string[];
  filter?: RuntimeWatchEventFilter;
  correlationId?: string;
};

/**
 * Filter for selecting which filesystem event types to receive in a watch subscription.
 * @public
 */
export type RuntimeWatchEventFilter = {
  added?: boolean;
  updated?: boolean;
  deleted?: boolean;
  renamed?: boolean;
};

/**
 * Discriminated union of filesystem watch events emitted by the watch subscription.
 * @public
 */
export type RuntimeWatchEvent =
  | { type: 'change'; path: string; correlationId?: string }
  | { type: 'delete'; path: string; correlationId?: string }
  | { type: 'rename'; oldPath: string; newPath: string; correlationId?: string }
  | { type: 'reset'; correlationId?: string }
  | { type: 'overflow'; correlationId?: string };

/**
 * Enhanced filesystem interface for runtime workers.
 * Extends the 11 base primitives with higher-level helper methods that have
 * default implementations built from the primitives (via `createRuntimeFileSystem`).
 * Backends may supply optimized overrides for any of the enhanced methods.
 * @public
 */
export type RuntimeFileSystem = RuntimeFileSystemBase & {
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
  filesystem: RuntimeFileSystem;
  /** Logger with kernel name pre-configured */
  logger: RuntimeLogger;
  /** Read-only view of cached file contents (absolute paths), populated during dependency computation */
  fileContentCache: ReadonlyMap<string, Uint8Array<ArrayBuffer> | string>;
  /** Esbuild bundler for JS/TS kernels. Lazily initialised on first access. */
  bundler: KernelBundler;
  /** Span tracer for kernel-authored performance instrumentation */
  tracer: RuntimeSpanTracer;
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
 * File path, parameters, and kernel-specific options for geometry evaluation.
 *
 * When `RenderSchema` is a concrete Zod type (inferred from `renderSchema`),
 * `options` is typed via `z.infer<RenderSchema>`. When no schema is declared
 * (default), `options` is `Record<string, unknown>`. Always required — the
 * framework populates defaults via Zod `safeParse({})`.
 *
 * @template RenderSchema - Zod schema type for render options, inferred from KernelDefinition
 * @public
 */
export type CreateGeometryInput<RenderSchema extends z.ZodType = z.ZodType> = {
  /** Absolute path to the active file */
  filePath: string;
  /** Absolute path to the project root directory */
  basePath: string;
  /** User-provided parameters */
  parameters: Record<string, unknown>;
  /** Kernel-specific options (Zod-validated when schema declared, untyped fallback otherwise). */
  options: z.ZodType extends RenderSchema ? Record<string, unknown> : z.infer<RenderSchema>;
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
 * Structured result from dependency resolution, separating successfully
 * resolved files from unresolvable import paths.
 *
 * Unresolved paths are added to the watch set so that creating the missing
 * files later triggers a re-render automatically.
 * @public
 */
export type GetDependenciesResult = {
  /** Absolute paths of files that were successfully resolved and read. */
  resolved: string[];
  /** Absolute paths of imports that could not be resolved — used for watch-set expansion. */
  unresolved: string[];
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
 * Export format, options, and native geometry handle for file export operations.
 *
 * When `ExportSchemas` has entries, the input becomes a discriminated union keyed
 * on `format`. Narrowing `input.format` in a switch/if narrows `input.options`
 * to the corresponding schema's inferred type. When no schemas are declared,
 * falls back to `format: string` with untyped options.
 *
 * Tessellation and coordinate system are carried inside `options` via per-format
 * Zod schema composition (e.g., `tessellationSchema.extend(coordinateSystemSchema.shape)`).
 *
 * @template NativeHandle - Kernel-specific native geometry representation, injected by the framework
 * @template ExportSchemas - Map of format string to Zod schema for per-format option typing
 * @public
 */
export type ExportGeometryInput<
  NativeHandle = unknown,
  // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- empty default signals "no schemas declared"
  ExportSchemas extends Record<string, z.ZodType> = {},
> = ([keyof ExportSchemas] extends [never]
  ? {
      format: FileExtension;
      /** Export options (untyped fallback). */
      options: Record<string, unknown>;
    }
  : {
      [K in Extract<keyof ExportSchemas, string>]: {
        format: K;
        /** Per-format export options (Zod-validated, defaults applied by framework). */
        options: z.infer<ExportSchemas[K]>;
      };
    }[Extract<keyof ExportSchemas, string>]) & {
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
 * All six type parameters are inferred automatically:
 * - Context from the return type of initialize()
 * - NativeHandle from the nativeHandle field of createGeometry()'s return
 * - SerializedHandle from the return type of serializeHandle() (when provided)
 * - Options from optionsSchema (when provided)
 * - ExportSchemas from exportSchemas (when provided)
 * - RenderSchema from renderSchema (when provided)
 *
 * @template Context - Kernel-specific context type, inferred from initialize() return
 * @template NativeHandle - Kernel-specific native geometry representation, inferred from createGeometry() return
 * @template SerializedHandle - Cacheable serialized form of NativeHandle, inferred from serializeHandle() return
 * @template Options - Validated options type, inferred from optionsSchema when provided
 * @template ExportSchemas - Map of format to Zod schema, inferred from exportSchemas when provided
 * @template RenderSchema - Zod schema for render options, inferred from renderSchema when provided
 * @public
 */
export type KernelDefinition<
  Context = unknown,
  NativeHandle = unknown,
  SerializedHandle = unknown,
  Options extends Record<string, unknown> = Record<string, unknown>,
  // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- empty default signals "no schemas declared"
  ExportSchemas extends Record<string, z.ZodType> = {},
  RenderSchema extends z.ZodType = z.ZodType,
> = {
  /** Human-readable kernel name, used in logs and error messages */
  name: string;
  /** Semantic version string for cache-key computation and diagnostics */
  version: string;

  /** Zod schema for validating and typing kernel options. Options type is inferred from this schema. */
  optionsSchema?: z.ZodType<Options>;

  /** Zod schema for kernel-specific render options. Type is inferred and threaded to createGeometry input. */
  renderSchema?: RenderSchema;

  /** Zod schemas for per-format export options. Keys define supported formats; provides type-safe narrowing in exportGeometry. */
  exportSchemas?: ExportSchemas;

  /** Initialize kernel with typed options. Options type is inferred from optionsSchema. */
  initialize(options: Options, runtime: KernelRuntime): Promise<Context>;

  /** Return resolved and unresolved dependency paths for change-detection, cache invalidation, and watch-set expansion. */
  getDependencies(
    input: GetDependenciesInput,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<GetDependenciesResult>;
  /** Extract user-facing parameters (and their JSON Schema) from the active file. */
  getParameters(input: GetParametersInput, runtime: KernelRuntime, context: Context): Promise<GetParametersResult>;
  /** Evaluate the active file and produce tessellated geometry plus a native handle for export. */
  createGeometry(
    input: CreateGeometryInput<RenderSchema>,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<CreateGeometryOutput<NativeHandle>>;
  /** Convert a previously created native geometry handle into one or more export file blobs. */
  exportGeometry(
    input: ExportGeometryInput<NativeHandle, ExportSchemas>,
    runtime: KernelRuntime,
    context: Context,
  ): Promise<ExportGeometryResult>;

  /** Serialize the native geometry handle to a cacheable representation. */
  serializeHandle?(nativeHandle: NativeHandle, context: Context): SerializedHandle;
  /** Restore native geometry handle from cached serialized data. */
  deserializeHandle?(data: SerializedHandle, context: Context): NativeHandle;

  /** Tear down kernel resources (WASM instances, temp files, etc.) when the worker is disposed. */
  cleanup?(context: Context): Promise<void>;
};

/**
 * Define a kernel module with full type inference.
 * All type parameters are inferred automatically -- no explicit type arguments needed:
 * - Context from initialize() return type
 * - NativeHandle from createGeometry() return type (nativeHandle field)
 * - SerializedHandle from serializeHandle() return type (when provided)
 * - Options from optionsSchema (when provided)
 * - ExportSchemas from exportSchemas (when provided)
 * - RenderSchema from renderSchema (when provided)
 *
 * @param definition - The kernel definition object implementing all required lifecycle methods
 * @returns The same definition, typed as {@link KernelDefinition}
 *
 * @public
 *
 * @example <caption>Registering a custom kernel</caption>
 * ```typescript
 * import { defineKernel } from '@taucad/runtime';
 *
 * export default defineKernel({
 *   name: 'MyKernel',
 *   version: '1.0.0',
 *   async initialize(options, runtime) {
 *     return { myContext: true };
 *   },
 *   async getDependencies(input, runtime, context) {
 *     return { resolved: [input.filePath], unresolved: [] };
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
export function defineKernel<
  Context,
  NativeHandle,
  SerializedHandle = unknown,
  Options extends Record<string, unknown> = Record<string, unknown>,
  // oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- empty default signals "no schemas declared"
  ExportSchemas extends Record<string, z.ZodType> = {},
  RenderSchema extends z.ZodType = z.ZodType,
>(
  definition: KernelDefinition<Context, NativeHandle, SerializedHandle, Options, ExportSchemas, RenderSchema>,
): KernelDefinition<Context, NativeHandle, SerializedHandle, Options, ExportSchemas, RenderSchema> {
  return definition;
}

/**
 * Widened KernelDefinition that accepts any concrete kernel regardless of
 * its specific generic type parameters. Use in test utilities, framework
 * internals, and helper functions that operate on kernels generically.
 * @public
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Intentional widening for generic kernel acceptance
export type AnyKernelDefinition = KernelDefinition<any, any, any, any, any, any>;
