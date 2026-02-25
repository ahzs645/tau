import { describe, it, expect, vi } from 'vitest';
import { KernelWorkerClient, RenderSupersededError, isRenderSupersededError } from '#framework/kernel-worker-client.js';
import type { KernelTransport } from '#transport/kernel-transport.js';
import type { KernelCommand, KernelResponse } from '#types/kernel-protocol.types.js';

function createMockTransport(): KernelTransport & { simulateResponse: (response: KernelResponse) => void } {
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
});
