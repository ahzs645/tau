import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/gallery-runtime-test',
  test: {
    environment: 'node',
    include: ['src/runtime/classic/**/*.integration.test.ts'],
    reporters: ['default'],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
