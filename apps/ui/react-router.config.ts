import type { Config } from '@react-router/dev/config';
import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGetUrl, getSlugs } from 'fumadocs-core/source';

const getDocumentUrl = createGetUrl('/docs');
const docsContentRoot = join(dirname(fileURLToPath(import.meta.url)), 'content/docs');

/**
 * Concurrency for parallel prerender requests. React Router defaults to 1
 * (serial); raising it speeds up the build because each prerendered URL runs
 * through the full SSR pipeline (~50–200 ms wall time per page) but the work
 * is mostly I/O and string assembly, not CPU.
 *
 * 4 matches the React Router docs example
 * (https://reactrouter.com/how-to/pre-rendering#concurrency) and is a safe
 * ceiling on a 22 MB SSR Function bundle: enough parallelism to cut the
 * ~40-page prerender pass to a few seconds, low enough to not blow memory in
 * CI runners. Bump cautiously — N > 8 has produced OOMs in similar setups.
 */
const prerenderConcurrency = 4;

/**
 * Pre-render docs URLs by walking the Fumadocs MDX content tree directly
 * with `fumadocs-core/source` helpers (canonical Fumadocs + React Router wiring,
 * see https://www.fumadocs.dev/docs/manual-installation/react-router).
 *
 * `/llms.mdx/*` is intentionally NOT prerendered: nested URL segments and the
 * parent route would both write under `build/client/llms.mdx/...`, causing
 * `EISDIR` (file vs directory collision). Those routes rely on the
 * `Netlify-CDN-Cache-Control` headers on the SSR loader instead.
 *
 * `getStaticPaths()` is NOT used: most static routes here (`/projects`,
 * `/files`, `/usage`, `/settings_`, `/health/*`, `/action/set-theme`,
 * `/api/*`, `/_index`) are auth-gated, runtime-only, or proxy endpoints that
 * would fail prerender. Each safelisted path below is one that genuinely has
 * no per-request work.
 */
export default {
  ssr: true,
  prerender: {
    async paths() {
      const documentPages: string[] = [];
      for await (const entry of glob('**/*.mdx', { cwd: docsContentRoot })) {
        documentPages.push(getDocumentUrl(getSlugs(entry)));
      }

      return [
        '/manifest.webmanifest',
        '/robots.txt',
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
    },
    // eslint-disable-next-line @typescript-eslint/naming-convention -- React Router config field is `unstable_concurrency` (snake_case in upstream API).
    unstable_concurrency: prerenderConcurrency,
  },
} satisfies Config;
