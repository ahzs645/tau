import { assimp } from '@taucad/assimp';
import { middleware } from '@taucad/middleware';
import { openrscad } from '@taucad/openrscad';
import { defineRuntime } from '@taucad/runtime/worker';

export const runtime = defineRuntime({ plugins: [openrscad(), assimp(), middleware({ preset: 'cache' })] });
