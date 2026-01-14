import type { DynamicStructuredTool, ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import type { JSONSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import { getKernelResultInputSchema } from '@taucad/chat';
import type { GetKernelResultInput, GetKernelResultOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

const getKernelResultJsonSchema = z.toJSONSchema(getKernelResultInputSchema);

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
  schema: getKernelResultJsonSchema,
} as const;

export const getKernelResultTool: DynamicStructuredTool<
  JSONSchema,
  GetKernelResultOutput,
  GetKernelResultInput,
  GetKernelResultOutput
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  const result = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.getKernelResult, args);
  return result as GetKernelResultOutput;
}, getKernelResultToolDefinition);
