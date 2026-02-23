/**
 * Kernel Worker Protocol Types
 *
 * Defines the typed MessagePort event protocol between the kernel machine (main thread)
 * and kernel workers.
 *
 * All request/response commands carry a `requestId` for correlation. Fire-and-forget
 * commands (fileChanged, configureMiddleware, cleanup) do not require a requestId.
 */

import type { GeometryFile, ExportFormat, LogLevel, LogOrigin } from '@taucad/types';
import type {
  HashedGeometryResult,
  GetParametersResult,
  ExportGeometryResult,
  KernelIssue,
  MiddlewareRegistrations,
  BundlerRegistrations,
} from '#types/kernel.types.js';
import type { Tessellation } from '#types/kernel-worker.types.js';

/**
 * Commands sent from the kernel machine (main thread) to the kernel worker.
 * Request/response commands include a `requestId` for correlation.
 */
export type KernelCommand =
  | {
      type: 'initialize';
      requestId: string;
      options: Record<string, unknown>;
      middlewareEntries: MiddlewareRegistrations;
      bundlerEntries?: BundlerRegistrations;
      fileSystemPort?: MessagePort;
    }
  | {
      type: 'render';
      requestId: string;
      file: GeometryFile;
      params: Record<string, unknown>;
      tessellation?: Tessellation;
    }
  | {
      type: 'export';
      requestId: string;
      format: ExportFormat;
      tessellation?: Tessellation;
    }
  | { type: 'cancel'; requestId: string }
  | { type: 'fileChanged'; paths: string[] }
  | { type: 'configureMiddleware'; entries: MiddlewareRegistrations }
  | { type: 'cleanup' };

/**
 * Telemetry entry data collected via PerformanceObserver in the worker.
 */
export type PerformanceEntryData = {
  name: string;
  startTime: number;
  duration: number;
  detail?: Record<string, unknown>;
  workerTimeOrigin: number;
};

/**
 * Rendering phase identifier for progress tracking.
 * Framework-defined conventions: 'resolvingDeps', 'bundling', 'extractingParams',
 * 'computingGeometry', 'postProcessing'. Bundler and kernel modules may emit
 * custom phase strings for domain-specific progress tracking.
 */
export type RenderPhase = string;

/**
 * Responses sent from the kernel worker back to the kernel machine (main thread).
 * Request-scoped responses include the `requestId` from the originating command.
 */
export type KernelResponse =
  | { type: 'initialized'; requestId: string }
  | { type: 'parametersResolved'; requestId: string; result: GetParametersResult }
  | { type: 'geometryComputed'; requestId: string; result: HashedGeometryResult }
  | { type: 'exported'; requestId: string; result: ExportGeometryResult }
  | { type: 'error'; requestId: string; issues: KernelIssue[] }
  | { type: 'progress'; requestId: string; phase: RenderPhase; detail?: Record<string, unknown> }
  | { type: 'log'; level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }
  | { type: 'logBatch'; entries: Array<{ level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }> }
  | { type: 'telemetry'; entries: PerformanceEntryData[] };
