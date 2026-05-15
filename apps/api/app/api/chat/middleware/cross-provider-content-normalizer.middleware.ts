import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
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

/**
 * Translates a generic LangChain `ToolMessage` content array into the OpenAI
 * Responses API native shape (`input_text` / `input_image`).
 *
 * `langchain-openai`'s Responses converter only forwards a tool-message content
 * array as a typed `function_call_output.output` list when **every** block is
 * `input_text|input_image|input_file`; any other shape (notably the LangChain
 * V1 `text`/`image_url` blocks our screenshot trimmer emits) falls back to
 * `JSON.stringify`, which surfaces base64 image data as raw text to the model.
 *
 * Block rewrites:
 *  - `{type:'image_url', image_url:{url}|string}` -> `{type:'input_image', image_url:url, detail:'auto'}`
 *  - `{type:'text', text}` -> `{type:'input_text', text}`
 *  - already-native blocks pass through unchanged
 *  - string content passes through unchanged
 *
 * Required because `isProviderNativeContent` demands a homogeneously-`input_*`
 * array; leaving a single `text` block would still trigger `JSON.stringify`.
 */
function normalizeToolMessageForOpenai(message: ToolMessage): ToolMessage {
  const { content } = message;

  if (!Array.isArray(content)) {
    return message;
  }

  const nextContent = content.map((block) => {
    if (!isRecord(block)) {
      return block;
    }

    const opaqueBlock = block as unknown as Record<string, unknown>;
    const { type } = opaqueBlock;

    if (type === 'image_url') {
      const rawUrl = opaqueBlock['image_url'];
      let url: string | undefined;
      if (typeof rawUrl === 'string') {
        url = rawUrl;
      } else if (isRecord(rawUrl)) {
        const candidate = (rawUrl as { url: unknown }).url;
        if (typeof candidate === 'string') {
          url = candidate;
        }
      }

      if (url === undefined) {
        return block;
      }

      return {
        type: 'input_image',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- OpenAI Responses API uses snake_case
        image_url: url,
        detail: 'auto',
      };
    }

    if (type === 'text') {
      const { text } = opaqueBlock;
      if (typeof text === 'string') {
        return {
          type: 'input_text',
          text,
        };
      }
    }

    return block;
  });

  const unchanged = nextContent.every((block, index) => block === content[index]);
  if (unchanged) {
    return message;
  }

  return new ToolMessage({
    content: nextContent as ToolMessage['content'],
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    tool_call_id: message.tool_call_id,
    name: message.name,
    id: message.id,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    additional_kwargs: message.additional_kwargs,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
    response_metadata: message.response_metadata,
  });
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
 * For OpenAI targets, also rewrites `ToolMessage` content blocks from the generic
 * LangChain V1 shape (`text` / `image_url`) into the OpenAI Responses API native
 * shape (`input_text` / `input_image`) so screenshots reach the model as real
 * pixels instead of a `JSON.stringify`'d base64 blob.
 *
 * Runs before {@link messageContentSanitizerMiddleware}, which assumes `reasoning` blocks where needed.
 */
export const createCrossProviderContentNormalizerMiddleware = (targetProvider: ProviderId): AgentMiddleware => {
  const targetIsAnthropic = targetProvider === 'anthropic';
  const targetIsOpenai = targetProvider === 'openai';

  return createMiddleware({
    name: 'CrossProviderContentNormalizer',

    async wrapModelCall(request, handler) {
      const normalized = request.messages.map((message) => {
        if (AIMessage.isInstance(message)) {
          return normalizeAiMessage(message, targetIsAnthropic);
        }
        if (targetIsOpenai && ToolMessage.isInstance(message)) {
          return normalizeToolMessageForOpenai(message);
        }
        return message;
      });

      return handler({
        ...request,
        messages: normalized,
      });
    },
  });
};
