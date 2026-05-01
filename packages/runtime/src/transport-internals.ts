/* oxlint-disable no-barrel-files/no-barrel-files -- intentional `transport-internals` facade */
/**
 * Transport-author primitives for custom filesystem bridges.
 *
 * Exposes the low-level bridge wire primitives (`createBridgeServer`,
 * `createBridgePort`, `createBridgeCall`, `createBridgeProxy`,
 * `catchMessages`, `extractTransferables`) and the high-level wrappers
 * (`exposeFileSystem`, `createFileSystemBridge`, `waitForWorkerReady`)
 * that custom transport authors compose to wire a remote
 * `RuntimeFileSystem` between an FS-owning worker and a runtime client
 * that consumes it via `fromChannelFs(...)`.
 *
 * Also re-exports {@link extractInlineFileSystem}, `wrapMessagePort`, and the
 * `Port` type from `@taucad/rpc`, for transport authors who bridge filesystem
 * who bridge filesystem RPC over non-`MessagePort` adapters or inject inline FS
 * into worker dispatchers (`inlineFileSystem` seam).
 *
 * Removed from the public `@taucad/runtime/filesystem` barrel (R16) so
 * the consumer-facing FS surface stays opaque — only the bundled `fromX`
 * factories and the `RuntimeFileSystem` brand. Reach for this subpath
 * only when authoring a custom FS bridge (e.g. an Electron renderer
 * that brokers a `file-manager.worker` over `MessagePort`); ordinary
 * consumers never need these primitives.
 *
 * @public
 */

export { exposeFileSystem, createFileSystemBridge, waitForWorkerReady } from '#filesystem/filesystem-bridge.js';
export type {
  FileSystemBridgeOptions,
  ExposeFileSystemHandle,
  ChangeEventCoalescer,
  CoalescerFactory,
  ThrottledEventWorker,
  ThrottledWorkerFactory,
} from '#filesystem/filesystem-bridge.js';

export { workerReadyMessageType, filesystemBridgeConnectMessageType } from '#framework/runtime-framework.constants.js';

export { extractInlineFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';

export { wrapMessagePort } from '@taucad/rpc';
export type { Port } from '@taucad/rpc';

export {
  createBridgeServer,
  createBridgePort,
  createBridgeCall,
  createBridgeProxy,
  catchMessages,
  extractTransferables,
} from '#transport/_internal/runtime-filesystem-bridge.js';
export type {
  BridgeError,
  FileSystemBridge,
  BridgePort,
  BridgeServerHandle,
  FilePool,
} from '#transport/_internal/runtime-filesystem-bridge.js';
