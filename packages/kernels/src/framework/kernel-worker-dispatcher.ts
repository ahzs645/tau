/**
 * Worker-side Message Dispatcher
 *
 * Routes KernelCommand messages to the appropriate KernelWorker methods
 * and sends KernelResponse messages back. Replaces Comlink expose() for the
 * kernel worker hot path.
 */

import type { OnWorkerLog, LogLevel, LogOrigin } from '@taucad/types';
import type { CreateGeometryResultCompleted } from '#types/kernel.types.js';
import type { KernelCommand, KernelResponse, PerformanceEntryData } from '#types/kernel-protocol.types.js';
import type { KernelWorker } from '#framework/kernel-worker.js';
import type { KernelMessagePort } from '#framework/kernel-message-adapter.js';

function extractGltfTransferables(result: CreateGeometryResultCompleted): Transferable[] {
  if (!result.success) {
    return [];
  }

  const buffers: Transferable[] = [];
  for (const geometry of result.data) {
    if (geometry.format === 'gltf') {
      buffers.push(geometry.content.buffer);
    }
  }

  return buffers;
}

/**
 * Create a message dispatcher that routes commands to a KernelWorker.
 * This is the worker-side counterpart to the KernelWorkerClient on the main thread.
 *
 * @param worker - The KernelWorker instance to dispatch commands to
 * @param port - The message port to receive commands from and send responses to
 */
export function createWorkerDispatcher(worker: KernelWorker, port: KernelMessagePort): void {
  const respond = (response: KernelResponse, transferables?: Transferable[]): void => {
    port.postMessage(response, transferables);
  };

  const pendingLogs: Array<{ level: LogLevel; message: string; origin?: LogOrigin; data?: unknown }> = [];
  let logFlushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushLogs = (): void => {
    if (pendingLogs.length === 0) {
      return;
    }

    respond({ type: 'logBatch', entries: pendingLogs.splice(0) });
    logFlushTimer = undefined;
  };

  const onLog: OnWorkerLog = (log) => {
    pendingLogs.push({ level: log.level, message: log.message, origin: log.origin, data: log.data });
    logFlushTimer ??= setTimeout(flushLogs, 250);
  };

  worker.setTelemetrySend((entries: PerformanceEntryData[]) => {
    respond({ type: 'telemetry', entries });
  });

  port.onMessage(async (command: KernelCommand | KernelResponse) => {
    const message = command as KernelCommand;
    const requestId = 'requestId' in message ? message.requestId : '';
    try {
      switch (message.type) {
        case 'initialize': {
          let fileManagerPort: MessagePort | undefined;
          if ('fileManagerPort' in message && message.fileManagerPort) {
            fileManagerPort = message.fileManagerPort;
          }

          await worker.initializeEntry({ onLog }, { fileManagerPort }, message.options, message.middlewareEntries);

          if (message.bundlerEntries) {
            for (const entry of message.bundlerEntries) {
              // eslint-disable-next-line no-await-in-loop -- Sequential: bundlers must be loaded before use
              await worker.ensureLoadedBundler(entry);
            }
          }

          respond({ type: 'initialized', requestId });
          break;
        }

        case 'render': {
          const result = await worker.renderEntry(
            message.file,
            message.params,
            (parametersResult) => {
              respond({ type: 'parametersResolved', requestId, result: parametersResult });
            },
            (phase) => {
              respond({ type: 'progress', requestId, phase });
            },
            message.tessellation,
          );
          const transferables = extractGltfTransferables(result);

          flushLogs();
          worker.flushTelemetry();
          respond({ type: 'geometryComputed', requestId, result }, transferables);
          break;
        }

        case 'fileChanged': {
          await worker.notifyFileChanged(message.paths);
          break;
        }

        case 'configureMiddleware': {
          await worker.configureMiddleware(message.entries);
          break;
        }

        case 'export': {
          const exportResult = await worker.exportGeometryEntry(message.format, message.tessellation);
          respond({ type: 'exported', requestId, result: exportResult });
          break;
        }

        case 'cancel': {
          break;
        }

        case 'cleanup': {
          await worker.cleanupEntry();
          break;
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      respond({
        type: 'error',
        requestId,
        issues: [{ message: errorMessage, type: 'runtime', severity: 'error' }],
      });
    }
  });
}
