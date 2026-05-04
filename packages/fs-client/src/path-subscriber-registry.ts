/**
 * Path-scoped and global listener registry with snapshot iteration so callbacks
 * registered during `notify` do not run in the same delivery pass.
 *
 * @public
 */
export class PathSubscriberRegistry<E = undefined> {
  private readonly pathSubscribers = new Map<string, Set<(event: E) => void>>();
  private readonly globalSubscribers = new Set<(event: E) => void>();

  /**
   * Subscribe to notifications for a single path key.
   * @param path - Path key whose notifications should invoke `callback`.
   * @param callback - Handler invoked when {@link notifyPath} fires for `path`.
   * @returns Unsubscribe function that removes `callback` from `path`.
   */
  public subscribePath(path: string, callback: (event: E) => void): () => void {
    let pathSet = this.pathSubscribers.get(path);
    if (!pathSet) {
      pathSet = new Set();
      this.pathSubscribers.set(path, pathSet);
    }
    pathSet.add(callback);
    return () => {
      pathSet.delete(callback);
      if (pathSet.size === 0) {
        this.pathSubscribers.delete(path);
      }
    };
  }

  /**
   * Subscribe to every `notifyGlobal` delivery.
   * @param callback - Handler invoked for global notifications.
   * @returns Unsubscribe function that removes `callback`.
   */
  public subscribeGlobal(callback: (event: E) => void): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers for one path (snapshot subscribers before delivery).
   * @param path - Path key to notify.
   * @param event - Payload passed to each subscriber callback.
   */
  public notifyPath(path: string, event: E): void {
    const set = this.pathSubscribers.get(path);
    if (!set) {
      return;
    }
    const subscribers = [...set];
    for (const callback of subscribers) {
      callback(event);
    }
  }

  /**
   * Notify all global subscribers (snapshot subscribers before delivery).
   * @param event - Payload passed to each global callback.
   */
  public notifyGlobal(event: E): void {
    const subscribers = [...this.globalSubscribers];
    for (const callback of subscribers) {
      callback(event);
    }
  }

  /**
   * Drop all registered subscribers.
   */
  public clear(): void {
    this.pathSubscribers.clear();
    this.globalSubscribers.clear();
  }

  /**
   * Total callbacks registered for any specific path (not counting global).
   * @returns Count of all path-scoped subscriptions across keys.
   */
  public get pathSubscriberCount(): number {
    let count = 0;
    for (const set of this.pathSubscribers.values()) {
      count += set.size;
    }
    return count;
  }

  /**
   * Whether any callbacks are still subscribed for `path`.
   * @param path - Path key to query.
   * @returns `true` when the path has at least one subscriber.
   */
  public hasPathSubscribers(path: string): boolean {
    return (this.pathSubscribers.get(path)?.size ?? 0) > 0;
  }

  /**
   * Paths that currently have at least one subscriber (for cache invalidation sweeps).
   * @returns Copy of active path keys with subscribers.
   */
  public subscribedPaths(): string[] {
    return [...this.pathSubscribers.keys()];
  }
}
