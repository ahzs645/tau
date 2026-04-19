/**
 * Cross-tab write coordinator using `navigator.locks` and `BroadcastChannel`.
 *
 * Provides exclusive per-file write locks to prevent concurrent write conflicts
 * across browser tabs. Notifies other tabs of mutations via `BroadcastChannel`.
 *
 * Progressive enhancement: no-op when `navigator.locks` is unavailable.
 */

import { generatePrefixedId } from '@taucad/utils/id';

const lockPrefix = 'tau-fs-write:';
const channelName = 'tau-fs-changes';

type ChangeNotification = {
  type: 'write' | 'delete' | 'rename';
  path: string;
  newPath?: string;
  tabId: string;
};

/**
 * Whether `navigator.locks` is available in the current environment.
 * @public
 */
export function isNavigatorLocksSupported(): boolean {
  return typeof navigator !== 'undefined' && 'locks' in navigator;
}

/**
 * Coordinates filesystem writes across browser tabs.
 *
 * - Uses `navigator.locks` for per-file exclusive write serialization
 * - Uses `BroadcastChannel` to notify other tabs of mutations
 * - Progressive enhancement: executes operations directly when locks unavailable
 *
 * @public
 */
export class CrossTabCoordinator {
  private readonly _tabId: string;
  private _channel: BroadcastChannel | undefined;
  private _changeHandler: ((notification: ChangeNotification) => void) | undefined;

  public constructor() {
    this._tabId = generatePrefixedId('tab');
    if (typeof BroadcastChannel !== 'undefined') {
      this._channel = new BroadcastChannel(channelName);
    }
  }

  /**
   * Execute a write operation under an exclusive per-file lock.
   * Other tabs attempting to write to the same path will queue until this completes.
   *
   * @param path - File path to acquire the lock for.
   * @param operation - Async operation to execute while holding the lock.
   * @returns The result of `operation`.
   */
  public async withWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (!isNavigatorLocksSupported()) {
      return operation();
    }

    return navigator.locks.request(`${lockPrefix}${path}`, { mode: 'exclusive' }, async () => {
      const result = await operation();
      this._postChangeNotification({ type: 'write', path, tabId: this._tabId });
      return result;
    });
  }

  /**
   * Listen for change notifications from other tabs.
   *
   * @param handler - Called when another tab mutates a file.
   */
  public onRemoteChange(handler: (notification: ChangeNotification) => void): void {
    this._changeHandler = handler;

    if (this._channel) {
      this._channel.addEventListener('message', (event: MessageEvent<ChangeNotification>) => {
        if (event.data.tabId !== this._tabId) {
          this._changeHandler?.(event.data);
        }
      });
    }
  }

  /** Release resources. */
  public dispose(): void {
    this._channel?.close();
    this._channel = undefined;
    this._changeHandler = undefined;
  }

  private _postChangeNotification(notification: ChangeNotification): void {
    try {
      this._channel?.postMessage(notification);
    } catch {
      // Channel may be closed; safe to ignore
    }
  }
}
