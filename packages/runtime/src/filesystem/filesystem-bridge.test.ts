import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createFileSystemBridge, exposeFileSystem } from '#filesystem/filesystem-bridge.js';
import type { ChangeEvent } from '@taucad/types';

const testBackend = 'memory';
const written = (path: string): ChangeEvent => ({ type: 'fileWritten', path, backend: testBackend });

describe('createFileSystemBridge', () => {
  const originalPostMessage = MessagePort.prototype.postMessage;
  afterEach(() => {
    MessagePort.prototype.postMessage = originalPostMessage;
  });

  it('should send disconnect message before closing port on dispose', () => {
    const messages: unknown[] = [];
    const worker = {
      postMessage: vi.fn(),
    } as unknown as Worker;

    const handle = createFileSystemBridge(worker);

    const originalPort2PostMessage = handle.port.postMessage.bind(handle.port);
    // @ts-expect-error - mock the postMessage method
    handle.port.postMessage = vi.fn((...args: Parameters<MessagePort['postMessage']>) => {
      messages.push(args[0]);
      originalPort2PostMessage(...args);
    });

    handle.dispose();

    expect(messages).toContainEqual({ type: 'disconnect' });
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
    const events = [written('/a.txt'), written('/b.txt')];
    coalescerDeliver!(events);

    expect(pushFunction).toHaveBeenCalledTimes(1);
    expect(pushFunction).toHaveBeenCalledWith(events);

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
    coalescerDeliver!([written('/a.txt')]);

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

    coalescerDeliver!([written('/a.txt'), written('/b.txt')]);

    expect(emitSpy).toHaveBeenCalledWith('fileChanged', written('/a.txt'));
    expect(emitSpy).toHaveBeenCalledWith('fileChanged', written('/b.txt'));

    handle.cleanup();
    channel.port2.close();
  });
});
