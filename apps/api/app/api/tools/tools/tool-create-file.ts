import type { DynamicStructuredTool, ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import type { JSONSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import { createFileInputSchema } from '@taucad/chat';
import type { CreateFileInput, CreateFileOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

const createFileJsonSchema = z.toJSONSchema(createFileInputSchema);

export const createFileToolDefinition = {
  name: toolName.createFile,
  description: `Create a new file with the specified content in the project filesystem.

Use this tool to:
- Create new source files (e.g., new modules, libraries)
- Create configuration files
- Add new assets or resources

The file path should be relative to the project root. Parent directories will be created automatically if they don't exist.

Note: This tool will overwrite an existing file if one exists at the specified path. Use read_file first to check if a file exists if you want to avoid overwriting.`,
  schema: createFileJsonSchema,
} as const;

export const createFileTool: DynamicStructuredTool<JSONSchema, CreateFileOutput, CreateFileInput, CreateFileOutput> =
  tool(async (args, runtime: ToolRuntime) => {
    const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
    const { toolCallId } = runtime;

    const result = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.createFile, args);
    return result as CreateFileOutput;
  }, createFileToolDefinition);
