/**
 * Generic transferable scanner for the v6 channel wire layer.
 *
 * The channel client extracts `WithTransferables.transferables` and hands
 * them to `port.postMessage(envelope, transferables)` so they cross the
 * structured-clone boundary by reference. When a transport bridges a port
 * across a worker / Electron / process seam, the inbound `MessageEvent.data`
 * already has any transferred handles materialised inside the envelope
 * payload, so the transport has to walk the structure to recover them
 * before posting onward. This walker is the single source of truth for that
 * recovery — transports never decode protocol shapes themselves.
 *
 * The walker recognises the two transferable categories the runtime
 * carries today:
 *
 * - `MessagePort` — embedded in `initialize` / FS bridge handoffs.
 * - `ArrayBuffer` — embedded in geometry / export delivery.
 *
 * `SharedArrayBuffer` is intentionally excluded: SABs are shared, not
 * transferred, so they ride the wire as ordinary clone references with
 * no transferables-list ceremony.
 *
 * Lives under `transport/_internal/` because it is wire-layer plumbing
 * consumed exclusively by transport implementations.
 *
 * @internal
 */

/**
 * Detect any DOM `MessagePort` or Node `worker_threads` `MessagePort`
 * instance via a structural sniff — `globalThis.MessagePort` is absent
 * in Node and `node:worker_threads` is async-loaded, so an `instanceof`
 * check is unreliable across environments.
 */
function isMessagePortLike(value: Record<string, unknown>): boolean {
  const candidate = value as { postMessage?: unknown; addEventListener?: unknown; on?: unknown; close?: unknown };
  if (typeof candidate.postMessage !== 'function' || typeof candidate.close !== 'function') {
    return false;
  }
  return typeof candidate.addEventListener === 'function' || typeof candidate.on === 'function';
}

/**
 * Walk an opaque envelope payload looking for transferable handles.
 *
 * The walker is bounded: it recurses into arrays and plain objects, but
 * stops at primitive values, typed-array views, `Date`, `Map`, `Set`,
 * and `SharedArrayBuffer`. Cycles are detected via a visited-set so
 * cyclic payloads (rare on the wire) cannot diverge.
 *
 * @param value - the inbound envelope (typically `WireMessage` or its
 *   payload subtree); accepted as `unknown` because runners do not
 *   decode protocol shapes.
 * @returns the recovered transferables, in iteration order.
 *
 * @public
 */
export function collectWireTransferables(value: unknown): Transferable[] {
  const transferables: Transferable[] = [];
  const visited = new WeakSet<Record<string, unknown>>();

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    const object = node as Record<string, unknown>;
    if (visited.has(object)) {
      return;
    }
    visited.add(object);

    if (isMessagePortLike(object)) {
      transferables.push(object as unknown as Transferable);
      return;
    }
    if (object instanceof ArrayBuffer) {
      transferables.push(object);
      return;
    }
    if (
      ArrayBuffer.isView(object) ||
      object instanceof SharedArrayBuffer ||
      object instanceof Date ||
      object instanceof Map ||
      object instanceof Set
    ) {
      return;
    }
    if (Array.isArray(object)) {
      for (const item of object) {
        walk(item);
      }
      return;
    }
    for (const item of Object.values(object)) {
      walk(item);
    }
  };

  walk(value);
  return transferables;
}
