import { createRuntimeClient } from '#client/runtime-client.js';
import type { RuntimeClientOptions, RuntimeClient } from '#client/runtime-client.js';
import { presets } from '#plugins/presets.js';
import { createInProcessTransport } from '#transport/in-process-transport.js';
import { fromNodeFS } from '#filesystem/from-node-fs.js';

/**
 * Create a RuntimeClient pre-configured for headless Node.js usage.
 *
 * Combines `presets.all()`, `createInProcessTransport()`, and optionally
 * `fromNodeFS(projectPath)` into a single async factory call.
 *
 * @param projectPath - Root directory for filesystem-backed rendering. Omit for inline code mode.
 * @param options - Override individual client options (kernels, middleware, etc.)
 * @returns Configured RuntimeClient ready for render/export operations
 *
 * @public
 *
 * @example <caption>Export a file from disk</caption>
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
  options?: Partial<RuntimeClientOptions>,
): Promise<RuntimeClient> {
  const fileSystem = projectPath ? fromNodeFS(projectPath) : undefined;

  return createRuntimeClient({
    ...presets.all(),
    ...options,
    transport: options?.transport ?? createInProcessTransport(),
    ...(fileSystem ? { fileSystem } : {}),
  });
}
