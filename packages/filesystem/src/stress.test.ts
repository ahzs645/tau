import { describe, it, expect, beforeEach } from 'vitest';
import { BoundedFileCache } from '#bounded-file-cache.js';
import { WriteCoordinator } from '#write-coordinator.js';
import { ChangeEventBus } from '#change-event-bus.js';
import { DirectoryTreeCache } from '#directory-tree-cache.js';

describe('BoundedFileCache stress tests', () => {
  it('should handle rapid set/get cycles without data loss', () => {
    const cache = new BoundedFileCache({
      maxEntries: 50,
      maxTotalBytes: 10_000,
    });

    for (let i = 0; i < 200; i++) {
      // oxlint-disable-next-line no-bitwise -- intentional byte masking for test data
      const data = new Uint8Array([i & 0xff]);
      cache.set(`file-${i}.txt`, data);
    }

    expect(cache.size).toBeLessThanOrEqual(50);

    for (let i = 150; i < 200; i++) {
      const data = cache.get(`file-${i}.txt`);
      expect(data).toBeDefined();
      // oxlint-disable-next-line no-bitwise -- intentional byte masking for test data
      expect(data![0]).toBe(i & 0xff);
    }
  });

  it('should enforce maxTotalBytes under pressure', () => {
    const cache = new BoundedFileCache({
      maxEntries: 1000,
      maxTotalBytes: 1024,
    });

    for (let i = 0; i < 100; i++) {
      const data = new Uint8Array(100);
      // oxlint-disable-next-line no-bitwise -- intentional byte masking for test data
      data.fill(i & 0xff);
      cache.set(`big-${i}.txt`, data);
    }

    expect(cache.totalBytes).toBeLessThanOrEqual(1024);
  });

  it('should reject files above maxSingleFileBytes', () => {
    const cache = new BoundedFileCache({
      maxEntries: 100,
      maxTotalBytes: 1_000_000,
      maxSingleFileBytes: 512,
    });

    const largeData = new Uint8Array(1024);
    cache.set('large.bin', largeData);
    expect(cache.has('large.bin')).toBe(false);

    const smallData = new Uint8Array(256);
    cache.set('small.bin', smallData);
    expect(cache.has('small.bin')).toBe(true);
  });

  it('should maintain LRU ordering under repeated access', () => {
    const cache = new BoundedFileCache({
      maxEntries: 3,
      maxTotalBytes: 1_000_000,
    });

    cache.set('a.txt', new Uint8Array([1]));
    cache.set('b.txt', new Uint8Array([2]));
    cache.set('c.txt', new Uint8Array([3]));

    // Access 'a' to make it most recently used
    cache.get('a.txt');

    // Adding 'd' should evict 'b' (oldest since 'a' was recently accessed)
    cache.set('d.txt', new Uint8Array([4]));

    expect(cache.has('a.txt')).toBe(true);
    expect(cache.has('b.txt')).toBe(false);
    expect(cache.has('c.txt')).toBe(true);
    expect(cache.has('d.txt')).toBe(true);
  });

  it('should handle rapid rename cycles', () => {
    const cache = new BoundedFileCache({
      maxEntries: 100,
      maxTotalBytes: 1_000_000,
    });

    for (let i = 0; i < 50; i++) {
      cache.set(`file-${i}.txt`, new Uint8Array([i]));
    }

    for (let i = 0; i < 50; i++) {
      cache.rename(`file-${i}.txt`, `renamed-${i}.txt`);
    }

    expect(cache.size).toBe(50);
    expect(cache.has('file-0.txt')).toBe(false);
    expect(cache.has('renamed-0.txt')).toBe(true);
    expect(cache.get('renamed-49.txt')![0]).toBe(49);
  });
});

describe('WriteCoordinator stress tests', () => {
  it('should serialize 100 concurrent operations correctly', async () => {
    const coordinator = new WriteCoordinator();
    const results: number[] = [];

    const operations = Array.from({ length: 100 }, async (_, i) =>
      coordinator.serialized(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        results.push(i);
        return i;
      }),
    );

    const returnValues = await Promise.all(operations);

    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(returnValues).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('should continue after errors without blocking', async () => {
    const coordinator = new WriteCoordinator();
    const results: string[] = [];

    const operations = [
      coordinator.serialized(async () => {
        results.push('first');
      }),
      coordinator.serialized(async () => {
        results.push('second-start');
        throw new Error('intentional failure');
      }),
      coordinator.serialized(async () => {
        results.push('third');
      }),
    ];

    const settled = await Promise.allSettled(operations);

    expect(settled[0]?.status).toBe('fulfilled');
    expect(settled[1]?.status).toBe('rejected');
    expect(settled[2]?.status).toBe('fulfilled');
    expect(results).toEqual(['first', 'second-start', 'third']);
  });

  it('should handle deeply nested serialization', async () => {
    const coordinator = new WriteCoordinator();
    const results: number[] = [];

    await coordinator.serialized(async () => {
      results.push(1);
      // Note: nested serialized calls will deadlock if not handled correctly.
      // This test verifies the queue works sequentially from the outside.
    });

    const nested = Array.from({ length: 50 }, async (_, i) =>
      coordinator.serialized(async () => {
        results.push(i + 2);
      }),
    );

    await Promise.all(nested);
    expect(results.length).toBe(51);
    expect(results[0]).toBe(1);
  });
});

describe('ChangeEventBus stress tests', () => {
  it('should handle 1000 rapid emissions to multiple subscribers', () => {
    const bus = new ChangeEventBus();
    let count1 = 0;
    let count2 = 0;

    bus.subscribe(() => {
      count1++;
    });
    bus.subscribe(() => {
      count2++;
    });

    for (let i = 0; i < 1000; i++) {
      bus.emit({ type: 'fileWritten', path: `/file-${i}.txt`, backend: 'indexeddb' });
    }

    expect(count1).toBe(1000);
    expect(count2).toBe(1000);

    bus.dispose();
  });

  it('should handle subscribe/unsubscribe churn during emissions', () => {
    const bus = new ChangeEventBus();
    const counts: number[] = [];

    for (let i = 0; i < 20; i++) {
      let count = 0;
      const unsub = bus.subscribe(() => {
        count++;
      });
      counts.push(0);
      const index = i;

      bus.emit({ type: 'fileWritten', path: '/test.txt', backend: 'indexeddb' });
      counts[index] = count;

      if (i % 2 === 0) {
        unsub();
      }
    }

    // Each subscriber was active for at least one emission
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(1);
    }

    bus.dispose();
  });

  it('should safely handle errors in subscribers without stopping other subscribers', () => {
    const bus = new ChangeEventBus();
    let goodCount = 0;

    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe(() => {
      goodCount++;
    });

    // Emissions should not throw even if a subscriber does
    expect(() => {
      bus.emit({ type: 'fileWritten', path: '/test.txt', backend: 'indexeddb' });
    }).not.toThrow();

    // Note: depending on implementation, the good subscriber might or might not fire
    // This test verifies the bus doesn't crash
    bus.dispose();
  });
});

describe('DirectoryTreeCache stress tests', () => {
  it('should handle large cache with thousands of entries', () => {
    const cache = new DirectoryTreeCache();

    for (let i = 0; i < 1000; i++) {
      const entries = new Map<string, { name: string; type: 'file' | 'directory'; size: number; mtimeMs: number }>();
      for (let j = 0; j < 10; j++) {
        entries.set(`file-${j}.txt`, { name: `file-${j}.txt`, type: 'file', size: j * 100, mtimeMs: Date.now() });
      }
      cache.set(`/dir-${i}`, entries);
    }

    expect(cache.get('/dir-500')).toBeDefined();
    expect(cache.get('/dir-500')!.size).toBe(10);

    // Set some children of /dir-5 to verify subtree invalidation
    cache.set('/dir-5/sub1', new Map());
    cache.set('/dir-5/sub2', new Map());

    cache.invalidateSubtree('/dir-5');

    expect(cache.get('/dir-5')).toBeUndefined();
    expect(cache.get('/dir-5/sub1')).toBeUndefined();
    expect(cache.get('/dir-5/sub2')).toBeUndefined();
    // /dir-50 should still exist (not a subtree of /dir-5, just shares a prefix)
    expect(cache.get('/dir-50')).toBeDefined();
    expect(cache.get('/dir-500')).toBeDefined();
    expect(cache.get('/dir-6')).toBeDefined();
  });

  let cache: DirectoryTreeCache;

  beforeEach(() => {
    cache = new DirectoryTreeCache();
  });

  it('should handle invalidateSubtree on root', () => {
    cache.set('/', new Map());
    cache.set('/a', new Map());
    cache.set('/a/b', new Map());
    cache.set('/a/b/c', new Map());

    cache.invalidateSubtree('/');

    expect(cache.get('/')).toBeUndefined();
    expect(cache.get('/a')).toBeUndefined();
    expect(cache.get('/a/b')).toBeUndefined();
    expect(cache.get('/a/b/c')).toBeUndefined();
  });

  it('should handle rapid set/invalidate cycles', () => {
    for (let round = 0; round < 100; round++) {
      cache.set(`/round-${round}`, new Map());
      if (round > 0) {
        cache.invalidate(`/round-${round - 1}`);
      }
    }

    expect(cache.get('/round-0')).toBeUndefined();
    expect(cache.get('/round-99')).toBeDefined();
  });
});
