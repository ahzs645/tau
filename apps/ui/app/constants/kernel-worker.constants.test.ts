import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createDefaultKernelOptions,
  createDebugKernelOptions,
  defaultKernels,
} from '#constants/kernel-worker.constants.js';
import { fromMemoryFs } from '@taucad/runtime/filesystem';

/* `webWorkerTransport.client(...)` validates a `Worker` ctor is in scope at
 * construction time (the actual worker is only spawned on `open()`). jsdom
 * does not expose `Worker` as a global, so install a minimal stub for the
 * duration of the suite — no real `postMessage` traffic happens here, the
 * test only inspects the synchronously-built transport handle shape. */
const noop = (): void => {
  /* No-op for stubbing browser APIs not present in jsdom. */
};
const originalWorker = (globalThis as { Worker?: unknown }).Worker;
beforeAll(() => {
  (globalThis as { Worker?: unknown }).Worker = class StubWorker {
    public postMessage = noop;
    public addEventListener = noop;
    public removeEventListener = noop;
    public terminate = noop;
  };
});
afterAll(() => {
  (globalThis as { Worker?: unknown }).Worker = originalWorker;
});

describe('kernel-worker constants', () => {
  it('defaultKernels exposes the editor kernel list independent of the transport', () => {
    expect(defaultKernels.length).toBeGreaterThan(0);
    for (const kernel of defaultKernels) {
      expect(typeof kernel.id).toBe('string');
      expect(Array.isArray(kernel.extensions)).toBe(true);
    }
  });

  it('createDefaultKernelOptions builds RuntimeClientOptions with a constructed transport client', () => {
    const fileSystem = fromMemoryFs();
    const filePoolBuffer = new SharedArrayBuffer(1024);
    const options = createDefaultKernelOptions({ fileSystem, filePoolBuffer });

    expect(options.transport).toBeDefined();
    /* The transport client is fully fledged (`describe`, `open`, `initialize`,
     * `abort`, `resolveGeometry`, `close`, `closed`) — assert a representative
     * subset without binding to internal field names. */
    expect(typeof options.transport!.open).toBe('function');
    expect(typeof options.transport!.close).toBe('function');
    expect(options.kernels.length).toBe(defaultKernels.length);
  });

  it('createDebugKernelOptions inherits transport composition from default', () => {
    const fileSystem = fromMemoryFs();
    const filePoolBuffer = new SharedArrayBuffer(1024);
    const debugOptions = createDebugKernelOptions({ fileSystem, filePoolBuffer });

    expect(debugOptions.transport).toBeDefined();
    expect(typeof debugOptions.transport!.open).toBe('function');
    expect(debugOptions.kernels.length).toBeGreaterThan(0);
  });

  it('createDefaultKernelOptions does not expose a top-level tessellation field', () => {
    const options = createDefaultKernelOptions({
      fileSystem: fromMemoryFs(),
      filePoolBuffer: new SharedArrayBuffer(1024),
    });
    expect(options).not.toHaveProperty('tessellation');
  });
});
