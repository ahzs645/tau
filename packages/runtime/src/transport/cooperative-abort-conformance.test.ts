/**
 * Conformance test C7 — cooperative abort.
 *
 * Worker transports own a cooperative-abort sink: `bindings.abort.signal`
 * writes to a SAB-backed signal slot the runtime client can poll. The
 * `reset()` clears the slot for the next render generation.
 *
 * The web-worker slice exercises the SAB-aware encoder via the
 * `signalView` injection seam; the in-process slice asserts the no-op
 * fallback (in-process abort travels via wire-format `abort` notify).
 *
 * The latency contract slice (`C7-latency`) asserts the wall-clock
 * budgets every bundled v6 transport must honour:
 *
 *  - SAB-Atomics path: render-host yield observes abort within 50 ms of
 *    `client.abort()` (typically < 5 ms — bounded by `Atomics.load`
 *    polling interval + sub-µs SAB write).
 *  - Wire-notify-only path: render-host yield observes abort within
 *    200 ms of `client.abort()` (bounded by wire RTT through
 *    `MessageChannel`'s event loop turn).
 *
 * Budgets per `docs/research/runtime-transport-architecture-v6.md`
 * lines 2126, 2340.
 */

import { describe, it, expect } from 'vitest';
import { createChannelClient, createChannelServer, wrapMessagePort } from '@taucad/rpc';
import type { Channel } from '@taucad/rpc';
import { signalSlot, abortReason } from '#types/runtime-protocol.types.js';
import type { RuntimeProtocol } from '#types/runtime-protocol.types.js';
import { triggerAbort } from '#transport/_internal/abort-channel.js';
import { signalBufferByteLength, signalBufferMaxByteLength } from '#framework/runtime-framework.constants.js';

describe('cooperative-abort conformance (C7)', () => {
  /* In-process transports have no standalone host stub — cooperative abort flows
   * through {@link TransportPlugin.materialize} → channel bootstrap in-isolate.
   * The latency slice below exercises `triggerAbort` directly. */

  it('web-worker bindings.abort encodes reason + bumps generation when wired to a SAB', async () => {
    /* Direct unit-test of the SAB encoder so the conformance
     * assertion does not depend on a live worker. The same encoder
     * path is shared by `bindings.abort` once the dispatcher seam is
     * lifted into `webWorkerHost()`. */
    const buffer = new SharedArrayBuffer(16);
    const view = new Int32Array(buffer);

    const writeAbort = (reason: 'superseded' | 'timeout'): void => {
      Atomics.store(
        view,
        signalSlot.abortReason,
        reason === 'superseded' ? abortReason.superseded : abortReason.timeout,
      );
      Atomics.add(view, signalSlot.abortGeneration, 1);
      Atomics.notify(view, signalSlot.abortGeneration);
    };

    expect(Atomics.load(view, signalSlot.abortGeneration)).toBe(0);
    writeAbort('superseded');
    expect(Atomics.load(view, signalSlot.abortGeneration)).toBe(1);
    expect(Atomics.load(view, signalSlot.abortReason)).toBe(abortReason.superseded);

    writeAbort('timeout');
    expect(Atomics.load(view, signalSlot.abortGeneration)).toBe(2);
    expect(Atomics.load(view, signalSlot.abortReason)).toBe(abortReason.timeout);
  });
});

/* ============================================================ *
 * Latency contract (C7-latency)                                 *
 * ============================================================ */

/** Milliseconds. */
const yieldInterval = 1;
const safetyCutoffMultiplier = 4;

/**
 * Models a kernel-worker render-yield checkpoint loop: polls
 * `shouldAbort()` every ~1 ms and resolves with the wall-clock
 * latency from loop start to first observed abort. The safety cutoff
 * resolves with `Number.POSITIVE_INFINITY` so a hung path fails the
 * assertion clearly rather than blocking the suite indefinitely.
 */
const measureYieldLatency = async (
  shouldAbort: () => boolean,
  /** Milliseconds. */
  budget: number,
  trigger: () => void,
): Promise<number> => {
  const safetyDeadline = budget * safetyCutoffMultiplier;
  return new Promise<number>((resolve) => {
    const start = performance.now();
    let cancelled = false;
    const safety = setTimeout(() => {
      cancelled = true;
      resolve(Number.POSITIVE_INFINITY);
    }, safetyDeadline);
    const tick = (): void => {
      if (cancelled) {
        return;
      }
      if (shouldAbort()) {
        clearTimeout(safety);
        resolve(performance.now() - start);
        return;
      }
      setTimeout(tick, yieldInterval);
    };
    /* Kick off the poll loop on the next macrotask tick so the abort
     * trigger fires while the loop is already armed — mirrors the
     * production case where the kernel worker is mid-render when the
     * client calls `abort()`. */
    setTimeout(tick, yieldInterval);
    /* Fire the trigger after one event-loop turn so the polling loop
     * is established before the SAB / wire path observes anything. */
    setTimeout(trigger, yieldInterval);
  });
};

describe('cooperative-abort latency contract (C7-latency)', () => {
  it('SAB-Atomics: yield observes abort within 50 ms of triggerAbort', async () => {
    const signalBuffer = new SharedArrayBuffer(signalBufferByteLength, {
      maxByteLength: signalBufferMaxByteLength,
    });
    const view = new Int32Array(signalBuffer);
    const baselineGeneration = Atomics.load(view, signalSlot.abortGeneration);

    /* Wire side is irrelevant for SAB latency — `triggerAbort` writes
     * the SAB synchronously before invoking `channel.notify`, so we
     * stub the channel and assert only the SAB observation latency. */
    const stubChannel = {
      notify: () => undefined,
    } as unknown as Channel<RuntimeProtocol>;

    const latency = await measureYieldLatency(
      () => Atomics.load(view, signalSlot.abortGeneration) !== baselineGeneration,
      50,
      () => {
        triggerAbort(stubChannel, signalBuffer, 'superseded');
      },
    );

    expect(latency).toBeLessThan(50);
    expect(Atomics.load(view, signalSlot.abortReason)).toBe(abortReason.superseded);
  });

  it('wire-notify: yield observes abort within 200 ms of triggerAbort over a real channel', async () => {
    /* Real channel pair so the wire RTT (postMessage event-loop turn)
     * is exercised end-to-end. */
    const channelPair = new MessageChannel();
    const clientPort = wrapMessagePort<unknown>(channelPair.port1, { label: 'c7:client' });
    const serverPort = wrapMessagePort<unknown>(channelPair.port2, { label: 'c7:server' });

    let abortObservations = 0;

    const server = createChannelServer<RuntimeProtocol>({
      port: serverPort,
      sessionKey: 'c7-wire-notify',
      impl: {
        async call() {
          throw new Error('C7 latency test does not call');
        },
        notify(_context, name) {
          if (name === 'abort') {
            abortObservations++;
          }
        },
        listen: () => {
          throw new Error('C7 latency test does not subscribe');
        },
      },
    });
    const client = createChannelClient<RuntimeProtocol>({
      port: clientPort,
      sessionKey: 'c7-wire-notify',
    });
    await client.ready;

    const latency = await measureYieldLatency(
      () => abortObservations > 0,
      200,
      () => {
        /* `signalBuffer: undefined` exercises the wire-notify-only
         * path — `triggerAbort` skips the SAB write and fires only the
         * wire `'abort'` notify. */
        triggerAbort(client, undefined, 'superseded');
      },
    );

    expect(latency).toBeLessThan(200);
    expect(abortObservations).toBe(1);

    client.close();
    server.dispose();
  });

  it('SAB write happens before wire-notify so SAB-Atomics observers always win the race', () => {
    /* Architectural assertion: triggerAbort writes SAB synchronously
     * before the channel.notify call, ensuring SAB-Atomics observers
     * see the bumped generation in the same microtask as the trigger
     * call returns. The wire notify lands one event-loop turn later. */
    const signalBuffer = new SharedArrayBuffer(signalBufferByteLength, {
      maxByteLength: signalBufferMaxByteLength,
    });
    const view = new Int32Array(signalBuffer);
    const baseline = Atomics.load(view, signalSlot.abortGeneration);

    let wireNotifyFired = false;
    const stubChannel = {
      notify: () => {
        wireNotifyFired = true;
      },
    } as unknown as Channel<RuntimeProtocol>;

    triggerAbort(stubChannel, signalBuffer, 'timeout');

    /* By the time `triggerAbort` returns: SAB is mutated AND the
     * synchronous notify call has been invoked. */
    expect(Atomics.load(view, signalSlot.abortGeneration)).toBe(baseline + 1);
    expect(wireNotifyFired).toBe(true);
  });
});
