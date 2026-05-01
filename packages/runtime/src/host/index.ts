/**
 * `@taucad/runtime/host` — symmetric host-side surface that mirrors
 * `@taucad/runtime`'s `createRuntimeClient`.
 *
 * Consumers compose a {@link RuntimeHostConfig} (kernels + middleware +
 * transcoders + bundlers + a transport `host`), pass it to
 * {@link createRuntimeHost}, and receive a {@link RuntimeHostHandle}
 * with `dispose()` for symmetric teardown. The transport `host` owns
 * the wire (the `web`/`node` worker subpath entries spawn the
 * dispatcher IIFE that adopts the worker port and the
 * `inProcessTransport.host` is the contract-stub paired with
 * `inProcessTransport({...})`).
 */

export { createRuntimeHost, createRuntimeHostConfig } from '#host/create-runtime-host.js';
export type { RuntimeFileCache, RuntimeHostConfig, RuntimeHostHandle } from '#host/runtime-host.types.js';
