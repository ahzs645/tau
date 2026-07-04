import { flatRoutes } from '@react-router/fs-routes';
import { index, route } from '@react-router/dev/routes';
import type { RouteConfigEntry } from '@react-router/dev/routes';

const ignoredRouteFiles = ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'];
const isGithubPagesBuild = process.env['GITHUB_PAGES'] === 'true';

const githubPagesRoutes = (): RouteConfigEntry[] => [
  index('routes/_index/route.tsx'),
  route('playground', 'routes/playground/route.tsx'),
  route('manifest.webmanifest', 'routes/manifest[.webmanifest].ts'),
  route('robots.txt', 'routes/robots[.]txt/route.ts'),
  route('sitemap.xml', 'routes/sitemap[.]xml/route.ts'),
  route('llms.txt', 'routes/llms[.]txt/route.ts'),
  route('llms-full.txt', 'routes/llms-full[.]txt/route.ts'),
  route('llms.mdx/*', 'routes/llms[.]mdx.$/route.tsx'),
  route('docs.mdx', 'routes/docs[.]mdx/route.tsx'),
  route('docs/*', 'routes/docs.$/route.tsx'),
  route('docs/runtime/llms.txt', 'routes/docs.runtime.llms[.]txt/route.ts'),
  route('docs/runtime/llms-full.txt', 'routes/docs.runtime.llms-full[.]txt/route.ts'),
  route('legal', 'routes/legal/route.tsx', [
    index('routes/legal._index/route.tsx'),
    route('terms', 'routes/legal.terms/route.tsx'),
    route('privacy', 'routes/legal.privacy/route.tsx'),
    route('cookies', 'routes/legal.cookies/route.tsx'),
    route('subprocessors', 'routes/legal.subprocessors/route.tsx'),
    route('acceptable-use', 'routes/legal.acceptable-use/route.tsx'),
  ]),
];

const routes: Promise<RouteConfigEntry[]> = isGithubPagesBuild
  ? Promise.resolve(githubPagesRoutes())
  : flatRoutes({
      // Co-located route tests (e.g. `health.live.test.ts`) live next to the
      // route module they exercise. Without explicit ignore globs, flatRoutes
      // would treat `<segment>.test.ts(x)` as a real route, react-router's type
      // generator would emit a matching `+types/<segment>.test.ts(x)` file under
      // `.react-router/types/`, and vitest would then discover those generated
      // .test.ts files and fail with "No test suite found in file ...".
      ignoredRouteFiles,
    });

export default routes;
