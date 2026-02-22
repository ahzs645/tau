/* eslint-disable @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names throughout */
import { describe, it, expect } from 'vitest';
import { fromMemoryFS } from '#client/filesystem-constructors.js';
import { getDirectoryContents, readFiles, batchExists } from '#framework/filesystem-helpers.js';

describe('filesystem-helpers', () => {
  describe('getDirectoryContents', () => {
    it('should return file contents from a flat directory', async () => {
      const fs = fromMemoryFS({
        '/project/a.ts': 'const a = 1;',
        '/project/b.ts': 'const b = 2;',
      });

      const contents = await getDirectoryContents(fs, '/project');
      expect(Object.keys(contents)).toHaveLength(2);
      expect(new TextDecoder().decode(contents['a.ts'])).toBe('const a = 1;');
      expect(new TextDecoder().decode(contents['b.ts'])).toBe('const b = 2;');
    });

    it('should skip subdirectories and only return files', async () => {
      const fs = fromMemoryFS({
        '/root/file.txt': 'hello',
        '/root/sub/nested.txt': 'nested',
      });

      const contents = await getDirectoryContents(fs, '/root');
      expect(Object.keys(contents)).toEqual(['file.txt']);
      expect(new TextDecoder().decode(contents['file.txt'])).toBe('hello');
    });

    it('should handle directories created by mkdir alongside files', async () => {
      const fs = fromMemoryFS({
        '/dir/readme.md': '# Hello',
      });
      await fs.mkdir('/dir/subdir');

      const contents = await getDirectoryContents(fs, '/dir');
      expect(Object.keys(contents)).toEqual(['readme.md']);
      expect(new TextDecoder().decode(contents['readme.md'])).toBe('# Hello');
    });

    it('should return an empty object for an empty directory', async () => {
      const fs = fromMemoryFS();
      await fs.mkdir('/empty');

      const contents = await getDirectoryContents(fs, '/empty');
      expect(Object.keys(contents)).toHaveLength(0);
    });

    it('should not include deeply nested files', async () => {
      const fs = fromMemoryFS({
        '/root/top.txt': 'top',
        '/root/a/b/deep.txt': 'deep',
      });

      const contents = await getDirectoryContents(fs, '/root');
      expect(Object.keys(contents)).toEqual(['top.txt']);
    });
  });

  describe('readFiles', () => {
    it('should read multiple files concurrently', async () => {
      const fs = fromMemoryFS({
        '/a.txt': 'alpha',
        '/b.txt': 'beta',
      });

      const result = await readFiles(fs, ['/a.txt', '/b.txt']);
      expect(new TextDecoder().decode(result['/a.txt'])).toBe('alpha');
      expect(new TextDecoder().decode(result['/b.txt'])).toBe('beta');
    });
  });

  describe('batchExists', () => {
    it('should check multiple paths concurrently', async () => {
      const fs = fromMemoryFS({
        '/exists.txt': 'yes',
      });

      const result = await batchExists(fs, ['/exists.txt', '/nope.txt']);
      expect(result['/exists.txt']).toBe(true);
      expect(result['/nope.txt']).toBe(false);
    });
  });
});
