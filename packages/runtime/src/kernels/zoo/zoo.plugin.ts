/**
 * Zoo (KCL) kernel plugin registration.
 *
 * Encapsulates all kernel metadata: id, extensions, and module URL resolution.
 */

import { createKernelPlugin } from '#plugins/plugin-helpers.js';
import { zooOptionsSchema, zooExportSchemas } from '#kernels/zoo/zoo.schemas.js';

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
export const zoo = createKernelPlugin({
  id: 'zoo',
  moduleUrl: new URL('zoo.kernel.js', import.meta.url).href,
  extensions: ['kcl'],
  optionsSchema: zooOptionsSchema,
  exportSchemas: zooExportSchemas,
});
