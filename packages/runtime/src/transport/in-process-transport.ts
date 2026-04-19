/**
 * InProcessTransport -- RuntimeTransport that runs the kernel in the same thread.
 *
 * Uses a MessageChannel to connect a RuntimeWorkerClient (via RuntimeTransport)
 * to a KernelRuntimeWorker + createWorkerDispatcher on the other side.
 * No Worker threads are created -- everything runs in the same event loop.
 *
 * Ideal for Node.js CLI tools (benchmarks, batch processing, SSR) where
 * spawning a real Worker thread is unnecessary overhead.
 */

import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';
import type { RuntimeTransport } from '#transport/runtime-transport.js';
import type { RuntimeMessagePort } from '#framework/runtime-message-adapter.js';
import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { createWorkerDispatcher } from '#framework/runtime-worker-dispatcher.js';

/**
 * Create a RuntimeTransport that runs the kernel dispatcher in-process.
 *
 * Internally creates a MessageChannel, wires one port to a KernelRuntimeWorker
 * via createWorkerDispatcher, and exposes the other port as a RuntimeTransport.
 * Transferable objects (e.g., MessagePort for filesystem) work correctly
 * through MessageChannel even without a real Worker thread.
 *
 * @returns RuntimeTransport for use with createRuntimeClient
 *
 * @public
 *
 * @example <caption>In-process testing setup</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { createInProcessTransport } from '@taucad/runtime/transport';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: createInProcessTransport(),
 * });
 * ```
 */
export function createInProcessTransport(): RuntimeTransport {
  const channel = new MessageChannel();

  const workerPort: RuntimeMessagePort = {
    postMessage(message: RuntimeCommand | RuntimeResponse, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        channel.port1.postMessage(message, transferables);
      } else {
        channel.port1.postMessage(message);
      }
    },
    onMessage(handler: (data: RuntimeCommand | RuntimeResponse) => void): void {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage assignment to implicitly call start()
      channel.port1.onmessage = (event: MessageEvent<RuntimeCommand | RuntimeResponse>): void => {
        handler(event.data);
      };
    },
    close(): void {
      channel.port1.close();
    },
  };

  const worker = new KernelRuntimeWorker();
  createWorkerDispatcher(worker, workerPort);

  return {
    send(message: RuntimeCommand, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        channel.port2.postMessage(message, transferables);
      } else {
        channel.port2.postMessage(message);
      }
    },
    onMessage(handler: (message: RuntimeResponse) => void): void {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage assignment to implicitly call start()
      channel.port2.onmessage = (event: MessageEvent<RuntimeResponse>): void => {
        handler(event.data);
      };
    },
    close(): void {
      channel.port1.close();
      channel.port2.close();
    },
  };
}
