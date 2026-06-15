import { describe, expect, it } from 'vitest';
import { loader } from '#routes/manifest[.webmanifest].js';

describe('webmanifest route', () => {
  it('uses root-relative asset paths for root deployments', async () => {
    const manifest = await loadManifest('https://tau.test/manifest.webmanifest');

    expect(manifest.start_url).toBe('/');
    expect(manifest.icons[0]?.src).toBe('/android-chrome-192x192.png');
    expect(manifest.icons[1]?.src).toBe('/android-chrome-512x512.png');
  });

  it('uses basename-relative asset paths for GitHub Pages deployments', async () => {
    const manifest = await loadManifest('https://3dd.ahmadjalil.com/tau/manifest.webmanifest');

    expect(manifest.start_url).toBe('/tau/');
    expect(manifest.icons[0]?.src).toBe('/tau/android-chrome-192x192.png');
    expect(manifest.icons[1]?.src).toBe('/tau/android-chrome-512x512.png');
  });
});

async function loadManifest(url: string): Promise<{
  start_url: string;
  icons: Array<{ src: string }>;
}> {
  const response = loader({
    request: new Request(url),
    params: {},
    context: {},
  } as Parameters<typeof loader>[0]);

  return (await response.json()) as {
    start_url: string;
    icons: Array<{ src: string }>;
  };
}
