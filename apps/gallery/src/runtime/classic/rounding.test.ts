import { describe, expect, it } from 'vitest';
import { roundClassicOffCoordinate } from '#runtime/classic/rounding.js';

// Independently recorded from pinned OpenSCAD 1.2.0's paired native OFF/ASCII export.
// These include the immediately adjacent IEEE doubles around halfway values and decimal powers.
const nativeSamples = [
  [100.06249999999999, 100.062],
  [100.0625, 100.062],
  [100.06250000000001, 100.063],
  [100.18749999999999, 100.187],
  [100.1875, 100.188],
  [100.18750000000001, 100.188],
  [0.10000049999999999, 0.1],
  [0.1000005, 0.100001],
  [0.10000050000000002, 0.100001],
  [999_999.4999999999, 999_999],
  [999_999.5, 1_000_000],
  [999_999.5000000001, 1_000_000],
  [0.09999999999999999, 0.1],
  [0.1, 0.1],
  [0.10000000000000002, 0.1],
  [9.999999999999998e-8, 1e-7],
  [1e-7, 1e-7],
  [1.0000000000000001e-7, 1e-7],
  [999_999.9999999999, 1_000_000],
  [1_000_000, 1_000_000],
  [1_000_000.0000000001, 1_000_000],
] as const;

describe('classic OFF native decimal rounding', () => {
  it.each(nativeSamples)('should match both signs of native coordinate %s rounded to %s', (value, expected) => {
    expect(roundClassicOffCoordinate(value)).toBe(expected);
    expect(roundClassicOffCoordinate(-value)).toBe(-expected);
  });

  it('should preserve zero and reject nonfinite coordinates', () => {
    expect(roundClassicOffCoordinate(0)).toBe(0);
    expect(roundClassicOffCoordinate(-0)).toBe(-0);
    expect(() => roundClassicOffCoordinate(Number.NaN)).toThrow('finite');
    expect(() => roundClassicOffCoordinate(Number.POSITIVE_INFINITY)).toThrow('finite');
    expect(() => roundClassicOffCoordinate(Number.NEGATIVE_INFINITY)).toThrow('finite');
  });
});
