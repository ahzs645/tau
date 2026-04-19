import type { CreateFileRpcInput, CreateFileRpcResult } from '#schemas/rpc.schema.js';
import type { RpcFileSystem } from '#rpc/rpc-dependencies.js';
import { toRpcError } from '#rpc/rpc-error.js';

/** @public */
export async function handleCreateFile(
  input: CreateFileRpcInput,
  fileSystem: RpcFileSystem,
): Promise<CreateFileRpcResult> {
  try {
    await fileSystem.writeFile(input.targetFile, input.content);

    const lineCount = input.content.split('\n').length;

    return {
      success: true,
      message: `File created: ${input.targetFile}`,
      diffStats: {
        linesAdded: lineCount,
        linesRemoved: 0,
        originalContent: '',
        modifiedContent: input.content,
      },
    };
  } catch (error) {
    return toRpcError(error);
  }
}
