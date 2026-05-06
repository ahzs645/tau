import { metaConfig } from '#constants/meta.constants.js';

/**
 * Canonical production URL for the deployed app.
 *
 * Built field-by-field through the WHATWG `URL` setters so
 * `metaConfig.appDomain` is validated as a bare hostname — any scheme,
 * path, or stray separator slipping into the constant trips the
 * post-assignment check and throws at module load. Surfaces config drift
 * at build / boot time (e.g. React Router prerender pass) instead of
 * silently emitting broken absolute URLs (`Sitemap:`, `<loc>`, etc.) at
 * runtime.
 *
 * `placeholder.invalid` is RFC 6761-reserved and can never collide with a
 * real domain, so the placeholder construction is unambiguous.
 */
function buildCanonicalProductionUrl(): URL {
  const url = new URL('https://placeholder.invalid/');
  url.protocol = 'https:';
  url.hostname = metaConfig.appDomain;
  if (url.hostname !== metaConfig.appDomain.toLowerCase()) {
    throw new Error(
      `Invalid metaConfig.appDomain (expected bare hostname, got ${JSON.stringify(metaConfig.appDomain)})`,
    );
  }
  return url;
}

export const canonicalProductionUrl: URL = buildCanonicalProductionUrl();

/**
 * Returns true when `frontendUrl` resolves to the canonical production
 * origin. Trailing slashes, paths, and query strings are normalised away
 * by the WHATWG `URL` parser, and a malformed URL throws.
 */
export function isCanonicalProductionUrl(frontendUrl: string): boolean {
  return new URL(frontendUrl).origin === canonicalProductionUrl.origin;
}
