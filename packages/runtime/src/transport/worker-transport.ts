/**
 * WorkerTransport -- default RuntimeTransport implementation using Web Workers.
 *
 * Internally creates a Worker from the provided URL and wraps its
 * postMessage/addEventListener as a RuntimeTransport.
 */

import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';

/**
 * Create a RuntimeTransport backed by a Web Worker.
 *
 * @param workerUrl - URL of the worker module (must be type: 'module')
 * @returns RuntimeTransport wrapping the Worker's message channel
 *
 * @public
 *
 * @example <caption>Browser setup with Worker transport</caption>
 * ```typescript
 * import { createWorkerTransport } from '@taucad/runtime/transport';
 *
 * const transport = createWorkerTransport('/kernel-worker.js');
 * transport.onMessage((response) => console.log(response.type));
 * ```
 */
export function createWorkerTransport(workerUrl: string): RuntimeTransport & { worker: Worker } {
  const worker = new Worker(workerUrl, { type: 'module' });

  return {
    worker,

    send(message: RuntimeCommand, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        worker.postMessage(message, transferables);
      } else {
        worker.postMessage(message);
      }
    },

    onMessage(handler: (message: RuntimeResponse) => void): void {
      worker.addEventListener('message', (event: MessageEvent<RuntimeResponse>) => {
        handler(event.data);
      });
    },

    close(): void {
      worker.terminate();
    },
  };
}
