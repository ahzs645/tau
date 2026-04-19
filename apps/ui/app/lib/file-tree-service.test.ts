import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileTreeService } from '#lib/file-tree-service.js';
import { FileContentService } from '#lib/file-content-service.js';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { ChangeEvent, FileEntry, FileStatEntry } from '@taucad/types';
import type { FileTreeNode } from '@taucad/filesystem';
import { parametersDirectory } from '#utils/parameter-config.utils.js';

function createMockProxy(overrides?: Partial<FileManagerProxy>): FileManagerProxy {
  return {
    readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    copyDirectory: vi.fn().mockResolvedValue(undefined),
    getZippedDirectory: vi.fn().mockResolvedValue(new Blob()),
    duplicateFile: vi.fn().mockResolvedValue(undefined),
    getDirectoryStat: vi.fn().mockResolvedValue([]),
    readDirectory: vi.fn().mockResolvedValue([]),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, mtimeMs: 0 }),
    rmdir: vi.fn().mockResolvedValue(undefined),
    readShallowDirectory: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as FileManagerProxy;
}

function createEntry(path: string, type: 'file' | 'dir' = 'file', size = 100): FileEntry {
  const parts = path.split('/');
  return { path, name: parts.at(-1) ?? path, type, size, mtimeMs: 0, isLoaded: false };
}

describe('FileTreeService', () => {
  let proxy: FileManagerProxy;
  let service: FileTreeService;

  beforeEach(() => {
    vi.useFakeTimers();
    proxy = createMockProxy();
    service = new FileTreeService({
      proxy,
      rootDirectory: '/project',
      initialEntries: [createEntry('main.ts'), createEntry('lib/utils.ts'), createEntry('lib/helpers.ts')],
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it('should return tree snapshot with stable reference when unchanged', () => {
    const snap1 = service.getTreeSnapshot();
    const snap2 = service.getTreeSnapshot();
    expect(snap1).toBe(snap2);
  });

  it('should return true from exists() for known paths', async () => {
    expect(await service.exists('main.ts')).toBe(true);
    expect(await service.exists('lib/utils.ts')).toBe(true);
  });

  it('should return entries from readdir() matching parent path', async () => {
    const entries = await service.readdir('lib');
    expect(entries).toContain('utils.ts');
    expect(entries).toContain('helpers.ts');
    expect(entries).not.toContain('main.ts');
  });

  it('should debounce refresh when rapid mutations occur', async () => {
    service.scheduleRefresh('lib');
    service.scheduleRefresh('lib');
    service.scheduleRefresh('lib');

    await vi.advanceTimersByTimeAsync(50);
    expect(proxy.readDirectory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60);
    expect(proxy.readDirectory).toHaveBeenCalledOnce();
  });

  it('should refresh only the changed files parent directory', async () => {
    vi.useRealTimers();

    const readDirectoryNodes: FileTreeNode[] = [
      { id: 'utils.ts', name: 'utils.ts' },
      { id: 'helpers.ts', name: 'helpers.ts' },
      { id: 'new-file.ts', name: 'new-file.ts' },
    ];
    const localProxy = createMockProxy({
      readDirectory: vi.fn().mockResolvedValue(readDirectoryNodes),
    });
    const localService = new FileTreeService({
      proxy: localProxy,
      rootDirectory: '/project',
      initialEntries: [createEntry('main.ts'), createEntry('lib/utils.ts'), createEntry('lib/helpers.ts')],
      debounceMs: 10,
    });

    localService.scheduleRefresh('lib');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(localProxy.readDirectory).toHaveBeenCalledWith('/project/lib');
    expect(await localService.exists('lib/new-file.ts')).toBe(true);
    expect(await localService.exists('main.ts')).toBe(true);

    localService.dispose();
    vi.useFakeTimers();
  });

  it('should skip tree refresh for source=editor content changes', () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });

    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    void contentService.write('main.ts', new Uint8Array([1]), 'editor');

    expect((service as unknown as { refreshTimer: unknown }).refreshTimer).toBeUndefined();

    contentService.dispose();
  });

  it('should apply optimistic tree update on content written event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    await contentService.write('newfile.ts', new Uint8Array([1, 2, 3]), 'machine');

    expect(await service.exists('newfile.ts')).toBe(true);
    const entry = await service.getEntry('newfile.ts');
    expect(entry?.type).toBe('file');
    expect(entry?.size).toBe(3);

    contentService.dispose();
  });

  it('should apply optimistic tree update on content deleted event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    expect(await service.exists('main.ts')).toBe(true);

    vi.mocked(contentProxy.unlink).mockResolvedValue(undefined);
    await contentService.delete('main.ts', 'user');

    expect(service.getTreeSnapshot().has('main.ts')).toBe(false);

    contentService.dispose();
  });

  it('should apply optimistic tree update on content renamed event', async () => {
    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.rename).mockResolvedValue(undefined);
    await contentService.rename('main.ts', 'app.ts');

    expect(service.getTreeSnapshot().has('main.ts')).toBe(false);
    expect(service.getTreeSnapshot().has('app.ts')).toBe(true);

    contentService.dispose();
  });

  it('should notify subscribers when tree changes', async () => {
    const subscriber = vi.fn();
    service.subscribeTree(subscriber);

    const contentProxy = createMockProxy();
    const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
    service.connectToContentService(contentService);

    vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
    await contentService.write('new.ts', new Uint8Array([1]), 'user');

    expect(subscriber).toHaveBeenCalled();

    contentService.dispose();
  });

  // ── R7: hasChildrenLoaded (F5) ──

  describe('hasChildrenLoaded', () => {
    it('should return false for root when no initialEntries are provided', () => {
      const emptyService = new FileTreeService({
        proxy: createMockProxy(),
        rootDirectory: '/project',
      });

      expect(emptyService.hasChildrenLoaded('')).toBe(false);

      emptyService.dispose();
    });

    it('should return true for root when direct root children exist', () => {
      expect(service.hasChildrenLoaded('')).toBe(true);
    });
  });

  // ── Directory resolution tracking (VS Code _isDirectoryResolved pattern) ──

  describe('directory resolution tracking', () => {
    it('should return false from hasChildrenLoaded for directory not yet loaded via loadDirectory', () => {
      const localService = new FileTreeService({
        proxy: createMockProxy(),
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir'), createEntry('main.ts')],
      });

      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      localService.dispose();
    });

    it('should return true from hasChildrenLoaded after loadDirectory resolves', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([
          { name: 'parameters', children: [{ name: 'main.ts.json' }] },
          { name: 'cache', children: [] },
        ]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });

      await localService.loadDirectory('.tau');

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has(parametersDirectory)).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);

      localService.dispose();
      vi.useFakeTimers();
    });

    it('should return false from hasChildrenLoaded after reset clears resolution state', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([{ name: 'parameters', children: [{ name: 'main.ts.json' }] }]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });

      await localService.loadDirectory('.tau');
      expect(localService.hasChildrenLoaded('.tau')).toBe(true);

      localService.reset('/project', [createEntry('.tau', 'dir')]);

      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      localService.dispose();
      vi.useFakeTimers();
    });

    it('should not mark directory as resolved from optimistic content read events', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        readDirectory: vi.fn().mockResolvedValue([
          { name: 'parameters', children: [{ name: 'main.ts.json' }] },
          { name: 'cache', children: [] },
          { name: 'artifacts', children: [] },
        ]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });
      const contentService = new FileContentService({ proxy: localProxy, rootDirectory: '/project' });
      localService.connectToContentService(contentService);

      await contentService.resolve(`${parametersDirectory}/main.ts.json`);

      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      await localService.loadDirectory('.tau');

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has(parametersDirectory)).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/artifacts')).toBe(true);

      contentService.dispose();
      localService.dispose();
      vi.useFakeTimers();
    });

    it('should not mark directory as resolved from optimistic content write events', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([
          { name: 'parameters', children: [{ name: 'main.ts.json' }] },
          { name: 'cache', children: [] },
        ]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });
      const contentService = new FileContentService({ proxy: localProxy, rootDirectory: '/project' });
      localService.connectToContentService(contentService);

      vi.mocked(localProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write(`${parametersDirectory}/main.ts.json`, new Uint8Array([1, 2, 3]), 'machine');

      expect(localService.getTreeSnapshot().has(`${parametersDirectory}/main.ts.json`)).toBe(true);
      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      await localService.loadDirectory('.tau');

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);

      contentService.dispose();
      localService.dispose();
      vi.useFakeTimers();
    });

    it('should mark directory as resolved after executeRefresh patches entries', async () => {
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([
          { name: 'parameters', children: [{ name: 'main.ts.json' }] },
          { name: 'cache', children: [] },
        ]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
        debounceMs: 10,
      });

      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      localService.scheduleRefresh('.tau');
      await vi.advanceTimersByTimeAsync(50);

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has(parametersDirectory)).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);

      localService.dispose();
    });
  });

  // ── R2: exists() async two-tier (F2) ──

  describe('exists (async two-tier)', () => {
    it('should return true for paths in the local tree without proxy call', async () => {
      expect(await service.exists('main.ts')).toBe(true);
      expect(proxy.stat).not.toHaveBeenCalled();
    });

    it('should return true for paths not in local tree but found via proxy.stat', async () => {
      vi.mocked(proxy.stat).mockResolvedValueOnce({ type: 'file', size: 42, mtimeMs: 1000 });

      expect(await service.exists('deep/nested/file.ts')).toBe(true);
      expect(proxy.stat).toHaveBeenCalledWith('/project/deep/nested/file.ts');
    });

    it('should return false when both local tree and proxy.stat miss', async () => {
      vi.mocked(proxy.stat).mockRejectedValueOnce(new Error('ENOENT'));

      expect(await service.exists('nonexistent.ts')).toBe(false);
    });
  });

  // ── R3: getEntry() async two-tier (F7) ──

  describe('getEntry (async two-tier)', () => {
    it('should return cached entry for paths in local tree', async () => {
      const entry = await service.getEntry('main.ts');
      expect(entry).toBeDefined();
      expect(entry?.path).toBe('main.ts');
      expect(entry?.type).toBe('file');
      expect(proxy.stat).not.toHaveBeenCalled();
    });

    it('should return entry from proxy.stat for paths not in local tree', async () => {
      vi.mocked(proxy.stat).mockResolvedValueOnce({ type: 'file', size: 42, mtimeMs: 1000 });

      const entry = await service.getEntry('deep/file.ts');

      expect(entry).toBeDefined();
      expect(entry?.path).toBe('deep/file.ts');
      expect(entry?.name).toBe('file.ts');
      expect(entry?.type).toBe('file');
      expect(entry?.size).toBe(42);
    });

    it('should return undefined when both tree and proxy miss', async () => {
      vi.mocked(proxy.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const entry = await service.getEntry('nonexistent.ts');

      expect(entry).toBeUndefined();
    });
  });

  // ── R5: deleteDirectory() (F4) ──

  describe('deleteDirectory', () => {
    it('should delete all nested files and the directory via proxy', async () => {
      const nestedFiles: FileStatEntry[] = [
        { path: '/project/src/a.ts', name: 'a.ts', type: 'file', size: 1, mtimeMs: 0 },
        { path: '/project/src/b.ts', name: 'b.ts', type: 'file', size: 1, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(nestedFiles);

      await service.deleteDirectory('src');

      expect(proxy.unlink).toHaveBeenCalledWith('/project/src/a.ts');
      expect(proxy.unlink).toHaveBeenCalledWith('/project/src/b.ts');
      expect(proxy.rmdir).toHaveBeenCalledWith('/project/src');
    });

    it('should remove deleted entries from the local tree snapshot', async () => {
      const localService = new FileTreeService({
        proxy,
        rootDirectory: '/project',
        initialEntries: [
          createEntry('src', 'dir'),
          createEntry('src/a.ts'),
          createEntry('src/b.ts'),
          createEntry('other.ts'),
        ],
      });
      const nestedFiles: FileStatEntry[] = [
        { path: '/project/src/a.ts', name: 'a.ts', type: 'file', size: 1, mtimeMs: 0 },
        { path: '/project/src/b.ts', name: 'b.ts', type: 'file', size: 1, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(nestedFiles);

      await localService.deleteDirectory('src');

      expect(localService.getTreeSnapshot().has('src')).toBe(false);
      expect(localService.getTreeSnapshot().has('src/a.ts')).toBe(false);
      expect(localService.getTreeSnapshot().has('src/b.ts')).toBe(false);
      expect(localService.getTreeSnapshot().has('other.ts')).toBe(true);

      localService.dispose();
    });

    it('should handle relative paths from getDirectoryStat (InMemoryFileTree built)', async () => {
      const relativeFiles: FileStatEntry[] = [
        { path: 'a.ts', name: 'a.ts', type: 'file', size: 1, mtimeMs: 0 },
        { path: 'sub/b.ts', name: 'b.ts', type: 'file', size: 1, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(relativeFiles);

      await service.deleteDirectory('.tau/cache');

      expect(proxy.unlink).toHaveBeenCalledWith('/project/.tau/cache/a.ts');
      expect(proxy.unlink).toHaveBeenCalledWith('/project/.tau/cache/sub/b.ts');
      expect(proxy.rmdir).toHaveBeenCalledWith('/project/.tau/cache');
    });

    it('should rmdir subdirectories deepest-first before top-level directory', async () => {
      const relativeFiles: FileStatEntry[] = [
        { path: 'root-file.glb', name: 'root-file.glb', type: 'file', size: 1, mtimeMs: 0 },
        { path: 'meshes/part.glb', name: 'part.glb', type: 'file', size: 1, mtimeMs: 0 },
        { path: 'meshes/sub/nested.glb', name: 'nested.glb', type: 'file', size: 1, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(relativeFiles);

      await service.deleteDirectory('.tau/cache');

      const rmdirCalls = vi.mocked(proxy.rmdir).mock.calls.map((c) => c[0]);
      expect(rmdirCalls).toEqual([
        '/project/.tau/cache/meshes/sub',
        '/project/.tau/cache/meshes',
        '/project/.tau/cache',
      ]);
    });

    it('should prune tree even when getDirectoryStat returns relative paths', async () => {
      const localService = new FileTreeService({
        proxy,
        rootDirectory: '/project',
        initialEntries: [
          createEntry('.tau', 'dir'),
          createEntry('.tau/cache', 'dir'),
          createEntry('.tau/cache/model.glb'),
          createEntry('main.ts'),
        ],
      });
      const relativeFiles: FileStatEntry[] = [
        { path: 'model.glb', name: 'model.glb', type: 'file', size: 1, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(relativeFiles);

      await localService.deleteDirectory('.tau/cache');

      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(false);
      expect(localService.getTreeSnapshot().has('.tau/cache/model.glb')).toBe(false);
      expect(localService.getTreeSnapshot().has('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has('main.ts')).toBe(true);

      localService.dispose();
    });
  });

  // ── R6: readDirectoryEntries() (F3) ──

  describe('readDirectoryEntries', () => {
    it('should return directory entries from proxy', async () => {
      const nodes: FileTreeNode[] = [
        { id: 'a.ts', name: 'a.ts' },
        { id: 'b.ts', name: 'b.ts' },
      ];
      vi.mocked(proxy.readDirectory).mockResolvedValueOnce(nodes);

      const result = await service.readDirectoryEntries('lib');

      expect(result).toEqual(nodes);
      expect(proxy.readDirectory).toHaveBeenCalledWith('/project/lib');
    });
  });

  // ── R8: handleContentChange 'read' events (F1, F6, F7) ──

  describe('content read events', () => {
    it('should not add file to tree when content service emits a read event', async () => {
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      service.connectToContentService(contentService);

      expect(service.getTreeSnapshot().has('newfile.ts')).toBe(false);

      vi.mocked(contentProxy.readFile).mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));
      await contentService.resolve('newfile.ts');

      expect(service.getTreeSnapshot().has('newfile.ts')).toBe(false);

      contentService.dispose();
    });
  });

  // ── R10: getCachedFileItems (tree-derived, sync, no worker RPC) ──

  describe('getCachedFileItems', () => {
    it('should return file items derived from the tree without calling getDirectoryStat', () => {
      const items = service.getCachedFileItems();

      expect(items).toHaveLength(3);
      expect(items).toEqual(
        expect.arrayContaining([
          { path: 'main.ts', size: 100 },
          { path: 'lib/utils.ts', size: 100 },
          { path: 'lib/helpers.ts', size: 100 },
        ]),
      );
      expect(proxy.getDirectoryStat).not.toHaveBeenCalled();
    });

    it('should return only file entries and exclude directories', () => {
      const localService = new FileTreeService({
        proxy: createMockProxy(),
        rootDirectory: '/project',
        initialEntries: [createEntry('main.ts'), createEntry('lib', 'dir'), createEntry('lib/utils.ts')],
      });

      const items = localService.getCachedFileItems();
      expect(items).toHaveLength(2);
      expect(items.every((item) => !item.path.endsWith('lib') || item.path.includes('/'))).toBe(true);
      expect(items.find((item) => item.path === 'lib')).toBeUndefined();

      localService.dispose();
    });

    it('should return same reference on consecutive calls without tree changes', () => {
      const first = service.getCachedFileItems();
      const second = service.getCachedFileItems();

      expect(first).toBe(second);
    });

    it('should invalidate cache when optimistic add occurs', async () => {
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      service.connectToContentService(contentService);

      const before = service.getCachedFileItems();
      expect(before).toHaveLength(3);

      vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write('new.ts', new Uint8Array([1, 2, 3]), 'user');

      const after = service.getCachedFileItems();
      expect(after).not.toBe(before);
      expect(after).toHaveLength(4);
      expect(after.find((item) => item.path === 'new.ts')).toEqual({ path: 'new.ts', size: 3 });

      contentService.dispose();
    });

    it('should invalidate cache when optimistic delete occurs', async () => {
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      service.connectToContentService(contentService);

      const before = service.getCachedFileItems();
      expect(before).toHaveLength(3);

      vi.mocked(contentProxy.unlink).mockResolvedValue(undefined);
      await contentService.delete('main.ts', 'user');

      const after = service.getCachedFileItems();
      expect(after).toHaveLength(2);
      expect(after.find((item) => item.path === 'main.ts')).toBeUndefined();

      contentService.dispose();
    });

    it('should reflect newly loaded directories after loadDirectory', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([
          { id: 'cache', name: 'cache', children: [] },
          { id: 'params.json', name: 'params.json' },
        ]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('main.ts'), createEntry('.tau', 'dir')],
      });

      const before = localService.getCachedFileItems();
      expect(before).toHaveLength(1);

      await localService.loadDirectory('.tau');

      const after = localService.getCachedFileItems();
      expect(after).toHaveLength(2);
      expect(after.find((item) => item.path === '.tau/params.json')).toBeDefined();

      localService.dispose();
      vi.useFakeTimers();
    });

    it('should return empty array when tree has no file entries', () => {
      const emptyService = new FileTreeService({
        proxy: createMockProxy(),
        rootDirectory: '/project',
        initialEntries: [createEntry('lib', 'dir'), createEntry('src', 'dir')],
      });

      const items = emptyService.getCachedFileItems();
      expect(items).toHaveLength(0);

      emptyService.dispose();
    });

    it('should invalidate cache after reset', () => {
      const first = service.getCachedFileItems();
      expect(first).toHaveLength(3);

      service.reset('/project', [createEntry('x.ts', 'file', 42)]);

      const after = service.getCachedFileItems();
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual({ path: 'x.ts', size: 42 });
    });

    it('should expose completeTreeVersion that increments on change', async () => {
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      service.connectToContentService(contentService);

      const v1 = service.completeTreeVersion;

      vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write('z.ts', new Uint8Array([1]), 'user');

      const v2 = service.completeTreeVersion;
      expect(v2).toBeGreaterThan(v1);

      contentService.dispose();
    });
  });

  describe('searchFiles', () => {
    it('should delegate to proxy.searchFiles with correct root path', async () => {
      const mockResults: FileStatEntry[] = [
        { path: 'src/main.ts', name: 'main.ts', type: 'file', size: 100, mtimeMs: 1000 },
      ];
      const searchProxy = createMockProxy({
        searchFiles: vi.fn().mockReturnValue(mockResults) as unknown as FileManagerProxy['searchFiles'],
      });
      const searchService = new FileTreeService({ proxy: searchProxy, rootDirectory: '/project' });

      const results = await searchService.searchFiles('main');
      expect(searchProxy.searchFiles).toHaveBeenCalledWith('/project', 'main', undefined);
      expect(results).toEqual(mockResults);

      searchService.dispose();
    });

    it('should forward query and options', async () => {
      const searchProxy = createMockProxy({
        searchFiles: vi.fn().mockReturnValue([]) as unknown as FileManagerProxy['searchFiles'],
      });
      const searchService = new FileTreeService({ proxy: searchProxy, rootDirectory: '/project' });

      await searchService.searchFiles('utils', { maxResults: 50, includeDirectories: true });
      expect(searchProxy.searchFiles).toHaveBeenCalledWith('/project', 'utils', {
        maxResults: 50,
        includeDirectories: true,
      });

      searchService.dispose();
    });

    it('should return FileStatEntry[] from proxy', async () => {
      const expected: FileStatEntry[] = [
        { path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 },
        { path: 'b.ts', name: 'b.ts', type: 'file', size: 20, mtimeMs: 200 },
      ];
      const searchProxy = createMockProxy({
        searchFiles: vi.fn().mockReturnValue(expected) as unknown as FileManagerProxy['searchFiles'],
      });
      const searchService = new FileTreeService({ proxy: searchProxy, rootDirectory: '/project' });

      const results = await searchService.searchFiles('.ts');
      expect(results).toHaveLength(2);
      expect(results[0]!.path).toBe('a.ts');

      searchService.dispose();
    });

    it('should warm the worker search index via getDirectoryStat on first call', async () => {
      const warmProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue([]),
        searchFiles: vi.fn().mockReturnValue([]) as unknown as FileManagerProxy['searchFiles'],
      });
      const warmService = new FileTreeService({ proxy: warmProxy, rootDirectory: '/project' });

      await warmService.searchFiles('main');
      expect(warmProxy.getDirectoryStat).toHaveBeenCalledWith('/project');

      await warmService.searchFiles('utils');
      expect(warmProxy.getDirectoryStat).toHaveBeenCalledOnce();

      warmService.dispose();
    });

    it('should re-warm the search index after reset()', async () => {
      const resetProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue([]),
        searchFiles: vi.fn().mockReturnValue([]) as unknown as FileManagerProxy['searchFiles'],
      });
      const resetService = new FileTreeService({ proxy: resetProxy, rootDirectory: '/project' });

      await resetService.searchFiles('main');
      expect(resetProxy.getDirectoryStat).toHaveBeenCalledOnce();

      resetService.reset('/new-project');

      await resetService.searchFiles('main');
      expect(resetProxy.getDirectoryStat).toHaveBeenCalledTimes(2);
      expect(resetProxy.getDirectoryStat).toHaveBeenLastCalledWith('/new-project');

      resetService.dispose();
    });
  });

  // === handleWorkerFileChanged (R11: structured incremental tree events) ===

  describe('handleWorkerFileChanged', () => {
    // ── R11: fileWritten — optimistic add when parent loaded, skip when not ──

    it('should optimistically add file to tree on fileWritten when parent is loaded', () => {
      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/newfile.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);

      expect(service.getTreeSnapshot().has('newfile.ts')).toBe(true);
      expect(service.getTreeSnapshot().get('newfile.ts')?.type).toBe('file');
      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    it('should skip fileWritten when parent directory is not loaded', async () => {
      const localService = new FileTreeService({
        proxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('main.ts'), createEntry('.tau', 'dir')],
      });

      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/.tau/cache/params.json',
        backend: 'indexeddb',
      };

      const snapshotBefore = localService.getTreeSnapshot();
      localService.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(localService.getTreeSnapshot()).toBe(snapshotBefore);
      expect(proxy.readDirectory).not.toHaveBeenCalled();

      localService.dispose();
    });

    it('should notify subscribers on fileWritten optimistic add', () => {
      const subscriber = vi.fn();
      service.subscribeTree(subscriber);

      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/added.ts',
        backend: 'indexeddb',
      };
      service.handleWorkerFileChanged(event);

      expect(subscriber).toHaveBeenCalledOnce();
    });

    // ── R11: fileDeleted — optimistic delete ──

    it('should optimistically remove file from tree on fileDeleted', () => {
      expect(service.getTreeSnapshot().has('main.ts')).toBe(true);

      const event: ChangeEvent = {
        type: 'fileDeleted',
        path: '/project/main.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);

      expect(service.getTreeSnapshot().has('main.ts')).toBe(false);
      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    it('should not call readDirectory on fileDeleted for unknown path', async () => {
      const event: ChangeEvent = {
        type: 'fileDeleted',
        path: '/project/nonexistent.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    // ── R11: fileRenamed — optimistic rename ──

    it('should optimistically rename file in tree on fileRenamed', () => {
      expect(service.getTreeSnapshot().has('main.ts')).toBe(true);

      const event: ChangeEvent = {
        type: 'fileRenamed',
        oldPath: '/project/main.ts',
        newPath: '/project/app.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);

      expect(service.getTreeSnapshot().has('main.ts')).toBe(false);
      expect(service.getTreeSnapshot().has('app.ts')).toBe(true);
      expect(service.getTreeSnapshot().get('app.ts')?.name).toBe('app.ts');
      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    it('should handle cross-directory rename optimistically without readDirectory', () => {
      expect(service.getTreeSnapshot().has('main.ts')).toBe(true);

      const event: ChangeEvent = {
        type: 'fileRenamed',
        oldPath: '/project/main.ts',
        newPath: '/project/lib/main.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);

      expect(service.getTreeSnapshot().has('main.ts')).toBe(false);
      expect(service.getTreeSnapshot().has('lib/main.ts')).toBe(true);
      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    // ── R11: directoryChanged — refresh only when loaded ──

    it('should refresh on directoryChanged when directory is loaded', async () => {
      const event: ChangeEvent = {
        type: 'directoryChanged',
        path: '/project',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project');
    });

    it('should skip refresh on directoryChanged when directory is not loaded', async () => {
      const localService = new FileTreeService({
        proxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('main.ts'), createEntry('.tau', 'dir')],
      });

      const event: ChangeEvent = {
        type: 'directoryChanged',
        path: '/project/.tau',
        backend: 'indexeddb',
      };

      localService.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).not.toHaveBeenCalled();

      localService.dispose();
    });

    // ── backendChanged — full refresh (unchanged behavior) ──

    it('should fall back to root refresh for backendChanged events', async () => {
      const event: ChangeEvent = {
        type: 'backendChanged',
        backend: 'opfs',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project');
    });

    // ── Scope filtering (unchanged behavior) ──

    it('should ignore events outside rootDirectory scope', async () => {
      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/other-project/file.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).not.toHaveBeenCalled();
      expect(service.getTreeSnapshot().size).toBe(3);
    });
  });
});
