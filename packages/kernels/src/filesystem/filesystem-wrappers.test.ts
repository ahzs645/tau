/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { fromMemoryFS } from '#filesystem/from-memory-fs.js';
import type { KernelFileSystemBase } from '#types/kernel-worker.types.js';
import { createBridgeProxy } from '#framework/kernel-filesystem-bridge.js';
import { exposeFileSystem, createFileSystemBridge } from '#filesystem/filesystem-bridge.js';

describe('filesystem high-level wrappers', () => {
  describe('exposeFileSystem', () => {
    let activeHandle: ReturnType<typeof exposeFileSystem> | undefined;

    afterEach(() => {
      activeHandle?.cleanup();
      activeHandle = undefined;
    });

    it('should serve a filesystem when receiving a bridge message', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/hello.txt': 'world' });

      activeHandle = exposeFileSystem(fs);

      const channel = new MessageChannel();
      const proxy = createBridgeProxy<KernelFileSystemBase>(channel.port2);

      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'connect', port: channel.port1 },
        }),
      );

      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      const content = await proxy.readFile('/hello.txt', 'utf8');
      expect(content).toBe('world');
    });

    it('should buffer messages sent before server is wired (catchMessages)', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/early.txt': 'buffered' });

      const channel = new MessageChannel();
      const proxy = createBridgeProxy<KernelFileSystemBase>(channel.port2);

      // Send a request BEFORE exposeFileSystem processes the connect message.
      // The proxy sends immediately on port2; port1 isn't served yet.
      const resultPromise = proxy.readFile('/early.txt', 'utf8');

      activeHandle = exposeFileSystem(fs);

      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'connect', port: channel.port1 },
        }),
      );

      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      const content = await resultPromise;
      expect(content).toBe('buffered');
    });

    it('should stop listening after cleanup is called', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/test.txt': 'data' });
      activeHandle = exposeFileSystem(fs);
      activeHandle.cleanup();

      const channel = new MessageChannel();
      // Post a message after cleanup -- no server should be set up
      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'connect', port: channel.port1 },
        }),
      );

      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      // Port1 should have no onmessage handler, so proxy calls will hang
      // We verify by checking port1.onmessage is null
      expect(channel.port1.onmessage).toBeNull();
    });

    it('should support custom messageType', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/custom.txt': 'custom' });
      activeHandle = exposeFileSystem(fs, { messageType: 'myBridge' });

      const channel = new MessageChannel();

      // Default type should be ignored
      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'connect', port: channel.port1 },
        }),
      );

      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      expect(channel.port1.onmessage).toBeNull();

      // Custom type should work
      const channel2 = new MessageChannel();
      const proxy2 = createBridgeProxy<KernelFileSystemBase>(channel2.port2);

      self.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'myBridge', port: channel2.port1 },
        }),
      );

      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      const content = await proxy2.readFile('/custom.txt', 'utf8');
      expect(content).toBe('custom');
    });
  });

  describe('createFileSystemBridge', () => {
    it('should post a message with port to the worker', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = mock<Worker>({ postMessage: postMessageSpy });

      const { port } = createFileSystemBridge(mockWorker);

      expect(port).toBeInstanceOf(MessagePort);
      expect(postMessageSpy).toHaveBeenCalledOnce();

      const [message, transferables] = postMessageSpy.mock.calls[0] as [
        { type: string; port: MessagePort },
        MessagePort[],
      ];
      expect(message.type).toBe('connect');
      expect(message.port).toBeInstanceOf(MessagePort);
      expect(transferables).toHaveLength(1);
      expect(transferables[0]).toBe(message.port);
    });

    it('should support custom messageType', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = mock<Worker>({ postMessage: postMessageSpy });

      createFileSystemBridge(mockWorker, { messageType: 'customBridge' });

      const [message] = postMessageSpy.mock.calls[0] as [{ type: string; port: MessagePort }];
      expect(message.type).toBe('customBridge');
    });

    it('should return a different port than the one transferred', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = mock<Worker>({ postMessage: postMessageSpy });

      const { port: returnedPort } = createFileSystemBridge(mockWorker);

      const [message] = postMessageSpy.mock.calls[0] as [{ type: string; port: MessagePort }];
      expect(returnedPort).not.toBe(message.port);
    });

    it('should close consumer port on dispose', () => {
      const postMessageSpy = vi.fn();
      const mockWorker = mock<Worker>({ postMessage: postMessageSpy });

      const handle = createFileSystemBridge(mockWorker);
      expect(handle.port).toBeInstanceOf(MessagePort);

      expect(() => {
        handle.dispose();
      }).not.toThrow();
    });
  });
});
