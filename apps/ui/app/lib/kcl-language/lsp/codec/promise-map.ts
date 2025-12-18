/**
 * A map that stores promises and resolves them when values are set.
 * Used for matching LSP responses to their requests by ID.
 *
 * Entries are automatically removed from the map when resolved to prevent memory leaks.
 */

type PromiseMapEntry<V> = {
  resolve: (item: V) => void;
  promise: Promise<V>;
};

export class PromiseMap<K, V> {
  private readonly map = new Map<K, PromiseMapEntry<V>>();

  /**
   * Get or create a promise for the given key.
   * The promise will resolve when `set()` is called with the same key.
   */
  public async get(key: K): Promise<V> {
    const existingEntry = this.map.get(key);
    if (existingEntry) {
      return existingEntry.promise;
    }

    const entry = this.createEntry(key);
    return entry.promise;
  }

  /**
   * Resolve the promise for the given key with the provided value.
   * If no promise exists for the key, this is a no-op (the value is discarded).
   */
  public set(key: K, value: V): this {
    const entry = this.map.get(key);

    if (entry) {
      // Remove entry from map before resolving to prevent memory leaks
      this.map.delete(key);
      entry.resolve(value);
    }
    // If no entry exists, no one is waiting for this value - discard it

    return this;
  }

  public get size(): number {
    return this.map.size;
  }

  private createEntry(key: K): PromiseMapEntry<V> {
    let resolve: (item: V) => void = () => {
      // Placeholder - will be replaced by Promise constructor
    };

    const promise = new Promise<V>((_resolve) => {
      resolve = _resolve;
    });

    const entry: PromiseMapEntry<V> = {
      resolve,
      promise,
    };

    this.map.set(key, entry);

    return entry;
  }
}
