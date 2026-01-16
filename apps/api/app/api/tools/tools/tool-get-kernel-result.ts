import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { getKernelResultInputSchema } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

export const getKernelResultToolDefinition = {
  name: toolName.getKernelResult,
  description: `Check the status of the CAD kernel and retrieve any compilation errors for a specific file.

Parameters:
- targetFile: The file to check kernel results for (relative to project root)

Use this tool AFTER using \`edit_file\` or \`create_file\` to verify that your code changes compiled successfully.

Returns:
- status: 'ready' if compilation succeeded, 'error' if there were errors, 'pending' if still processing
- kernelIssues: Array of compilation/runtime errors if any occurred

Best Practice: Always call this tool after making file changes to ensure the model renders correctly before proceeding.`,
  schema: getKernelResultInputSchema,
} as const;

export const getKernelResultTool = tool(async (args, runtime: ToolRuntime) => {
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  return chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.getKernelResult, args);
}, getKernelResultToolDefinition);
