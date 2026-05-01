import { createRuntimeClient } from '#client/runtime-client.js';
import type { RuntimeClientOptions, RuntimeClient } from '#client/runtime-client.js';
import { presets } from '#plugins/presets.js';
import { inProcessTransport } from '#transport/in-process-transport.js';
import { fromMemoryFs } from '#filesystem/runtime-filesystem.js';
import type { RuntimeFileSystem } from '#filesystem/runtime-filesystem.js';
import { fromNodeFs } from '#filesystem/from-node-fs.js';

/**
 * Create a `RuntimeClient` pre-configured for headless Node.js usage.
 *
 * Composes `presets.all()` with the bundled `inProcessTransport` (FS-backed
 * by `fromNodeFs(projectPath)` when supplied, `fromMemoryFs()`
 * otherwise) into a single factory call. The returned client connects
 * on first command.
 *
 * @param projectPath - Root directory for filesystem-backed rendering. Omit
 *   for inline-`code:` mode; the client provisions an in-memory filesystem
 *   on the first `openFile` / `export({ code })` call.
 * @param options - Override individual client options (kernels, middleware)
 * @returns Configured `RuntimeClient` ready for render and export operations
 *
 * @public
 *
 * @example <caption>Inline-code export (no projectPath, auto-connect)</caption>
 * ```typescript
 * import { createNodeClient } from '@taucad/runtime/node';
 *
 * const client = await createNodeClient();
 * const result = await client.export('glb', {
 *   code: { 'main.ts': 'import { makeBaseBox } from "replicad";\nexport default () => makeBaseBox(10, 20, 30);' },
 *   file: 'main.ts',
 * });
 * client.terminate();
 * ```
 *
 * @example <caption>Export a file from disk (filesystem-backed)</caption>
 * ```typescript
 * import { createNodeClient } from '@taucad/runtime/node';
 *
 * const client = await createNodeClient('/path/to/project');
 * const result = await client.export('glb', { file: 'main.ts' });
 * client.terminate();
 * ```
 */
export async function createNodeClient(
  projectPath?: string,
  options?: Partial<Omit<RuntimeClientOptions, 'transport'>>,
): Promise<RuntimeClient> {
  const fileSystem: RuntimeFileSystem = projectPath ? fromNodeFs(projectPath) : fromMemoryFs();
  const transport = inProcessTransport({ fileSystem });

  return createRuntimeClient({
    ...presets.all(),
    ...options,
    transport,
  });
}
