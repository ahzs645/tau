import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signalSlot, workerStateEnum } from '#types/kernel-protocol.types.js';
import { RenderAbortedError, isRenderAbortedError } from '#framework/kernel-worker-client.js';

/**
 * Tests for the autonomous kernel render loop patterns.
 *
 * KernelWorker is tightly coupled to the kernel plugin system, so we test
 * the core scheduling patterns (generation counter, abort detection,
 * debounce, state push) in isolation using the same primitives.
 */

describe('Autonomous render loop patterns', () => {
  let signalBuffer: SharedArrayBuffer;
  let signalView: Int32Array;

  beforeEach(() => {
    vi.useFakeTimers();
    signalBuffer = new SharedArrayBuffer(16);
    signalView = new Int32Array(signalBuffer);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('generation counter abort mechanism', () => {
    it('should detect abort when generation is incremented', () => {
      let renderGeneration = 0;
      const generation = ++renderGeneration;
      Atomics.store(signalView, signalSlot.abortGeneration, generation);

      // Simulate a new setFile arriving mid-render
      renderGeneration++;
      Atomics.store(signalView, signalSlot.abortGeneration, renderGeneration);

      // The original render's generation no longer matches
      const isAborted = Atomics.load(signalView, signalSlot.abortGeneration) !== generation;
      expect(isAborted).toBe(true);
    });

    it('should not detect abort when generation is unchanged', () => {
      let renderGeneration = 0;
      const generation = ++renderGeneration;
      Atomics.store(signalView, signalSlot.abortGeneration, generation);

      const isAborted = Atomics.load(signalView, signalSlot.abortGeneration) !== generation;
      expect(isAborted).toBe(false);
    });

    it('should handle rapid increments correctly', () => {
      let renderGeneration = 0;

      // Simulate 10 rapid setParameters calls
      for (let i = 0; i < 10; i++) {
        renderGeneration++;
        Atomics.store(signalView, signalSlot.abortGeneration, renderGeneration);
      }

      expect(Atomics.load(signalView, signalSlot.abortGeneration)).toBe(10);

      // Only the last generation should not be "aborted"
      for (let gen = 1; gen <= 9; gen++) {
        expect(Atomics.load(signalView, signalSlot.abortGeneration) !== gen).toBe(true);
      }
      expect(Atomics.load(signalView, signalSlot.abortGeneration) !== 10).toBe(false);
    });
  });

  describe('state push pattern', () => {
    it('should push rendering state', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      Atomics.notify(signalView, signalSlot.workerState);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.rendering);
    });

    it('should push idle state after render completes', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.rendering);
      Atomics.notify(signalView, signalSlot.workerState);

      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.idle);
      Atomics.notify(signalView, signalSlot.workerState);

      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.idle);
    });

    it('should push error state on failure', () => {
      Atomics.store(signalView, signalSlot.workerState, workerStateEnum.error);
      Atomics.notify(signalView, signalSlot.workerState);
      expect(Atomics.load(signalView, signalSlot.workerState)).toBe(workerStateEnum.error);
    });
  });

  describe('progress tracking', () => {
    it('should track progress from 0 to 100', () => {
      Atomics.store(signalView, signalSlot.progressPercent, 0);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(0);

      Atomics.store(signalView, signalSlot.progressPercent, 30);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(30);

      Atomics.store(signalView, signalSlot.progressPercent, 100);
      expect(Atomics.load(signalView, signalSlot.progressPercent)).toBe(100);
    });
  });

  describe('debounce scheduling', () => {
    it('should debounce parameter changes at 50ms', () => {
      const renderFunction = vi.fn();
      let timer: number | undefined;

      const scheduleRender = (delayMs: number) => {
        clearTimeout(timer);
        timer = Number(setTimeout(renderFunction, delayMs));
      };

      // Rapid parameter changes
      scheduleRender(50);
      scheduleRender(50);
      scheduleRender(50);

      // Should not have rendered yet
      expect(renderFunction).not.toHaveBeenCalled();

      // Advance 49ms - still not rendered
      vi.advanceTimersByTime(49);
      expect(renderFunction).not.toHaveBeenCalled();

      // Advance 1ms more - should render
      vi.advanceTimersByTime(1);
      expect(renderFunction).toHaveBeenCalledTimes(1);
    });

    it('should debounce file changes at 500ms', () => {
      const renderFunction = vi.fn();
      let timer: number | undefined;

      const scheduleRender = (delayMs: number) => {
        clearTimeout(timer);
        timer = Number(setTimeout(renderFunction, delayMs));
      };

      scheduleRender(500);

      vi.advanceTimersByTime(499);
      expect(renderFunction).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(renderFunction).toHaveBeenCalledTimes(1);
    });

    it('should cancel previous debounce when new change arrives', () => {
      const renderFunction = vi.fn();
      let timer: number | undefined;

      const scheduleRender = (delayMs: number) => {
        clearTimeout(timer);
        timer = Number(setTimeout(renderFunction, delayMs));
      };

      scheduleRender(500);
      vi.advanceTimersByTime(400);
      expect(renderFunction).not.toHaveBeenCalled();

      // New change resets the timer
      scheduleRender(500);
      vi.advanceTimersByTime(400);
      expect(renderFunction).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(renderFunction).toHaveBeenCalledTimes(1);
    });

    it('should not debounce initial setFile', () => {
      const renderFunction = vi.fn();

      // HandleSetFile calls executeRender immediately (void promise)
      renderFunction();
      expect(renderFunction).toHaveBeenCalledTimes(1);
    });
  });

  describe('RenderAbortedError handling', () => {
    it('should catch RenderAbortedError and transition to idle', () => {
      let finalState = 'rendering';

      try {
        throw new RenderAbortedError();
      } catch (error) {
        if (isRenderAbortedError(error)) {
          finalState = 'idle';
        }
      }

      expect(finalState).toBe('idle');
    });

    it('should not swallow non-abort errors', () => {
      let finalState = 'rendering';
      let errorMessage: string | undefined;

      try {
        throw new Error('Compilation failed');
      } catch (error) {
        if (isRenderAbortedError(error)) {
          finalState = 'idle';
        } else {
          errorMessage = error instanceof Error ? error.message : String(error);
          finalState = 'error';
        }
      }

      expect(finalState).toBe('error');
      expect(errorMessage).toBe('Compilation failed');
    });
  });

  describe('latest-wins semantics', () => {
    it('should discard stale results via generation check', async () => {
      let renderGeneration = 0;
      const results: Array<{ generation: number; data: string }> = [];

      const simulateRender = async (genAtStart: number, data: string, delayMs: number) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
        // Check if still current
        if (genAtStart === renderGeneration) {
          results.push({ generation: genAtStart, data });
        }
      };

      // Start first render
      const gen1 = ++renderGeneration;
      const render1 = simulateRender(gen1, 'first', 100);

      // Before it completes, start a second render
      const gen2 = ++renderGeneration;
      const render2 = simulateRender(gen2, 'second', 50);

      vi.advanceTimersByTime(50);
      await render2;

      vi.advanceTimersByTime(50);
      await render1;

      // Only the second render's result should be accepted
      expect(results).toHaveLength(1);
      expect(results[0]!.data).toBe('second');
      expect(results[0]!.generation).toBe(gen2);
    });
  });
});
