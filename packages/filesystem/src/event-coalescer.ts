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
 * Originating bridge port ids are stored on events via {@link tagEventOrigin} /
 * {@link getEventOrigin} from `#event-origin-registry.js` (not a separate wire
 * type).
 *
 * @see docs/policy/filesystem-policy.md
 */

import { clearEventOrigin, getEventOrigin, tagEventOrigin } from '#event-origin-registry.js';
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
  /** Window for coalescing events. Default: 50. Milliseconds. */
  coalescingWindow?: number;
  /** Maximum queue depth before emitting overflow. Default: 10,000. */
  maxQueueDepth?: number;
  /** Called when queue depth is exceeded. */
  onOverflow?: () => void;
};

/** Milliseconds. */
const defaultCoalescingWindow = 50;
const defaultMaxQueueDepth = 10_000;

function mergeOrigins(history: ChangeEvent[]): string | undefined {
  let sawDefined = false;
  let sawUndefined = false;
  let singleDefined: string | undefined;
  for (const event of history) {
    const origin = getEventOrigin(event);
    if (origin === undefined) {
      sawUndefined = true;
    } else {
      sawDefined = true;
      if (singleDefined === undefined) {
        singleDefined = origin;
      } else if (singleDefined !== origin) {
        return undefined;
      }
    }
  }
  if (sawUndefined && sawDefined) {
    return undefined;
  }
  if (sawDefined) {
    return singleDefined;
  }
  return undefined;
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

  const origin = mergeOrigins(history);

  if (firstType === 'fileWritten' && lastType === 'fileDeleted') {
    return undefined;
  }

  if (firstType === 'fileDeleted' && lastType === 'fileWritten') {
    applyCollapsedOrigin(last, origin);
    return last;
  }

  applyCollapsedOrigin(last, origin);
  return last;
}

function applyCollapsedOrigin(survivor: ChangeEvent, origin: string | undefined): void {
  if (origin === undefined) {
    clearEventOrigin(survivor);
    return;
  }

  tagEventOrigin(survivor, origin);
}

/**
 * Buffers {@link ChangeEvent}s within a time window and applies coalescing
 * rules (cancel-out, collapse, dedup) before delivering the batch.
 * @public
 */
export class EventCoalescer {
  /** Milliseconds. */
  private readonly _coalescingWindow: number;
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
    this._coalescingWindow = options?.coalescingWindow ?? defaultCoalescingWindow;
    this._maxQueueDepth = options?.maxQueueDepth ?? defaultMaxQueueDepth;
    this._onOverflow = options?.onOverflow;
  }

  /**
   * Queue an event for coalescing.
   *
   * @param event - Change event to queue. Origin may be set via {@link tagEventOrigin} before push.
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

    if (this._timer !== undefined) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      this._flush();
    }, this._coalescingWindow);
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

    const coalesced = coalesceChangeEvents(events);
    if (coalesced.length > 0) {
      this._deliverCallback(coalesced);
    }
  }
}

/**
 * Apply coalescing rules to a batch of events.
 *
 * Same originator across a merged path sequence preserves the tag via
 * {@link tagEventOrigin}; mixed originators (including untagged mixed with
 * tagged) clear it via {@link clearEventOrigin} on the survivor so every
 * bridge port receives the batch when appropriate.
 *
 * @param events - Raw change events to coalesce.
 * @returns Coalesced event array.
 * @public
 */
export function coalesceChangeEvents(events: ChangeEvent[]): ChangeEvent[] {
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

/**
 * Alias for {@link coalesceChangeEvents}; kept as the historical public entry
 * name for untagged batches used by tests and tooling.
 *
 * @param events - Raw change events to coalesce.
 * @returns Coalesced event array.
 * @public
 */
export function coalesceEvents(events: ChangeEvent[]): ChangeEvent[] {
  return coalesceChangeEvents(events);
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
