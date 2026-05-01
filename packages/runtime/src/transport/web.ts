/* oxlint-disable no-barrel-files/no-barrel-files -- public topology subpath barrel */

/**
 * Browser-only transport entry — `@taucad/runtime/transport/web`.
 *
 * Hosts {@link webWorkerTransport}, which spawns a dedicated browser
 * `Worker` and acquires its worker-side wire from the worker's global
 * scope (`globalThis.addEventListener('message', …)` /
 * `globalThis.postMessage(…)`). Importing this subpath from a Node
 * bundle pulls in DOM-flavoured runtime calls that have no Node
 * counterpart — Node consumers should reach for
 * `@taucad/runtime/transport/in-process` (same-isolate) or
 * `@taucad/runtime/transport/node` (`worker_threads`) instead.
 *
 * The split mirrors `@taucad/runtime/transport/node` (Node-only) and
 * `@taucad/runtime/transport/in-process` (cross-env): every concrete
 * transport ships behind its own topology-tagged subpath so consumers
 * signal their intent at import time. The universal
 * `@taucad/runtime/transport` barrel intentionally excludes these
 * symbols — it carries only the author API
 * (`defineRuntimeTransport`), wire validators, and types.
 *
 * Per `docs/research/runtime-transport-authoring-simplification.md` (R1),
 * the standalone {@link webWorkerHost} factory is also exported here
 * so custom worker entries can import it without pulling in the
 * client's `new URL(...)` chunk-emit literal.
 *
 * @public
 */

export { webWorkerTransport } from '#transport/web-worker-transport.js';
export type { WebWorkerLike, WebWorkerClientOptions } from '#transport/web-worker-client.js';
export type { WebWorkerHostOptions } from '#transport/web-worker-host.js';
export { webWorkerHost } from '#transport/web-worker-host.js';
export { webWorkerClient } from '#transport/web-worker-client.js';
