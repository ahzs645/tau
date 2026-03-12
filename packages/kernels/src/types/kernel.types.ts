/**
 * Kernel Types
 *
 * Shared types for kernel operations used across the codebase.
 * Includes error types, result types, and provider types.
 *
 * For worker-specific types (dependencies, runtime, input types, middleware),
 * see kernel-worker.types.ts.
 */

import type { backendProviders, kernelProviders } from '@taucad/types/constants';
import type { ExportFile, Geometry, GeometryResponse } from '@taucad/types';

// =============================================================================
// Error Types
// =============================================================================

/**
 * Classification for stack frame origin.
 * - `user` -- the developer's project code. Visible by default. Used for Monaco error markers.
 * - `library` -- third-party CAD libraries the user imported (replicad, @jscad/modeling). Visible by default.
 * - `framework` -- kernel worker infrastructure (Proxy traps, bundler, esbuild). Hidden by default.
 * - `runtime` -- V8/Emscripten/WASM boundary frames, `node:` internals, native code. Hidden by default.
 * @public
 */
export type FrameContext = 'user' | 'library' | 'framework' | 'runtime';

/**
 * Stack frame captured during a kernel error, enriched with source mapping and visibility context for error reporting UI.
 * @public
 */
export type KernelStackFrame = {
  fileName?: string;
  functionName?: string;
  lineNumber?: number;
  columnNumber?: number;
  source?: string;
  /** Classification of the frame's origin for visibility and error location purposes */
  context?: FrameContext;
};

/**
 * Source location for an error (file, line, column range) used for editor markers and navigation.
 * @public
 */
export type ErrorLocation = {
  fileName: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber?: number;
  endColumn?: number;
};

/**
 * Classification of the origin or cause of a kernel issue for filtering and display.
 * @public
 */
export type KernelIssueType = 'compilation' | 'runtime' | 'kernel' | 'connection' | 'unknown';

/**
 * Severity level for kernel issues, used for prioritization and UI presentation.
 * @public
 */
export type IssueSeverity = 'error' | 'warning' | 'info';

/**
 * Diagnostic produced by a kernel operation — displayed in the editor's problem panel and used for error markers.
 * @public
 */
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

/**
 * Successful kernel operation outcome. Non-fatal warnings are preserved in `issues` alongside the operation data.
 * @public
 */
export type KernelSuccessResult<T> = {
  success: true;
  data: T;
  issues: KernelIssue[];
};

/**
 * Failed kernel operation outcome. Inspect `issues` for error messages, source locations, and stack traces.
 * @public
 */
export type KernelErrorResult = {
  success: false;
  issues: KernelIssue[];
};

/**
 * Discriminated union returned by all kernel operations. Branch on `success` to access data or error diagnostics.
 * @public
 */
export type KernelResult<T> = KernelSuccessResult<T> | KernelErrorResult;

// =============================================================================
// Provider Types
// =============================================================================

/**
 * Identifier for a first-party CAD kernel shipped with `@taucad/kernels` (replicad, jscad, manifold, openscad, zoo).
 * @public
 */
export type KernelProvider = (typeof kernelProviders)[number];
/**
 * Backend provider identifier for geometry export and processing pipelines.
 * @public
 */
export type BackendProvider = (typeof backendProviders)[number];

/**
 * All first-party kernel IDs including internal-only kernels.
 * @public
 */
export type KnownKernelProvider = KernelProvider | 'tau';

/**
 * Kernel provider identifier.
 * Provides intellisense for first-party kernels while accepting arbitrary
 * third-party IDs (e.g. `'manifold'`, `'cadquery'`) without type errors.
 * @public
 */
export type KernelProviderId = KnownKernelProvider | (string & {});

/**
 * A single kernel worker registration.
 * Bundles the kernel module URL and initialization options together.
 * Array position in `KernelModules` determines `canHandle` priority.
 * @public
 */
export type KernelRegistration = {
  id: KernelProviderId;
  options?: Record<string, unknown>;
  /** File extensions this kernel handles (e.g. ['scad'], ['ts', 'js']). '*' is a catch-all. */
  extensions?: string[];
  /** For JS/TS kernels: regex to match against file content to determine if this kernel handles it. */
  detectImport?: RegExp;
  /**
   * Bare-specifier module names this kernel provides (e.g. ['replicad'], ['@jscad/modeling']).
   * Used by the framework for bundle-based transitive detection: the bundler's detectImports()
   * reports which modules are imported, and the framework matches them against these names
   * to select the correct kernel.
   */
  builtinModuleNames?: string[];
  /**
   * URL of the defineKernel module for this kernel (e.g. replicad.kernel.js).
   * The runtime worker dynamically imports this module to load the kernel.
   */
  kernelModuleUrl: string;
};

/**
 * Ordered array of kernel worker registrations.
 * Position determines `canHandle` priority (first match wins).
 * @public
 */
export type KernelModules = KernelRegistration[];

// =============================================================================
// Middleware Options Types
// =============================================================================

/**
 * A single middleware registration.
 * The worker dynamically imports the module at `url` and resolves it
 * as a KernelMiddleware. Options are validated against the middleware's
 * optionsSchema, with the schema providing defaults for missing fields.
 * @public
 */
export type MiddlewareRegistration = {
  /** URL of the middleware module (obtained via `?url` import at build time) */
  url: string;
  /** Whether this middleware is active. Defaults to `true`. */
  enabled?: boolean;
  /** Options validated against the middleware's optionsSchema */
  options?: Record<string, unknown>;
};

/**
 * Ordered array of middleware registrations.
 * Position determines onion-model wrapping order (first = outermost).
 * @public
 */
export type MiddlewareRegistrations = MiddlewareRegistration[];

// =============================================================================
// Bundler Options Types
// =============================================================================

/**
 * A single bundler registration.
 * The worker dynamically imports the module at `bundlerModuleUrl` and resolves it
 * as a BundlerDefinition. The `extensions` field declares which file types this
 * bundler handles; the framework routes detectImports/bundle calls accordingly.
 * @public
 */
export type BundlerRegistration = {
  /** URL of the bundler module (obtained via `?url` import at build time) */
  bundlerModuleUrl: string;
  /** File extensions this bundler handles */
  extensions: string[];
  /** Bundler-specific options passed to initialize() */
  options?: Record<string, unknown>;
};

/**
 * Array of bundler registrations.
 * The framework selects the appropriate bundler by matching file extension.
 * @public
 */
export type BundlerRegistrations = BundlerRegistration[];

// =============================================================================
// Operation Result Types
// =============================================================================

/**
 * Result type for createGeometry.
 * Used by kernel workers and middleware - geometries don't have hash yet.
 * The hash is added by kernel-worker.ts after the middleware chain.
 * @public
 */
export type CreateGeometryResult = KernelResult<GeometryResponse[]>;

/**
 * Completed result type for createGeometry.
 * Returned to consumers - geometries have hash for React keys and caching.
 * @public
 */
export type HashedGeometryResult = KernelResult<Geometry[]>;

/**
 * Outcome of extracting customizer parameters from a CAD script, used to render the parameter editor UI.
 * @public
 */
export type GetParametersResult = KernelResult<{
  defaultParameters: Record<string, unknown>;
  jsonSchema: unknown;
}>;

/**
 * Outcome of inferring a human-readable name from a CAD script, used as the default project title.
 * @public
 */
export type ExtractNameResult = KernelResult<string | undefined>;

/**
 * Outcome of exporting CAD geometry to a downloadable file format (STL, STEP, glTF, etc.).
 * @public
 */
export type ExportGeometryResult = KernelResult<ExportFile[]>;
