/**
 * Replicad kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, detect pattern,
 * builtin module names, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import {
  replicadOptionsSchema,
  replicadRenderSchema,
  replicadExportSchemas,
} from '#kernels/replicad/replicad.schemas.js';

/**
 * Canonical regex for detecting replicad usage in source code.
 *
 * Branches: ESM import, CJS require, destructured global, JSDoc typedef, CDN import.
 * @public
 */
export const replicadDetectPattern =
  /import.*from\s+["']replicad["']|\bconst\s*{\s*[\s\w,]*}\s*=\s*replicad\s*;|require\s*\(\s*["']replicad["']\s*\)|@typedef.*import\s*\(\s*["']replicad["']\s*\)|import.*from\s+["']https?:\/\/[^"']*replicad[^"']*["']/s;

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
export const replicad = createKernelPlugin({
  id: 'replicad',
  moduleUrl: new URL('replicad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: replicadDetectPattern,
  builtinModuleNames: ['replicad'],
  optionsSchema: replicadOptionsSchema,
  renderSchema: replicadRenderSchema,
  exportSchemas: replicadExportSchemas,
});
