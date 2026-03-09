import { describe, it, expect, beforeEach } from 'vitest';
import { InMemory } from '@zenfs/core';
import { createZenFsProvider } from '#providers/create-zenfs-provider.js';
import type { FileSystemProvider } from '#types.js';

describe('createZenFsProvider', () => {
  let provider: FileSystemProvider;

  beforeEach(async () => {
    provider = await createZenFsProvider({
      id: 'test-memory',
      capabilities: { persistent: false, writable: true, quotaBased: false },
      backendConfig: { backend: InMemory },
    });
  });

  describe('provider metadata', () => {
    it('should have the configured id', () => {
      expect(provider.id).toBe('test-memory');
    });

    it('should have the configured capabilities', () => {
      expect(provider.capabilities).toEqual({
        persistent: false,
        writable: true,
        quotaBased: false,
      });
    });
  });

  describe('writeFile + readFile round-trip', () => {
    it('should write and read a string as utf8', async () => {
      await provider.writeFile('/hello.txt', 'world');
      const content = await provider.readFile('/hello.txt', 'utf8');
      expect(content).toBe('world');
    });

    it('should write and read binary data', async () => {
      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await provider.writeFile('/bin.dat', data);
      const result = await provider.readFile('/bin.dat');
      expect(result).toEqual(data);
    });

    it('should write a Uint8Array and read as utf8', async () => {
      const bytes = new TextEncoder().encode('encoded');
      await provider.writeFile('/encoded.txt', bytes);
      const text = await provider.readFile('/encoded.txt', 'utf8');
      expect(text).toBe('encoded');
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

    it('should handle empty Uint8Array writes', async () => {
      await provider.writeFile('/empty.bin', new Uint8Array(0));
      const result = await provider.readFile('/empty.bin');
      expect(result.byteLength).toBe(0);
    });
  });

  describe('readFile errors', () => {
    it('should throw for non-existent file', async () => {
      await expect(provider.readFile('/missing.txt')).rejects.toThrow();
    });

    it('should throw for non-existent file with encoding', async () => {
      await expect(provider.readFile('/missing.txt', 'utf8')).rejects.toThrow();
    });
  });

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
      await expect(provider.readdir('/nonexistent')).rejects.toThrow();
    });
  });

  describe('stat', () => {
    it('should return correct size for a file', async () => {
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

    it('should return a numeric mtimeMs', async () => {
      await provider.writeFile('/timed.txt', 'data');
      const stats = await provider.stat('/timed.txt');
      expect(typeof stats.mtimeMs).toBe('number');
      expect(stats.mtimeMs).toBeGreaterThan(0);
    });

    it('should throw for non-existent path', async () => {
      await expect(provider.stat('/nope')).rejects.toThrow();
    });
  });

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

    it('should succeed when recursive mkdir with existing intermediate dirs', async () => {
      await provider.mkdir('/x');
      await provider.mkdir('/x/y/z', { recursive: true });
      const stats = await provider.stat('/x/y/z');
      expect(stats.isDirectory).toBe(true);
    });

    it('should throw when parent does not exist (non-recursive)', async () => {
      await expect(provider.mkdir('/no/parent')).rejects.toThrow();
    });
  });

  describe('unlink', () => {
    it('should delete a file', async () => {
      await provider.writeFile('/delete-me.txt', 'gone');
      await provider.unlink('/delete-me.txt');
      const exists = await provider.exists('/delete-me.txt');
      expect(exists).toBe(false);
    });

    it('should throw for non-existent file', async () => {
      await expect(provider.unlink('/not-here.txt')).rejects.toThrow();
    });
  });

  describe('rmdir', () => {
    it('should remove an empty directory', async () => {
      await provider.mkdir('/removable');
      await provider.rmdir('/removable');
      const exists = await provider.exists('/removable');
      expect(exists).toBe(false);
    });

    it('should throw for non-existent directory', async () => {
      await expect(provider.rmdir('/ghost')).rejects.toThrow();
    });
  });

  describe('rename', () => {
    it('should rename a file', async () => {
      await provider.writeFile('/old.txt', 'content');
      await provider.rename('/old.txt', '/new.txt');
      const exists = await provider.exists('/old.txt');
      expect(exists).toBe(false);
      const content = await provider.readFile('/new.txt', 'utf8');
      expect(content).toBe('content');
    });

    it('should throw when source does not exist', async () => {
      await expect(provider.rename('/missing.txt', '/target.txt')).rejects.toThrow();
    });
  });

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

  describe('lstat', () => {
    it('should return file stats', async () => {
      await provider.writeFile('/lstat.txt', 'data');
      const stats = await provider.lstat('/lstat.txt');
      expect(stats.isFile).toBe(true);
      expect(stats.isDirectory).toBe(false);
      expect(stats.size).toBe(4);
    });

    it('should return directory stats', async () => {
      await provider.mkdir('/lstat-dir');
      const stats = await provider.lstat('/lstat-dir');
      expect(stats.isDirectory).toBe(true);
      expect(stats.isFile).toBe(false);
    });

    it('should throw for non-existent path', async () => {
      await expect(provider.lstat('/missing')).rejects.toThrow();
    });
  });

  describe('mkdir error handling', () => {
    it('should re-throw non-EEXIST errors during recursive mkdir', async () => {
      await provider.writeFile('/blocker', 'file-not-dir');

      await expect(provider.mkdir('/blocker/nested', { recursive: true })).rejects.toThrow();
    });
  });

  describe('dispose', () => {
    it('should complete without affecting previously written data', async () => {
      await provider.writeFile('/lifecycle.txt', 'data');
      provider.dispose();
      const content = await provider.readFile('/lifecycle.txt', 'utf8');
      expect(content).toBe('data');
    });
  });
});
