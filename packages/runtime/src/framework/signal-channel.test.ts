/**
 * Tests the SAB signal-channel layout: cooperative-abort generation and
 * reason slots only. Worker state and progress flow through `postMessage`.
 */

import { describe, expect, it } from 'vitest';

import { signalSlot } from '#types/runtime-protocol.types.js';
import { signalBufferByteLength, signalBufferMaxByteLength } from '#framework/runtime-framework.constants.js';

describe('signal channel layout', () => {
  it('should expose only abortGeneration and abortReason slots', () => {
    const slotKeys = Object.keys(signalSlot).sort();
    expect(slotKeys).toEqual(['abortGeneration', 'abortReason']);
  });

  it('should size signal buffer to 8 bytes (2 Int32 slots)', () => {
    expect(signalBufferByteLength).toBe(8);
  });

  it('should keep growable buffer max byte length within a small bounded headroom', () => {
    expect(signalBufferMaxByteLength).toBeGreaterThanOrEqual(signalBufferByteLength);
    expect(signalBufferMaxByteLength).toBeLessThanOrEqual(32);
  });

  it('should assign unique non-overlapping Int32 indices to every slot', () => {
    const indices = Object.values(signalSlot);
    expect(new Set(indices).size).toBe(indices.length);
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(signalBufferByteLength / 4);
    }
  });
});
