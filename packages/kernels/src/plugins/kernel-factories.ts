/**
 * Consumer-facing kernel plugin factory functions.
 * Each factory returns a KernelPlugin registration object with resolved module URL.
 */

import type { KernelPlugin } from '#plugins/plugin-types.js';

/**
 * Replicad kernel options.
 */
export type ReplicadOptions = {
  /** Enable OpenCASCADE exception messages for detailed error feedback. Slower when enabled. */
  withExceptions?: boolean;
  /** OC API call tracing mode. 'summary' (default) emits aggregated stats, 'per-call' emits individual spans. */
  ocTracing?: 'off' | 'summary' | 'per-call';
};

/**
 * Create a Replicad kernel plugin registration.
 *
 * @param options - Optional Replicad-specific configuration
 * @returns KernelPlugin for Replicad (OpenCASCADE-based parametric CAD)
 *
 * @example
 * ```typescript
 * replicad({ withExceptions: true })
 * ```
 */
export function replicad(options?: ReplicadOptions): KernelPlugin {
  return {
    id: 'replicad',
    moduleUrl: new URL('../kernels/replicad/replicad.kernel.js', import.meta.url).href,
    extensions: ['ts', 'js'],
    detectImport: /import.*from\s+['"]replicad['"]/s,
    builtinModuleNames: ['replicad'],
    options: options as Record<string, unknown> | undefined,
  };
}

/**
 * Zoo (KCL) kernel options.
 */
export type ZooOptions = {
  /** WebSocket base URL for the Zoo engine connection. */
  baseUrl: string;
};

/**
 * Create a Zoo (KCL) kernel plugin registration.
 *
 * @param options - Zoo-specific configuration (requires baseUrl)
 * @returns KernelPlugin for Zoo (KCL language)
 *
 * @example
 * ```typescript
 * zoo({ baseUrl: 'wss://my-server/v1/kernels/zoo' })
 * ```
 */
export function zoo(options?: ZooOptions): KernelPlugin {
  return {
    id: 'zoo',
    moduleUrl: new URL('../kernels/zoo/zoo.kernel.js', import.meta.url).href,
    extensions: ['kcl'],
    options: options as Record<string, unknown> | undefined,
  };
}

/**
 * Create an OpenSCAD kernel plugin registration.
 *
 * @returns KernelPlugin for OpenSCAD (.scad files)
 *
 * @example
 * ```typescript
 * openscad()
 * ```
 */
export function openscad(): KernelPlugin {
  return {
    id: 'openscad',
    moduleUrl: new URL('../kernels/openscad/openscad.kernel.js', import.meta.url).href,
    extensions: ['scad'],
  };
}

/**
 * Create a JSCAD kernel plugin registration.
 *
 * @returns KernelPlugin for JSCAD (@jscad/modeling)
 *
 * @example
 * ```typescript
 * jscad()
 * ```
 */
export function jscad(): KernelPlugin {
  return {
    id: 'jscad',
    moduleUrl: new URL('../kernels/jscad/jscad.kernel.js', import.meta.url).href,
    extensions: ['ts', 'js'],
    detectImport: /import\s+.*from\s+['"]@jscad\/modeling(\/[^'"]*)?['"]/,
    builtinModuleNames: ['@jscad/modeling'],
  };
}

/**
 * Create a Tau converter kernel plugin registration.
 * Tau is the catch-all kernel that handles STEP, STL, 3MF, and other import formats.
 *
 * @returns KernelPlugin for Tau (catch-all converter)
 *
 * @example
 * ```typescript
 * tau()
 * ```
 */
export function tau(): KernelPlugin {
  return {
    id: 'tau',
    moduleUrl: new URL('../kernels/tau/tau.kernel.js', import.meta.url).href,
    extensions: ['*'],
  };
}
