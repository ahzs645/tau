/**
 * Default web-worker entry for `@taucad/runtime`.
 *
 * Composes a {@link KernelRuntimeWorker} with {@link webWorkerHost}
 * to acquire the worker-side `MessagePort` from `self`, wire the
 * dispatcher, and install the crash trap. `webWorkerTransport({})`
 * defaults to this entry — consumers never need to construct a `URL`
 * themselves.
 *
 * Per `library-api-policy.md` §6 (Subpath Exports) and §10 (High-Level
 * Wrappers + Low-Level Escape Hatches): each environment ships its
 * own self-contained subpath so consumers never branch on
 * `typeof Worker` and the runtime core never imports
 * `node:worker_threads`.
 *
 * Per `docs/research/runtime-transport-authoring-simplification.md` (R1):
 * this entry static-imports {@link webWorkerHost} from
 * `#transport/web-worker-host.js`. The host file is the structural
 * sibling of `web-worker-client.ts` (which owns the
 * `new URL('../worker/web.js', import.meta.url)` chunk-emit literal),
 * so the worker chunk never reaches its own chunk-emitter — Rolldown's
 * chunk planner is free to plan the bundle in a single pass.
 *
 * Custom worker entries can compose the same primitives directly:
 *
 * ```typescript
 * import { KernelRuntimeWorker } from '@taucad/runtime/worker-internals';
 * import { webWorkerHost } from '@taucad/runtime/transport/web';
 *
 * const worker = new KernelRuntimeWorker();
 * await webWorkerHost({ worker }).open();
 * ```
 *
 * @public
 */

// oxlint-disable-next-line import-x/no-unassigned-import -- side-effect: stubs `document` before any bundler modulepreload code runs
import '#framework/worker-preload-polyfill.js';

import { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
import { webWorkerHost } from '#transport/web-worker-host.js';

const worker = new KernelRuntimeWorker();
await webWorkerHost({ worker }).open();
