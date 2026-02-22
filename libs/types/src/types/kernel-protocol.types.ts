/**
 * Kernel Worker Protocol Types
 *
 * Defines the typed MessagePort event protocol between the kernel machine (main thread)
 * and kernel workers. Replaces Comlink for the kernel hot path (render, fileChanged,
 * configureMiddleware) while keeping Comlink for the file manager.
 *
 * All request/response commands carry a `requestId` for correlation. Fire-and-forget
 * commands (fileChanged, configureMiddleware, cleanup) do not require a requestId.
 */

import type {
  GeometryFile,
  ExportFormat,
  CreateGeometryResultCompleted,
  GetParametersResult,
  ExportGeometryResult,
  KernelIssue,
  MiddlewareConfig,
  BundlerConfig,
} from '#types/index.js';
import type { LogLevel, LogOrigin } from '#types/logger.types.js';

/**
 * Commands sent from the kernel machine (main thread) to the kernel worker.
 * Request/response commands include a `requestId` for correlation.
 */
export type KernelCommand =
  | {
      type: 'initialize';
      requestId: string;
      options: Record<string, unknown>;
      middlewareConfig: MiddlewareConfig;
      bundlerConfig?: BundlerConfig;
      fileManagerPort?: MessagePort;
    }
  | { type: 'render'; requestId: string; file: GeometryFile; params: Record<string, unknown> }
  | { type: 'canHandle'; requestId: string; file: GeometryFile }
  | {
      type: 'export';
      requestId: string;
      format: ExportFormat;
      meshConfig?: { linearTolerance: number; angularTolerance: number };
    }
  | { type: 'cancel'; requestId: string }
  | { type: 'fileChanged'; paths: string[] }
  | { type: 'configureMiddleware'; config: MiddlewareConfig }
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
  | { type: 'canHandleResult'; requestId: string; result: boolean }
  | { type: 'parametersResolved'; requestId: string; result: GetParametersResult }
  | { type: 'geometryComputed'; requestId: string; result: CreateGeometryResultCompleted }
  | { type: 'exported'; requestId: string; result: ExportGeometryResult }
  | { type: 'error'; requestId: string; issues: KernelIssue[] }
  | { type: 'progress'; requestId: string; phase: RenderPhase; detail?: Record<string, unknown> }
  | { type: 'log'; level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }
  | { type: 'logBatch'; entries: Array<{ level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }> }
  | { type: 'telemetry'; entries: PerformanceEntryData[] };
