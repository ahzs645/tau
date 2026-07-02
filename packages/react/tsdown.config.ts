import { defineConfig } from 'tsdown';
import type { Options } from 'tsdown';

const baseConfig: Options = {
  entry: [
    'src/index.ts',
    'src/components/geometry/parameters/parameters.tsx',
    'src/components/geometry/parameters/parameters-number.tsx',
    'src/components/geometry/parameters/rjsf-theme.tsx',
    'src/components/geometry/parameters/rjsf-utils.ts',
    'src/components/geometry/parameters/rjsf-context.ts',
    'src/components/ui/tooltip.tsx',
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
