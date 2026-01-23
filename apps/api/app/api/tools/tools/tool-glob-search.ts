import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { globSearchInputSchema, isRpcClientError, isRpcExecutionError } from '@taucad/chat';
import { rpcErrorToToolError } from '@taucad/chat/utils';
import type { ChatTool, GlobSearchInput, GlobSearchOutput, ToolExecutionError } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

export const globSearchToolDefinition = {
  name: toolName.globSearch,
  description: `Find files matching a glob pattern in the project.

Use this tool to:
- Find all files of a certain type (e.g., "**/*.scad", "**/*.ts")
- Locate files in specific directories (e.g., "lib/**/*.scad")
- Discover files by name pattern (e.g., "**/test_*.scad")

Common glob patterns:
- "**/*.ext" - All files with extension in any directory
- "dir/**/*" - All files under a specific directory
- "**/prefix_*" - Files starting with a prefix in any directory`,
  schema: globSearchInputSchema,
} as const;

export const globSearchTool: ChatTool<
  typeof globSearchInputSchema,
  GlobSearchInput,
  GlobSearchOutput,
  typeof toolName.globSearch
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.globSearch, args);

  // Handle RPC infrastructure errors (timeout, disconnect, validation)
  if (isRpcExecutionError(result)) {
    return rpcErrorToToolError(result, toolName.globSearch, toolCallId);
  }

  // Handle RPC business errors
  if (isRpcClientError(result)) {
    const error: ToolExecutionError = {
      errorCode: 'TOOL_EXECUTION_ERROR',
      message: `Glob search failed: ${result.message}`,
      toolName: toolName.globSearch,
      toolCallId,
    };
    return error;
  }

  // Return success output
  return {
    files: result.files,
    totalFiles: result.totalFiles,
  };
}, globSearchToolDefinition);
