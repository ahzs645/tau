import { AIMessage } from '@langchain/core/messages';

type TextTransformer = (text: string) => string;

/**
 * Applies a text transform across all text-bearing parts of an AIMessage.
 *
 * Supported shapes:
 * - string content
 * - array content with `text` and `reasoning` blocks
 *
 * Returns the original AIMessage instance when no content changes occur.
 */
export function transformAiMessageContent(message: AIMessage, transform: TextTransformer): AIMessage {
  const { content } = message;

  if (typeof content === 'string') {
    const transformed = transform(content);

    if (transformed === content) {
      return message;
    }

    return new AIMessage({
      content: transformed,
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

  const transformedBlocks = content.map((block) => {
    const typed = block as Record<string, unknown>;

    if (typed['type'] === 'text' && typeof typed['text'] === 'string') {
      const transformed = transform(typed['text']);
      if (transformed !== typed['text']) {
        return { ...typed, text: transformed };
      }
    }

    if (typed['type'] === 'reasoning' && typeof typed['reasoning'] === 'string') {
      const transformed = transform(typed['reasoning']);
      if (transformed !== typed['reasoning']) {
        return { ...typed, reasoning: transformed };
      }
    }

    return block;
  });

  const modified = transformedBlocks.some((block, index) => block !== content[index]);
  if (!modified) {
    return message;
  }

  return new AIMessage({
    content: transformedBlocks as AIMessage['content'],
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
