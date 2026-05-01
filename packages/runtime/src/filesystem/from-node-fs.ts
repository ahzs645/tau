/**
 * Public opaque {@link RuntimeFileSystem} factory backed by Node.js
 * `fs.promises`. Exposed through the
 * `@taucad/runtime/filesystem/node` subpath so the bundle stays free of
 * Node-only imports for the default browser-safe entry.
 *
 * @public
 */

import { _fromNodeFsHandle } from '#transport/_internal/from-node-fs-handle.js';
import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import { wrapAsRuntimeFileSystem } from '#transport/_internal/runtime-filesystem-handle.js';

/**
 * Create an opaque {@link RuntimeFileSystem} backed by Node.js
 * `fs.promises`. Pass the result to
 * `inProcessTransport({ fileSystem })`,
 * `nodeWorkerTransport({ fileSystem })`, or `webWorkerTransport({ fileSystem })`.
 *
 * @param basePath - Root path for all filesystem operations.
 * @public
 *
 * @example <caption>Server-side Node.js filesystem</caption>
 * ```typescript
 * import { createRuntimeClient } from '@taucad/runtime';
 * import { inProcessTransport } from '@taucad/runtime/transport/in-process';
 * import { fromNodeFs } from '@taucad/runtime/filesystem/node';
 * import { replicad } from '@taucad/runtime/kernels';
 * import { esbuild } from '@taucad/runtime/bundler';
 *
 * const client = createRuntimeClient({
 *   kernels: [replicad()],
 *   bundlers: [esbuild()],
 *   transport: inProcessTransport({
 *     fileSystem: fromNodeFs('/path/to/project'),
 *   }),
 * });
 * ```
 */
export const fromNodeFs = (basePath: string): RuntimeFileSystem => wrapAsRuntimeFileSystem(_fromNodeFsHandle(basePath));
