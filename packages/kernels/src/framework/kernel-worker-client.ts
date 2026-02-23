/**
 * Main-thread client for communicating with kernel workers via the KernelTransport protocol.
 * Wraps a KernelTransport with request/response correlation and Promise-based methods.
 */

import type { GeometryFile, ExportFormat, LogOrigin } from '@taucad/types';
import type {
  HashedGeometryResult,
  ExportGeometryResult,
  GetParametersResult,
  KernelIssue,
  MiddlewareRegistrations,
  BundlerRegistrations,
} from '#types/kernel.types.js';
import type { Tessellation } from '#types/kernel-worker.types.js';
import type { KernelResponse, KernelCommand, PerformanceEntryData, RenderPhase } from '#types/kernel-protocol.types.js';
import type { KernelTransport } from '#transport/kernel-transport.js';

/** Callback for worker log events. */
export type OnLogCallback = (log: { level: string; message: string; origin?: LogOrigin; data?: unknown }) => void;

/** Callback for worker telemetry events. */
export type OnTelemetryCallback = (entries: PerformanceEntryData[]) => void;

/** Callback for render progress phase transitions. */
export type OnProgressCallback = (phase: RenderPhase, detail?: Record<string, unknown>) => void;

/**
 * Main-thread client for communicating with kernel workers via the KernelTransport protocol.
 * Wraps a KernelTransport with request/response correlation and Promise-based methods.
 */
export class KernelWorkerClient {
  /* eslint-disable @typescript-eslint/parameter-properties -- erasableSyntaxOnly forbids parameter properties */
  private readonly transport: KernelTransport;
  private readonly onLog: OnLogCallback;
  private readonly onTelemetry?: OnTelemetryCallback;
  /* eslint-enable @typescript-eslint/parameter-properties -- re-enable after constructor fields */

  private nextRequestId = 0;
  private lastRenderRequestId?: string;

  private pendingInit?: { resolve: () => void; reject: (error: Error) => void };
  private pendingRender?: {
    resolve: (result: HashedGeometryResult) => void;
    reject: (error: Error) => void;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: OnProgressCallback;
  };

  private pendingExport?: {
    resolve: (result: ExportGeometryResult) => void;
    reject: (error: Error) => void;
  };

  /** Create a new kernel worker client wrapping the given transport. */
  public constructor(transport: KernelTransport, onLog: OnLogCallback, onTelemetry?: OnTelemetryCallback) {
    this.transport = transport;
    this.onLog = onLog;
    this.onTelemetry = onTelemetry;

    transport.onMessage((response: KernelResponse) => {
      this.handleMessage(response);
    });
  }

  /** Send an initialize command to the worker with options, file manager port, and plugin configs. */
  public async initialize(input: {
    options: Record<string, unknown>;
    fileSystemPort: MessagePort;
    middlewareEntries: MiddlewareRegistrations;
    bundlerEntries?: BundlerRegistrations;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      const command: KernelCommand = {
        type: 'initialize',
        requestId: String(this.nextRequestId++),
        options: input.options,
        middlewareEntries: input.middlewareEntries,
        bundlerEntries: input.bundlerEntries,
        fileSystemPort: input.fileSystemPort,
      };
      this.transport.send(command, [input.fileSystemPort]);
    });
  }

  /**
   * Send a render command to the worker.
   *
   * @param input - Render input containing file, parameters, callbacks, and tessellation
   * @param input.file - The geometry file to render
   * @param input.parameters - The parameters for rendering
   * @param input.onParametersResolved - Optional callback when parameters are resolved
   * @param input.onProgress - Optional progress callback
   * @param input.tessellation - Optional tessellation quality override
   * @returns Completed geometry result
   */
  public async render(input: {
    file: GeometryFile;
    parameters: Record<string, unknown>;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: OnProgressCallback;
    tessellation?: Tessellation;
  }): Promise<HashedGeometryResult> {
    return new Promise<HashedGeometryResult>((resolve, reject) => {
      this.pendingRender = {
        resolve,
        reject,
        onParametersResolved: input.onParametersResolved,
        onProgress: input.onProgress,
      };
      const requestId = String(this.nextRequestId++);
      this.lastRenderRequestId = requestId;
      const command: KernelCommand = {
        type: 'render',
        requestId,
        file: input.file,
        params: input.parameters,
        tessellation: input.tessellation,
      };
      this.transport.send(command);
    });
  }

  /** Cancel any pending render operation. */
  public cancelPendingRender(): void {
    if (this.pendingRender && this.lastRenderRequestId) {
      const command: KernelCommand = { type: 'cancel', requestId: this.lastRenderRequestId };
      this.transport.send(command);
      this.pendingRender.reject(new Error('Render cancelled'));
      this.pendingRender = undefined;
      this.lastRenderRequestId = undefined;
    }
  }

  /** Notify the worker that files have changed for cache invalidation. */
  public notifyFileChanged(paths: string[]): void {
    const command: KernelCommand = { type: 'fileChanged', paths };
    this.transport.send(command);
  }

  /** Send a middleware reconfiguration command to the worker. */
  public configureMiddleware(entries: MiddlewareRegistrations): void {
    const command: KernelCommand = { type: 'configureMiddleware', entries };
    this.transport.send(command);
  }

  /**
   * Send an export command to the worker.
   *
   * @param format - Export file format
   * @param tessellation - Optional tessellation quality for export meshing
   * @returns Export result with blob data
   */
  public async exportGeometry(format: ExportFormat, tessellation?: Tessellation): Promise<ExportGeometryResult> {
    return new Promise<ExportGeometryResult>((resolve, reject) => {
      this.pendingExport = { resolve, reject };
      const command: KernelCommand = {
        type: 'export',
        requestId: String(this.nextRequestId++),
        format,
        tessellation,
      };
      this.transport.send(command);
    });
  }

  /** Send a cleanup command to the worker. */
  public cleanup(): void {
    const command: KernelCommand = { type: 'cleanup' };
    this.transport.send(command);
  }

  /** Terminate the transport connection, rejecting any in-flight promises. */
  public terminate(): void {
    const error = new Error('Kernel client terminated');
    this.pendingInit?.reject(error);
    this.pendingInit = undefined;
    this.pendingRender?.reject(error);
    this.pendingRender = undefined;
    this.pendingExport?.reject(error);
    this.pendingExport = undefined;
    this.transport.close();
  }

  private handleMessage(response: KernelResponse): void {
    switch (response.type) {
      case 'initialized': {
        this.pendingInit?.resolve();
        this.pendingInit = undefined;
        break;
      }

      case 'parametersResolved': {
        this.pendingRender?.onParametersResolved?.(response.result);
        break;
      }

      case 'geometryComputed': {
        this.pendingRender?.resolve(response.result);
        this.pendingRender = undefined;
        break;
      }

      case 'exported': {
        this.pendingExport?.resolve(response.result);
        this.pendingExport = undefined;
        break;
      }

      case 'log': {
        this.onLog({
          level: response.level,
          message: response.message,
          origin: response.origin,
          data: response.data,
        });
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
        this.pendingRender?.onProgress?.(response.phase, response.detail);
        break;
      }

      case 'error': {
        const errorMessage = response.issues.map((i: KernelIssue) => i.message).join('; ');
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
        }

        break;
      }
    }
  }
}
