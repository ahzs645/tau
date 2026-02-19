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
  KernelResponse,
  KernelCommand,
  PerformanceEntryData,
  RenderPhase,
} from '@taucad/types';

export type OnLogCallback = (log: { level: string; message: string; origin?: LogOrigin; data?: unknown }) => void;

export type OnTelemetryCallback = (entries: PerformanceEntryData[]) => void;

export type OnProgressCallback = (phase: RenderPhase, detail?: Record<string, unknown>) => void;

export class KernelWorkerClient {
  private readonly worker: Worker;
  private readonly onLog: OnLogCallback;
  private readonly onTelemetry?: OnTelemetryCallback;

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
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      const command: KernelCommand = {
        type: 'initialize',
        options,
        middlewareConfig,
        fileManagerPort,
      };
      this.worker.postMessage(command, [fileManagerPort]);
    });
  }

  public async canHandle(file: GeometryFile): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.pendingCanHandle = { resolve, reject };
      const command: KernelCommand = { type: 'canHandle', file };
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
      const command: KernelCommand = { type: 'render', file, params: parameters };
      this.worker.postMessage(command);
    });
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
      const command: KernelCommand = { type: 'export', format, meshConfig };
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

      case 'telemetry': {
        this.onTelemetry?.(response.entries);
        break;
      }

      case 'progress': {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- detail is Record<string, unknown> from KernelResponse
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
