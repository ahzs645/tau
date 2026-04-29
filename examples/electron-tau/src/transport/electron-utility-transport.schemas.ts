/**
 * Zod schemas for {@link electronUtilityTransport} options.
 *
 * - `electronUtilityClientOptionsSchema` — supplied to `transport.client(...)`
 *   from the renderer; carries the renderer-received `MessagePort`
 *   that main shipped via `webContents.postMessage`.
 * - `electronUtilityHostOptionsSchema` — supplied to `transport.host(...)`
 *   inside the utility process. Empty for now; reserved for future
 *   per-utility options (e.g. `projectRoot`).
 */

import { z } from 'zod';

/**
 * Renderer-side options. The `port` is the WHATWG `MessagePort` the
 * renderer received from main via `window.postMessage` relay (preload
 * forwards `event.ports[0]` from the IPC `runtime-port` channel).
 *
 * Validated as `z.custom<MessagePort>()` because MessagePort is not a
 * JSON-serializable shape; the schema exists only for type inference,
 * not runtime validation.
 */
export const electronUtilityClientOptionsSchema = z.object({
  port: z.custom<MessagePort>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { postMessage?: unknown }).postMessage === 'function',
    { message: 'port must be a MessagePort' },
  ),
});

export const electronUtilityHostOptionsSchema = z.object({});
