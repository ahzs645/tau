import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { TauRpcBackendFactory } from '#api/chat/tau-rpc-backend.js';

/** Default token threshold for offloading (~80KB at ~4 chars/token). */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Domain constant
const DEFAULT_TOKEN_THRESHOLD = 20_000;

/** Characters per token approximation. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Domain constant
const CHARS_PER_TOKEN = 4;

/** Number of preview lines to show from head and tail. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Domain constant
const PREVIEW_LINES = 5;

/**
 * Tools excluded from offloading — same rationale as Deep Agents:
 * - Built-in truncation: list_directory, glob_search, grep
 * - Re-read loops: read_file
 * - Minimal output: edit_file, create_file, delete_file
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Domain constant
const EXCLUDED_TOOLS = new Set([
  'list_directory',
  'glob_search',
  'grep',
  'read_file',
  'edit_file',
  'create_file',
  'delete_file',
]);

const offloadingContextSchema = z.object({
  chatId: z.string(),
});

/**
 * Creates a head+tail preview of content with a truncation marker.
 */
function createPreview(content: string, headLines: number, tailLines: number): string {
  const lines = content.split('\n');

  if (lines.length <= headLines + tailLines) {
    return content;
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;

  return [...head, `\n... [${omitted} lines truncated] ...\n`, ...tail].join('\n');
}

/**
 * Creates middleware that offloads large tool results to the browser filesystem.
 *
 * When a tool result exceeds the token threshold, the full result is written
 * to `.tau/offloaded-tool-results/{toolCallId}.txt` and the ToolMessage content
 * is replaced with a head+tail preview and file path reference.
 */
export const createToolOffloadingMiddleware = (
  rpcBackendFactory: TauRpcBackendFactory,
  options?: { tokenThreshold?: number },
): AgentMiddleware => {
  const threshold = options?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
  const charThreshold = threshold * CHARS_PER_TOKEN;

  return createMiddleware({
    name: 'ToolOffloading',
    contextSchema: offloadingContextSchema,

    async wrapToolCall(request, handler) {
      const result = await handler(request);
      const { context } = request.runtime;
      const { chatId } = context;

      if (!(result instanceof ToolMessage)) {
        return result;
      }

      const toolName = result.name ?? '';
      if (EXCLUDED_TOOLS.has(toolName)) {
        return result;
      }

      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

      if (content.length <= charThreshold) {
        return result;
      }

      const toolCallId = result.tool_call_id;
      const filePath = `.tau/offloaded-tool-results/${toolCallId}.txt`;

      try {
        const backend = rpcBackendFactory.create(chatId, toolCallId);
        await backend.write(filePath, content);

        const preview = createPreview(content, PREVIEW_LINES, PREVIEW_LINES);
        const replacementContent =
          `Tool result too large (${Math.ceil(content.length / CHARS_PER_TOKEN)} tokens). ` +
          `Full result saved to: ${filePath}\n` +
          `Use read_file to access the full result.\n\n` +
          `Preview:\n${preview}`;

        return new ToolMessage({
          content: replacementContent,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: toolCallId,
          name: toolName,
        });
      } catch {
        // If offloading fails, return the original result
        return result;
      }
    },
  });
};
