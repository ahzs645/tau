// Make sure to include this route in `routes.ts` & pre-rendering!
import { metaConfig } from '#constants/meta.constants.js';
import { ENV } from '#environment.config.js';
import { getLlmRefText } from '#lib/fumadocs/get-llms-text.js';
import { cacheTag, cdnBackedSsrRouteHeaders } from '#lib/react-router.lib.js';

const runtimeDocsPrefix = '/docs/runtime';

export async function loader(): Promise<Response> {
  const content = await getLlmRefText({
    siteTitle: `${metaConfig.name} Runtime Documentation`,
    siteUrl: ENV.TAU_FRONTEND_URL,
    pathPrefix: runtimeDocsPrefix,
  });

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...cdnBackedSsrRouteHeaders(cacheTag.llmsRuntimeIndex),
    },
  });
}
