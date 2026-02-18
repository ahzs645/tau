/**
 * Kernel Types
 *
 * Shared types for kernel operations used across the codebase.
 * Includes error types, result types, and provider types.
 *
 * For worker-specific types (dependencies, runtime, input types, middleware),
 * see kernel-worker.types.ts.
 */

import type { backendProviders, kernelProviders } from '#constants/kernel.constants.js';
import type { Geometry, GeometryResponse } from '#types/cad.types.js';
import type { ExportFormat, GeometryFile } from '#types/file.types.js';
import type { OnWorkerLog } from '#types/logger.types.js';

// =============================================================================
// Error Types
// =============================================================================

/**
 * Classification for stack frame origin.
 * - `user` -- the developer's project code. Visible by default. Used for Monaco error markers.
 * - `library` -- third-party CAD libraries the user imported (replicad, @jscad/modeling). Visible by default.
 * - `framework` -- kernel worker infrastructure (Proxy traps, bundler, esbuild). Hidden by default.
 * - `runtime` -- V8/Emscripten/WASM boundary frames, `node:` internals, native code. Hidden by default.
 */
export type FrameContext = 'user' | 'library' | 'framework' | 'runtime';

export type KernelStackFrame = {
  fileName?: string;
  functionName?: string;
  lineNumber?: number;
  columnNumber?: number;
  source?: string;
  /** Classification of the frame's origin for visibility and error location purposes */
  context?: FrameContext;
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

// =============================================================================
// Result Types
// =============================================================================

export type KernelSuccessResult<T> = {
  success: true;
  data: T;
  issues: KernelIssue[];
};

export type KernelErrorResult = {
  success: false;
  issues: KernelIssue[];
};

export type KernelResult<T> = KernelSuccessResult<T> | KernelErrorResult;

// =============================================================================
// Provider Types
// =============================================================================

export type KernelProvider = (typeof kernelProviders)[number];
export type BackendProvider = (typeof backendProviders)[number];

/** All first-party kernel IDs including internal-only kernels. */
export type KnownKernelProvider = KernelProvider | 'tau';

/**
 * Kernel provider identifier.
 * Provides intellisense for first-party kernels while accepting arbitrary
 * third-party IDs (e.g. `'manifold'`, `'cadquery'`) without type errors.
 */
// eslint-disable-next-line @typescript-eslint/ban-types -- `string & {}` preserves autocomplete for known literals
export type KernelProviderId = KnownKernelProvider | (string & {});

/**
 * A single kernel worker registration.
 * Bundles the worker URL and initialization options together.
 * Array position in `KernelConfig` determines `canHandle` priority.
 */
export type KernelWorkerEntry = {
  id: KernelProviderId;
  url: string;
  options?: Record<string, unknown>;
};

/**
 * Ordered array of kernel worker registrations.
 * Position determines `canHandle` priority (first match wins).
 *
 * @example First-party defaults
 * ```ts
 * const config: KernelConfig = [
 *   { id: 'openscad', url: openscadUrl },
 *   { id: 'replicad', url: replicadUrl, options: { withExceptions: true } },
 * ];
 * ```
 *
 * @example Adding a third-party kernel
 * ```ts
 * const config: KernelConfig = [
 *   ...defaultKernelConfig,
 *   { id: 'manifold', url: manifoldWorkerUrl },
 * ];
 * ```
 */
export type KernelConfig = KernelWorkerEntry[];

/**
 * Public interface for kernel workers as exposed via Comlink.
 *
 * The kernel-comlink-adapter maps symbol-keyed methods on KernelWorker
 * to string-named equivalents. This type represents that string-named surface,
 * allowing the kernel machine to interact with workers generically without
 * importing concrete worker types.
 */
export type KernelWorkerInterface = {
  initializeEntry(
    callbacks: { onLog: OnWorkerLog },
    transferables: { fileManagerPort?: MessagePort },
    options: Record<string, unknown>,
  ): Promise<void>;
  cleanupEntry(): Promise<void>;
  canHandleEntry(file: GeometryFile): Promise<boolean>;
  getParametersEntry(file: GeometryFile): Promise<GetParametersResult>;
  createGeometryEntry(file: GeometryFile, parameters: Record<string, unknown>): Promise<CreateGeometryResultCompleted>;
  exportGeometryEntry(
    fileType: ExportFormat,
    meshConfig?: { linearTolerance: number; angularTolerance: number },
  ): Promise<ExportGeometryResult>;
  getExportFormats(): ExportFormat[];
};

// =============================================================================
// Operation Result Types
// =============================================================================

/**
 * Result type for createGeometry.
 * Used by kernel workers and middleware - geometries don't have hash yet.
 * The hash is added by kernel-worker.ts after the middleware chain.
 */
export type CreateGeometryResult = KernelResult<GeometryResponse[]>;

/**
 * Completed result type for createGeometry.
 * Returned to consumers - geometries have hash for React keys and caching.
 */
export type CreateGeometryResultCompleted = KernelResult<Geometry[]>;

export type GetParametersResult = KernelResult<{
  defaultParameters: Record<string, unknown>;
  jsonSchema: unknown;
}>;

export type ExtractNameResult = KernelResult<string | undefined>;

export type ExportGeometryResult = KernelResult<Array<{ blob: Blob; name: string }>>;
