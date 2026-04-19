/**
 * Kernel Worker Protocol Types
 *
 * Defines the typed MessagePort event protocol between the kernel machine (main thread)
 * and kernel workers.
 *
 * All request/response commands carry a `requestId` for correlation. Fire-and-forget
 * commands (fileChanged, configureMiddleware, cleanup) do not require a requestId.
 */

import type { FileExtension, GeometryFile, GeometrySvg, GeometryWebRtc, LogEntry } from '@taucad/types';
import type {
  GetParametersResult,
  ExportGeometryResult,
  KernelIssue,
  KernelResult,
  MiddlewareRegistrations,
  BundlerRegistrations,
  CapabilitiesManifest,
} from '#types/runtime.types.js';

// =============================================================================
// Two-Layer Geometry Transport Types
// =============================================================================

/**
 * Discriminated delivery descriptor for GLTF content in transit.
 *
 * `inline` carries the raw bytes in the message (traditional ArrayBuffer transfer).
 * `pooled` carries only the pool/key coordinates — the main thread resolves bytes
 * from SharedPool for zero-copy access.
 * @internal
 */
export type GltfContentDelivery =
  | { readonly delivery: 'inline'; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly delivery: 'pooled'; readonly key: string };

/**
 * GLTF geometry in transit — content delivered inline or via shared pool.
 * @internal
 */
export type GeometryGltfTransport = {
  readonly format: 'gltf';
  readonly content: GltfContentDelivery;
};

/**
 * All geometry variants in transit.
 * SVG and WebRTC pass through unchanged — only GLTF uses the two-layer transport.
 * @internal
 */
export type GeometryResponseTransport = GeometrySvg | GeometryGltfTransport | GeometryWebRtc;

/**
 * Hashed geometry in transit (wire format).
 * @internal
 */
export type GeometryTransport = GeometryResponseTransport & { readonly hash: string };

/**
 * Full geometry result in transit (wire format).
 * Used on the MessagePort protocol; resolved to `HashedGeometryResult` by RuntimeClient.
 * @internal
 */
export type HashedGeometryResultTransport = KernelResult<GeometryTransport[]>;

/**
 * Entry describing a transcoder module to load during worker initialization.
 * @internal
 */
export type TranscoderModuleEntry = {
  id: string;
  moduleUrl: string;
  options?: Record<string, unknown>;
};

/**
 * Commands sent from the kernel machine (main thread) to the runtime worker.
 * Request/response commands include a `requestId` for correlation.
 * @internal
 */
export type RuntimeCommand =
  | {
      type: 'initialize';
      requestId: string;
      options: Record<string, unknown>;
      middlewareEntries: MiddlewareRegistrations;
      bundlerEntries?: BundlerRegistrations;
      transcoderModules?: TranscoderModuleEntry[];
      fileSystemPort?: MessagePort;
      signalBuffer?: SharedArrayBuffer;
      /** SharedArrayBuffer for the geometry pool (zero-IPC geometry data exchange). */
      geometryPoolBuffer?: SharedArrayBuffer;
      /** SharedArrayBuffer for the file pool (zero-IPC file content caching). */
      filePoolBuffer?: SharedArrayBuffer;
    }
  | {
      type: 'render';
      requestId: string;
      file: GeometryFile;
      params: Record<string, unknown>;
      options?: Record<string, unknown>;
    }
  | {
      type: 'setFile';
      file: GeometryFile;
      parameters: Record<string, unknown>;
      options?: Record<string, unknown>;
    }
  | {
      type: 'setParameters';
      parameters: Record<string, unknown>;
    }
  | {
      type: 'export';
      requestId: string;
      format: FileExtension;
      options?: Record<string, unknown>;
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
export type WorkerState = 'idle' | 'buffering' | 'rendering' | 'error';

/**
 * Integer enum for worker state in the SharedArrayBuffer signal channel.
 * @internal
 */
export const workerStateEnum = {
  idle: 0,
  rendering: 1,
  error: 2,
  buffering: 3,
} as const satisfies Record<WorkerState, number>;

/**
 * Reverse lookup from integer to WorkerState string.
 * @internal
 */
export const workerStateNames: Record<number, WorkerState> = {
  [workerStateEnum.idle]: 'idle',
  [workerStateEnum.rendering]: 'rendering',
  [workerStateEnum.error]: 'error',
  [workerStateEnum.buffering]: 'buffering',
};

/**
 * Int32Array index layout for the bidirectional GrowableSharedArrayBuffer signal channel.
 *
 * - Slot 0: abort generation (main -> worker, Atomics.add / Atomics.load)
 * - Slot 1: worker state enum (worker -> main, Atomics.store + Atomics.notify / Atomics.waitAsync)
 * - Slot 2: progress percent (worker -> main, Atomics.store, polled)
 * - Slot 3: render phase (worker -> main, Atomics.store, polled)
 * - Slot 4: abort reason (main -> worker, Atomics.store / Atomics.load)
 * @internal
 */
export const signalSlot = {
  abortGeneration: 0,
  workerState: 1,
  progressPercent: 2,
  renderPhase: 3,
  abortReason: 4,
} as const;

/**
 * Reason why the current render was aborted, written by the main thread
 * and read by the worker to decide how to handle the abort (error vs. silent discard).
 * @internal
 */
export const abortReason = {
  none: 0,
  superseded: 1,
  timeout: 2,
} as const;

/**
 * Responses sent from the runtime worker back to the kernel machine (main thread).
 * Request-scoped responses include the `requestId` from the originating command.
 * @internal
 */
export type RuntimeResponse =
  | { type: 'initialized'; requestId: string; capabilities: CapabilitiesManifest }
  | {
      type: 'parametersResolved';
      requestId: string;
      result: GetParametersResult;
    }
  | {
      type: 'geometryComputed';
      requestId: string;
      result: HashedGeometryResultTransport;
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
      type: 'activeKernelChanged';
      kernelId: string | undefined;
    }
  | {
      type: 'stateChanged';
      state: WorkerState;
      detail?: string;
    }
  | {
      type: 'log';
      entry: LogEntry;
    }
  | {
      type: 'logBatch';
      entries: LogEntry[];
    }
  | { type: 'telemetry'; entries: PerformanceEntryData[] }
  | { type: 'capabilitiesUpdated'; capabilities: CapabilitiesManifest };
