/**
 * Conformance test C17 (v6 Appendix B).
 *
 * Sentinel that locks the v6 kernel-API correction in place: `KernelPlugin`
 * does NOT carry a `worker` field (kernels host inside the runtime worker;
 * the worker entry is configured per transport, not per kernel), and
 * `createKernelPlugin` accepts only the documented config keys.
 *
 * Reintroducing a `worker` accessor on the kernel plugin would make
 * documentation drift back into the v5 misconception that each kernel
 * spawns its own worker.
 */

import { assertType, describe, it } from 'vitest';
import type { KernelPlugin } from '#plugins/plugin-types.js';
import { createKernelPlugin } from '#plugins/plugin-helpers.js';

describe('KernelPlugin API correctness (C17)', () => {
  it('KernelPlugin must not expose a `worker` field', () => {
    type HasWorker = 'worker' extends keyof KernelPlugin ? true : false;
    assertType<HasWorker>(false);
  });

  it('createKernelPlugin rejects extra unknown config keys at compile time', () => {
    // Baseline: documented keys compile and the curried factory returns a KernelPlugin.
    const okFactory = createKernelPlugin({
      id: 'x',
      moduleUrl: 'taucad:test',
      extensions: ['x'],
    });
    assertType<KernelPlugin>(okFactory());

    createKernelPlugin({
      id: 'x',
      moduleUrl: 'taucad:test',
      extensions: ['x'],
      // @ts-expect-error -- `worker` is not a valid createKernelPlugin config key (C17).
      worker: () => undefined,
    });

    createKernelPlugin({
      id: 'x',
      moduleUrl: 'taucad:test',
      extensions: ['x'],
      // @ts-expect-error -- `transport` belongs on createRuntimeClient, not on a kernel.
      transport: undefined,
    });
  });
});
