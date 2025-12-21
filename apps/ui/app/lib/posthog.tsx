import type { PostHogConfig } from 'posthog-js';
import { PostHogProvider } from 'posthog-js/react';
import { ENV } from '#config.js';

export const getPosthogConfig = (): { options: Partial<PostHogConfig>; apiKey: string } => {
  return {
    options: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- posthog-js Options
      api_host: '/api/ph',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- posthog-js Options
      ui_host: ENV.POSTHOG_UI_HOST,
      defaults: '2025-11-30',
    },
    apiKey: ENV.POSTHOG_CLIENT_KEY,
  };
};

