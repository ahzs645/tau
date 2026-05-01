/**
 * Worker-side crash trap.
 *
 * Installs `uncaughtException` / `unhandledRejection` (Node) or
 * `error` / `unhandledrejection` (browser/worker) listeners that close
 * the channel server with an `lb` (bye) frame so the renderer always
 * observes a typed shutdown instead of a half-open seam when the
 * worker crashes.
 *
 * Lives under `transport/_internal/` because it is plumbing owned by
 * each transport's `host()` factory (web/node-worker hosts install it
 * automatically inside `open()`), not framework-layer code.
 *
 * @internal
 */

import { isNode } from '#framework/environment.js';

/**
 * Install the worker-side crash trap.
 *
 * @param handle - Channel server handle whose `dispose(reason)` will
 *   be invoked to push the `lb` frame.
 * @returns A teardown function that removes the listeners. The
 *   returned function does NOT dispose the channel — call
 *   `handle.dispose(...)` separately for an orderly close.
 */
export const installWorkerCrashTrap = (handle: { dispose(reason?: string): void }): (() => void) => {
  const closeWithBye = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason);
    try {
      handle.dispose(`worker-uncaught: ${message}`);
    } catch {
      /* Drop: dispose is idempotent and we cannot recover from a
       * post-crash double-close. The wire `lb` frame from the first
       * dispose() is what the consumer actually observes. */
    }
  };

  if (isNode()) {
    const onUncaught = (error: unknown): void => {
      closeWithBye(error);
    };
    const onUnhandled = (reason: unknown): void => {
      closeWithBye(reason);
    };
    // oxlint-disable-next-line n/prefer-global/process -- guarded by isNode()
    process.on('uncaughtException', onUncaught);
    // oxlint-disable-next-line n/prefer-global/process -- guarded by isNode()
    process.on('unhandledRejection', onUnhandled);
    return (): void => {
      // oxlint-disable-next-line n/prefer-global/process -- guarded by isNode()
      process.off('uncaughtException', onUncaught);
      // oxlint-disable-next-line n/prefer-global/process -- guarded by isNode()
      process.off('unhandledRejection', onUnhandled);
    };
  }

  const onErrorEvent = (event: ErrorEvent): void => {
    closeWithBye(event.error ?? event.message);
  };
  const onRejectionEvent = (event: PromiseRejectionEvent): void => {
    closeWithBye(event.reason);
  };
  globalThis.addEventListener('error', onErrorEvent);
  globalThis.addEventListener('unhandledrejection', onRejectionEvent);
  return (): void => {
    globalThis.removeEventListener('error', onErrorEvent);
    globalThis.removeEventListener('unhandledrejection', onRejectionEvent);
  };
};
