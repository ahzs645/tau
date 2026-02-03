import { describe, expect, it } from 'vitest';
import { formatCurrency } from '#utils/currency.utils.js';

describe('formatCurrency', () => {
  describe('without options (default formatting)', () => {
    it('should format zero with 6 decimal places', () => {
      expect(formatCurrency(0)).toBe('0.000000');
    });

    it('should format integer values with 6 decimal places', () => {
      expect(formatCurrency(1)).toBe('1.000000');
      expect(formatCurrency(100)).toBe('100.000000');
    });

    it('should format decimal values with 6 decimal places', () => {
      expect(formatCurrency(1.5)).toBe('1.500000');
      expect(formatCurrency(0.123_456)).toBe('0.123456');
    });

    it('should truncate values beyond 6 decimal places', () => {
      expect(formatCurrency(0.123_456_7)).toBe('0.123457');
    });

    it('should format negative values', () => {
      expect(formatCurrency(-1.5)).toBe('-1.500000');
      expect(formatCurrency(-100)).toBe('-100.000000');
    });

    it('should format large values with thousand separators', () => {
      expect(formatCurrency(1000)).toBe('1,000.000000');
      expect(formatCurrency(1_000_000)).toBe('1,000,000.000000');
    });
  });

  describe('with significantFigures option', () => {
    it('should return "0.00 USD" for zero value', () => {
      expect(formatCurrency(0, { significantFigures: 3 })).toBe('0.00 USD');
    });

    it('should format with 3 significant figures', () => {
      expect(formatCurrency(1.2345, { significantFigures: 3 })).toBe('1.23');
      expect(formatCurrency(12.345, { significantFigures: 3 })).toBe('12.35');
      expect(formatCurrency(123.45, { significantFigures: 3 })).toBe('123.45');
    });

    it('should format small values with appropriate decimal places', () => {
      expect(formatCurrency(0.001_234, { significantFigures: 3 })).toBe('0.00123');
      expect(formatCurrency(0.000_123_4, { significantFigures: 3 })).toBe('0.000123');
    });

    it('should format values less than 1 with proper precision', () => {
      expect(formatCurrency(0.1234, { significantFigures: 3 })).toBe('0.123');
      expect(formatCurrency(0.5678, { significantFigures: 3 })).toBe('0.568');
    });

    it('should format with different significant figure counts', () => {
      expect(formatCurrency(1.234_56, { significantFigures: 2 })).toBe('1.23');
      // SF=4 gives dpForSf=3, but minDp=2 (default), so max(3,2)=3 decimal places
      expect(formatCurrency(1.234_56, { significantFigures: 4 })).toBe('1.235');
      // SF=5 gives dpForSf=4, so max(4,2)=4 decimal places
      expect(formatCurrency(1.234_56, { significantFigures: 5 })).toBe('1.2346');
    });

    it('should format negative values', () => {
      expect(formatCurrency(-1.234, { significantFigures: 3 })).toBe('-1.23');
      expect(formatCurrency(-0.001_234, { significantFigures: 3 })).toBe('-0.00123');
    });
  });

  describe('with minDecimalPlaces option', () => {
    it('should use minDecimalPlaces when it provides more precision than SF', () => {
      // Value 100 with SF=3 would need 0 decimal places, but minDp=4 forces 4
      expect(formatCurrency(100, { significantFigures: 3, minDecimalPlaces: 4 })).toBe('100.0000');
    });

    it('should use SF decimal places when it provides more precision than minDp', () => {
      // Value 0.001234 with SF=3 needs 5 decimal places, which is more than minDp=2
      expect(formatCurrency(0.001_234, { significantFigures: 3, minDecimalPlaces: 2 })).toBe('0.00123');
    });

    it('should default minDecimalPlaces to 2 when not specified', () => {
      // Value 100 with SF=3 would need 0 decimal places, but default minDp=2 forces 2
      expect(formatCurrency(100, { significantFigures: 3 })).toBe('100.00');
    });

    it('should respect custom minDecimalPlaces', () => {
      expect(formatCurrency(1, { significantFigures: 1, minDecimalPlaces: 3 })).toBe('1.000');
      expect(formatCurrency(10, { significantFigures: 2, minDecimalPlaces: 4 })).toBe('10.0000');
    });

    it('should cap decimal places at 6', () => {
      // Even with high SF and minDp, should not exceed 6 decimal places
      expect(formatCurrency(0.000_001_234, { significantFigures: 10, minDecimalPlaces: 10 })).toBe('0.000001');
    });
  });

  describe('edge cases', () => {
    it('should handle very small values', () => {
      expect(formatCurrency(0.000_001, { significantFigures: 3 })).toBe('0.000001');
    });

    it('should handle large values with thousand separators', () => {
      expect(formatCurrency(1234.56, { significantFigures: 4 })).toBe('1,234.56');
      expect(formatCurrency(1_000_000, { significantFigures: 3 })).toBe('1,000,000.00');
    });

    it('should handle values at boundary of precision', () => {
      // Calculation is based on original value's magnitude, not the rounded result
      // 0.999999: magnitude=-1, dpForSf=3, decimalPlaces=max(3,2)=3
      expect(formatCurrency(0.999_999, { significantFigures: 3 })).toBe('1.000');
      // 9.99999: magnitude=0, dpForSf=2, decimalPlaces=max(2,2)=2
      expect(formatCurrency(9.999_99, { significantFigures: 3 })).toBe('10.00');
    });
  });

  describe('real-world usage scenarios', () => {
    it('should format typical API costs', () => {
      // Typical LLM API costs
      expect(formatCurrency(0.0318, { significantFigures: 3, minDecimalPlaces: 3 })).toBe('0.0318');
      expect(formatCurrency(0.117, { significantFigures: 3, minDecimalPlaces: 3 })).toBe('0.117');
      expect(formatCurrency(0.0852, { significantFigures: 3, minDecimalPlaces: 3 })).toBe('0.0852');
    });

    it('should format costs for summary display', () => {
      expect(formatCurrency(1.23, { significantFigures: 3, minDecimalPlaces: 2 })).toBe('1.23');
      expect(formatCurrency(12.34, { significantFigures: 3, minDecimalPlaces: 2 })).toBe('12.34');
      expect(formatCurrency(123.45, { significantFigures: 3, minDecimalPlaces: 2 })).toBe('123.45');
    });
  });
});
