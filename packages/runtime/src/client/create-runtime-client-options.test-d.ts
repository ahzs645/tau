/**
 * Phase 4 / R13 — `createRuntimeClientOptions` threads the wired
 * {@link TransportPlugin} literal alongside kernel plugins.
 */

import { describe, it, expectTypeOf } from 'vitest';

import type { KernelPlugin } from '#plugins/plugin-types.js';

import { createRuntimeClientOptions } from '#client/runtime-client-options.js';
import { webWorkerTransport } from '#transport/web-worker-transport.js';
import { inProcessTransport } from '#transport/in-process-transport.js';

const stubKernel = {
  id: 'stub-kernel',
  extensions: ['js'],
  moduleUrl: 'https://example.test/kernel.js',
} as const satisfies KernelPlugin;

describe('createRuntimeClientOptions — TransportPlugin narrowing (R13)', () => {
  it("preserves the literal transport id 'web-worker' through the factory", () => {
    const options = createRuntimeClientOptions({
      kernels: [stubKernel],
      transport: webWorkerTransport({
        url: new URL('https://example.test/worker.js'),
      }),
    });
    expectTypeOf(options.transport!.id).toEqualTypeOf<'web-worker'>();
  });

  it("preserves the literal transport id 'in-process'", () => {
    const options = createRuntimeClientOptions({
      kernels: [stubKernel],
      transport: inProcessTransport({}),
    });
    expectTypeOf(options.transport!.id).toEqualTypeOf<'in-process'>();
  });
});
