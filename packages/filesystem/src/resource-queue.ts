// oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Initial sentinel for queue chain
const resolved: Promise<void> = Promise.resolve();

/**
 * Per-resource write serialization queue (VS Code ResourceQueue pattern).
 *
 * Writes to the same file path are serialized (FIFO). Writes to different
 * file paths run in parallel. Auto-cleans empty queues on drain.
 *
 * Replaces both WriteCoordinator (global — too strict) and the legacy
 * ResourceWriteQueue (per-parent — ZenFS artifact, unnecessary with
 * path-keyed IDB).
 *
 * @see repos/vscode/src/vs/base/common/async.ts ResourceQueue
 * @see repos/vscode/src/vs/platform/files/common/fileService.ts writeQueue
 * @public
 */
export class ResourceQueue {
  private readonly _queues = new Map<string, Promise<void>>();
  private _totalDepth = 0;
  private _drainResolvers: Array<() => void> = [];

  /**
   * Queue an operation serialized by the exact file path.
   *
   * Same-file writes execute in FIFO order. Different-file writes run
   * in parallel. The queue for a given path is auto-cleaned once empty.
   *
   * @param path - Absolute file path (used as serialization key).
   * @param operation - Async operation to execute.
   * @returns The operation's return value.
   */
  public async queueFor<T>(path: string, operation: () => Promise<T>): Promise<T> {
    this._totalDepth++;
    const existingQueue = this._queues.get(path) ?? resolved;

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

    this._queues.set(path, next);

    // Auto-cleanup when the queue empties for this path
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue cleanup
    void next.then(() => {
      if (this._queues.get(path) === next) {
        this._queues.delete(path);
      }
    });

    return promise;
  }

  /**
   * Total number of operations queued or in-flight across all paths.
   */
  public get depth(): number {
    return this._totalDepth;
  }

  /**
   * Resolves when all queues are empty (no in-flight or pending operations).
   */
  public async whenDrained(): Promise<void> {
    if (this._totalDepth === 0) {
      return;
    }

    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }
}
