import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wrapMessagePort } from '@taucad/rpc';
import type { Port } from '@taucad/rpc';
import { ChangeEventBus, tagEventOrigin } from '@taucad/filesystem';
import type { ChangeEvent } from '@taucad/types';
import { createFileSystemBridge, exposeFileSystem } from '#filesystem/filesystem-bridge.js';
import { createBridgeCall } from '#transport/_internal/runtime-filesystem-bridge.js';

const testBackend = 'memory';
const written = (path: string): ChangeEvent => ({ type: 'fileWritten', path, backend: testBackend });

function fsBridgePort(port: MessagePort, label: string): Port<unknown> {
  const wrapped = wrapMessagePort<unknown>(port, { label });
  if (wrapped.start !== undefined) {
    wrapped.start();
  }
  return wrapped;
}

describe('createFileSystemBridge', () => {
  it('should send disconnect message before closing port on dispose', () => {
    const postSpy = vi.spyOn(MessagePort.prototype, 'postMessage');
    try {
      const worker = {
        postMessage: vi.fn(),
      } as unknown as Worker;

      const handle = createFileSystemBridge(worker);
      handle.dispose();

      expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'disconnect' }));
    } finally {
      postSpy.mockRestore();
    }
  });
});

describe('exposeFileSystem throttled delivery', () => {
  let messageHandlers: Array<(event: MessageEvent) => void>;

  beforeEach(() => {
    messageHandlers = [];
    vi.stubGlobal('self', {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
        messageHandlers.push(handler);
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create ThrottledWorker when createThrottledWorker is provided', () => {
    let factoryCalled = false;

    const handle = exposeFileSystem(
      {},
      {
        changeEventBus: { subscribe: vi.fn(() => vi.fn()) },
        createCoalescer: () => ({ push: vi.fn(), flush: vi.fn(), dispose: vi.fn() }),
        createThrottledWorker: () => {
          factoryCalled = true;
          return { push: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
        },
      },
    );

    expect(factoryCalled).toBe(true);

    handle.cleanup();
  });

  it('should pass coalesced events to throttled worker push', () => {
    const pushFunction = vi.fn();
    let coalescerDeliver: ((events: ChangeEvent[]) => void) | undefined;

    const handle = exposeFileSystem(
      {},
      {
        changeEventBus: { subscribe: vi.fn(() => vi.fn()) },
        createCoalescer: (deliver) => {
          coalescerDeliver = deliver;
          return { push: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
        },
        createThrottledWorker: () => ({
          push: pushFunction,
          flush: vi.fn(),
          dispose: vi.fn(),
        }),
      },
    );

    expect(coalescerDeliver).toBeDefined();
    const a = written('/a.txt');
    const b = written('/b.txt');
    const batch = [a, b];
    coalescerDeliver!(batch);

    expect(pushFunction).toHaveBeenCalledTimes(1);
    expect(pushFunction).toHaveBeenCalledWith(batch);

    handle.cleanup();
  });

  it('should dispose ThrottledWorker on bridge cleanup', () => {
    const disposeFunction = vi.fn();

    const handle = exposeFileSystem(
      {},
      {
        changeEventBus: { subscribe: vi.fn(() => vi.fn()) },
        createCoalescer: () => ({ push: vi.fn(), flush: vi.fn(), dispose: vi.fn() }),
        createThrottledWorker: () => ({
          push: vi.fn(),
          flush: vi.fn(),
          dispose: disposeFunction,
        }),
      },
    );

    handle.cleanup();

    expect(disposeFunction).toHaveBeenCalledTimes(1);
  });

  it('should deliver directly to handles when no throttled worker is provided', () => {
    let coalescerDeliver: ((events: ChangeEvent[]) => void) | undefined;

    const handle = exposeFileSystem(
      {},
      {
        changeEventBus: { subscribe: vi.fn(() => vi.fn()) },
        createCoalescer: (deliver) => {
          coalescerDeliver = deliver;
          return { push: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
        },
      },
    );

    expect(coalescerDeliver).toBeDefined();
    const writtenEvent = written('/a.txt');
    coalescerDeliver!([writtenEvent]);

    handle.cleanup();
  });

  it('should route throttled worker output through deliverToHandles', () => {
    let throttledHandler: ((chunk: ChangeEvent[]) => void) | undefined;
    let coalescerDeliver: ((events: ChangeEvent[]) => void) | undefined;

    const handle = exposeFileSystem(
      {},
      {
        changeEventBus: { subscribe: vi.fn(() => vi.fn()) },
        createCoalescer: (deliver) => {
          coalescerDeliver = deliver;
          return { push: vi.fn(), flush: vi.fn(), dispose: vi.fn() };
        },
        createThrottledWorker: (handler) => {
          throttledHandler = handler;
          return {
            push: (items: ChangeEvent[]) => {
              handler(items);
            },
            flush: vi.fn(),
            dispose: vi.fn(),
          };
        },
      },
    );

    const channel = new MessageChannel();
    for (const h of messageHandlers) {
      h(new MessageEvent('message', { data: { type: 'connect', port: channel.port1 } }));
    }

    expect(handle.serverHandles.size).toBe(1);
    expect(throttledHandler).toBeDefined();

    const serverHandle = [...handle.serverHandles.values()][0]!;
    const emitSpy = vi.spyOn(serverHandle, 'emit');

    const first = written('/a.txt');
    const second = written('/b.txt');
    coalescerDeliver!([first, second]);

    expect(emitSpy).toHaveBeenCalledWith('fileChanged', first);
    expect(emitSpy).toHaveBeenCalledWith('fileChanged', second);

    handle.cleanup();
    channel.port2.close();
  });
});

describe('exposeFileSystem skip-originator dispatch', () => {
  let messageHandlers: Array<(event: MessageEvent) => void>;

  beforeEach(() => {
    messageHandlers = [];
    vi.stubGlobal('self', {
      addEventListener: (_type: string, handler: (event: MessageEvent) => void) => {
        messageHandlers.push(handler);
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should deliver fileChanged to peer ports but skip the originating port on self-write', async () => {
    const bus = new ChangeEventBus();

    const handle = exposeFileSystem(
      {
        async writeFile(
          path: string,
          data: Uint8Array<ArrayBuffer>,
          context?: { originClientId?: string },
        ): Promise<void> {
          void data;
          const event: ChangeEvent = { type: 'fileWritten', path, backend: 'memory' };
          if (context?.originClientId !== undefined) {
            tagEventOrigin(event, context.originClientId);
          }
          bus.emit(event);
        },
      },
      {
        changeEventBus: bus,
      },
    );

    const fireConnect = (port: MessagePort) => {
      const mh = messageHandlers[0];
      expect(mh).toBeDefined();
      mh!(new MessageEvent('message', { data: { type: 'connect', port } }));
    };

    const chA = new MessageChannel();
    const chB = new MessageChannel();
    fireConnect(chA.port1);
    fireConnect(chB.port1);

    expect(handle.serverHandles.size).toBe(2);

    const clientA = createBridgeCall(fsBridgePort(chA.port2, 'fs-bridge-client-a'));
    const clientB = createBridgeCall(fsBridgePort(chB.port2, 'fs-bridge-client-b'));

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const offA = clientA.listen('fileChanged', (d) => {
      receivedA.push(d);
    });
    const offB = clientB.listen('fileChanged', (d) => {
      receivedB.push(d);
    });

    const bytes = new TextEncoder().encode('hi');
    await clientA.call('writeFile', ['/x.txt', bytes]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]).toEqual({ type: 'fileWritten', path: '/x.txt', backend: 'memory' });

    offA();
    offB();
    clientA.dispose();
    clientB.dispose();
    handle.cleanup();
    chA.port2.close();
    chB.port2.close();
  });

  it('should deliver observer-sourced bus events to every connected port', async () => {
    const bus = new ChangeEventBus();

    const handle = exposeFileSystem(
      { readFile: vi.fn() },
      {
        changeEventBus: bus,
      },
    );

    const fireConnect = (port: MessagePort) => {
      messageHandlers[0]!(new MessageEvent('message', { data: { type: 'connect', port } }));
    };

    const chA = new MessageChannel();
    const chB = new MessageChannel();
    fireConnect(chA.port1);
    fireConnect(chB.port1);

    const clientA = createBridgeCall(fsBridgePort(chA.port2, 'fs-bridge-client-a'));
    const clientB = createBridgeCall(fsBridgePort(chB.port2, 'fs-bridge-client-b'));

    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    clientA.listen('fileChanged', (d) => {
      receivedA.push(d);
    });
    clientB.listen('fileChanged', (d) => {
      receivedB.push(d);
    });

    bus.emit({ type: 'fileWritten', path: '/ext.txt', backend: 'memory' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
    expect(receivedA[0]).toEqual({ type: 'fileWritten', path: '/ext.txt', backend: 'memory' });
    expect(receivedB[0]).toEqual({ type: 'fileWritten', path: '/ext.txt', backend: 'memory' });

    clientA.dispose();
    clientB.dispose();
    handle.cleanup();
    chA.port2.close();
    chB.port2.close();
  });
});
