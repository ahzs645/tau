/* eslint-disable @typescript-eslint/naming-convention -- snake_case is expected for webmanifest */
import type { WebAppManifest } from '@remix-pwa/dev';
import type { LinkDescriptor, LoaderFunctionArgs } from 'react-router';
import { metaConfig } from '#constants/meta.constants.js';

export const webManifestHref = '/manifest.webmanifest';
export const webManifestLinks: LinkDescriptor[] = [{ rel: 'manifest', href: webManifestHref }];

export function loader({ request }: LoaderFunctionArgs): Response {
  const publicBasePath = getPublicBasePath(request.url);

  return Response.json(
    {
      short_name: metaConfig.name,
      name: metaConfig.name,
      description: metaConfig.description,
      orientation: 'portrait',
      start_url: publicBasePath === '' ? '/' : `${publicBasePath}/`,
      display: 'standalone',
      // @see https://developer.mozilla.org/en-US/docs/Web/Manifest/Reference/display_override
      // @ts-expect-error - fullscreen and minimal-ui are available in types, but are legitimate values
      display_override: ['fullscreen', 'minimal-ui'],
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: [
        {
          src: `${publicBasePath}/android-chrome-192x192.png`,
          sizes: '192x192',
          type: 'image/png',
        },
        {
          src: `${publicBasePath}/android-chrome-512x512.png`,
          sizes: '512x512',
          type: 'image/png',
        },
      ],
    } satisfies WebAppManifest,
    {
      headers: {
        'Cache-Control': 'public, max-age=600',
        'Content-Type': 'application/manifest+json',
      },
    },
  );
}

function getPublicBasePath(requestUrl: string): string {
  const { pathname } = new URL(requestUrl);
  const suffix = '/manifest.webmanifest';
  return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : '';
}
