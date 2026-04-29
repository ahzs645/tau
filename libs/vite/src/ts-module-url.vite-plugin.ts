import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Shared regex for `new URL('<spec>', import.meta.url)` patterns.
 * Captures the specifier (group 1) and optional `.href` suffix (group 2).
 *
 * The specifier is intentionally not pinned to `.js` — bare module
 * specifiers (e.g. `@taucad/runtime/worker`) and extension-less paths
 * also need processing because Vite/Rollup will emit the resolved
 * `.ts` file as a verbatim asset (`/assets/<chunk>-<hash>.ts`) which
 * the browser refuses to load as a Worker module. Filtering for
 * `.ts`-resolving specifiers happens in {@link findTsSourceMatches}.
 */
const urlPattern = /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*,?\s*\)(\.href)?/g;

type UrlMatch = {
  full: string;
  specifier: string;
  hasHref: boolean;
  index: number;
};

type UrlMatchWithTsPath = UrlMatch & { tsPath: string };

/**
 * Specifiers we never try to resolve as modules. Anything with a URL
 * scheme (`http://`, `file://`, `data:`) or starting with `/` (absolute
 * filesystem path) is left to Vite's default asset handling.
 */
const isExternalLikeSpec = (spec: string): boolean => /^[a-z][\d+.a-z-]*:/i.test(spec) || spec.startsWith('/');

const collectMatches = (code: string): UrlMatch[] =>
  [...code.matchAll(urlPattern)].map((m) => ({
    full: m[0],
    specifier: m[1]!,
    hasHref: Boolean(m[2]),
    index: m.index,
  }));

type RollupLikeContext = {
  resolve?: (specifier: string, importer?: string) => Promise<{ id: string } | undefined> | { id: string } | undefined;
};

/**
 * Resolve every `new URL(...)` reference in `code` whose target is a
 * TypeScript source file:
 *
 * 1. Relative `.js` paths whose sibling `.ts` exists on disk (fast
 *    path — no async resolution needed; matches the original plugin's
 *    behavior for the in-package case).
 * 2. Any other specifier (relative without `.js`, or bare module
 *    specifier like `@taucad/runtime/worker`) is dispatched through
 *    Rollup's `this.resolve()` so package-export maps are honoured.
 *    The match is kept only when the resolved id ends in `.ts`.
 */
// oxlint-disable-next-line max-params -- refactor
const findTsSourceMatches = async (
  matches: UrlMatch[],
  directory: string,
  importer: string,
  context: RollupLikeContext,
): Promise<UrlMatchWithTsPath[]> => {
  const out: UrlMatchWithTsPath[] = [];

  for (const match of matches) {
    if (isExternalLikeSpec(match.specifier)) {
      continue;
    }

    if (match.specifier.endsWith('.js')) {
      const tsPath = path.resolve(directory, match.specifier.replace(/\.js$/, '.ts'));
      if (fs.existsSync(tsPath)) {
        out.push({ ...match, tsPath });
        continue;
      }
    }

    if (typeof context.resolve === 'function') {
      // oxlint-disable-next-line no-await-in-loop -- sequential resolve calls
      const resolved = await context.resolve(match.specifier, importer);
      if (resolved && typeof resolved.id === 'string' && resolved.id.endsWith('.ts')) {
        out.push({ ...match, tsPath: resolved.id });
      }
    }
  }

  return out;
};

/**
 * Build-time plugin: emit TypeScript files referenced via
 * `new URL(<spec>, import.meta.url)` as fully-bundled Rollup chunks
 * instead of raw asset copies.
 *
 * In dev mode Vite transpiles TypeScript on-the-fly so .ts assets work fine.
 * In production builds, however, .ts files emitted as assets are copied
 * verbatim — the server serves them with `video/mp2t` MIME type and the
 * browser rejects them ("non-JavaScript MIME type").
 *
 * This plugin fixes the production path: for every `new URL()` reference
 * whose specifier resolves to a .ts source file (either via the relative
 * `.js → .ts` heuristic or via Rollup's package-export resolver for bare
 * specifiers), it tells Rollup to emit the file as a chunk (full pipeline:
 * transpile → resolve → bundle) and swaps the expression with
 * `import.meta.ROLLUP_FILE_URL_<ref>`.
 *
 * When neither path resolves to a .ts file (pre-built JS package consumed
 * by 3rd parties, or a non-module asset like `.wasm`), the plugin is a
 * no-op for that match — Vite's default asset handling takes over unchanged.
 *
 * @public
 */
export function tsModuleUrlBuildPlugin(): Plugin {
  return {
    name: 'vite:ts-module-url-build',
    enforce: 'pre',
    apply: 'build',

    transform: {
      filter: { code: 'import.meta.url' },
      async handler(code, id) {
        if (!code.includes('import.meta.url')) {
          return;
        }

        const directory = path.dirname(id);
        const matches = await findTsSourceMatches(
          collectMatches(code),
          directory,
          id,
          this as unknown as RollupLikeContext,
        );

        if (matches.length === 0) {
          return;
        }

        let result = code;

        for (const match of [...matches].reverse()) {
          /* `preserveSignature: 'strict'` keeps the chunk's `export` statements
           * intact even when no static `import` consumes them. The chunk is
           * referenced via `new URL(...)` (asset pattern) and dynamic
           * `import(moduleUrl)` at runtime; without this option Rollup
           * (in app-build mode under regular Vite, e.g. electron-vite's
           * bundled Vite 5) tree-shakes the exports because the static
           * graph never imports them, leaving the chunk's `default` export
           * unreachable and breaking the runtime worker dispatcher's
           * `import(moduleUrl).then(m => m.default)` flow.
           * (Rolldown-vite preserves signatures by default; vanilla Rollup
           * does not.) */
          const refId = this.emitFile({
            type: 'chunk',
            id: match.tsPath,
            preserveSignature: 'strict',
          });

          const replacement = match.hasHref
            ? `import.meta.ROLLUP_FILE_URL_${refId}`
            : `new URL(import.meta.ROLLUP_FILE_URL_${refId})`;

          result = result.slice(0, match.index) + replacement + result.slice(match.index + match.full.length);
        }

        return { code: result, map: null, moduleType: 'js' };
      },
    },
  };
}

/**
 * Serve-time plugin: rewrite `new URL('./path.js', import.meta.url)`
 * references to `.ts` sources. In standard Vite, the SSR module runner
 * resolved `.js` → `.ts` transparently; rolldown-vite does not, so dynamic
 * imports of the resulting `file://` URLs fail. This plugin rewrites the URL
 * at transform time so the resolved URL points to the existing `.ts` file.
 *
 * Bare module specifiers (`@scope/pkg/sub`) are NOT rewritten here — Vite's
 * dev module resolver consumes them directly via the package's `exports`
 * map and serves the underlying `.ts` source on the fly.
 *
 * @public
 */
export function tsModuleUrlServePlugin(): Plugin {
  return {
    name: 'vite:ts-module-url-serve',
    enforce: 'pre',
    apply: 'serve',

    transform: {
      filter: { code: 'import.meta.url' },
      handler(code, id) {
        if (!code.includes('import.meta.url')) {
          return;
        }

        const directory = path.dirname(id);
        const matches = collectMatches(code).filter(({ specifier }) => {
          if (isExternalLikeSpec(specifier)) {
            return false;
          }
          if (!specifier.endsWith('.js')) {
            return false;
          }
          const tsPath = path.resolve(directory, specifier.replace(/\.js$/, '.ts'));
          return fs.existsSync(tsPath);
        });

        if (matches.length === 0) {
          return;
        }

        let result = code;

        for (const { full, specifier } of [...matches].reverse()) {
          const tsSpecifier = specifier.replace(/\.js$/, '.ts');
          result = result.replace(full, full.replace(specifier, tsSpecifier));
        }

        return { code: result, map: null, moduleType: 'js' };
      },
    },
  };
}

/**
 * Convenience: returns both the build and serve plugins.
 * Use this when you need both (most apps do).
 *
 * @public
 */
export function tsModuleUrlPlugin(): Plugin[] {
  return [tsModuleUrlBuildPlugin(), tsModuleUrlServePlugin()];
}
