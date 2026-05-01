import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

const baseURL = process.env['BASE_URL'] ?? 'http://localhost:3000';
const isCi = Boolean(process.env['CI']);

export default defineConfig({
  ...nxE2EPreset(fileURLToPath(import.meta.url), { testDir: './src' }),

  timeout: 60_000,
  retries: isCi ? 2 : 0,

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },

  use: {
    baseURL,
    actionTimeout: 10_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  webServer: {
    /* Boots the production React Router server (`apps/ui/server.ts`) under
     * `NODE_ENV=production` after a fresh build. `TAU_DEBUG=true` flips on
     * the diagnostic panel below the preview "Downloads" section so e2e
     * specs can scrape `bbox-*` / `count-*` / `asset-*` testids — the same
     * surface the Electron suite consumes.
     *
     * Endpoint env vars are stubbed to localhost defaults; the e2e flow
     * never hits the API (geometry is computed entirely client-side via
     * the web-worker transport). */
    command: 'pnpm exec nx run ui:serve',
    env: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_DEBUG: 'true',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_API_URL: 'http://localhost:4000',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_WEBSOCKET_URL: 'ws://localhost:4001',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_FRONTEND_URL: 'http://localhost:3000',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      NODE_ENV: 'production',
    },
    url: 'http://localhost:3000',
    reuseExistingServer: !isCi,
    cwd: workspaceRoot,
    timeout: 180_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
});
