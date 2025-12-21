import type { Route } from './+types/route.js';
import { getEnvironment } from '#environment.config.js';
import { metaConfig } from '#constants/meta.constants.js';

/**
 * Proxy route for GitHub avatar images.
 * Fetches avatars from GitHub with proper authentication and caching.
 *
 * Usage: /api/github-avatar?user=username
 *    or: /api/github-avatar?org=orgname
 *    or: /api/github-avatar?id=12345 (user ID)
 */
export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url);
  const user = url.searchParams.get('user');
  const org = url.searchParams.get('org');
  const userId = url.searchParams.get('id');
  const size = url.searchParams.get('size') ?? '64';

  // Build the avatar URL based on provided parameters
  let avatarUrl: string;

  if (userId) {
    // Direct user ID
    avatarUrl = `https://avatars.githubusercontent.com/u/${encodeURIComponent(userId)}?v=4&s=${size}`;
  } else if (user) {
    // Username
    avatarUrl = `https://github.com/${encodeURIComponent(user)}.png?size=${size}`;
  } else if (org) {
    // Organization
    avatarUrl = `https://github.com/${encodeURIComponent(org)}.png?size=${size}`;
  } else {
    return new Response('Missing required parameter: user, org, or id', { status: 400 });
  }

  // Prepare headers
  const headers = new Headers();
  headers.set('User-Agent', metaConfig.userAgent);
  headers.set('Accept', 'image/*');

  // Add GitHub authentication if available (helps with rate limiting)
  try {
    const environment = await getEnvironment();
    if (environment.GITHUB_API_TOKEN) {
      headers.set('Authorization', `Bearer ${environment.GITHUB_API_TOKEN}`);
    }
  } catch {
    // Environment not available, continue without auth
  }

  try {
    const response = await fetch(avatarUrl, {
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      // Return a transparent 1x1 PNG as fallback
      return new Response(null, {
        status: 404,
        headers: {
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    // Get the image data
    const imageData = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') ?? 'image/png';

    // Return with caching headers
    return new Response(imageData, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        'Content-Length': imageData.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('Failed to fetch GitHub avatar:', error);
    return new Response(null, {
      status: 502,
      headers: {
        'Cache-Control': 'public, max-age=60',
      },
    });
  }
}
