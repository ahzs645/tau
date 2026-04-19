import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchRegistry } from '#watch-registry.js';
import { ChangeEventBus } from '#change-event-bus.js';
import { EventCoalescer } from '#event-coalescer.js';
import type { ChangeEvent, WatchEvent } from '#types.js';

const testBackend = 'memory';
const written = (path: string): ChangeEvent => ({ type: 'fileWritten', path, backend: testBackend });
const deleted = (path: string): ChangeEvent => ({ type: 'fileDeleted', path, backend: testBackend });

describe('Watch edit storm (100+ rapid events)', () => {
  let bus: ChangeEventBus;
  let registry: WatchRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new ChangeEventBus();
    registry = new WatchRegistry(bus);
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it('should coalesce 200 rapid writes to the same file into a single delivery', () => {
    const received: WatchEvent[] = [];
    registry.watch({ paths: ['/src'], recursive: true }, (event) => {
      received.push(event);
    });

    for (let i = 0; i < 200; i++) {
      bus.emit(written('/src/main.ts'));
    }

    vi.advanceTimersByTime(100);

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(expect.objectContaining({ type: 'change', path: '/src/main.ts' }));
  });

  it('should deliver all distinct paths from a 100-file storm without silent drops', () => {
    const received: WatchEvent[] = [];
    registry.watch({ paths: ['/src'], recursive: true }, (event) => {
      received.push(event);
    });

    const pathCount = 100;
    for (let i = 0; i < pathCount; i++) {
      bus.emit(written(`/src/file-${i}.ts`));
    }

    vi.advanceTimersByTime(100);

    expect(received.length).toBe(pathCount);
    const paths = new Set(received.map((event) => (event as { path: string }).path));
    expect(paths.size).toBe(pathCount);
  });

  it('should coalesce rapid write+delete pairs into zero events (cancel)', () => {
    const received: WatchEvent[] = [];
    registry.watch({ paths: ['/src'], recursive: true }, (event) => {
      received.push(event);
    });

    for (let i = 0; i < 50; i++) {
      bus.emit(written(`/src/tmp-${i}.ts`));
      bus.emit(deleted(`/src/tmp-${i}.ts`));
    }

    vi.advanceTimersByTime(100);

    expect(received.length).toBe(0);
  });

  it('should handle mixed event types across 100+ files correctly', () => {
    const received: WatchEvent[] = [];
    registry.watch({ paths: ['/src'], recursive: true }, (event) => {
      received.push(event);
    });

    for (let i = 0; i < 50; i++) {
      bus.emit(written(`/src/new-${i}.ts`));
    }
    for (let i = 0; i < 30; i++) {
      bus.emit(deleted(`/src/old-${i}.ts`));
    }
    for (let i = 0; i < 20; i++) {
      bus.emit(written(`/src/updated-${i}.ts`));
      bus.emit(written(`/src/updated-${i}.ts`));
    }

    vi.advanceTimersByTime(100);

    const changes = received.filter((event) => event.type === 'change');
    const deletes = received.filter((event) => event.type === 'delete');
    expect(changes.length).toBe(70);
    expect(deletes.length).toBe(30);
  });
});

describe('Watch subscribe/unsubscribe lifecycle', () => {
  let bus: ChangeEventBus;
  let registry: WatchRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new ChangeEventBus();
    registry = new WatchRegistry(bus);
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it('should handle 50 watch/unwatch cycles with no leaked subscriptions', () => {
    for (let i = 0; i < 50; i++) {
      const handler = vi.fn();
      const unsub = registry.watch({ paths: [`/project-${i}`], recursive: true }, handler, `owner-${i}`);
      unsub();
    }

    expect(registry.subscriptionCount).toBe(0);
    expect(registry.handlerCount).toBe(0);
  });

  it('should handle 50 owner-based cleanup cycles with no leaks', () => {
    for (let i = 0; i < 50; i++) {
      const ownerId = `port-${i}`;
      registry.watch({ paths: ['/src'], recursive: true }, vi.fn(), ownerId);
      registry.watch({ paths: ['/lib'], recursive: true }, vi.fn(), ownerId);
      registry.cleanupOwner(ownerId);
    }

    expect(registry.subscriptionCount).toBe(0);
    expect(registry.handlerCount).toBe(0);
  });

  it('should maintain correct ref counts for concurrent owners with shared requests', () => {
    const request = { paths: ['/src'], recursive: true };
    const handlers: Array<ReturnType<typeof vi.fn>> = [];
    const unsubs: Array<() => void> = [];

    for (let i = 0; i < 20; i++) {
      const handler = vi.fn();
      handlers.push(handler);
      unsubs.push(registry.watch(request, handler, `port-${i}`));
    }

    expect(registry.subscriptionCount).toBe(1);
    expect(registry.handlerCount).toBe(20);

    bus.emit(written('/src/test.ts'));
    vi.advanceTimersByTime(100);

    for (const handler of handlers) {
      expect(handler).toHaveBeenCalledTimes(1);
    }

    for (let i = 0; i < 15; i++) {
      unsubs[i]!();
    }

    expect(registry.subscriptionCount).toBe(1);
    expect(registry.handlerCount).toBe(5);

    for (let i = 15; i < 20; i++) {
      unsubs[i]!();
    }

    expect(registry.subscriptionCount).toBe(0);
    expect(registry.handlerCount).toBe(0);
  });
});

describe('EventCoalescer overflow stress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should trigger overflow at exact boundary and recover', () => {
    const deliver = vi.fn();
    const onOverflow = vi.fn();
    const coalescer = new EventCoalescer(deliver, { maxQueueDepth: 100, onOverflow });

    for (let i = 0; i < 101; i++) {
      coalescer.push(written(`/file-${i}.ts`));
    }
    expect(onOverflow).toHaveBeenCalledTimes(1);

    coalescer.push(written('/recovery.ts'));
    vi.advanceTimersByTime(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith([written('/recovery.ts')]);

    coalescer.dispose();
  });

  it('should handle repeated overflow cycles without accumulation', () => {
    const deliver = vi.fn();
    const onOverflow = vi.fn();
    const coalescer = new EventCoalescer(deliver, { maxQueueDepth: 5, onOverflow });

    for (let i = 0; i < 30; i++) {
      coalescer.push(written(`/file-${i}.ts`));
    }

    expect(onOverflow.mock.calls.length).toBeGreaterThanOrEqual(4);

    coalescer.push(written('/after.ts'));
    vi.advanceTimersByTime(100);
    expect(deliver).toHaveBeenCalled();

    coalescer.dispose();
  });
});

describe('Watch event latency measurement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should bound coalescer window at configured ms', () => {
    const windowMs = 50;
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs });

    coalescer.push(written('/test.ts'));

    vi.advanceTimersByTime(windowMs - 1);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    coalescer.dispose();
  });

  it('should batch multiple events within window into one delivery', () => {
    const windowMs = 50;
    const deliveries: ChangeEvent[][] = [];
    const coalescer = new EventCoalescer((events) => deliveries.push([...events]), { windowMs });

    coalescer.push(written('/a.ts'));
    vi.advanceTimersByTime(10);
    coalescer.push(written('/b.ts'));
    vi.advanceTimersByTime(10);
    coalescer.push(written('/c.ts'));

    vi.advanceTimersByTime(windowMs);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.length).toBe(3);

    coalescer.dispose();
  });
});

describe('Large tree incremental operations', () => {
  it('should handle 1000 paths in a single recursive watch', () => {
    vi.useFakeTimers();
    const bus = new ChangeEventBus();
    const registry = new WatchRegistry(bus);

    const received: WatchEvent[] = [];
    registry.watch({ paths: ['/project'], recursive: true }, (event) => {
      received.push(event);
    });

    for (let directory = 0; directory < 50; directory++) {
      for (let file = 0; file < 20; file++) {
        bus.emit(written(`/project/dir-${directory}/file-${file}.ts`));
      }
    }

    vi.advanceTimersByTime(100);

    expect(received.length).toBe(1000);

    registry.dispose();
    vi.useRealTimers();
  });
});
