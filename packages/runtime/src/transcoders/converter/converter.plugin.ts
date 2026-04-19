/**
 * Converter transcoder plugin registration.
 *
 * Wraps the converter transcoder module as a TranscoderPlugin for use in
 * RuntimeClient options and presets.
 */

import { createTranscoderPlugin } from '#plugins/plugin-helpers.js';
import { converterEdgeSchemas } from '#transcoders/converter/converter-export-options.js';

/**
 * Create a converter transcoder plugin registration.
 * Enables GLB-to-any-format conversion via the `@taucad/converter` pipeline.
 *
 * The `edges` map carries the compile-time `EdgeMap` phantom so that
 * `client.export('3mf', { unit, application, tessellation, coordinateSystem })`
 * is type-checked against the merged kernel source-format + transcoder edge schema.
 *
 * @public
 *
 * @example <caption>Adding converter transcoding to a runtime client</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { converterTranscoder } from '@taucad/runtime/transcoder';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   transcoders: [converterTranscoder()],
 * });
 * ```
 */
export const converterTranscoder = createTranscoderPlugin({
  id: 'converter',
  moduleUrl: new URL('converter.transcoder.js', import.meta.url).href,
  from: 'glb',
  edges: converterEdgeSchemas,
});
