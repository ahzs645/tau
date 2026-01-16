import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { readFileInputSchema, isToolExecutionError } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { ChatToolsConfigurable } from '#api/tools/tool.types.js';

export const readFileToolDefinition = {
  name: toolName.readFile,
  description: `Read the contents of a file from the project filesystem.

You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.

Lines in the output are numbered starting at 1, using the format: LINE_NUMBER|LINE_CONTENT.

Use this tool when you need to:
- Examine the contents of a specific file
- Understand existing code before making modifications
- Review configuration files or documentation`,
  schema: readFileInputSchema,
} as const;

/**
 * Add line numbers to raw content for LLM display.
 * Format: "     1|content" where the number is right-padded to 6 chars.
 */
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n');
  return lines.map((line, idx) => `${String(startLine + idx).padStart(6)}|${line}`).join('\n');
}

export const readFileTool = tool(async (args, runtime: ToolRuntime) => {
  const { chatToolsService, thread_id: chatId } = runtime.configurable as ChatToolsConfigurable;
  const { toolCallId } = runtime;

  const result = await chatToolsService.sendToolCallRequest(chatId, toolCallId, toolName.readFile, args);

  // Return error objects directly to the LLM
  if (isToolExecutionError(result)) {
    return result;
  }

  // Add line numbers to the raw content for LLM display
  const startLine = result.startLine ?? 1;
  const contentWithLineNumbers = addLineNumbers(result.content, startLine);

  return {
    content: contentWithLineNumbers,
    totalLines: result.totalLines,
  };
}, readFileToolDefinition);
