import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { listDirectoryInputSchema } from '@taucad/chat';
import type { ChatTool, ListDirectoryInput, ListDirectoryOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

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
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  return chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.listDirectory, args);
}, listDirectoryToolDefinition);
