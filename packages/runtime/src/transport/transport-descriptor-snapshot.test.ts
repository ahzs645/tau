/**
 * Conformance test C6 — `describe()` returns a stable
 * per-wiring snapshot of the chosen transport strategy.
 *
 * Each `TransportPlugin` returns a fresh descriptor per `describe()` call;
 * mutating one descriptor must not leak into the others.
 */

import { describe, it, expect } from 'vitest';
import { inProcessTransport } from '#transport/in-process-transport.js';
import { webWorkerTransport } from '#transport/web-worker-transport.js';
import { fromMemoryFs } from '#filesystem/runtime-filesystem.js';

describe('transport descriptor snapshot (C6)', () => {
  it('inProcessTransport wiring returns equivalent descriptor snapshots per call', () => {
    const pluginA = inProcessTransport({ fileSystem: fromMemoryFs() });
    const pluginB = inProcessTransport({ fileSystem: fromMemoryFs() });
    expect(pluginA.describe()).toEqual(pluginB.describe());
    expect(pluginA.describe()).not.toBe(pluginB.describe());

    const clientA = pluginA.materialize();
    const clientB = pluginB.materialize();
    void clientA.close();
    void clientB.close();
  });

  it('descriptor reflects strategy selection at wiring time', () => {
    const ctor = makeBlankWorkerCtor();
    const pluginNoPool = webWorkerTransport({
      url: 'about:blank',
      workerCtor: ctor,
      fileSystem: fromMemoryFs(),
    });
    const pluginWithPool = webWorkerTransport({
      url: 'about:blank',
      workerCtor: ctor,
      sharedMemory: { geometry: { bytes: 256 * 1024 } },
      fileSystem: fromMemoryFs(),
    });

    expect(pluginNoPool.describe().memory.geometryDelivery).toBe('transfer');
    expect(['pool', 'transfer']).toContain(pluginWithPool.describe().memory.geometryDelivery);

    const noPoolClient = pluginNoPool.materialize();
    const withPoolClient = pluginWithPool.materialize();
    void noPoolClient.close();
    void withPoolClient.close();
  });
});

function makeBlankWorkerCtor(): typeof Worker {
  return function FakeWorker(
    this: Record<string, unknown>,
    _url: string | URL,
    _options?: WorkerOptions,
  ): Record<string, unknown> {
    return {
      postMessage() {
        /* No-op */
      },
      addEventListener() {
        /* No-op */
      },
      removeEventListener() {
        /* No-op */
      },
      terminate() {
        /* No-op */
      },
    };
  } as unknown as typeof Worker;
}
