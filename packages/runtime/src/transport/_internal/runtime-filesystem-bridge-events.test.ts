/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { wrapMessagePort, type Port } from '@taucad/rpc';
import {
  createBridgeServer,
  createBridgeCall,
  createBridgeProxy,
} from '#transport/_internal/runtime-filesystem-bridge.js';

function fsBridgePort(port: MessagePort, label: string): Port<unknown> {
  const wrapped = wrapMessagePort<unknown>(port, { label });
  if (wrapped.start !== undefined) {
    wrapped.start();
  }
  return wrapped;
}

describe('bridge event channel', () => {
  it('should deliver events from server to client via listen()', async () => {
    const channel = new MessageChannel();
    const handlers = {
      async ping(): Promise<string> {
        return 'pong';
      },
    };

    const server = createBridgeServer(handlers, fsBridgePort(channel.port1, 'fs-bridge-server'));
    const { listen, dispose } = createBridgeCall(fsBridgePort(channel.port2, 'fs-bridge-client'));

    const received: unknown[] = [];
    listen('fileChanged', (data) => {
      received.push(data);
    });

    server.emit('fileChanged', { path: '/test.txt' });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ path: '/test.txt' });

    dispose();
  });

  it('should support multiple event listeners for the same event', async () => {
    const channel = new MessageChannel();
    const server = createBridgeServer({}, fsBridgePort(channel.port1, 'fs-bridge-server'));
    const { listen, dispose } = createBridgeCall(fsBridgePort(channel.port2, 'fs-bridge-client'));

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    listen('change', handler1);
    listen('change', handler2);

    server.emit('change', { type: 'update' });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(handler1).toHaveBeenCalledWith({ type: 'update' });
    expect(handler2).toHaveBeenCalledWith({ type: 'update' });

    dispose();
  });

  it('should unsubscribe a specific listener', async () => {
    const channel = new MessageChannel();
    const server = createBridgeServer({}, fsBridgePort(channel.port1, 'fs-bridge-server'));
    const { listen, dispose } = createBridgeCall(fsBridgePort(channel.port2, 'fs-bridge-client'));

    const handler = vi.fn();
    const unsub = listen('change', handler);

    server.emit('change', 'first');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    server.emit('change', 'second');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(handler).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('should not interfere with RPC calls', async () => {
    const channel = new MessageChannel();
    const handlers = {
      async add(a: number, b: number): Promise<number> {
        return a + b;
      },
    };

    const server = createBridgeServer(handlers, fsBridgePort(channel.port1, 'fs-bridge-server'));
    const { call, listen, dispose } = createBridgeCall(fsBridgePort(channel.port2, 'fs-bridge-client'));

    const events: unknown[] = [];
    listen('notify', (data) => {
      events.push(data);
    });

    const result = await call('add', [3, 4]);
    expect(result).toBe(7);

    server.emit('notify', 'hello');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(events).toEqual(['hello']);

    dispose();
  });

  it('should expose listen() on bridge proxy', async () => {
    const channel = new MessageChannel();
    const handlers = {
      async echo(message: string): Promise<string> {
        return message;
      },
    };

    const server = createBridgeServer(handlers, fsBridgePort(channel.port1, 'fs-bridge-server'));
    const proxy = createBridgeProxy<{ echo(message: string): Promise<string> }>(
      fsBridgePort(channel.port2, 'fs-bridge-client'),
    );

    const events: unknown[] = [];
    proxy.listen('test', (data) => {
      events.push(data);
    });

    const result = await proxy.echo('hi');
    expect(result).toBe('hi');

    server.emit('test', { value: 42 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(events).toEqual([{ value: 42 }]);

    proxy.dispose();
  });

  it('should handle disconnect control message', async () => {
    const channel = new MessageChannel();
    const onDisconnect = vi.fn();
    createBridgeServer({}, fsBridgePort(channel.port1, 'fs-bridge-server'), { onDisconnect });

    const proxy = createBridgeProxy<Record<string, never>>(fsBridgePort(channel.port2, 'fs-bridge-client'));
    proxy.dispose();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
