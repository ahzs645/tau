/**
 * Main-thread client for communicating with kernel workers via the MessagePort protocol.
 * Replaces Comlink's Remote<KernelWorkerInterface> for the kernel hot path.
 */

import type {
  CreateGeometryResultCompleted,
  ExportGeometryResult,
  GetParametersResult,
  GeometryFile,
  ExportFormat,
  KernelIssue,
  LogOrigin,
  MiddlewareConfig,
  BundlerConfig,
  KernelResponse,
  KernelCommand,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/types';

export type OnLogCallback = (log: { level: string; message: string; origin?: LogOrigin; data?: unknown }) => void;

export type OnTelemetryCallback = (entries: PerformanceEntryData[]) => void;

export type OnProgressCallback = (phase: RenderPhase, detail?: Record<string, unknown>) => void;

export class KernelWorkerClient {
  /* eslint-disable @typescript-eslint/parameter-properties -- erasableSyntaxOnly forbids parameter properties */
  public readonly worker: Worker;
  private readonly onLog: OnLogCallback;
  private readonly onTelemetry?: OnTelemetryCallback;
  /* eslint-enable @typescript-eslint/parameter-properties -- re-enable after constructor fields */

  private nextRequestId = 0;
  private lastRenderRequestId?: string;

  private pendingInit?: { resolve: () => void; reject: (error: Error) => void };
  private pendingCanHandle?: { resolve: (result: boolean) => void; reject: (error: Error) => void };
  private pendingRender?: {
    resolve: (result: CreateGeometryResultCompleted) => void;
    reject: (error: Error) => void;
    onParametersResolved?: (result: GetParametersResult) => void;
    onProgress?: OnProgressCallback;
  };

  private pendingExport?: {
    resolve: (result: ExportGeometryResult) => void;
    reject: (error: Error) => void;
  };

  public constructor(worker: Worker, onLog: OnLogCallback, onTelemetry?: OnTelemetryCallback) {
    this.worker = worker;
    this.onLog = onLog;
    this.onTelemetry = onTelemetry;

    worker.addEventListener('message', (event: MessageEvent<KernelResponse>) => {
      this.handleMessage(event.data);
    });
  }

  public async initialize(
    options: Record<string, unknown>,
    fileManagerPort: MessagePort,
    middlewareConfig: MiddlewareConfig,
    bundlerConfig?: BundlerConfig,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      const command: KernelCommand = {
        type: 'initialize',
        requestId: String(this.nextRequestId++),
        options,
        middlewareConfig,
        bundlerConfig,
        fileManagerPort,
      };
      this.worker.postMessage(command, [fileManagerPort]);
    });
  }

  public async canHandle(file: GeometryFile): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.pendingCanHandle = { resolve, reject };
      const command: KernelCommand = { type: 'canHandle', requestId: String(this.nextRequestId++), file };
      this.worker.postMessage(command);
    });
  }

  public async render(
    file: GeometryFile,
    parameters: Record<string, unknown>,
    onParametersResolved?: (result: GetParametersResult) => void,
    onProgress?: OnProgressCallback,
  ): Promise<CreateGeometryResultCompleted> {
    return new Promise<CreateGeometryResultCompleted>((resolve, reject) => {
      this.pendingRender = { resolve, reject, onParametersResolved, onProgress };
      const requestId = String(this.nextRequestId++);
      this.lastRenderRequestId = requestId;
      const command: KernelCommand = {
        type: 'render',
        requestId,
        file,
        params: parameters,
      };
      this.worker.postMessage(command);
    });
  }

  public cancelPendingRender(): void {
    if (this.pendingRender && this.lastRenderRequestId) {
      const command: KernelCommand = { type: 'cancel', requestId: this.lastRenderRequestId };
      this.worker.postMessage(command);
      this.pendingRender.reject(new Error('Render cancelled'));
      this.pendingRender = undefined;
      this.lastRenderRequestId = undefined;
    }
  }

  public notifyFileChanged(paths: string[]): void {
    const command: KernelCommand = { type: 'fileChanged', paths };
    this.worker.postMessage(command);
  }

  public configureMiddleware(config: MiddlewareConfig): void {
    const command: KernelCommand = { type: 'configureMiddleware', config };
    this.worker.postMessage(command);
  }

  public async exportGeometry(
    format: ExportFormat,
    meshConfig?: { linearTolerance: number; angularTolerance: number },
  ): Promise<ExportGeometryResult> {
    return new Promise<ExportGeometryResult>((resolve, reject) => {
      this.pendingExport = { resolve, reject };
      const command: KernelCommand = {
        type: 'export',
        requestId: String(this.nextRequestId++),
        format,
        meshConfig,
      };
      this.worker.postMessage(command);
    });
  }

  public cleanup(): void {
    const command: KernelCommand = { type: 'cleanup' };
    this.worker.postMessage(command);
  }

  public terminate(): void {
    this.worker.terminate();
  }

  private handleMessage(response: KernelResponse): void {
    switch (response.type) {
      case 'initialized': {
        this.pendingInit?.resolve();
        this.pendingInit = undefined;
        break;
      }

      case 'canHandleResult': {
        this.pendingCanHandle?.resolve(response.result);
        this.pendingCanHandle = undefined;
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
        } else if (this.pendingCanHandle) {
          this.pendingCanHandle.reject(error);
          this.pendingCanHandle = undefined;
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
