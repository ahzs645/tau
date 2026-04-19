import { createAuthClient } from 'better-auth/react';
import { apiKeyClient, magicLinkClient, usernameClient } from 'better-auth/client/plugins';
import { ENV } from '#environment.config.js';

export const authClient = createAuthClient({
  baseURL: `${ENV.TAU_API_URL}/v1/auth`,
  plugins: [magicLinkClient(), usernameClient(), apiKeyClient()],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
});
