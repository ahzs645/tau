/**
 * Worker-side Message Dispatcher
 *
 * Routes RuntimeCommand messages to the appropriate KernelWorker methods
 * and sends RuntimeResponse messages back via the runtime worker MessagePort.
 *
 * Includes an unhandled-rejection trap around every awaited operation so
 * that errors thrown in fire-and-forget promises (e.g. Emscripten pthread
 * init) surface as structured error responses instead of silent hangs.
 */

import type { Geometry, OnWorkerLog, LogEntry } from '@taucad/types';
import { idPrefix } from '@taucad/types/constants';
import type { SharedPool } from '@taucad/memory';
import { generatePrefixedId } from '@taucad/utils/id';
import type { HashedGeometryResult, ExportGeometryResult } from '#types/runtime.types.js';
import type {
  RuntimeCommand,
  RuntimeResponse,
  PerformanceEntryData,
  GeometryTransport,
  HashedGeometryResultTransport,
} from '#types/runtime-protocol.types.js';
import type { KernelWorker } from '#framework/kernel-worker.js';
import { logFlushDebounceMs } from '#framework/runtime-framework.constants.js';
import type { RuntimeMessagePort } from '#framework/runtime-message-adapter.js';
import { createErrorTrap } from '#framework/worker-error-trap.js';
import { named } from '#framework/named.js';

function toTransportGeometry(geometry: Geometry, geometryPool: SharedPool | undefined): GeometryTransport {
  if (geometry.format !== 'gltf') {
    return geometry;
  }

  if (geometryPool) {
    if (!geometryPool.has(geometry.hash)) {
      geometryPool.store(geometry.hash, geometry.content);
    }
    if (geometryPool.has(geometry.hash)) {
      return {
        format: 'gltf',
        content: { delivery: 'pooled', key: geometry.hash },
        hash: geometry.hash,
      };
    }
  }

  return {
    format: 'gltf',
    content: { delivery: 'inline', bytes: geometry.content },
    hash: geometry.hash,
  };
}

function toTransportResult(
  result: HashedGeometryResult,
  geometryPool: SharedPool | undefined,
): HashedGeometryResultTransport {
  if (!result.success) {
    return result;
  }

  return {
    ...result,
    data: result.data.map((geo) => toTransportGeometry(geo, geometryPool)),
  };
}

function extractExportTransferables(result: ExportGeometryResult): Transferable[] {
  if (!result.success) {
    return [];
  }

  const seen = new Set<ArrayBuffer>();
  for (const file of result.data) {
    seen.add(file.bytes.buffer);
  }

  return [...seen];
}

/**
 * Create a message dispatcher that routes commands to a KernelWorker.
 * This is the worker-side counterpart to the RuntimeWorkerClient on the main thread.
 *
 * @param worker - The KernelWorker instance to dispatch commands to
 * @param port - The message port to receive commands from and send responses to
 */
export function createWorkerDispatcher(worker: KernelWorker, port: RuntimeMessagePort): void {
  const respond = (response: RuntimeResponse, transferables?: Transferable[]): void => {
    port.postMessage(response, transferables);
  };

  const pendingLogs: LogEntry[] = [];
  let logFlushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushLogs = (): void => {
    if (pendingLogs.length === 0) {
      return;
    }

    respond({ type: 'logBatch', entries: pendingLogs.splice(0) });
    logFlushTimer = undefined;
  };

  const onLog: OnWorkerLog = (log) => {
    pendingLogs.push({
      id: generatePrefixedId(idPrefix.log),
      timestamp: Date.now(),
      level: log.level,
      message: log.message,
      origin: log.origin,
      data: log.data,
    });
    logFlushTimer ??= setTimeout(flushLogs, logFlushDebounceMs);
  };

  worker.setTelemetrySend((entries: PerformanceEntryData[]) => {
    respond({ type: 'telemetry', entries });
  });

  const dispatchCommand = named('dispatchCommand', async (command: RuntimeCommand | RuntimeResponse): Promise<void> => {
    const message = command as RuntimeCommand;
    const requestId = 'requestId' in message ? message.requestId : '';

    const { promise: trapPromise, cleanup: cleanupTrap } = createErrorTrap();

    try {
      switch (message.type) {
        case 'initialize': {
          let fileSystemPort: MessagePort | undefined;
          if ('fileSystemPort' in message && message.fileSystemPort) {
            fileSystemPort = message.fileSystemPort;
          }

          const signalBuffer = 'signalBuffer' in message ? message.signalBuffer : undefined;
          if (signalBuffer) {
            worker.setSignalBuffer(signalBuffer);
          }

          if (message.geometryPoolBuffer) {
            worker.setGeometryPoolBuffer(message.geometryPoolBuffer);
          }
          if (message.filePoolBuffer) {
            worker.setFilePoolBuffer(message.filePoolBuffer);
          }

          worker.onStateChanged = (state, detail) => {
            respond({ type: 'stateChanged', state, detail });
          };

          worker.onGeometryComputed = (result) => {
            const transport = toTransportResult(result, worker.geometryPool);
            respond({ type: 'geometryComputed', requestId: '', result: transport });
          };

          worker.onParametersResolved = (result) => {
            respond({ type: 'parametersResolved', requestId: '', result });
          };

          worker.onProgressUpdate = (phase) => {
            respond({ type: 'progress', requestId: '', phase });
          };

          worker.onError = (issues) => {
            respond({ type: 'error', requestId: '', issues });
          };

          worker.onActiveKernelChanged = (kernelId) => {
            respond({ type: 'activeKernelChanged', kernelId });
          };

          worker.onCapabilitiesUpdated = (capabilities) => {
            respond({ type: 'capabilitiesUpdated', capabilities });
          };

          await Promise.race([
            worker.initialize({
              callbacks: { onLog },
              transferables: { fileSystemPort },
              options: message.options,
              middlewareEntries: message.middlewareEntries,
              transcoderModules: message.transcoderModules,
            }),
            trapPromise,
          ]);

          if (message.bundlerEntries) {
            for (const entry of message.bundlerEntries) {
              // oxlint-disable-next-line no-await-in-loop -- bundler entries must load sequentially to avoid race conditions
              await Promise.race([worker.ensureLoadedBundler(entry), trapPromise]);
            }
          }

          respond({
            type: 'initialized',
            requestId,
            capabilities: worker.capabilitiesManifest,
          });
          break;
        }

        case 'render': {
          const result = await Promise.race([
            worker.render({
              file: message.file,
              parameters: message.params,
              onParametersResolved(parametersResult) {
                respond({
                  type: 'parametersResolved',
                  requestId,
                  result: parametersResult,
                });
              },
              onProgress(phase) {
                respond({ type: 'progress', requestId, phase });
              },
              options: message.options,
            }),
            trapPromise,
          ]);
          const transport = toTransportResult(result, worker.geometryPool);

          flushLogs();
          worker.flushTelemetry();
          respond({ type: 'geometryComputed', requestId, result: transport });
          break;
        }

        case 'setFile': {
          worker.handleSetFile(message.file, message.parameters, message.options);
          break;
        }

        case 'setParameters': {
          worker.handleSetParameters(message.parameters);
          break;
        }

        case 'fileChanged': {
          await Promise.race([worker.notifyFileChanged(message.paths), trapPromise]);
          break;
        }

        case 'configureMiddleware': {
          await Promise.race([worker.configureMiddleware(message.entries), trapPromise]);
          break;
        }

        case 'export': {
          const exportResult = await Promise.race([
            worker.exportGeometry(message.format, message.options),
            trapPromise,
          ]);
          const exportTransferables = extractExportTransferables(exportResult);
          respond({ type: 'exported', requestId, result: exportResult }, exportTransferables);
          break;
        }

        case 'cancel': {
          break;
        }

        case 'cleanup': {
          if (logFlushTimer) {
            clearTimeout(logFlushTimer);
            logFlushTimer = undefined;
          }

          flushLogs();
          await Promise.race([worker.cleanup(), trapPromise]);
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
    } finally {
      cleanupTrap();
    }
  });
  port.onMessage(dispatchCommand);
}
