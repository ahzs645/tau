// oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Initial sentinel for queue chain
const resolved: Promise<void> = Promise.resolve();

/**
 * Serializes filesystem write operations into a sequential promise chain,
 * preventing concurrent writes that can cause race conditions.
 * @public
 */
export class WriteCoordinator {
  private _writeQueue: Promise<void> = resolved;
  private _depth = 0;

  /**
   * Queue an operation to run after all previously queued operations complete.
   *
   * @param operation - Async operation to serialize.
   * @returns The operation's return value.
   */
  public async serialized<T>(operation: () => Promise<T>): Promise<T> {
    this._depth++;
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    const result = this._writeQueue
      // Defensive: _writeQueue is always pre-caught below (line 29), so this
      // catch is unreachable in practice. It guards against future refactors
      // that might remove the downstream catch, keeping the queue unjammable.
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .catch(() => undefined)
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .then(async () => operation());
    // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
    this._writeQueue = result
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .catch(() => undefined)
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- Intentional promise chaining for queue serialization
      .then(() => {
        this._depth--;
      });
    return result;
  }

  /**
   * Number of operations currently queued or in-flight.
   *
   * @returns Current queue depth.
   */
  public get depth(): number {
    return this._depth;
  }
}
