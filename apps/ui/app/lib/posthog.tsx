import type { PostHogConfig } from 'posthog-js';
import { ENV } from '#environment.config.js';

export const posthogConfig: { options: Partial<PostHogConfig>; apiKey: string } = {
  options: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- posthog-js Options
    api_host: '/api/ph',
    // eslint-disable-next-line @typescript-eslint/naming-convention -- posthog-js Options
    ui_host: ENV.POSTHOG_UI_HOST,
    defaults: '2025-11-30',
  },
  // When no API key is set, set an empty string. `use-analytics.tsx` will detect this and not use the analytics provider.
  // This is useful for development and self-hosted configurations.
  apiKey: ENV.POSTHOG_CLIENT_KEY ?? '',
};
