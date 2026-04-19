/**
 * Shared XState test utilities.
 *
 * `stopRootWithRehydration` mirrors the internal stop-and-rehydrate logic
 * from `@xstate/react` so that unit tests can simulate React Strict Mode
 * double-mount without pulling in the full React integration.
 *
 * @see https://github.com/statelyai/xstate/blob/main/packages/xstate-react/src/stopRootWithRehydration.ts
 */
import type { AnyActorRef } from 'xstate';

export function forEachActor(actorRef: AnyActorRef, callback: (ref: AnyActorRef) => void): void {
  callback(actorRef);
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mirror @xstate/react internals
  const { children } = actorRef.getSnapshot();
  if (children) {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-argument -- mirror @xstate/react internals
    for (const child of Object.values(children)) {
      forEachActor(child as AnyActorRef, callback);
    }
  }
}

/**
 * Stops an actor tree and rehydrates snapshots so the actors can be
 * restarted in the same state — simulating React Strict Mode unmount/remount.
 *
 * Accesses private XState internals (`observers`, `_snapshot`,
 * `_processingStatus`) via `as unknown as Record<string, unknown>`.
 * This is intentional: the alternative is importing private symbols from
 * `@xstate/react`, which is not exported.
 */
export function stopRootWithRehydration(actorRef: AnyActorRef): void {
  const persistedSnapshots: Array<[AnyActorRef, unknown]> = [];
  forEachActor(actorRef, (ref) => {
    persistedSnapshots.push([ref, ref.getSnapshot()]);
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mirror @xstate/react internals
    (ref as unknown as Record<string, unknown>)['observers'] = new Set();
  });

  // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- mirror @xstate/react internals
  const systemSnapshot = (
    (actorRef.system as unknown as Record<string, unknown>)['getSnapshot'] as (() => unknown) | undefined
  )?.();
  actorRef.stop();
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mirror @xstate/react internals
  (actorRef.system as unknown as Record<string, unknown>)['_snapshot'] = systemSnapshot;

  for (const [ref, snapshot] of persistedSnapshots) {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mirror @xstate/react internals
    (ref as unknown as Record<string, unknown>)['_processingStatus'] = 0;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access -- mirror @xstate/react internals
    (ref as unknown as Record<string, unknown>)['_snapshot'] = snapshot;
  }
}
