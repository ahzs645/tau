import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  plugins: [nxViteTsPaths()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.spec.json',
      ignoreSourceErrors: true,
    },
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/packages/react',
      include: ['src/**/*'],
      exclude: ['src/**/*.{test,spec,test-d}.{ts,tsx}'],
      // The hooks keep the original 100% bar. The component tree extracted from
      // apps/ui arrives with its existing (non-exhaustive) test suite; hold it
      // at the global floor below and ratchet upward.
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- vitest per-path threshold keys are globs
        'src/hooks/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
