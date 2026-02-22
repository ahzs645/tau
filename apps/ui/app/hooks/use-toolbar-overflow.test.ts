import { describe, expect, it } from 'vitest';
import { computeToolbarOverflow } from '#hooks/use-toolbar-overflow.js';
import type { ToolbarItemConfig } from '#hooks/use-toolbar-overflow.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

/** Mirrors the real control items from chat-viewer-controls.tsx */
const viewerControlItems: ToolbarItemConfig[] = [
  { id: 'fov', width: 200, compactWidth: 120 },
  { id: 'grid', width: 32 },
  { id: 'section', width: 32 },
  { id: 'measure', width: 32 },
  { id: 'reset', width: 32 },
];

/** Simple items with no compact widths */
const simpleItems: ToolbarItemConfig[] = [
  { id: 'a', width: 100 },
  { id: 'b', width: 100 },
  { id: 'c', width: 100 },
];

const defaultGap = 8;
const defaultReserved = 44;

// ── Helpers ──────────────────────────────────────────────────────────────────

function idsArray(set: Set<string>): string[] {
  return [...set].sort();
}

/**
 * Calculates the exact total width for a list of items.
 * Useful for constructing precise container widths in tests.
 */
function totalWidth(items: readonly ToolbarItemConfig[], compact: boolean, gap: number): number {
  if (items.length === 0) {
    return 0;
  }

  let total = 0;
  for (const item of items) {
    total += compact && item.compactWidth !== undefined ? item.compactWidth : item.width;
  }

  total += (items.length - 1) * gap;
  return total;
}

// ── Pre-measurement (containerWidth = undefined) ─────────────────────────────

describe('computeToolbarOverflow', () => {
  describe('before first measurement (containerWidth = undefined)', () => {
    it('shows all items as visible at full size', () => {
      const result = computeToolbarOverflow(viewerControlItems, undefined, defaultGap, defaultReserved);

      expect(idsArray(result.visibleIds)).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('handles empty items', () => {
      const result = computeToolbarOverflow([], undefined, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(0);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });
  });

  // ── Phase 1: All items fit at full width ─────────────────────────────────

  describe('phase 1: all items fit at full width', () => {
    it('shows everything visible and not compact when container is wide enough', () => {
      const fullWidth = totalWidth(viewerControlItems, false, defaultGap);
      const containerWidth = fullWidth + defaultReserved;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(idsArray(result.visibleIds)).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('fits when container has more than enough space', () => {
      const result = computeToolbarOverflow(viewerControlItems, 1000, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(5);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('fits items with no compact widths at full size', () => {
      // 3 items * 100px + 2 gaps * 8px = 316px needed + 44 reserved = 360
      const result = computeToolbarOverflow(simpleItems, 360, defaultGap, defaultReserved);

      expect(idsArray(result.visibleIds)).toEqual(['a', 'b', 'c']);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });
  });

  // ── Phase 2: All items fit in compact mode ───────────────────────────────

  describe('phase 2: all items fit in compact mode', () => {
    it('activates compact mode when full width does not fit but compact does', () => {
      const fullWidth = totalWidth(viewerControlItems, false, defaultGap);
      const compactWidth = totalWidth(viewerControlItems, true, defaultGap);

      // Container fits compact but not full
      const containerWidth = compactWidth + defaultReserved;
      // Verify our container is actually between compact and full
      expect(containerWidth - defaultReserved).toBeLessThan(fullWidth);

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(idsArray(result.visibleIds)).toEqual(['fov', 'grid', 'measure', 'reset', 'section']);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(true);
    });

    it('skips compact phase for items with no compactWidth (falls through to overflow)', () => {
      // `simpleItems` have no compactWidth, so compact === full.
      // If full doesn't fit, it goes straight to overflow phase.
      // 3 items * 100 + 2*8 = 316 full = 316 compact. Need < 316 available.
      const containerWidth = 300 + defaultReserved; // 300 < 316

      const result = computeToolbarOverflow(simpleItems, containerWidth, defaultGap, defaultReserved);

      // Should overflow 'c' (last item)
      expect(result.overflowIds.has('c')).toBe(true);
      expect(result.isCompact).toBe(true);
    });
  });

  // ── Phase 3: Overflow items from the end ─────────────────────────────────

  describe('phase 3: overflow items from the end', () => {
    it('overflows the last item first (lowest stickiness)', () => {
      const compactWidth = totalWidth(viewerControlItems, true, defaultGap);
      // Make it just too narrow for all compact items, so one must overflow
      const containerWidth = compactWidth + defaultReserved - 1;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.overflowIds.has('reset')).toBe(true);
      expect(result.visibleIds.has('reset')).toBe(false);
      expect(result.isCompact).toBe(true);
    });

    it('overflows multiple items right-to-left', () => {
      // Only enough space for fov(compact=120) + grid(32) + 1 gap(8) = 160
      const containerWidth = 160 + defaultReserved;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.has('fov')).toBe(true);
      expect(result.visibleIds.has('grid')).toBe(true);
      expect(result.overflowIds.has('section')).toBe(true);
      expect(result.overflowIds.has('measure')).toBe(true);
      expect(result.overflowIds.has('reset')).toBe(true);
      expect(result.isCompact).toBe(true);
    });

    it('preserves stickiness order — first item is last to overflow', () => {
      // Only enough space for fov compact (120px)
      const containerWidth = 120 + defaultReserved;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.has('fov')).toBe(true);
      expect(result.visibleIds.size).toBe(1);
      expect(result.overflowIds.size).toBe(4);
    });

    it('overflows everything when container is too narrow for even the first item', () => {
      const containerWidth = 50 + defaultReserved; // 50 < 120 compact fov

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(0);
      expect(result.overflowIds.size).toBe(5);
      expect(result.isCompact).toBe(true);
    });

    it('overflows everything with zero available width', () => {
      const result = computeToolbarOverflow(viewerControlItems, defaultReserved, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(0);
      expect(result.overflowIds.size).toBe(5);
      expect(result.isCompact).toBe(true);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty items list with a measured container', () => {
      const result = computeToolbarOverflow([], 500, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(0);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('handles a single item that fits', () => {
      const items: ToolbarItemConfig[] = [{ id: 'solo', width: 80 }];
      const containerWidth = 80 + defaultReserved;

      const result = computeToolbarOverflow(items, containerWidth, defaultGap, defaultReserved);

      expect(idsArray(result.visibleIds)).toEqual(['solo']);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('handles a single item that does not fit', () => {
      const items: ToolbarItemConfig[] = [{ id: 'solo', width: 80 }];
      const containerWidth = 79 + defaultReserved; // 1px too narrow

      const result = computeToolbarOverflow(items, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(0);
      expect(result.overflowIds.has('solo')).toBe(true);
    });

    it('handles zero gap', () => {
      // 3 items * 100 = 300 needed + 44 reserved = 344
      const result = computeToolbarOverflow(simpleItems, 344, 0, defaultReserved);

      expect(result.visibleIds.size).toBe(3);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('handles zero reserved width', () => {
      const fullWidth = totalWidth(simpleItems, false, defaultGap);
      const result = computeToolbarOverflow(simpleItems, fullWidth, defaultGap, 0);

      expect(result.visibleIds.size).toBe(3);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('handles exact boundary — full width exactly equals available', () => {
      const fullWidth = totalWidth(viewerControlItems, false, defaultGap);
      const containerWidth = fullWidth + defaultReserved;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(5);
      expect(result.isCompact).toBe(false);
    });

    it('handles exact boundary — 1px less than full triggers compact', () => {
      const fullWidth = totalWidth(viewerControlItems, false, defaultGap);
      const containerWidth = fullWidth + defaultReserved - 1;

      const result = computeToolbarOverflow(viewerControlItems, containerWidth, defaultGap, defaultReserved);

      expect(result.visibleIds.size).toBe(5);
      expect(result.isCompact).toBe(true);
    });
  });

  // ── Real-world scenario (viewer controls) ────────────────────────────────

  describe('real-world viewer controls scenario', () => {
    const items = viewerControlItems;
    const gap = 8;
    const reserved = 40; // Matches chat-viewer-controls.tsx

    it('wide desktop — all visible at full size', () => {
      const result = computeToolbarOverflow(items, 600, gap, reserved);

      expect(result.visibleIds.size).toBe(5);
      expect(result.overflowIds.size).toBe(0);
      expect(result.isCompact).toBe(false);
    });

    it('narrower width triggers compact FOV slider', () => {
      // Full: fov(200) + grid(32) + section(32) + measure(32) + reset(32) + 4*8 = 360
      // 360 + 40 = 400 needed. At 399 it should compact.
      const result = computeToolbarOverflow(items, 399, gap, reserved);

      expect(result.visibleIds.size).toBe(5);
      expect(result.isCompact).toBe(true);
    });

    it('very narrow width overflows least-sticky items first', () => {
      const result = computeToolbarOverflow(items, 250, gap, reserved);

      // FOV (most sticky) should still be visible
      expect(result.visibleIds.has('fov')).toBe(true);
      // Reset (least sticky) should be overflowed
      expect(result.overflowIds.has('reset')).toBe(true);
    });
  });
});
