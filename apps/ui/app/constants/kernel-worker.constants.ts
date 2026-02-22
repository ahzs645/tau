import type { KernelConfig, MiddlewareConfig, BundlerConfig } from '@taucad/types';
import { createDefaultConfig } from '@taucad/kernels';
import { ENV } from '#environment.config.js';

const baseConfig = createDefaultConfig({
  kernels: {
    zoo: { options: { baseUrl: `${ENV.TAU_WEBSOCKET_URL}/v1/kernels/zoo` } },
    replicad: {
      options: {
        withExceptions: false,
        meshConfiguration: { linearTolerance: 0.1, angularTolerance: 0.1 },
      },
    },
  },
});

/**
 * Default kernel configuration optimized for fast previews.
 *
 * Replicad runs with `withExceptions: false` for faster execution.
 * Use `debugKernelConfig` in the editor for detailed error feedback.
 *
 * Array order defines `canHandle` priority -- the first kernel whose worker
 * reports it can handle a file wins.
 */
export const defaultKernelConfig: KernelConfig = baseConfig.kernelConfig;

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

/**
 * Default middleware configuration for all kernel workers.
 *
 * Order determines onion-model wrapping (first = outermost):
 * 1. ParameterCache -- caches getParameters results
 * 2. GeometryCache -- checks/writes geometry cache
 * 3. GltfCoordinateTransform -- Y-up/meters -> Z-up/mm
 * 4. GltfEdgeDetection -- adds edge primitives for sharp edge rendering
 *
 * Edge detection is innermost so coordinate transform can transform both
 * mesh and edge primitives on the return journey.
 */
export const defaultMiddlewareConfig: MiddlewareConfig = baseConfig.middlewareConfig;

/**
 * Default bundler configuration.
 *
 * The esbuild bundler handles JS/TS files for kernels that need bundling
 * (replicad, jscad). Non-JS kernels (OpenSCAD, KCL, Tau) resolve dependencies
 * internally and never invoke the bundler.
 */
export const defaultBundlerConfig: BundlerConfig = baseConfig.bundlerConfig;

/**
 * Runtime worker URL for creating new Worker instances.
 */
export const runtimeWorkerUrl = baseConfig.workerUrl;
