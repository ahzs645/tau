/**
 * Preset configurations for zero-config kernel setup.
 */

import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin } from '#plugins/plugin-types.js';
import { replicad, zoo, openscad, jscad, tau } from '#plugins/kernel-factories.js';
import {
  parameterCache,
  geometryCache,
  gltfCoordinateTransform,
  gltfEdgeDetection,
} from '#plugins/middleware-factories.js';
import { esbuild } from '#plugins/bundler-factories.js';

/**
 * Client options shape for presets.
 */
export type PresetOptions = {
  kernels: KernelPlugin[];
  middleware: MiddlewarePlugin[];
  bundlers: BundlerPlugin[];
};

/**
 * Preset configurations for common use cases.
 */
export const presets = {
  /**
   * All built-in kernels, middleware, and bundlers.
   * Zero-config default for consumers who want everything.
   *
   * @returns Complete client options with all plugins
   *
   * @example
   * ```typescript
   * import { createKernelClient, presets } from '@taucad/kernels';
   * const client = createKernelClient(presets.all());
   * ```
   */
  all(): PresetOptions {
    return {
      kernels: [openscad(), zoo(), replicad(), jscad(), tau()],
      middleware: [parameterCache(), geometryCache(), gltfCoordinateTransform(), gltfEdgeDetection()],
      bundlers: [esbuild()],
    };
  },
};
