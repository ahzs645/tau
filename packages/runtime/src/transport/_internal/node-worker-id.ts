/**
 * Single source of truth for the node-worker transport id literal.
 *
 * The literal lives in its own module so the host file
 * (`node-worker-host.ts`) and the client file (`node-worker-client.ts`)
 * can share the constant without either pulling in the other. Per
 * `docs/research/runtime-transport-authoring-simplification.md` (R2),
 * the structural break between client and host is the gate that lets
 * Rolldown plan the Node worker chunk without re-entering the
 * chunk-emitter file.
 *
 * @internal
 */

export const nodeWorkerId = 'node-worker';

/** Literal type alias for `nodeWorkerId`. */
export type NodeWorkerId = typeof nodeWorkerId;
