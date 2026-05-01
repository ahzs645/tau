/**
 * Worker-side primitives for custom transport authors.
 *
 * Re-exports the value-level primitives a custom
 * {@link RuntimeTransportPlugin} can compose to wire a kernel host
 * onto a wire it owns (Electron `MessagePortMain`,
 * `MessageChannel.port2`, an Ably-style remote channel, etc.).
 *
 * The bundled `@taucad/runtime/worker/web` and
 * `@taucad/runtime/worker/node` subpaths cover every in-tree consumer
 * (browser Web Workers and Node `worker_threads`); reach for this
 * subpath only when neither bundled host fits — for example, an
 * Electron utility process that brokers a `MessagePortMain` from
 * `process.parentPort` and needs to instantiate
 * {@link KernelRuntimeWorker} + {@link createWorkerDispatcher} in its
 * own process boundary.
 *
 * Exposed as a sibling subpath (not from the main `index.ts`) so the
 * default browser-safe entry point never eagerly loads `esbuild-wasm`
 * (transitively pulled in by {@link KernelRuntimeWorker}'s base
 * {@link KernelWorker} bundler integration) — see
 * `library-api-policy.md` §6 (Subpath Exports) and §10 (High-Level
 * Wrappers + Low-Level Escape Hatches).
 *
 * @public
 */

export { KernelRuntimeWorker } from '#framework/kernel-runtime-worker.js';
export { createWorkerDispatcher } from '#transport/_internal/runtime-worker-dispatcher.js';
export { installWorkerCrashTrap } from '#transport/_internal/worker-crash-trap.js';
