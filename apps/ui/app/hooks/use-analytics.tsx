import { PostHogProvider, usePostHog } from 'posthog-js/react';
import type { PostHog } from 'posthog-js/react';
import { useAuthenticate } from '@daveyplate/better-auth-ui';
import { useEffect, useRef } from 'react';
import { posthogConfig } from '#lib/posthog.js';

export type Analytics = PostHog;

export function useAnalytics(): Analytics {
  const posthog = usePostHog();
  return posthog;
}

/**
 * Internal component that handles user identification with PostHog.
 *
 * Following PostHog best practices:
 * - Identifies logged-in users with their unique user ID and person properties
 * - Resets analytics when users log out to unlink future events
 * - Called once per session, with identification on app load and after login
 *
 * @see https://posthog.com/docs/data/identify
 */
function AnalyticsIdentifier({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const analytics = useAnalytics();
  const { user } = useAuthenticate({ enabled: false });
  const previousUserIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const currentUserId = user?.id;
    const previousUserId = previousUserIdRef.current;

    // User logged in or app loaded with authenticated user
    // Identify the user with their unique ID and person properties
    if (currentUserId && currentUserId !== previousUserId) {
      analytics.identify(currentUserId, {
        email: user.email,
        name: user.name,
        // PostHog uses 'avatar' for person profile images
        avatar: user.image,
      });
    }

    // User logged out - reset to unlink future events from this user
    // This is important for shared devices to avoid merging different users
    if (!currentUserId && previousUserId) {
      analytics.reset();
    }

    previousUserIdRef.current = currentUserId;
  }, [analytics, user?.id, user?.email, user?.name, user?.image]);

  return children;
}

export function AnalyticsProvider({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const { options, apiKey } = posthogConfig;

  // When no API key is set, we don't use the analytics provider.
  // This is useful for development and self-hosted configurations.
  // The usePostHog hook safely handles the missing context.
  if (!apiKey) {
    return children;
  }

  return (
    <PostHogProvider options={options} apiKey={apiKey}>
      <AnalyticsIdentifier>{children}</AnalyticsIdentifier>
    </PostHogProvider>
  );
}
