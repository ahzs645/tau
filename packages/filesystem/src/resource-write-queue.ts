import { parentDirectory } from '@taucad/utils/path';

// oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Initial sentinel for queue chain
const resolved: Promise<void> = Promise.resolve();

/**
 * Per-parent-directory write serialization queue.
 *
 * Writes to the same parent directory are serialized (FIFO) to prevent the
 * directory listing TOCTOU race. Writes to different parent directories
 * run in parallel since they touch different listing blobs.
 *
 * @public
 */
export class ResourceWriteQueue {
  private readonly _queues = new Map<string, Promise<void>>();
  private _totalDepth = 0;
  private _drainResolvers: Array<() => void> = [];

  /**
   * Queue an operation serialized by the parent directory of `path`.
   *
   * @param path - Absolute file or directory path (parent directory is derived).
   * @param operation - Async operation to execute.
   * @returns The operation's return value.
   */
  public async enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const key = parentDirectory(path);
    return this._enqueueForKey(key, operation);
  }

  /**
   * Queue an operation for an explicit directory key.
   * Use when the operation affects a directory listing directly (e.g. mkdir).
   *
   * @param directoryPath - The directory whose listing is being modified.
   * @param operation - Async operation to execute.
   * @returns The operation's return value.
   */
  public async enqueueForDirectory<T>(directoryPath: string, operation: () => Promise<T>): Promise<T> {
    return this._enqueueForKey(directoryPath, operation);
  }

  /**
   * Total number of operations queued or in-flight across all directories.
   * @returns The current queue depth.
   */
  public get depth(): number {
    return this._totalDepth;
  }

  /**
   * Resolves when all queues are empty (no in-flight or pending operations).
   * @returns A promise that resolves when drained.
   */
  public async whenDrained(): Promise<void> {
    if (this._totalDepth === 0) {
      return;
    }

    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  private async _enqueueForKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this._totalDepth++;
    const existingQueue = this._queues.get(key) ?? resolved;

    const { promise, resolve, reject } = Promise.withResolvers<T>();

    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    const next = existingQueue
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .catch(() => undefined)
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .then(async () => {
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this._totalDepth--;
          if (this._totalDepth === 0) {
            for (const drainResolve of this._drainResolvers) {
              drainResolve();
            }
            this._drainResolvers = [];
          }
        }
      });

    this._queues.set(key, next);

    // Auto-cleanup when the queue empties for this key
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue cleanup
    void next.then(() => {
      if (this._queues.get(key) === next) {
        this._queues.delete(key);
      }
    });

    return promise;
  }
}
