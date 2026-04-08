/**
 * Throttled worker for rate-limiting event delivery.
 *
 * Buffers items and delivers them in fixed-size chunks with a configurable
 * delay between deliveries. Inspired by VS Code's `ThrottledWorker` pattern
 * for filesystem event pipelines.
 *
 * @public
 * @see docs/research/shared-worker-gate-startup-performance.md R8
 */

const defaultMaxWorkChunkSize = 100;
const defaultThrottleDelay = 200;
const defaultMaxBufferedWork = 10_000;

/**
 * Configuration for {@link ThrottledWorker}.
 * @public
 */
export type ThrottledWorkerOptions = {
  /** Maximum items per delivery chunk. Default: 100. */
  maxWorkChunkSize?: number;
  /** Delay in ms between chunk deliveries. Default: 200. */
  throttleDelay?: number;
  /** Maximum buffered items before overflow. Default: 10,000. */
  maxBufferedWork?: number;
  /** Called when the buffer exceeds {@link maxBufferedWork}. */
  onOverflow?: () => void;
};

/**
 * Rate-limited delivery of items in fixed-size chunks.
 *
 * Items pushed into the worker are buffered internally. The first chunk
 * (up to `maxWorkChunkSize`) is delivered immediately; subsequent chunks
 * are delivered after `throttleDelay` ms each. If the buffer exceeds
 * `maxBufferedWork`, all pending work is discarded and `onOverflow` fires.
 *
 * @template T - Type of work items.
 * @public
 */
export class ThrottledWorker<T> {
  private readonly _handler: (chunk: T[]) => void;
  private readonly _maxWorkChunkSize: number;
  private readonly _throttleDelay: number;
  private readonly _maxBufferedWork: number;
  private readonly _onOverflow?: () => void;
  private _buffer: T[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _disposed = false;

  /**
   * Create a ThrottledWorker with a delivery handler and optional config.
   *
   * @param handler - Called with each chunk of items when delivered.
   * @param options - Chunk size, delay, buffer limit, and overflow callback.
   */
  public constructor(handler: (chunk: T[]) => void, options?: ThrottledWorkerOptions) {
    this._handler = handler;
    this._maxWorkChunkSize = options?.maxWorkChunkSize ?? defaultMaxWorkChunkSize;
    this._throttleDelay = options?.throttleDelay ?? defaultThrottleDelay;
    this._maxBufferedWork = options?.maxBufferedWork ?? defaultMaxBufferedWork;
    this._onOverflow = options?.onOverflow;
  }

  /**
   * Add items to the buffer for chunked delivery.
   *
   * @param items - Work items to enqueue.
   */
  public push(items: T[]): void {
    if (this._disposed) {
      return;
    }

    this._buffer.push(...items);

    if (this._buffer.length > this._maxBufferedWork) {
      this._buffer = [];
      if (this._timer !== undefined) {
        clearTimeout(this._timer);
        this._timer = undefined;
      }
      this._onOverflow?.();
      return;
    }

    if (this._timer === undefined) {
      this._drainChunk();
    }
  }

  /** Deliver all buffered items immediately, bypassing throttle delay. */
  public flush(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    while (this._buffer.length > 0) {
      this._drainChunk();
    }
  }

  /** Discard all buffered items and cancel pending deliveries. */
  public dispose(): void {
    this._disposed = true;
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._buffer = [];
  }

  private _drainChunk(): void {
    const chunk = this._buffer.splice(0, this._maxWorkChunkSize);
    if (chunk.length > 0) {
      this._handler(chunk);
    }

    if (this._buffer.length > 0 && !this._disposed) {
      this._timer = setTimeout(() => {
        this._timer = undefined;
        this._drainChunk();
      }, this._throttleDelay);
    }
  }
}
