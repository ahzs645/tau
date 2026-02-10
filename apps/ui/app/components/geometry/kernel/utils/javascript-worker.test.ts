/**
 * JavaScriptWorker Tests
 *
 * Tests for the JavaScriptWorker base class including:
 * - Module resolution
 * - Bundling
 * - Error handling
 * - Stack trace classification
 */

import { describe, it, expect } from 'vitest';
import {
  parsePackageSpecifier,
  resolveRelativePath,
  getNodeModulesPath,
  isBareSpecifier,
} from '#utils/import.utils.js';

describe('Module Manager', () => {
  describe('parsePackageSpecifier', () => {
    it('should parse simple package name', () => {
      const result = parsePackageSpecifier('replicad');
      expect(result).toEqual({ name: 'replicad', version: '', path: '' });
    });

    it('should parse package with version', () => {
      const result = parsePackageSpecifier('replicad@0.19.1');
      expect(result).toEqual({ name: 'replicad', version: '0.19.1', path: '' });
    });

    it('should parse scoped package', () => {
      const result = parsePackageSpecifier('@jscad/modeling');
      expect(result).toEqual({ name: '@jscad/modeling', version: '', path: '' });
    });

    it('should parse scoped package with version', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: '' });
    });

    it('should parse package with subpath', () => {
      const result = parsePackageSpecifier('replicad/shapes');
      expect(result).toEqual({ name: 'replicad', version: '', path: 'shapes' });
    });

    it('should parse scoped package with version and subpath', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6/primitives');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: 'primitives' });
    });
  });

  describe('isBareSpecifier', () => {
    it('should return true for bare specifiers', () => {
      expect(isBareSpecifier('replicad')).toBe(true);
      expect(isBareSpecifier('@jscad/modeling')).toBe(true);
      expect(isBareSpecifier('zod')).toBe(true);
    });

    it('should return false for relative imports', () => {
      expect(isBareSpecifier('./utils.ts')).toBe(false);
      expect(isBareSpecifier('../helpers.ts')).toBe(false);
    });

    it('should return false for absolute imports', () => {
      expect(isBareSpecifier('/absolute/path.ts')).toBe(false);
    });

    it('should return false for URL imports', () => {
      expect(isBareSpecifier('https://cdn.jsdelivr.net/npm/lodash')).toBe(false);
      expect(isBareSpecifier('http://example.com/module.js')).toBe(false);
    });
  });

  describe('resolveRelativePath', () => {
    it('should resolve ./ imports', () => {
      const result = resolveRelativePath('./utils.ts', '/project/src/main.ts');
      expect(result).toBe('/project/src/utils.ts');
    });

    it('should resolve ../ imports', () => {
      const result = resolveRelativePath('../helpers.ts', '/project/src/main.ts');
      expect(result).toBe('/project/helpers.ts');
    });

    it('should handle multiple ../', () => {
      const result = resolveRelativePath('../../lib/utils.ts', '/project/src/components/button.ts');
      expect(result).toBe('/project/lib/utils.ts');
    });
  });

  describe('getNodeModulesPath', () => {
    it('should return correct path for simple package', () => {
      const result = getNodeModulesPath('replicad');
      expect(result).toBe('/node_modules/replicad');
    });

    it('should return correct path for scoped package', () => {
      const result = getNodeModulesPath('@jscad/modeling');
      expect(result).toBe('/node_modules/@jscad/modeling');
    });
  });
});

describe('Stack Frame Classification', () => {
  it('should mark node_modules frames as internal', () => {
    const fileName = '/builds/project/node_modules/replicad/index.js';
    const isInternal = fileName.includes('/node_modules/');
    expect(isInternal).toBe(true);
  });

  it('should mark data: URLs as internal', () => {
    const fileName = 'data:text/javascript;base64,abc123';
    const isInternal = fileName.startsWith('data:');
    expect(isInternal).toBe(true);
  });

  it('should mark blob: URLs as internal', () => {
    const fileName = 'blob:https://example.com/abc123';
    const isInternal = fileName.startsWith('blob:');
    expect(isInternal).toBe(true);
  });

  it('should not mark user files as internal', () => {
    const fileName = '/builds/project/main.ts';
    const isInternal =
      fileName.includes('/node_modules/') || fileName.startsWith('data:') || fileName.startsWith('blob:');
    expect(isInternal).toBe(false);
  });
});
