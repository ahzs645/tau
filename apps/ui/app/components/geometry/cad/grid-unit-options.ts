import type { LengthSymbol } from '@taucad/units';
import { standardInternationalBaseUnits } from '@taucad/units/constants';
import { toTitleCase } from '#utils/string.utils.js';

/**
 * Maximum digits for formatting grid size values in engineering notation.
 */
export const maxGridDigits = 3;

/**
 * Ordered list of supported grid unit symbols for the unit selector.
 */
export const gridUnitOrder = ['mm', 'cm', 'm', 'in', 'ft', 'yd'] as const;

/**
 * Grid unit options derived from SI base units, suitable for rendering in a unit selector.
 */
export const gridUnitOptions = gridUnitOrder.map((symbol) => {
  if (symbol === standardInternationalBaseUnits.length.symbol) {
    return {
      label: toTitleCase(standardInternationalBaseUnits.length.unit),
      value: symbol as LengthSymbol,
    };
  }

  const variant = standardInternationalBaseUnits.length.variants.find((v) => v.symbol === symbol);
  return {
    label: variant ? toTitleCase(variant.unit) : symbol,
    value: symbol as LengthSymbol,
  };
});
