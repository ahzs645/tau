/**
 * Type-level conformance tests for {@link PortCapabilities} and the
 * `readonly capabilities: PortCapabilities` field carried by every
 * {@link Port}<T>` adapter (R21, F15).
 *
 * The capability surface is the contract every transport adapter declares
 * up-front so the channel layer can route binary delivery through the
 * `pool → transfer → copy` ladder and cancellation through the
 * `signalSlot + wire` fast-path without branching on transport-class
 * string checks. Adding/removing a tier requires editing exactly one type
 * and watching this file flip, then walking the resulting fan-out.
 */
import { describe, it } from 'vitest';
import type { Port, PortCapabilities } from '#index.js';

describe('PortCapabilities — capability-tier vocabulary (R21, F15)', () => {
  it('is structurally identical to the four-tier readonly-optional record', () => {
    type Expected = {
      readonly sab?: boolean;
      readonly signalSlot?: boolean;
      readonly transfer?: boolean;
      readonly pool?: boolean;
    };
    const fromCanonical: Expected = undefined as unknown as PortCapabilities;
    const fromExpected: PortCapabilities = undefined as unknown as Expected;
    void fromCanonical;
    void fromExpected;
  });

  it('admits `{}` as a no-tier adapter (BroadcastChannel-like)', () => {
    const empty: PortCapabilities = {};
    void empty;
  });

  it('admits a `worker_threads`-shaped capability set', () => {
    const wt: PortCapabilities = { sab: true, signalSlot: true, transfer: true };
    void wt;
  });

  it('admits a `MessagePort`-shaped capability set', () => {
    const mp: PortCapabilities = { transfer: true };
    void mp;
  });

  it('admits a pool-capable adapter (declared after pool construction in `lh` payload)', () => {
    const pooled: PortCapabilities = {
      sab: true,
      signalSlot: true,
      transfer: true,
      pool: true,
    };
    void pooled;
  });
});

describe('Port<T>.capabilities — required structural field (R21)', () => {
  it('exposes `capabilities` typed as PortCapabilities', () => {
    type Caps = Port<unknown>['capabilities'];
    const fromPort: PortCapabilities = undefined as unknown as Caps;
    const fromCaps: Caps = undefined as unknown as PortCapabilities;
    void fromPort;
    void fromCaps;
  });

  it('has `capabilities` listed in the structural keyset', () => {
    type Required = 'capabilities' extends keyof Port<unknown> ? true : false;
    const isRequired: true = undefined as unknown as Required;
    void isRequired;
  });
});
