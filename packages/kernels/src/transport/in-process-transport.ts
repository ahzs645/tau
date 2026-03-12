/**
 * InProcessTransport -- KernelTransport that runs the kernel in the same thread.
 *
 * Uses a MessageChannel to connect a KernelWorkerClient (via KernelTransport)
 * to a KernelRuntimeWorker + createWorkerDispatcher on the other side.
 * No Worker threads are created -- everything runs in the same event loop.
 *
 * Ideal for Node.js CLI tools (benchmarks, batch processing, SSR) where
 * spawning a real Worker thread is unnecessary overhead.
 */

import type { KernelCommand, KernelResponse } from '#types/kernel-protocol.types.js';
import type { KernelTransport } from '#transport/kernel-transport.js';
import type { KernelMessagePort } from '#framework/kernel-message-adapter.js';
import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { createWorkerDispatcher } from '#framework/kernel-worker-dispatcher.js';

/**
 * Create a KernelTransport that runs the kernel dispatcher in-process.
 *
 * Internally creates a MessageChannel, wires one port to a KernelRuntimeWorker
 * via createWorkerDispatcher, and exposes the other port as a KernelTransport.
 * Transferable objects (e.g., MessagePort for filesystem) work correctly
 * through MessageChannel even without a real Worker thread.
 *
 * @returns KernelTransport for use with createKernelClient
 *
 * @public
 *
 * @example <caption>In-process testing setup</caption>
 * ```typescript
 * import { createKernelClient } from '@taucad/runtime';
 * import { createInProcessTransport } from '@taucad/runtime/transport';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createKernelClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: createInProcessTransport(),
 * });
 * ```
 */
export function createInProcessTransport(): KernelTransport {
  const channel = new MessageChannel();

  const workerPort: KernelMessagePort = {
    postMessage(message: KernelCommand | KernelResponse, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        channel.port1.postMessage(message, transferables);
      } else {
        channel.port1.postMessage(message);
      }
    },
    onMessage(handler: (data: KernelCommand | KernelResponse) => void): void {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage assignment to implicitly call start()
      channel.port1.onmessage = (event: MessageEvent<KernelCommand | KernelResponse>): void => {
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
    send(message: KernelCommand, transferables?: Transferable[]): void {
      if (transferables && transferables.length > 0) {
        channel.port2.postMessage(message, transferables);
      } else {
        channel.port2.postMessage(message);
      }
    },
    onMessage(handler: (message: KernelResponse) => void): void {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MessagePort requires onmessage assignment to implicitly call start()
      channel.port2.onmessage = (event: MessageEvent<KernelResponse>): void => {
        handler(event.data);
      };
    },
    close(): void {
      channel.port1.close();
      channel.port2.close();
    },
  };
}
