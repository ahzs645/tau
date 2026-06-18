import type { LazyKernelOptionsFactory } from '#types/runtime-client.alias.js';

/**
 * Lazy-resolve default editor kernel options after the file manager is ready.
 * Keeps `kernel-worker.constants` (heavy runtime graph) out of the SSR eager set.
 */
export const defaultKernelOptions: LazyKernelOptionsFactory = async () => {
  const { createDefaultKernelOptions } = await import('#constants/kernel-worker.constants.js');
  return createDefaultKernelOptions;
};

/**
 * Lazy-resolve debug kernel options (enriched replicad stack traces).
 */
export const debugKernelOptions: LazyKernelOptionsFactory = async () => {
  const { createDebugKernelOptions } = await import('#constants/kernel-worker.constants.js');
  return createDebugKernelOptions;
};

/**
 * Lazy-resolve playground preview kernel options.
 * Omits expensive GLTF edge detection; playground exports still use the kernel export path.
 */
export const playgroundPreviewKernelOptions: LazyKernelOptionsFactory = async () => {
  const { createPlaygroundPreviewKernelOptions } = await import('#constants/kernel-worker.constants.js');
  return createPlaygroundPreviewKernelOptions;
};
