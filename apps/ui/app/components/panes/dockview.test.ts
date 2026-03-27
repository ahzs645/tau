import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { scrollActiveTabIntoView } from '#components/panes/dockview.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Tracks root elements appended to `document.body` for cleanup. */
const roots: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots) {
    root.remove();
  }

  roots.length = 0;
});

type TabLayout = {
  offsetLeft: number;
  width: number;
  isActive?: boolean;
};

type ContainerLayout = {
  scrollLeft: number;
  clientWidth: number;
};

/**
 * Builds a mock `DockviewApi` with a group element containing a
 * `.dv-tabs-container` and `.dv-tab` children with configurable layout.
 */
function buildApi(options: {
  tabs?: TabLayout[];
  container?: ContainerLayout;
  omitGroup?: boolean;
  omitTabsContainer?: boolean;
}): { api: DockviewApi; tabsContainer: HTMLElement | undefined } {
  const {
    tabs = [],
    container = { scrollLeft: 0, clientWidth: 300 },
    omitGroup = false,
    omitTabsContainer = false,
  } = options;

  if (omitGroup) {
    const api = { activeGroup: undefined } as unknown as DockviewApi;
    return { api, tabsContainer: undefined };
  }

  const groupElement = document.createElement('div');
  document.body.append(groupElement);
  roots.push(groupElement);

  let tabsContainer: HTMLElement | undefined;

  if (!omitTabsContainer) {
    tabsContainer = document.createElement('div');
    tabsContainer.classList.add('dv-tabs-container');

    Object.defineProperty(tabsContainer, 'scrollLeft', {
      value: container.scrollLeft,
      writable: true,
    });
    Object.defineProperty(tabsContainer, 'clientWidth', {
      value: container.clientWidth,
    });

    for (const tab of tabs) {
      const tabElement = document.createElement('div');
      tabElement.classList.add('dv-tab');
      if (tab.isActive) {
        tabElement.classList.add('dv-active-tab');
      }

      Object.defineProperty(tabElement, 'offsetLeft', { value: tab.offsetLeft });
      Object.defineProperty(tabElement, 'offsetWidth', { value: tab.width });

      tabsContainer.append(tabElement);
    }

    groupElement.append(tabsContainer);
  }

  const api = {
    activeGroup: { element: groupElement },
  } as unknown as DockviewApi;

  return { api, tabsContainer };
}

/** Flushes the `requestAnimationFrame` callback queued by `scrollActiveTabIntoView`. */
function flushRaf(): void {
  vi.advanceTimersByTime(16);
}

// ── scrollActiveTabIntoView ──────────────────────────────────────────────────

describe('scrollActiveTabIntoView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Bail-out conditions ──

  describe('bail-out conditions', () => {
    it('should not throw when no active group exists', () => {
      const { api } = buildApi({ omitGroup: true });

      scrollActiveTabIntoView(api);
      flushRaf();
    });

    it('should not throw when tabs container is missing', () => {
      const { api } = buildApi({ omitTabsContainer: true });

      scrollActiveTabIntoView(api);
      flushRaf();
    });

    it('should not throw when no active tab exists', () => {
      const { api } = buildApi({
        tabs: [{ offsetLeft: 0, width: 100, isActive: false }],
      });

      scrollActiveTabIntoView(api);
      flushRaf();
    });
  });

  // ── No-op when fully visible ──

  describe('no-op when fully visible', () => {
    it('should not scroll when the active tab is fully visible', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: false },
          { offsetLeft: 100, width: 100, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      expect(tabsContainer!.scrollLeft).toBe(0);
    });

    it('should not scroll when the active tab is at the right edge but still fully visible', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: false },
          { offsetLeft: 100, width: 100, isActive: false },
          { offsetLeft: 200, width: 100, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      expect(tabsContainer!.scrollLeft).toBe(0);
    });
  });

  // ── Scroll right ──

  describe('scroll right', () => {
    it('should scroll right when the active tab is clipped on the right', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: false },
          { offsetLeft: 100, width: 100, isActive: false },
          { offsetLeft: 200, width: 100, isActive: false },
          { offsetLeft: 300, width: 120, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab right edge (300 + 120 = 420) - clientWidth (300) = 120
      expect(tabsContainer!.scrollLeft).toBe(120);
    });

    it('should scroll to show the rightmost edge of the tab at the container edge', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 200, isActive: false },
          { offsetLeft: 200, width: 200, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab right edge (200 + 200 = 400) - clientWidth (300) = 100
      expect(tabsContainer!.scrollLeft).toBe(100);
    });
  });

  // ── Scroll left ──

  describe('scroll left', () => {
    it('should scroll left when the active tab is clipped on the left', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: true },
          { offsetLeft: 100, width: 100, isActive: false },
          { offsetLeft: 200, width: 100, isActive: false },
        ],
        container: { scrollLeft: 50, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      expect(tabsContainer!.scrollLeft).toBe(0);
    });

    it('should scroll left to the tab position when scrolled past the tab', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: false },
          { offsetLeft: 100, width: 100, isActive: true },
          { offsetLeft: 200, width: 100, isActive: false },
        ],
        container: { scrollLeft: 200, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      expect(tabsContainer!.scrollLeft).toBe(100);
    });
  });

  // ── Full-tab visibility ──

  describe('full-tab visibility', () => {
    it('should prefer the left edge when the tab is wider than the container and clipped right', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 100, isActive: false },
          { offsetLeft: 100, width: 400, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab at [100, 500] doesn't fit in 300px container.
      // Left edge alignment: scrollLeft = 100
      expect(tabsContainer!.scrollLeft).toBe(100);
    });

    it('should prefer the left edge when a very wide tab is clipped right', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [{ offsetLeft: 50, width: 1000, isActive: true }],
        container: { scrollLeft: 0, clientWidth: 200 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab at [50, 1050] much wider than 200px container.
      // Left edge alignment: scrollLeft = 50
      expect(tabsContainer!.scrollLeft).toBe(50);
    });

    it('should show the entire tab when it fits and is clipped right', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [
          { offsetLeft: 0, width: 250, isActive: false },
          { offsetLeft: 250, width: 100, isActive: true },
        ],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab at [250, 350] fits in 300px container.
      // Right edge alignment: scrollLeft = 350 - 300 = 50
      expect(tabsContainer!.scrollLeft).toBe(50);
    });

    it('should prefer the left edge when the tab is wider than the container and clipped left', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [{ offsetLeft: 0, width: 500, isActive: true }],
        container: { scrollLeft: 100, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);
      flushRaf();

      // Tab at [0, 500] wider than 300px container, left edge clipped.
      // Left edge alignment: scrollLeft = 0
      expect(tabsContainer!.scrollLeft).toBe(0);
    });
  });

  // ── requestAnimationFrame deferral ──

  describe('requestAnimationFrame deferral', () => {
    it('should not execute scroll logic synchronously', () => {
      const { api, tabsContainer } = buildApi({
        tabs: [{ offsetLeft: 300, width: 120, isActive: true }],
        container: { scrollLeft: 0, clientWidth: 300 },
      });

      scrollActiveTabIntoView(api);

      // Before rAF fires, scrollLeft should be unchanged
      expect(tabsContainer!.scrollLeft).toBe(0);

      flushRaf();

      // After rAF fires, scrollLeft should be corrected
      expect(tabsContainer!.scrollLeft).toBe(120);
    });
  });
});
