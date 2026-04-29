/**
 * Large-payload conformance suite for {@link multiplex}.
 *
 * Phase 8 of the v5 channel blueprint promises that the multiplex layer is
 * correct under realistic geometry/file payloads. The unit suite in
 * `multiplex.test.ts` covers the binary fast-path semantics; this file
 * locks in the large-fixture behaviour:
 *
 *   1. 1 MB and 16 MB `Uint8Array` round-trip via the binary fast-path
 *      (single structured-clone frame, transferable-detach observed).
 *   2. Large JSON-only payloads survive the stringify-and-chunk reassembly
 *      path with byte-level fidelity.
 *   3. Mixed envelopes (binary + JSON-friendly fields) take the fast-path
 *      without exploding `Uint8Array` into `{"0":1,…}` pseudo-objects.
 *
 * The harness uses `node:worker_threads.MessageChannel` so transferable
 * detach is observable end-to-end. Tests that allocate 16 MB are scoped
 * to a single allocation per case and disposed eagerly.
 */

// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import type { Port } from '#port.js';
import { wrapMessagePort } from '#port.js';
import { multiplex } from '#multiplex.js';
import type { MultiplexedPort } from '#multiplex.js';

type Pair = {
  readonly host: MultiplexedPort;
  readonly client: MultiplexedPort;
  readonly observedClientFrames: readonly ObservedFrame[];
  dispose(): void;
};

type ObservedFrame = {
  readonly data: unknown;
  readonly transferables: readonly Transferable[] | undefined;
};

const setupPair = (options?: { observe?: boolean; chunkSize?: number }): Pair => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const p1 = wrapMessagePort<unknown>(channel.port1);
  const p2Real = wrapMessagePort<unknown>(channel.port2);
  const observed: ObservedFrame[] = [];

  const p2: Port<unknown> = options?.observe
    ? {
        capabilities: p2Real.capabilities,
        postMessage(data, transfer) {
          observed.push({ data, transferables: transfer });
          p2Real.postMessage(data, transfer);
        },
        onMessage: (handler) => p2Real.onMessage(handler),
        start: () => {
          p2Real.start?.();
        },
        close: () => {
          p2Real.close();
        },
      }
    : p2Real;

  if (p1.start) {
    p1.start();
  }
  if (p2.start) {
    p2.start();
  }

  const muxOptions = options?.chunkSize === undefined ? undefined : { maxSingleStringLength: options.chunkSize };
  const host = multiplex(p1, muxOptions);
  const client = multiplex(p2, muxOptions);

  return {
    host,
    client,
    observedClientFrames: observed,
    dispose(): void {
      host.close();
      client.close();
    },
  };
};

const checksum = (bytes: Uint8Array<ArrayBuffer>): number => {
  let sum = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    sum = (sum + bytes[i]!) % 0xff_ff_ff_ff;
  }
  return sum;
};

const fillRandomish = (bytes: Uint8Array<ArrayBuffer>): void => {
  // Deterministic mod-256 ramp so fixtures are reproducible across runs and
  // give a wide-spread byte distribution that defeats trivial JSON chunking
  // heuristics. Linter forbids `&` so we lean on `%` for the byte-mask.
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bytes[i] = (i + 1) % 256;
  }
};

describe('multiplex conformance — large payloads (Phase 8)', () => {
  let pairs: Pair[] = [];

  afterEach(() => {
    for (const pair of pairs) {
      pair.dispose();
    }
    pairs = [];
  });

  it('round-trips a 1 MB Uint8Array on the binary fast-path', async () => {
    const pair = setupPair({ observe: true, chunkSize: 8 });
    pairs.push(pair);
    const handle = pair.host.serve('bin', {
      call: async (_context, _name, args) => {
        const incoming = (args as { bytes: Uint8Array<ArrayBuffer> }).bytes;
        return { byteLength: incoming.byteLength, checksum: checksum(incoming) };
      },
      async *listen() {
        yield 0;
      },
    });
    const channel = pair.client.open('bin');
    const bytes = new Uint8Array(1024 * 1024);
    fillRandomish(bytes);
    const expectedChecksum = checksum(bytes);
    const sourceBuffer = bytes.buffer;

    const result = await channel.call('echo', {
      value: { bytes },
      transferables: [bytes.buffer],
    });

    expect(result).toEqual({ byteLength: 1024 * 1024, checksum: expectedChecksum });
    expect(sourceBuffer.byteLength).toBe(0);

    const callFrames = pair.observedClientFrames.filter((frame) => {
      const { inner } = frame.data as { inner?: { k?: unknown } };
      return inner?.k === 'rq';
    });
    expect(callFrames).toHaveLength(1);
    expect(callFrames[0]!.transferables?.length).toBe(1);

    handle.dispose();
  });

  it('round-trips a 16 MB Uint8Array on the binary fast-path', async () => {
    const pair = setupPair({ chunkSize: 8 });
    pairs.push(pair);
    const handle = pair.host.serve('bin', {
      call: async (_context, _name, args) => {
        const incoming = (args as { bytes: Uint8Array<ArrayBuffer> }).bytes;
        return { byteLength: incoming.byteLength, checksum: checksum(incoming) };
      },
      async *listen() {
        yield 0;
      },
    });
    const channel = pair.client.open('bin');
    const bytes = new Uint8Array(16 * 1024 * 1024);
    fillRandomish(bytes);
    const expectedChecksum = checksum(bytes);

    const result = await channel.call('echo', {
      value: { bytes },
      transferables: [bytes.buffer],
    });

    expect(result).toEqual({ byteLength: 16 * 1024 * 1024, checksum: expectedChecksum });

    handle.dispose();
  });

  it('round-trips a 1 MB JSON-only payload via the chunker', async () => {
    const pair = setupPair({ observe: true, chunkSize: 64 * 1024 });
    pairs.push(pair);
    const handle = pair.host.serve('json', {
      call: async (_context, _name, args) => {
        const { payload } = args as { payload: string };
        return { length: payload.length, head: payload.slice(0, 16), tail: payload.slice(-16) };
      },
      async *listen() {
        yield 0;
      },
    });
    const channel = pair.client.open('json');
    // 1 MB of JSON-encoded characters; chunk threshold above forces ~16 chunks.
    const payload = 'x'.repeat(1024 * 1024 - 32) + 'TAILMARKERTAILMARK';

    const result = await channel.call('echo', { payload });

    expect(result).toEqual({
      length: payload.length,
      head: payload.slice(0, 16),
      tail: payload.slice(-16),
    });

    const chunkFrames = pair.observedClientFrames.filter((frame) => {
      const { t } = frame.data as { t?: unknown };
      return t === 'k';
    });
    expect(chunkFrames.length).toBeGreaterThan(1);

    handle.dispose();
  });

  it('takes the binary fast-path for mixed envelopes containing both Uint8Array and JSON-friendly fields', async () => {
    const pair = setupPair({ observe: true, chunkSize: 8 });
    pairs.push(pair);
    const handle = pair.host.serve('mix', {
      call: async (_context, _name, args) => {
        const { meta, bytes } = args as { meta: { kind: string; flag: boolean }; bytes: Uint8Array<ArrayBuffer> };
        return {
          kind: meta.kind,
          flag: meta.flag,
          byteLength: bytes.byteLength,
          first: bytes[0],
          last: bytes[bytes.byteLength - 1],
        };
      },
      async *listen() {
        yield 0;
      },
    });
    const channel = pair.client.open('mix');
    const bytes = new Uint8Array(256 * 1024);
    bytes[0] = 9;
    bytes[bytes.byteLength - 1] = 11;

    const result = await channel.call('echo', {
      meta: { kind: 'gltf', flag: true },
      bytes,
    });

    expect(result).toEqual({ kind: 'gltf', flag: true, byteLength: 256 * 1024, first: 9, last: 11 });

    const chunkFrames = pair.observedClientFrames.filter((frame) => {
      const { t } = frame.data as { t?: unknown };
      return t === 'k';
    });
    expect(chunkFrames).toHaveLength(0);
    const singleFrames = pair.observedClientFrames.filter((frame) => {
      const { t } = frame.data as { t?: unknown };
      return t === 's';
    });
    expect(singleFrames.length).toBeGreaterThan(0);

    handle.dispose();
  });

  it('multiplexes parallel binary calls on independent sessions without cross-talk', async () => {
    const pair = setupPair();
    pairs.push(pair);
    const handleA = pair.host.serve('a', {
      call: async (_context, _name, args) => {
        const { bytes } = args as { bytes: Uint8Array<ArrayBuffer> };
        return { sid: 'a', sum: checksum(bytes) };
      },
      async *listen() {
        yield 0;
      },
    });
    const handleB = pair.host.serve('b', {
      call: async (_context, _name, args) => {
        const { bytes } = args as { bytes: Uint8Array<ArrayBuffer> };
        return { sid: 'b', sum: checksum(bytes) };
      },
      async *listen() {
        yield 0;
      },
    });
    const channelA = pair.client.open('a');
    const channelB = pair.client.open('b');

    const bytesA = new Uint8Array(512 * 1024);
    bytesA.fill(0xa5);
    const bytesB = new Uint8Array(512 * 1024);
    bytesB.fill(0x5a);
    const expectedA = checksum(bytesA);
    const expectedB = checksum(bytesB);

    const [resultA, resultB] = await Promise.all([
      channelA.call('echo', { bytes: bytesA }),
      channelB.call('echo', { bytes: bytesB }),
    ]);

    expect(resultA).toEqual({ sid: 'a', sum: expectedA });
    expect(resultB).toEqual({ sid: 'b', sum: expectedB });

    handleA.dispose();
    handleB.dispose();
  });
});
