import { setup, assign } from 'xstate';

/**
 * Conservative limit that leaves headroom for gizmo renderers, screenshot
 * off-screen canvases, and other incidental WebGL contexts.  Browsers
 * typically allow 8-16 active contexts per origin; the oldest context is
 * silently lost when the limit is exceeded.
 */
const maxWebglContexts = 8;

// Type definitions
type WebglContextMachineContext = {
  count: number;
  limit: number;
};

type WebglContextMachineEvents = { type: 'acquire' } | { type: 'release' };

/**
 * Tracks the number of active WebGL rendering contexts across all viewer
 * panels.  Components send `acquire` when a Canvas mounts and `release`
 * when it unmounts.  Consumers read `count` / `limit` via
 * `actorRef.getSnapshot()` (imperative, non-reactive) to decide whether
 * to create a new context or show a fallback.
 *
 * **Important**: Do NOT use `useSelector` on this actor in any component
 * that controls mounting/unmounting of a WebGL Canvas based on the count.
 * Both `useSelector` and `useSyncExternalStore` notify subscribers
 * synchronously, which creates an infinite re-render loop when the
 * subscribing component's render output controls the child that triggers
 * acquire/release events.
 */
export const webglContextMachine = setup({
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- Required for XState's type inference */
  types: {
    context: {} as WebglContextMachineContext,
    events: {} as WebglContextMachineEvents,
  },
  /* eslint-enable @typescript-eslint/consistent-type-assertions -- reenabling */
  guards: {
    hasActiveContexts: ({ context }) => context.count > 0,
  },
}).createMachine({
  id: 'webglContext',
  context: {
    count: 0,
    limit: maxWebglContexts,
  },
  on: {
    acquire: {
      actions: assign({
        count: ({ context }) => context.count + 1,
      }),
    },
    release: {
      guard: 'hasActiveContexts',
      actions: assign({
        count: ({ context }) => context.count - 1,
      }),
    },
  },
});
