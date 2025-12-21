import { PostHogProvider, usePostHog } from 'posthog-js/react';
import type { PostHog } from 'posthog-js/react';
import { posthogConfig } from '#lib/posthog.js';

export type Analytics = PostHog;

export function useAnalytics(): Analytics {
  const posthog = usePostHog();
  return posthog;
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
      {children}
    </PostHogProvider>
  );
}
