import { defineConfig } from 'tsdown';
import type { Options } from 'tsdown';

const baseConfig: Options = {
  entry: [
    'src/workspace-path-resolver.ts',
    'src/path-subscriber-registry.ts',
    'src/visibility-provider.ts',
    'src/refresh-generation-guard.ts',
    'src/worker-change-channel.ts',
    'src/file-write-source.ts',
    'src/file-system-client.ts',
    'src/file-content-errors.ts',
    'src/seems-binary.ts',
    'src/file-content-service.ts',
    'src/file-tree-service.ts',
  ],
  sourcemap: false,
  clean: true,
  dts: true,
  minify: true,
  tsconfig: 'tsconfig.build.json',
  unbundle: true,
};

const cjsConfig: Options = {
  ...baseConfig,
  format: 'cjs',
  outDir: 'dist/cjs',
  dts: false,
};

const esmConfig: Options = {
  ...baseConfig,
  format: 'esm',
  outDir: 'dist/esm',
};

export default defineConfig([esmConfig, cjsConfig]);
