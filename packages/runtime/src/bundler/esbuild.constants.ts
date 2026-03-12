/**
 * Centralized constants for the esbuild bundler plugin system.
 *
 * All namespace identifiers, prefix strings, and fetch limits live here
 * so they can be adjusted in a single place. These are shared between
 * the production plugin, the detection plugin, dependency extractors,
 * and the error-enrichment source-map resolver.
 */

/**
 * esbuild custom namespace identifiers.
 *
 * NOTE: esbuild reserves `"file"` for its built-in filesystem namespace,
 * so `vfs` is used instead to avoid collisions.
 *
 * - `vfs` — project files (project-relative paths) and CDN-cached modules
 * - `builtin` — pre-loaded modules served from memory (zero FS I/O)
 * - `httpUrl` — HTTP/HTTPS URLs fetched on demand
 */
export const esbuildNamespace = {
  vfs: 'vfs',
  builtin: 'builtin',
  httpUrl: 'http-url',
} as const;

/**
 * Prefix that esbuild prepends to file paths in error messages and metafile
 * keys for the `vfs` namespace (i.e. `"vfs:main.ts"`).
 *
 * Derived from the namespace identifier + `:`.
 */
export const vfsNamespacePrefix = `${esbuildNamespace.vfs}:`;

/** Maximum time (ms) to wait for a remote HTTP module before aborting. */
export const httpFetchTimeoutMs = 30_000;

/** Maximum response size (bytes) for fetched HTTP modules (10 MB). */
export const httpFetchMaxSizeBytes = 10 * 1024 * 1024;
