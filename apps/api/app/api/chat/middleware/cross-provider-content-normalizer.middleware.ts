import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ProviderId } from '#api/providers/provider.schema.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeContentBlock(block: unknown, targetIsAnthropic: boolean): unknown {
  if (!isRecord(block)) {
    return block;
  }

  const blockType = block['type'];
  if (typeof blockType !== 'string') {
    return block;
  }

  if (blockType === 'thinking') {
    const { thinking, signature } = block;
    if (typeof thinking !== 'string') {
      return block;
    }

    const next: Record<string, unknown> = {
      type: 'reasoning',
      reasoning: thinking,
    };

    if (targetIsAnthropic && typeof signature === 'string' && signature.length > 0) {
      next['signature'] = signature;
    }

    return next;
  }

  if (blockType === 'redacted_thinking' || blockType === 'compaction') {
    return {
      type: 'non_standard',
      value: block,
    };
  }

  if (blockType === 'reasoning' && !targetIsAnthropic) {
    if (!('signature' in block) && !('thoughtSignature' in block)) {
      return block;
    }

    const rest = { ...block };
    delete rest['signature'];
    delete rest['thoughtSignature'];
    return rest;
  }

  return block;
}

function normalizeAiMessage(message: AIMessage, targetIsAnthropic: boolean): BaseMessage {
  const { content } = message;

  if (!Array.isArray(content)) {
    return message;
  }

  const nextContent = content.map((block) => normalizeContentBlock(block, targetIsAnthropic));
  const unchanged = nextContent.every((block, index) => block === content[index]);

  if (unchanged) {
    return message;
  }

  return new AIMessage({
    content: nextContent as typeof content,
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
 * Rewrites legacy Anthropic-native assistant blocks (`thinking`, `redacted_thinking`, `compaction`)
 * into LangChain V1-standard shapes before the active provider formats messages.
 *
 * Runs before {@link messageContentSanitizerMiddleware}, which assumes `reasoning` blocks where needed.
 */
export const createCrossProviderContentNormalizerMiddleware = (targetProvider: ProviderId): AgentMiddleware => {
  const targetIsAnthropic = targetProvider === 'anthropic';

  return createMiddleware({
    name: 'CrossProviderContentNormalizer',

    async wrapModelCall(request, handler) {
      const normalized = request.messages.map((message) =>
        AIMessage.isInstance(message) ? normalizeAiMessage(message, targetIsAnthropic) : message,
      );

      return handler({
        ...request,
        messages: normalized,
      });
    },
  });
};
