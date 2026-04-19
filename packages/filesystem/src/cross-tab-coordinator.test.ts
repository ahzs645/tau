import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CrossTabCoordinator, isNavigatorLocksSupported } from '#cross-tab-coordinator.js';

describe('isNavigatorLocksSupported', () => {
  it('should return true when navigator.locks exists', () => {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      expect(isNavigatorLocksSupported()).toBe(true);
    }
  });
});

describe('CrossTabCoordinator', () => {
  let coordinator: CrossTabCoordinator;

  beforeEach(() => {
    coordinator = new CrossTabCoordinator();
  });

  afterEach(() => {
    coordinator.dispose();
  });

  it('should execute write operation and return result', async () => {
    const result = await coordinator.withWriteLock('/test.txt', async () => {
      return 'written';
    });
    expect(result).toBe('written');
  });

  it('should serialize concurrent writes to the same path when locks available', async () => {
    const order: number[] = [];

    const write1 = coordinator.withWriteLock('/same.txt', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      order.push(1);
    });

    const write2 = coordinator.withWriteLock('/same.txt', async () => {
      order.push(2);
    });

    await Promise.all([write1, write2]);

    if (isNavigatorLocksSupported()) {
      expect(order).toEqual([1, 2]);
    } else {
      // Without locks, both execute concurrently (progressive enhancement no-op)
      expect(order).toHaveLength(2);
    }
  });

  it('should allow parallel writes to different paths', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    const write1 = coordinator.withWriteLock('/a.txt', async () => {
      started.push('a');
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      finished.push('a');
    });

    const write2 = coordinator.withWriteLock('/b.txt', async () => {
      started.push('b');
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      finished.push('b');
    });

    await Promise.all([write1, write2]);

    expect(started).toContain('a');
    expect(started).toContain('b');
    expect(finished).toContain('a');
    expect(finished).toContain('b');
  });

  it('should propagate errors from write operations', async () => {
    await expect(
      coordinator.withWriteLock('/fail.txt', async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
  });

  it('should listen for remote changes via BroadcastChannel', async () => {
    const received: unknown[] = [];
    coordinator.onRemoteChange((notification) => {
      received.push(notification);
    });

    const otherChannel = new BroadcastChannel('tau-fs-changes');
    otherChannel.postMessage({
      type: 'write',
      path: '/remote.txt',
      tabId: 'other-tab-id',
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'write', path: '/remote.txt' });

    otherChannel.close();
  });

  it('should not receive own change notifications', async () => {
    const received: unknown[] = [];
    coordinator.onRemoteChange((notification) => {
      received.push(notification);
    });

    await coordinator.withWriteLock('/self.txt', async () => {
      /* No-op */
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(0);
  });

  it('should clean up on dispose', () => {
    coordinator.onRemoteChange(vi.fn());
    coordinator.dispose();

    expect(() => {
      coordinator.dispose();
    }).not.toThrow();
  });
});
