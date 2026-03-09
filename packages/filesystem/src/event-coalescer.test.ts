import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventCoalescer, coalesceEvents } from '#event-coalescer.js';
import type { ChangeEvent } from '#types.js';

const testBackend = 'memory' as const;

const written = (path: string): ChangeEvent => ({ type: 'fileWritten', path, backend: testBackend });
const deleted = (path: string): ChangeEvent => ({ type: 'fileDeleted', path, backend: testBackend });
const renamed = (oldPath: string, newPath: string): ChangeEvent => ({
  type: 'fileRenamed',
  oldPath,
  newPath,
  backend: testBackend,
});

describe('coalesceEvents (pure)', () => {
  it('should pass through single events unchanged', () => {
    const events = [written('/a.txt')];
    expect(coalesceEvents(events)).toEqual(events);
  });

  it('should cancel written → deleted for the same path', () => {
    const events = [written('/a.txt'), deleted('/a.txt')];
    expect(coalesceEvents(events)).toEqual([]);
  });

  it('should collapse deleted → written to a single written (update)', () => {
    const events = [deleted('/a.txt'), written('/a.txt')];
    expect(coalesceEvents(events)).toEqual([written('/a.txt')]);
  });

  it('should suppress child deletes when parent is deleted', () => {
    const events = [deleted('/dir'), deleted('/dir/a.txt'), deleted('/dir/b.txt')];
    const result = coalesceEvents(events);
    expect(result).toEqual([deleted('/dir')]);
  });

  it('should not suppress child events for unrelated parents', () => {
    const events = [deleted('/other'), deleted('/dir/a.txt')];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(2);
  });

  it('should keep rename events', () => {
    const events = [renamed('/old.txt', '/new.txt')];
    expect(coalesceEvents(events)).toEqual(events);
  });

  it('should preserve rename event alongside other events in multi-event batch', () => {
    const events = [written('/a.txt'), renamed('/old.txt', '/new.txt')];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(2);
    expect(result).toEqual([written('/a.txt'), renamed('/old.txt', '/new.txt')]);
  });

  it('should deduplicate repeated writes to the same path', () => {
    const events = [written('/a.txt'), written('/a.txt'), written('/a.txt')];
    const result = coalesceEvents(events);
    expect(result).toEqual([written('/a.txt')]);
  });

  it('should preserve mixed events for different paths', () => {
    const events = [written('/a.txt'), deleted('/b.txt'), written('/c.txt')];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(3);
  });

  it('should pass through backendChanged events', () => {
    const backendEvent: ChangeEvent = { type: 'backendChanged', backend: testBackend };
    const result = coalesceEvents([backendEvent, written('/a.txt')]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(backendEvent);
  });
});

describe('EventCoalescer (timed)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should deliver events after the window elapses', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 50 });

    coalescer.push(written('/a.txt'));
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith([written('/a.txt')]);

    coalescer.dispose();
  });

  it('should coalesce events within the same window', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 50 });

    coalescer.push(written('/a.txt'));
    coalescer.push(written('/a.txt'));

    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith([written('/a.txt')]);

    coalescer.dispose();
  });

  it('should cancel written+deleted within same window', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 50 });

    coalescer.push(written('/a.txt'));
    coalescer.push(deleted('/a.txt'));

    vi.advanceTimersByTime(50);
    expect(deliver).not.toHaveBeenCalled();

    coalescer.dispose();
  });

  it('should deliver immediately when flush() is called', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 500 });

    coalescer.push(written('/a.txt'));
    coalescer.flush();

    expect(deliver).toHaveBeenCalledTimes(1);

    coalescer.dispose();
  });

  it('should trigger overflow callback when queue exceeds max depth', () => {
    const deliver = vi.fn();
    const onOverflow = vi.fn();
    const coalescer = new EventCoalescer(deliver, { maxQueueDepth: 3, onOverflow });

    coalescer.push(written('/1.txt'));
    coalescer.push(written('/2.txt'));
    coalescer.push(written('/3.txt'));
    expect(onOverflow).not.toHaveBeenCalled();

    coalescer.push(written('/4.txt'));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(deliver).not.toHaveBeenCalled();

    coalescer.dispose();
  });

  it('should prevent further delivery after dispose()', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 50 });

    coalescer.push(written('/a.txt'));
    coalescer.dispose();

    vi.advanceTimersByTime(100);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('should process separate windows independently', () => {
    const deliver = vi.fn();
    const coalescer = new EventCoalescer(deliver, { windowMs: 50 });

    coalescer.push(written('/a.txt'));
    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenCalledTimes(1);

    coalescer.push(written('/b.txt'));
    vi.advanceTimersByTime(50);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith([written('/b.txt')]);

    coalescer.dispose();
  });
});
