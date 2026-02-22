import type { KernelConfig, MiddlewareConfig, BundlerConfig } from '@taucad/types';

export type DefaultConfigOptions = {
  kernels?: {
    replicad?: { enabled?: boolean; options?: Record<string, unknown> };
    jscad?: { enabled?: boolean };
    openscad?: { enabled?: boolean };
    zoo?: { enabled?: boolean; options?: Record<string, unknown> };
    tau?: { enabled?: boolean };
  };
  middleware?: {
    parameterCache?: { enabled?: boolean };
    geometryCache?: { enabled?: boolean };
    gltfCoordinateTransform?: { enabled?: boolean };
    gltfEdgeDetection?: { enabled?: boolean };
  };
};

export type DefaultConfigResult = {
  workerUrl: string;
  kernelConfig: KernelConfig;
  middlewareConfig: MiddlewareConfig;
  bundlerConfig: BundlerConfig;
};

/**
 * Create a default kernel configuration with self-resolving module URLs.
 *
 * All URLs resolve relative to this module's location in the built package
 * using the `new URL('./path', import.meta.url)` pattern. This works across
 * all modern bundlers (Vite, webpack 5, Rollup, esbuild) and Node.js without
 * any bundler plugins.
 *
 * @see https://web.dev/articles/bundling-non-js-resources#universal_pattern
 */
export function createDefaultConfig(options?: DefaultConfigOptions): DefaultConfigResult {
  const workerUrl = new URL('framework/kernel-runtime-worker.js', import.meta.url).href;

  type KernelEntry = {
    id: string;
    extensions: string[];
    kernelModuleUrl: string;
    detectImport?: RegExp;
    builtinModuleNames?: string[];
    options?: Record<string, unknown>;
  };

  const allKernels: KernelEntry[] = [
    {
      id: 'openscad',
      extensions: ['scad'],
      kernelModuleUrl: new URL('kernels/openscad/openscad.kernel.js', import.meta.url).href,
    },
    {
      id: 'zoo',
      extensions: ['kcl'],
      options: options?.kernels?.zoo?.options,
      kernelModuleUrl: new URL('kernels/zoo/zoo.kernel.js', import.meta.url).href,
    },
    {
      id: 'replicad',
      extensions: ['ts', 'js'],
      detectImport: /import.*from\s+['"]replicad['"]/s,
      builtinModuleNames: ['replicad'],
      options: options?.kernels?.replicad?.options,
      kernelModuleUrl: new URL('kernels/replicad/replicad.kernel.js', import.meta.url).href,
    },
    {
      id: 'jscad',
      extensions: ['ts', 'js'],
      detectImport: /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/,
      builtinModuleNames: ['@jscad/modeling'],
      kernelModuleUrl: new URL('kernels/jscad/jscad.kernel.js', import.meta.url).href,
    },
    {
      id: 'tau',
      extensions: ['*'],
      kernelModuleUrl: new URL('kernels/tau/tau.kernel.js', import.meta.url).href,
    },
  ];

  const kernelConfig: KernelConfig = allKernels.filter(
    (entry) => options?.kernels?.[entry.id as keyof NonNullable<DefaultConfigOptions['kernels']>]?.enabled !== false,
  );

  type MiddlewareEntry = { id: string; url: string };
  const allMiddleware: MiddlewareEntry[] = [
    { id: 'parameterCache', url: new URL('middleware/parameter-cache.middleware.js', import.meta.url).href },
    { id: 'geometryCache', url: new URL('middleware/geometry-cache.middleware.js', import.meta.url).href },
    {
      id: 'gltfCoordinateTransform',
      url: new URL('middleware/gltf-coordinate-transform.middleware.js', import.meta.url).href,
    },
    { id: 'gltfEdgeDetection', url: new URL('middleware/gltf-edge-detection.middleware.js', import.meta.url).href },
  ];

  const middlewareConfig: MiddlewareConfig = allMiddleware
    .filter(
      (entry) =>
        options?.middleware?.[entry.id as keyof NonNullable<DefaultConfigOptions['middleware']>]?.enabled !== false,
    )
    .map(({ url }) => ({ url }));

  const bundlerConfig: BundlerConfig = [
    {
      bundlerModuleUrl: new URL('bundler/esbuild.bundler.js', import.meta.url).href,
      extensions: ['ts', 'js', 'tsx', 'jsx'],
    },
  ];

  return { workerUrl, kernelConfig, middlewareConfig, bundlerConfig };
}
