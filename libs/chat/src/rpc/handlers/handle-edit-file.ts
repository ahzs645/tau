import type { EditFileRpcInput, EditFileRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { toRpcError } from '#rpc/rpc-error.js';

/** @public */
export async function handleEditFile(input: EditFileRpcInput, fileSystem: RpcFileSystem): Promise<EditFileRpcResult> {
  try {
    const { occurrences } = await fileSystem.editFile(
      input.targetFile,
      input.oldString,
      input.newString,
      input.replaceAll,
    );

    return {
      success: true,
      message: `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${input.targetFile}`,
      occurrences,
    };
  } catch (error) {
    return toRpcError(error);
  }
}
