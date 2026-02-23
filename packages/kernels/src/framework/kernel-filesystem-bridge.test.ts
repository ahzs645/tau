import { describe, it, expect, vi } from 'vitest';
import { fromMemoryFS } from '#client/filesystem-constructors.js';
import {
  createFileSystemServer,
  createFileSystemProxy,
  createFileSystemPort,
} from '#framework/kernel-filesystem-bridge.js';

describe('kernel-filesystem-bridge', () => {
  describe('createFileSystemServer + createFileSystemProxy integration', () => {
    it('should read a file as utf8 through the bridge', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/test.ts': 'const x = 1;' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      const content = await proxy.readFile('/test.ts', 'utf8');
      expect(content).toBe('const x = 1;');
    });

    it('should read a file as Uint8Array through the bridge', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/test.ts': 'hello' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      const content = await proxy.readFile('/test.ts');
      expect(content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(content)).toBe('hello');
    });

    it('should write and read back a file', async () => {
      const fs = fromMemoryFS();
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      await proxy.writeFile('/new.txt', 'written content');
      const content = await proxy.readFile('/new.txt', 'utf8');
      expect(content).toBe('written content');
    });

    it('should create directories and list them', async () => {
      const fs = fromMemoryFS();
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      await proxy.mkdir('/mydir');
      await proxy.writeFile('/mydir/file.txt', 'data');
      const entries = await proxy.readdir('/mydir');
      expect(entries).toContain('file.txt');
    });

    it('should delete a file via unlink', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/del.txt': 'gone' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      expect(await proxy.exists('/del.txt')).toBe(true);
      await proxy.unlink('/del.txt');
      expect(await proxy.exists('/del.txt')).toBe(false);
    });

    it('should stat a file with correct type and size', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/stat.txt': 'abcde' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      const stat = await proxy.stat('/stat.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(5);
      expect(stat.mtimeMs).toBeTypeOf('number');
    });

    it('should report exists correctly', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/yes.txt': 'here' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      expect(await proxy.exists('/yes.txt')).toBe(true);
      expect(await proxy.exists('/no.txt')).toBe(false);
    });
  });

  describe('createFileSystemServer error handling', () => {
    it('should serialize filesystem errors across the bridge', async () => {
      const fs = fromMemoryFS();
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      await expect(proxy.readFile('/nonexistent.txt', 'utf8')).rejects.toThrow('ENOENT');
    });

    it('should reject calls to unknown methods', async () => {
      const fs = fromMemoryFS();
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);

      // Send a raw message with an unknown method from the consumer side (port2)
      // and listen for the error response
      const result = await new Promise<{ id: number; error?: string }>((resolve) => {
        const handler = (event: MessageEvent): void => {
          resolve(event.data as { id: number; error?: string });
          channel.port2.removeEventListener('message', handler);
        };

        channel.port2.addEventListener('message', handler);
        channel.port2.start();
        channel.port2.postMessage({ id: 999, method: 'fakeMethod', args: [] });
      });
      expect(result.error).toContain('Unknown method');
    });
  });

  describe('proxy call timeout', () => {
    it('should reject with timeout error when server never responds', async () => {
      vi.useFakeTimers();

      try {
        const channel = new MessageChannel();
        const proxy = createFileSystemProxy(channel.port2);

        const readPromise = proxy.readFile('/never.txt', 'utf8');
        const expectation = expect(readPromise).rejects.toThrow("Filesystem call 'readFile' timed out");

        await vi.advanceTimersByTimeAsync(30_000);
        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reject before timeout elapses when server responds in time', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/fast.txt': 'quick' });
      const channel = new MessageChannel();
      createFileSystemServer(fs, channel.port1);
      const proxy = createFileSystemProxy(channel.port2);

      const content = await proxy.readFile('/fast.txt', 'utf8');
      expect(content).toBe('quick');
    });
  });

  describe('FileSystemProxy dispose', () => {
    it('should reject pending calls when disposed', async () => {
      const channel = new MessageChannel();
      const proxy = createFileSystemProxy(channel.port2);

      const readPromise = proxy.readFile('/pending.txt', 'utf8');
      proxy.dispose();

      await expect(readPromise).rejects.toThrow('Filesystem proxy closed');
      channel.port1.close();
    });

    it('should reject multiple pending calls when disposed', async () => {
      const channel = new MessageChannel();
      const proxy = createFileSystemProxy(channel.port2);

      const read1 = proxy.readFile('/a.txt', 'utf8');
      const read2 = proxy.readFile('/b.txt', 'utf8');
      const write1 = proxy.writeFile('/c.txt', 'data');
      proxy.dispose();

      await expect(read1).rejects.toThrow('Filesystem proxy closed');
      await expect(read2).rejects.toThrow('Filesystem proxy closed');
      await expect(write1).rejects.toThrow('Filesystem proxy closed');
      channel.port1.close();
    });

    it('should not throw when disposed with no pending calls', () => {
      const channel = new MessageChannel();
      const proxy = createFileSystemProxy(channel.port2);

      expect(() => {
        proxy.dispose();
      }).not.toThrow();
      channel.port1.close();
    });

    it('should not throw when disposed twice', () => {
      const channel = new MessageChannel();
      const proxy = createFileSystemProxy(channel.port2);

      expect(() => {
        proxy.dispose();
        proxy.dispose();
      }).not.toThrow();
      channel.port1.close();
    });
  });

  describe('createFileSystemPort convenience', () => {
    it('should return a working MessagePort', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- filesystem paths use non-camelCase names
      const fs = fromMemoryFS({ '/port.txt': 'via port' });
      const port = createFileSystemPort(fs);
      const proxy = createFileSystemProxy(port);

      const content = await proxy.readFile('/port.txt', 'utf8');
      expect(content).toBe('via port');
    });

    it('should support write operations through the port', async () => {
      const fs = fromMemoryFS();
      const port = createFileSystemPort(fs);
      const proxy = createFileSystemProxy(port);

      await proxy.writeFile('/new.txt', 'new data');
      const content = await proxy.readFile('/new.txt', 'utf8');
      expect(content).toBe('new data');
    });
  });
});
