/**
 * Consumer-facing kernel plugin factory functions.
 * Each factory returns a KernelPlugin registration object with resolved module URL.
 *
 * Option types are co-located with their kernel implementations and re-exported here.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import type { ReplicadOptions } from '#kernels/replicad/replicad.kernel.js';
import type { OpenCascadeOptions } from '#kernels/opencascade/opencascade.kernel.js';
import type { ZooOptions } from '#kernels/zoo/zoo.kernel.js';
import type { ManifoldOptions } from '#kernels/manifold/manifold.kernel.js';

/**
 * Create a Replicad kernel plugin registration.
 * Replicad is an OpenCASCADE-based parametric CAD kernel.
 *
 * @public
 *
 * @example <caption>Default WASM build</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 * });
 * ```
 *
 * @example <caption>Custom WASM build</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad({ wasm: { wasmUrl: '/custom/oc.wasm', wasmBindingsUrl: '/custom/oc.js' } })],
 *   bundlers: [esbuild()],
 * });
 * ```
 */
export const replicad = createKernelPlugin<ReplicadOptions>({
  id: 'replicad',
  moduleUrl: new URL('../kernels/replicad/replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import.*from\s+["']replicad["']/s,
  builtinModuleNames: ['replicad'],
});

/**
 * Create an OpenCascade kernel plugin registration.
 * OpenCascade provides direct access to the OpenCASCADE API without the Replicad abstraction.
 *
 * @public
 *
 * @example <caption>Custom WASM build</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { opencascade } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [opencascade({ wasm: { wasmUrl: '/custom/oc.wasm', wasmBindingsUrl: '/custom/oc.js' } })],
 *   bundlers: [esbuild()],
 * });
 * ```
 */
export const opencascade = createKernelPlugin<OpenCascadeOptions>({
  id: 'opencascade',
  moduleUrl: new URL('../kernels/opencascade/opencascade.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import.*from\s+["']opencascade\.js["']/s,
  builtinModuleNames: ['opencascade.js'],
});

/**
 * Create a Zoo (KCL) kernel plugin registration.
 * Zoo connects to the Zoo engine via WebSocket for KCL language support.
 *
 * @public
 *
 * @example <caption>WebSocket-based KCL kernel</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { zoo } from '@taucad/runtime/kernels';
 *
 * const client = createRuntimeClient({
 *   kernels: [zoo({ baseUrl: 'wss://api.zoo.dev/ws' })],
 *   bundlers: [],
 * });
 * ```
 */
export const zoo = createKernelPlugin<ZooOptions>({
  id: 'zoo',
  moduleUrl: new URL('../kernels/zoo/zoo.kernel.js', import.meta.url).href,
  extensions: ['kcl'],
});

/**
 * Create an OpenSCAD kernel plugin registration.
 * @public
 */
export const openscad = createKernelPlugin({
  id: 'openscad',
  moduleUrl: new URL('../kernels/openscad/openscad.kernel.js', import.meta.url).href,
  extensions: ['scad'],
});

/**
 * Create a JSCAD kernel plugin registration.
 * @public
 */
export const jscad = createKernelPlugin({
  id: 'jscad',
  moduleUrl: new URL('../kernels/jscad/jscad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import\s+.*from\s+["']@jscad\/modeling(\/[^"']*)?["']/,
  builtinModuleNames: ['@jscad/modeling'],
});

/**
 * Create a Manifold kernel plugin registration.
 * @public
 */
export const manifold = createKernelPlugin<ManifoldOptions>({
  id: 'manifold',
  moduleUrl: new URL('../kernels/manifold/manifold.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: /import\s+.*from\s+["']manifold-3d(\/[^"']*)?["']/,
  builtinModuleNames: ['manifold-3d', 'manifold-3d/manifoldCAD'],
});

/**
 * Create a Tau converter kernel plugin registration.
 * Tau is the catch-all kernel that handles STEP, STL, 3MF, and other import formats.
 * @public
 */
export const tau = createKernelPlugin({
  id: 'tau',
  moduleUrl: new URL('../kernels/tau/tau.kernel.js', import.meta.url).href,
  extensions: ['*'],
});
