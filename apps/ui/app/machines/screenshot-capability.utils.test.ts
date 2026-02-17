import { describe, expect, it } from 'vitest';
import { calculateOptimalGrid } from '#machines/screenshot-capability.machine.js';

describe('calculateOptimalGrid', () => {
  describe('edge cases', () => {
    it('should return { columns: 1, rows: 1 } for 0 items', () => {
      const result = calculateOptimalGrid(0);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });

    it('should return { columns: 1, rows: 1 } for negative item count', () => {
      const result = calculateOptimalGrid(-5);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });

    it('should return { columns: 1, rows: 1 } for 1 item', () => {
      const result = calculateOptimalGrid(1);
      expect(result).toEqual({ columns: 1, rows: 1 });
    });
  });

  describe('default 3:2 preferred ratio', () => {
    it('should return { columns: 2, rows: 1 } for 2 items', () => {
      const result = calculateOptimalGrid(2);
      expect(result).toEqual({ columns: 2, rows: 1 });
    });

    it('should return { columns: 2, rows: 2 } for 3 items (2/2=1.0 closest to 1.5)', () => {
      // 3/1=3.0 (diff 1.5), 2/2=1.0 (diff 0.5) -- 2x2 wins
      const result = calculateOptimalGrid(3);
      expect(result).toEqual({ columns: 2, rows: 2 });
    });

    it('should return { columns: 3, rows: 2 } for 4 items (perfect 1.5 ratio)', () => {
      // 4/1=4.0 (diff 2.5), 2/2=1.0 (diff 0.5), 3/2=1.5 (diff 0) -- 3x2 wins
      const result = calculateOptimalGrid(4);
      expect(result).toEqual({ columns: 3, rows: 2 });
    });

    it('should return a valid layout for 5 items', () => {
      const result = calculateOptimalGrid(5);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(5);
    });

    it('should return { columns: 3, rows: 2 } for 6 items (perfect 3:2 match)', () => {
      const result = calculateOptimalGrid(6);
      expect(result).toEqual({ columns: 3, rows: 2 });
    });

    it('should return a valid layout for 7 items', () => {
      const result = calculateOptimalGrid(7);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(7);
    });

    it('should return a valid layout for 8 items', () => {
      const result = calculateOptimalGrid(8);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(8);
    });

    it('should return { columns: 4, rows: 3 } for 9 items (4/3=1.33 closest to 1.5)', () => {
      // 3/3=1.0 (diff 0.5), 4/3=1.33 (diff 0.17), 5/2=2.5 (diff 1.0) -- 4x3 wins
      const result = calculateOptimalGrid(9);
      expect(result).toEqual({ columns: 4, rows: 3 });
    });

    it('should return a valid layout for 12 items', () => {
      const result = calculateOptimalGrid(12);
      expect(result.columns * result.rows).toBeGreaterThanOrEqual(12);
      // 4x3 = 12, ratio 4/3 = 1.33, close to 3/2 = 1.5
      // 3x4 = 12, ratio 3/4 = 0.75, further from 1.5
      // 6x2 = 12, ratio 6/2 = 3.0, further from 1.5
      expect(result.columns).toBeGreaterThanOrEqual(result.rows);
    });
  });

  describe('custom preferred ratio', () => {
    it('should prefer square layouts with 1:1 ratio', () => {
      const result = calculateOptimalGrid(4, { columns: 1, rows: 1 });
      expect(result).toEqual({ columns: 2, rows: 2 });
    });

    it('should prefer wide layouts with 4:1 ratio', () => {
      const result = calculateOptimalGrid(8, { columns: 4, rows: 1 });
      // 8x1 = ratio 8, 4x2 = ratio 2, etc. -- 4x2 is closest to 4
      expect(result.columns).toBeGreaterThan(result.rows);
    });

    it('should prefer tall layouts with 1:3 ratio', () => {
      const result = calculateOptimalGrid(6, { columns: 1, rows: 3 });
      // Target ratio = 1/3 ≈ 0.33
      // 1x6 = 0.167, 2x3 = 0.667, 3x2 = 1.5, 6x1 = 6
      // Closest to 0.33 is 1x6 (0.167) or 2x3 (0.667)
      expect(result.rows).toBeGreaterThanOrEqual(result.columns);
    });
  });

  describe('capacity guarantee', () => {
    it('should always return a grid that can fit all items', () => {
      for (let count = 1; count <= 20; count++) {
        const result = calculateOptimalGrid(count);
        expect(result.columns * result.rows).toBeGreaterThanOrEqual(count);
      }
    });

    it('should always return positive columns and rows', () => {
      for (let count = 0; count <= 20; count++) {
        const result = calculateOptimalGrid(count);
        expect(result.columns).toBeGreaterThanOrEqual(1);
        expect(result.rows).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('consistency', () => {
    it('should return the same result for the same inputs', () => {
      const result1 = calculateOptimalGrid(6);
      const result2 = calculateOptimalGrid(6);
      expect(result1).toEqual(result2);
    });

    it('should return the same result with explicit default ratio', () => {
      const withDefault = calculateOptimalGrid(6);
      const withExplicit = calculateOptimalGrid(6, { columns: 3, rows: 2 });
      expect(withDefault).toEqual(withExplicit);
    });
  });
});
