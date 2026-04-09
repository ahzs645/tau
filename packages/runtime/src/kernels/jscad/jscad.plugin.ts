/**
 * JSCAD kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, detect pattern,
 * builtin module names, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';

/**
 * Canonical regex for detecting @jscad/modeling usage in source code.
 *
 * Branches: ESM import, CJS require.
 * @public
 */
export const jscadDetectPattern =
  /import\s+.*from\s+["']@jscad\/modeling(\/[^"']*)?["']|require\s*\(\s*["']@jscad\/modeling(\/[^"']*)?["']\s*\)/;

/**
 * Create a JSCAD kernel plugin registration.
 *
 * @public
 */
export const jscad = createKernelPlugin({
  id: 'jscad',
  moduleUrl: new URL('jscad.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: jscadDetectPattern,
  builtinModuleNames: ['@jscad/modeling'],
});
