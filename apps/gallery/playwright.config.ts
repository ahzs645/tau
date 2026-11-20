import { defineConfig, devices } from 'playwright/test';

const port = Number(process.env['GALLERY_TEST_PORT'] ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('GALLERY_TEST_PORT must be a valid TCP port.');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: '../../out/test-results/gallery',
  reporter: [['list'], ['html', { outputFolder: '../../out/reports/gallery/browser', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: {
      executablePath: process.env['CHROMIUM_EXECUTABLE_PATH'],
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    // A plain server deliberately provides no COOP/COEP headers or SPA fallback:
    // this exercises the exact static files and isolation model used by Pages.
    command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory apps/gallery/dist`,
    url: `http://127.0.0.1:${port}`,
    cwd: '../..',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
