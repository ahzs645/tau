import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

/**
 * Config for the gallery poster generator (`thumbnails/generate-thumbnails.spec.ts`).
 * Kept separate from `playwright.config.ts` so `nx run ui-e2e:e2e` never runs the
 * generator, and the generator renders serially with generous kernel timeouts.
 */

const baseURL = process.env['BASE_URL'] ?? 'http://localhost:3000';
const isCi = Boolean(process.env['CI']);
/** Escape hatch for sandboxes that ship a system Chromium instead of Playwright's own build. */
const chromiumExecutablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];

export default defineConfig({
  ...nxE2EPreset(fileURLToPath(import.meta.url), { testDir: './thumbnails' }),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {}),
  },
  webServer: {
    // Same production server the e2e suite uses; geometry renders entirely
    // client-side, so the stubbed endpoint env vars are never hit.
    command: 'pnpm exec nx run ui:serve',
    env: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_API_URL: 'http://localhost:4000',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_WEBSOCKET_URL: 'ws://localhost:4001',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      TAU_FRONTEND_URL: 'http://localhost:3000',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- env var keys
      NODE_ENV: 'production',
    },
    url: baseURL,
    reuseExistingServer: !isCi,
    cwd: workspaceRoot,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
