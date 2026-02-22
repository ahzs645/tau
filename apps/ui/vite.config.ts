import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import netlifyReactRouter from '@netlify/vite-plugin-react-router';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import mdx from 'fumadocs-mdx/vite';
import svgSpriteWrapper from 'vite-svg-sprite-wrapper';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
// eslint-disable-next-line no-restricted-imports -- allowed for Fumadocs.
import * as MdxConfig from './app/lib/fumadocs/source.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sprite generation can slow down the build time, so we disable it by default.
// Enable it when adding a new icon to regenerate the sprite.
const enableSpriteGeneration = false;

/**
 * Emit TypeScript files referenced via `new URL('./path.js', import.meta.url)`
 * as fully-bundled Rollup chunks instead of raw asset copies.
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
function tsModuleUrlPlugin(): Plugin {
  return {
    name: 'vite-plugin-ts-module-urls',
    enforce: 'pre',
    apply: 'build',

    transform(code, id) {
      if (!code.includes('import.meta.url')) {
        return;
      }

      const urlPattern = /new\s+URL\(\s*['"]([^'"]+\.js)['"]\s*,\s*import\.meta\.url\s*\)(\.href)?/g;
      const dir = path.dirname(id);

      type UrlMatch = { full: string; relPath: string; hasHref: boolean; idx: number };
      const matches: UrlMatch[] = [];

      let m: ReturnType<typeof urlPattern.exec>;

      while ((m = urlPattern.exec(code)) !== null) {
        const relPath = m[1]!;
        const tsPath = path.resolve(dir, relPath.replace(/\.js$/, '.ts'));
        if (fs.existsSync(tsPath)) {
          matches.push({ full: m[0], relPath, hasHref: Boolean(m[2]), idx: m.index });
        }
      }

      if (matches.length === 0) {
        return;
      }

      let result = code;

      for (const match of matches.reverse()) {
        const tsPath = path.resolve(dir, match.relPath.replace(/\.js$/, '.ts'));
        const refId = this.emitFile({ type: 'chunk', id: tsPath });

        const replacement = match.hasHref
          ? `import.meta.ROLLUP_FILE_URL_${refId}`
          : `import.meta.ROLLUP_FILE_URL_OBJ_${refId}`;

        result = result.slice(0, match.idx) + replacement + result.slice(match.idx + match.full.length);
      }

      return { code: result, map: null };
    },
  };
}

/**
 * A simple plugin to load files as base64 strings.
 *
 * The data encoding for url() imports is not supplied.
 */
const base64Loader: Plugin = {
  name: 'base64-loader',
  transform(_, id) {
    const [path, query] = id.split('?');
    if (query !== 'base64' || !path) {
      return;
    }

    const data = fs.readFileSync(path);
    const base64 = data.toString('base64');

    return `export default '${base64}';`;
  },
};

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test';
  const isNetlify = process.env['NETLIFY'] === 'true';

  return {
    root: __dirname,
    cacheDir: '../../node_modules/.vite/apps/ui',
    plugins: [
      // Emit .ts files referenced via new URL() as bundled chunks (production only)
      tsModuleUrlPlugin(),

      // Base64 Loader
      base64Loader,

      ...(isTest
        ? []
        : // In non-test mode, include the React Router plugin and the Netlify plugin
          [
            reactRouter(),
            // Netlify plugin is only needed for Netlify builds
            ...(isNetlify ? [netlifyReactRouter()] : []),
          ]),
      tailwindcss(),
      // RemixPWA(), // TODO: add PWA back after https://github.com/remix-pwa/monorepo/issues/284

      // Paths - use nxViteTsPaths only (tsconfigPaths is redundant in Nx workspaces)
      nxViteTsPaths(),

      // Fumadocs
      mdx(MdxConfig, { configPath: path.resolve(__dirname, './app/lib/fumadocs/source.config.ts') }), // Fumadocs

      // Browser DevTools JSON plugin.
      devtoolsJson(),

      // This plugin visualizes the bundle size of the build.
      visualizer({
        exclude: [{ file: '**/*?raw' }], // ignore raw files that are used for editor typings
      }),

      // This plugin generates an SVG sprite to reduce the number of requests to the server.
      // An SVG sprite is a single SVG file that contains all the SVG icons,
      // inlined as <use> elements.
      // This provides better caching performance.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- allowed for quick switching of sprite generation.
      ...(enableSpriteGeneration
        ? [
            svgSpriteWrapper({
              icons: path.resolve(__dirname, './app/components/icons/raw/**/*.svg'),
              outputDir: path.resolve(__dirname, './app/components/icons/generated'),
              generateType: true,
              typeOutputDir: path.resolve(__dirname, './app/components/icons/generated'),
              // Ensure the sprite retains the original svg attributes
              sprite: { shape: {} },
            }),
          ]
        : []),
    ],
    worker: {
      // Workers need their own plugins.
      // https://vite.dev/config/worker-options.html#worker-plugins
      plugins: () => [nxViteTsPaths()],
      format: 'es',
    },

    server: {
      port: 3000,
      // TODO: set to actual domain
      allowedHosts: true,
    },
    build: {
      sourcemap: true,
      assetsInlineLimit(file) {
        // Don't inline SVGs
        return !file.endsWith('.svg');
      },
      target: 'es2022',
    },

    test: {
      globals: true, // Required by @testing-library/jest-dom, which uses `expect` implicitly
      environment: 'jsdom',
      typecheck: {
        enabled: true,
        include: ['**/*.test-d.ts'],
        tsconfig: './tsconfig.spec.json',
        ignoreSourceErrors: true,
      },
      setupFiles: ['./vitest.setup.ts'],
      reporters: ['verbose'],
      coverage: {
        reportsDirectory: '../../coverage/apps/ui',
        provider: 'v8',
        include: ['app/**/*'],
        exclude: ['app/**/*.{test,spec}.{ts,tsx}', 'app/**/index.ts'],
      },
    },
  };
});
