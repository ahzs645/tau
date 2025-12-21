import { PostHogProvider, usePostHog } from 'posthog-js/react';
import type { PostHog } from 'posthog-js/react';
import { getPosthogConfig } from '#lib/posthog.js';

export type Analytics = PostHog;

export function useAnalytics(): Analytics {
  const posthog = usePostHog();
  return posthog;
}

export function AnalyticsProvider({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const { options, apiKey } = getPosthogConfig();

  // When no API key is set, we don't use the analytics provider.
  // This is useful for development and self-hosted configurations.
  if (!apiKey) {
    console.debug('No `POSTHOG_CLIENT_KEY` key set, skipping analytics provider');
    return children;
  }

  return (
    <PostHogProvider options={options} apiKey={apiKey}>
      {children}
    </PostHogProvider>
  );
}
