/**
 * OpenSCAD kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';

/**
 * Create an OpenSCAD kernel plugin registration.
 *
 * @public
 */
export const openscad = createKernelPlugin({
  id: 'openscad',
  moduleUrl: new URL('openscad.kernel.js', import.meta.url).href,
  extensions: ['scad'],
});
