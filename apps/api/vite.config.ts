import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { VitePluginNode as vitePluginNode } from 'vite-plugin-node';
import { corsBaseConfiguration } from '#constants/cors.constant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test';

  return {
    root: __dirname,
    cacheDir: '../../node_modules/.vite/apps/api',
    build: {
      outDir: 'dist',
    },
    server: {
      // Vite server configs, for details see [vite doc](https://vitejs.dev/config/#server-host)
      port: Number(process.env.PORT),
      cors: {
        origin: [process.env.TAU_FRONTEND_URL],
        ...corsBaseConfiguration,
      },
    },
    plugins: [
      nxViteTsPaths(),
      viteStaticCopy({
        targets: [
          {
            src: 'app/database/migrations/**/*',
            dest: 'migrations',
          },
        ],
      }),
      ...(isTest
        ? []
        : [
            vitePluginNode({
              adapter: 'nest',
              appPath: './app/main.ts',
              outputFormat: 'module',
              exportName: 'viteNodeApp',
              initAppOnBoot: true,
            }),
          ]),
    ],
    optimizeDeps: {
      // Vite does not work well with optionnal dependencies,
      // mark them as ignored for now
      exclude: [
        // May need to list dependencies here, e.g.:
        // '@nestjs/microservices',
      ],
    },
    test: {
      env: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
        NODE_ENV: 'test',
      },
      environment: 'node',
      typecheck: {
        enabled: true,
        include: ['**/*.test-d.ts'],
        tsconfig: './tsconfig.spec.json',
        ignoreSourceErrors: true,
      },
      setupFiles: ['./vitest.setup.ts'],
      reporter: ['verbose'], // Ensure detailed test output
      coverage: {
        provider: 'v8',
        reportsDirectory: '../../coverage/apps/api',
        include: ['app/**/*'],
        exclude: ['app/**/*.{test,spec}.ts', 'app/main.ts'],
      },
    },
  };
});
