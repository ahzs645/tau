/**
 * Single source of truth for the web-worker transport id literal.
 *
 * The literal lives in its own module so the host file
 * (`web-worker-host.ts`) and the client file (`web-worker-client.ts`)
 * can share the constant without either pulling in the other. Per
 * `docs/research/runtime-transport-authoring-simplification.md` (R1),
 * the structural break between client and host is the gate that lets
 * Rolldown plan the worker chunk without re-entering the chunk-emitter
 * file.
 *
 * @internal
 */

export const webWorkerId = 'web-worker';

/** Literal type alias for `webWorkerId`. */
export type WebWorkerId = typeof webWorkerId;
