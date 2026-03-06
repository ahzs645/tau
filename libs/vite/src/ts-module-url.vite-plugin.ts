import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Shared regex for `new URL('./path.js', import.meta.url)` patterns.
 * Captures the relative path (group 1) and optional `.href` suffix (group 2).
 */
const urlPattern = /new\s+URL\(\s*["']([^"']+\.js)["']\s*,\s*import\.meta\.url\s*\)(\.href)?/g;

type UrlMatch = {
  full: string;
  relativePath: string;
  hasHref: boolean;
  index: number;
};

/**
 * Find all `new URL('./path.js', import.meta.url)` references where a `.ts`
 * source file exists on disk for the referenced `.js` path.
 */
function findTsSourceMatches(code: string, directory: string): UrlMatch[] {
  return [...code.matchAll(urlPattern)]
    .map((m) => ({
      full: m[0],
      relativePath: m[1]!,
      hasHref: Boolean(m[2]),
      index: m.index,
    }))
    .filter(({ relativePath }) => fs.existsSync(path.resolve(directory, relativePath.replace(/\.js$/, '.ts'))));
}

/**
 * Build-time plugin: emit TypeScript files referenced via
 * `new URL('./path.js', import.meta.url)` as fully-bundled Rollup chunks
 * instead of raw asset copies.
 *
 * In dev mode Vite transpiles TypeScript on-the-fly so .ts assets work fine.
 * In production builds, however, .ts files emitted as assets are copied
 * verbatim — the server serves them with `video/mp2t` MIME type and the
 * browser rejects them ("non-JavaScript MIME type").
 *
 * This plugin fixes the production path: for every `new URL()` reference
 * whose .js path resolves to a .ts source file, it tells Rollup to emit
 * the file as a chunk (full pipeline: transpile → resolve → bundle) and
 * swaps the expression with `import.meta.ROLLUP_FILE_URL_<ref>`.
 *
 * When the .js file actually exists (pre-built package consumed by 3rd
 * parties), the fs check fails and the plugin is a no-op — Vite's default
 * asset handling takes over unchanged.
 */
export function tsModuleUrlBuildPlugin(): Plugin {
  return {
    name: 'vite-plugin-ts-module-urls-build',
    enforce: 'pre',
    apply: 'build',

    transform(code, id) {
      if (!code.includes('import.meta.url')) {
        return;
      }

      const directory = path.dirname(id);
      const matches = findTsSourceMatches(code, directory);

      if (matches.length === 0) {
        return;
      }

      let result = code;

      for (const match of [...matches].reverse()) {
        const tsPath = path.resolve(directory, match.relativePath.replace(/\.js$/, '.ts'));
        const refId = this.emitFile({ type: 'chunk', id: tsPath });

        const replacement = match.hasHref
          ? `import.meta.ROLLUP_FILE_URL_${refId}`
          : `new URL(import.meta.ROLLUP_FILE_URL_${refId})`;

        result = result.slice(0, match.index) + replacement + result.slice(match.index + match.full.length);
      }

      return { code: result, map: null };
    },
  };
}

/**
 * Serve-time plugin: rewrite `new URL('./path.js', import.meta.url)`
 * references to `.ts` sources. In standard Vite, the SSR module runner
 * resolved `.js` → `.ts` transparently; rolldown-vite does not, so dynamic
 * imports of the resulting `file://` URLs fail. This plugin rewrites the URL
 * at transform time so the resolved URL points to the existing `.ts` file.
 */
export function tsModuleUrlServePlugin(): Plugin {
  return {
    name: 'vite-plugin-ts-module-urls-serve',
    enforce: 'pre',
    apply: 'serve',

    transform(code, id) {
      if (!code.includes('import.meta.url')) {
        return;
      }

      const directory = path.dirname(id);
      const matches = findTsSourceMatches(code, directory);

      if (matches.length === 0) {
        return;
      }

      let result = code;

      for (const { full, relativePath } of [...matches].reverse()) {
        const tsRelativePath = relativePath.replace(/\.js$/, '.ts');
        result = result.replace(full, full.replace(relativePath, tsRelativePath));
      }

      return { code: result, map: null };
    },
  };
}

/**
 * Convenience: returns both the build and serve plugins.
 * Use this when you need both (most apps do).
 */
export function tsModuleUrlPlugin(): Plugin[] {
  return [tsModuleUrlBuildPlugin(), tsModuleUrlServePlugin()];
}
