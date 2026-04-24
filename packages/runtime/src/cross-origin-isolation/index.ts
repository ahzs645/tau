/**
 * Canonical cross-origin isolation headers and runtime helpers.
 *
 * Consumers of `@taucad/runtime` that need `SharedArrayBuffer` (file pool,
 * geometry pool, signal-buffer abort channel, multi-threaded WASM) must serve
 * a `crossOriginIsolated` document. This module is the single source of truth
 * for the header set — every framework adapter (`@taucad/runtime/vite`,
 * `@taucad/runtime/react-router`, …) depends on it.
 *
 * @public
 *
 * @see https://web.dev/articles/coop-coep
 *
 * @example <caption>Set headers on a `Response`</caption>
 * ```typescript
 * import { applyDocumentHeaders } from '@taucad/runtime/cross-origin-isolation';
 *
 * const response = new Response('<!doctype html>…');
 * applyDocumentHeaders(response.headers);
 * ```
 *
 * @example <caption>Detect runtime isolation status</caption>
 * ```typescript
 * import { inspectCrossOriginIsolation } from '@taucad/runtime/cross-origin-isolation';
 *
 * const status = inspectCrossOriginIsolation();
 * if (!status.crossOriginIsolated) console.warn('COI disabled:', status.reason);
 * ```
 */

/**
 * Headers required on the top-level HTML document response for the browser to
 * enter the cross-origin isolated state. Apply these at every layer that
 * produces a document response (SSR function, dev server, static host).
 *
 * @public
 */
export const documentHeaders: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/**
 * Headers for cross-origin API responses consumed by an isolated document.
 * The API must advertise `Cross-Origin-Resource-Policy: cross-origin` so the
 * embedder policy of the caller (`require-corp`) admits the response.
 *
 * @public
 */
export const apiHeaders: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Resource-Policy': 'cross-origin',
});

/**
 * Headers for same-origin subresources (images, fonts, assets) served to a
 * `require-corp` document. Equivalent to the CORP portion of
 * {@link documentHeaders}; provided as a distinct constant so consumers can
 * reason about each response class explicitly.
 *
 * @public
 */
export const subresourceHeaders: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/**
 * Reason `crossOriginIsolated` is not active.
 *
 * - `no-secure-context`: Not served over HTTPS or `localhost`.
 * - `no-coep`: The document lacks the required COOP + COEP headers.
 * - `no-sab-constructor`: `SharedArrayBuffer` is not defined on the global.
 *
 * @public
 */
export type IsolationFailureReason = 'no-secure-context' | 'no-coep' | 'no-sab-constructor';

/**
 * Result of {@link inspectCrossOriginIsolation}.
 *
 * @public
 */
export type IsolationStatus =
  | { crossOriginIsolated: true; sharedArrayBuffer: true }
  | { crossOriginIsolated: false; sharedArrayBuffer: boolean; reason: IsolationFailureReason };

/**
 * Apply {@link documentHeaders} to a `Headers` instance or a plain header
 * record. Existing values for the same names are replaced.
 *
 * @param target - The headers object to mutate.
 *
 * @public
 */
export function applyDocumentHeaders(target: Headers | Record<string, string>): void {
  applyHeaderMap(target, documentHeaders);
}

/**
 * Apply {@link apiHeaders} to a `Headers` instance or a plain header record.
 * Existing values for the same names are replaced.
 *
 * @param target - The headers object to mutate.
 *
 * @public
 */
export function applyApiHeaders(target: Headers | Record<string, string>): void {
  applyHeaderMap(target, apiHeaders);
}

/**
 * Apply {@link subresourceHeaders} to a `Headers` instance or a plain header
 * record. Existing values for the same names are replaced.
 *
 * @param target - The headers object to mutate.
 *
 * @public
 */
export function applySubresourceHeaders(target: Headers | Record<string, string>): void {
  applyHeaderMap(target, subresourceHeaders);
}

/**
 * Inspect the current runtime environment for cross-origin isolation and
 * `SharedArrayBuffer` availability. Safe to call from any JavaScript runtime
 * (browser main thread, Worker, Node.js); returns a typed status object so
 * consumers can surface degradation in their UI.
 *
 * @returns Discriminated union describing isolation state.
 *
 * @public
 */
export function inspectCrossOriginIsolation(): IsolationStatus {
  const globalScope = globalThis as typeof globalThis & {
    crossOriginIsolated?: boolean;
    isSecureContext?: boolean;
    SharedArrayBuffer?: unknown;
  };
  const sab = typeof globalScope.SharedArrayBuffer === 'function';
  const isolated = Boolean(globalScope.crossOriginIsolated);
  if (isolated && sab) {
    return { crossOriginIsolated: true, sharedArrayBuffer: true };
  }
  const secure = Boolean(globalScope.isSecureContext);
  const reason: IsolationFailureReason = sab ? (secure ? 'no-coep' : 'no-secure-context') : 'no-sab-constructor';
  return { crossOriginIsolated: false, sharedArrayBuffer: sab, reason };
}

function applyHeaderMap(target: Headers | Record<string, string>, headers: Readonly<Record<string, string>>): void {
  if (target instanceof Headers) {
    for (const [name, value] of Object.entries(headers)) {
      target.set(name, value);
    }
    return;
  }
  Object.assign(target, headers);
}
