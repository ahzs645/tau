import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { createFileInputSchema } from '@taucad/chat';
import type { ChatTool, CreateFileInput, CreateFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

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
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  return chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.createFile, args);
}, createFileToolDefinition);
