import { describe, expect, it } from 'vitest';
import { resolveGalleryParameters } from '#runtime/parameters.js';

describe('gallery parameter migration', () => {
  it('should apply existing flat OpenSCAD links to the current grouped customizer', () => {
    const defaults = { Dimensions: { width: 10, height: 20 }, Material: { hollow: false } };
    expect(resolveGalleryParameters(defaults, { width: 35, hollow: true })).toEqual({
      Dimensions: { width: 35, height: 20 },
      Material: { hollow: true },
    });
    expect(defaults.Dimensions.width).toBe(10);
  });

  it('should restore removed overrides and retain untouched grouped defaults', () => {
    const defaults = { Dimensions: { width: 10, height: 20 }, label: 'Default' };
    const edited = resolveGalleryParameters(defaults, { Dimensions: { width: 35 }, label: 'Edited' });
    expect(edited).toEqual({ Dimensions: { width: 35, height: 20 }, label: 'Edited' });
    expect(resolveGalleryParameters(defaults, {})).toEqual(defaults);
  });

  it('should preserve unknown or ambiguous fields so runtime validation can report them', () => {
    expect(resolveGalleryParameters({ First: { size: 1 }, Second: { size: 2 } }, { size: 3, unknown: 4 })).toEqual({
      First: { size: 1 },
      Second: { size: 2 },
      size: 3,
      unknown: 4,
    });
  });
});
