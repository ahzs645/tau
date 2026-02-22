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
 * @example
 * ```typescript
 * import { createWorkerTransport } from '@taucad/kernels/transport';
 *
 * const transport = createWorkerTransport(myWorkerUrl);
 * transport.send({ type: 'initialize', requestId: '1', ... });
 * transport.onMessage((response) => console.log(response));
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
