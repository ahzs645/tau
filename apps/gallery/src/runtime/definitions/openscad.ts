import { assimp } from '@taucad/assimp';
import { middleware } from '@taucad/middleware';
import { defineRuntime } from '@taucad/runtime/worker';
import { classicOpenScad } from '#runtime/classic/kernel.js';

export const runtime = defineRuntime({
  kernels: [classicOpenScad()],
  plugins: [assimp(), middleware({ preset: 'cache' })],
});
