/**
 * `electronUtilityTransport` — bundled Topology C transport (callable plugin).
 *
 * Consume the plugin directly on `createRuntimeClient`:
 *
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 * import { electronUtilityTransport } from './electron-utility-transport.js';
 *
 * const { port1 } = new MessageChannel();
 * const client = createRuntimeClient({
 *   transport: electronUtilityTransport({ port: port1 }),
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 * });
 * ```
 *
 * **Utility-process host**: use standalone {@link electronUtilityHost}; the
 * `MessagePortMain` arrives via `process.parentPort` after main bridges the
 * channel.
 *
 * Architecture and wire constraints match
 * {@link electronUtilityClient} / {@link electronUtilityHost}.
 *
 * @public
 */

import { defineRuntimeTransport } from '@taucad/runtime/transport';

import { electronUtilityClient } from './electron-utility-client.js';
import { electronUtilityHost } from './electron-utility-host.js';
import {
  electronUtilityClientOptionsSchema,
  electronUtilityHostOptionsSchema,
} from './electron-utility-transport.schemas.js';

const electronUtilityId = 'electron-utility';

/** Bundled Electron utility-process transport plugin. */
export const electronUtilityTransport = defineRuntimeTransport({
  id: electronUtilityId,
  clientOptionsSchema: electronUtilityClientOptionsSchema,
  hostOptionsSchema: electronUtilityHostOptionsSchema,
  client: electronUtilityClient,
  host: electronUtilityHost,
});
