// @vitest-environment node
/**
 * Electron filesystem authority seam tests (Phase 11, R8 seam 2, R9).
 *
 * Validates the `createFsBridgeHost` ↔ `createChannelClient<FsProtocol>`
 * round-trip end-to-end:
 *
 * 1. **Calls round-trip** — every `FsProtocol['calls']` verb hops the
 *    wire, lands on the host's `RuntimeFileSystemBase`, and returns the
 *    correct shape (binary `Uint8Array`, UTF-8 string, stat object,
 *    etc.).
 * 2. **Mutations broadcast `fileChanged`** — `writeFile` and `delete`
 *    each fire exactly one notify with the matching path + kind.
 * 3. **Watches are subscription-scoped** — `listen('watch', request)`
 *    instantiates one underlying watcher per subscription, the host's
 *    `unsubscribe` is invoked on iterator return / abort, and a
 *    bridge-host `dispose()` tears down every still-open watch.
 *
 * Uses a plain `node:worker_threads` `MessageChannel` + `wrapMessagePort`
 * to stand in for `MessageChannelMain`; the `Port<unknown>` shape is
 * wire-identical so the assertions hold for the production Electron
 * topology too.
 *
 * @see docs/research/runtime-channel-blueprint-v5.md
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

import { createChannelClient, wrapMessagePort } from '@taucad/rpc';
import type { Channel, Port } from '@taucad/rpc';
import type { FileStat } from '@taucad/types';
import type { RuntimeFileSystemBase, RuntimeWatchEvent, RuntimeWatchRequest } from '@taucad/runtime';

import { createFsBridgeHost } from './fs-bridge.js';
import type { FsBridgeHostHandle } from './fs-bridge.js';
import { fsProtocolSessionKey } from '#shared/fs-protocol.js';
import type { FsProtocol } from '#shared/fs-protocol.js';

/* Minimal in-memory `RuntimeFileSystemBase` with a manually-emit-able
 * watch surface. Built fresh per test so assertions on watcher lifecycle
 * (subscribe/unsubscribe counts) don't bleed between cases.
 *
 * Only exposes the methods the bridge actually calls — keeping the stub
 * narrow makes the contract under test obvious. The unused
 * `FileSystemProvider` shape is filled in via `as unknown as` only for
 * the slots the bridge never invokes. */
type StubFs = RuntimeFileSystemBase & {
  files: Map<string, Uint8Array<ArrayBuffer>>;
  watcherCount: number;
  emit(event: RuntimeWatchEvent): void;
};

const utf8Encode = (text: string): Uint8Array<ArrayBuffer> => {
  /* Spec-compliant UTF-8 encoder so multi-byte / non-ASCII fixtures
   * round-trip correctly. The previous loop assumed 1 char === 1 byte
   * and would silently truncate non-Latin-1 input. */
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  const view = new Uint8Array(buffer);
  view.set(encoded);
  return view;
};

const createStubFs = (): StubFs => {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const handlers = new Set<(event: RuntimeWatchEvent) => void>();
  let watcherCount = 0;

  const stubCapabilities: RuntimeFileSystemBase['capabilities'] = {
    persistent: false,
    writable: true,
    quotaBased: false,
    caseSensitive: true,
  };
  const fs: StubFs = {
    id: 'stub',
    capabilities: stubCapabilities,
    files,
    get watcherCount() {
      return watcherCount;
    },
    emit(event: RuntimeWatchEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    },
    /* `readFile` overload pair: the encoded form returns `string`, the
     * default returns `Uint8Array<ArrayBuffer>`. Implemented as a
     * single async body that branches on encoding — mirrors the real
     * `FileSystemProvider` contract. */
    readFile: (async (path: string, encoding?: 'utf8') => {
      const data = files.get(path);
      if (!data) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
      if (encoding === 'utf8') {
        return new TextDecoder().decode(data);
      }
      return data;
    }) as RuntimeFileSystemBase['readFile'],
    async writeFile(path: string, data: Uint8Array<ArrayBuffer> | string) {
      const bytes = typeof data === 'string' ? utf8Encode(data) : data;
      files.set(path, bytes);
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      return [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    },
    async stat(path: string): Promise<FileStat> {
      const data = files.get(path);
      if (!data) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
      return { type: 'file', size: data.byteLength, mtimeMs: 0 };
    },
    async unlink(path: string) {
      if (!files.delete(path)) {
        const error = new Error(`ENOENT: ${path}`) as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
    },
    async exists(path: string) {
      return files.has(path);
    },
    /* The bridge only calls the subset above; the rest of
     * `FileSystemProvider` is unused here. Async no-op placeholders
     * satisfy the structural type without implementing irrelevant
     * behaviour. */
    mkdir: (async () => undefined) as RuntimeFileSystemBase['mkdir'],
    rmdir: (async () => undefined) as RuntimeFileSystemBase['rmdir'],
    rename: (async () => undefined) as RuntimeFileSystemBase['rename'],
    lstat: (async () => {
      throw new Error('not implemented');
    }) as RuntimeFileSystemBase['lstat'],
    dispose: () => undefined,
    watch(_request: RuntimeWatchRequest, handler: (event: RuntimeWatchEvent) => void) {
      watcherCount += 1;
      handlers.add(handler);
      return () => {
        if (handlers.delete(handler)) {
          watcherCount -= 1;
        }
      };
    },
  };

  return fs;
};

type Pair = {
  readonly hostPort: Port<unknown>;
  readonly clientPort: Port<unknown>;
};

const setupChannelPair = (): Pair => {
  const channel = new NodeMessageChannel();
  const hostPort = wrapMessagePort<unknown>(channel.port1, { label: 'fs.host' });
  const clientPort = wrapMessagePort<unknown>(channel.port2, { label: 'fs.client' });
  return { hostPort, clientPort };
};

describe('createFsBridgeHost (Phase 11 — Electron FS authority seam)', () => {
  let host: FsBridgeHostHandle | undefined;
  let client: Channel<FsProtocol> | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    host?.dispose();
    if (host) {
      await host.closed;
    }
    host = undefined;
  });

  const setup = (): { fs: StubFs; client: Channel<FsProtocol>; host: FsBridgeHostHandle } => {
    const fs = createStubFs();
    const { hostPort, clientPort } = setupChannelPair();
    host = createFsBridgeHost(hostPort, fs);
    client = createChannelClient<FsProtocol>({ port: clientPort, sessionKey: fsProtocolSessionKey });
    return { fs, client, host };
  };

  it('round-trips readFile in binary form across the FS authority seam', async () => {
    const { fs, client: c } = setup();
    fs.files.set('/a.bin', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    await c.ready;

    const result = await c.call('readFile', { path: '/a.bin' });

    expect(result).toBeInstanceOf(Uint8Array);
    expect([...(result as Uint8Array<ArrayBuffer>)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('round-trips readFile in utf8 form (returns string)', async () => {
    const { fs, client: c } = setup();
    fs.files.set('/a.txt', utf8Encode('hello fs'));

    await c.ready;

    const result = await c.call('readFile', { path: '/a.txt', encoding: 'utf8' });

    expect(typeof result).toBe('string');
    expect(result).toBe('hello fs');
  });

  it('round-trips readDir, stat, exists, and delete', async () => {
    const { fs, client: c } = setup();
    fs.files.set('/dir/a.txt', utf8Encode('a'));
    fs.files.set('/dir/b.txt', utf8Encode('bb'));

    await c.ready;

    expect(await c.call('readDir', { path: '/dir' })).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect(await c.call('stat', { path: '/dir/a.txt' })).toEqual({ type: 'file', size: 1, mtimeMs: 0 });
    expect(await c.call('exists', { path: '/dir/a.txt' })).toBe(true);
    expect(await c.call('exists', { path: '/dir/missing.txt' })).toBe(false);

    await c.call('delete', { path: '/dir/a.txt' });
    expect(fs.files.has('/dir/a.txt')).toBe(false);
  });

  it('writeFile triggers a single fileChanged notify with kind="updated"', async () => {
    const { fs, client: c } = setup();

    await c.ready;
    const notifies: Array<FsProtocol['notifies']['fileChanged']['args']> = [];
    c.onNotify('fileChanged', (args) => {
      notifies.push(args);
    });

    await c.call('writeFile', { path: '/created.txt', data: 'fresh' });

    expect(fs.files.get('/created.txt')).toBeDefined();
    expect(notifies).toEqual([{ path: '/created.txt', kind: 'updated' }]);
  });

  it('delete triggers a single fileChanged notify with kind="deleted"', async () => {
    const { fs, client: c } = setup();
    fs.files.set('/old.txt', utf8Encode('old'));

    await c.ready;
    const notifies: Array<FsProtocol['notifies']['fileChanged']['args']> = [];
    c.onNotify('fileChanged', (args) => {
      notifies.push(args);
    });

    await c.call('delete', { path: '/old.txt' });

    expect(notifies).toEqual([{ path: '/old.txt', kind: 'deleted' }]);
  });

  it('listens.watch streams host-emitted events to the renderer subscriber', async () => {
    const { fs, client: c } = setup();
    await c.ready;

    const events: RuntimeWatchEvent[] = [];
    const ac = new AbortController();
    /* Drain the iterable on a separate microtask so we can drive the
     * test sequentially: subscribe → emit → assert → abort. */
    const drainPromise = (async () => {
      try {
        for await (const event of c.listen('watch', { paths: ['/'] }, ac.signal)) {
          events.push(event);
        }
      } catch {
        /* Aborted via the supplied signal; nothing to surface. */
      }
    })();

    /* Wait long enough for the `subscribe` round-trip (a small batch of
     * microtasks); the channel allocates a stream id + acks before any
     * frames flow. Polling on `fs.watcherCount` is more deterministic
     * than a fixed `setTimeout`. */
    await vi.waitFor(
      () => {
        expect(fs.watcherCount).toBe(1);
      },
      { timeout: 1000 },
    );

    fs.emit({ type: 'change', path: '/x.txt' });
    fs.emit({ type: 'delete', path: '/y.txt' });

    await vi.waitFor(
      () => {
        expect(events).toHaveLength(2);
      },
      { timeout: 1000 },
    );
    expect(events[0]).toEqual({ type: 'change', path: '/x.txt' });
    expect(events[1]).toEqual({ type: 'delete', path: '/y.txt' });

    ac.abort();
    await drainPromise;

    /* Aborting the iterator must tear down the host-side watcher so a
     * renderer reload can never accumulate watcher leaks. */
    await vi.waitFor(
      () => {
        expect(fs.watcherCount).toBe(0);
      },
      { timeout: 1000 },
    );
  });

  it('host dispose() tears down every still-open watch subscription', async () => {
    const { fs, client: c, host: h } = setup();
    await c.ready;

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    /* Two parallel subscribers — both must be torn down on host dispose
     * even though neither client signalled abort. The drain helpers are
     * declared as named async functions (vs anonymous `void IIFE`s) so
     * the no-async-iife rule passes — we still capture both promises so
     * the event loop has handles to await on if needed. */
    const drainA = async (): Promise<void> => {
      try {
        for await (const _ of c.listen('watch', { paths: ['/a'] }, ac1.signal)) {
          /* Drain */
        }
      } catch {
        /* Dropped */
      }
    };
    const drainB = async (): Promise<void> => {
      try {
        for await (const _ of c.listen('watch', { paths: ['/b'] }, ac2.signal)) {
          /* Drain */
        }
      } catch {
        /* Dropped */
      }
    };
    const drainAPromise = drainA();
    const drainBPromise = drainB();

    await vi.waitFor(
      () => {
        expect(fs.watcherCount).toBe(2);
      },
      { timeout: 1000 },
    );

    h.dispose();
    await h.closed;

    /* Bridge-host teardown must cascade through to the underlying
     * `RuntimeFileSystemBase.watch` unsubscribers — a leak here would
     * leave native FS watchers in scope after the renderer disconnect
     * (R9). */
    expect(fs.watcherCount).toBe(0);

    /* Awaiting the drain promises ensures Vitest's async tracking sees
     * both iterators settle before the test exits — otherwise an
     * unhandled rejection from a still-pending iterator could surface
     * in a sibling test. */
    await Promise.all([drainAPromise, drainBPromise]);
  });

  it('readFile against a missing path surfaces the host error to the client', async () => {
    const { client: c } = setup();
    await c.ready;

    await expect(c.call('readFile', { path: '/missing.bin' })).rejects.toThrow(/ENOENT/);
  });
});
