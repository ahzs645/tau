/**
 * Consumer-facing kernel plugin factory functions.
 * Each factory returns a KernelPlugin registration object with resolved module URL.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';

/**
 * Custom WASM configuration for injecting non-standard builds at runtime.
 * Primarily used for Node.js tooling (benchmarks, CI) via `file://` URLs.
 *
 * @example
 * ```typescript
 * replicad({
 *   wasm: {
 *     wasmUrl: 'file:///path/to/replicad_single.wasm',
 *     wasmBindingsUrl: 'file:///path/to/replicad_single.js',
 *   },
 * })
 * ```
 */
type ReplicadWasmConfig = {
  /** Absolute URL to the `.wasm` binary (typically `file://` in Node.js). */
  wasmUrl: string;
  /** Absolute URL to the Emscripten JS glue module (typically `file://` in Node.js). */
  wasmBindingsUrl: string;
};

/**
 * Replicad kernel options.
 */
export type ReplicadOptions = {
  /**
   * WASM build variant or custom build configuration.
   *
   * - `'single'` (default) -- compact build (~17 MB), OC errors abort rather than throw
   * - `'single-exceptions'` -- exceptions-enabled build (~20 MB) with human-readable OC error messages
   * - `ReplicadWasmConfig` -- custom WASM/JS URLs for runtime injection (Node.js tooling)
   *
   * @example
   * ```typescript
   * replicad()                                          // default: 'single'
   * replicad({ wasm: 'single-exceptions' })               // exceptions variant
   * replicad({ wasm: { wasmUrl, wasmBindingsUrl } })    // custom build
   * ```
   *
   * @default 'single'
   */
  wasm?: 'single' | 'single-exceptions' | ReplicadWasmConfig;
  /** OC API call tracing mode. 'summary' (default) emits aggregated stats, 'per-call' emits individual spans. */
  ocTracing?: 'off' | 'summary' | 'per-call';
  /** Include Boundary Representation (BRep) edge lines in the generated GLTF geometry. Defaults to `false`. */
  withBrepEdges?: boolean;
  /** Load library source maps for enriched error stack traces. Adds ~50ms to init. Defaults to `false`. */
  withSourceMapping?: boolean;
};

/**
 * Zoo (KCL) kernel options.
 */
export type ZooOptions = {
  /** WebSocket base URL for the Zoo engine connection. Defaults to 'wss://api.zoo.dev'. */
  baseUrl?: string;
};

/**
 * Manifold kernel options.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Manifold currently exposes no runtime options
export type ManifoldOptions = {};

/**
 * Create a Replicad kernel plugin registration.
 * Replicad is an OpenCASCADE-based parametric CAD kernel.
 *
 * @example
 * ```typescript
 * replicad()                                          // single WASM (~17 MB)
 * replicad({ wasm: 'single-exceptions' })               // exceptions WASM (~20 MB)
 * replicad({ wasm: { wasmUrl, wasmBindingsUrl } })    // custom build injection
 * ```
 */
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('../kernels/replicad/replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import.*from\s+['"]replicad['"]/s,
  builtinModuleNames: ['replicad'],
});

/**
 * Create a Zoo (KCL) kernel plugin registration.
 * Zoo connects to the Zoo engine via WebSocket for KCL language support.
 *
 * @example
 * ```typescript
 * zoo({ baseUrl: 'wss://my-server/v1/kernels/zoo' })
 * ```
 */
export const zoo = createKernelPlugin<ZooOptions>({
  id: 'zoo',
  moduleUrl: new URL('../kernels/zoo/zoo.kernel.js', import.meta.url).href,
  extensions: ['kcl'],
});

/**
 * Create an OpenSCAD kernel plugin registration.
 *
 * @example
 * ```typescript
 * openscad()
 * ```
 */
export const openscad = createKernelPlugin({
  id: 'openscad',
  moduleUrl: new URL('../kernels/openscad/openscad.kernel.js', import.meta.url).href,
  extensions: ['scad'],
});

/**
 * Create a JSCAD kernel plugin registration.
 *
 * @example
 * ```typescript
 * jscad()
 * ```
 */
export const jscad = createKernelPlugin({
  id: 'jscad',
  moduleUrl: new URL('../kernels/jscad/jscad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/,
  builtinModuleNames: ['@jscad/modeling'],
});

/**
 * Create a Manifold kernel plugin registration.
 *
 * @example
 * ```typescript
 * manifold()
 * ```
 */
export const manifold = createKernelPlugin<ManifoldOptions>({
  id: 'manifold',
  moduleUrl: new URL('../kernels/manifold/manifold.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import\s+.*from\s+['"]manifold-3d(\/[^'"]*)?['"]/,
  builtinModuleNames: ['manifold-3d', 'manifold-3d/manifoldCAD'],
});

/**
 * Create a Tau converter kernel plugin registration.
 * Tau is the catch-all kernel that handles STEP, STL, 3MF, and other import formats.
 *
 * @example
 * ```typescript
 * tau()
 * ```
 */
export const tau = createKernelPlugin({
  id: 'tau',
  moduleUrl: new URL('../kernels/tau/tau.kernel.js', import.meta.url).href,
  extensions: ['*'],
});
