import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { deleteFileInputSchema } from '@taucad/chat';
import type { DeleteFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

const deleteFileJsonSchema = z.toJSONSchema(deleteFileInputSchema);

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
  schema: deleteFileJsonSchema,
} as const;

export const deleteFileTool = tool(async (args, runtime: ToolRuntime) => {
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  const result = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.deleteFile, args);
  return result as DeleteFileOutput;
}, deleteFileToolDefinition);
