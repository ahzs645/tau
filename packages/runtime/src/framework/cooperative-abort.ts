/**
 * Cooperative Abort Mechanism — INTERNAL kernel-side primitive.
 *
 * Provides a SharedArrayBuffer-based abort signal that kernel proxies (e.g. the
 * OC Proxy in replicad) check before every WASM API call. When the abort
 * generation in the SAB no longer matches the generation set at render start,
 * `checkAbort()` throws a {@link RenderAbortedError} to unwind the synchronous
 * WASM call stack.
 *
 * Lifecycle:
 * 1. `setAbortContext(view, generation)` — called by `KernelWorker.executeRender`
 *    before handing control to the kernel.
 * 2. Kernel proxy calls `checkAbort()` on every API call (~1 ns overhead).
 * 3. `clearAbortContext()` — called in the `finally` block of `executeRender`.
 *
 * Not part of the `@taucad/runtime` public surface. Kernel authors must import
 * from `#framework/cooperative-abort.js` only when implementing a custom kernel
 * proxy. End-user `RuntimeClient` consumers never touch these helpers — abort
 * signalling is an internal worker-side concern.
 *
 * @internal
 */

import { RenderAbortedError } from '#framework/runtime-worker-client.js';
import { signalSlot } from '#types/runtime-protocol.types.js';

let abortSignalView: Int32Array | undefined;
let abortGeneration = 0;

/**
 * Configure the abort context before starting a render cycle.
 * The proxy checks this before every OC call (~1ns overhead per call).
 *
 * @internal
 *
 * @param view - Int32Array view over the shared signal buffer
 * @param generation - current render generation (must match to continue)
 */
export function setAbortContext(view: Int32Array, generation: number): void {
  abortSignalView = view;
  abortGeneration = generation;
}

/**
 * Clear the abort context after a render cycle completes or is aborted.
 * @internal
 */
export function clearAbortContext(): void {
  abortSignalView = undefined;
  abortGeneration = 0;
}

/**
 * Check whether the current render has been aborted.
 * Throws {@link RenderAbortedError} when the SAB abort generation no longer
 * matches the generation stored by `setAbortContext`.
 * @internal
 */
export function checkAbort(): void {
  if (abortSignalView && Atomics.load(abortSignalView, signalSlot.abortGeneration) !== abortGeneration) {
    throw new RenderAbortedError();
  }
}
