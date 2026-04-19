import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Plugin } from 'vite';

type CacheMetadata = {
  optimized: Record<string, { needsInterop: boolean }>;
};

/**
 * Reads the Vite dep-optimization cache from a previous dev session and
 * injects all discovered dependency names into `optimizeDeps.include` (and
 * `optimizeDeps.needsInterop`) so they are pre-bundled in a single pass on
 * cold start — eliminating the cascading "new dependencies optimized →
 * reloading" cycle.
 *
 * On the very first run (no cache exists yet) the plugin is a no-op; Vite
 * discovers deps normally. Every subsequent start reads the previous
 * session's `_metadata.json` and feeds it back, making startup instant.
 *
 * Safe edge cases:
 * - **Lockfile change**: dep names stay valid, only hashes differ — Vite
 *   re-optimizes without cascading.
 * - **Removed dep**: unresolvable name produces a harmless warning.
 * - **New dep**: discovered dynamically (single reload), then cached for
 *   the next start.
 */
export function optimizeDepsFromCache(): Plugin {
  return {
    name: 'vite:optimize-deps-from-cache',

    config(config, env) {
      if (env.command !== 'serve') {
        return;
      }

      const root = config.root ?? process.cwd();
      const cacheDirectory = resolve(root, config.cacheDir ?? 'node_modules/.vite');
      const metadataPath = resolve(cacheDirectory, 'deps/_metadata.json');

      if (!existsSync(metadataPath)) {
        return;
      }

      let metadata: CacheMetadata;
      try {
        metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as CacheMetadata;
      } catch {
        return;
      }

      const entries = Object.entries(metadata.optimized);
      if (entries.length === 0) {
        return;
      }

      const include = entries.map(([name]) => name);
      const needsInterop = entries.filter(([, meta]) => meta.needsInterop).map(([name]) => name);

      return {
        optimizeDeps: {
          include,
          ...(needsInterop.length > 0 ? { needsInterop } : {}),
        },
      };
    },
  };
}
