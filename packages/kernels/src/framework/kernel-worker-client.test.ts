import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KernelWorkerClient, RenderSupersededError, isRenderSupersededError } from '#framework/kernel-worker-client.js';
import { signalSlot } from '#types/kernel-protocol.types.js';
import type { KernelTransport } from '#transport/kernel-transport.js';
import type { KernelCommand, KernelResponse } from '#types/kernel-protocol.types.js';

function createMockTransport(): KernelTransport & {
  simulateResponse: (response: KernelResponse) => void;
} {
  let handler: ((message: KernelResponse) => void) | undefined;

  return {
    send: vi.fn<(message: KernelCommand, transferables?: Transferable[]) => void>(),
    onMessage(callback: (message: KernelResponse) => void): void {
      handler = callback;
    },
    close: vi.fn(),
    simulateResponse(response: KernelResponse): void {
      handler?.(response);
    },
  };
}

describe('KernelWorkerClient', () => {
  describe('terminate() rejects pending promises', () => {
    it('should reject a pending initialize call', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const channel = new MessageChannel();
      const initPromise = client.initialize({
        options: {},
        fileSystemPort: channel.port1,
        middlewareEntries: [],
      });

      client.terminate();

      await expect(initPromise).rejects.toThrow('Kernel client terminated');
      channel.port1.close();
      channel.port2.close();
    });

    it('should reject a pending render call', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });

      client.terminate();

      await expect(renderPromise).rejects.toThrow('Kernel client terminated');
    });

    it('should reject a pending export call', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const exportPromise = client.exportGeometry('stl');

      client.terminate();

      await expect(exportPromise).rejects.toThrow('Kernel client terminated');
    });

    it('should reject all pending promises simultaneously', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const channel = new MessageChannel();
      const initPromise = client.initialize({
        options: {},
        fileSystemPort: channel.port1,
        middlewareEntries: [],
      });
      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });
      const exportPromise = client.exportGeometry('stl');

      client.terminate();

      await expect(initPromise).rejects.toThrow('Kernel client terminated');
      await expect(renderPromise).rejects.toThrow('Kernel client terminated');
      await expect(exportPromise).rejects.toThrow('Kernel client terminated');
      channel.port1.close();
      channel.port2.close();
    });

    it('should close the transport after rejecting promises', () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      client.terminate();

      expect(transport.close).toHaveBeenCalledOnce();
    });

    it('should not throw when terminating with no pending promises', () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      expect(() => {
        client.terminate();
      }).not.toThrow();
    });
  });

  describe('cancelPendingRender()', () => {
    it('should reject a pending render with RenderSupersededError', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });

      client.cancelPendingRender();

      await expect(renderPromise).rejects.toThrow(RenderSupersededError);
    });

    it('should be detected by isRenderSupersededError type guard', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });

      client.cancelPendingRender();

      try {
        await renderPromise;
      } catch (error) {
        expect(isRenderSupersededError(error)).toBe(true);
        return;
      }

      expect.fail('Expected renderPromise to reject');
    });

    it('should not match unrelated errors', () => {
      expect(isRenderSupersededError(new Error('some other error'))).toBe(false);
      expect(isRenderSupersededError(null)).toBe(false);
      expect(isRenderSupersededError('string')).toBe(false);
    });

    it('should send a cancel command to the transport', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });

      client.cancelPendingRender();

      try {
        await renderPromise;
      } catch {}

      const { calls } = vi.mocked(transport.send).mock;
      const cancelCommand = calls.find(([cmd]) => cmd.type === 'cancel');
      expect(cancelCommand).toBeDefined();
    });

    it('should be a no-op when no render is pending', () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      expect(() => {
        client.cancelPendingRender();
      }).not.toThrow();
    });
  });

  describe('handleMessage', () => {
    it('should call onLog callback when log response received', () => {
      const transport = createMockTransport();
      const onLog = vi.fn();
      const client = new KernelWorkerClient(transport, onLog);
      expect(client).toBeDefined();

      transport.simulateResponse({
        type: 'log',
        level: 'info',
        message: 'test log',
        origin: 'kernel',
        data: { extra: true },
      } as KernelResponse);

      expect(onLog).toHaveBeenCalledWith({
        level: 'info',
        message: 'test log',
        origin: 'kernel',
        data: { extra: true },
      });
    });

    it('should iterate logBatch entries and call onLog for each', () => {
      const transport = createMockTransport();
      const onLog = vi.fn();
      const client = new KernelWorkerClient(transport, onLog);
      expect(client).toBeDefined();

      transport.simulateResponse({
        type: 'logBatch',
        entries: [
          { level: 'info', message: 'log 1' },
          { level: 'warn', message: 'log 2' },
        ],
      } as KernelResponse);

      expect(onLog).toHaveBeenCalledTimes(2);
      expect(onLog).toHaveBeenCalledWith({ level: 'info', message: 'log 1' });
      expect(onLog).toHaveBeenCalledWith({ level: 'warn', message: 'log 2' });
    });

    it('should call onTelemetry when telemetry response received', () => {
      const transport = createMockTransport();
      const onTelemetry = vi.fn();
      const client = new KernelWorkerClient(transport, vi.fn(), { onTelemetry });
      expect(client).toBeDefined();

      const entries = [{ name: 'kernel.render', startTime: 100, duration: 50, workerTimeOrigin: 1000 }];
      transport.simulateResponse({
        type: 'telemetry',
        entries,
      } as KernelResponse);

      expect(onTelemetry).toHaveBeenCalledWith(entries);
    });

    it('should call onProgress when progress response received during render', async () => {
      const transport = createMockTransport();
      const onProgress = vi.fn();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
        onProgress,
      });

      transport.simulateResponse({
        type: 'progress',
        requestId: '0',
        phase: 'bundling',
      } as KernelResponse);

      expect(onProgress).toHaveBeenCalledWith('bundling', undefined);

      transport.simulateResponse({
        type: 'geometryComputed',
        requestId: '0',
        result: { success: true, data: [], issues: [] },
      } as KernelResponse);

      await renderPromise;
    });

    it('should reject pending init when error response received', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const channel = new MessageChannel();
      const initPromise = client.initialize({
        options: {},
        fileSystemPort: channel.port1,
        middlewareEntries: [],
      });

      transport.simulateResponse({
        type: 'error',
        requestId: '0',
        issues: [{ message: 'init failed', type: 'runtime', severity: 'error' }],
      } as KernelResponse);

      await expect(initPromise).rejects.toThrow('init failed');
      channel.port1.close();
      channel.port2.close();
    });

    it('should reject pending render when error response received', async () => {
      const transport = createMockTransport();
      const client = new KernelWorkerClient(transport, vi.fn());

      const renderPromise = client.render({
        file: { path: '/', filename: 'test.ts' },
        parameters: {},
      });

      transport.simulateResponse({
        type: 'error',
        requestId: '0',
        issues: [{ message: 'render failed', type: 'runtime', severity: 'error' }],
      } as KernelResponse);

      await expect(renderPromise).rejects.toThrow('render failed');
    });

    it('should call onStateChanged when stateChanged response received', () => {
      const transport = createMockTransport();
      const onStateChanged = vi.fn();
      const client = new KernelWorkerClient(transport, vi.fn(), { onStateChanged });
      expect(client).toBeDefined();

      transport.simulateResponse({
        type: 'stateChanged',
        state: 'idle',
        detail: 'render complete',
      } as KernelResponse);

      expect(onStateChanged).toHaveBeenCalledWith('idle', 'render complete');
    });

    it('should call onFilesChanged when filesChanged response received', () => {
      const transport = createMockTransport();
      const onFilesChanged = vi.fn();
      const client = new KernelWorkerClient(transport, vi.fn(), { onFilesChanged });
      expect(client).toBeDefined();

      transport.simulateResponse({
        type: 'filesChanged',
        paths: ['/src/main.ts', '/src/util.ts'],
      } as KernelResponse);

      expect(onFilesChanged).toHaveBeenCalledWith(['/src/main.ts', '/src/util.ts']);
    });

    it('should call onError callback when error received with no pending operations', () => {
      const transport = createMockTransport();
      const onError = vi.fn();
      const client = new KernelWorkerClient(transport, vi.fn(), { onError });
      expect(client).toBeDefined();

      transport.simulateResponse({
        type: 'error',
        requestId: '',
        issues: [{ message: 'background error', type: 'runtime', severity: 'error' }],
      } as KernelResponse);

      expect(onError).toHaveBeenCalledWith([{ message: 'background error', type: 'runtime', severity: 'error' }]);
    });
  });

  describe('SharedArrayBuffer signal channel', () => {
    let channel: MessageChannel;
    let transport: ReturnType<typeof createMockTransport>;
    let client: KernelWorkerClient;

    beforeEach(() => {
      transport = createMockTransport();
      client = new KernelWorkerClient(transport, vi.fn());
      channel = new MessageChannel();
    });

    let initPromise: Promise<void>;

    afterEach(async () => {
      transport.simulateResponse({ type: 'initialized', requestId: '0' });
      await initPromise;
      channel.port1.close();
      channel.port2.close();
    });

    function extractSignalBuffer(): SharedArrayBuffer {
      const initCall = vi.mocked(transport.send).mock.calls.find(([cmd]) => cmd.type === 'initialize');
      expect(initCall).toBeDefined();
      const buffer = (initCall![0] as KernelCommand & { signalBuffer?: SharedArrayBuffer }).signalBuffer;
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
      return buffer!;
    }

    function initAndExtract() {
      initPromise = client.initialize({
        options: {},
        fileSystemPort: channel.port1,
        middlewareEntries: [],
      });
      return new Int32Array(extractSignalBuffer());
    }

    it('should transfer the signal buffer during initialize', () => {
      initPromise = client.initialize({
        options: {},
        fileSystemPort: channel.port1,
        middlewareEntries: [],
      });

      const signalBuffer = extractSignalBuffer();
      expect(signalBuffer.byteLength).toBe(16);
    });

    it('should make incrementAbortGeneration visible to the worker-side view', () => {
      const workerView = initAndExtract();

      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(0);

      client.incrementAbortGeneration();
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(1);

      client.incrementAbortGeneration();
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(2);
    });

    it('should bump abort generation when setFile is called', () => {
      const workerView = initAndExtract();

      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(0);

      client.setFile({ path: '/', filename: 'box.ts' }, { width: 10 });
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(1);

      client.setFile({ path: '/', filename: 'sphere.ts' }, {});
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(2);
    });

    it('should bump abort generation when setParameters is called', () => {
      const workerView = initAndExtract();

      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(0);

      client.setParameters({ width: 20 });
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(1);

      client.setParameters({ width: 30 });
      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(2);
    });

    it('should allow the worker side to detect a stale generation after client bump', () => {
      const workerView = initAndExtract();

      const workerGeneration = Atomics.load(workerView, signalSlot.abortGeneration);
      client.setFile({ path: '/', filename: 'box.ts' }, {});

      expect(Atomics.load(workerView, signalSlot.abortGeneration)).not.toBe(workerGeneration);
    });

    it('should accumulate generations across mixed setFile and setParameters calls', () => {
      const workerView = initAndExtract();

      client.setFile({ path: '/', filename: 'box.ts' }, {});
      client.setParameters({ width: 10 });
      client.setParameters({ width: 20 });
      client.setFile({ path: '/', filename: 'sphere.ts' }, {});

      expect(Atomics.load(workerView, signalSlot.abortGeneration)).toBe(4);
    });
  });
});
