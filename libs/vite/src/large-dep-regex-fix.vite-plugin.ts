import type { Plugin } from 'vite';

/**
 * Workaround for a Vite 8 beta bug where the internal `vite:asset-import-meta-url`
 * plugin uses a code filter regex (`/new\s+URL.+import\.meta\.url/s`) that overflows
 * V8's RegExp stack when tested against very large pre-bundled dependency chunks
 * (e.g. Monaco Editor's ~6MB `editor.api2-*.js`).
 *
 * This plugin replaces the problematic dotAll regex with a simple string check
 * (`"import.meta.url"`) which is a necessary condition for the regex to match.
 * The replacement is safe because the plugin's transform handler already performs
 * its own precise regex matching — the filter is only a fast pre-check.
 *
 * @see https://github.com/vitejs/vite/issues/XXXXX (to be filed)
 */
export function largeDepRegexFix(): Plugin {
  return {
    name: 'vite:large-dep-regex-fix',
    enforce: 'pre',

    configResolved(config) {
      for (const plugin of config.plugins) {
        if (plugin.name !== 'vite:asset-import-meta-url') {
          continue;
        }

        const { transform } = plugin;
        if (transform && typeof transform === 'object' && 'filter' in transform && transform.filter) {
          const filter = transform.filter as { code?: unknown };
          if (filter.code instanceof RegExp) {
            filter.code = 'import.meta.url';
          }
        }
      }
    },
  };
}
