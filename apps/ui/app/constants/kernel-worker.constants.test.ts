import { describe, it, expect } from 'vitest';
import { defaultKernelOptions, debugKernelOptions } from '#constants/kernel-worker.constants.js';

describe('kernel-worker constants', () => {
  it('defaultKernelOptions includes preview tessellation tolerances', () => {
    expect(defaultKernelOptions.tessellation).toEqual({
      preview: { linearTolerance: 0.1, angularTolerance: 0.1 },
    });
  });

  it('debugKernelOptions inherits the same tessellation config via spread', () => {
    expect(debugKernelOptions.tessellation).toEqual(defaultKernelOptions.tessellation);
  });
});
