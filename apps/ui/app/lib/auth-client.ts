import { createAuthClient } from 'better-auth/react';
import { apiKeyClient, magicLinkClient, usernameClient } from 'better-auth/client/plugins';
import { ENV } from '#environment.config.js';

// Tolerate `TAU_API_URL` missing during the React Router prerender pass: that build
// step imports the SSR bundle in Node where `process.env.TAU_API_URL` may be unset
// (e.g. CI runners), and `createAuthClient` rejects an undefined `baseURL`. The
// browser bundle always reads the real value from `window.ENV.TAU_API_URL` injected
// by the root loader, and prerender never invokes any auth methods, so the
// placeholder URL is unreachable at runtime.
const apiBaseURL = ENV.TAU_API_URL ?? 'http://localhost:4000';

export const authClient = createAuthClient({
  baseURL: `${apiBaseURL}/v1/auth`,
  plugins: [magicLinkClient(), usernameClient(), apiKeyClient()],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
});
