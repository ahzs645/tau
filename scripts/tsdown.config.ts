import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';
import type { Options } from 'tsdown';

const cliConfig: Options = {
  entry: { repos: 'src/repos/repos.ts' },
  format: 'esm',
  outDir: 'dist',
  platform: 'node',
  clean: true,
  dts: false,
  minify: false,
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  outputOptions: {
    inlineDynamicImports: true,
  },
};

const tuiConfig: Options = {
  entry: { 'repos-tui': 'src/repos/repos-tui.ts' },
  format: 'esm',
  outDir: 'dist',
  platform: 'node',
  clean: false,
  dts: false,
  minify: false,
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
  noExternal: [/.*/],
  alias: {
    'react-devtools-core': resolve(import.meta.dirname, 'src/repos/stubs/react-devtools-core.ts'),
  },
  outputOptions: {
    inlineDynamicImports: true,
  },
};

export default defineConfig([cliConfig, tuiConfig]);
