import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { deleteFileInputSchema } from '@taucad/chat';
import type { ChatTool, DeleteFileInput, DeleteFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

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
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  return chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.deleteFile, args);
}, deleteFileToolDefinition);
