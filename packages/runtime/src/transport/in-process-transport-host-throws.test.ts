/**
 * R3 — passthrough transports do not synthesise a `.host` accessor on the
 * consumer callable (`inProcessTransport({...})` → `{@link TransportPlugin}`).
 * Same-isolate kernel runs use {@link inProcessClient} only.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { inProcessTransport } from '#transport/in-process-transport.js';

describe('inProcessTransport — no synthesized host accessor (R3)', () => {
  it('callable exposes no `.host` property', () => {
    expect(typeof inProcessTransport).toBe('function');
    expect(Object.hasOwn(inProcessTransport, 'host')).toBe(false);
    expect('host' in inProcessTransport).toBe(false);
  });
});
