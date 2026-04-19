import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/api-integration',
  plugins: [nxViteTsPaths()],
  test: {
    environment: 'node',
    include: ['app/testing/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    reporters: ['verbose'],
    env: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
      NODE_ENV: 'test',
    },
  },
});
