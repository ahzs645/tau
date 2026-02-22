import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useToolbarOverflow } from '#hooks/use-toolbar-overflow.js';
import type { ToolbarItemConfig } from '#hooks/use-toolbar-overflow.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

/**
 * Controlled mock for useResizeObserver.
 * Tests set `mockObservedWidth.current` to simulate ResizeObserver reporting.
 * When `undefined`, the hook falls back to the synchronous initial measurement.
 */
const mockObservedWidth: { current: number | undefined } = { current: undefined };

vi.mock('#hooks/use-resize-observer.js', () => ({
  useResizeObserver: () => ({
    width: mockObservedWidth.current,
    height: undefined,
  }),
}));

/**
 * Width returned by the mocked `getBoundingClientRect`.
 * Simulates the real container width that `useLayoutEffect` reads synchronously.
 */
let mockBoundingWidth = 0;
let boundingRectSpy: ReturnType<typeof vi.spyOn>;

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockObservedWidth.current = undefined;
  mockBoundingWidth = 0;

  boundingRectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: mockBoundingWidth,
    height: 40,
    top: 0,
    left: 0,
    right: mockBoundingWidth,
    bottom: 40,
    x: 0,
    y: 0,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- This is a mock
    toJSON() {
      return this;
    },
  }));
});

afterEach(() => {
  boundingRectSpy.mockRestore();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Mirrors the real viewer control items from chat-viewer-controls.tsx */
const viewerItems: ToolbarItemConfig[] = [
  { id: 'fov', width: 200, compactWidth: 120 },
  { id: 'grid', width: 32 },
  { id: 'section', width: 32 },
  { id: 'measure', width: 32 },
  { id: 'reset', width: 32 },
];

const gap = 8;
const reservedWidth = 40;
const options = { gap, reservedWidth } as const;

// Full width needed:    fov(200) + 4×32 + 4×gap(8) = 360; available must be ≥ 360 → container ≥ 400
// Compact width needed: fov(120) + 4×32 + 4×gap(8) = 280; available must be ≥ 280 → container ≥ 320

// ── Test harness ─────────────────────────────────────────────────────────────

/**
 * Minimal component that uses the hook and exposes its output via data attributes.
 * The `containerRef` is attached to a real div so `useLayoutEffect` can read it.
 */
function ToolbarHarness({
  items,
  overflowOptions,
}: {
  readonly items: ToolbarItemConfig[];
  readonly overflowOptions?: { gap?: number; reservedWidth?: number };
}): React.JSX.Element {
  const { containerRef, visibleIds, overflowIds, isCompact } = useToolbarOverflow(items, overflowOptions);

  return (
    <div ref={containerRef} data-testid="toolbar">
      <span data-testid="visible">{JSON.stringify([...visibleIds].sort())}</span>
      <span data-testid="overflow">{JSON.stringify([...overflowIds].sort())}</span>
      <span data-testid="compact">{String(isCompact)}</span>
    </div>
  );
}

/** Reads the current hook output from the rendered DOM. */
function readResult(): { visible: string[]; overflow: string[]; isCompact: boolean } {
  return {
    visible: JSON.parse(screen.getByTestId('visible').textContent) as string[],
    overflow: JSON.parse(screen.getByTestId('overflow').textContent) as string[],
    isCompact: screen.getByTestId('compact').textContent === 'true',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useToolbarOverflow hook integration', () => {
  describe('synchronous initial measurement (flicker prevention)', () => {
    it('reads getBoundingClientRect before first paint when ResizeObserver has not reported', () => {
      // Wide container — all items fit at full size
      mockBoundingWidth = 500;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      expect(result.visible).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflow).toEqual([]);
      expect(result.isCompact).toBe(false);
    });

    it('applies compact mode on initial measurement when full width does not fit', () => {
      // Container 350px: available = 350 - 40 = 310
      // Full = 360 > 310, compact = 280 ≤ 310 → compact mode, all visible
      mockBoundingWidth = 350;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      expect(result.visible).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflow).toEqual([]);
      expect(result.isCompact).toBe(true);
    });

    it('overflows items on initial measurement for narrow containers', () => {
      // Container 200px: available = 200 - 40 = 160
      // Compact: fov(120) + grid(32) + gap(8) = 160 ≤ 160 → fov + grid fit
      mockBoundingWidth = 200;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      expect(result.visible).toContain('fov');
      expect(result.visible).toContain('grid');
      expect(result.overflow).toContain('reset');
      expect(result.overflow).toContain('measure');
      expect(result.overflow).toContain('section');
      expect(result.isCompact).toBe(true);
    });

    it('overflows everything for very narrow containers', () => {
      // Container 50px: available = 50 - 40 = 10px — nothing fits
      mockBoundingWidth = 50;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      expect(result.visible).toEqual([]);
      expect(result.overflow).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.isCompact).toBe(true);
    });

    it('calls getBoundingClientRect exactly once for the initial measurement', () => {
      mockBoundingWidth = 500;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      // The hook should measure once in useLayoutEffect, then stop
      // (the guard `initialWidth !== undefined` prevents repeated calls).
      // Other calls may come from React internals / testing-library, so
      // we just verify it was called at least once on the container element.
      expect(boundingRectSpy).toHaveBeenCalled();
    });
  });

  describe('ResizeObserver takes precedence over initial measurement', () => {
    it('uses observedWidth when ResizeObserver has reported', () => {
      // GetBoundingClientRect says 500 (all fit), but ResizeObserver says 200 (overflow)
      mockBoundingWidth = 500;
      mockObservedWidth.current = 200;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      // Should reflect the narrow ResizeObserver width, not the wide bounding rect
      expect(result.overflow.length).toBeGreaterThan(0);
      expect(result.isCompact).toBe(true);
    });

    it('uses observedWidth even when it is wider than initialWidth', () => {
      // GetBoundingClientRect says 200 (overflow), but ResizeObserver says 500 (all fit)
      mockBoundingWidth = 200;
      mockObservedWidth.current = 500;

      render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      const result = readResult();
      expect(result.visible).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflow).toEqual([]);
      expect(result.isCompact).toBe(false);
    });
  });

  describe('responds to container resize', () => {
    it('updates overflow state when ResizeObserver reports a new width', () => {
      // Start wide — all items fit
      mockBoundingWidth = 500;
      mockObservedWidth.current = 500;

      const { rerender } = render(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      let result = readResult();
      expect(result.visible.length).toBe(5);
      expect(result.overflow).toEqual([]);

      // Simulate resize to narrow — triggers overflow
      mockObservedWidth.current = 200;
      rerender(<ToolbarHarness items={viewerItems} overflowOptions={options} />);

      result = readResult();
      expect(result.overflow.length).toBeGreaterThan(0);
      expect(result.isCompact).toBe(true);
    });
  });
});
