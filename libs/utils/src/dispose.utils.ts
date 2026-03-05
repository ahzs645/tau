/**
 * Execute a cleanup function, swallowing any errors to ensure
 * subsequent cleanup steps in a disposal chain are not blocked.
 *
 * Use in teardown paths where multiple resources must be released
 * and one failure must not prevent the rest from being cleaned up.
 *
 * @param cleanupFunction - Cleanup function to execute (no-ops if undefined)
 *
 * @example
 * ```typescript
 * safeDispose(() => proxy.dispose());
 * safeDispose(() => worker.terminate());
 * safeDispose(() => port.close());
 * ```
 */
export function safeDispose(cleanupFunction: (() => void) | undefined): void {
  try {
    cleanupFunction?.();
  } catch (error) {
    console.error('Failed to dispose:', error);
    // Intentionally swallowed — disposal errors must not break the cleanup chain.
  }
}
