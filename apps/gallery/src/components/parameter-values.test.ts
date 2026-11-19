import { describe, expect, it } from 'vitest';
import { mergeParameterChanges } from '#components/parameter-values.js';

describe('parameter field edits', () => {
  it('should retain another field changed after the form rendered', () => {
    expect(
      mergeParameterChanges(
        { width: 20, height: 30 },
        { base: { width: 10, height: 30 }, next: { width: 10, height: 40 } },
      ),
    ).toEqual({ width: 20, height: 40 });
  });
  it('should remove an override when its field resets and preserve unrelated overrides', () => {
    const current = { width: 20, height: 30 };
    expect(mergeParameterChanges(current, { base: { width: 20, height: 30 }, next: { height: 30 } })).toEqual({
      height: 30,
    });
    expect(current).toEqual({ width: 20, height: 30 });
  });
  it('should retain nested JSON parameter values without converting their types', () => {
    expect(
      mergeParameterChanges(
        { spec: { enabled: true, count: 2 } },
        { base: { spec: { enabled: true, count: 2 } }, next: { spec: { enabled: false, count: 3 } } },
      ),
    ).toEqual({ spec: { enabled: false, count: 3 } });
  });
  it('should preserve an independent edit within the same nested parameter group', () => {
    expect(
      mergeParameterChanges(
        { lower: { radius: 25, hole: 3 } },
        { base: { lower: { radius: 20, hole: 3 } }, next: { lower: { radius: 20, hole: 4 } } },
      ),
    ).toEqual({ lower: { radius: 25, hole: 4 } });
  });
  it('should replace array parameters atomically when their shape changes', () => {
    expect(
      mergeParameterChanges(
        { position: [1, 2, 3], scale: 2 },
        { base: { position: [1, 2, 3], scale: 1 }, next: { position: [4, 5], scale: 1 } },
      ),
    ).toEqual({ position: [4, 5], scale: 2 });
  });
});
