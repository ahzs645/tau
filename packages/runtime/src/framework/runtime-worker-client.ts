/**
 * Main-thread client for communicating with kernel workers via the RuntimeTransport protocol.
 * Wraps a RuntimeTransport with request/response correlation and Promise-based methods.
 */

import type { FileExtension, GeometryFile, LogEntry } from '@taucad/types';
import type {
  ExportGeometryResult,
  GetParametersResult,
  KernelIssue,
  MiddlewareRegistrations,
  BundlerRegistrations,
  CapabilitiesManifest,
} from '#types/runtime.types.js';
import type {
  RuntimeResponse,
  RuntimeCommand,
  PerformanceEntryData,
  RenderPhase,
  WorkerState,
  HashedGeometryResultTransport,
  TranscoderModuleEntry,
} from '#types/runtime-protocol.types.js';
import { signalSlot, abortReason, workerStateNames } from '#types/runtime-protocol.types.js';
import { waitForSlotChange } from '#framework/async-polyfills.js';
import { signalBufferByteLength, signalBufferMaxByteLength } from '#framework/runtime-framework.constants.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';

/**
 * Error thrown when a render is superseded by a newer `render()` call.
 * Used by the auto-cancellation (latest-wins) mechanism.
 * @public
 */
export class RenderSupersededError extends Error {
  public constructor() {
    super('Render superseded by a newer render() call');
    this.name = 'RenderSupersededError';
  }
}

/**
 * Realm-safe type guard -- checks `error.name` instead of prototype chain.
 *
 * @param error - the value to test
 * @returns `true` when the error is a {@link RenderSupersededError}
 * @public
 */
export function isRenderSupersededError(error: unknown): error is RenderSupersededError {
  return error instanceof Error && error.name === 'RenderSupersededError';
}

/**
 * Error thrown when a render is aborted via the SharedArrayBuffer abort channel.
 * The OC Proxy checks the abort generation before every WASM call and throws this
 * when the generation has been incremented by a newer setFile/setParameters call.
 * @public
 */
export class RenderAbortedError extends Error {
  public constructor() {
    super('Render aborted by a newer setFile/setParameters call');
    this.name = 'RenderAbortedError';
  }
}

/**
 * Realm-safe type guard -- checks `error.name` instead of prototype chain.
 *
 * @param error - the value to test
 * @returns `true` when the error is a {@link RenderAbortedError}
 * @public
 */
export function isRenderAbortedError(error: unknown): error is RenderAbortedError {
  return error instanceof Error && error.name === 'RenderAbortedError';
}

/**
 * Error thrown when a render exceeds the configured wall-clock timeout.
 * @public
 */
export class RenderTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(
      `Render timed out after ${timeoutMs / 1000} seconds. ` +
        'Increase the timeout in viewer settings or simplify the model geometry.',
    );
    this.name = 'RenderTimeoutError';
  }
}

/**
 * Realm-safe type guard -- checks `error.name` instead of prototype chain.
 *
 * @param error - the value to test
 * @returns `true` when the error is a {@link RenderTimeoutError}
 * @public
 */
export function isRenderTimeoutError(error: unknown): error is RenderTimeoutError {
  return error instanceof Error && error.name === 'RenderTimeoutError';
}

/**
 * Callback for worker log events.
 * @public
 */
export type OnLogCallback = (log: LogEntry) => void;

/**
 * Callback for worker telemetry events.
 * @public
 */
export type OnTelemetryCallback = (entries: PerformanceEntryData[]) => void;

/**
 * Callback for render progress phase transitions.
 * @public
 */
export type OnProgressCallback = (phase: RenderPhase, detail?: Record<string, unknown>) => void;

/**
 * Callback for worker state changes (idle, rendering, error).
 * @public
 */
export type OnStateChangedCallback = (state: WorkerState, detail?: string) => void;

/**
 * Main-thread client for communicating with kernel workers via the RuntimeTransport protocol.
 * Wraps a RuntimeTransport with request/response correlation and Promise-based methods.
 * @public
 */
export class RuntimeWorkerClient {
  /* oxlint-disable @typescript-eslint/parameter-properties -- erasableSyntaxOnly forbids parameter properties */
  private readonly transport: RuntimeTransport;
  private readonly onLog: OnLogCallback;
  private readonly onTelemetry?: OnTelemetryCallback;
  private readonly onStateChanged?: OnStateChangedCallback;
  private readonly onGeometryComputed?: (result: HashedGeometryResultTransport) => void;
  private readonly onParametersResolvedCb?: (result: GetParametersResult) => void;
  private readonly onProgressCb?: OnProgressCallback;
  private readonly onErrorCb?: (issues: KernelIssue[]) => void;
  private readonly onActiveKernelChangedCb?: (kernelId: string | undefined) => void;
  private readonly onCapabilitiesUpdatedCb?: (capabilities: CapabilitiesManifest) => void;
  /* oxlint-enable @typescript-eslint/parameter-properties -- re-enable after constructor fields */

  private nextRequestId = 0;
  private lastRenderRequestId?: string;
  private abortGeneration = 0;
  private readonly signalBuffer: SharedArrayBuffer | undefined;
  private readonly signalView: Int32Array | undefined;
  private stateMonitorTerminated = false;
  private lastReportedState?: WorkerState;
  private renderTimeoutMs = 0;
  private renderTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  private _capabilities: CapabilitiesManifest | undefined;
  private pendingInit?: { resolve: () => void; reject: (error: Error) => void };
  private pendingRender?: {
    resolve: (result: HashedGeometryResultTransport) => void;
    reject: (error: Error) => void;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: OnProgressCallback;
  };

  private pendingExport?: {
    resolve: (result: ExportGeometryResult) => void;
    reject: (error: Error) => void;
  };

  /**
   * Create a new runtime worker client wrapping the given transport.
   *
   * @param transport - transport layer used to send commands and receive responses
   * @param onLog - callback invoked for every log event from the worker
   * @param options - optional callbacks for telemetry, file change, and state change events
   */
  public constructor(
    transport: RuntimeTransport,
    onLog: OnLogCallback,
    options?: {
      onTelemetry?: OnTelemetryCallback;
      onStateChanged?: OnStateChangedCallback;
      onGeometryComputed?: (result: HashedGeometryResultTransport) => void;
      onParametersResolved?: (result: GetParametersResult) => void;
      onProgress?: OnProgressCallback;
      onError?: (issues: KernelIssue[]) => void;
      onActiveKernelChanged?: (kernelId: string | undefined) => void;
      onCapabilitiesUpdated?: (capabilities: CapabilitiesManifest) => void;
    },
  ) {
    this.transport = transport;
    this.onLog = onLog;
    this.onTelemetry = options?.onTelemetry;
    this.onStateChanged = options?.onStateChanged;
    this.onGeometryComputed = options?.onGeometryComputed;
    this.onParametersResolvedCb = options?.onParametersResolved;
    this.onProgressCb = options?.onProgress;
    this.onErrorCb = options?.onError;
    this.onActiveKernelChangedCb = options?.onActiveKernelChanged;
    this.onCapabilitiesUpdatedCb = options?.onCapabilitiesUpdated;

    try {
      // GrowableSharedArrayBuffer: maxByteLength allows future expansion without worker restart
      this.signalBuffer = new SharedArrayBuffer(signalBufferByteLength, {
        maxByteLength: signalBufferMaxByteLength,
      });
      this.signalView = new Int32Array(this.signalBuffer);
    } catch {
      this.signalBuffer = undefined;
      this.signalView = undefined;
    }

    transport.onMessage((response: RuntimeResponse) => {
      this.handleMessage(response);
    });
  }

  /**
   * Send an initialize command to the worker with options, file manager port, and plugin configs.
   *
   * @param input - initialization payload with options, filesystem port, and middleware/bundler registrations
   */
  public async initialize(input: {
    options: Record<string, unknown>;
    fileSystemPort: MessagePort;
    middlewareEntries: MiddlewareRegistrations;
    bundlerEntries?: BundlerRegistrations;
    transcoderModules?: TranscoderModuleEntry[];
    /** SharedArrayBuffer for the geometry pool (zero-IPC geometry data exchange). */
    geometryPoolBuffer?: SharedArrayBuffer;
    /** SharedArrayBuffer for the file pool (zero-IPC file content caching). */
    filePoolBuffer?: SharedArrayBuffer;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInit = {
        resolve: () => {
          this.startStateMonitor();
          resolve();
        },
        reject,
      };
      const command: RuntimeCommand = {
        type: 'initialize',
        requestId: String(this.nextRequestId++),
        options: input.options,
        middlewareEntries: input.middlewareEntries,
        bundlerEntries: input.bundlerEntries,
        transcoderModules: input.transcoderModules,
        fileSystemPort: input.fileSystemPort,
        signalBuffer: this.signalBuffer,
        geometryPoolBuffer: input.geometryPoolBuffer,
        filePoolBuffer: input.filePoolBuffer,
      };
      this.transport.send(command, [input.fileSystemPort]);
    });
  }

  /**
   * Increment the abort generation in the shared signal channel.
   * The worker checks this value before every OC call and aborts if it has changed.
   *
   * @returns The new abort generation value.
   */
  public incrementAbortGeneration(): number {
    if (this.signalView) {
      this.abortGeneration = Atomics.add(this.signalView, signalSlot.abortGeneration, 1) + 1;
    } else {
      this.abortGeneration++;
    }
    return this.abortGeneration;
  }

  /**
   * Read current worker state from the shared signal channel.
   *
   * @returns Current worker state or undefined if no signal buffer.
   */
  public getWorkerState(): WorkerState | undefined {
    if (!this.signalView) {
      return undefined;
    }
    const raw = Atomics.load(this.signalView, signalSlot.workerState);
    return workerStateNames[raw];
  }

  /**
   * Read current progress percent from the shared signal channel.
   *
   * @returns Progress percent (0-100), or 0 if no signal buffer.
   */
  public getProgressPercent(): number {
    if (!this.signalView) {
      return 0;
    }
    return Atomics.load(this.signalView, signalSlot.progressPercent);
  }

  /**
   * Send a render command to the worker.
   *
   * @param input - render payload with file, parameters, callbacks, and tessellation config
   * @returns Completed geometry result
   */
  public async render(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: OnProgressCallback;
    options?: Record<string, unknown>;
  }): Promise<HashedGeometryResultTransport> {
    return new Promise<HashedGeometryResultTransport>((resolve, reject) => {
      this.pendingRender = {
        resolve,
        reject,
        onParametersResolved: input.onParametersResolved,
        onProgress: input.onProgress,
      };
      const requestId = String(this.nextRequestId++);
      this.lastRenderRequestId = requestId;
      const command: RuntimeCommand = {
        type: 'render',
        requestId,
        file: input.file,
        params: input.parameters,
        options: input.options,
      };
      this.transport.send(command);
    });
  }

  /** Cancel any pending render operation. */
  public cancelPendingRender(): void {
    if (this.pendingRender && this.lastRenderRequestId) {
      const command: RuntimeCommand = {
        type: 'cancel',
        requestId: this.lastRenderRequestId,
      };
      this.transport.send(command);
      this.pendingRender.reject(new RenderSupersededError());
      this.pendingRender = undefined;
      this.lastRenderRequestId = undefined;
    }
  }

  /**
   * Set the active file for the autonomous render loop (filesystem mode).
   * Aborts any in-progress render via the shared signal channel before sending the command.
   *
   * @param file - The geometry file to render
   * @param parameters - Parameters for the render
   * @param options - Optional render options
   */
  public setFile(file: GeometryFile, parameters?: Record<string, unknown>, options?: Record<string, unknown>): void {
    if (this.signalView) {
      Atomics.store(this.signalView, signalSlot.abortReason, abortReason.superseded);
    }
    this.incrementAbortGeneration();
    const command: RuntimeCommand = {
      type: 'setFile',
      file,
      parameters: parameters ?? {},
      options,
    };
    this.transport.send(command);
  }

  /**
   * Update parameters for the autonomous render loop (filesystem mode).
   * Aborts any in-progress render via the shared signal channel before sending the command.
   *
   * @param parameters - Updated parameters for the render
   */
  public setParameters(parameters: Record<string, unknown>): void {
    if (this.signalView) {
      Atomics.store(this.signalView, signalSlot.abortReason, abortReason.superseded);
    }
    this.incrementAbortGeneration();
    const command: RuntimeCommand = {
      type: 'setParameters',
      parameters,
    };
    this.transport.send(command);
  }

  /**
   * Notify the worker that files have changed for cache invalidation.
   *
   * @param paths - absolute paths of the files that changed
   */
  public notifyFileChanged(paths: string[]): void {
    const command: RuntimeCommand = { type: 'fileChanged', paths };
    this.transport.send(command);
  }

  /**
   * Send a middleware reconfiguration command to the worker.
   *
   * @param entries - new middleware configuration to apply
   */
  public configureMiddleware(entries: MiddlewareRegistrations): void {
    const command: RuntimeCommand = { type: 'configureMiddleware', entries };
    this.transport.send(command);
  }

  /**
   * Set the wall-clock render timeout enforced by the main thread.
   * When the timer fires, the abort generation is incremented via SharedArrayBuffer
   * and the abort reason is set to `timeout`, causing the worker's cooperative
   * abort checks to throw.
   *
   * @param timeoutMs - Timeout in milliseconds. 0 disables the timeout.
   */
  public setRenderTimeout(timeoutMs: number): void {
    this.renderTimeoutMs = timeoutMs;
  }

  /**
   * Send an export command to the worker.
   *
   * @param format - Export file format identifier (e.g. 'stl', 'step', 'glb')
   * @param options - Format-specific export options. May include `tessellation`.
   * @returns Export result with blob data
   */
  public async exportGeometry(format: FileExtension, options?: Record<string, unknown>): Promise<ExportGeometryResult> {
    return new Promise<ExportGeometryResult>((resolve, reject) => {
      this.pendingExport = { resolve, reject };
      const command: RuntimeCommand = {
        type: 'export',
        requestId: String(this.nextRequestId++),
        format,
        options,
      };
      this.transport.send(command);
    });
  }

  /** Capabilities manifest from the worker, available after initialization. */
  public get capabilities(): CapabilitiesManifest | undefined {
    return this._capabilities;
  }

  /** Send a cleanup command to the worker. */
  public cleanup(): void {
    const command: RuntimeCommand = { type: 'cleanup' };
    this.transport.send(command);
  }

  /** Terminate the transport connection, rejecting any in-flight promises. */
  public terminate(): void {
    this.clearRenderTimeout();
    this.stateMonitorTerminated = true;
    if (this.signalView) {
      Atomics.notify(this.signalView, signalSlot.workerState);
    }
    const error = new Error('Runtime client terminated');
    this.pendingInit?.reject(error);
    this.pendingInit = undefined;
    this.pendingRender?.reject(error);
    this.pendingRender = undefined;
    this.pendingExport?.reject(error);
    this.pendingExport = undefined;
    this.transport.close();
  }

  private startRenderTimeout(): void {
    this.clearRenderTimeout();
    if (this.renderTimeoutMs <= 0 || !this.signalView) {
      return;
    }
    this.renderTimeoutTimer = setTimeout(() => {
      if (this.signalView) {
        Atomics.store(this.signalView, signalSlot.abortReason, abortReason.timeout);
      }
      this.incrementAbortGeneration();
    }, this.renderTimeoutMs);
  }

  private clearRenderTimeout(): void {
    if (this.renderTimeoutTimer !== undefined) {
      clearTimeout(this.renderTimeoutTimer);
      this.renderTimeoutTimer = undefined;
    }
  }

  private reportState(state: WorkerState, detail?: string): void {
    if (state === this.lastReportedState && !detail) {
      return;
    }
    this.lastReportedState = state;

    if (state === 'rendering') {
      this.startRenderTimeout();
    } else if (state === 'idle' || state === 'error') {
      this.clearRenderTimeout();
    }

    this.onStateChanged?.(state, detail);
  }

  private startStateMonitor(): void {
    if (!this.signalView || !this.onStateChanged) {
      return;
    }

    const view = this.signalView;
    const monitorLoop = async (): Promise<void> => {
      let currentState = Atomics.load(view, signalSlot.workerState);
      while (!this.stateMonitorTerminated) {
        // oxlint-disable-next-line no-await-in-loop -- sequential processing is intentional
        await waitForSlotChange(view, signalSlot.workerState, currentState);
        const newState = Atomics.load(view, signalSlot.workerState);
        if (newState !== currentState) {
          currentState = newState;
          const stateName = workerStateNames[newState];
          if (stateName) {
            this.reportState(stateName);
          }
        }
      }
    };
    void monitorLoop();
  }

  // oxlint-disable-next-line complexity -- TODO: refactor if needed
  private handleMessage(response: RuntimeResponse): void {
    switch (response.type) {
      case 'initialized': {
        this._capabilities = response.capabilities;
        this.pendingInit?.resolve();
        this.pendingInit = undefined;
        break;
      }

      case 'parametersResolved': {
        if (this.pendingRender) {
          this.pendingRender.onParametersResolved?.(response.result);
        } else {
          this.onParametersResolvedCb?.(response.result);
        }
        break;
      }

      case 'geometryComputed': {
        if (this.pendingRender) {
          this.pendingRender.resolve(response.result);
          this.pendingRender = undefined;
        } else {
          this.onGeometryComputed?.(response.result);
        }
        break;
      }

      case 'exported': {
        this.pendingExport?.resolve(response.result);
        this.pendingExport = undefined;
        break;
      }

      case 'log': {
        const { entry } = response;
        this.onLog(entry);
        break;
      }

      case 'logBatch': {
        for (const entry of response.entries) {
          this.onLog(entry);
        }

        break;
      }

      case 'telemetry': {
        this.onTelemetry?.(response.entries);
        break;
      }

      case 'progress': {
        if (this.pendingRender) {
          this.pendingRender.onProgress?.(response.phase, response.detail);
        } else {
          this.onProgressCb?.(response.phase, response.detail);
        }
        break;
      }

      case 'error': {
        const { issues } = response;
        const errorMessage = issues.map((issue: KernelIssue) => issue.message).join('; ');
        const error = new Error(errorMessage);

        if (this.pendingInit) {
          this.pendingInit.reject(error);
          this.pendingInit = undefined;
        } else if (this.pendingRender) {
          this.pendingRender.reject(error);
          this.pendingRender = undefined;
        } else if (this.pendingExport) {
          this.pendingExport.reject(error);
          this.pendingExport = undefined;
        } else {
          this.onErrorCb?.(issues);
        }

        break;
      }

      case 'stateChanged': {
        this.reportState(response.state, response.detail);
        break;
      }

      case 'activeKernelChanged': {
        this.onActiveKernelChangedCb?.(response.kernelId);
        break;
      }

      case 'capabilitiesUpdated': {
        this._capabilities = response.capabilities;
        this.onCapabilitiesUpdatedCb?.(response.capabilities);
        break;
      }
    }
  }
}
