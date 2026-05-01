/**
 * Wire-protocol schemas mapped type — pairs every entry of an
 * {@link RpcProtocol} with its Zod validator.
 *
 * Used by `@taucad/rpc` `Channel` / `ChannelServer` to validate inbound
 * frames at the wire boundary when supplied via `protocolSchemas`.
 *
 * @internal
 */

import type { z } from 'zod';

/**
 * Per-call/per-notify Zod validator map for an `RpcProtocol`-shaped
 * contract. The map's keys mirror the protocol's `calls` and `notifies`
 * inventories exactly; missing entries are surfaced by the
 * `runtime-protocol-schema-coverage.test.ts` conformance test (C15).
 *
 * Authors typically declare a single value (`runtimeProtocolSchemas`)
 * with `as const satisfies WireProtocolSchemas` rather than spelling
 * the generic out, which keeps inference end-to-end.
 *
 * @internal
 */
export type WireProtocolSchemas = {
  readonly calls: Readonly<Record<string, { readonly args: z.ZodTypeAny; readonly result: z.ZodTypeAny }>>;
  readonly notifies: Readonly<Record<string, z.ZodTypeAny>>;
};
