import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { grepInputSchema } from '@taucad/chat';
import type { ChatTool, GrepInput, GrepOutput } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

export const grepToolDefinition = {
  name: toolName.grep,
  description: `Search for text patterns in files using regular expressions.

This is a powerful search tool for finding exact matches in file contents.

Usage:
- Supports full regex syntax, e.g. "function\\s+\\w+", "import.*from"
- Escape special characters for exact matches, e.g. "functionCall\\("
- Use the glob parameter to filter by file type, e.g. "*.scad", "*.ts"
- Results show file path, line number, and matching line content

Use this tool when you need to:
- Find specific code patterns or function calls
- Locate variable or function definitions
- Search for text across multiple files`,
  schema: grepInputSchema,
} as const;

export const grepTool: ChatTool<typeof grepInputSchema, GrepInput, GrepOutput, typeof toolName.grep> = tool(
  async (args, runtime: ToolRuntime) => {
    const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
    const { toolCallId } = runtime;

    return chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.grep, args);
  },
  grepToolDefinition,
);
