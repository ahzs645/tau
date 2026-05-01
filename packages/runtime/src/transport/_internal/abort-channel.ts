/**
 * Cooperative-abort signalling helpers used by every bundled
 * transport. Exposes both the client-side trigger (write to SAB +
 * notify) and the host-side adoption (build an `AbortSignal` driven by
 * SAB Atomics waits or a wire-notify fallback).
 *
 * @internal
 */

import type { Channel } from '@taucad/rpc';
import { signalSlot, abortReason } from '#types/runtime-protocol.types.js';
import type { AbortReason, AbortReasonCode, RuntimeProtocol } from '#types/runtime-protocol.types.js';

/**
 * Encode an `AbortReason` to its numeric on-the-wire / on-SAB code.
 */
const encodeReason = (reason: AbortReason): AbortReasonCode =>
  reason === 'superseded' ? abortReason.superseded : abortReason.timeout;

/**
 * Client-side abort trigger. Writes the reason + bumps the
 * generation slot in the signal SAB (when present), then fires the
 * wire-format `'abort'` notify so SAB-less peers stay coherent.
 */
export const triggerAbort = (
  channel: Channel<RuntimeProtocol>,
  signalBuffer: SharedArrayBuffer | undefined,
  reason: AbortReason,
): void => {
  const code = encodeReason(reason);
  if (signalBuffer) {
    const view = new Int32Array(signalBuffer);
    Atomics.store(view, signalSlot.abortReason, code);
    Atomics.add(view, signalSlot.abortGeneration, 1);
    Atomics.notify(view, signalSlot.abortGeneration);
  }
  channel.notify('abort', { reason: code });
};

/**
 * Host-side abort surface: a controller whose `signal` is exposed
 * inside `HostInitializeBindings.abort.signal` and is aborted from
 * either the SAB-Atomics watch loop or the wire-format `'abort'`
 * notify handler.
 */
export type HostAbortSurface = {
  readonly controller: AbortController;
  readonly strategy: 'sab-atomics' | 'wire-notify';
  readonly stop: () => void;
};

/**
 * Build the host-side abort surface from the signal SAB (if any)
 * delivered through the initialise memory handle. When the SAB is
 * present the surface starts an `Atomics.waitAsync` loop watching
 * the `abortGeneration` slot; otherwise the controller is aborted
 * only by the wire-notify handler installed by the dispatcher.
 */
export const adoptHostAbort = (signalBuffer: SharedArrayBuffer | undefined): HostAbortSurface => {
  const controller = new AbortController();
  if (!signalBuffer) {
    return {
      controller,
      strategy: 'wire-notify',
      stop: () => undefined,
    };
  }

  const view = new Int32Array(signalBuffer);
  let stopped = false;

  const watch = async (): Promise<void> => {
    let lastGen = Atomics.load(view, signalSlot.abortGeneration);
    while (!stopped) {
      // `Atomics.waitAsync` may return synchronously when the value already
      // changed; loop until generation actually advances.
      const result = Atomics.waitAsync(view, signalSlot.abortGeneration, lastGen);
      const value: 'ok' | 'not-equal' | 'timed-out' = result.async
        ? await result.value
        : (result.value as 'ok' | 'not-equal' | 'timed-out');
      if (stopped) {
        return;
      }
      const next = Atomics.load(view, signalSlot.abortGeneration);
      if (next !== lastGen) {
        lastGen = next;
        if (!controller.signal.aborted) {
          controller.abort('cooperative-abort');
        }
        return;
      }
      if (value === 'timed-out') {
        return;
      }
    }
  };

  void watch();

  return {
    controller,
    strategy: 'sab-atomics',
    stop: () => {
      stopped = true;
    },
  };
};
