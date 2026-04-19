/* eslint-disable @typescript-eslint/naming-convention -- assimp convention uses CONSTANT_CASE */
import { describe, it, expect } from 'vitest';
import { converterExportOptions } from '#transcoders/converter/converter-export-options.js';

describe('converter export options', () => {
  describe('3mf schema', () => {
    const { schema } = converterExportOptions['3mf'];

    it('should apply millimeter default when unit is omitted', () => {
      const result = schema.parse({});
      expect(result.unit).toBe('millimeter');
      expect(result.application).toBeUndefined();
    });

    it('should accept all valid unit values', () => {
      const units = ['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'] as const;

      for (const unit of units) {
        const result = schema.parse({ unit });
        expect(result.unit).toBe(unit);
      }
    });

    it('should reject invalid unit values', () => {
      expect(() => schema.parse({ unit: 'parsec' })).toThrow();
    });

    it('should accept an optional application string', () => {
      const result = schema.parse({ application: 'PrusaSlicer 2.8' });
      expect(result.application).toBe('PrusaSlicer 2.8');
    });

    it('should strip unknown keys', () => {
      const result = schema.parse({ unit: 'centimeter', unknown: 42 });
      expect(result).toEqual({ unit: 'centimeter' });
    });
  });

  describe('3mf toAssimpProperties transform', () => {
    const { toAssimpProperties } = converterExportOptions['3mf'];

    it('should map unit to 3MF_EXPORT_UNIT', () => {
      const result = toAssimpProperties.parse({ unit: 'centimeter' });
      expect(result).toEqual({ '3MF_EXPORT_UNIT': 'centimeter' });
    });

    it('should map application to 3MF_EXPORT_APPLICATION', () => {
      const result = toAssimpProperties.parse({ application: 'Cura 5.6' });
      expect(result).toEqual({
        '3MF_EXPORT_UNIT': 'millimeter',
        '3MF_EXPORT_APPLICATION': 'Cura 5.6',
      });
    });

    it('should apply millimeter default and omit absent optional keys', () => {
      const result = toAssimpProperties.parse({});
      expect(result).toEqual({ '3MF_EXPORT_UNIT': 'millimeter' });
    });

    it('should map both keys when both are provided', () => {
      const result = toAssimpProperties.parse({
        unit: 'inch',
        application: 'BambuStudio 1.9',
      });
      expect(result).toEqual({
        '3MF_EXPORT_UNIT': 'inch',
        '3MF_EXPORT_APPLICATION': 'BambuStudio 1.9',
      });
    });
  });
});
