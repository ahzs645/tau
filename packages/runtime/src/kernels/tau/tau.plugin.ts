/**
 * Tau converter kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, and module URL resolution.
 * Uses the converter's format list for explicit extension matching.
 */

import { supportedImportFormats } from '@taucad/converter/formats';
import { createKernelPlugin } from '#plugins/plugin-helpers.js';

/**
 * Create a Tau converter kernel plugin registration.
 * Tau handles STEP, STL, 3MF, and other import formats via the converter pipeline.
 *
 * @public
 */
export const tau = createKernelPlugin({
  id: 'tau',
  moduleUrl: new URL('tau.kernel.js', import.meta.url).href,
  extensions: [...supportedImportFormats],
});
