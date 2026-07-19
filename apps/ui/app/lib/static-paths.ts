import { glob, readFile } from 'node:fs/promises';
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
 * Root-level `/<model>` playground pages, prerendered only on the GitHub
 * Pages gallery build (the `:model` route in `routes.ts` exists only there).
 * Mirrors the visible-project filter in `routes/playground/projects.ts`.
 */
async function listPlaygroundModelPaths(): Promise<string[]> {
  if (process.env['GITHUB_PAGES'] !== 'true') {
    return [];
  }

  const projectsRoot = join(getUiRootDirectory(), 'app/routes/playground/projects');
  const modelPaths: string[] = [];
  for await (const entry of glob('*/project.json', { cwd: projectsRoot })) {
    const metadata = JSON.parse(await readFile(join(projectsRoot, entry), 'utf8')) as { hidden?: boolean };
    if (metadata.hidden === true) {
      continue;
    }
    modelPaths.push(`/${dirname(entry)}`);
  }

  return modelPaths.sort((left, right) => left.localeCompare(right));
}

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
    ...(await listPlaygroundModelPaths()),
    '/manifest.webmanifest',
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
