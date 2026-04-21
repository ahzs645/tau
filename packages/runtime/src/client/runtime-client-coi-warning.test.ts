/* eslint-disable @typescript-eslint/naming-convention -- matches existing file naming */
// @vitest-environment node
/**
 * Boot-time isolation warning emitted by RuntimeClient.connect().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@taucad/types';
import { createRuntimeClient, fromMemoryFS } from '#index.js';
import { createInProcessTransport } from '#transport/in-process-transport.js';
import { replicad } from '#plugins/kernel-factories.js';
import { esbuild } from '#plugins/bundler-factories.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RuntimeClient cross-origin isolation boot warning', () => {
  it('should emit a single structured warning when crossOriginIsolated is false', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('isSecureContext', true);

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const warnings: LogEntry[] = [];
    client.on('log', (entry) => {
      if (entry.level === 'warn' && entry.message.includes('cross-origin isolation')) {
        warnings.push(entry);
      }
    });

    await client.connect({ fileSystem: fromMemoryFS({ '/a.ts': '' }) });

    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.origin).toEqual({ component: 'RuntimeClient', operation: 'connect' });
    expect(warning?.data).toMatchObject({ crossOriginIsolated: false });
  });

  it('should not emit the warning when crossOriginIsolated is true', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('SharedArrayBuffer', globalThis.SharedArrayBuffer);

    const client = createRuntimeClient({
      kernels: [replicad()],
      bundlers: [esbuild()],
      transport: createInProcessTransport(),
    });

    const warnings: LogEntry[] = [];
    client.on('log', (entry) => {
      if (entry.message.includes('cross-origin isolation')) {
        warnings.push(entry);
      }
    });

    await client.connect({ fileSystem: fromMemoryFS({ '/a.ts': '' }) });

    expect(warnings).toHaveLength(0);
  });
});
