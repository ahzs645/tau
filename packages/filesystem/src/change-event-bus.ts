import type { ChangeEvent } from '#types.js';

type Subscriber = {
  handler: (event: ChangeEvent) => void;
};

/**
 * Simple pub/sub bus for broadcasting {@link ChangeEvent}s to subscribers.
 * @public
 */
export class ChangeEventBus {
  private readonly _subscribers = new Set<Subscriber>();

  /**
   * Register a handler to receive all change events.
   *
   * @param handler - Callback invoked for every emitted event.
   * @returns Unsubscribe function.
   */
  public subscribe(handler: (event: ChangeEvent) => void): () => void {
    const subscriber: Subscriber = { handler };
    this._subscribers.add(subscriber);

    return () => {
      this._subscribers.delete(subscriber);
    };
  }

  /**
   * Broadcast an event to all current subscribers.
   *
   * @param event - Change event to emit.
   */
  public emit(event: ChangeEvent): void {
    for (const subscriber of this._subscribers) {
      try {
        subscriber.handler(event);
      } catch (error) {
        console.error('[ChangeEventBus] Subscriber error:', error);
      }
    }
  }

  /** Remove all subscribers. */
  public dispose(): void {
    this._subscribers.clear();
  }
}
