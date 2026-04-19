import { describe, expect, it } from 'vitest';
import { snapToStep } from '#components/geometry/parameters/parameters-number-field.js';

describe('snapToStep', () => {
  it('should snap 0.299 to 0.3 with step 0.01', () => {
    expect(snapToStep(0.299, 0.01)).toBe(0.3);
  });

  it('should snap 0.1 + 0.2 result to 0.3 with step 0.1', () => {
    const imprecise = 0.1 + 0.2; // 0.30000000000000004
    expect(snapToStep(imprecise, 0.1)).toBe(0.3);
  });

  it('should snap to integer steps without precision loss', () => {
    expect(snapToStep(7.6, 1)).toBe(8);
    expect(snapToStep(7.4, 1)).toBe(7);
    expect(snapToStep(15, 5)).toBe(15);
    expect(snapToStep(17, 5)).toBe(15);
    expect(snapToStep(18, 5)).toBe(20);
  });

  it('should anchor snapping to min when min is non-zero', () => {
    expect(snapToStep(0.16, 0.1, 0.05)).toBe(0.15);
    expect(snapToStep(0.21, 0.1, 0.05)).toBe(0.25);
    expect(snapToStep(0.3, 0.1, 0.05)).toBe(0.35);
  });

  it('should return value unchanged when step is 0', () => {
    expect(snapToStep(0.123_456, 0)).toBe(0.123_456);
  });

  it('should return value unchanged when step is negative', () => {
    expect(snapToStep(0.5, -1)).toBe(0.5);
  });

  it('should handle negative values correctly', () => {
    expect(snapToStep(-0.299, 0.01)).toBe(-0.3);
    expect(snapToStep(-7.6, 1)).toBe(-8);
    expect(snapToStep(-17, 5)).toBe(-15);
  });

  it('should handle very small fractional steps', () => {
    expect(snapToStep(0.0029, 0.001)).toBe(0.003);
    expect(snapToStep(1.0006, 0.001)).toBe(1.001);
    expect(snapToStep(0.0126, 0.001)).toBe(0.013);
  });
});
