// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import {
  KERNEL_MODULES_KEY,
  isRecordObject,
  getModuleRegistry,
  extractDefaultParameters,
  resolveToRelative,
  convertRawIssuesToKernelIssues,
  enrichIssueLocation,
  loadBinaryFile,
} from '#kernels/kernel-module-helpers.js';

describe('isRecordObject', () => {
  it('should return true for plain objects', () => {
    expect(isRecordObject({})).toBe(true);
    expect(isRecordObject({ a: 1 })).toBe(true);
  });

  it('should return false for arrays', () => {
    expect(isRecordObject([])).toBe(false);
    expect(isRecordObject([1, 2])).toBe(false);
  });

  it('should return false for null and primitives', () => {
    expect(isRecordObject(null)).toBe(false);
    expect(isRecordObject(undefined)).toBe(false);
    expect(isRecordObject(42)).toBe(false);
    expect(isRecordObject('string')).toBe(false);
  });
});

describe('getModuleRegistry', () => {
  it('should return a Map', () => {
    const registry = getModuleRegistry();
    expect(registry).toBeInstanceOf(Map);
  });

  it('should return the same instance on repeated calls', () => {
    const a = getModuleRegistry();
    const b = getModuleRegistry();
    expect(a).toBe(b);
  });

  it('should store the registry on globalThis', () => {
    const registry = getModuleRegistry();
    expect((globalThis as Record<string, unknown>)[KERNEL_MODULES_KEY]).toBe(registry);
  });
});

describe('extractDefaultParameters', () => {
  it('should extract defaultParams from a module', () => {
    const result = extractDefaultParameters({ defaultParams: { width: 10 } });
    expect(result).toEqual({ width: 10 });
  });

  it('should extract defaultParameters from a module', () => {
    const result = extractDefaultParameters({ defaultParameters: { height: 20 } });
    expect(result).toEqual({ height: 20 });
  });

  it('should prefer defaultParams over defaultParameters', () => {
    const result = extractDefaultParameters({
      defaultParams: { a: 1 },
      defaultParameters: { b: 2 },
    });
    expect(result).toEqual({ a: 1 });
  });

  it('should return empty object for non-record module', () => {
    expect(extractDefaultParameters(null)).toEqual({});
    expect(extractDefaultParameters(undefined)).toEqual({});
    expect(extractDefaultParameters(42)).toEqual({});
  });

  it('should return empty object when params are not a record', () => {
    expect(extractDefaultParameters({ defaultParams: 'not-a-record' })).toEqual({});
    expect(extractDefaultParameters({ defaultParams: [1, 2] })).toEqual({});
  });
});

describe('resolveToRelative', () => {
  it('should strip the base path prefix', () => {
    expect(resolveToRelative('/project/src/main.ts', '/project')).toBe('src/main.ts');
  });

  it('should handle base paths with trailing slash', () => {
    expect(resolveToRelative('/project/src/main.ts', '/project/')).toBe('src/main.ts');
  });

  it('should return original path when base does not match', () => {
    expect(resolveToRelative('/other/file.ts', '/project')).toBe('/other/file.ts');
  });

  it('should handle root base path', () => {
    expect(resolveToRelative('/file.ts', '/')).toBe('file.ts');
  });
});

describe('convertRawIssuesToKernelIssues', () => {
  it('should convert raw issues to KernelIssue with fallback location', () => {
    const raw = [{ message: 'syntax error', severity: 'error' }];
    const result = convertRawIssuesToKernelIssues(raw, 'main.ts');
    expect(result).toEqual([
      {
        message: 'syntax error',
        severity: 'error',
        type: 'runtime',
        location: { fileName: 'main.ts', startLineNumber: 1, startColumn: 1 },
      },
    ]);
  });

  it('should normalize warning severity', () => {
    const raw = [{ message: 'deprecated', severity: 'warning' }];
    const result = convertRawIssuesToKernelIssues(raw, 'main.ts');
    expect(result[0]!.severity).toBe('warning');
  });

  it('should preserve existing location', () => {
    const location = { fileName: 'other.ts', startLineNumber: 5, startColumn: 3 };
    const raw = [{ message: 'error', severity: 'error', location }];
    const result = convertRawIssuesToKernelIssues(raw, 'main.ts');
    expect(result[0]!.location).toEqual(location);
  });
});

describe('enrichIssueLocation', () => {
  it('should add fallback location when missing', () => {
    // oxlint-disable-next-line tau-lint/no-literal-const-assertion -- these are necessary
    const issues = [{ message: 'oops', type: 'runtime' as const, severity: 'error' as const }];
    const result = enrichIssueLocation(issues, 'fallback.ts');
    expect(result[0]!.location).toEqual({
      fileName: 'fallback.ts',
      startLineNumber: 1,
      startColumn: 1,
    });
  });

  it('should preserve existing location', () => {
    const location = { fileName: 'original.ts', startLineNumber: 10, startColumn: 5 };
    // oxlint-disable-next-line tau-lint/no-literal-const-assertion -- these are necessary
    const issues = [{ message: 'oops', type: 'runtime' as const, severity: 'error' as const, location }];
    const result = enrichIssueLocation(issues, 'fallback.ts');
    expect(result[0]!.location).toEqual(location);
  });
});

describe('loadBinaryFile', () => {
  it('should load a file via file: URL in Node.js', async () => {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const fontPath = resolve(join(currentDirectory, 'replicad', 'fonts', 'Geist-Regular.ttf'));
    const url = `file://${fontPath}`;
    const result = await loadBinaryFile(url);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result!.byteLength).toBeGreaterThan(0);
  });

  it('should return undefined for a non-existent file: URL', async () => {
    const result = await loadBinaryFile('file:///nonexistent/path/font.ttf');
    expect(result).toBeUndefined();
  });

  it('should return undefined for an unreachable HTTP URL', async () => {
    const result = await loadBinaryFile('http://127.0.0.1:1/nonexistent.ttf');
    expect(result).toBeUndefined();
  });
});
