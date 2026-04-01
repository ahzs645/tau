import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test file; not part of lazy-loaded bundle
import { WriteCoordinator } from '@taucad/filesystem';

describe('WriteCoordinator serialization', () => {
  it('should serialize concurrent operations', async () => {
    const coordinator = new WriteCoordinator();
    const order: number[] = [];

    const operations = Array.from({ length: 5 }, async (_, i) =>
      coordinator.serialized(async () => {
        order.push(i);
      }),
    );

    await Promise.all(operations);

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('should propagate errors without blocking subsequent operations', async () => {
    const coordinator = new WriteCoordinator();

    await expect(
      coordinator.serialized(async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    const result = await coordinator.serialized(async () => 'recovered');
    expect(result).toBe('recovered');
  });
});
