import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThrottledWorker } from '#throttled-worker.js';

describe('ThrottledWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should deliver a small batch immediately when under chunk size', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler);

    worker.push([1, 2, 3, 4, 5]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith([1, 2, 3, 4, 5]);

    worker.dispose();
  });

  it('should split a large batch into chunks of maxWorkChunkSize', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 100 });

    const items = Array.from({ length: 250 }, (_, i) => i);
    worker.push(items);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(items.slice(0, 100));

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(2, items.slice(100, 200));

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(3, items.slice(200, 250));

    worker.dispose();
  });

  it('should buffer work across multiple push calls', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 100, throttleDelay: 200 });

    const first = Array.from({ length: 50 }, (_, i) => i);
    const second = Array.from({ length: 80 }, (_, i) => i + 50);
    worker.push(first);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(first);

    worker.push(second);

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(2, second);

    worker.dispose();
  });

  it('should respect throttleDelay between chunk deliveries', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 50, throttleDelay: 300 });

    const items = Array.from({ length: 150 }, (_, i) => i);
    worker.push(items);

    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(299);
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(300);
    expect(handler).toHaveBeenCalledTimes(3);

    worker.dispose();
  });

  it('should call onOverflow when buffer exceeds maxBufferedWork', () => {
    const handler = vi.fn();
    const onOverflow = vi.fn();
    const worker = new ThrottledWorker(handler, { maxBufferedWork: 100, onOverflow });

    const items = Array.from({ length: 101 }, (_, i) => i);
    worker.push(items);

    expect(onOverflow).toHaveBeenCalledTimes(1);

    worker.dispose();
  });

  it('should clear pending work on overflow', () => {
    const handler = vi.fn();
    const onOverflow = vi.fn();
    const worker = new ThrottledWorker(handler, {
      maxWorkChunkSize: 50,
      maxBufferedWork: 100,
      onOverflow,
    });

    const items = Array.from({ length: 101 }, (_, i) => i);
    worker.push(items);

    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(handler).not.toHaveBeenCalled();

    worker.dispose();
  });

  it('should dispose cleanly and discard pending work', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 50, throttleDelay: 200 });

    const items = Array.from({ length: 150 }, (_, i) => i);
    worker.push(items);

    expect(handler).toHaveBeenCalledTimes(1);

    worker.dispose();

    vi.advanceTimersByTime(10_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should flush pending work immediately on flush()', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 50, throttleDelay: 200 });

    const items = Array.from({ length: 150 }, (_, i) => i);
    worker.push(items);

    expect(handler).toHaveBeenCalledTimes(1);

    worker.flush();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(2, items.slice(50, 100));
    expect(handler).toHaveBeenNthCalledWith(3, items.slice(100, 150));

    worker.dispose();
  });

  it('should accept custom chunk size and delay', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 10, throttleDelay: 50 });

    const items = Array.from({ length: 25 }, (_, i) => i);
    worker.push(items);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(items.slice(0, 10));

    vi.advanceTimersByTime(50);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(2, items.slice(10, 20));

    vi.advanceTimersByTime(50);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(3, items.slice(20, 25));

    worker.dispose();
  });

  it('should continue draining after new items arrive mid-drain', () => {
    const handler = vi.fn();
    const worker = new ThrottledWorker(handler, { maxWorkChunkSize: 50, throttleDelay: 200 });

    worker.push(Array.from({ length: 120 }, (_, i) => i));
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(2);

    worker.push(Array.from({ length: 30 }, (_, i) => i + 1000));

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(3);
    const thirdCall = handler.mock.calls[2]![0] as number[];
    expect(thirdCall).toHaveLength(50);
    expect(thirdCall.slice(0, 20).every((n: number) => n < 120)).toBe(true);

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(3);

    worker.dispose();
  });
});
