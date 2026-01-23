import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { listDirectoryInputSchema, isRpcClientError, isRpcExecutionError } from '@taucad/chat';
import { rpcErrorToToolError } from '@taucad/chat/utils';
import type { ChatTool, ListDirectoryInput, ListDirectoryOutput, ToolExecutionError } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const listDirectoryToolDefinition = {
  name: toolName.listDirectory,
  description: `List files and directories in a given path within the project.

Use this tool to:
- Explore the project structure
- Find files in specific directories
- Understand the organization of the codebase

The path should be relative to the project root. Use an empty string "" to list the root directory.`,
  schema: listDirectoryInputSchema,
} as const;

export const listDirectoryTool: ChatTool<
  typeof listDirectoryInputSchema,
  ListDirectoryInput,
  ListDirectoryOutput,
  typeof toolName.listDirectory
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.listDirectory, args);

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(result)) {
    return rpcErrorToToolError(result, toolName.listDirectory, toolCallId);
  }

  // Handle RPC business errors
  if (isRpcClientError(result)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Cannot list directory "${args.path}": ${result.message}`,
      toolName: toolName.listDirectory,
      toolCallId,
    };
    return error;
  }

  // Return success output
  return {
    entries: result.entries,
    path: result.path,
  };
}, listDirectoryToolDefinition);
