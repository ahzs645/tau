import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useBlockBrowserNavigation } from '#hooks/use-block-browser-navigation.js';

// ── Spies ─────────────────────────────────────────────────────────────────────

let pushStateSpy: ReturnType<typeof vi.spyOn>;
let backSpy: ReturnType<typeof vi.spyOn>;
let addEventSpy: ReturnType<typeof vi.spyOn>;
let removeEventSpy: ReturnType<typeof vi.spyOn>;

let currentState: unknown = null;

beforeEach(() => {
  currentState = null;

  pushStateSpy = vi.spyOn(history, 'pushState').mockImplementation((state: unknown) => {
    currentState = state;
  });

  backSpy = vi.spyOn(history, 'back').mockImplementation(() => {
    currentState = null;
  });

  addEventSpy = vi.spyOn(globalThis, 'addEventListener');
  removeEventSpy = vi.spyOn(globalThis, 'removeEventListener');

  Object.defineProperty(history, 'state', {
    get: () => currentState,
    configurable: true,
  });
});

afterEach(() => {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
  pushStateSpy.mockRestore();
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
  backSpy.mockRestore();
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
  addEventSpy.mockRestore();
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
  removeEventSpy.mockRestore();

  Object.defineProperty(history, 'state', {
    value: null,
    writable: true,
    configurable: true,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function dispatchPopState(): void {
  globalThis.dispatchEvent(new PopStateEvent('popstate'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useBlockBrowserNavigation', () => {
  describe('mount', () => {
    it('should push a sentinel history entry on mount', () => {
      renderHook(() => {
        useBlockBrowserNavigation();
      });

      expect(pushStateSpy).toHaveBeenCalledOnce();
      expect(pushStateSpy).toHaveBeenCalledWith('navigation-blocked', '');
    });

    it('should register a popstate event listener', () => {
      renderHook(() => {
        useBlockBrowserNavigation();
      });

      expect(addEventSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    });
  });

  describe('popstate interception', () => {
    it('should re-push the sentinel state when a popstate event fires', () => {
      renderHook(() => {
        useBlockBrowserNavigation();
      });
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
      pushStateSpy.mockClear();

      dispatchPopState();

      expect(pushStateSpy).toHaveBeenCalledOnce();
      expect(pushStateSpy).toHaveBeenCalledWith('navigation-blocked', '');
    });

    it('should re-push on every popstate event', () => {
      renderHook(() => {
        useBlockBrowserNavigation();
      });
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
      pushStateSpy.mockClear();

      dispatchPopState();
      dispatchPopState();
      dispatchPopState();

      expect(pushStateSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('unmount', () => {
    it('should remove the popstate event listener', () => {
      const { unmount } = renderHook(() => {
        useBlockBrowserNavigation();
      });

      unmount();

      expect(removeEventSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    });

    it('should call history.back() to pop the sentinel entry when state matches', () => {
      const { unmount } = renderHook(() => {
        useBlockBrowserNavigation();
      });

      unmount();

      expect(backSpy).toHaveBeenCalledOnce();
    });

    it('should not call history.back() when state no longer matches the sentinel', () => {
      const { unmount } = renderHook(() => {
        useBlockBrowserNavigation();
      });

      currentState = 'something-else';
      unmount();

      expect(backSpy).not.toHaveBeenCalled();
    });

    it('should not respond to popstate events after unmount', () => {
      const { unmount } = renderHook(() => {
        useBlockBrowserNavigation();
      });

      unmount();
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-call -- vitest spy mock type gap
      pushStateSpy.mockClear();

      dispatchPopState();

      expect(pushStateSpy).not.toHaveBeenCalled();
    });
  });

  describe('effect stability', () => {
    it('should only run the effect once across rerenders', () => {
      const { rerender } = renderHook(() => {
        useBlockBrowserNavigation();
      });

      rerender();
      rerender();

      expect(pushStateSpy).toHaveBeenCalledOnce();
    });
  });
});
