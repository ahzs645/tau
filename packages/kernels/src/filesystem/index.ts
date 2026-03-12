/**
 * @taucad/runtime/filesystem -- advanced filesystem bridge primitives.
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
export { createKernelFileSystem } from '#filesystem/create-kernel-filesystem.js';

// High-level wrappers
export { exposeFileSystem, createFileSystemBridge } from '#filesystem/filesystem-bridge.js';
export type { FileSystemBridgeOptions, ExposeFileSystemHandle } from '#filesystem/filesystem-bridge.js';

// Low-level bridge primitives
export {
  createBridgeServer,
  createBridgePort,
  createBridgeCall,
  createBridgeProxy,
  catchMessages,
  extractTransferables,
} from '#framework/kernel-filesystem-bridge.js';
export type { BridgeError, BridgeHandle, BridgeServerHandle } from '#framework/kernel-filesystem-bridge.js';
