import { createMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';

/**
 * Trims leading/trailing newlines and collapses runs of 3+ consecutive
 * newlines down to a single paragraph break (`\n\n`).
 *
 * Returns the original string when no changes are needed.
 */
export function trimNewlines(text: string): string {
  return text
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .replaceAll(/\n{3,}/g, '\n\n');
}

/**
 * Trims excessive newlines from an AIMessage's content.
 *
 * Handles three content shapes:
 * 1. String content — direct trim
 * 2. Array content with `text` blocks (`ContentBlock.Text`)
 * 3. Array content with `reasoning` blocks (`ContentBlock.Reasoning`)
 *
 * Returns the original message reference when no trimming was applied
 * (short-circuit for identity checks in tests).
 */
function trimMessageContent(message: AIMessage): AIMessage {
  const { content } = message;

  if (typeof content === 'string') {
    const trimmed = trimNewlines(content);
    if (trimmed === content) {
      return message;
    }

    return new AIMessage({
      content: trimmed,
      id: message.id,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      tool_calls: message.tool_calls,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      additional_kwargs: message.additional_kwargs,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      response_metadata: message.response_metadata,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      usage_metadata: message.usage_metadata,
    });
  }

  if (!Array.isArray(content)) {
    return message;
  }

  const trimmedBlocks = content.map((block) => {
    const typed = block as Record<string, unknown>;

    if (typed['type'] === 'text' && typeof typed['text'] === 'string') {
      const trimmed = trimNewlines(typed['text']);
      if (trimmed !== typed['text']) {
        return { ...typed, text: trimmed };
      }
    }

    if (typed['type'] === 'reasoning' && typeof typed['reasoning'] === 'string') {
      const trimmed = trimNewlines(typed['reasoning']);
      if (trimmed !== typed['reasoning']) {
        return { ...typed, reasoning: trimmed };
      }
    }

    return block;
  });

  const modified = trimmedBlocks.some((block, index) => block !== content[index]);
  if (!modified) {
    return message;
  }

  return new AIMessage({
    content: trimmedBlocks as AIMessage['content'],
    id: message.id,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    tool_calls: message.tool_calls,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    additional_kwargs: message.additional_kwargs,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    response_metadata: message.response_metadata,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    usage_metadata: message.usage_metadata,
  });
}

/**
 * Middleware that trims excessive newlines from AIMessage content
 * after each model call.
 *
 * Uses `wrapModelCall` to intercept the model response and strip:
 * - Leading newlines from text / reasoning blocks
 * - Trailing newlines from text / reasoning blocks
 * - Interior runs of 3+ newlines (collapsed to `\n\n`)
 *
 * This prevents models that emit leading `\n\n` sequences (common with
 * Gemini reasoning output) from producing blank-line artifacts in the
 * chat UI's "Thought process" panel.
 */
export const newlineTrimmerMiddleware = createMiddleware({
  name: 'NewlineTrimmer',

  async wrapModelCall(request, handler) {
    const response = await handler(request);
    return trimMessageContent(response);
  },
});
