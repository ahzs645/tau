import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { deleteFileInputSchema, isRpcClientError, isRpcExecutionError } from '@taucad/chat';
import { rpcErrorToToolError } from '@taucad/chat/utils';
import type { ChatTool, DeleteFileInput, DeleteFileOutput, ToolExecutionError } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const deleteFileToolDefinition = {
  name: toolName.deleteFile,
  description: `Delete a file from the project filesystem.

Use this tool to:
- Remove unused or obsolete files
- Clean up temporary files
- Remove files that are no longer needed

The operation will fail gracefully if:
- The file doesn't exist
- The operation is rejected for security reasons
- The file cannot be deleted`,
  schema: deleteFileInputSchema,
} as const;

export const deleteFileTool: ChatTool<
  typeof deleteFileInputSchema,
  DeleteFileInput,
  DeleteFileOutput,
  typeof toolName.deleteFile
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.deleteFile, args);

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(result)) {
    return rpcErrorToToolError(result, toolName.deleteFile, toolCallId);
  }

  // Handle RPC business errors (file not found, permission denied)
  if (isRpcClientError(result)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Cannot delete file "${args.targetFile}": ${result.message}`,
      toolName: toolName.deleteFile,
      toolCallId,
    };
    return error;
  }

  // Return success output (no success property in schema)
  const output: DeleteFileOutput = {
    message: result.message,
  };
  return output;
}, deleteFileToolDefinition);
