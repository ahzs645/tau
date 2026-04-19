/**
 * Preset configurations for zero-config kernel setup.
 */

import type { KernelPlugin, MiddlewarePlugin, BundlerPlugin, TranscoderPlugin } from '#plugins/plugin-types.js';
import { replicad, opencascade, zoo, openscad, jscad, manifold, tau } from '#plugins/kernel-factories.js';
import {
  parameterCache,
  geometryCache,
  gltfCoordinateTransform,
  gltfEdgeDetection,
} from '#plugins/middleware-factories.js';
import { esbuild } from '#plugins/bundler-factories.js';
import { converterTranscoder } from '#plugins/transcoder-factories.js';

/**
 * Client options shape returned by preset functions.
 * Contains the full set of plugins required to configure a runtime client.
 * @public
 */
export type PresetOptions = {
  /** Kernel plugins that handle specific CAD file formats and languages */
  kernels: KernelPlugin[];
  /** Middleware plugins that intercept and transform kernel operations */
  middleware: MiddlewarePlugin[];
  /** Bundler plugins that handle code bundling and execution */
  bundlers: BundlerPlugin[];
  /** Transcoder plugins for bytes-to-bytes format conversion */
  transcoders: TranscoderPlugin[];
};

/**
 * Preset configurations for common use cases.
 *
 * @public
 */
export const presets = {
  /**
   * All built-in kernels, middleware, and bundlers.
   * Zero-config default for consumers who want everything.
   *
   * @returns Complete client options with all plugins
   *
   * @example <caption>Zero-config full setup</caption>
   * ```typescript
   * import { createRuntimeClient, presets } from '@taucad/runtime';
   *
   * const client = createRuntimeClient(presets.all());
   * ```
   */
  // oxlint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- intentional: rely on inference so per-kernel/per-transcoder phantom generics survive into `createRuntimeClient`. An explicit `PresetOptions` return type would widen `kernels`/`transcoders` to the erased `KernelPlugin[]`/`TranscoderPlugin[]` aliases and break `CollectFormatMap`/`MergeExportMap` typesafety on `client.export(...)`.
  all() {
    return {
      kernels: [openscad(), zoo(), replicad(), opencascade(), manifold(), jscad(), tau()],
      middleware: [parameterCache(), geometryCache(), gltfCoordinateTransform(), gltfEdgeDetection()],
      bundlers: [esbuild()],
      transcoders: [converterTranscoder()],
    };
  },
};
