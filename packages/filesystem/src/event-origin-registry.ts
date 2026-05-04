import type { ChangeEvent } from '#types.js';

const originRegistry = new WeakMap<ChangeEvent, string>();

/**
 * Attach the originating bridge port id to a change event for intra-process
 * routing (coalescer merge rule, bridge skip-originator). Never serialised or
 * sent over the wire.
 *
 * @param event - Change event instance to tag (WeakMap key).
 * @param originClientId - Originating bridge port id.
 *
 * @public
 */
export function tagEventOrigin(event: ChangeEvent, originClientId: string): void {
  originRegistry.set(event, originClientId);
}

/**
 * Read the originating bridge port id for an event, if tagged.
 *
 * @param event - Change event to look up.
 * @returns The port id if tagged; otherwise `undefined`.
 *
 * @public
 */
export function getEventOrigin(event: ChangeEvent): string | undefined {
  return originRegistry.get(event);
}

/**
 * Remove any originating-port tag from an event (e.g. after origin merge clears).
 *
 * @param event - Change event to untag.
 *
 * @public
 */
export function clearEventOrigin(event: ChangeEvent): void {
  originRegistry.delete(event);
}
