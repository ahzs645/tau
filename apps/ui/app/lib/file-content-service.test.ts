import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileContentService } from '#lib/file-content-service.js';
import { SharedPool } from '@taucad/memory';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';
import type { ContentChangeEvent } from '#lib/file-content-service.js';

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
    dispose: vi.fn(),
    ...overrides,
  } as unknown as FileManagerProxy;
}

describe('FileContentService', () => {
  let proxy: FileManagerProxy;
  let service: FileContentService;

  beforeEach(() => {
    proxy = createMockProxy();
    service = new FileContentService({
      proxy,
      rootDirectory: '/project',
    });
  });

  it('should resolve content from worker on cache miss', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).toHaveBeenCalledWith('/project/main.ts');
    expect(result).toEqual(data);
  });

  it('should return cached content without worker call on cache hit', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('main.ts');
    vi.mocked(proxy.readFile).mockClear();

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).not.toHaveBeenCalled();
    expect(result).toEqual(data);
  });

  it('should join pending resolves for concurrent reads of same path', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const [result1, result2] = await Promise.all([service.resolve('main.ts'), service.resolve('main.ts')]);

    expect(proxy.readFile).toHaveBeenCalledTimes(1);
    expect(result1).toBe(result2);
  });

  it('should clone buffer before transfer on write, keeping valid local copy', async () => {
    const original = new Uint8Array([1, 2, 3]);

    await service.write('main.ts', original, 'machine');

    expect(proxy.writeFile).toHaveBeenCalledWith('/project/main.ts', original);

    const cached = service.peek('main.ts');
    expect(cached).toBeDefined();
    expect(cached).toEqual(new Uint8Array([1, 2, 3]));
    expect(cached).not.toBe(original);
  });

  it('should fire onDidContentChange with valid data after write', async () => {
    const handler = vi.fn<(event: ContentChangeEvent) => void>();
    service.onDidContentChange(handler);

    const data = new Uint8Array([1, 2, 3]);
    await service.write('main.ts', data, 'editor');

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0]![0];
    expect(event.type).toBe('written');
    if (event.type === 'written') {
      expect(event.path).toBe('main.ts');
      expect(event.source).toBe('editor');
      expect(event.data.byteLength).toBe(3);
    }
  });

  it('should update cache on rename', async () => {
    const data = new Uint8Array([1, 2, 3]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('old.ts');
    await service.rename('old.ts', 'new.ts');

    expect(service.has('old.ts')).toBe(false);
    expect(service.has('new.ts')).toBe(true);
    expect(service.peek('new.ts')).toEqual(data);
  });

  it('should fire content change on delete', async () => {
    const handler = vi.fn<(event: ContentChangeEvent) => void>();
    service.onDidContentChange(handler);

    const data = new Uint8Array([1]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);
    await service.resolve('main.ts');

    handler.mockClear();

    await service.delete('main.ts', 'user');

    expect(service.has('main.ts')).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].type).toBe('deleted');
  });

  it('should return data without LRU promotion via peek()', async () => {
    const data = new Uint8Array([1]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('main.ts');

    const peeked = service.peek('main.ts');
    expect(peeked).toEqual(data);
  });

  it('should clone each file buffer on writeFiles', async () => {
    const file1 = new Uint8Array([1, 2]);
    const file2 = new Uint8Array([3, 4]);

    const filePathA = 'a.ts';
    const filePathB = 'b.ts';
    await service.writeFiles({ [filePathA]: { content: file1 }, [filePathB]: { content: file2 } }, 'machine');

    expect(proxy.writeFiles).toHaveBeenCalledOnce();

    const cachedA = service.peek('a.ts');
    const cachedB = service.peek('b.ts');
    expect(cachedA).toEqual(new Uint8Array([1, 2]));
    expect(cachedB).toEqual(new Uint8Array([3, 4]));
    expect(cachedA).not.toBe(file1);
    expect(cachedB).not.toBe(file2);
  });

  it('should notify path subscribers on write', async () => {
    const callback = vi.fn();
    service.subscribe('main.ts', callback);

    await service.write('main.ts', new Uint8Array([1]), 'user');

    expect(callback).toHaveBeenCalledOnce();
  });

  it('should notify path subscribers on resolve (cache population)', async () => {
    const callback = vi.fn();
    service.subscribe('main.ts', callback);

    vi.mocked(proxy.readFile).mockResolvedValue(new Uint8Array([1]));
    await service.resolve('main.ts');

    expect(callback).toHaveBeenCalledOnce();
  });

  it('should call proxy.copyDirectory for copyDirectory', async () => {
    await service.copyDirectory('/src', '/dest');

    expect(proxy.copyDirectory).toHaveBeenCalledWith('/src', '/dest');
  });

  it('should call proxy.getZippedDirectory for getZippedDirectory', async () => {
    const blob = new Blob(['zip']);
    vi.mocked(proxy.getZippedDirectory).mockResolvedValue(blob);

    const result = await service.getZippedDirectory('/project');

    expect(proxy.getZippedDirectory).toHaveBeenCalledWith('/project');
    expect(result).toBe(blob);
  });

  // ── Orphan Tracking (VS Code inOrphanMode pattern) ──

  describe('orphan tracking', () => {
    function createEnoentError(path: string): Error {
      const error = new Error(`ENOENT: no such file or directory '${path}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      return error;
    }

    it('should mark path as orphaned when resolve rejects with file-not-found', async () => {
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/missing.ts'));

      expect(service.isOrphaned('missing.ts')).toBe(false);

      await expect(service.resolve('missing.ts')).rejects.toThrow('ENOENT');

      expect(service.isOrphaned('missing.ts')).toBe(true);
    });

    it('should clear orphan when resolve succeeds', async () => {
      vi.mocked(proxy.readFile).mockRejectedValueOnce(createEnoentError('/project/main.ts'));
      await expect(service.resolve('main.ts')).rejects.toThrow('ENOENT');
      expect(service.isOrphaned('main.ts')).toBe(true);

      vi.mocked(proxy.readFile).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
      service.reset('/project');
      await service.resolve('main.ts');

      expect(service.isOrphaned('main.ts')).toBe(false);
    });

    it('should clear orphan when write succeeds', async () => {
      vi.mocked(proxy.readFile).mockRejectedValueOnce(createEnoentError('/project/main.ts'));
      await expect(service.resolve('main.ts')).rejects.toThrow('ENOENT');
      expect(service.isOrphaned('main.ts')).toBe(true);

      await service.write('main.ts', new Uint8Array([1]), 'user');

      expect(service.isOrphaned('main.ts')).toBe(false);
    });

    it('should set orphan when delete is called', async () => {
      vi.mocked(proxy.readFile).mockResolvedValue(new Uint8Array([1]));
      await service.resolve('main.ts');
      expect(service.isOrphaned('main.ts')).toBe(false);

      await service.delete('main.ts', 'user');

      expect(service.isOrphaned('main.ts')).toBe(true);
    });

    it('should fire onDidChangeOrphaned event on orphan state transition', async () => {
      const handler = vi.fn<(event: { path: string; orphaned: boolean }) => void>();
      service.onDidChangeOrphaned(handler);

      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/main.ts'));
      await expect(service.resolve('main.ts')).rejects.toThrow('ENOENT');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ path: 'main.ts', orphaned: true });
    });

    it('should not fire onDidChangeOrphaned when state is unchanged', async () => {
      const handler = vi.fn<(event: { path: string; orphaned: boolean }) => void>();
      service.onDidChangeOrphaned(handler);

      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/main.ts'));
      await expect(service.resolve('main.ts')).rejects.toThrow('ENOENT');
      handler.mockClear();

      service.reset('/project');
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/main.ts'));
      await expect(service.resolve('main.ts')).rejects.toThrow('ENOENT');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should clear all orphans on reset', async () => {
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/a.ts'));
      await expect(service.resolve('a.ts')).rejects.toThrow('ENOENT');
      expect(service.isOrphaned('a.ts')).toBe(true);

      service.reset('/project');

      expect(service.isOrphaned('a.ts')).toBe(false);
    });
  });

  describe('cache capacity', () => {
    it('should accept 500 entries before eviction with default cache options', async () => {
      const svc = new FileContentService({
        proxy: createMockProxy({
          readFile: vi.fn().mockImplementation(async () => new Uint8Array([1])),
        }),
        rootDirectory: '/project',
      });

      for (let i = 0; i < 500; i++) {
        // oxlint-disable-next-line no-await-in-loop -- Sequential cache population required
        await svc.resolve(`file-${i}.ts`);
      }

      for (let i = 0; i < 500; i++) {
        expect(svc.peek(`file-${i}.ts`)).toBeDefined();
      }
    });
  });

  describe('SharedPool integration', () => {
    const encoder = new TextEncoder();

    function createPoolService() {
      const buffer = new SharedArrayBuffer(128 * 1024);
      const pool = new SharedPool(buffer, { maxEntries: 128 });
      const mockProxy = createMockProxy();
      const svc = new FileContentService({
        proxy: mockProxy,
        rootDirectory: '/project',
        filePool: pool,
      });
      return { service: svc, pool, proxy: mockProxy };
    }

    it('should resolve from shared pool on BoundedFileCache miss', async () => {
      const { service: svc, pool, proxy: mockProxy } = createPoolService();

      pool.store('/project/pooled.ts', encoder.encode('pool content'));

      const result = await svc.resolve('pooled.ts');
      expect(new TextDecoder().decode(result)).toBe('pool content');
      expect(mockProxy.readFile).not.toHaveBeenCalled();
    });

    it('should fall through to worker RPC on double miss', async () => {
      const { service: svc, proxy: mockProxy } = createPoolService();

      const workerData = new Uint8Array([7, 8, 9]);
      vi.mocked(mockProxy.readFile).mockResolvedValue(workerData);

      const result = await svc.resolve('worker-only.ts');
      expect(mockProxy.readFile).toHaveBeenCalledWith('/project/worker-only.ts');
      expect(result).toEqual(workerData);
    });

    it('should preserve existing BoundedFileCache behavior', async () => {
      const { service: svc, proxy: mockProxy } = createPoolService();

      const workerData = new Uint8Array([1, 2, 3]);
      vi.mocked(mockProxy.readFile).mockResolvedValue(workerData);

      await svc.resolve('cached.ts');
      vi.mocked(mockProxy.readFile).mockClear();

      const result = await svc.resolve('cached.ts');
      expect(mockProxy.readFile).not.toHaveBeenCalled();
      expect(result).toEqual(workerData);
    });
  });
});
