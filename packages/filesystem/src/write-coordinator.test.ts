import { describe, it, expect } from 'vitest';
import { WriteCoordinator } from '#write-coordinator.js';

describe('WriteCoordinator', () => {
  it('should execute operations in FIFO order', async () => {
    const coordinator = new WriteCoordinator();
    const order: number[] = [];

    const op1 = coordinator.serialized(async () => {
      order.push(1);
    });
    const op2 = coordinator.serialized(async () => {
      order.push(2);
    });
    const op3 = coordinator.serialized(async () => {
      order.push(3);
    });

    await Promise.all([op1, op2, op3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('should serialize concurrent operations (no interleaving)', async () => {
    const coordinator = new WriteCoordinator();
    const log: string[] = [];

    const slowOp = coordinator.serialized(async () => {
      log.push('start-slow');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      log.push('end-slow');
    });

    const fastOp = coordinator.serialized(async () => {
      log.push('start-fast');
      log.push('end-fast');
    });

    await Promise.all([slowOp, fastOp]);

    // Fast op must run after slow op completes (no interleaving)
    expect(log).toEqual(['start-slow', 'end-slow', 'start-fast', 'end-fast']);
  });

  it('should not block the queue when an operation throws', async () => {
    const coordinator = new WriteCoordinator();
    const results: string[] = [];

    const failingOp = coordinator.serialized(async () => {
      results.push('before-error');
      throw new Error('operation failed');
    });

    const succeedingOp = coordinator.serialized(async () => {
      results.push('after-error');
    });

    await expect(failingOp).rejects.toThrow('operation failed');
    await succeedingOp;

    expect(results).toEqual(['before-error', 'after-error']);
  });

  it('should have accurate depth getter', async () => {
    const coordinator = new WriteCoordinator();

    expect(coordinator.depth).toBe(0);

    const op1Promise = coordinator.serialized(async () => {
      expect(coordinator.depth).toBeGreaterThanOrEqual(1);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    });

    expect(coordinator.depth).toBe(1);

    const op2Promise = coordinator.serialized(async () => {
      expect(coordinator.depth).toBeGreaterThanOrEqual(1);
    });

    await op1Promise;
    await op2Promise;

    expect(coordinator.depth).toBe(0);
  });
});
