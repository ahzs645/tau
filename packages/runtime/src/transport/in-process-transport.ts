/**
 * Bundled in-process transport.
 *
 * Same V8 isolate; no wire crossing — a *passthrough* transport in the
 * `definePassthroughTransport` sense. The live client logic lives in
 * {@link inProcessClient}.
 *
 * @public
 */

import { definePassthroughTransport } from '#transport/define-runtime-transport.js';
import { inProcessClient } from '#transport/in-process-client.js';
import { inProcessClientOptionsSchema } from '#transport/in-process-transport.schemas.js';

/**
 * Bundled in-process transport.
 *
 * Importable from the cross-environment subpath
 * `@taucad/runtime/transport/in-process` — the package root and
 * `@taucad/runtime/transport` barrel intentionally exclude this
 * symbol so every concrete transport ships behind its own
 * topology-tagged import path.
 *
 * @public
 *
 * @example <caption>Spin up an in-process kernel for tests</caption>
 * ```typescript
 * import { createRuntimeClient, presets } from '@taucad/runtime';
 * import { inProcessTransport } from '@taucad/runtime/transport/in-process';
 * import { fromMemoryFs } from '@taucad/runtime/filesystem';
 *
 * const client = createRuntimeClient({
 *   ...presets.all(),
 *   transport: inProcessTransport({
 *     fileSystem: fromMemoryFs({ '/main.ts': 'export default () => "hi";' }),
 *   }),
 * });
 * ```
 */
export const inProcessTransport = definePassthroughTransport({
  id: 'in-process',
  clientOptionsSchema: inProcessClientOptionsSchema,
  client: inProcessClient,
});

export type { InProcessClientOptions } from '#transport/in-process-client.js';

export { inProcessClient, inProcessClientDescribe } from '#transport/in-process-client.js';
