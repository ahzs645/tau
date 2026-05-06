/**
 * Static kernel id → source extensions map for Monaco language warm-up.
 *
 * Kept free of runtime value imports so SSR and `MonacoModelServiceProvider`
 * never pull the kernel/plugin graph. The `KernelId` union below is derived
 * from `defaultKernels` via `typeof import(...)` (a type-only expression that
 * is fully erased at compile time), which forces this map to stay aligned
 * with `kernel-worker.constants.ts` at the type level — adding/removing a
 * kernel without updating this map fails `tsc` instead of CI.
 */
import { supportedImportFormats } from '@taucad/converter/formats';
import type { defaultKernels } from '#constants/kernel-worker.constants.js';

type KernelId = (typeof defaultKernels)[number]['id'];

export const kernelSourceExtensionsById = {
  openscad: ['scad'],
  zoo: ['kcl'],
  replicad: ['ts', 'js'],
  opencascade: ['ts', 'js'],
  manifold: ['ts', 'js'],
  jscad: ['ts', 'js'],
  tau: supportedImportFormats,
} as const satisfies Record<KernelId, readonly string[]>;
