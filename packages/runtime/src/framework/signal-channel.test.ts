import { describe, it, expect, beforeEach } from 'vitest';
import { signalSlot, workerStateEnum, workerStateNames } from '#types/runtime-protocol.types.js';

describe('SharedArrayBuffer signal channel', () => {
  let signalBuffer: SharedArrayBuffer;
  let signalView: Int32Array;

  beforeEach(() => {
    signalBuffer = new SharedArrayBuffer(16);
    signalView = new Int32Array(signalBuffer);
  });

  describe('signalSlot layout', () => {
    it('should have 4 defined slots', () => {
      expect(signalSlot.abortGeneration).toBe(0);
      expect(signalSlot.workerState).toBe(1);
      expect(signalSlot.progressPercent).toBe(2);
      expect(signalSlot.renderPhase).toBe(3);
    });

    it('should fit within the 16-byte buffer (4 Int32 slots)', () => {
      expect(signalView.length).toBe(4);
    });
  });

  describe('workerStateEnum enum', () => {
    it('should have correct integer values', () => {
      expect(workerStateEnum.idle).toBe(0);
      expect(workerStateEnum.rendering).toBe(1);
      expect(workerStateEnum.error).toBe(2);
      expect(workerStateEnum.buffering).toBe(3);
    });
  });

  describe('workerStateNames mapping', () => {
    it('should map integer states to string names', () => {
      expect(workerStateNames[workerStateEnum.idle]).toBe('idle');
      expect(workerStateNames[workerStateEnum.rendering]).toBe('rendering');
      expect(workerStateNames[workerStateEnum.error]).toBe('error');
      expect(workerStateNames[workerStateEnum.buffering]).toBe('buffering');
    });
  });

  describe('abort generation (main -> worker)', () => {
    it('should store and load abort generation atomically', () => {
      const generation = 7;
      Atomics.store(signalView, signalSlot.abortGeneration, generation);
      expect(Atomics.load(signalView, signalSlot.abortGeneration)).toBe(generation);
    });

    it('should reflect incremental generation bumps', () => {
      for (let i = 0; i < 10; i++) {
        Atomics.store(signalView, signalSlot.abortGeneration, i);
        expect(Atomics.load(signalView, signalSlot.abortGeneration)).toBe(i);
      }
    });
  });

  describe('worker state (worker -> main)', () => {
    it('should store and load worker state atomically', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.rendering);
    });

    it('should support state transitions idle -> rendering -> idle', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.idle);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.rendering);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.idle);
    });

    it('should support error state', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.error);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.error);
    });

    it('should support idle -> buffering -> rendering -> idle transitions', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.idle);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.buffering);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.buffering);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.rendering);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.idle);
    });

    it('should resolve state name from integer value', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      const stateInt = Atomics.load(signalView, signalSlot.workerState);
      const stateName = workerStateNames[stateInt];
      expect(stateName).toBeDefined();
      expect(stateName).toBe('rendering');
    });
  });

  describe('progress percent (worker -> main, polled)', () => {
    it('should store and load progress values', () => {
      Atomics.store(signalView, signalSlot.progressPercent, 50);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(50);
    });

    it('should handle 0-100 range', () => {
      Atomics.store(signalView, signalSlot.progressPercent, 0);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(0);

      Atomics.store(signalView, signalSlot.progressPercent, 100);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(100);
    });
  });

  describe('GrowableSharedArrayBuffer', () => {
    it('should allocate with maxByteLength for future expansion', () => {
      const growableBuffer = new SharedArrayBuffer(16, { maxByteLength: 64 });
      expect(growableBuffer.byteLength).toBe(16);
    });

    it('should be usable as Int32Array', () => {
      const growableBuffer = new SharedArrayBuffer(16, { maxByteLength: 64 });
      const view = new Int32Array(growableBuffer);
      expect(view.length).toBe(4);

      Atomics.store(view, 0, 123);
      expect(Atomics.load(view, 0)).toBe(123);
    });
  });

  describe('Atomics.notify / Atomics.waitAsync', () => {
    it('should notify without errors when no waiters exist', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      const wokenCount = Atomics.notify(signalView, signalSlot.workerState);
      expect(wokenCount).toBe(0);
    });

    it('should support Atomics.waitAsync if available', () => {
      if (typeof Atomics.waitAsync !== 'function') {
        // Environment doesn't support Atomics.waitAsync, skip
        return;
      }

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);

      const waitResult = Atomics.waitAsync(signalView, signalSlot.workerState, workerStateEnum.idle);
      expect(waitResult).toBeDefined();
      expect(waitResult.async).toBe(true);

      // Trigger the waiter
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      Atomics.notify(signalView, signalSlot.workerState);
    });
  });
});
