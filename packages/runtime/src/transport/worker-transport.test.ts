import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RuntimeCommand } from '#types/runtime-protocol.types.js';
import { createWorkerTransport } from '#transport/worker-transport.js';

type MessageHandler = (event: { data: unknown }) => void;

type MockWorkerInstance = {
  url: string;
  options: { type: string };
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, handler: MessageHandler) => void;
  simulateMessage: (data: unknown) => void;
};

function createMockWorkerInstance(url: string, options: { type: string }): MockWorkerInstance {
  const listeners = new Map<string, MessageHandler[]>();
  return {
    url,
    options,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener(type: string, handler: MessageHandler): void {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    simulateMessage(data: unknown): void {
      const handlers = listeners.get('message') ?? [];
      for (const handler of handlers) {
        handler({ data });
      }
    },
  };
}

describe('createWorkerTransport', () => {
  let originalWorker: unknown;
  let mockWorkerInstance: MockWorkerInstance | undefined;

  beforeEach(() => {
    originalWorker = (globalThis as Record<string, unknown>)['Worker'];
    mockWorkerInstance = undefined;

    function workerStub(url: string, options: { type: string }): MockWorkerInstance {
      mockWorkerInstance = createMockWorkerInstance(url, options);
      return mockWorkerInstance;
    }

    (globalThis as Record<string, unknown>)['Worker'] = workerStub;
  });

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (globalThis as Record<string, unknown>)['Worker'];
    } else {
      (globalThis as Record<string, unknown>)['Worker'] = originalWorker;
    }
    mockWorkerInstance = undefined;
  });

  it('should create a Worker with type module', () => {
    createWorkerTransport('https://example.com/worker.js');

    expect(mockWorkerInstance).toBeDefined();
    expect(mockWorkerInstance!.url).toBe('https://example.com/worker.js');
    expect(mockWorkerInstance!.options).toEqual({ type: 'module' });
  });

  it('should delegate send to worker.postMessage without transferables', () => {
    const transport = createWorkerTransport('https://example.com/worker.js');
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- plain object required for postMessage serialization
    const command = { type: 'initialize', requestId: '1' } as RuntimeCommand;

    transport.send(command);

    expect(mockWorkerInstance!.postMessage).toHaveBeenCalledWith(command);
    expect(mockWorkerInstance!.postMessage).toHaveBeenCalledTimes(1);
  });

  it('should delegate send to worker.postMessage with transferables', () => {
    const transport = createWorkerTransport('https://example.com/worker.js');
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- plain object required for postMessage serialization
    const command = { type: 'initialize', requestId: '1' } as RuntimeCommand;
    const buffer = new ArrayBuffer(8);
    const transferables = [buffer];

    transport.send(command, transferables);

    expect(mockWorkerInstance!.postMessage).toHaveBeenCalledWith(command, transferables);
  });

  it('should delegate onMessage to worker.addEventListener for message events', () => {
    const transport = createWorkerTransport('https://example.com/worker.js');
    const handler = vi.fn();

    transport.onMessage(handler);

    const responseData = { type: 'initialized', requestId: '1', capabilities: { routes: [], renderSchemas: {} } };
    mockWorkerInstance!.simulateMessage(responseData);

    expect(handler).toHaveBeenCalledWith(responseData);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should call worker.terminate on close', () => {
    const transport = createWorkerTransport('https://example.com/worker.js');

    transport.close();

    expect(mockWorkerInstance!.terminate).toHaveBeenCalledTimes(1);
  });

  it('should expose the underlying worker instance', () => {
    const transport = createWorkerTransport('https://example.com/worker.js');

    expect(transport.worker).toBe(mockWorkerInstance);
  });
});
