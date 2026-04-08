import process from 'node:process';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SharedPool } from '@taucad/memory';
import { createWorkerDispatcher } from '#framework/runtime-worker-dispatcher.js';
import type { KernelWorker } from '#framework/kernel-worker.js';
import type { RuntimeMessagePort } from '#framework/runtime-message-adapter.js';
import type { RuntimeCommand, RuntimeResponse } from '#types/runtime-protocol.types.js';

type MessageHandler = (data: RuntimeCommand | RuntimeResponse) => void;

function createMockPort(): RuntimeMessagePort & {
  simulateMessage: (command: RuntimeCommand) => void;
  sentMessages: RuntimeResponse[];
} {
  let handler: MessageHandler | undefined;
  const sentMessages: RuntimeResponse[] = [];

  return {
    postMessage(message: RuntimeCommand | RuntimeResponse) {
      sentMessages.push(message as RuntimeResponse);
    },
    onMessage(callback: MessageHandler) {
      handler = callback;
    },
    close: vi.fn(),
    simulateMessage(command: RuntimeCommand) {
      handler?.(command);
    },
    sentMessages,
  };
}

function createMockWorker(overrides?: Partial<KernelWorker> & { geometryPool?: SharedPool }): KernelWorker {
  const { geometryPool, ...rest } = overrides ?? {};
  const base = {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    render: vi.fn<() => Promise<{ success: true; data: unknown[] }>>().mockResolvedValue({ success: true, data: [] }),
    exportGeometry: vi
      .fn<() => Promise<{ success: true; data: unknown[] }>>()
      .mockResolvedValue({ success: true, data: [] }),
    cleanup: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    notifyFileChanged: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    configureMiddleware: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ensureLoadedBundler: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    setTelemetrySend: vi.fn(),
    flushTelemetry: vi.fn(),
    setSignalBuffer: vi.fn(),
    setGeometryPoolBuffer: vi.fn(),
    setFilePoolBuffer: vi.fn(),
    geometryPool: geometryPool ?? undefined,
    ...rest,
  };
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to KernelWorker
  return base as unknown as KernelWorker;
}

async function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

describe('createWorkerDispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('normal operation', () => {
    it('responds with initialized on successful init', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '1',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'initialized');
      expect(response).toEqual({ type: 'initialized', requestId: '1' });
    });

    it('responds with error when init throws', async () => {
      const worker = createMockWorker({
        initialize: vi.fn().mockRejectedValue(new Error('WASM load failed')),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '2',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'error');
      expect(response).toBeDefined();
      expect(response!.type).toBe('error');
      expect((response as { issues: Array<{ message: string }> }).issues[0]!.message).toContain('WASM load failed');
    });

    it('responds with exported on successful export', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'export',
        requestId: '3',
        format: 'stl',
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'exported');
      expect(response).toBeDefined();
    });

    it('should call setGeometryPoolBuffer and setFilePoolBuffer when pool buffers are present in initialize command', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      const geometryBuffer = new SharedArrayBuffer(4096);
      const fileBuffer = new SharedArrayBuffer(8192);

      port.simulateMessage({
        type: 'initialize',
        requestId: '10',
        options: {},
        middlewareEntries: [],
        geometryPoolBuffer: geometryBuffer,
        filePoolBuffer: fileBuffer,
      });

      await waitForMicrotasks();
      expect(worker.setGeometryPoolBuffer).toHaveBeenCalledWith(geometryBuffer);
      expect(worker.setFilePoolBuffer).toHaveBeenCalledWith(fileBuffer);
    });
  });

  describe('unhandled rejection trap', () => {
    let originalListenerCount: number;

    beforeEach(() => {
      originalListenerCount = process.listenerCount('unhandledRejection');
    });

    afterEach(() => {
      // Verify no listeners leaked
      const currentCount = process.listenerCount('unhandledRejection');
      expect(currentCount).toBeLessThanOrEqual(originalListenerCount + 1);
    });

    it('catches unhandled rejections during init and sends error response', async () => {
      const worker = createMockWorker({
        initialize: vi.fn().mockImplementation(
          async () =>
            new Promise<void>(() => {
              // Simulates Emscripten's pthread init: throws in a fire-and-forget promise
              // oxlint-disable-next-line promise/prefer-await-to-then -- oxlint false positive: flags Promise.reject() static call, not .then() chain
              void Promise.reject(new Error('SharedArrayBuffer transfer requires self.crossOriginIsolated'));
            }),
        ),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '10',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'crossOriginIsolated',
      );
    });

    it('catches unhandled rejections during render and sends error response', async () => {
      const worker = createMockWorker({
        render: vi.fn().mockImplementation(
          async () =>
            new Promise(() => {
              // oxlint-disable-next-line promise/prefer-await-to-then -- oxlint false positive: flags Promise.reject() static call, not .then() chain
              void Promise.reject(new Error('WASM worker crash'));
            }),
        ),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'render',
        requestId: '11',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'WASM worker crash',
      );
    });

    it('catches unhandled rejections during export and sends error response', async () => {
      const worker = createMockWorker({
        exportGeometry: vi.fn().mockImplementation(
          async () =>
            new Promise(() => {
              // oxlint-disable-next-line promise/prefer-await-to-then -- oxlint false positive: flags Promise.reject() static call, not .then() chain
              void Promise.reject(new Error('export worker failure'));
            }),
        ),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'export',
        requestId: '12',
        format: 'stl',
      });

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'export worker failure',
      );
    });

    it('cleans up the listener after successful operation', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '20',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();

      const currentCount = process.listenerCount('unhandledRejection');
      expect(currentCount).toBe(originalListenerCount);
    });

    it('cleans up the listener after failed operation', async () => {
      const worker = createMockWorker({
        initialize: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '21',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();

      const currentCount = process.listenerCount('unhandledRejection');
      expect(currentCount).toBe(originalListenerCount);
    });

    it('handles non-Error rejection reasons gracefully', async () => {
      const worker = createMockWorker({
        initialize: vi.fn().mockImplementation(
          async () =>
            new Promise<void>(() => {
              // oxlint-disable-next-line prefer-promise-reject-errors, promise/prefer-await-to-then -- testing non-Error rejection; oxlint false positive on Promise.reject()
              void Promise.reject('plain string rejection');
            }),
        ),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: '30',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'plain string rejection',
      );
    });
  });

  describe('cancel command', () => {
    it('should handle cancel command without crashing', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'cancel',
        requestId: 'cancel-1',
      });

      await waitForMicrotasks();

      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeUndefined();
    });
  });

  describe('sync error catch paths', () => {
    it('should send error response when setFile handler throws', async () => {
      const worker = createMockWorker({
        handleSetFile: vi.fn().mockImplementation(() => {
          throw new Error('setFile exploded');
        }),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'setFile',
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      } as RuntimeCommand);

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'setFile exploded',
      );
    });

    it('should send error response when setParameters handler throws', async () => {
      const worker = createMockWorker({
        handleSetParameters: vi.fn().mockImplementation(() => {
          throw new Error('setParameters exploded');
        }),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'setParameters',
        parameters: { key: 'value' },
      } as RuntimeCommand);

      await waitForMicrotasks();
      const errorResponse = port.sentMessages.find((m) => m.type === 'error');
      expect(errorResponse).toBeDefined();
      expect((errorResponse as { issues: Array<{ message: string }> }).issues[0]!.message).toContain(
        'setParameters exploded',
      );
    });
  });

  describe('setRenderTimeout', () => {
    it('should call worker.setRenderTimeout on setRenderTimeout command', async () => {
      const worker = createMockWorker();
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'setRenderTimeout',
        timeoutMs: 60_000,
      } as RuntimeCommand);

      await waitForMicrotasks();
      expect(worker.setRenderTimeout).toHaveBeenCalledWith(60_000);
    });
  });

  describe('geometry transport types', () => {
    it('should auto-store geometry in pool and produce pooled delivery', async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const pool = new SharedPool(sab, { maxEntries: 64 });
      const content = new Uint8Array([10, 20, 30]);

      const gltfResult = {
        success: true as const,
        data: [{ format: 'gltf' as const, content, hash: 'dep-hash-0' }],
        issues: [],
      };

      const worker = createMockWorker({
        render: vi.fn().mockResolvedValue(gltfResult),
        geometryPool: pool,
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      expect(pool.has('dep-hash-0')).toBe(false);

      port.simulateMessage({
        type: 'render',
        requestId: 'r1',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();

      expect(pool.has('dep-hash-0')).toBe(true);
      const stored = pool.resolveCopy('dep-hash-0');
      expect(stored).toEqual(content);

      const response = port.sentMessages.find((m) => m.type === 'geometryComputed');
      expect(response).toBeDefined();

      const result = (response as { result: { success: boolean; data: unknown[] } }).result;
      expect(result.success).toBe(true);

      const geo = result.data[0] as { format: string; contentRef: { delivery: string; key: string } };
      expect(geo.format).toBe('gltf');
      expect(geo.contentRef.delivery).toBe('pooled');
      expect(geo.contentRef.key).toBe('dep-hash-0');
    });

    it('should fall back to inline delivery when pool.store fails due to oversized entry', async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const pool = new SharedPool(sab, { maxEntries: 64, maxEntryBytes: 2 });
      const content = new Uint8Array([10, 20, 30]);

      const gltfResult = {
        success: true as const,
        data: [{ format: 'gltf' as const, content, hash: 'oversized-0' }],
        issues: [],
      };

      const worker = createMockWorker({
        render: vi.fn().mockResolvedValue(gltfResult),
        geometryPool: pool,
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'render',
        requestId: 'r-over',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'geometryComputed');
      expect(response).toBeDefined();

      const result = (response as { result: { success: boolean; data: unknown[] } }).result;
      const geo = result.data[0] as { format: string; contentRef: { delivery: string; bytes: Uint8Array } };
      expect(geo.format).toBe('gltf');
      expect(geo.contentRef.delivery).toBe('inline');
      expect(geo.contentRef.bytes).toEqual(content);
    });

    it('should not double-store when geometry already exists in pool', async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const pool = new SharedPool(sab, { maxEntries: 64 });
      const content = new Uint8Array([10, 20, 30]);
      pool.store('pre-stored-0', content);

      const storeSpy = vi.spyOn(pool, 'store');

      const gltfResult = {
        success: true as const,
        data: [{ format: 'gltf' as const, content, hash: 'pre-stored-0' }],
        issues: [],
      };

      const worker = createMockWorker({
        render: vi.fn().mockResolvedValue(gltfResult),
        geometryPool: pool,
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'render',
        requestId: 'r-dup',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();
      expect(storeSpy).not.toHaveBeenCalled();

      const response = port.sentMessages.find((m) => m.type === 'geometryComputed');
      const result = (response as { result: { data: unknown[] } }).result;
      const geo = result.data[0] as { format: string; contentRef: { delivery: string } };
      expect(geo.contentRef.delivery).toBe('pooled');
    });

    it('should produce inline delivery when no pool is configured', async () => {
      const content = new Uint8Array([1, 2, 3]);
      const gltfResult = {
        success: true as const,
        data: [{ format: 'gltf' as const, content, hash: 'h1' }],
        issues: [],
      };

      const worker = createMockWorker({
        render: vi.fn().mockResolvedValue(gltfResult),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'render',
        requestId: 'r2',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'geometryComputed');
      expect(response).toBeDefined();

      const result = (response as { result: { success: boolean; data: unknown[] } }).result;
      const geo = result.data[0] as { format: string; contentRef: { delivery: string; bytes: Uint8Array } };
      expect(geo.format).toBe('gltf');
      expect(geo.contentRef.delivery).toBe('inline');
      expect(geo.contentRef.bytes).toEqual(content);
    });

    it('should pass SVG geometries through unchanged', async () => {
      const svgResult = {
        success: true as const,
        data: [
          {
            format: 'svg' as const,
            paths: ['M0 0'],
            viewbox: '0 0 100 100',
            name: 'test',
            hash: 'svg-hash',
          },
        ],
        issues: [],
      };

      const worker = createMockWorker({
        render: vi.fn().mockResolvedValue(svgResult),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'render',
        requestId: 'r3',
        file: { path: '/', filename: 'test.ts' },
        params: {},
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'geometryComputed');
      expect(response).toBeDefined();

      const result = (response as { result: { success: boolean; data: unknown[] } }).result;
      const geo = result.data[0] as { format: string; paths: string[] };
      expect(geo.format).toBe('svg');
      expect(geo.paths).toEqual(['M0 0']);
    });

    it('should also convert autonomous onGeometryComputed callback to transport types', async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const pool = new SharedPool(sab, { maxEntries: 64 });
      const content = new Uint8Array([42]);

      let capturedCallback: ((result: unknown) => void) | undefined;

      const worker = createMockWorker({
        geometryPool: pool,
      });
      Object.defineProperty(worker, 'onGeometryComputed', {
        set(fn: (result: unknown) => void) {
          capturedCallback = fn;
        },
        get() {
          return capturedCallback;
        },
      });

      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'initialize',
        requestId: 'init1',
        options: {},
        middlewareEntries: [],
      });

      await waitForMicrotasks();

      capturedCallback!({
        success: true,
        data: [{ format: 'gltf', content, hash: 'auto-0' }],
        issues: [],
      });

      await waitForMicrotasks();
      const geoResponse = port.sentMessages.find((m) => m.type === 'geometryComputed');
      expect(geoResponse).toBeDefined();

      const result = (geoResponse as { result: { data: unknown[] } }).result;
      const geo = result.data[0] as { format: string; contentRef: { delivery: string } };
      expect(geo.format).toBe('gltf');
      expect(geo.contentRef.delivery).toBe('pooled');
    });

    it('should not affect export transferables', async () => {
      const exportBytes = new Uint8Array([1, 2, 3, 4]);
      const exportResult = {
        success: true as const,
        data: [{ bytes: exportBytes, mimeType: 'model/stl' }],
        issues: [],
      };

      const worker = createMockWorker({
        exportGeometry: vi.fn().mockResolvedValue(exportResult),
      });
      const port = createMockPort();
      createWorkerDispatcher(worker, port);

      port.simulateMessage({
        type: 'export',
        requestId: 'e1',
        format: 'stl',
      });

      await waitForMicrotasks();
      const response = port.sentMessages.find((m) => m.type === 'exported');
      expect(response).toBeDefined();
      const result = (response as { result: { data: Array<{ bytes: Uint8Array }> } }).result;
      expect(result.data[0]!.bytes).toEqual(exportBytes);
    });
  });
});
