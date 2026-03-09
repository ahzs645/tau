import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileService } from '#file-service.js';
import { ProviderRegistry } from '#provider-registry.js';
import { WriteCoordinator } from '#write-coordinator.js';
import { DirectoryTreeCache } from '#directory-tree-cache.js';
import { ChangeEventBus } from '#change-event-bus.js';
import type { ChangeEvent } from '#types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function createFileService() {
  const providerRegistry = new ProviderRegistry();
  await providerRegistry.switchActiveProvider('memory');

  const writeCoordinator = new WriteCoordinator();
  const treeCache = new DirectoryTreeCache();
  const eventBus = new ChangeEventBus();

  const service = new FileService({
    providerRegistry,
    writeCoordinator,
    treeCache,
    eventBus,
  });

  return { service, eventBus, treeCache, providerRegistry };
}

describe('FileService', () => {
  let service: FileService;
  let eventBus: ChangeEventBus;
  let providerRegistry: ProviderRegistry;

  beforeEach(async () => {
    const context = await createFileService();
    service = context.service;
    eventBus = context.eventBus;
    providerRegistry = context.providerRegistry;
  });

  // ---------------------------------------------------------------------------
  // writeFile / readFile round-trip
  // ---------------------------------------------------------------------------

  describe('writeFile + readFile', () => {
    it('should round-trip a string via utf8 encoding', async () => {
      await service.writeFile('/hello.txt', 'world');
      const result = await service.readFile('/hello.txt', 'utf8');
      expect(result).toBe('world');
    });

    it('should round-trip a string via encoding object', async () => {
      await service.writeFile('/hello.txt', 'world');
      const result = await service.readFile('/hello.txt', { encoding: 'utf8' });
      expect(result).toBe('world');
    });

    it('should round-trip Uint8Array data', async () => {
      const data = encoder.encode('binary content');
      await service.writeFile('/bin.dat', data);
      const result = await service.readFile('/bin.dat');
      expect(result).toBeInstanceOf(Uint8Array);
      expect(decoder.decode(result as Uint8Array<ArrayBuffer>)).toBe('binary content');
    });

    it('should return raw Uint8Array when no encoding is specified', async () => {
      await service.writeFile('/raw.txt', 'hello');
      const result = await service.readFile('/raw.txt');
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should overwrite an existing file', async () => {
      await service.writeFile('/file.txt', 'first');
      await service.writeFile('/file.txt', 'second');
      const result = await service.readFile('/file.txt', 'utf8');
      expect(result).toBe('second');
    });

    it('should auto-create parent directories for nested paths', async () => {
      await service.writeFile('/a/b/c/file.txt', 'nested');
      const result = await service.readFile('/a/b/c/file.txt', 'utf8');
      expect(result).toBe('nested');
    });

    it('should write an empty file', async () => {
      await service.writeFile('/empty.txt', '');
      const result = await service.readFile('/empty.txt', 'utf8');
      expect(result).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // readFile errors
  // ---------------------------------------------------------------------------

  describe('readFile errors', () => {
    it('should throw for a non-existent file', async () => {
      await expect(service.readFile('/nope.txt')).rejects.toThrow();
    });

    it('should throw for a non-existent nested file', async () => {
      await expect(service.readFile('/a/b/c.txt')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // readFiles
  // ---------------------------------------------------------------------------

  describe('readFiles', () => {
    it('should read multiple files in parallel', async () => {
      await service.writeFile('/a.txt', 'alpha');
      await service.writeFile('/b.txt', 'bravo');
      const results = await service.readFiles(['/a.txt', '/b.txt']);
      expect(decoder.decode(results['/a.txt'])).toBe('alpha');
      expect(decoder.decode(results['/b.txt'])).toBe('bravo');
    });

    it('should return an empty record for an empty input', async () => {
      const results = await service.readFiles([]);
      expect(results).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // readdir
  // ---------------------------------------------------------------------------

  describe('readdir', () => {
    it('should list entries in a directory', async () => {
      await service.writeFile('/dir/a.txt', 'a');
      await service.writeFile('/dir/b.txt', 'b');
      const entries = await service.readdir('/dir');
      expect(entries.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('should return an empty array for an empty directory', async () => {
      await service.mkdir('/empty');
      const entries = await service.readdir('/empty');
      expect(entries).toEqual([]);
    });

    it('should include subdirectories in the listing', async () => {
      await service.mkdir('/parent/child', { recursive: true });
      await service.writeFile('/parent/file.txt', 'x');
      const entries = await service.readdir('/parent');
      expect(entries.sort()).toEqual(['child', 'file.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // stat / lstat
  // ---------------------------------------------------------------------------

  describe('stat', () => {
    it('should return file stat with type "file"', async () => {
      await service.writeFile('/f.txt', 'content');
      const stat = await service.stat('/f.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.mtimeMs).toBeGreaterThan(0);
    });

    it('should return directory stat with type "dir"', async () => {
      await service.mkdir('/mydir');
      const stat = await service.stat('/mydir');
      expect(stat.type).toBe('dir');
    });

    it('should throw for a non-existent path', async () => {
      await expect(service.stat('/missing')).rejects.toThrow();
    });
  });

  describe('lstat', () => {
    it('should return stat for a file', async () => {
      await service.writeFile('/f.txt', 'data');
      const stat = await service.lstat('/f.txt');
      expect(stat.type).toBe('file');
    });

    it('should return stat for a directory', async () => {
      await service.mkdir('/d');
      const stat = await service.lstat('/d');
      expect(stat.type).toBe('dir');
    });
  });

  // ---------------------------------------------------------------------------
  // exists / batchExists
  // ---------------------------------------------------------------------------

  describe('exists', () => {
    it('should return true for an existing file', async () => {
      await service.writeFile('/e.txt', 'exists');
      expect(await service.exists('/e.txt')).toBe(true);
    });

    it('should return false for a missing file', async () => {
      expect(await service.exists('/missing.txt')).toBe(false);
    });

    it('should return true for an existing directory', async () => {
      await service.mkdir('/dir');
      expect(await service.exists('/dir')).toBe(true);
    });
  });

  describe('batchExists', () => {
    it('should return existence map for multiple paths', async () => {
      await service.writeFile('/yes.txt', 'y');
      const result = await service.batchExists(['/yes.txt', '/no.txt']);
      expect(result['/yes.txt']).toBe(true);
      expect(result['/no.txt']).toBe(false);
    });

    it('should return an empty record for empty input', async () => {
      const result = await service.batchExists([]);
      expect(result).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // mkdir
  // ---------------------------------------------------------------------------

  describe('mkdir', () => {
    it('should create a single directory', async () => {
      await service.mkdir('/newdir');
      expect(await service.exists('/newdir')).toBe(true);
      const stat = await service.stat('/newdir');
      expect(stat.type).toBe('dir');
    });

    it('should create nested directories with recursive option', async () => {
      await service.mkdir('/a/b/c', { recursive: true });
      expect(await service.exists('/a')).toBe(true);
      expect(await service.exists('/a/b')).toBe(true);
      expect(await service.exists('/a/b/c')).toBe(true);
    });

    it('should throw when creating nested directory without recursive', async () => {
      await expect(service.mkdir('/x/y/z')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // rename
  // ---------------------------------------------------------------------------

  describe('rename', () => {
    it('should rename a file', async () => {
      await service.writeFile('/old.txt', 'data');
      await service.rename('/old.txt', '/new.txt');
      expect(await service.exists('/old.txt')).toBe(false);
      const content = await service.readFile('/new.txt', 'utf8');
      expect(content).toBe('data');
    });

    it('should rename a directory', async () => {
      await service.mkdir('/olddir');
      await service.writeFile('/olddir/file.txt', 'inside');
      await service.rename('/olddir', '/newdir');
      expect(await service.exists('/olddir')).toBe(false);
      expect(await service.exists('/newdir')).toBe(true);
      const content = await service.readFile('/newdir/file.txt', 'utf8');
      expect(content).toBe('inside');
    });
  });

  // ---------------------------------------------------------------------------
  // unlink
  // ---------------------------------------------------------------------------

  describe('unlink', () => {
    it('should delete a file', async () => {
      await service.writeFile('/del.txt', 'gone');
      await service.unlink('/del.txt');
      expect(await service.exists('/del.txt')).toBe(false);
    });

    it('should throw when deleting a non-existent file', async () => {
      await expect(service.unlink('/nonexistent.txt')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // rmdir
  // ---------------------------------------------------------------------------

  describe('rmdir', () => {
    it('should remove an empty directory', async () => {
      await service.mkdir('/todel');
      await service.rmdir('/todel');
      expect(await service.exists('/todel')).toBe(false);
    });

    it('should throw when removing a non-existent directory', async () => {
      await expect(service.rmdir('/nope')).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureDirectoryExists
  // ---------------------------------------------------------------------------

  describe('ensureDirectoryExists', () => {
    it('should create the full directory chain', async () => {
      await service.ensureDirectoryExists('/x/y/z');
      expect(await service.exists('/x')).toBe(true);
      expect(await service.exists('/x/y')).toBe(true);
      expect(await service.exists('/x/y/z')).toBe(true);
    });

    it('should be a no-op when directories already exist', async () => {
      await service.mkdir('/existing', { recursive: true });
      await service.ensureDirectoryExists('/existing');
      expect(await service.exists('/existing')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // duplicateFile
  // ---------------------------------------------------------------------------

  describe('duplicateFile', () => {
    it('should copy a file to a new location', async () => {
      await service.writeFile('/src.txt', 'copy me');
      await service.duplicateFile('/src.txt', '/dst.txt');
      const content = await service.readFile('/dst.txt', 'utf8');
      expect(content).toBe('copy me');
      expect(await service.exists('/src.txt')).toBe(true);
    });

    it('should create parent directories for the destination', async () => {
      await service.writeFile('/orig.txt', 'data');
      await service.duplicateFile('/orig.txt', '/deep/nested/copy.txt');
      const content = await service.readFile('/deep/nested/copy.txt', 'utf8');
      expect(content).toBe('data');
    });
  });

  // ---------------------------------------------------------------------------
  // copyDirectory
  // ---------------------------------------------------------------------------

  describe('copyDirectory', () => {
    it('should recursively copy a directory', async () => {
      await service.writeFile('/source/a.txt', 'aaa');
      await service.writeFile('/source/sub/b.txt', 'bbb');
      await service.copyDirectory('/source', '/dest');
      expect(await service.readFile('/dest/a.txt', 'utf8')).toBe('aaa');
      expect(await service.readFile('/dest/sub/b.txt', 'utf8')).toBe('bbb');
    });
  });

  // ---------------------------------------------------------------------------
  // getDirectoryContents
  // ---------------------------------------------------------------------------

  describe('getDirectoryContents', () => {
    it('should return all files with relative paths', async () => {
      await service.writeFile('/proj/readme.md', '# Hi');
      await service.writeFile('/proj/src/main.ts', 'code');
      const contents = await service.getDirectoryContents('/proj');
      expect(decoder.decode(contents['readme.md'])).toBe('# Hi');
      expect(decoder.decode(contents['src/main.ts'])).toBe('code');
    });

    it('should return an empty record for a non-existent directory', async () => {
      const contents = await service.getDirectoryContents('/nonexistent');
      expect(contents).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // writeFiles
  // ---------------------------------------------------------------------------

  describe('writeFiles', () => {
    it('should write multiple files atomically', async () => {
      const pathA = '/batch/a.txt';
      const pathB = '/batch/b.txt';
      await service.writeFiles({
        [pathA]: { content: 'alpha' },
        [pathB]: { content: 'bravo' },
      });
      expect(await service.readFile(pathA, 'utf8')).toBe('alpha');
      expect(await service.readFile(pathB, 'utf8')).toBe('bravo');
    });

    it('should create parent directories for each file', async () => {
      const pathA = '/deep/a/file.txt';
      const pathB = '/deep/b/file.txt';
      await service.writeFiles({
        [pathA]: { content: 'deep-a' },
        [pathB]: { content: 'deep-b' },
      });
      expect(await service.readFile(pathA, 'utf8')).toBe('deep-a');
      expect(await service.readFile(pathB, 'utf8')).toBe('deep-b');
    });
  });

  // ---------------------------------------------------------------------------
  // readDirectory (tree cache)
  // ---------------------------------------------------------------------------

  describe('readDirectory', () => {
    it('should return sorted tree nodes (folders first)', async () => {
      await service.mkdir('/tree/sub', { recursive: true });
      await service.writeFile('/tree/file.txt', 'x');
      const nodes = await service.readDirectory('/tree');
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.name).toBe('sub');
      expect(nodes[0]!.children).toEqual([]);
      expect(nodes[1]!.name).toBe('file.txt');
      expect(nodes[1]!.children).toBeUndefined();
    });

    it('should return empty array for non-existent directory', async () => {
      const nodes = await service.readDirectory('/nowhere');
      expect(nodes).toEqual([]);
    });

    it('should cache results on subsequent calls', async () => {
      await service.writeFile('/cached/a.txt', 'a');
      const first = await service.readDirectory('/cached');
      const second = await service.readDirectory('/cached');
      expect(first).toEqual(second);
    });
  });

  // ---------------------------------------------------------------------------
  // getDirectoryStat
  // ---------------------------------------------------------------------------

  describe('getDirectoryStat', () => {
    it('should return stat entries for all files recursively', async () => {
      await service.writeFile('/stats/a.txt', 'aaa');
      await service.writeFile('/stats/sub/b.txt', 'bb');
      const stats = await service.getDirectoryStat('/stats');
      expect(stats).toHaveLength(2);

      const paths = stats.map((s) => s.path).sort();
      expect(paths).toEqual(['a.txt', 'sub/b.txt']);

      const aEntry = stats.find((s) => s.name === 'a.txt')!;
      expect(aEntry.type).toBe('file');
      expect(aEntry.size).toBeGreaterThan(0);
      expect(aEntry.mtimeMs).toBeGreaterThan(0);
    });

    it('should return empty array for an empty directory', async () => {
      await service.mkdir('/emptystats');
      const stats = await service.getDirectoryStat('/emptystats');
      expect(stats).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // readShallowDirectory
  // ---------------------------------------------------------------------------

  describe('readShallowDirectory', () => {
    it('should return empty array for memory backend', async () => {
      const nodes = await service.readShallowDirectory('/', 'memory');
      expect(nodes).toEqual([]);
    });

    it('should return files and folders sorted (folders first, alpha) when backend has entries', async () => {
      const mockProvider = {
        readdir: vi.fn().mockResolvedValue(['zebra.txt', 'alpha', 'beta.txt', 'alpha-dir']),
        stat: vi.fn().mockImplementation(async (path: string) => {
          const directories = new Set(['/alpha', '/alpha-dir']);
          return { isDirectory: directories.has(path), isFile: !directories.has(path), size: 10, mtimeMs: 1 };
        }),
      };
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockResolvedValue(mockProvider as never);

      const nodes = await service.readShallowDirectory('/', 'indexeddb');

      expect(nodes).toEqual([
        { id: '/alpha', name: 'alpha', children: [] },
        { id: '/alpha-dir', name: 'alpha-dir', children: [] },
        { id: '/beta.txt', name: 'beta.txt' },
        { id: '/zebra.txt', name: 'zebra.txt' },
      ]);
    });

    it('should return empty array when getStandaloneProvider throws', async () => {
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockRejectedValue(new Error('no provider'));

      const nodes = await service.readShallowDirectory('/', 'indexeddb');
      expect(nodes).toEqual([]);
    });

    it('should return empty array when readdir throws', async () => {
      const mockProvider = { readdir: vi.fn().mockRejectedValue(new Error('ENOENT')) };
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockResolvedValue(mockProvider as never);

      const nodes = await service.readShallowDirectory('/', 'indexeddb');
      expect(nodes).toEqual([]);
    });

    it('should skip entries where stat throws', async () => {
      const mockProvider = {
        readdir: vi.fn().mockResolvedValue(['good.txt', 'bad.txt']),
        stat: vi.fn().mockImplementation(async (path: string) => {
          if (path === '/good.txt') {
            return { isDirectory: false, isFile: true, size: 5, mtimeMs: 1 };
          }
          throw new Error('stat failed');
        }),
      };
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockResolvedValue(mockProvider as never);

      const nodes = await service.readShallowDirectory('/', 'indexeddb');
      expect(nodes).toEqual([{ id: '/good.txt', name: 'good.txt' }]);
    });

    it('should build correct paths when root is /', async () => {
      const mockProvider = {
        readdir: vi.fn().mockResolvedValue(['file.txt']),
        stat: vi.fn().mockResolvedValue({ isDirectory: false, isFile: true, size: 1, mtimeMs: 1 }),
      };
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockResolvedValue(mockProvider as never);

      const nodes = await service.readShallowDirectory('/', 'indexeddb');
      expect(nodes[0]!.id).toBe('/file.txt');
      expect(mockProvider.stat).toHaveBeenCalledWith('/file.txt');
    });

    it('should build correct paths for nested directories', async () => {
      const mockProvider = {
        readdir: vi.fn().mockResolvedValue(['child.txt']),
        stat: vi.fn().mockResolvedValue({ isDirectory: false, isFile: true, size: 1, mtimeMs: 1 }),
      };
      vi.spyOn(providerRegistry, 'getStandaloneProvider').mockResolvedValue(mockProvider as never);

      const nodes = await service.readShallowDirectory('/parent/sub', 'indexeddb');
      expect(nodes[0]!.id).toBe('/parent/sub/child.txt');
      expect(mockProvider.stat).toHaveBeenCalledWith('/parent/sub/child.txt');
    });
  });

  // ---------------------------------------------------------------------------
  // Event emission
  // ---------------------------------------------------------------------------

  describe('event emission', () => {
    it('should emit fileWritten on writeFile', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.writeFile('/ev.txt', 'data');

      const writeEvents = events.filter((event) => event.type === 'fileWritten');
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0]!.path).toBe('/ev.txt');
    });

    it('should emit directoryChanged on writeFiles', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      const filePath = '/batch/f.txt';
      await service.writeFiles({ [filePath]: { content: 'x' } });

      const directoryEvents = events.filter((event) => event.type === 'directoryChanged');
      expect(directoryEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit directoryChanged on mkdir', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.mkdir('/evdir');

      const directoryEvents = events.filter((event) => event.type === 'directoryChanged');
      expect(directoryEvents).toHaveLength(1);
    });

    it('should emit fileRenamed on rename', async () => {
      await service.writeFile('/ren.txt', 'data');
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.rename('/ren.txt', '/renamed.txt');

      const renameEvents = events.filter((event) => event.type === 'fileRenamed');
      expect(renameEvents).toHaveLength(1);
      const renameEvent = renameEvents[0]!;
      expect(renameEvent.oldPath).toBe('/ren.txt');
      expect(renameEvent.newPath).toBe('/renamed.txt');
    });

    it('should emit fileDeleted on unlink', async () => {
      await service.writeFile('/gone.txt', 'bye');
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.unlink('/gone.txt');

      const deleteEvents = events.filter((event) => event.type === 'fileDeleted');
      expect(deleteEvents).toHaveLength(1);
      expect(deleteEvents[0]!.path).toBe('/gone.txt');
    });

    it('should emit directoryChanged on rmdir', async () => {
      await service.mkdir('/rmd');
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.rmdir('/rmd');

      const directoryEvents = events.filter((event) => event.type === 'directoryChanged');
      expect(directoryEvents).toHaveLength(1);
    });

    it('should emit fileWritten on duplicateFile', async () => {
      await service.writeFile('/dup-src.txt', 'copy');
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.duplicateFile('/dup-src.txt', '/dup-dst.txt');

      const writeEvents = events.filter((event) => event.type === 'fileWritten');
      expect(writeEvents).toHaveLength(1);
      expect(writeEvents[0]!.path).toBe('/dup-dst.txt');
    });

    it('should include backend in emitted events', async () => {
      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => events.push(event));

      await service.writeFile('/backend.txt', 'x');

      const writeEvent = events.find((event) => event.type === 'fileWritten')!;
      expect('backend' in writeEvent && writeEvent.backend).toBe('memory');
    });
  });

  // ---------------------------------------------------------------------------
  // Tree cache invalidation
  // ---------------------------------------------------------------------------

  describe('tree cache invalidation', () => {
    it('should invalidate cache on write so readDirectory returns fresh data', async () => {
      await service.writeFile('/cacheinv/a.txt', 'a');
      const first = await service.readDirectory('/cacheinv');
      expect(first).toHaveLength(1);

      await service.writeFile('/cacheinv/b.txt', 'b');
      const second = await service.readDirectory('/cacheinv');
      expect(second).toHaveLength(2);
    });

    it('should invalidate cache on unlink', async () => {
      await service.writeFile('/cacheinv2/a.txt', 'a');
      await service.readDirectory('/cacheinv2');

      await service.unlink('/cacheinv2/a.txt');
      const after = await service.readDirectory('/cacheinv2');
      expect(after).toHaveLength(0);
    });

    it('should invalidate cache on rename', async () => {
      await service.writeFile('/ren-cache/old.txt', 'data');
      await service.readDirectory('/ren-cache');

      await service.rename('/ren-cache/old.txt', '/ren-cache/new.txt');
      const nodes = await service.readDirectory('/ren-cache');
      const names = nodes.map((n) => n.name);
      expect(names).toContain('new.txt');
      expect(names).not.toContain('old.txt');
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  describe('dispose', () => {
    it('should clear the event bus (no subscribers fire after dispose)', async () => {
      const handler = vi.fn();
      eventBus.subscribe(handler);
      service.dispose();
      eventBus.emit({ type: 'fileWritten', path: '/x', backend: 'memory' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // watch API
  // ---------------------------------------------------------------------------

  describe('watch', () => {
    it('should return an unsubscribe function', async () => {
      const unsub = service.watch({ paths: ['/'] }, () => {
        /* Intentionally empty */
      });
      expect(typeof unsub).toBe('function');
      unsub();
    });

    it('should expose watchRegistry', () => {
      expect(service.watchRegistry).toBeDefined();
      expect(service.watchRegistry.subscriptionCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrent writes are serialized
  // ---------------------------------------------------------------------------

  describe('write serialization', () => {
    it('should serialize concurrent writeFile calls', async () => {
      const order: string[] = [];
      const origSubscribe = eventBus.subscribe.bind(eventBus);
      origSubscribe((event) => {
        if (event.type === 'fileWritten' && 'path' in event) {
          order.push(event.path);
        }
      });

      const w1 = service.writeFile('/s1.txt', 'a');
      const w2 = service.writeFile('/s2.txt', 'b');
      const w3 = service.writeFile('/s3.txt', 'c');

      await Promise.all([w1, w2, w3]);

      expect(order).toEqual(['/s1.txt', '/s2.txt', '/s3.txt']);
    });
  });

  describe('cleanupWatches', () => {
    it('should delegate to watchRegistry.cleanupOwner', async () => {
      const handler = vi.fn();
      service.watch({ paths: ['/'], correlationId: 'c', recursive: true }, handler, 'owner-1');
      expect(service.watchRegistry.handlerCount).toBe(1);

      service.cleanupWatches('owner-1');
      expect(service.watchRegistry.handlerCount).toBe(0);
    });
  });

  describe('reconfigure', () => {
    it('should switch backend and clear tree cache', async () => {
      await service.writeFile('/cached.txt', 'data');
      await service.readDirectory('/');

      const events: ChangeEvent[] = [];
      eventBus.subscribe((event) => {
        events.push(event);
      });

      await service.reconfigure('memory');

      expect(events.some((event) => event.type === 'backendChanged')).toBe(true);
    });
  });

  describe('eventBus getter', () => {
    it('should return the event bus instance', () => {
      expect(service.eventBus).toBe(eventBus);
    });
  });

  describe('_ensurePath error propagation', () => {
    it('should propagate non-EEXIST errors during nested writes', async () => {
      const provider = await providerRegistry.getActiveProvider();
      const origMkdir = provider.mkdir.bind(provider);
      let callCount = 0;
      provider.mkdir = async (path: string) => {
        callCount++;
        if (callCount === 2) {
          const error = new Error('disk full') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return origMkdir(path);
      };

      await expect(service.writeFile('/a/b/c.txt', 'data')).rejects.toThrow('disk full');
    });
  });
});
