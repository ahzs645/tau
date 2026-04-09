/**
 * Manifold kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, detect pattern,
 * builtin module names, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import type { ManifoldOptions } from '#kernels/manifold/manifold.kernel.js';

/**
 * Canonical regex for detecting manifold-3d usage in source code.
 *
 * Branches: ESM import, CJS require, dynamic import().
 * @public
 */
export const manifoldDetectPattern =
  /import\s+.*from\s+["']manifold-3d(?:\/[^"']*)?["']|require\s*\(\s*["']manifold-3d(?:\/[^"']*)?["']\s*\)|import\s*\(\s*["']manifold-3d(?:\/[^"']*)?["']\s*\)/;

/**
 * Create a Manifold kernel plugin registration.
 *
 * @public
 */
export const manifold = createKernelPlugin<ManifoldOptions>({
  id: 'manifold',
  moduleUrl: new URL('manifold.kernel.js', import.meta.url).href,
  extensions: ['ts', 'js'],
  detectImport: manifoldDetectPattern,
  builtinModuleNames: ['manifold-3d', 'manifold-3d/manifoldCAD'],
});
