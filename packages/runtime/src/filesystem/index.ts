/**
 * Advanced filesystem bridge primitives (`taucad/runtime/filesystem` subpath).
 *
 * Low-level primitives for custom filesystem bridge setups, plus high-level
 * wrappers for zero-config worker-to-worker communication.
 *
 * Most consumers should use `fromNodeFS`, `fromMemoryFS`, or `fromFsLike`
 * from the main `@taucad/runtime` entry instead.
 */

// Filesystem constructors
export { fromNodeFS } from '#filesystem/from-node-fs.js';
export { fromMemoryFS } from '#filesystem/from-memory-fs.js';
export { fromFsLike } from '#filesystem/from-fs-like.js';
export type { FsLike } from '#filesystem/from-fs-like.js';

// Enhanced filesystem wrapper
export { createRuntimeFileSystem } from '#filesystem/create-runtime-filesystem.js';

// High-level wrappers
export { exposeFileSystem, createFileSystemBridge, waitForWorkerReady } from '#filesystem/filesystem-bridge.js';
export type {
  FileSystemBridgeOptions,
  ExposeFileSystemHandle,
  ChangeEventCoalescer,
  CoalescerFactory,
  ThrottledEventWorker,
  ThrottledWorkerFactory,
} from '#filesystem/filesystem-bridge.js';

// Constants
export { workerReadyMessageType } from '#framework/runtime-framework.constants.js';

// Low-level bridge primitives
export {
  createBridgeServer,
  createBridgePort,
  createBridgeCall,
  createBridgeProxy,
  catchMessages,
  extractTransferables,
} from '#framework/runtime-filesystem-bridge.js';
export type {
  BridgeError,
  BridgeHandle,
  BridgeServerHandle,
  ContentPool,
} from '#framework/runtime-filesystem-bridge.js';
