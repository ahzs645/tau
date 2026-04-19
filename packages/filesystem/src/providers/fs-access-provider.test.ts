import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystemAccessProvider } from '#providers/fs-access-provider.js';
import { createMockRootHandle } from '#testing/mock-handle-factory.js';

describe('FileSystemAccessProvider', () => {
  let provider: FileSystemAccessProvider;

  beforeEach(() => {
    const rootHandle = createMockRootHandle();
    provider = new FileSystemAccessProvider(rootHandle as unknown as FileSystemDirectoryHandle);
  });

  // ---------------------------------------------------------------------------
  // provider metadata
  // ---------------------------------------------------------------------------

  describe('provider metadata', () => {
    it('should have id "webaccess"', () => {
      expect(provider.id).toBe('webaccess');
    });

    it('should report persistent, writable, non-quotaBased capabilities', () => {
      expect(provider.capabilities).toEqual({
        persistent: true,
        writable: true,
        quotaBased: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // writeFile + readFile round-trip
  // ---------------------------------------------------------------------------

  describe('writeFile + readFile round-trip', () => {
    it('should round-trip a string via utf8 encoding', async () => {
      await provider.writeFile('/hello.txt', 'world');
      const content = await provider.readFile('/hello.txt', 'utf8');
      expect(content).toBe('world');
    });

    it('should round-trip binary data', async () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await provider.writeFile('/bin.dat', data);
      const result = await provider.readFile('/bin.dat');
      expect(new Uint8Array(result)).toEqual(data);
    });

    it('should overwrite existing file content', async () => {
      await provider.writeFile('/file.txt', 'first');
      await provider.writeFile('/file.txt', 'second');
      const content = await provider.readFile('/file.txt', 'utf8');
      expect(content).toBe('second');
    });

    it('should handle empty string writes', async () => {
      await provider.writeFile('/empty.txt', '');
      const content = await provider.readFile('/empty.txt', 'utf8');
      expect(content).toBe('');
    });

    it('should auto-create parent directories for nested paths', async () => {
      await provider.writeFile('/a/b/c/file.txt', 'nested');
      const result = await provider.readFile('/a/b/c/file.txt', 'utf8');
      expect(result).toBe('nested');
    });
  });

  // ---------------------------------------------------------------------------
  // readFile errors
  // ---------------------------------------------------------------------------

  describe('readFile errors', () => {
    it('should throw ENOENT for non-existent file', async () => {
      await expect(provider.readFile('/missing.txt')).rejects.toThrow('ENOENT');
    });

    it('should throw ENOENT for non-existent file with encoding', async () => {
      await expect(provider.readFile('/missing.txt', 'utf8')).rejects.toThrow('ENOENT');
    });
  });

  // ---------------------------------------------------------------------------
  // readdir
  // ---------------------------------------------------------------------------

  describe('readdir', () => {
    it('should list files in root directory', async () => {
      await provider.writeFile('/a.txt', 'a');
      await provider.writeFile('/b.txt', 'b');
      const entries = await provider.readdir('/');
      expect(entries.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('should list files in a subdirectory', async () => {
      await provider.mkdir('/sub');
      await provider.writeFile('/sub/x.txt', 'x');
      await provider.writeFile('/sub/y.txt', 'y');
      const entries = await provider.readdir('/sub');
      expect(entries.sort()).toEqual(['x.txt', 'y.txt']);
    });

    it('should return empty array for empty directory', async () => {
      await provider.mkdir('/empty');
      const entries = await provider.readdir('/empty');
      expect(entries).toEqual([]);
    });

    it('should throw for non-existent directory', async () => {
      await expect(provider.readdir('/nonexistent')).rejects.toThrow('ENOENT');
    });
  });

  // ---------------------------------------------------------------------------
  // stat
  // ---------------------------------------------------------------------------

  describe('stat', () => {
    it('should return correct stats for a file', async () => {
      await provider.writeFile('/sized.txt', 'hello');
      const stats = await provider.stat('/sized.txt');
      expect(stats.size).toBe(5);
      expect(stats.isFile).toBe(true);
      expect(stats.isDirectory).toBe(false);
    });

    it('should return correct stats for a directory', async () => {
      await provider.mkdir('/dir');
      const stats = await provider.stat('/dir');
      expect(stats.isDirectory).toBe(true);
      expect(stats.isFile).toBe(false);
    });

    it('should return correct stats for root', async () => {
      const stats = await provider.stat('/');
      expect(stats.isDirectory).toBe(true);
    });

    it('should throw for non-existent path', async () => {
      await expect(provider.stat('/nope')).rejects.toThrow('ENOENT');
    });
  });

  // ---------------------------------------------------------------------------
  // mkdir
  // ---------------------------------------------------------------------------

  describe('mkdir', () => {
    it('should create a directory', async () => {
      await provider.mkdir('/newdir');
      const stats = await provider.stat('/newdir');
      expect(stats.isDirectory).toBe(true);
    });

    it('should create nested directories with recursive option', async () => {
      await provider.mkdir('/a/b/c', { recursive: true });
      const stats = await provider.stat('/a/b/c');
      expect(stats.isDirectory).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // unlink
  // ---------------------------------------------------------------------------

  describe('unlink', () => {
    it('should delete a file', async () => {
      await provider.writeFile('/delete-me.txt', 'gone');
      await provider.unlink('/delete-me.txt');
      expect(await provider.exists('/delete-me.txt')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // rmdir
  // ---------------------------------------------------------------------------

  describe('rmdir', () => {
    it('should remove an empty directory', async () => {
      await provider.mkdir('/removable');
      await provider.rmdir('/removable');
      expect(await provider.exists('/removable')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // rename
  // ---------------------------------------------------------------------------

  describe('rename', () => {
    it('should rename a file by copying content and removing the original', async () => {
      await provider.writeFile('/old.txt', 'content');
      await provider.rename('/old.txt', '/new.txt');
      expect(await provider.exists('/old.txt')).toBe(false);
      const content = await provider.readFile('/new.txt', 'utf8');
      expect(content).toBe('content');
    });

    it('should throw when source does not exist', async () => {
      await expect(provider.rename('/missing.txt', '/target.txt')).rejects.toThrow('ENOENT');
    });
  });

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------

  describe('exists', () => {
    it('should return true for existing file', async () => {
      await provider.writeFile('/exists.txt', 'yes');
      expect(await provider.exists('/exists.txt')).toBe(true);
    });

    it('should return true for existing directory', async () => {
      await provider.mkdir('/exists-dir');
      expect(await provider.exists('/exists-dir')).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await provider.exists('/nothing')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // handle resolution
  // ---------------------------------------------------------------------------

  describe('handle resolution', () => {
    it('should resolve nested path segments to directory handles', async () => {
      await provider.mkdir('/a/b/c', { recursive: true });
      await provider.writeFile('/a/b/c/file.txt', 'deep');
      const content = await provider.readFile('/a/b/c/file.txt', 'utf8');
      expect(content).toBe('deep');
    });

    it('should throw when intermediate directory does not exist', async () => {
      await expect(provider.readFile('/nonexistent/dir/file.txt')).rejects.toThrow('ENOENT');
    });
  });

  describe('directory handle cache', () => {
    it('should cache handles for repeated directory resolution', async () => {
      await provider.mkdir('/cached/nested', { recursive: true });
      await provider.writeFile('/cached/nested/a.txt', 'a');

      const content1 = await provider.readFile('/cached/nested/a.txt', 'utf8');
      const content2 = await provider.readFile('/cached/nested/a.txt', 'utf8');

      expect(content1).toBe('a');
      expect(content2).toBe('a');
    });

    it('should invalidate cache on rmdir', async () => {
      await provider.mkdir('/removeme');
      await provider.readdir('/removeme');
      await provider.rmdir('/removeme');
      expect(await provider.exists('/removeme')).toBe(false);
    });

    it('should invalidate cache on rename', async () => {
      await provider.writeFile('/old-file.txt', 'data');
      const read1 = await provider.readFile('/old-file.txt', 'utf8');
      expect(read1).toBe('data');

      await provider.rename('/old-file.txt', '/new-file.txt');
      const read2 = await provider.readFile('/new-file.txt', 'utf8');
      expect(read2).toBe('data');
    });
  });

  describe('readdirWithStats', () => {
    it('should return entries with type and size in single pass', async () => {
      await provider.mkdir('/src');
      await provider.writeFile('/src/index.ts', 'export {}');
      await provider.mkdir('/src/utils');

      const entries = await provider.readdirWithStats('/src');
      expect(entries).toHaveLength(2);

      const file = entries.find((entry) => entry.name === 'index.ts');
      const directory = entries.find((entry) => entry.name === 'utils');

      expect(file!.isFile).toBe(true);
      expect(file!.size).toBeGreaterThan(0);

      expect(directory!.isDirectory).toBe(true);
    });
  });
});
