/**
 * Acquire the worker-side `Port<unknown>` from the global scope of a
 * dedicated browser `Worker`. Used by **`webWorkerHost()`** to
 * wire its `ChannelServer` against the parent thread's wire without
 * the consumer having to thread a `MessagePort` through transport
 * options.
 *
 * @internal
 */

import type { Port } from '@taucad/rpc';

export const acquireWebWorkerSelfPort = (): Port<unknown> => {
  const subjects = new Set<(event: { data: unknown }) => void>();
  return {
    postMessage(message, transferables) {
      const transfer = (transferables ?? []) as Transferable[];
      // oxlint-disable-next-line no-restricted-globals -- inside the worker `self === globalThis` and is the parent-thread wire
      (
        globalThis as unknown as { postMessage(value: unknown, options?: { transfer?: Transferable[] }): void }
      ).postMessage(message, transfer.length > 0 ? { transfer } : undefined);
    },
    onMessage(handler) {
      const listener = ((event: MessageEvent<unknown>): void => {
        handler(event.data);
      }) as EventListener;
      subjects.add(listener as unknown as (event: { data: unknown }) => void);
      globalThis.addEventListener('message', listener);
      return () => {
        subjects.delete(listener as unknown as (event: { data: unknown }) => void);
        globalThis.removeEventListener('message', listener);
      };
    },
    close() {
      for (const listener of subjects) {
        globalThis.removeEventListener('message', listener as unknown as EventListener);
      }
      subjects.clear();
    },
  };
};
