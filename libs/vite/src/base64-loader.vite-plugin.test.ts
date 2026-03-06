import { describe, it, expect, vi } from 'vitest';
import { base64Loader } from '#base64-loader.vite-plugin.js';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

const { readFileSync } = await import('node:fs').then((m) => m.default);
const mockReadFileSync = vi.mocked(readFileSync);

type TransformHook = (code: string, id: string) => { code: string; moduleType: string } | undefined;

const transform = base64Loader.transform as TransformHook;

describe('base64Loader', () => {
  it('should have correct name', () => {
    expect(base64Loader.name).toBe('base64-loader');
  });

  it('should skip files without ?base64 query', () => {
    const result = transform('', '/path/to/file.png');
    expect(result).toBeUndefined();
  });

  it('should skip files with a different query parameter', () => {
    const result = transform('', '/path/to/file.png?raw');
    expect(result).toBeUndefined();
  });

  it('should transform files with ?base64 query to base64 export', () => {
    const fileContent = Buffer.from('hello world');
    mockReadFileSync.mockReturnValue(fileContent as never);

    const result = transform('', '/path/to/file.png?base64');

    expect(mockReadFileSync).toHaveBeenCalledWith('/path/to/file.png');
    expect(result).toEqual({
      code: `export default '${fileContent.toString('base64')}';`,
      moduleType: 'js',
    });
  });

  it('should encode binary content correctly', () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    mockReadFileSync.mockReturnValue(binaryContent as never);

    const result = transform('', '/path/to/image.png?base64');

    expect(result?.code).toBe(`export default '${binaryContent.toString('base64')}';`);
  });

  it('should return moduleType js for rolldown compatibility', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('test') as never);

    const result = transform('', '/path/to/file.woff2?base64');

    expect(result?.moduleType).toBe('js');
  });

  it('should handle paths with no extension', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('data') as never);

    const result = transform('', '/path/to/Makefile?base64');

    expect(mockReadFileSync).toHaveBeenCalledWith('/path/to/Makefile');
    expect(result).toBeDefined();
  });

  it('should skip when path is empty after split', () => {
    const result = transform('', '?base64');
    expect(result).toBeUndefined();
  });
});
