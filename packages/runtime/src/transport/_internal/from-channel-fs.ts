/**
 * Internal port-based bridge to wrap an opaque {@link RuntimeFileSystem}
 * around a caller-owned `MessagePort` whose remote end already serves
 * the runtime FS-bridge protocol.
 *
 * Used by transports whose host-side process owns the FS authority
 * (Electron utility process, dedicated worker, sandboxed iframe) and
 * pushes the bridge `MessagePort` into the consumer side via its IPC
 * bridge.
 *
 * The accepted argument is intentionally a raw `MessagePort` rather
 * than a wrapped `Port<unknown>` / `Channel<unknown>`: the FS-bridge
 * protocol is not framed via `@taucad/rpc`, it speaks directly on the
 * port.
 *
 * Lives under `transport/_internal/` because the runtime architecture
 * keeps `MessagePort` plumbing transport-internal — consumers compose
 * a transport (which internally wires its own FS bridge), they do not
 * hand-construct a channel-bridged `RuntimeFileSystem`. The public
 * worker-based factory is `fromChannelFs` in
 * `filesystem/runtime-filesystem.ts`.
 *
 * @internal
 */

import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import { wrapAsRuntimeFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';

/**
 * Wrap a caller-owned `MessagePort` as the opaque
 * {@link RuntimeFileSystem} value a transport hands its dispatcher.
 *
 * The runtime client never invokes `dispose` on the underlying port —
 * the wire belongs to the IPC bridge that produced it.
 *
 * @internal
 * @param port - A `MessagePort` whose peer serves the runtime FS bridge.
 */
export const _fromChannelFsHandle = (port: MessagePort): RuntimeFileSystem =>
  wrapAsRuntimeFileSystem({ kind: 'channel', port });
