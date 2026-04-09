/**
 * OpenCascade kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, detect pattern,
 * builtin module names, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import type { OpenCascadeOptions } from '#kernels/opencascade/opencascade.kernel.js';

/**
 * Canonical regex for detecting opencascade.js usage in source code.
 * The module specifier is always 'opencascade.js' (the .js suffix is required).
 *
 * Branches: ESM import, CJS require.
 * @public
 */
export const opencascadeDetectPattern =
  /import.*from\s+["']opencascade\.js["']|require\s*\(\s*["']opencascade\.js["']\s*\)/s;

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
  moduleUrl: new URL('opencascade.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: opencascadeDetectPattern,
  builtinModuleNames: ['opencascade.js'],
});
