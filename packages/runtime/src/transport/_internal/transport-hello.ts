/**
 * Shared `TransportHelloPayload` builder used by every bundled
 * transport. Centralised so the runtime version is read once and the
 * `server` literal stays consistent across `client.open()` /
 * `host.open()`.
 *
 * @internal
 */

import { packageVersion } from '#utils/package-info.js';
import type { TransportHelloPayload } from '#transport/runtime-transport.types.js';

export const buildHelloPayload = (transportId: string): TransportHelloPayload => ({
  server: 'kernel-runtime-worker',
  runtimeVersion: packageVersion,
  transportId,
});
