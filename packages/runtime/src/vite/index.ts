/**
 * Vite integrations for `@taucad/runtime` consumers.
 *
 * This namespace hosts Vite-specific helpers. The canonical header set is
 * duplicated here (as a tiny frozen map) rather than imported from
 * `../cross-origin-isolation/index.js`: the Vite config graph resolver that
 * Nx uses to analyse `vite.config.ts` consumers does not follow `.js`
 * specifiers back to `.ts` sources across workspace packages, so we keep this
 * entry self-contained and guard drift with a dedicated test that asserts
 * parity against `documentHeaders`.
 *
 * @public
 *
 * @see https://vite.dev/guide/api-plugin.html
 */

import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

const documentHeaders: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/**
 * Vite plugin that sets the canonical cross-origin isolation headers on every
 * dev and preview server response. Required for `SharedArrayBuffer` (used by
 * multi-threaded OpenCASCADE, the file pool, the geometry pool, and the
 * signal-buffer abort channel).
 *
 * Uses `configureServer` middleware (not `server.headers`) so headers apply
 * to all responses including those served by framework plugins like React
 * Router SSR.
 *
 * @returns A Vite `Plugin` that registers the isolation middleware.
 *
 * @public
 *
 * @see https://github.com/vitejs/vite/issues/3909#issuecomment-934044912
 *
 * @example <caption>Register the plugin in vite.config.ts</caption>
 * ```typescript
 * import { crossOriginIsolation } from '@taucad/runtime/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   plugins: [crossOriginIsolation()],
 * });
 * ```
 */
export function crossOriginIsolation(): Plugin {
  const applyHeaders = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use((_request, response, next) => {
      for (const [name, value] of Object.entries(documentHeaders)) {
        response.setHeader(name, value);
      }
      next();
    });
  };

  return {
    name: 'taucad-runtime:cross-origin-isolation',
    configureServer: applyHeaders,
    configurePreviewServer: applyHeaders,
  };
}
