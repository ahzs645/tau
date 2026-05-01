/**
 * Projection helpers — extract phantom-tagged generics from a
 * {@link TransportPlugin} returned by bundled transport factories
 * (`typeof webWorkerTransport extends (opts) => TransportPlugin`) without
 * repeating type parameters at the consumer surface.
 *
 * Pattern mirrors the `KernelPlugin` projections in
 * `#plugins/plugin-types.js` (`CollectKernelIds`, `RenderOptionsFor`).
 *
 * @public
 */

import type { RpcProtocol } from '@taucad/rpc';
import type { TransportPlugin, _TransportBindingsExtraSlot } from '#transport/runtime-transport.types.js';

// oxlint-disable @typescript-eslint/no-explicit-any -- variance: phantom slot projection

/** */
type TransportCallable = (...args: any[]) => TransportPlugin<any, any, any>;

/**
 * Extract the literal transport id carried by {@link TransportPlugin}.
 *
 * @public
 */
export type TransportPluginId<P extends TransportPlugin<any, any, any>> =
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- phantom slot inference
  P extends TransportPlugin<any, any, infer Id> ? Id : never;

/**
 * Extract the literal `Id` from a bundled transport callable
 * (`webWorkerTransport({...})`).
 *
 * @public
 */
export type TransportId<F extends TransportCallable> =
  ReturnType<F> extends TransportPlugin<any, any, infer Id> ? Id : never;

/**
 * Extract the protocol carried by the bundled transport callable.
 *
 * @public
 */
export type TransportProtocol<F extends TransportCallable> =
  ReturnType<F> extends TransportPlugin<infer P, any, any> ? P : RpcProtocol;

/**
 * Extract the host-side bindings extension shape.
 *
 * @public
 */
export type TransportBindingsExtra<F extends TransportCallable> =
  ReturnType<F> extends TransportPlugin<any, infer B, any> ? B : Readonly<Record<never, never>>;

/**
 * Extract the consumer options shape accepted by `transport(...)`.
 *
 * @public
 */
export type TransportClientOptions<F extends TransportCallable> = F extends (
  options: infer O,
) => TransportPlugin<any, any, any>
  ? O
  : Readonly<Record<string, unknown>>;

/**
 * Host options projected from a standalone host factory
 * `(options) => {@link RuntimeTransportHost}` — not from the bundled
 * client callable (use alongside `typeof webWorkerHost`).
 *
 * @public
 */
export type TransportHostOptions<H extends (options: any) => any> =
  /* oxlint-disable-next-line @typescript-eslint/no-explicit-any -- generic host factory arity */
  H extends (options: infer O) => any ? O : Readonly<Record<string, unknown>>;

// oxlint-enable @typescript-eslint/no-explicit-any

/* Re-export the phantom slot type alias so conformance tests satisfy
 * structural compatibility checks against {@link TransportPlugin}. */
export type { _TransportBindingsExtraSlot };

export { type _TransportIdSlot, type _TransportProtocolSlot } from '#transport/runtime-transport.types.js';
