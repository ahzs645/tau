import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileTreeService } from '#lib/file-tree-service.js';
import { FileContentService } from '#lib/file-content-service.js';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { ChangeEvent, FileEntry, FileStatEntry } from '@taucad/types';
import type { FileTreeNode } from '@taucad/filesystem';

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
        readDirectory: vi.fn().mockResolvedValue([{ name: 'parameters.json' }, { name: 'cache', children: [] }]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });

      await localService.loadDirectory('.tau');

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/parameters.json')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);

      localService.dispose();
      vi.useFakeTimers();
    });

    it('should return false from hasChildrenLoaded after reset clears resolution state', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([{ name: 'parameters.json' }]),
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
        readDirectory: vi
          .fn()
          .mockResolvedValue([
            { name: 'parameters.json' },
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

      await contentService.resolve('.tau/parameters.json');

      expect(localService.hasChildrenLoaded('.tau')).toBe(false);

      await localService.loadDirectory('.tau');

      expect(localService.hasChildrenLoaded('.tau')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/parameters.json')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/cache')).toBe(true);
      expect(localService.getTreeSnapshot().has('.tau/artifacts')).toBe(true);

      contentService.dispose();
      localService.dispose();
      vi.useFakeTimers();
    });

    it('should not mark directory as resolved from optimistic content write events', async () => {
      vi.useRealTimers();
      const localProxy = createMockProxy({
        readDirectory: vi.fn().mockResolvedValue([{ name: 'parameters.json' }, { name: 'cache', children: [] }]),
      });
      const localService = new FileTreeService({
        proxy: localProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('.tau', 'dir')],
      });
      const contentService = new FileContentService({ proxy: localProxy, rootDirectory: '/project' });
      localService.connectToContentService(contentService);

      vi.mocked(localProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write('.tau/parameters.json', new Uint8Array([1, 2, 3]), 'machine');

      expect(localService.getTreeSnapshot().has('.tau/parameters.json')).toBe(true);
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
        readDirectory: vi.fn().mockResolvedValue([{ name: 'parameters.json' }, { name: 'cache', children: [] }]),
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
      expect(localService.getTreeSnapshot().has('.tau/parameters.json')).toBe(true);
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

  // ── R4: getCompleteFileTree() (F6, F8, F9) ──

  describe('getCompleteFileTree', () => {
    it('should return complete file tree with relative paths', async () => {
      const allFiles: FileStatEntry[] = [
        { path: '/project/main.ts', name: 'main.ts', type: 'file', size: 100, mtimeMs: 0 },
        { path: '/project/lib/utils.ts', name: 'utils.ts', type: 'file', size: 200, mtimeMs: 0 },
      ];
      vi.mocked(proxy.getDirectoryStat).mockResolvedValueOnce(allFiles);

      const result = await service.getCompleteFileTree();

      expect(result).toEqual([
        expect.objectContaining({ path: 'main.ts' }),
        expect.objectContaining({ path: 'lib/utils.ts' }),
      ]);
      expect(proxy.getDirectoryStat).toHaveBeenCalledWith('/project');
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

  describe('getCachedFileItems', () => {
    it('should return FileItem[] from getCachedFileItems', async () => {
      const entries: FileStatEntry[] = [
        { path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 },
        { path: 'b.ts', name: 'b.ts', type: 'file', size: 20, mtimeMs: 200 },
      ];
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue(entries),
      });
      const cacheService = new FileTreeService({ proxy: cacheProxy, rootDirectory: '/project' });

      const items = await cacheService.getCachedFileItems();
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ path: 'a.ts', size: 10 });

      cacheService.dispose();
    });

    it('should return same reference on consecutive calls without changes', async () => {
      const entries: FileStatEntry[] = [{ path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 }];
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue(entries),
      });
      const cacheService = new FileTreeService({ proxy: cacheProxy, rootDirectory: '/project' });

      const first = await cacheService.getCachedFileItems();
      const second = await cacheService.getCachedFileItems();
      expect(first).toBe(second);
      expect(cacheProxy.getDirectoryStat).toHaveBeenCalledTimes(1);

      cacheService.dispose();
    });

    it('should invalidate cache when optimisticAdd is called', async () => {
      const entries: FileStatEntry[] = [{ path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 }];
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue(entries),
        readDirectory: vi.fn().mockResolvedValue([]),
      });
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      const cacheService = new FileTreeService({ proxy: cacheProxy, rootDirectory: '/project' });
      cacheService.connectToContentService(contentService);

      await cacheService.getCachedFileItems();
      expect(cacheProxy.getDirectoryStat).toHaveBeenCalledTimes(1);

      vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write('new.ts', new Uint8Array([1, 2, 3]), 'user');

      const updatedEntries: FileStatEntry[] = [
        { path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 },
        { path: 'new.ts', name: 'new.ts', type: 'file', size: 3, mtimeMs: 200 },
      ];
      vi.mocked(cacheProxy.getDirectoryStat).mockResolvedValue(updatedEntries);

      const items = await cacheService.getCachedFileItems();
      expect(cacheProxy.getDirectoryStat).toHaveBeenCalledTimes(2);
      expect(items).toHaveLength(2);

      contentService.dispose();
      cacheService.dispose();
    });

    it('should invalidate cache when optimisticDelete is called', async () => {
      const entries: FileStatEntry[] = [{ path: 'a.ts', name: 'a.ts', type: 'file', size: 10, mtimeMs: 100 }];
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue(entries),
        readDirectory: vi.fn().mockResolvedValue([]),
      });
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      const cacheService = new FileTreeService({
        proxy: cacheProxy,
        rootDirectory: '/project',
        initialEntries: [createEntry('a.ts')],
      });
      cacheService.connectToContentService(contentService);

      await cacheService.getCachedFileItems();

      vi.mocked(contentProxy.unlink).mockResolvedValue(undefined);
      await contentService.delete('a.ts', 'user');

      vi.mocked(cacheProxy.getDirectoryStat).mockResolvedValue([]);
      const items = await cacheService.getCachedFileItems();
      expect(items).toHaveLength(0);

      contentService.dispose();
      cacheService.dispose();
    });

    it('should re-fetch from worker after invalidation', async () => {
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue([]),
      });
      const cacheService = new FileTreeService({ proxy: cacheProxy, rootDirectory: '/project' });

      await cacheService.getCachedFileItems();
      await cacheService.getCachedFileItems();
      expect(cacheProxy.getDirectoryStat).toHaveBeenCalledTimes(1);

      cacheService.reset('/project');
      const afterReset: FileStatEntry[] = [{ path: 'x.ts', name: 'x.ts', type: 'file', size: 5, mtimeMs: 50 }];
      vi.mocked(cacheProxy.getDirectoryStat).mockResolvedValue(afterReset);

      const items = await cacheService.getCachedFileItems();
      expect(cacheProxy.getDirectoryStat).toHaveBeenCalledTimes(2);
      expect(items).toHaveLength(1);

      cacheService.dispose();
    });

    it('should expose completeTreeVersion that increments on change', async () => {
      const cacheProxy = createMockProxy({
        getDirectoryStat: vi.fn().mockResolvedValue([]),
        readDirectory: vi.fn().mockResolvedValue([]),
      });
      const contentProxy = createMockProxy();
      const contentService = new FileContentService({ proxy: contentProxy, rootDirectory: '/project' });
      const cacheService = new FileTreeService({ proxy: cacheProxy, rootDirectory: '/project' });
      cacheService.connectToContentService(contentService);

      const v1 = cacheService.completeTreeVersion;

      vi.mocked(contentProxy.writeFile).mockResolvedValue(undefined);
      await contentService.write('z.ts', new Uint8Array([1]), 'user');

      const v2 = cacheService.completeTreeVersion;
      expect(v2).toBeGreaterThan(v1);

      contentService.dispose();
      cacheService.dispose();
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
  });

  // === handleWorkerFileChanged ===

  describe('handleWorkerFileChanged', () => {
    it('should refresh parent directory when receiving fileWritten event', async () => {
      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/.tau/cache/params.json',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project/.tau/cache');
    });

    it('should refresh parent of newPath when receiving fileRenamed event', async () => {
      const event: ChangeEvent = {
        type: 'fileRenamed',
        oldPath: '/project/old.ts',
        newPath: '/project/lib/new.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project/lib');
    });

    it('should fall back to root refresh for backendChanged events', async () => {
      const event: ChangeEvent = {
        type: 'backendChanged',
        backend: 'opfs',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project');
    });

    it('should ignore events outside rootDirectory scope', async () => {
      const event: ChangeEvent = {
        type: 'fileWritten',
        path: '/other-project/file.ts',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).not.toHaveBeenCalled();
    });

    it('should refresh parent directory when receiving directoryChanged event', async () => {
      const event: ChangeEvent = {
        type: 'directoryChanged',
        path: '/project/.tau/cache',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledWith('/project/.tau');
    });

    it('should coalesce rapid worker events to common ancestor', async () => {
      const event1: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/.tau/cache/a.json',
        backend: 'indexeddb',
      };
      const event2: ChangeEvent = {
        type: 'fileWritten',
        path: '/project/.tau/artifacts/b.json',
        backend: 'indexeddb',
      };

      service.handleWorkerFileChanged(event1);
      service.handleWorkerFileChanged(event2);
      await vi.advanceTimersByTimeAsync(200);

      expect(proxy.readDirectory).toHaveBeenCalledOnce();
      expect(proxy.readDirectory).toHaveBeenCalledWith('/project/.tau');
    });
  });
});
