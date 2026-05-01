/**
 * Acquire the worker-side `Port<unknown>` from `node:worker_threads`'s
 * `parentPort`. Used by **`nodeWorkerHost()`** to wire its
 * `ChannelServer` against the parent thread's wire without the
 * consumer having to thread a `MessagePort` through transport options.
 *
 * @internal
 */

import { parentPort } from 'node:worker_threads';
import type { Transferable as NodeTransferable } from 'node:worker_threads';
import type { Port } from '@taucad/rpc';

export const acquireNodeParentPort = (): Port<unknown> => {
  if (!parentPort) {
    throw new Error(
      'nodeWorkerHost(): `parentPort` unavailable — must be called from a `node:worker_threads.Worker` script',
    );
  }
  const port = parentPort;
  const subjects = new Set<(data: unknown) => void>();
  return {
    postMessage(message, transferables) {
      const transfer = (transferables ?? []) as NodeTransferable[];
      port.postMessage(message, transfer.length > 0 ? transfer : undefined);
    },
    onMessage(handler) {
      const listener = (data: unknown): void => {
        handler(data);
      };
      subjects.add(listener);
      port.on('message', listener);
      return () => {
        subjects.delete(listener);
        port.off('message', listener);
      };
    },
    close() {
      for (const listener of subjects) {
        port.off('message', listener);
      }
      subjects.clear();
    },
  };
};
