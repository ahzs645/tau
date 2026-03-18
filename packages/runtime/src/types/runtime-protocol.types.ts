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
} from '#types/runtime.types.js';
import type { Tessellation } from '#types/runtime-kernel.types.js';

/**
 * Commands sent from the kernel machine (main thread) to the runtime worker.
 * Request/response commands include a `requestId` for correlation.
 * @public
 */
export type RuntimeCommand =
  | {
      type: 'initialize';
      requestId: string;
      options: Record<string, unknown>;
      middlewareEntries: MiddlewareRegistrations;
      bundlerEntries?: BundlerRegistrations;
      fileSystemPort?: MessagePort;
      signalBuffer?: SharedArrayBuffer;
    }
  | {
      type: 'render';
      requestId: string;
      file: GeometryFile;
      params: Record<string, unknown>;
      tessellation?: Tessellation;
    }
  | {
      type: 'setFile';
      file: GeometryFile;
      parameters: Record<string, unknown>;
      tessellation?: Tessellation;
    }
  | {
      type: 'setParameters';
      parameters: Record<string, unknown>;
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
 * @public
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
 * @public
 */
export type RenderPhase = string;

/**
 * Worker state as reported via the shared signal channel and stateChanged responses.
 * @public
 */
export type WorkerState = 'idle' | 'rendering' | 'error';

/**
 * Integer enum for worker state in the SharedArrayBuffer signal channel.
 * @public
 */
export const workerStateEnum = {
  idle: 0,
  rendering: 1,
  error: 2,
} as const satisfies Record<WorkerState, number>;

/**
 * Reverse lookup from integer to WorkerState string.
 * @public
 */
export const workerStateNames: Record<number, WorkerState> = {
  [workerStateEnum.idle]: 'idle',
  [workerStateEnum.rendering]: 'rendering',
  [workerStateEnum.error]: 'error',
};

/**
 * Int32Array index layout for the bidirectional GrowableSharedArrayBuffer signal channel.
 *
 * - Slot 0: abort generation (main -> worker, Atomics.store / Atomics.load)
 * - Slot 1: worker state enum (worker -> main, Atomics.store + Atomics.notify / Atomics.waitAsync)
 * - Slot 2: progress percent (worker -> main, Atomics.store, polled)
 * - Slot 3: render phase (worker -> main, Atomics.store, polled)
 * @public
 */
export const signalSlot = {
  abortGeneration: 0,
  workerState: 1,
  progressPercent: 2,
  renderPhase: 3,
} as const;

/**
 * Responses sent from the runtime worker back to the kernel machine (main thread).
 * Request-scoped responses include the `requestId` from the originating command.
 * @public
 */
export type RuntimeResponse =
  | { type: 'initialized'; requestId: string }
  | {
      type: 'parametersResolved';
      requestId: string;
      result: GetParametersResult;
    }
  | {
      type: 'geometryComputed';
      requestId: string;
      result: HashedGeometryResult;
    }
  | { type: 'exported'; requestId: string; result: ExportGeometryResult }
  | { type: 'error'; requestId: string; issues: KernelIssue[] }
  | {
      type: 'progress';
      requestId: string;
      phase: RenderPhase;
      detail?: Record<string, unknown>;
    }
  | {
      type: 'stateChanged';
      state: WorkerState;
      detail?: string;
    }
  | {
      type: 'log';
      level: LogLevel;
      message: string;
      origin?: LogOrigin;
      data?: unknown;
    }
  | {
      type: 'logBatch';
      entries: Array<{
        level: LogLevel;
        message: string;
        origin?: LogOrigin;
        data?: unknown;
      }>;
    }
  | { type: 'telemetry'; entries: PerformanceEntryData[] };
