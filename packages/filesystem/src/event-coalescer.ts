/**
 * Event coalescer for the filesystem watch pipeline.
 *
 * Buffers ChangeEvents within a configurable time window and applies
 * coalescing rules before delivery:
 *
 * - `added → deleted` within the same window cancels out (no event)
 * - `deleted → added` within the same window collapses to `updated`
 * - Parent directory delete suppresses child delete spam
 * - Rename emits both old and new path invalidation
 *
 * @see docs/policy/filesystem-policy.md Rule 21
 */

import type { ChangeEvent } from '#types.js';

type PendingEvent = {
  event: ChangeEvent;
  timestamp: number;
};

/**
 * Configuration for {@link EventCoalescer}.
 * @public
 */
export type CoalescerOptions = {
  /** Window in milliseconds for coalescing events. Default: 50. */
  windowMs?: number;
  /** Maximum queue depth before emitting overflow. Default: 1000. */
  maxQueueDepth?: number;
  /** Called when queue depth is exceeded. */
  onOverflow?: () => void;
};

const defaultWindowMs = 50;
const defaultMaxQueueDepth = 1000;

/**
 * Buffers {@link ChangeEvent}s within a time window and applies coalescing
 * rules (cancel-out, collapse, dedup) before delivering the batch.
 * @public
 */
export class EventCoalescer {
  private readonly _windowMs: number;
  private readonly _maxQueueDepth: number;
  private readonly _onOverflow?: () => void;
  private readonly _deliverCallback: (events: ChangeEvent[]) => void;
  private _pending: PendingEvent[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Create an EventCoalescer with a delivery callback and optional config.
   *
   * @param deliverCallback - Called with the coalesced batch when the window expires.
   * @param options - Timing and overflow configuration.
   */
  public constructor(deliverCallback: (events: ChangeEvent[]) => void, options?: CoalescerOptions) {
    this._deliverCallback = deliverCallback;
    this._windowMs = options?.windowMs ?? defaultWindowMs;
    this._maxQueueDepth = options?.maxQueueDepth ?? defaultMaxQueueDepth;
    this._onOverflow = options?.onOverflow;
  }

  /**
   * Queue an event for coalescing.
   *
   * @param event - Change event to queue.
   */
  public push(event: ChangeEvent): void {
    if (this._pending.length >= this._maxQueueDepth) {
      this._pending = [];
      if (this._timer !== undefined) {
        clearTimeout(this._timer);
        this._timer = undefined;
      }
      this._onOverflow?.();
      return;
    }

    this._pending.push({ event, timestamp: Date.now() });

    this._timer ??= setTimeout(() => {
      this._flush();
    }, this._windowMs);
  }

  /** Immediately flush any pending events (e.g. on dispose). */
  public flush(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._flush();
  }

  /** Cancel any pending timer and discard queued events. */
  public dispose(): void {
    if (this._timer !== undefined) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._pending = [];
  }

  private _flush(): void {
    this._timer = undefined;

    if (this._pending.length === 0) {
      return;
    }

    const events = this._pending.map((p) => p.event);
    this._pending = [];

    const coalesced = coalesceEvents(events);
    if (coalesced.length > 0) {
      this._deliverCallback(coalesced);
    }
  }
}

/**
 * Apply coalescing rules to a batch of events.
 *
 * Rules applied in order:
 * 1. Collect per-path event sequences
 * 2. Cancel `fileWritten → fileDeleted` pairs (same path)
 * 3. Collapse `fileDeleted → fileWritten` pairs to a single `fileWritten` (treated as update)
 * 4. Suppress child deletes when parent is deleted
 * 5. Deduplicate identical events
 *
 * @param events - Raw change events to coalesce.
 * @returns Coalesced event array.
 * @public
 */
export function coalesceEvents(events: ChangeEvent[]): ChangeEvent[] {
  if (events.length <= 1) {
    return events;
  }

  const renameEvents: ChangeEvent[] = [];
  const renamedFromPaths = new Set<string>();
  const pathHistory = new Map<string, ChangeEvent[]>();
  const nonPathEvents: ChangeEvent[] = [];

  for (const event of events) {
    if (event.type === 'fileRenamed') {
      renameEvents.push(event);
      renamedFromPaths.add(event.oldPath);
      continue;
    }
    const path = getEventPath(event);
    if (!path) {
      nonPathEvents.push(event);
      continue;
    }
    let history = pathHistory.get(path);
    if (!history) {
      history = [];
      pathHistory.set(path, history);
    }
    history.push(event);
  }

  const result: ChangeEvent[] = [];
  const deletedDirectories = new Set<string>();

  for (const event of nonPathEvents) {
    result.push(event);
  }

  for (const [path, history] of pathHistory) {
    const collapsed = collapsePathHistory(history);
    if (!collapsed) {
      continue;
    }

    if (collapsed.type === 'fileDeleted' && renamedFromPaths.has(path)) {
      continue;
    }

    if (collapsed.type === 'fileDeleted') {
      deletedDirectories.add(path);
    }
    result.push(collapsed);
  }

  for (const event of renameEvents) {
    result.push(event);
  }

  return result.filter((event) => {
    if (event.type !== 'fileDeleted') {
      return true;
    }
    const { path } = event;
    for (const directory of deletedDirectories) {
      if (directory !== path && path.startsWith(`${directory}/`)) {
        return false;
      }
    }
    return true;
  });
}

function collapsePathHistory(history: ChangeEvent[]): ChangeEvent | undefined {
  if (history.length === 0) {
    return undefined;
  }
  if (history.length === 1) {
    return history[0];
  }

  const first = history[0]!;
  const last = history.at(-1)!;

  const firstType = first.type;
  const lastType = last.type;

  if (firstType === 'fileWritten' && lastType === 'fileDeleted') {
    return undefined;
  }

  if (firstType === 'fileDeleted' && lastType === 'fileWritten') {
    return last;
  }

  return last;
}

function getEventPath(event: ChangeEvent): string | undefined {
  switch (event.type) {
    case 'fileWritten':
    case 'fileDeleted':
    case 'directoryChanged': {
      return event.path;
    }
    case 'fileRenamed': {
      return event.oldPath;
    }
    default: {
      return undefined;
    }
  }
}
