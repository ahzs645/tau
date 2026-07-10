/**
 * Bounded LRU Map with entry-count and optional weight-based eviction.
 *
 * Uses the native `Map` insertion-order guarantee: on access, entries are
 * deleted and re-inserted to promote them to most-recently-used. When the
 * map exceeds `maxEntries`, the first (oldest) entry is evicted.
 *
 * @public
 * @example <caption>Content-addressable geometry cache</caption>
 *
 * ```typescript
 * import { LruMap } from '@taucad/utils/cache';
 *
 * const cache = new LruMap<Uint8Array>({ maxEntries: 20 });
 * const dependencyHash = 'sha256-abc123';
 * const glbBuffer = new Uint8Array(1024);
 * cache.set(dependencyHash, glbBuffer);
 * const hit = cache.get(dependencyHash); // promotes to MRU
 * ```
 */
export class LruMap<V> {
  private readonly _map = new Map<string, { readonly value: V; readonly weight: number }>();
  private readonly _maxEntries: number;
  private readonly _maxWeight: number | undefined;
  private readonly _getWeight: ((value: V, key: string) => number) | undefined;
  private _totalWeight = 0;

  /**
   * Create an LRU cache with entry-count and optional weight limits.
   *
   * @param options - Cache configuration.
   * @param options.maxEntries - Maximum number of entries before LRU eviction.
   * @param options.maxWeight - Optional maximum aggregate caller-defined weight.
   * @param options.getWeight - Returns the caller-defined weight for an entry.
   */
  public constructor(options: {
    maxEntries: number;
    maxWeight?: number;
    getWeight?: (value: V, key: string) => number;
  }) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    if (options.maxWeight !== undefined && (!Number.isFinite(options.maxWeight) || options.maxWeight <= 0)) {
      throw new RangeError('maxWeight must be a positive finite number');
    }
    if ((options.maxWeight === undefined) !== (options.getWeight === undefined)) {
      throw new TypeError('maxWeight and getWeight must be provided together');
    }

    this._maxEntries = options.maxEntries;
    this._maxWeight = options.maxWeight;
    this._getWeight = options.getWeight;
  }

  /**
   * Retrieve a cached value and promote the entry to most-recently-used.
   *
   * @param key - Cache key.
   * @returns The cached value, or `undefined` on miss.
   */
  public get(key: string): V | undefined {
    const entry = this._map.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * Retrieve a cached value without promoting the entry in LRU order.
   * Safe for read-only paths where side effects must be avoided.
   *
   * @param key - Cache key.
   * @returns The cached value, or `undefined` on miss.
   */
  public peek(key: string): V | undefined {
    return this._map.get(key)?.value;
  }

  /**
   * Insert or update a cache entry. If the cache exceeds `maxEntries`,
   * the least-recently-used entry is evicted.
   *
   * Oversized entries are rejected after removing any previous value stored at
   * the same key, keeping the configured weight bound invariant intact.
   *
   * @param key - Cache key.
   * @param value - Value to cache.
   * @returns `true` when the value was retained, or `false` when it exceeded `maxWeight`.
   */
  public set(key: string, value: V): boolean {
    this.delete(key);

    const weight = this._getWeight?.(value, key) ?? 0;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError('getWeight must return a non-negative finite number');
    }
    if (this._maxWeight !== undefined && weight > this._maxWeight) {
      return false;
    }

    while (
      this._map.size >= this._maxEntries ||
      (this._maxWeight !== undefined && this._totalWeight + weight > this._maxWeight)
    ) {
      if (!this.deleteLeastRecentlyUsed()) {
        return false;
      }
    }

    this._map.set(key, { value, weight });
    this._totalWeight += weight;
    return true;
  }

  /**
   * Remove a single entry from the cache.
   *
   * @param key - Cache key to remove.
   * @returns `true` if the entry existed and was removed.
   */
  public delete(key: string): boolean {
    const entry = this._map.get(key);
    if (!entry) {
      return false;
    }

    this._totalWeight -= entry.weight;
    return this._map.delete(key);
  }

  /**
   * Check whether an entry exists in the cache.
   *
   * @param key - Cache key to check.
   * @returns `true` if the entry is cached.
   */
  public has(key: string): boolean {
    return this._map.has(key);
  }

  /** Remove all entries from the cache. */
  public clear(): void {
    this._map.clear();
    this._totalWeight = 0;
  }

  /**
   * Number of entries currently in the cache.
   *
   * @returns The retained entry count.
   */
  public get size(): number {
    return this._map.size;
  }

  /**
   * Aggregate caller-defined weight of all retained entries.
   *
   * @returns The current aggregate weight.
   */
  public get totalWeight(): number {
    return this._totalWeight;
  }

  /**
   * Evict the least-recently-used entry.
   *
   * @returns `true` when an entry was removed.
   */
  private deleteLeastRecentlyUsed(): boolean {
    const first = this._map.keys().next();
    return first.done ? false : this.delete(first.value);
  }
}

/**
 * Create a lazily-initialized async singleton with rejection retry.
 *
 * The returned function calls `factory` on first invocation and caches the
 * resulting promise. Concurrent callers share the same in-flight promise
 * (no stampede). If the promise rejects, the cache is cleared so the next
 * caller retries — unlike the `cached ??= factory()` pattern which
 * permanently caches rejected promises.
 *
 * @param factory - Async function that produces the singleton value.
 * @returns A function that returns the cached or in-flight promise.
 *
 * @public
 * @example <caption>WASM module singleton</caption>
 *
 * ```typescript
 * import { lazyAsync } from '@taucad/utils/cache';
 *
 * const initNodeIo = async () => ({ read: () => 'data' });
 * const getNodeIo = lazyAsync(() => initNodeIo());
 * const io = await getNodeIo(); // first call: inits
 * const io2 = await getNodeIo(); // same instance
 * ```
 */
export const lazyAsync = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return async () => {
    cached ??= factory();
    try {
      return await cached;
    } catch (error) {
      cached = undefined;
      throw error;
    }
  };
};
