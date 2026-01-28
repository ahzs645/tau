/**
 * Isomorphic Comlink Endpoint Utility
 *
 * Provides an endpoint that works in both browser/worker and Node.js worker_threads environments.
 * - Browser/Web Worker: uses `self` (the global worker context)
 * - Node.js worker_threads: uses `nodeEndpoint(parentPort)` from comlink's node-adapter
 *
 * @see https://github.com/GoogleChromeLabs/comlink/blob/main/docs/examples/06-node-example/main.mjs
 */

import type { MessagePort } from 'node:worker_threads';
import type { Endpoint } from 'comlink';
import { expose } from 'comlink';
import nodeEndpoint from '#components/geometry/kernel/utils/comlink-node-endpoint.js';

/**
 * Detects if we're running in a browser/worker environment.
 * Uses feature detection rather than environment checks.
 */
function isBrowserWorkerContext(): boolean {
  // Check if `self` exists and has addEventListener (browser/worker global)
  // In Node.js, `self` is undefined or doesn't have the worker interface
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- May not exist in Node.js
    globalThis.self !== undefined &&
    typeof globalThis.self.addEventListener === 'function' &&
    typeof globalThis.self.postMessage === 'function'
  );
}

/**
 * Gets the Node.js worker_threads parentPort if available.
 * Returns undefined if not running in a Node.js worker thread.
 */
function getNodeParentPort(): MessagePort | undefined {
  try {
    // Dynamic require to avoid bundler issues in browser builds
    // eslint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module, @typescript-eslint/consistent-type-imports -- Dynamic require for Node.js detection
    const workerThreads = require('node:worker_threads') as typeof import('node:worker_threads');
    return workerThreads.parentPort ?? undefined;
  } catch {
    // Not in Node.js or worker_threads not available
    return undefined;
  }
}

/**
 * Checks if we're running in a worker context (browser or Node.js).
 * Use this to guard expose() calls in worker files.
 */
export function isWorkerContext(): boolean {
  if (isBrowserWorkerContext()) {
    return true;
  }

  const parentPort = getNodeParentPort();
  return parentPort !== undefined;
}

/**
 * Returns an isomorphic endpoint for comlink's expose() function.
 * - In browser/worker context: returns `self` (the global worker context)
 * - In Node.js worker_threads: returns `nodeEndpoint(parentPort)`
 *
 * @throws Error if called outside of a worker context (browser or Node.js)
 *
 * @example
 * ```typescript
 * import { expose } from 'comlink';
 * import { getWorkerEndpoint, isWorkerContext } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
 *
 * const service = new MyWorker();
 * if (isWorkerContext()) {
 *   expose(service, getWorkerEndpoint());
 * }
 * ```
 */
export function getWorkerEndpoint(): Endpoint {
  // Browser/Web Worker context
  if (isBrowserWorkerContext()) {
    return globalThis.self as unknown as Endpoint;
  }

  // Node.js worker_threads context
  const parentPort = getNodeParentPort();
  if (parentPort) {
    return nodeEndpoint(parentPort);
  }

  throw new Error(
    'getWorkerEndpoint() must be called from a worker context (browser Web Worker or Node.js worker_threads)',
  );
}

/**
 * Exposes a service via comlink if running in a worker context.
 * This is a convenience wrapper that combines isWorkerContext() and expose().
 *
 * In a worker context (browser or Node.js), it exposes the service via comlink.
 * In a non-worker context (tests, direct imports), it does nothing.
 *
 * @param service - The service object to expose via comlink
 * @returns true if the service was exposed, false otherwise
 *
 * @example
 * ```typescript
 * import { exposeWorker } from '#components/geometry/kernel/utils/comlink-worker.utils.js';
 *
 * class MyWorker {
 *   doWork() { return 42; }
 * }
 *
 * const service = new MyWorker();
 * exposeWorker(service);
 *
 * export type MyWorkerInterface = typeof service;
 * ```
 */
export function exposeWorker<T>(service: T): boolean {
  if (!isWorkerContext()) {
    return false;
  }

  expose(service, getWorkerEndpoint());
  return true;
}
