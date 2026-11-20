import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { readNodeCatalog } from '#scripts/catalog-node.js';

/** Emit deep links that work on static hosts without a rewrite service. */
export const galleryStaticPages = (): Plugin => ({
  name: 'gallery-static-pages',
  apply: 'build',
  // Vite emits index.html from its own generateBundle hook before post plugins.
  enforce: 'post',
  async generateBundle(_options, bundle) {
    const index = bundle['index.html'];
    if (index?.type !== 'asset' || typeof index.source !== 'string') {
      throw new Error('The gallery build did not produce index.html.');
    }
    const catalog = await readNodeCatalog();
    const publicProjects = catalog.filter(({ project }) => !project.hidden);
    const routes = [
      'playground',
      'tau',
      'tau/playground',
      ...publicProjects.flatMap(({ project }) => [project.id, `tau/${project.id}`]),
    ];
    for (const route of routes) {
      this.emitFile({ type: 'asset', fileName: `${route}/index.html`, source: index.source });
    }
    // GitHub Pages serves this file for unrecognised routes. The client renders a
    // useful missing-model page and preserves old query strings and share payloads.
    this.emitFile({ type: 'asset', fileName: '404.html', source: index.source });
    this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' });
    this.emitFile({ type: 'asset', fileName: 'CNAME', source: '3dd.ahmadjalil.com\n' });
    this.emitFile({
      type: 'asset',
      fileName: 'build-meta.json',
      source: JSON.stringify(
        {
          application: '@taucad/gallery',
          commit: process.env['VITE_COMMIT_SHA'] ?? 'local',
          upstream: '787e47d2a4cefa5d28c7488ef447253332679310',
          publicProjects: publicProjects.length,
          models: publicProjects.map(({ project }) => project.id),
        },
        null,
        2,
      ),
    });
    const licences = await Promise.all(
      (
        [
          ['LICENSE', 'license'],
          ['NOTICE', 'NOTICE'],
          ['GALLERY-LICENSE.txt', 'apps/gallery/LICENSE'],
          ['licenses/openscad/LICENSE', 'apps/gallery/src/runtime/classic/LICENSE'],
          ['licenses/openscad/NOTICE.md', 'apps/gallery/src/runtime/classic/NOTICE.md'],
          ['licenses/openscad/ENGINE-COPYING.txt', 'apps/gallery/node_modules/openscad-wasm-prebuilt/COPYING'],
          ['licenses/openscad/fonts/OFL.txt', 'apps/gallery/src/runtime/classic/fonts/OFL.txt'],
        ] as const
      ).map(async ([fileName, sourceName]) => ({
        fileName,
        source: await readFile(new URL(`../../${sourceName}`, import.meta.url), 'utf8'),
      })),
    );
    for (const licence of licences) {
      this.emitFile({ type: 'asset', ...licence });
    }
  },
});
