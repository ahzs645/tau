/**
 * Resolve a consumer-supplied {@link RuntimeFileSystem} into a
 * `MessagePort` suitable for the dispatcher's filesystem bridge.
 *
 * - `kind: 'inline'`  → wrap in a fresh `BridgePort` so the worker can
 *                       consume it via the same proxy plumbing.
 * - `kind: 'channel'` → forward the supplied port verbatim.
 *
 * Returns `undefined` when no filesystem was supplied (`fileSystem ===
 * undefined`); transports degrade to whatever default FS the worker
 * brings up internally.
 *
 * @internal
 */

import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import { resolveRuntimeFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';
import { createBridgePort } from '#transport/_internal/runtime-filesystem-bridge.js';

/** */
export type ResolvedFileSystemBridge = {
  readonly port: MessagePort;
  readonly kind: 'inline' | 'channel';
  readonly dispose: () => void;
};

export const buildFileSystemBridge = (fs: RuntimeFileSystem | undefined): ResolvedFileSystemBridge | undefined => {
  if (!fs) {
    return undefined;
  }
  const handle = resolveRuntimeFileSystem(fs);
  if (handle.kind === 'inline') {
    const bridge = createBridgePort(handle.fs as unknown as Record<string, unknown>);
    return {
      port: bridge.port,
      kind: 'inline',
      dispose: () => {
        bridge.dispose();
      },
    };
  }
  return {
    port: handle.port,
    kind: 'channel',
    dispose: () => undefined,
  };
};
