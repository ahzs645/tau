/**
 * Best-in-class fast-path tiers a {@link Port} adapter declares to the channel layer.
 *
 * The dispatcher walks the ladder `pool → transfer → copy` for binary delivery (geometry,
 * export bytes) and `signalSlot + wire → wire-only` for cooperative abort, gating each
 * faster path on the capability bit. Adapters never lie: `wrapMessagePort` declares
 * `{ transfer: true }`, a `node:worker_threads` adapter declares
 * `{ sab: true, signalSlot: true, transfer: true }`, a `BroadcastChannel` adapter declares `{}`.
 * The `pool` bit is set by the worker after pool construction and exchanged via the `lh`
 * hello payload — never at adapter-construction time.
 *
 * @public
 */
export type PortCapabilities = {
  /** Adapter can share `SharedArrayBuffer` references across the boundary. */
  readonly sab?: boolean;
  /** Adapter exposes a SAB cancellation slot the producer can `Atomics.store` into. */
  readonly signalSlot?: boolean;
  /** Adapter honours the second argument of `postMessage` for zero-copy `Transferable` hoist. */
  readonly transfer?: boolean;
  /** Both sides of the adapter share a SAB-backed pool for delivery-by-reference. */
  readonly pool?: boolean;
};

/**
 * Minimal bidirectional postMessage port, generic over the message payload shape.
 * Adapters map DOM `MessagePort`, Electron `MessagePortMain`, and similar APIs to this type.
 *
 * @public
 */
export type Port<T> = {
  /** Capability set declared by the adapter. Consumers consult this to pick a delivery tier. */
  readonly capabilities: PortCapabilities;
  postMessage(data: T, transfer?: readonly Transferable[]): void;
  /**
   * Register an inbound message handler. Returns an unsubscribe that is safe to call multiple times.
   */
  onMessage(handler: (data: T) => void): () => void;
  /**
   * Optional: DOM `MessagePort` requires `start()` on the receiving side before events flow.
   */
  start?(): void;
  close(): void;
};

type AnyMessagePort = {
  // oxlint-disable-next-line typescript/no-explicit-any -- intentionally accept DOM MessagePort and node:worker_threads MessagePort
  postMessage(data: any, transfer?: any): void;
  // oxlint-disable-next-line typescript/no-explicit-any -- DOM uses EventListener, node uses (msg) => void
  addEventListener(type: 'message', listener: any, options?: any): void;
  // oxlint-disable-next-line typescript/no-explicit-any -- mirror of addEventListener
  removeEventListener(type: 'message', listener: any, options?: any): void;
  start?(): void;
  close(): void;
};

/**
 * Adapts a standard WHATWG `MessagePort` (or compatible Node `worker_threads` port) to {@link Port}.
 *
 * @param port - The port to wrap (typically from `new MessageChannel()` or `messageChannel.port2`).
 * @param options - `label` is only used for `close` error messages.
 * @returns A {@link Port} bound to the given `MessagePort`.
 * @public
 */
export const wrapMessagePort = <T>(port: AnyMessagePort, options?: { label?: string }): Port<T> => {
  const label = options?.label ?? 'MessagePort';
  return {
    capabilities: { transfer: true },
    postMessage(data: T, transfer?: readonly Transferable[]): void {
      port.postMessage(data, transfer);
    },
    onMessage(handler: (data: T) => void): () => void {
      const listener = (event: { data: T }): void => {
        handler(event.data);
      };
      port.addEventListener('message', listener);
      return () => {
        port.removeEventListener('message', listener);
      };
    },
    start(): void {
      port.start?.();
    },
    close(): void {
      try {
        port.close();
      } catch (error) {
        throw new Error(`${label} close failed`, { cause: error });
      }
    },
  };
};
