import { describe, expect, it } from 'vitest';
import { resolveGalleryParameters } from '#runtime/parameters.js';

describe('gallery parameter migration', () => {
  it('should apply existing flat OpenSCAD links to the current grouped customizer', () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- External Customizer group names retain their authored spelling.
    const defaults = { Dimensions: { width: 10, height: 20 }, Material: { hollow: false } };
    expect(resolveGalleryParameters(defaults, { width: 35, hollow: true })).toEqual({
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The migrated parameters must retain the authored Dimensions group.
      Dimensions: { width: 35, height: 20 },
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The migrated parameters must retain the authored Material group.
      Material: { hollow: true },
    });
    expect(defaults.Dimensions.width).toBe(10);
  });

  it('should restore removed overrides and retain untouched grouped defaults', () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Dimensions is an external Customizer group name.
    const defaults = { Dimensions: { width: 10, height: 20 }, label: 'Default' };
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Overrides address the authored Dimensions group without renaming it.
    const edited = resolveGalleryParameters(defaults, { Dimensions: { width: 35 }, label: 'Edited' });
    // eslint-disable-next-line @typescript-eslint/naming-convention -- The migrated parameters must retain the authored Dimensions group.
    expect(edited).toEqual({ Dimensions: { width: 35, height: 20 }, label: 'Edited' });
    expect(resolveGalleryParameters(defaults, {})).toEqual(defaults);
  });

  it('should preserve unknown or ambiguous fields so runtime validation can report them', () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- First and Second model the original external Customizer group names.
    expect(resolveGalleryParameters({ First: { size: 1 }, Second: { size: 2 } }, { size: 3, unknown: 4 })).toEqual({
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The ambiguous-field fixture must preserve the original First group.
      First: { size: 1 },
      // eslint-disable-next-line @typescript-eslint/naming-convention -- The ambiguous-field fixture must preserve the original Second group.
      Second: { size: 2 },
      size: 3,
      unknown: 4,
    });
  });
});
