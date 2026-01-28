import type { ToolRuntime } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { readFileInputSchema } from '@taucad/chat';
import { assertRpcSuccess } from '@taucad/chat/utils';
import type { ChatTool, ReadFileInput, ReadFileOutput } from '@taucad/chat';
import { rpcName, toolName } from '@taucad/chat/constants';
import type { ChatRpcConfigurable } from '#api/tools/tool.types.js';

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
 * Format: "1|content" (no padding to save tokens).
 */
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n');
  return lines.map((line, idx) => `${startLine + idx}|${line}`).join('\n');
}

export const readFileTool: ChatTool<
  typeof readFileInputSchema,
  ReadFileInput,
  ReadFileOutput,
  typeof toolName.readFile
> = tool(async (args, runtime: ToolRuntime) => {
  const { chatRpcService, thread_id: chatId } = runtime.configurable as ChatRpcConfigurable;
  const { toolCallId } = runtime;

  const result = await chatRpcService.sendRpcRequest(chatId, toolCallId, rpcName.readFile, args);

  // Assert RPC success - throws ToolError for any infrastructure or client error
  assertRpcSuccess(result, toolName.readFile, toolCallId, (error) => {
    if (error.errorCode === 'FILE_NOT_FOUND') {
      return `File not found`;
    }

    return `Cannot read file`;
  });

  // Add line numbers to the raw content for LLM display
  const startLine = result.startLine ?? 1;
  const contentWithLineNumbers = addLineNumbers(result.content, startLine);

  return {
    content: contentWithLineNumbers,
    totalLines: result.totalLines,
  };
}, readFileToolDefinition);
