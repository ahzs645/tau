import { describe, it, expect } from 'vitest';
import type { FileParameterConfig } from '@taucad/types';
import {
  parseParameterConfig,
  createDefaultConfig,
  getActiveSetValues,
  updateSetValues,
  createSet,
  deleteSet,
  switchActiveSet,
  serializeParameterConfig,
  validateParameterConfig,
} from '#utils/parameter-config.utils.js';

const createTestConfig = (): FileParameterConfig => ({
  version: 1,
  files: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
    'main.ts': {
      activeSet: 'default',
      sets: {
        default: { values: { width: 10, height: 20 } },
        small: { values: { width: 5, height: 10 } },
      },
    },
  },
});

describe('parameter-config.utils', () => {
  describe('parseParameterConfig', () => {
    it('should parse valid JSON with version 1', () => {
      const json = JSON.stringify(createTestConfig());
      const result = parseParameterConfig(json);
      expect(result.version).toBe(1);
      expect(result.files['main.ts']?.activeSet).toBe('default');
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseParameterConfig('{')).toThrow();
    });

    it('should throw on missing version', () => {
      expect(() => parseParameterConfig('{"files":{}}')).toThrow('Invalid parameter config');
    });

    it('should throw on unsupported version', () => {
      expect(() => parseParameterConfig('{"version":2,"files":{}}')).toThrow('Invalid parameter config');
    });
  });

  describe('createDefaultConfig', () => {
    it('should create config with single file and default set', () => {
      const config = createDefaultConfig('main.ts');
      expect(config.version).toBe(1);
      expect(Object.keys(config.files)).toEqual(['main.ts']);
      expect(config.files['main.ts']?.activeSet).toBe('default');
      expect(config.files['main.ts']?.sets['default']?.values).toEqual({});
    });
  });

  describe('getActiveSetValues', () => {
    it('should return values of the active set', () => {
      const config = createTestConfig();
      expect(getActiveSetValues(config, 'main.ts')).toEqual({
        width: 10,
        height: 20,
      });
    });

    it('should return empty object for unknown file', () => {
      const config = createTestConfig();
      expect(getActiveSetValues(config, 'unknown.ts')).toEqual({});
    });

    it('should return empty object when active set is missing', () => {
      const config: FileParameterConfig = {
        version: 1,
        files: {
          // eslint-disable-next-line @typescript-eslint/naming-convention -- file path key
          'main.ts': {
            activeSet: 'nonexistent',
            sets: {},
          },
        },
      };
      expect(getActiveSetValues(config, 'main.ts')).toEqual({});
    });
  });

  describe('updateSetValues', () => {
    it('should update existing set values immutably', () => {
      const original = createTestConfig();
      const updated = updateSetValues(original, {
        filePath: 'main.ts',
        setName: 'default',
        values: {
          width: 99,
        },
      });

      expect(updated.files['main.ts']?.sets['default']?.values).toEqual({
        width: 99,
      });
      // Original unchanged
      expect(original.files['main.ts']?.sets['default']?.values).toEqual({
        width: 10,
        height: 20,
      });
    });

    it('should create file entry if it does not exist', () => {
      const original = createTestConfig();
      const updated = updateSetValues(original, {
        filePath: 'box.ts',
        setName: 'default',
        values: {
          size: 5,
        },
      });

      expect(updated.files['box.ts']?.activeSet).toBe('default');
      expect(updated.files['box.ts']?.sets['default']?.values).toEqual({
        size: 5,
      });
      expect(original.files['box.ts']).toBeUndefined();
    });

    it('should not mutate the original config', () => {
      const original = createTestConfig();
      const updated = updateSetValues(original, {
        filePath: 'main.ts',
        setName: 'default',
        values: {
          width: 99,
        },
      });

      expect(updated).not.toBe(original);
      expect(updated.files).not.toBe(original.files);
      expect(updated.files['main.ts']).not.toBe(original.files['main.ts']);
    });
  });

  describe('createSet', () => {
    it('should create a new set with provided values', () => {
      const config = createTestConfig();
      const updated = createSet(config, {
        filePath: 'main.ts',
        setName: 'large',
        values: {
          width: 100,
          height: 200,
        },
      });

      expect(updated.files['main.ts']?.sets['large']?.values).toEqual({
        width: 100,
        height: 200,
      });
    });

    it('should create a new set with empty values by default', () => {
      const config = createTestConfig();
      const updated = createSet(config, { filePath: 'main.ts', setName: 'empty' });

      expect(updated.files['main.ts']?.sets['empty']?.values).toEqual({});
    });

    it('should throw if set already exists', () => {
      const config = createTestConfig();
      expect(() => createSet(config, { filePath: 'main.ts', setName: 'default' })).toThrow('already exists');
    });
  });

  describe('deleteSet', () => {
    it('should delete a non-active set', () => {
      const config = createTestConfig();
      const updated = deleteSet(config, 'main.ts', 'small');

      expect(updated.files['main.ts']?.sets['small']).toBeUndefined();
      expect(updated.files['main.ts']?.sets['default']).toBeDefined();
    });

    it('should throw when deleting the active set', () => {
      const config = createTestConfig();
      expect(() => deleteSet(config, 'main.ts', 'default')).toThrow('Cannot delete the active');
    });

    it('should throw when set does not exist', () => {
      const config = createTestConfig();
      expect(() => deleteSet(config, 'main.ts', 'nonexistent')).toThrow('does not exist');
    });

    it('should not mutate the original config', () => {
      const original = createTestConfig();
      deleteSet(original, 'main.ts', 'small');
      expect(original.files['main.ts']?.sets['small']).toBeDefined();
    });
  });

  describe('switchActiveSet', () => {
    it('should switch the active set', () => {
      const config = createTestConfig();
      const updated = switchActiveSet(config, 'main.ts', 'small');

      expect(updated.files['main.ts']?.activeSet).toBe('small');
    });

    it('should throw when target set does not exist', () => {
      const config = createTestConfig();
      expect(() => switchActiveSet(config, 'main.ts', 'nonexistent')).toThrow('does not exist');
    });

    it('should not mutate the original config', () => {
      const original = createTestConfig();
      switchActiveSet(original, 'main.ts', 'small');
      expect(original.files['main.ts']?.activeSet).toBe('default');
    });
  });

  describe('validateParameterConfig', () => {
    it('should pass for a valid config', () => {
      expect(() => {
        validateParameterConfig(createTestConfig());
      }).not.toThrow();
    });

    it('should throw on undefined', () => {
      expect(() => {
        validateParameterConfig(undefined);
      }).toThrow('expected a non-null object');
    });

    it('should throw on null', () => {
      expect(() => {
        validateParameterConfig(null);
      }).toThrow('expected a non-null object');
    });

    it('should throw on non-object', () => {
      expect(() => {
        validateParameterConfig('string');
      }).toThrow('expected a non-null object');
    });

    it('should throw on missing version', () => {
      expect(() => {
        validateParameterConfig({ files: {} });
      }).toThrow('missing or unsupported version');
    });

    it('should throw on wrong version', () => {
      expect(() => {
        validateParameterConfig({ version: 2, files: {} });
      }).toThrow('missing or unsupported version');
    });

    it('should throw on missing files', () => {
      expect(() => {
        validateParameterConfig({ version: 1 });
      }).toThrow('missing or invalid files object');
    });

    it('should throw on null files', () => {
      expect(() => {
        validateParameterConfig({ version: 1, files: null });
      }).toThrow('missing or invalid files object');
    });
  });

  describe('serializeParameterConfig', () => {
    it('should produce valid JSON that round-trips through parse', () => {
      const config = createTestConfig();
      const json = serializeParameterConfig(config);
      const parsed = parseParameterConfig(json);

      expect(parsed).toEqual(config);
    });

    it('should produce formatted JSON with indentation', () => {
      const config = createDefaultConfig('main.ts');
      const json = serializeParameterConfig(config);

      expect(json).toContain('\n');
      expect(json).toContain('  ');
    });

    it('should throw on undefined input', () => {
      expect(() => serializeParameterConfig(undefined as unknown as FileParameterConfig)).toThrow(
        'expected a non-null object',
      );
    });

    it('should throw on null input', () => {
      expect(() => serializeParameterConfig(null as unknown as FileParameterConfig)).toThrow(
        'expected a non-null object',
      );
    });

    it('should throw on config missing version', () => {
      expect(() => serializeParameterConfig({ files: {} } as unknown as FileParameterConfig)).toThrow(
        'missing or unsupported version',
      );
    });

    it('should throw on config missing files', () => {
      expect(() => serializeParameterConfig({ version: 1 } as unknown as FileParameterConfig)).toThrow(
        'missing or invalid files object',
      );
    });

    it('should preserve all file entries when one CU is reset to empty values', () => {
      const config = updateSetValues(createTestConfig(), {
        filePath: 'second.ts',
        setName: 'default',
        values: { size: 5 },
      });
      const reset = updateSetValues(config, { filePath: 'second.ts', setName: 'default', values: {} });
      const json = serializeParameterConfig(reset);
      const parsed = parseParameterConfig(json);

      expect(parsed.files['main.ts']?.sets['default']?.values).toEqual({ width: 10, height: 20 });
      expect(parsed.files['second.ts']?.sets['default']?.values).toEqual({});
    });
  });
});
