import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { TauRpcBackendFactory } from '#api/chat/tau-rpc-backend.js';

/** Default token threshold for offloading (~80KB at ~4 chars/token). */
const defaultTokenThreshold = 20_000;

/** Characters per token approximation. */
const charactersPerToken = 4;

/** Number of preview lines to show from head and tail. */
const previewLines = 5;

/** Per-field char threshold for structure-preserving compaction (~250 tokens). */
const perFieldCharacterThreshold = 1000;

/**
 * Tools excluded from offloading — same rationale as Deep Agents:
 * - Built-in truncation: list_directory, glob_search, grep
 * - Re-read loops: read_file
 * - Minimal output: edit_file, create_file, delete_file
 */
const excludedTools = new Set([
  'list_directory',
  'glob_search',
  'grep',
  'read_file',
  'edit_file',
  'create_file',
  'delete_file',
  'screenshot',
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
 * Attempts structure-preserving JSON compaction, falling back to a flat-string
 * preview for non-JSON content.
 */
function compactJsonContent(content: string, filePath: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    const compacted = compactLargeStrings(parsed, perFieldCharacterThreshold);

    if (compacted !== null && typeof compacted === 'object' && !Array.isArray(compacted)) {
      (compacted as Record<string, unknown>)['_offloadedTo'] = filePath;
    }

    return JSON.stringify(compacted);
  } catch {
    const preview = createPreview(content, previewLines, previewLines);
    return (
      `Tool result too large (${Math.ceil(content.length / charactersPerToken)} tokens). ` +
      `Full result saved to: ${filePath}\n` +
      `Use read_file to access the full result.\n\n` +
      `Preview:\n${preview}`
    );
  }
}

/**
 * Recursively walks a parsed JSON value and replaces string leaves exceeding
 * the threshold with compact placeholders. Preserves the overall structure
 * (objects, arrays, primitives) so downstream schemas still validate.
 *
 * @public
 */
export function compactLargeStrings(value: unknown, threshold: number): unknown {
  if (typeof value === 'string') {
    return value.length > threshold ? `[offloaded: ${value.length} chars]` : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => compactLargeStrings(item, threshold));
  }

  if (value !== null && typeof value === 'object') {
    const compacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      compacted[key] = compactLargeStrings(entry, threshold);
    }
    return compacted;
  }

  return value;
}

/**
 * Creates middleware that offloads large tool results to the browser filesystem.
 *
 * When a tool result exceeds the token threshold, the full result is written
 * to `.tau/offloaded-tool-results/{toolCallId}.txt` and the ToolMessage content
 * is replaced with a compacted version that preserves JSON structure.
 *
 * For JSON content: large string leaves are replaced with `[offloaded: N chars]`
 * placeholders, keeping the schema-valid structure intact.
 * For non-JSON content: falls back to a head+tail text preview.
 */
export const createToolOffloadingMiddleware = (
  rpcBackendFactory: TauRpcBackendFactory,
  options?: { tokenThreshold?: number },
): AgentMiddleware => {
  const threshold = options?.tokenThreshold ?? defaultTokenThreshold;
  const charThreshold = threshold * charactersPerToken;

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
      if (excludedTools.has(toolName)) {
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

        const replacementContent = compactJsonContent(content, filePath);

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
