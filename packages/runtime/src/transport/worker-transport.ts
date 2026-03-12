/**
 * WorkerTransport -- default KernelTransport implementation using Web Workers.
 *
 * Internally creates a Worker from the provided URL and wraps its
 * postMessage/addEventListener as a KernelTransport.
 */

import type { KernelCommand, KernelResponse } from '#types/kernel-protocol.types.js';
import type { KernelTransport } from '#transport/kernel-transport.js';

/**
 * Create a KernelTransport backed by a Web Worker.
 *
 * @param workerUrl - URL of the worker module (must be type: 'module')
 * @returns KernelTransport wrapping the Worker's message channel
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
export function createWorkerTransport(workerUrl: string): KernelTransport & { worker: Worker } {
  const worker = new Worker(workerUrl, { type: 'module' });

  return {
    worker,

    send(message: KernelCommand, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        worker.postMessage(message, transferables);
      } else {
        worker.postMessage(message);
      }
    },

    onMessage(handler: (message: KernelResponse) => void): void {
      worker.addEventListener('message', (event: MessageEvent<KernelResponse>) => {
        handler(event.data);
      });
    },

    close(): void {
      worker.terminate();
    },
  };
}
