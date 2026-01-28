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

// =============================================================================
// Error Types
// =============================================================================

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
