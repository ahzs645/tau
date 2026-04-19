import type { ListDirectoryRpcInput, ListDirectoryRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { toRpcError } from '#rpc/rpc-error.js';

/** @public */
export async function handleListDirectory(
  input: ListDirectoryRpcInput,
  fileSystem: RpcFileSystem,
): Promise<ListDirectoryRpcResult> {
  try {
    const rawEntries = await fileSystem.readdir(input.path);
    const entries = rawEntries.map(
      (entry) =>
        ({
          name: entry.name,
          type: entry.type === 'directory' ? 'dir' : 'file',
          size: entry.size,
          ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
        }) as const,
    );

    return { success: true, entries, path: input.path || '/' };
  } catch (error) {
    return toRpcError(error);
  }
}
