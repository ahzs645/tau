/**
 * Public filesystem surface (`@taucad/runtime/filesystem` subpath).
 *
 * Consumers compose an opaque {@link RuntimeFileSystem} via one of the
 * bundled `fromX` factories and hand it to a transport plugin. Bridge
 * primitives (`createBridgeServer`, `exposeFileSystem`,
 * `createFileSystemBridge`, `waitForWorkerReady`, ...) are
 * transport-author tools; reach for them via
 * `@taucad/runtime/transport-internals` only when authoring a custom
 * FS bridge — ordinary consumers never need them.
 */

// Public opaque `RuntimeFileSystem` and `fromX` factories.
export { fromMemoryFs, fromFsLike, fromChannelFs, isRuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
export type { FsLike, RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
export { fromBrowserFs } from '#filesystem/from-browser-fs.js';

// Enhanced filesystem wrapper — used by kernel authors composing their own
// `RuntimeFileSystemBase` implementations.
export { createRuntimeFileSystem } from '#filesystem/create-runtime-filesystem.js';

export { runtimeFileSystemSchema } from '#filesystem/runtime-filesystem.schemas.js';
