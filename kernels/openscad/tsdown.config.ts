import { defineConfig } from 'tsdown';
import type { Options } from 'tsdown';

const baseConfig: Options = {
  entry: ['src/index.ts', 'src/openscad.kernel.ts'],
  sourcemap: false,
  clean: true,
  dts: true,
  minify: true,
  copy: (options) => [
    {
      from: 'src/fonts',
      to: `${options.outDir}/fonts`,
    },
    {
      from: 'src/bosl2-library.generated.json.gz',
      to: `${options.outDir}/bosl2-library.generated.json.gz`,
    },
  ],
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
