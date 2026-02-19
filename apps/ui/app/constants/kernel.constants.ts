import type { KernelConfig, MiddlewareConfig } from '@taucad/types';
import tauKernelModuleUrl from '#components/geometry/kernel/tau/tau.kernel.js?url';
import replicadKernelModuleUrl from '#components/geometry/kernel/replicad/replicad.kernel.js?url';
import jscadKernelModuleUrl from '#components/geometry/kernel/jscad/jscad.kernel.js?url';
import openscadKernelModuleUrl from '#components/geometry/kernel/openscad/openscad.kernel.js?url';
import zooKernelModuleUrl from '#components/geometry/kernel/zoo/zoo.kernel.js?url';
import parameterCacheUrl from '#components/geometry/kernel/middleware/parameter-cache.middleware.js?url';
import geometryCacheUrl from '#components/geometry/kernel/middleware/geometry-cache.middleware.js?url';
import gltfCoordinateTransformUrl from '#components/geometry/kernel/middleware/gltf-coordinate-transform.middleware.js?url';
import gltfEdgeDetectionUrl from '#components/geometry/kernel/middleware/gltf-edge-detection.middleware.js?url';
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
 *   { id: 'manifold', kernelModuleUrl: manifoldKernelUrl },
 * ];
 * ```
 */
export const defaultKernelConfig: KernelConfig = [
  { id: 'openscad', extensions: ['scad'], kernelModuleUrl: openscadKernelModuleUrl },
  {
    id: 'zoo',
    extensions: ['kcl'],
    options: { baseUrl: `${ENV.TAU_WEBSOCKET_URL}/v1/kernels/zoo` },
    kernelModuleUrl: zooKernelModuleUrl,
  },
  {
    id: 'replicad',
    extensions: ['ts', 'js'],
    detectImport: /import.*from\s+['"]replicad['"]/s,
    options: {
      withExceptions: false,
      meshConfiguration: { linearTolerance: 0.1, angularTolerance: 0.1 },
    },
    kernelModuleUrl: replicadKernelModuleUrl,
  },
  {
    id: 'jscad',
    extensions: ['ts', 'js'],
    detectImport: /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/,
    kernelModuleUrl: jscadKernelModuleUrl,
  },
  { id: 'tau', extensions: ['*'], kernelModuleUrl: tauKernelModuleUrl },
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
export const defaultMiddlewareConfig: MiddlewareConfig = [
  { url: parameterCacheUrl },
  { url: geometryCacheUrl },
  { url: gltfCoordinateTransformUrl },
  { url: gltfEdgeDetectionUrl },
];
