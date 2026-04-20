import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { FileContentService } from '#lib/file-content-service.js';
import type { ContentChangeEvent, FileContentResult, OutcomeChangeEvent } from '#lib/file-content-service.js';
import { BinaryFileError, FileNotFoundError, FileTooLargeError } from '#lib/file-content-errors.js';
import { SharedPool } from '@taucad/memory';
import type { FileManagerProxy } from '#machines/file-manager.machine.types.js';

function createMockProxy(overrides?: Partial<FileManagerProxy>): FileManagerProxy {
  const proxy = mock<FileManagerProxy>({
    readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFiles: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    copyDirectory: vi.fn().mockResolvedValue(undefined),
    getZippedDirectory: vi.fn().mockResolvedValue(new Blob()),
    duplicateFile: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  });
  if (overrides) {
    Object.assign(proxy, overrides);
  }
  return proxy;
}

function expectTextContent(result: FileContentResult, expected: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  expect(result.kind).toBe('text');
  if (result.kind !== 'text') {
    throw new Error(`Expected text outcome, got ${result.kind}`);
  }
  expect(result.content).toEqual(expected);
  return result.content;
}

function makeAsciiBuffer(byteLength: number): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(byteLength);
  buffer.fill(0x41);
  return buffer;
}

describe('FileContentService', () => {
  let proxy: FileManagerProxy;
  let service: FileContentService;

  beforeEach(() => {
    proxy = createMockProxy();
    service = new FileContentService({
      proxy,
      rootDirectory: '/project',
      // Use a high open limit by default so tests opt-in to too-large scenarios.
      openSizeBytes: 50 * 1024 * 1024,
    });
  });

  it('should resolve text content from worker on cache miss', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).toHaveBeenCalledWith('/project/main.ts');
    expectTextContent(result, data);
  });

  it('should return cached text content without worker call on cache hit', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    await service.resolve('main.ts');
    vi.mocked(proxy.readFile).mockClear();

    const result = await service.resolve('main.ts');

    expect(proxy.readFile).not.toHaveBeenCalled();
    expectTextContent(result, data);
  });

  it('should join pending resolves for concurrent reads of same path', async () => {
    const data = new Uint8Array([10, 20, 30]);
    vi.mocked(proxy.readFile).mockResolvedValue(data);

    const [first, second] = await Promise.all([service.resolve('main.ts'), service.resolve('main.ts')]);

    expect(proxy.readFile).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
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

  it('should notify path subscribers on resolve (outcome change)', async () => {
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

  describe('peekOutcome (B1)', () => {
    it('should return loading kind before any resolve', () => {
      expect(service.peekOutcome('main.ts')).toEqual({ kind: 'loading' });
    });

    it('should return a referentially stable loading sentinel for unresolved paths', () => {
      // `useSyncExternalStore` requires getSnapshot to be referentially stable
      // when nothing has changed. Returning a fresh `{ kind: 'loading' }` on
      // every call previously caused a crash-loop where the project tree was
      // continuously remounted by the surrounding error boundary.
      const first = service.peekOutcome('main.ts');
      const second = service.peekOutcome('main.ts');
      const third = service.peekOutcome('other.ts');

      expect(first).toBe(second);
      expect(first).toBe(third);
    });

    it('should return text outcome after a successful resolve', async () => {
      const data = new Uint8Array([1, 2, 3]);
      vi.mocked(proxy.readFile).mockResolvedValue(data);

      await service.resolve('main.ts');

      const outcome = service.peekOutcome('main.ts');
      expect(outcome.kind).toBe('text');
      if (outcome.kind === 'text') {
        expect(outcome.content).toEqual(data);
      }
    });
  });

  describe('discriminated resolve outcomes (R1, B2)', () => {
    it('should produce binary outcome when content sniffs as binary', async () => {
      const binaryBytes = new Uint8Array(5 * 1024 * 1024);
      binaryBytes[0] = 0x00;
      vi.mocked(proxy.readFile).mockResolvedValue(binaryBytes);

      const result = await service.resolve('mystery.dat');

      expect(result.kind).toBe('binary');
      if (result.kind === 'binary') {
        expect(result.size).toBe(5 * 1024 * 1024);
        expect(result.head.byteLength).toBe(512);
        expect(result.head[0]).toBe(0x00);
      }
      expect(service.peek('mystery.dat')).toBeUndefined();
    });

    it('should produce too-large outcome when ASCII content exceeds open limit', async () => {
      const tinyService = new FileContentService({
        proxy,
        rootDirectory: '/project',
        openSizeBytes: 1024,
      });
      const ascii = makeAsciiBuffer(5000);
      vi.mocked(proxy.readFile).mockResolvedValue(ascii);

      const result = await tinyService.resolve('mystery.dat');

      expect(result.kind).toBe('too-large');
      if (result.kind === 'too-large') {
        expect(result.size).toBe(5000);
        expect(result.limit).toBe(1024);
      }
      expect(tinyService.peek('mystery.dat')).toBeUndefined();
    });

    it('should bypass binary sniff when forceText override is set', async () => {
      const buffer = new Uint8Array([0x00, 0x41, 0x42, 0x43]);
      vi.mocked(proxy.readFile).mockResolvedValue(buffer);

      const result = await service.resolve('mystery.dat', { forceText: true });

      expectTextContent(result, buffer);
    });

    it('should bypass open-limit when sizeLimit override is set', async () => {
      const tinyService = new FileContentService({
        proxy,
        rootDirectory: '/project',
        openSizeBytes: 1024,
      });
      const ascii = makeAsciiBuffer(4096);
      vi.mocked(proxy.readFile).mockResolvedValue(ascii);

      const result = await tinyService.resolve('mystery.dat', { sizeLimit: Number.MAX_SAFE_INTEGER });

      expectTextContent(result, ascii);
    });

    it('should produce orphaned outcome when worker rejects with ENOENT', async () => {
      const error = new Error("ENOENT: no such file or directory '/project/missing.ts'");
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      vi.mocked(proxy.readFile).mockRejectedValue(error);

      const result = await service.resolve('missing.ts');

      expect(result.kind).toBe('orphaned');
      expect(service.isOrphaned('missing.ts')).toBe(true);
    });

    it('should produce error outcome carrying the original cause for generic worker rejection', async () => {
      const cause = new Error('disk on fire');
      vi.mocked(proxy.readFile).mockRejectedValue(cause);

      const result = await service.resolve('main.ts');

      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.cause).toBe(cause);
      }
    });
  });

  describe('open-limit decoupled from cache budget (R5, B3)', () => {
    it('should reject ASCII bytes with too-large when openSizeBytes is below cache.maxSingleFileBytes', async () => {
      const decoupled = new FileContentService({
        proxy,
        rootDirectory: '/project',
        openSizeBytes: 2 * 1024 * 1024,
        cacheOptions: { maxSingleFileBytes: 50 * 1024 * 1024 },
      });
      const ascii = makeAsciiBuffer(5 * 1024 * 1024);
      vi.mocked(proxy.readFile).mockResolvedValue(ascii);

      const result = await decoupled.resolve('mystery.dat');

      expect(result.kind).toBe('too-large');
      if (result.kind === 'too-large') {
        expect(result.size).toBe(5 * 1024 * 1024);
        expect(result.limit).toBe(2 * 1024 * 1024);
      }
    });
  });

  describe('cache rejection does not become too-large (R4 wiring, B5)', () => {
    it('should still produce text outcome when cache.set rejects but bytes fit the open-limit', async () => {
      const tinyCache = new FileContentService({
        proxy,
        rootDirectory: '/project',
        openSizeBytes: 10 * 1024 * 1024,
        cacheOptions: { maxSingleFileBytes: 1024, maxEntries: 10, maxTotalBytes: 100 * 1024 },
      });
      const ascii = makeAsciiBuffer(5 * 1024);
      vi.mocked(proxy.readFile).mockResolvedValue(ascii);

      const callback = vi.fn();
      tinyCache.subscribe('mystery.dat', callback);

      const result = await tinyCache.resolve('mystery.dat');

      expectTextContent(result, ascii);
      expect(tinyCache.peek('mystery.dat')).toBeUndefined();
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe('SharedPool fast path (R7, B4)', () => {
    const encoder = new TextEncoder();

    function createPoolService(options?: { openSizeBytes?: number }): {
      service: FileContentService;
      pool: SharedPool;
      proxy: FileManagerProxy;
    } {
      const buffer = new SharedArrayBuffer(16 * 1024 * 1024);
      const pool = new SharedPool(buffer, { maxEntries: 128 });
      const mockProxy = createMockProxy();
      const svc = new FileContentService({
        proxy: mockProxy,
        rootDirectory: '/project',
        filePool: pool,
        openSizeBytes: options?.openSizeBytes ?? 50 * 1024 * 1024,
      });
      return { service: svc, pool, proxy: mockProxy };
    }

    it('should resolve text from shared pool on cache miss', async () => {
      const { service: svc, pool, proxy: mockProxy } = createPoolService();

      pool.store('/project/pooled.ts', encoder.encode('pool content'));

      const result = await svc.resolve('pooled.ts');
      expect(result.kind).toBe('text');
      if (result.kind === 'text') {
        expect(new TextDecoder().decode(result.content)).toBe('pool content');
      }
      expect(mockProxy.readFile).not.toHaveBeenCalled();
    });

    it('should produce binary outcome when pool returns binary bytes', async () => {
      const { service: svc, pool, proxy: mockProxy } = createPoolService();

      const binaryBytes = new Uint8Array(2048);
      binaryBytes[0] = 0x00;
      pool.store('/project/mystery.dat', binaryBytes);

      const result = await svc.resolve('mystery.dat');

      expect(result.kind).toBe('binary');
      if (result.kind === 'binary') {
        expect(result.size).toBe(2048);
      }
      expect(mockProxy.readFile).not.toHaveBeenCalled();
      expect(svc.peek('mystery.dat')).toBeUndefined();
    });

    it('should produce too-large outcome when pool returns oversize ASCII bytes', async () => {
      const { service: svc, pool, proxy: mockProxy } = createPoolService({ openSizeBytes: 1024 });

      const big = makeAsciiBuffer(4096);
      pool.store('/project/mystery.dat', big);

      const result = await svc.resolve('mystery.dat');

      expect(result.kind).toBe('too-large');
      if (result.kind === 'too-large') {
        expect(result.size).toBe(4096);
        expect(result.limit).toBe(1024);
      }
      expect(mockProxy.readFile).not.toHaveBeenCalled();
    });

    it('should fall through to worker RPC on double miss', async () => {
      const { service: svc, proxy: mockProxy } = createPoolService();

      const workerData = new Uint8Array([7, 8, 9]);
      vi.mocked(mockProxy.readFile).mockResolvedValue(workerData);

      const result = await svc.resolve('worker-only.ts');
      expect(mockProxy.readFile).toHaveBeenCalledWith('/project/worker-only.ts');
      expectTextContent(result, workerData);
    });

    it('should preserve existing cache hit behaviour after pool fast path', async () => {
      const { service: svc, proxy: mockProxy } = createPoolService();

      const workerData = new Uint8Array([1, 2, 3]);
      vi.mocked(mockProxy.readFile).mockResolvedValue(workerData);

      await svc.resolve('cached.ts');
      vi.mocked(mockProxy.readFile).mockClear();

      const result = await svc.resolve('cached.ts');
      expect(mockProxy.readFile).not.toHaveBeenCalled();
      expectTextContent(result, workerData);
    });
  });

  describe('outcome subscription channel (R6, B6)', () => {
    it('should fire onDidChangeOutcome once per outcome transition', async () => {
      const handler = vi.fn<(event: OutcomeChangeEvent) => void>();
      service.onDidChangeOutcome(handler);

      const data = new Uint8Array([1, 2, 3]);
      vi.mocked(proxy.readFile).mockResolvedValue(data);

      await service.resolve('main.ts');

      expect(handler).toHaveBeenCalledOnce();
      const [event] = handler.mock.calls[0]!;
      expect(event.path).toBe('main.ts');
      expect(event.result.kind).toBe('text');
    });

    it('should not fire onDidChangeOutcome when outcome is unchanged', async () => {
      const handler = vi.fn<(event: OutcomeChangeEvent) => void>();
      service.onDidChangeOutcome(handler);

      const data = new Uint8Array([1, 2, 3]);
      vi.mocked(proxy.readFile).mockResolvedValue(data);

      await service.resolve('main.ts');
      handler.mockClear();

      await service.resolve('main.ts');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should stop firing onDidChangeOutcome after unsubscribe', async () => {
      const handler = vi.fn<(event: OutcomeChangeEvent) => void>();
      const dispose = service.onDidChangeOutcome(handler);
      dispose();

      vi.mocked(proxy.readFile).mockResolvedValue(new Uint8Array([1]));
      await service.resolve('main.ts');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('resolveBytes typed errors (B7)', () => {
    it('should resolve with bytes for text outcome', async () => {
      const data = new Uint8Array([1, 2, 3]);
      vi.mocked(proxy.readFile).mockResolvedValue(data);

      const bytes = await service.resolveBytes('main.ts');

      expect(bytes).toEqual(data);
    });

    it('should reject with BinaryFileError for binary outcome', async () => {
      const binaryBytes = new Uint8Array([0x00, 0x01, 0x02]);
      vi.mocked(proxy.readFile).mockResolvedValue(binaryBytes);

      try {
        await service.resolveBytes('mystery.dat');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BinaryFileError);
        expect((error as BinaryFileError).name).toBe('BinaryFileError');
        expect((error as BinaryFileError).path).toBe('mystery.dat');
        expect((error as BinaryFileError).size).toBe(3);
      }
    });

    it('should reject with FileTooLargeError for too-large outcome', async () => {
      const tinyService = new FileContentService({
        proxy,
        rootDirectory: '/project',
        openSizeBytes: 2,
      });
      const ascii = makeAsciiBuffer(64);
      vi.mocked(proxy.readFile).mockResolvedValue(ascii);

      try {
        await tinyService.resolveBytes('mystery.dat');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FileTooLargeError);
        expect((error as FileTooLargeError).name).toBe('FileTooLargeError');
        expect((error as FileTooLargeError).size).toBe(64);
        expect((error as FileTooLargeError).limit).toBe(2);
      }
    });

    it('should reject with FileNotFoundError for orphaned outcome', async () => {
      const enoent = new Error("ENOENT: no such file or directory '/project/missing.ts'");
      (enoent as NodeJS.ErrnoException).code = 'ENOENT';
      vi.mocked(proxy.readFile).mockRejectedValue(enoent);

      try {
        await service.resolveBytes('missing.ts');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FileNotFoundError);
        expect((error as FileNotFoundError).name).toBe('FileNotFoundError');
        expect((error as FileNotFoundError).path).toBe('missing.ts');
      }
    });

    it('should reject with the original cause for generic worker error', async () => {
      const cause = new Error('disk on fire');
      vi.mocked(proxy.readFile).mockRejectedValue(cause);

      await expect(service.resolveBytes('main.ts')).rejects.toBe(cause);
    });
  });

  describe('orphan tracking', () => {
    function createEnoentError(path: string): Error {
      const error = new Error(`ENOENT: no such file or directory '${path}'`);
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      return error;
    }

    it('should mark path as orphaned when resolve produces orphaned outcome', async () => {
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/missing.ts'));

      expect(service.isOrphaned('missing.ts')).toBe(false);

      const result = await service.resolve('missing.ts');

      expect(result.kind).toBe('orphaned');
      expect(service.isOrphaned('missing.ts')).toBe(true);
    });

    it('should clear orphan when resolve succeeds after reset', async () => {
      vi.mocked(proxy.readFile).mockRejectedValueOnce(createEnoentError('/project/main.ts'));
      const failed = await service.resolve('main.ts');
      expect(failed.kind).toBe('orphaned');
      expect(service.isOrphaned('main.ts')).toBe(true);

      vi.mocked(proxy.readFile).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
      service.reset('/project');
      await service.resolve('main.ts');

      expect(service.isOrphaned('main.ts')).toBe(false);
    });

    it('should clear orphan when write succeeds', async () => {
      vi.mocked(proxy.readFile).mockRejectedValueOnce(createEnoentError('/project/main.ts'));
      const failed = await service.resolve('main.ts');
      expect(failed.kind).toBe('orphaned');
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
      const result = await service.resolve('main.ts');
      expect(result.kind).toBe('orphaned');

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ path: 'main.ts', orphaned: true });
    });

    it('should not fire onDidChangeOrphaned when state is unchanged', async () => {
      const handler = vi.fn<(event: { path: string; orphaned: boolean }) => void>();
      service.onDidChangeOrphaned(handler);

      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/main.ts'));
      await service.resolve('main.ts');
      handler.mockClear();

      service.reset('/project');
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/main.ts'));
      await service.resolve('main.ts');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should clear all orphans on reset', async () => {
      vi.mocked(proxy.readFile).mockRejectedValue(createEnoentError('/project/a.ts'));
      const result = await service.resolve('a.ts');
      expect(result.kind).toBe('orphaned');
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
});
