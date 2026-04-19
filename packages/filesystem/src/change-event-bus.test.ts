import { describe, it, expect, vi } from 'vitest';
import { ChangeEventBus } from '#change-event-bus.js';
import type { ChangeEvent } from '#types.js';

const mockBackend = 'memory';

function fileWrittenEvent(path: string): ChangeEvent {
  return { type: 'fileWritten', path, backend: mockBackend };
}

describe('ChangeEventBus', () => {
  it('should deliver emitted events to subscribers', () => {
    const bus = new ChangeEventBus();
    const handler = vi.fn();

    bus.subscribe(handler);
    bus.emit(fileWrittenEvent('/foo.txt'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'fileWritten', path: '/foo.txt', backend: mockBackend });
  });

  it('should deliver events to all subscribers', () => {
    const bus = new ChangeEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.subscribe(handler1);
    bus.subscribe(handler2);
    bus.emit(fileWrittenEvent('/bar.txt'));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler1).toHaveBeenCalledWith({ type: 'fileWritten', path: '/bar.txt', backend: mockBackend });
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledWith({ type: 'fileWritten', path: '/bar.txt', backend: mockBackend });
  });

  it('should remove the handler when unsubscribe is called', () => {
    const bus = new ChangeEventBus();
    const handler = vi.fn();

    const unsubscribe = bus.subscribe(handler);
    bus.emit(fileWrittenEvent('/first.txt'));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    bus.emit(fileWrittenEvent('/second.txt'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should clear all subscribers when dispose() is called', () => {
    const bus = new ChangeEventBus();
    const handler = vi.fn();

    bus.subscribe(handler);
    bus.emit(fileWrittenEvent('/before.txt'));
    expect(handler).toHaveBeenCalledTimes(1);

    bus.dispose();
    bus.emit(fileWrittenEvent('/after.txt'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not affect other subscribers when one subscriber throws', () => {
    const bus = new ChangeEventBus();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failingHandler = vi.fn(() => {
      throw new Error('subscriber error');
    });
    const succeedingHandler = vi.fn();

    bus.subscribe(failingHandler);
    bus.subscribe(succeedingHandler);
    bus.emit(fileWrittenEvent('/test.txt'));

    expect(failingHandler).toHaveBeenCalledTimes(1);
    expect(succeedingHandler).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[ChangeEventBus] Subscriber error:', expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});
