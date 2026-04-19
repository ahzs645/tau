/**
 * OpenSCAD kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, and module URL resolution.
 * OpenSCAD tessellation maps to native $fn/$fa/$fs parameters.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import { openscadRenderSchema, openscadExportSchemas } from '#kernels/openscad/openscad.schemas.js';

/**
 * Create an OpenSCAD kernel plugin registration.
 *
 * @public
 */
export const openscad = createKernelPlugin({
  id: 'openscad',
  moduleUrl: new URL('openscad.kernel.js', import.meta.url).href,
  extensions: ['scad'],
  renderSchema: openscadRenderSchema,
  exportSchemas: openscadExportSchemas,
});
