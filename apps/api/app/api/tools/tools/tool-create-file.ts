import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { createFileInputSchema, isRpcClientError, isRpcExecutionError } from '@taucad/chat';
import { rpcErrorToToolError } from '@taucad/chat/utils';
import type { ChatTool, CreateFileInput, CreateFileOutput, ToolExecutionError } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const createFileToolDefinition = {
  name: toolName.createFile,
  description: `Create a new file with the specified content in the project filesystem.

Use this tool to:
- Create new source files (e.g., new modules, libraries)
- Create configuration files
- Add new assets or resources

The file path should be relative to the project root. Parent directories will be created automatically if they don't exist.

Note: This tool will overwrite an existing file if one exists at the specified path. Use read_file first to check if a file exists if you want to avoid overwriting.`,
  schema: createFileInputSchema,
} as const;

export const createFileTool: ChatTool<
  typeof createFileInputSchema,
  CreateFileInput,
  CreateFileOutput,
  typeof toolName.createFile
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.createFile, args);

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(result)) {
    return rpcErrorToToolError(result, toolName.createFile, toolCallId);
  }

  // Handle RPC business errors (permission denied, etc.)
  if (isRpcClientError(result)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Cannot create file "${args.targetFile}": ${result.message}`,
      toolName: toolName.createFile,
      toolCallId,
    };
    return error;
  }

  // Return success output (no success property in schema)
  const output: CreateFileOutput = {
    message: result.message,
    diffStats: result.diffStats,
  };
  return output;
}, createFileToolDefinition);
