// Make sure to include this route in `routes.ts` & pre-rendering!
import { getLlmText } from '#lib/fumadocs/get-llms-text.js';
import { source } from '#lib/fumadocs/source.js';
import { cacheTag, cdnBackedSsrRouteHeaders } from '#lib/react-router.lib.js';

const runtimeDocsPrefix = '/docs/runtime';

export async function loader(): Promise<Response> {
  const pages = source
    .getPages()
    .filter((page) => page.url === runtimeDocsPrefix || page.url.startsWith(`${runtimeDocsPrefix}/`));
  const scan = pages.map(async (page) => getLlmText(page));
  const scanned = await Promise.all(scan);

  return new Response(scanned.join('\n\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...cdnBackedSsrRouteHeaders(cacheTag.llmsRuntimeFull),
    },
  });
}
