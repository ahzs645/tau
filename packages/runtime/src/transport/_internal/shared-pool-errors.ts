/**
 * Shared-pool lookup errors raised by the geometry materialisation layer.
 *
 * Lives in `transport/_internal/` alongside the geometry materialiser
 * (`#transport/_internal/geometry-materialiser.js`) — its sole producer.
 * Public so consumers can classify failures via `error.code` / `is*Error`
 * guards on the runtime barrel re-export.
 */

/**
 * Error raised when a consumer requests a pooled geometry entry whose key
 * is not present in the SAB-backed `SharedPool`. The geometry materialiser
 * throws this when a `{ delivery: 'pooled', key }` lookup fails.
 *
 * @public
 */
export class SharedPoolEntryNotFoundError extends Error {
  public readonly key: string;

  /**
   * @param key - The pool entry key that was missing.
   */
  public constructor(key: string) {
    super(`SharedPool entry not found: key=${key}`);
    this.name = 'SharedPoolEntryNotFoundError';
    this.key = key;
  }

  /** */
  public get code(): 'RUNTIME_SHARED_POOL_KEY_MISSING' {
    return 'RUNTIME_SHARED_POOL_KEY_MISSING';
  }
}

/**
 * Realm-safe type guard for {@link SharedPoolEntryNotFoundError} -- checks
 * `error.name` instead of prototype chain so cross-realm Errors (Web Workers,
 * iframes) are still recognised.
 *
 * @param error - the value to test
 * @returns `true` when the error is a {@link SharedPoolEntryNotFoundError}
 * @public
 */
export function isSharedPoolEntryNotFoundError(error: unknown): error is SharedPoolEntryNotFoundError {
  return error instanceof Error && error.name === 'SharedPoolEntryNotFoundError';
}
