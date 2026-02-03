/**
 * Format a number as a currency string, uses USD as the currency.
 *
 * Displays at least 2 decimal places by default.
 *
 * @param value - The number to format
 * @param options - Formatting options
 * @param options.significantFigures - Number of significant figures to display (if provided, overrides default formatting)
 * @param options.minDecimalPlaces - Minimum decimal places to display (default: 2)
 * @returns A formatted currency string
 */
export const formatCurrency = (
  value: number,
  options?: { significantFigures?: number; minDecimalPlaces?: number },
): string => {
  if (options?.significantFigures) {
    if (value === 0) {
      return '0.00 USD';
    }

    const sf = options.significantFigures;
    const minDp = options.minDecimalPlaces ?? 2;

    // Calculate how many decimal places we need for the significant figures
    const absValue = Math.abs(value);
    const magnitude = Math.floor(Math.log10(absValue));
    const dpForSf = Math.max(0, sf - 1 - magnitude);

    // Use whichever gives more precision: SF or minimum DP
    const decimalPlaces = Math.max(dpForSf, minDp);

    return value.toLocaleString('en-US', {
      style: 'decimal',
      minimumFractionDigits: Math.min(decimalPlaces, 6),
      maximumFractionDigits: Math.min(decimalPlaces, 6),
    });
  }

  return value.toLocaleString('en-US', {
    style: 'decimal',
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
};
