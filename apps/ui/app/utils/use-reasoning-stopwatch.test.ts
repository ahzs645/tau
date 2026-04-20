import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReasoningStopwatch } from '#utils/use-reasoning-stopwatch.js';

describe('useReasoningStopwatch', () => {
  describe('defensive cases', () => {
    it('should return 0 when startedAtMs is undefined', () => {
      const { result } = renderHook(() => useReasoningStopwatch(undefined, true));

      expect(result.current).toBe(0);
    });

    it('should return 0 when startedAtMs is undefined even while enabled is false', () => {
      const { result } = renderHook(() => useReasoningStopwatch(undefined, false));

      expect(result.current).toBe(0);
    });
  });

  describe('initial value (server-time anchor, no client-arrival skew compensation)', () => {
    it('should return Date.now() - startedAtMs on first render', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:05Z'));
        const startedAtMs = Date.now() - 5000;

        const { result } = renderHook(() => useReasoningStopwatch(startedAtMs, true));

        expect(result.current).toBe(5000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clamp negative differences to 0 when startedAtMs > Date.now() (clock skew)', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now() + 10_000;

        const { result } = renderHook(() => useReasoningStopwatch(startedAtMs, true));

        expect(result.current).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('1Hz ticking', () => {
    it('should advance the returned value by ~1000ms after one fake-timer tick when enabled', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        const { result } = renderHook(() => useReasoningStopwatch(startedAtMs, true));
        expect(result.current).toBe(0);

        act(() => {
          vi.advanceTimersByTime(1000);
        });

        expect(result.current).toBe(1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should keep ticking at 1Hz across multiple intervals', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        const { result } = renderHook(() => useReasoningStopwatch(startedAtMs, true));

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(result.current).toBe(1000);

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(result.current).toBe(2000);

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(result.current).toBe(3000);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('disabled state', () => {
    it('should not advance the returned value when enabled is false', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        const { result } = renderHook(() => useReasoningStopwatch(startedAtMs, false));
        const initial = result.current;

        act(() => {
          vi.advanceTimersByTime(5000);
        });

        expect(result.current).toBe(initial);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not register a setInterval when enabled is false', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();
        const intervalsBefore = setIntervalSpy.mock.calls.length;

        renderHook(() => useReasoningStopwatch(startedAtMs, false));

        expect(setIntervalSpy.mock.calls.length).toBe(intervalsBefore);
      } finally {
        setIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('cleanup', () => {
    it('should clear the interval on unmount', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const { unmount } = renderHook(() => useReasoningStopwatch(Date.now(), true));
        const clearsBefore = clearIntervalSpy.mock.calls.length;

        unmount();

        expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBefore);

        // No state-on-unmounted-component warnings should fire after unmount.
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
      } finally {
        clearIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should clear the interval and stop advancing when enabled flips true → false', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        const { result, rerender } = renderHook(
          ({ enabled }: { enabled: boolean }) => useReasoningStopwatch(startedAtMs, enabled),
          { initialProps: { enabled: true } },
        );

        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(result.current).toBe(2000);

        const clearsBefore = clearIntervalSpy.mock.calls.length;
        rerender({ enabled: false });
        expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBefore);

        act(() => {
          vi.advanceTimersByTime(5000);
        });
        expect(result.current).toBe(2000);
      } finally {
        clearIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should re-arm a single interval when enabled flips false → true', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const startedAtMs = Date.now();

        const { result, rerender } = renderHook(
          ({ enabled }: { enabled: boolean }) => useReasoningStopwatch(startedAtMs, enabled),
          { initialProps: { enabled: false } },
        );
        const intervalsBefore = setIntervalSpy.mock.calls.length;

        rerender({ enabled: true });

        expect(setIntervalSpy.mock.calls.length).toBe(intervalsBefore + 1);

        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(result.current).toBe(1000);
      } finally {
        setIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('should re-anchor without tearing down the interval when only startedAtMs changes', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      try {
        vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
        const initialStartedAt = Date.now();

        const { result, rerender } = renderHook(
          ({ startedAtMs }: { startedAtMs: number }) => useReasoningStopwatch(startedAtMs, true),
          { initialProps: { startedAtMs: initialStartedAt } },
        );

        const clearsBefore = clearIntervalSpy.mock.calls.length;
        const newStartedAt = initialStartedAt - 4000;
        rerender({ startedAtMs: newStartedAt });

        // Interval is keyed on `enabled`, not on `startedAtMs`, so it should
        // not be torn down purely because the anchor moved.
        expect(clearIntervalSpy.mock.calls.length).toBe(clearsBefore);
        expect(result.current).toBe(4000);
      } finally {
        clearIntervalSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});
