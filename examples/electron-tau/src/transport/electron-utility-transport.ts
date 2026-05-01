/**
 * `electronUtilityTransport` — bundled Topology C transport (callable plugin).
 *
 * Consume the plugin directly on `createRuntimeClient`:
 *
 * ```typescript
 * createRuntimeClient({
 *   ...
 *   transport: electronUtilityTransport({ port }),
 * })
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

/** */
export const electronUtilityTransport = defineRuntimeTransport({
  id: electronUtilityId,
  clientOptionsSchema: electronUtilityClientOptionsSchema,
  hostOptionsSchema: electronUtilityHostOptionsSchema,
  client: electronUtilityClient,
  host: electronUtilityHost,
});

export type { ElectronUtilityClientOptions, ElectronUtilityHostOptions } from './electron-utility-transport.schemas.js';

export { electronUtilityClient, electronUtilityClientDescribe } from './electron-utility-client.js';
export { electronUtilityHost } from './electron-utility-host.js';
