/**
 * Pins one {@link TransportPlugin} → many {@link RuntimeClient} lifetimes: each
 * client invokes {@link TransportPlugin.materialize} once during construction.
 *
 * Sequential clients sharing the same plugin reference reuse the wired options,
 * terminate always closes each materialised transport handle.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { createRuntimeClient } from '#client/runtime-client.js';
import { fromMemoryFs } from '#filesystem/runtime-filesystem.js';
import type { KernelPlugin } from '#plugins/plugin-types.js';
import { inProcessTransport } from '#transport/in-process-transport.js';

const stubKernel = (kernelId: string): KernelPlugin => ({
  id: kernelId,
  extensions: ['js'],
  moduleUrl: `https://example.com/${kernelId}.js`,
});

describe('RuntimeClient TransportPlugin materialization', () => {
  it('materializes distinct transport handles across sequential clients that share one plugin reference', async () => {
    const mainPath = '/main.ts';
    const fs = fromMemoryFs({ [mainPath]: `export default () => true;\n` });
    const plugin = inProcessTransport({ fileSystem: fs });

    expect(plugin.materialize()).not.toBe(plugin.materialize());

    const clientFirst = createRuntimeClient({
      transport: plugin,
      kernels: [stubKernel('alpha')],
    });

    await clientFirst.connect();

    clientFirst.terminate();

    const clientSecond = createRuntimeClient({
      transport: plugin,
      kernels: [stubKernel('beta')],
    });

    await clientSecond.connect();
    clientSecond.terminate();
  });

  it('defaults to an empty in-process wiring when transport is omitted', () => {
    const client = createRuntimeClient({
      kernels: [stubKernel('alpha')],
    });
    expect(client.transport.descriptor.id).toBe('in-process');
    client.terminate();
  });
});
