import { describe, it, expect } from 'vitest';
import { defaultKernelOptions, debugKernelOptions } from '#constants/kernel-worker.constants.js';

describe('kernel-worker constants', () => {
  it('defaultKernelOptions includes shared memory geometry pool', () => {
    expect(defaultKernelOptions.sharedMemory).toEqual({
      geometry: { bytes: 100 * 1024 * 1024, maxEntries: 20, eviction: 'lru' },
    });
  });

  it('debugKernelOptions inherits shared memory config from default', () => {
    expect(debugKernelOptions.sharedMemory).toEqual(defaultKernelOptions.sharedMemory);
  });

  it('defaultKernelOptions does not have a tessellation field', () => {
    expect(defaultKernelOptions).not.toHaveProperty('tessellation');
  });
});
