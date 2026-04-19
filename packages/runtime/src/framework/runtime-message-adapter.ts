/**
 * Isomorphic Message Adapter for Kernel Workers
 *
 * Provides a unified message interface for browser Web Workers and Node.js worker_threads,
 * Abstracts browser/Node.js worker context differences for the MessagePort protocol.
 */

import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';
import type * as NodeWorkerThreads from 'node:worker_threads';
import type { MessagePort as NodeMessagePort, Transferable as NodeTransferable } from 'node:worker_threads';
import { isWebWorker } from '#framework/environment.js';

/**
 * Unified message port interface for runtime worker communication.
 * Abstracts browser Worker and Node.js worker_threads differences.
 */
export type RuntimeMessagePort = {
  postMessage(message: RuntimeCommand | RuntimeResponse, transferables?: Transferable[]): void;
  onMessage(handler: (data: RuntimeCommand | RuntimeResponse) => void): void;
  close(): void;
};

/*
 * Lazy, memoized loader for `node:worker_threads`.
 *
 * Top-level await would block CJS dist output, so the load is deferred to first
 * call. Both Web Workers and Node `worker_threads` buffer port messages until
 * a handler is attached, so the brief async window during worker bootstrap is
 * race-safe.
 */
let cachedWorkerThreadsModule: typeof NodeWorkerThreads | undefined;
let workerThreadsLoadPromise: Promise<void> | undefined;

async function ensureWorkerThreadsLoaded(): Promise<void> {
  if (workerThreadsLoadPromise) {
    return workerThreadsLoadPromise;
  }
  workerThreadsLoadPromise = (async () => {
    // oxlint-disable-next-line @typescript-eslint/no-unnecessary-condition -- globalThis.process is undefined in browsers despite TS typings
    if (!globalThis.process?.versions.node) {
      return;
    }
    cachedWorkerThreadsModule = await import('node:worker_threads').catch(() => undefined);
  })();
  return workerThreadsLoadPromise;
}

async function getNodeParentPort(): Promise<NodeMessagePort | undefined> {
  await ensureWorkerThreadsLoaded();
  return cachedWorkerThreadsModule?.parentPort ?? undefined;
}

/**
 * Check whether the current thread is a worker context (browser or Node.js).
 * Use this to guard dispatcher setup in worker files.
 *
 * @returns `true` when running inside a Web Worker or Node.js worker_threads
 */
export async function isWorkerContext(): Promise<boolean> {
  if (isWebWorker()) {
    return true;
  }
  return (await getNodeParentPort()) !== undefined;
}

/**
 * Get a unified message port for the current worker context.
 * Works in both browser Web Workers and Node.js worker_threads.
 *
 * @returns RuntimeMessagePort with unified send/receive interface
 * @throws Error if called outside a worker context
 */
export async function getWorkerMessagePort(): Promise<RuntimeMessagePort> {
  if (isWebWorker()) {
    return {
      postMessage(message, transferables) {
        self.postMessage(message, { transfer: transferables ?? [] });
      },
      onMessage(handler) {
        globalThis.addEventListener('message', (event: MessageEvent<RuntimeCommand | RuntimeResponse>) => {
          handler(event.data);
        });
      },
      close() {
        globalThis.close();
      },
    };
  }

  const parentPort = await getNodeParentPort();
  if (parentPort) {
    return {
      postMessage(message, transferables) {
        parentPort.postMessage(message, transferables as Array<NodeTransferable> | undefined);
      },
      onMessage(handler) {
        parentPort.on('message', (data: RuntimeCommand | RuntimeResponse) => {
          handler(data);
        });
      },
      close() {
        parentPort.close();
      },
    };
  }

  throw new Error('getWorkerMessagePort() must be called from a worker context');
}
