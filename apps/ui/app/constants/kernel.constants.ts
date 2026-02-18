import type { KernelConfig } from '@taucad/types';
import replicadWorkerUrl from '#components/geometry/kernel/replicad/replicad.worker.js?url';
import openscadWorkerUrl from '#components/geometry/kernel/openscad/openscad.worker.js?url';
import zooWorkerUrl from '#components/geometry/kernel/zoo/zoo.worker.js?url';
import tauWorkerUrl from '#components/geometry/kernel/tau/tau.worker.js?url';
import jscadWorkerUrl from '#components/geometry/kernel/jscad/jscad.worker.js?url';
import { ENV } from '#environment.config.js';

/**
 * Default kernel configuration optimized for fast previews.
 *
 * Replicad runs with `withExceptions: false` for faster execution.
 * Use `debugKernelConfig` in the editor for detailed error feedback.
 *
 * Array order defines `canHandle` priority -- the first kernel whose worker
 * reports it can handle a file wins. Append entries to extend with third-party
 * kernels, or spread and filter to customize.
 *
 * @example Adding a third-party kernel
 * ```ts
 * import { defaultKernelConfig } from '#constants/kernel-workers.js';
 *
 * const extendedConfig: KernelConfig = [
 *   ...defaultKernelConfig,
 *   { id: 'manifold', url: manifoldWorkerUrl },
 * ];
 * ```
 */
export const defaultKernelConfig: KernelConfig = [
  { id: 'openscad', url: openscadWorkerUrl },
  { id: 'zoo', url: zooWorkerUrl, options: { baseUrl: `${ENV.TAU_WEBSOCKET_URL}/v1/kernels/zoo` } },
  {
    id: 'replicad',
    url: replicadWorkerUrl,
    options: {
      withExceptions: false,
      meshConfiguration: { linearTolerance: 0.1, angularTolerance: 0.1 },
    },
  },
  { id: 'jscad', url: jscadWorkerUrl },
  { id: 'tau', url: tauWorkerUrl },
];

/**
 * Debug kernel configuration for the editor.
 *
 * Identical to default but enables `withExceptions: true` on replicad
 * for detailed OpenCASCADE error messages during interactive editing.
 * Slower than the default -- only use where rich error feedback matters.
 */
export const debugKernelConfig: KernelConfig = defaultKernelConfig.map((entry) =>
  entry.id === 'replicad' ? { ...entry, options: { ...entry.options, withExceptions: true } } : entry,
);
