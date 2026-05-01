/* oxlint-disable no-barrel-files/no-barrel-files -- composition file: re-exports paired client/host types from sibling files */

/**
 * Bundled web-worker transport — composition file.
 *
 * Hosts the kernel inside a dedicated browser `Worker`. The transport
 * advertises the highest-tier wire (SAB-backed memory, signal-slot
 * abort, transferable / pooled geometry) on its descriptor and exposes
 * the canonical fat handles through paired `client` / `host` factories.
 *
 * Per `docs/research/runtime-transport-authoring-simplification.md` (R1),
 * the client factory (and its `new URL('../worker/web.js', ...)`
 * chunk-emit literal) live in `web-worker-client.ts`, and the host
 * factory lives in `web-worker-host.ts`. This file is the *only*
 * place that imports both — the worker entry chunk
 * (`@taucad/runtime/worker/web`) static-imports `webWorkerHost`
 * directly to keep the chunk-emitter file structurally outside its
 * own transitive graph.
 *
 * @public
 *
 * @example <caption>Defaulted bundled worker (recommended)</caption>
 * ```typescript
 * import { createRuntimeClient, fromMemoryFs } from '@taucad/runtime';
 * import { webWorkerTransport } from '@taucad/runtime/transport/web';
 * import { replicad } from '@taucad/runtime/kernels';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   transport: webWorkerTransport({
 *     fileSystem: fromMemoryFs(),
 *   }),
 * });
 * ```
 *
 * @example <caption>Custom worker module — pass an explicit URL</caption>
 * ```typescript
 * import { createRuntimeClient, fromMemoryFs } from '@taucad/runtime';
 * import { webWorkerTransport } from '@taucad/runtime/transport/web';
 * import { replicad } from '@taucad/runtime/kernels';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   transport: webWorkerTransport({
 *     url: new URL('./custom-worker.ts', import.meta.url),
 *     fileSystem: fromMemoryFs(),
 *   }),
 * });
 * ```
 */

import { defineRuntimeTransport } from '#transport/define-runtime-transport.js';
import { webWorkerClientOptionsSchema, webWorkerHostOptionsSchema } from '#transport/web-worker-transport.schemas.js';
import { webWorkerId } from '#transport/_internal/web-worker-id.js';
import { webWorkerClient } from '#transport/web-worker-client.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

export type { WebWorkerLike, WebWorkerClientOptions } from '#transport/web-worker-client.js';
export type { WebWorkerHostOptions } from '#transport/web-worker-host.js';

/**
 * Bundled web-worker transport plugin (`webWorkerTransport`). Pairs
 * {@link webWorkerClient} and {@link webWorkerHost} via
 * {@link defineRuntimeTransport} so consumers can pass the result to
 * `createRuntimeClient` / `createRuntimeHost` directly.
 *
 * @public
 */
export const webWorkerTransport = defineRuntimeTransport({
  id: webWorkerId,
  clientOptionsSchema: webWorkerClientOptionsSchema,
  hostOptionsSchema: webWorkerHostOptionsSchema,
  client: webWorkerClient,
  host: webWorkerHost,
});
