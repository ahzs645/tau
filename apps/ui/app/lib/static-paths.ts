import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGetUrl, getSlugs } from 'fumadocs-core/source';

const getDocumentUrl = createGetUrl('/docs');

/** Repo root for `apps/ui` (directory containing `content/docs`). */
export function getUiRootDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../..');
}

const docsContentRoot = join(getUiRootDirectory(), 'content/docs');

/**
 * Canonical list of paths prerendered at build time and/or listed in
 * `sitemap.xml`. Keep in sync with {@link react-router.config.ts} `prerender.paths`.
 */
export async function listStaticPrerenderPaths(): Promise<string[]> {
  const documentPages: string[] = [];
  for await (const entry of glob('**/*.mdx', { cwd: docsContentRoot })) {
    documentPages.push(getDocumentUrl(getSlugs(entry)));
  }

  return [
    '/',
    '/playground',
    '/manifest.webmanifest',
    '/version.json',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/llms-full.txt',
    ...documentPages,
    '/legal',
    '/legal/terms',
    '/legal/privacy',
    '/legal/cookies',
    '/legal/subprocessors',
    '/legal/acceptable-use',
  ];
}

export { docsContentRoot, getDocumentUrl };
