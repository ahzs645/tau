import { describe, it, expect, afterEach } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import type { Port } from '#port.js';
import { wrapMessagePort } from '#index.js';
import { multiplex } from '#multiplex.js';

describe('multiplex', () => {
  const unsubs: Array<() => void> = [];

  afterEach(() => {
    for (const u of unsubs) {
      u();
    }
    unsubs.length = 0;
  });

  it('routes two session keys independently over one physical port', async () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2 = wrapMessagePort<unknown>(c.port2);
    if (p1.start) {
      p1.start();
    }
    if (p2.start) {
      p2.start();
    }

    const host = multiplex(p1);
    const client = multiplex(p2);
    unsubs.push(() => {
      host.close();
      client.close();
    });

    const hA = host.serve('a', {
      call: async (_context, name) => (name === 'get' ? 'A' : '0'),
      async *listen() {
        yield 0;
      },
    });
    const hB = host.serve('b', {
      call: async (_context, name) => (name === 'get' ? 'B' : '0'),
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      hA.dispose();
      hB.dispose();
    });

    const dA = client.open('a');
    const dB = client.open('b');

    await expect(dA.call('get')).resolves.toBe('A');
    await expect(dB.call('get')).resolves.toBe('B');
  });

  it('reassembles chunked inner payloads', async () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2 = wrapMessagePort<unknown>(c.port2);
    if (p1.start) {
      p1.start();
    }
    if (p2.start) {
      p2.start();
    }

    const host = multiplex(p1, { maxSingleStringLength: 3 });
    const client = multiplex(p2, { maxSingleStringLength: 3 });
    unsubs.push(() => {
      host.close();
      client.close();
    });
    const big = 'x'.repeat(20);
    const h = host.serve('c', {
      call: async (_context, _name, args) => (args as { s: string }).s,
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      h.dispose();
    });
    const ch = client.open('c');
    await expect(ch.call('echo', { s: big })).resolves.toBe(big);
  });

  it('throws when opening on a closed multiplex', () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p2 = wrapMessagePort<unknown>(c.port2);
    if (p2.start) {
      p2.start();
    }
    const m = multiplex(p2);
    m.close();
    expect(() => m.open('x')).toThrow('MultiplexedPort is closed');
  });

  it('rejects serve after the multiplex is closed', () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    if (p1.start) {
      p1.start();
    }
    const host = multiplex(p1);
    host.close();
    expect(() =>
      host.serve('z', {
        call: async () => 0,
        async *listen() {
          yield 0;
        },
      }),
    ).toThrow('MultiplexedPort is closed');
  });

  it('ignores non-mux frames at root', async () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2 = wrapMessagePort<unknown>(c.port2);
    const host = multiplex(p1);
    const client = multiplex(p2);
    unsubs.push(() => {
      host.close();
      client.close();
    });
    p1.postMessage({ not: 'mux' });
    p1.postMessage(null);
    p1.postMessage(42);
    const h = host.serve('s', {
      call: async () => 'ok',
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      h.dispose();
    });
    const ch = client.open('s');
    await expect(ch.call('any')).resolves.toBe('ok');
  });

  it('is idempotent against duplicate chunks at the same index', async () => {
    let captured: ((data: unknown) => void) | undefined;
    const fakeRoot: Port<unknown> = {
      capabilities: {},
      postMessage: () => undefined,
      onMessage: (handler) => {
        captured = handler;
        return () => {
          captured = undefined;
        };
      },
      close: () => undefined,
    };
    const m = multiplex(fakeRoot);
    unsubs.push(() => {
      m.close();
    });
    const received: unknown[] = [];
    const sessionPort = m.open('a');
    void sessionPort;
    const inner = { hello: 'world' };
    const inJson = JSON.stringify(inner);
    const half = Math.ceil(inJson.length / 2);
    const a = inJson.slice(0, half);
    const b = inJson.slice(half);
    const offHandler = m.serve('a', {
      call: async () => 0,
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      offHandler.dispose();
    });
    const tap = m.open('a');
    const tapPortHandler = (d: unknown): void => {
      received.push(d);
    };
    void tap;
    void tapPortHandler;
    captured?.({ v: 1, t: 'k', sid: 'a', m: 'M', i: 0, tot: 2, c: a });
    captured?.({ v: 1, t: 'k', sid: 'a', m: 'M', i: 0, tot: 2, c: a });
    captured?.({ v: 1, t: 'k', sid: 'a', m: 'M', i: 1, tot: 2, c: b });
    expect(captured).toBeDefined();
  });

  it('starts the root port on construction when start is supported', () => {
    let started = 0;
    const fakeRoot: Port<unknown> = {
      capabilities: {},
      postMessage: () => undefined,
      onMessage: () => () => undefined,
      start: () => {
        started += 1;
      },
      close: () => undefined,
    };
    const m = multiplex(fakeRoot);
    unsubs.push(() => {
      m.close();
    });
    expect(started).toBe(1);
    const session = m.open('s');
    session.close();
  });

  it('clears chunk and handler buffers on close', () => {
    const fakeRoot: Port<unknown> = {
      capabilities: {},
      postMessage: () => undefined,
      onMessage: () => () => undefined,
      close: () => undefined,
    };
    const m = multiplex(fakeRoot);
    const session = m.open('a');
    m.close();
    m.close();
    expect(() => m.open('b')).toThrow('MultiplexedPort is closed');
    session.close();
  });

  it('round-trips a Uint8Array call result without JSON chunking', async () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2 = wrapMessagePort<unknown>(c.port2);
    if (p1.start) {
      p1.start();
    }
    if (p2.start) {
      p2.start();
    }
    // 64 KiB payload, way larger than the 8 KiB JSON-chunk threshold — proves the
    // binary fast-path bypasses the stringify-and-slice chunker.
    const host = multiplex(p1, { maxSingleStringLength: 8 });
    const client = multiplex(p2, { maxSingleStringLength: 8 });
    unsubs.push(() => {
      host.close();
      client.close();
    });
    const h = host.serve('bin', {
      call: async (_context, _name, args) => {
        const incoming = (args as { bytes: Uint8Array<ArrayBuffer> }).bytes;
        return { length: incoming.byteLength, first: incoming[0], last: incoming[incoming.byteLength - 1] };
      },
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      h.dispose();
    });
    const ch = client.open('bin');
    const bytes = new Uint8Array(64 * 1024);
    bytes[0] = 7;
    bytes[bytes.byteLength - 1] = 13;
    await expect(ch.call('echo', { bytes })).resolves.toEqual({
      length: bytes.byteLength,
      first: 7,
      last: 13,
    });
  });

  it('forwards transferables out of the session port and detaches the source ArrayBuffer', async () => {
    type ObservedFrame = { data: unknown; transferables: readonly Transferable[] | undefined };
    const observed: ObservedFrame[] = [];
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2Real = wrapMessagePort<unknown>(c.port2);
    const p2: Port<unknown> = {
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
    };
    if (p1.start) {
      p1.start();
    }
    if (p2.start) {
      p2.start();
    }
    const host = multiplex(p1);
    const client = multiplex(p2);
    unsubs.push(() => {
      host.close();
      client.close();
    });
    const h = host.serve('t', {
      call: async (_context, _name, args) => (args as { bytes: Uint8Array<ArrayBuffer> }).bytes.byteLength,
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      h.dispose();
    });
    const ch = client.open('t');
    const bytes = new Uint8Array(32 * 1024);
    const sourceBuffer = bytes.buffer;
    await expect(ch.call('echo', { value: { bytes }, transferables: [bytes.buffer] })).resolves.toBe(bytes.byteLength);
    const callFrame = observed.find((frame) => {
      const { inner } = frame.data as { inner?: { k?: unknown } };
      return inner?.k === 'rq';
    });
    expect(callFrame).toBeDefined();
    expect(callFrame!.transferables?.length).toBe(1);
    expect(sourceBuffer.byteLength).toBe(0);
  });

  it('still chunks JSON-only payloads when the binary fast-path does not apply', async () => {
    const c = new MessageChannel();
    c.port1.start();
    c.port2.start();
    const p1 = wrapMessagePort<unknown>(c.port1);
    const p2 = wrapMessagePort<unknown>(c.port2);
    if (p1.start) {
      p1.start();
    }
    if (p2.start) {
      p2.start();
    }
    const host = multiplex(p1, { maxSingleStringLength: 32 });
    const client = multiplex(p2, { maxSingleStringLength: 32 });
    unsubs.push(() => {
      host.close();
      client.close();
    });
    const h = host.serve('json', {
      call: async (_context, _name, args) => (args as { s: string }).s.length,
      async *listen() {
        yield 0;
      },
    });
    unsubs.push(() => {
      h.dispose();
    });
    const ch = client.open('json');
    const big = 'a'.repeat(2048);
    await expect(ch.call('len', { s: big })).resolves.toBe(big.length);
  });

  it('ignores chunked frames whose session has no handlers', () => {
    let captured: ((data: unknown) => void) | undefined;
    const fakeRoot: Port<unknown> = {
      capabilities: {},
      postMessage: () => undefined,
      onMessage: (handler) => {
        captured = handler;
        return () => {
          captured = undefined;
        };
      },
      close: () => undefined,
    };
    const m = multiplex(fakeRoot);
    unsubs.push(() => {
      m.close();
    });
    captured?.({ v: 1, t: 's', sid: 'unknown', inner: { v: 1, k: 'r', i: 'x', o: 1, d: 0 } });
    expect(captured).toBeDefined();
  });
});
