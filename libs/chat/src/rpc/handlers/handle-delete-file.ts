import type { DeleteFileRpcInput, DeleteFileRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { toRpcError } from '#rpc/rpc-error.js';

/** @public */
export async function handleDeleteFile(
  input: DeleteFileRpcInput,
  fileSystem: RpcFileSystem,
): Promise<DeleteFileRpcResult> {
  try {
    await fileSystem.deleteFile(input.targetFile);

    return { success: true, message: `File deleted: ${input.targetFile}` };
  } catch (error) {
    return toRpcError(error);
  }
}
