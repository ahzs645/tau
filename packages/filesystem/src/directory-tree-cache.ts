import type { TreeEntry } from '#types.js';
import { canonicalizePath } from '@taucad/utils/path';

/**
 * In-memory cache mapping directory paths to their entry metadata.
 * Supports targeted invalidation by path and subtree prefix.
 * @public
 */
export class DirectoryTreeCache {
  private readonly _cache = new Map<string, Map<string, TreeEntry>>();

  /**
   * Retrieve cached entries for a directory.
   *
   * @param path - Absolute directory path.
   * @returns Cached entry map or `undefined` on miss.
   */
  public get(path: string): Map<string, TreeEntry> | undefined {
    return this._cache.get(canonicalizePath(path));
  }

  /**
   * Cache entries for a directory.
   *
   * @param path - Absolute directory path.
   * @param entries - Map of entry name to metadata.
   */
  public set(path: string, entries: Map<string, TreeEntry>): void {
    this._cache.set(canonicalizePath(path), entries);
  }

  /**
   * Remove a single directory from the cache.
   *
   * @param path - Absolute directory path to invalidate.
   */
  public invalidate(path: string): void {
    this._cache.delete(canonicalizePath(path));
  }

  /**
   * Remove a directory and all descendants from the cache.
   *
   * @param path - Root of the subtree to invalidate.
   */
  public invalidateSubtree(path: string): void {
    const norm = canonicalizePath(path);
    const prefix = norm === '/' ? '/' : `${norm}/`;
    const keys = [...this._cache.keys()];
    for (const key of keys) {
      if (key === norm || key.startsWith(prefix)) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * Invalidate a directory and all its ancestors up to root.
   * Used for recursive mkdir where intermediate directories are created.
   *
   * @param path - Deepest directory path whose ancestors should be invalidated.
   */
  public invalidateAncestors(path: string): void {
    let current = canonicalizePath(path);
    while (current !== '/') {
      this._cache.delete(current);
      const lastSlash = current.lastIndexOf('/');
      current = lastSlash <= 0 ? '/' : current.slice(0, lastSlash);
    }
    this._cache.delete('/');
  }

  /**
   * Return the full internal cache map (for inspection/debugging).
   *
   * @returns Full cache map from path to entry map.
   */
  public getFullTree(): Map<string, Map<string, TreeEntry>> {
    return this._cache;
  }

  /** Remove all cached directory entries. */
  public clear(): void {
    this._cache.clear();
  }
}
