/**
 * Kernel Worker Protocol Types
 *
 * Defines the typed MessagePort event protocol between the kernel machine (main thread)
 * and kernel workers. Replaces Comlink for the kernel hot path (render, fileChanged,
 * configureMiddleware) while keeping Comlink for the file manager.
 */

import type {
  GeometryFile,
  ExportFormat,
  CreateGeometryResultCompleted,
  GetParametersResult,
  ExportGeometryResult,
  KernelIssue,
  MiddlewareConfig,
} from '#types/index.js';
import type { LogLevel, LogOrigin } from '#types/logger.types.js';

/**
 * Commands sent from the kernel machine (main thread) to the kernel worker.
 */
export type KernelCommand =
  | { type: 'initialize'; options: Record<string, unknown>; middlewareConfig: MiddlewareConfig; fileManagerPort?: MessagePort }
  | { type: 'render'; file: GeometryFile; params: Record<string, unknown> }
  | { type: 'fileChanged'; paths: string[] }
  | { type: 'canHandle'; file: GeometryFile }
  | { type: 'configureMiddleware'; config: MiddlewareConfig }
  | { type: 'export'; format: ExportFormat; meshConfig?: { linearTolerance: number; angularTolerance: number } }
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
 * Rendering phase identifiers for progress tracking.
 * Emitted by the worker dispatcher at each phase transition during a render cycle.
 */
export type RenderPhase =
  | 'resolvingDeps'
  | 'bundling'
  | 'extractingParams'
  | 'computingGeometry'
  | 'postProcessing';

/**
 * Responses sent from the kernel worker back to the kernel machine (main thread).
 */
export type KernelResponse =
  | { type: 'initialized' }
  | { type: 'canHandleResult'; result: boolean }
  | { type: 'parametersResolved'; result: GetParametersResult }
  | { type: 'geometryComputed'; result: CreateGeometryResultCompleted }
  | { type: 'exported'; result: ExportGeometryResult }
  | { type: 'error'; issues: KernelIssue[] }
  | { type: 'log'; level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }
  | { type: 'telemetry'; entries: PerformanceEntryData[] }
  | { type: 'progress'; phase: RenderPhase; detail?: Record<string, unknown> };
