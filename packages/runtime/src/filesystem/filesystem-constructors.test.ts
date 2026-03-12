import { describe, it, expect, beforeEach } from 'vitest';
import { configure, fs } from '@zenfs/core';
import { InMemory } from '@zenfs/core/backends/memory.js';
import { fromFsLike } from '#filesystem/from-fs-like.js';
import { fromMemoryFS } from '#filesystem/from-memory-fs.js';

describe('filesystem constructors', () => {
  describe('fromFsLike', () => {
    beforeEach(async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem mount point requires '/' as key
      await configure({ mounts: { '/': InMemory } });
    });

    it('should read a file as utf8', async () => {
      await fs.promises.writeFile('/test.txt', 'hello world');
      const fileSystem = fromFsLike(fs);

      const content = await fileSystem.readFile('/test.txt', 'utf8');
      expect(content).toBe('hello world');
    });

    it('should read a file as Uint8Array', async () => {
      await fs.promises.writeFile('/bin.txt', 'binary');
      const fileSystem = fromFsLike(fs);

      const content = await fileSystem.readFile('/bin.txt');
      expect(content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(content)).toBe('binary');
    });

    it('should write and read back a file', async () => {
      const fileSystem = fromFsLike(fs);

      await fileSystem.writeFile('/new.txt', 'written');
      const content = await fileSystem.readFile('/new.txt', 'utf8');
      expect(content).toBe('written');
    });

    it('should create directories', async () => {
      const fileSystem = fromFsLike(fs);

      await fileSystem.mkdir('/mydir');
      const stat = await fileSystem.stat('/mydir');
      expect(stat.type).toBe('dir');
    });

    it('should create directories recursively', async () => {
      const fileSystem = fromFsLike(fs);

      await fileSystem.mkdir('/a/b/c', { recursive: true });
      const stat = await fileSystem.stat('/a/b/c');
      expect(stat.type).toBe('dir');
    });

    it('should list directory contents', async () => {
      await fs.promises.writeFile('/dir-test.txt', 'data');
      const fileSystem = fromFsLike(fs);

      const entries = await fileSystem.readdir('/');
      expect(entries).toContain('dir-test.txt');
    });

    it('should delete a file', async () => {
      await fs.promises.writeFile('/del.txt', 'gone');
      const fileSystem = fromFsLike(fs);

      await fileSystem.unlink('/del.txt');
      const exists = await fileSystem.exists('/del.txt');
      expect(exists).toBe(false);
    });

    it('should stat a file with correct metadata', async () => {
      await fs.promises.writeFile('/stat.txt', 'abcde');
      const fileSystem = fromFsLike(fs);

      const stat = await fileSystem.stat('/stat.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(5);
      expect(stat.mtimeMs).toBeTypeOf('number');
    });

    it('should stat a directory', async () => {
      await fs.promises.mkdir('/statdir');
      const fileSystem = fromFsLike(fs);

      const stat = await fileSystem.stat('/statdir');
      expect(stat.type).toBe('dir');
    });

    it('should check file existence', async () => {
      await fs.promises.writeFile('/exists.txt', 'yes');
      const fileSystem = fromFsLike(fs);

      expect(await fileSystem.exists('/exists.txt')).toBe(true);
      expect(await fileSystem.exists('/nope.txt')).toBe(false);
    });

    it('should scope operations to rootPath', async () => {
      await fs.promises.mkdir('/root', { recursive: true });
      await fs.promises.writeFile('/root/scoped.txt', 'scoped data');
      const fileSystem = fromFsLike(fs, '/root');

      const content = await fileSystem.readFile('/scoped.txt', 'utf8');
      expect(content).toBe('scoped data');
    });

    it('should remove a directory via rmdir', async () => {
      const fileSystem = fromFsLike(fs);

      await fileSystem.mkdir('/rmdir-test');
      await fileSystem.rmdir('/rmdir-test');
      expect(await fileSystem.exists('/rmdir-test')).toBe(false);
    });

    it('should rename a file', async () => {
      const fileSystem = fromFsLike(fs);

      await fileSystem.writeFile('/old.txt', 'rename me');
      await fileSystem.rename('/old.txt', '/new.txt');

      expect(await fileSystem.exists('/old.txt')).toBe(false);
      const content = await fileSystem.readFile('/new.txt', 'utf8');
      expect(content).toBe('rename me');
    });

    it('should lstat a file', async () => {
      await fs.promises.writeFile('/lstat.txt', 'abc');
      const fileSystem = fromFsLike(fs);

      const stat = await fileSystem.lstat('/lstat.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(3);
      expect(stat.mtimeMs).toBeTypeOf('number');
    });
  });

  describe('fromMemoryFS', () => {
    it('should mkdir and create all parent directories', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/a/b/c');

      expect(await fileSystem.exists('/a/b/c')).toBe(true);
      expect(await fileSystem.exists('/a/b')).toBe(true);
      expect(await fileSystem.exists('/a')).toBe(true);
    });

    it('should make parent directories visible via stat', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/x/y/z');

      const statX = await fileSystem.stat('/x');
      expect(statX.type).toBe('dir');

      const statXy = await fileSystem.stat('/x/y');
      expect(statXy.type).toBe('dir');
    });

    it('should list children created by mkdir in readdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/parent/child');

      const entries = await fileSystem.readdir('/parent');
      expect(entries).toContain('child');
    });

    it('should list deeply nested mkdir directories via readdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/a/b/c/d');

      expect(await fileSystem.readdir('/a')).toContain('b');
      expect(await fileSystem.readdir('/a/b')).toContain('c');
      expect(await fileSystem.readdir('/a/b/c')).toContain('d');
    });

    it('should read and write files in directories created by mkdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/project/src');
      await fileSystem.writeFile('/project/src/index.ts', 'export {}');

      const content = await fileSystem.readFile('/project/src/index.ts', 'utf8');
      expect(content).toBe('export {}');
    });

    it('should remove a directory via rmdir', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/rmdir-test');
      expect(await fileSystem.exists('/rmdir-test')).toBe(true);
      await fileSystem.rmdir('/rmdir-test');
      expect(await fileSystem.exists('/rmdir-test')).toBe(false);
    });

    it('should rename a file', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.writeFile('/old.txt', 'rename me');
      await fileSystem.rename('/old.txt', '/new.txt');

      expect(await fileSystem.exists('/old.txt')).toBe(false);
      const content = await fileSystem.readFile('/new.txt', 'utf8');
      expect(content).toBe('rename me');
    });

    it('should rename a directory', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.mkdir('/old-dir');
      await fileSystem.rename('/old-dir', '/new-dir');

      expect(await fileSystem.exists('/old-dir')).toBe(false);
      expect(await fileSystem.exists('/new-dir')).toBe(true);
    });

    it('should throw ENOENT when renaming nonexistent path', async () => {
      const fileSystem = fromMemoryFS();

      await expect(fileSystem.rename('/nope', '/also-nope')).rejects.toThrow('ENOENT');
    });

    it('should lstat a file (delegates to stat, no symlinks)', async () => {
      const fileSystem = fromMemoryFS();

      await fileSystem.writeFile('/lstat.txt', 'abc');
      const stat = await fileSystem.lstat('/lstat.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(3);
      expect(stat.mtimeMs).toBeTypeOf('number');
    });

    it('should throw ENOENT from stat for nonexistent path', async () => {
      const fileSystem = fromMemoryFS();
      await expect(fileSystem.stat('/does-not-exist')).rejects.toThrow('ENOENT');
    });

    it('should return directory stat from lstat', async () => {
      const fileSystem = fromMemoryFS();
      await fileSystem.mkdir('/my-dir');

      const stat = await fileSystem.lstat('/my-dir');
      expect(stat.type).toBe('dir');
    });

    it('should throw ENOENT from lstat for nonexistent path', async () => {
      const fileSystem = fromMemoryFS();
      await expect(fileSystem.lstat('/missing')).rejects.toThrow('ENOENT');
    });
  });
});
