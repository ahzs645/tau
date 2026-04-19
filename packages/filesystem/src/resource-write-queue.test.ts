import { describe, it, expect } from 'vitest';
import { ResourceWriteQueue } from '#resource-write-queue.js';

describe('ResourceWriteQueue', () => {
  it('should serialize writes to the same parent directory', async () => {
    const queue = new ResourceWriteQueue();
    const order: number[] = [];

    const op1 = queue.enqueue('/dir/file1.txt', async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      order.push(2);
    });

    const op2 = queue.enqueue('/dir/file2.txt', async () => {
      order.push(3);
      order.push(4);
    });

    await Promise.all([op1, op2]);

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('should parallelize writes to different parent directories', async () => {
    const queue = new ResourceWriteQueue();
    const log: string[] = [];

    const op1 = queue.enqueue('/dirA/file.txt', async () => {
      log.push('A-start');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      log.push('A-end');
    });

    const op2 = queue.enqueue('/dirB/file.txt', async () => {
      log.push('B-start');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      log.push('B-end');
    });

    await Promise.all([op1, op2]);

    expect(log.indexOf('A-start')).toBeLessThan(log.indexOf('B-end'));
    expect(log.indexOf('B-start')).toBeLessThan(log.indexOf('A-end'));
  });

  it('should auto-cleanup empty queues', async () => {
    const queue = new ResourceWriteQueue();

    // oxlint-disable-next-line no-empty-function -- intentional no-op
    await queue.enqueue('/dir/file.txt', async () => {});

    expect(queue.depth).toBe(0);
  });

  it('should resolve whenDrained when all queues empty', async () => {
    const queue = new ResourceWriteQueue();

    const op = queue.enqueue('/dir/file.txt', async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    });

    const drained = queue.whenDrained();

    await op;
    await drained;

    expect(queue.depth).toBe(0);
  });

  it('should resolve whenDrained immediately if already empty', async () => {
    const queue = new ResourceWriteQueue();
    await queue.whenDrained();
    expect(queue.depth).toBe(0);
  });

  it('should not block other queues when one operation fails', async () => {
    const queue = new ResourceWriteQueue();

    const failOp = queue.enqueue('/dirA/file.txt', async () => {
      throw new Error('failed');
    });

    const successOp = queue.enqueue('/dirB/file.txt', async () => {
      return 'success';
    });

    await expect(failOp).rejects.toThrow('failed');
    await expect(successOp).resolves.toBe('success');
  });

  it('should not block same-directory queue when an operation fails', async () => {
    const queue = new ResourceWriteQueue();
    const results: string[] = [];

    const failOp = queue.enqueue('/dir/file1.txt', async () => {
      results.push('before-error');
      throw new Error('op failed');
    });

    const successOp = queue.enqueue('/dir/file2.txt', async () => {
      results.push('after-error');
    });

    await expect(failOp).rejects.toThrow('op failed');
    await successOp;

    expect(results).toEqual(['before-error', 'after-error']);
  });

  it('should track depth accurately', async () => {
    const queue = new ResourceWriteQueue();

    expect(queue.depth).toBe(0);

    const op1 = queue.enqueue('/dir/a.txt', async () => {
      expect(queue.depth).toBeGreaterThanOrEqual(1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    });

    expect(queue.depth).toBe(1);

    const op2 = queue.enqueue('/dir/b.txt', async () => {
      expect(queue.depth).toBeGreaterThanOrEqual(1);
    });

    expect(queue.depth).toBe(2);

    await op1;
    await op2;

    expect(queue.depth).toBe(0);
  });

  it('should return operation result', async () => {
    const queue = new ResourceWriteQueue();
    const result = await queue.enqueue('/dir/file.txt', async () => 42);
    expect(result).toBe(42);
  });
});
