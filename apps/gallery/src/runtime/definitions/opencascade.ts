import { assimp } from '@taucad/assimp';
import { esbuild } from '@taucad/esbuild';
import { middleware } from '@taucad/middleware';
import { opencascade } from '@taucad/opencascade';
import { defineRuntime } from '@taucad/runtime/worker';

export const runtime = defineRuntime({
  plugins: [
    opencascade({ kernels: { default: { wasm: 'full' } } }),
    esbuild(),
    assimp(),
    middleware({ preset: 'cache' }),
  ],
});
