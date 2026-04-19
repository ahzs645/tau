/**
 * Type guard for abort errors thrown by `AbortController` / `AbortSignal`.
 *
 * Covers both the standard `DOMException` with `name === 'AbortError'`
 * (thrown by `fetch`, XState's `waitFor`, etc.) and any `Error` subclass
 * whose `name` has been set to `'AbortError'`.
 * @public
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}
