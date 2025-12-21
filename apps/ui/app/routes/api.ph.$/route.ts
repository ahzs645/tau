import type { Route } from './+types/route.js';
import { getEnvironment } from '#environment.config.js';

/**
 * Proxy route for PostHog analytics.
 * Forwards requests to PostHog API and asset servers while preserving client anonymity.
 *
 * Routes:
 *   - /api/ph/* → PostHog API (us.i.posthog.com)
 *   - /api/ph/static/* → PostHog assets (us-assets.i.posthog.com)
 */

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  return posthogProxy(request);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return posthogProxy(request);
}

const extractHostname = (host: string): string => {
  // Handle both "hostname.com" and "https://hostname.com" formats
  if (host.includes('://')) {
    return new URL(host).hostname;
  }

  return host;
};

const posthogProxy = async (request: Request): Promise<Response> => {
  const environment = await getEnvironment();
  const url = new URL(request.url);
  const rawHost = url.pathname.startsWith('/api/ph/static/')
    ? environment.POSTHOG_ASSET_HOST
    : environment.POSTHOG_API_HOST;

  const hostname = extractHostname(rawHost);

  const newUrl = new URL(url);
  newUrl.protocol = 'https';
  newUrl.hostname = hostname;
  newUrl.port = '443';
  // Remove the expected `/api/ph` prefix to forward to PostHog's root path
  newUrl.pathname = newUrl.pathname.replace(/^\/api\/ph/, '');

  const headers = new Headers(request.headers);
  headers.set('host', hostname);
  headers.delete('accept-encoding');

  const response = await fetch(newUrl, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required for streaming request bodies
    duplex: 'half',
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');

  const data = await response.arrayBuffer();

  return new Response(data, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};
