import { describe, it, expect, beforeEach } from 'vitest';
import { setAbortContext, clearAbortContext, checkAbort } from '#framework/cooperative-abort.js';
import { RenderAbortedError } from '#framework/runtime-worker-client.js';
import { signalSlot } from '#types/runtime-protocol.types.js';
import { signalBufferByteLength } from '#framework/runtime-framework.constants.js';

describe('cooperative-abort', () => {
  let sab: SharedArrayBuffer;
  let view: Int32Array;

  beforeEach(() => {
    clearAbortContext();
    sab = new SharedArrayBuffer(signalBufferByteLength);
    view = new Int32Array(sab);
  });

  it('should throw RenderAbortedError when abort generation changes', () => {
    Atomics.store(view, signalSlot.abortGeneration, 1);
    setAbortContext(view, 1);

    Atomics.store(view, signalSlot.abortGeneration, 2);

    expect(() => {
      checkAbort();
    }).toThrow(RenderAbortedError);
  });

  it('should not throw when generation matches', () => {
    Atomics.store(view, signalSlot.abortGeneration, 5);
    setAbortContext(view, 5);

    expect(() => {
      checkAbort();
    }).not.toThrow();
  });

  it('should be a no-op after clearAbortContext', () => {
    Atomics.store(view, signalSlot.abortGeneration, 1);
    setAbortContext(view, 1);

    Atomics.store(view, signalSlot.abortGeneration, 2);
    clearAbortContext();

    expect(() => {
      checkAbort();
    }).not.toThrow();
  });
});
