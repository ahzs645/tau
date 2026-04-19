import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newlineTrimmerMiddleware, trimNewlines } from '#api/chat/middleware/newline-trimmer.middleware.js';
import { invokeWrapModelCall } from '#testing/middleware-testing.utils.js';

// =============================================================================
// trimNewlines (unit)
// =============================================================================

describe('trimNewlines', () => {
  it('should strip leading newlines', () => {
    expect(trimNewlines('\n\nHello')).toBe('Hello');
  });

  it('should strip trailing newlines', () => {
    expect(trimNewlines('Hello\n\n')).toBe('Hello');
  });

  it('should strip both leading and trailing newlines', () => {
    expect(trimNewlines('\n\n\nHello\n\n')).toBe('Hello');
  });

  it('should collapse 3+ interior newlines to double newline', () => {
    expect(trimNewlines('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('should preserve single interior newlines', () => {
    expect(trimNewlines('A\nB')).toBe('A\nB');
  });

  it('should preserve double interior newlines', () => {
    expect(trimNewlines('A\n\nB')).toBe('A\n\nB');
  });

  it('should handle text with no newlines', () => {
    expect(trimNewlines('Hello world')).toBe('Hello world');
  });

  it('should handle empty string', () => {
    expect(trimNewlines('')).toBe('');
  });

  it('should handle string of only newlines', () => {
    expect(trimNewlines('\n\n\n')).toBe('');
  });

  it('should collapse multiple interior runs independently', () => {
    expect(trimNewlines('A\n\n\n\nB\n\n\n\nC')).toBe('A\n\nB\n\nC');
  });
});

// =============================================================================
// newlineTrimmerMiddleware
// =============================================================================

describe('newlineTrimmerMiddleware', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn();
  });

  // ===========================================================================
  // String content
  // ===========================================================================

  describe('string content', () => {
    it('should trim leading newlines from string content', async () => {
      handler.mockResolvedValue(new AIMessage({ content: '\n\nHello world' }));

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Hello world');
    });

    it('should trim trailing newlines from string content', async () => {
      handler.mockResolvedValue(new AIMessage({ content: 'Hello world\n\n\n' }));

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Hello world');
    });

    it('should collapse excessive interior newlines in string content', async () => {
      handler.mockResolvedValue(new AIMessage({ content: 'Paragraph one\n\n\n\nParagraph two' }));

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Paragraph one\n\nParagraph two');
    });

    it('should return original message when string content has no excessive newlines', async () => {
      const original = new AIMessage({ content: 'Clean text\n\nWith paragraph' });
      handler.mockResolvedValue(original);

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result).toBe(original);
    });
  });

  // ===========================================================================
  // Array content — text blocks
  // ===========================================================================

  describe('text blocks', () => {
    it('should trim leading newlines from text block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [{ type: 'text', text: '\n\nHere is my response' }],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; text: string }>;

      expect(blocks[0]!.text).toBe('Here is my response');
    });

    it('should trim trailing newlines from text block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [{ type: 'text', text: 'Response text\n\n\n' }],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; text: string }>;

      expect(blocks[0]!.text).toBe('Response text');
    });

    it('should collapse excessive interior newlines in text block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [{ type: 'text', text: 'First\n\n\n\n\nSecond' }],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; text: string }>;

      expect(blocks[0]!.text).toBe('First\n\nSecond');
    });

    it('should return original message when text block has no excessive newlines', async () => {
      const original = new AIMessage({
        content: [{ type: 'text', text: 'Clean response' }],
      });
      handler.mockResolvedValue(original);

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result).toBe(original);
    });
  });

  // ===========================================================================
  // Array content — reasoning blocks
  // ===========================================================================

  describe('reasoning blocks', () => {
    it('should trim leading newlines from reasoning block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: '\n\nReviewing the implementation' },
            { type: 'text', text: 'Here is my answer' },
          ],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string; text?: string }>;

      expect(blocks[0]!.reasoning).toBe('Reviewing the implementation');
      expect(blocks[1]!.text).toBe('Here is my answer');
    });

    it('should trim trailing newlines from reasoning block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: 'Thinking about this\n\n\n' },
            { type: 'text', text: 'Done' },
          ],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string }>;

      expect(blocks[0]!.reasoning).toBe('Thinking about this');
    });

    it('should collapse excessive interior newlines in reasoning block', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [{ type: 'reasoning', reasoning: 'Step 1\n\n\n\nStep 2\n\n\n\n\nStep 3' }],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string }>;

      expect(blocks[0]!.reasoning).toBe('Step 1\n\nStep 2\n\nStep 3');
    });

    it('should return original message when reasoning has no excessive newlines', async () => {
      const original = new AIMessage({
        content: [
          { type: 'reasoning', reasoning: 'Clean reasoning' },
          { type: 'text', text: 'Response' },
        ],
      });
      handler.mockResolvedValue(original);

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result).toBe(original);
    });
  });

  // ===========================================================================
  // Mixed content
  // ===========================================================================

  describe('mixed content', () => {
    it('should trim both reasoning and text blocks in one message', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: '\n\nLet me think\n\n\n' },
            { type: 'text', text: '\n\nHere is my answer\n\n' },
          ],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string; text?: string }>;

      expect(blocks[0]!.reasoning).toBe('Let me think');
      expect(blocks[1]!.text).toBe('Here is my answer');
    });

    it('should trim only blocks that need it, leaving others unchanged', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: 'Clean reasoning' },
            { type: 'text', text: '\n\nNeeds trimming' },
          ],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<{ type: string; reasoning?: string; text?: string }>;

      expect(blocks[0]!.reasoning).toBe('Clean reasoning');
      expect(blocks[1]!.text).toBe('Needs trimming');
    });

    it('should not modify non-text, non-reasoning blocks', async () => {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain multimodal content block format
      const imageBlock = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
      handler.mockResolvedValue(
        new AIMessage({
          content: [imageBlock, { type: 'text', text: '\n\nCaption' }],
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;
      const blocks = result.content as Array<Record<string, unknown>>;

      expect(blocks[0]).toEqual(imageBlock);
      expect(blocks[1]).toEqual({ type: 'text', text: 'Caption' });
    });
  });

  // ===========================================================================
  // Property preservation
  // ===========================================================================

  describe('property preservation', () => {
    it('should preserve message id after trimming', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nTrimmed',
          id: 'msg_abc123',
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.id).toBe('msg_abc123');
      expect(result.content).toBe('Trimmed');
    });

    it('should preserve tool_calls after trimming', async () => {
      const toolCalls = [{ id: 'call_1', name: 'read_file', args: { path: '/main.ts' } }];
      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nLet me read the file',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: toolCalls,
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Let me read the file');
      expect(result.tool_calls).toEqual(toolCalls);
    });

    it('should preserve additional_kwargs after trimming', async () => {
      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nResponse',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          additional_kwargs: { custom: 'value' },
        }),
      );

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Response');
      expect(result.additional_kwargs).toEqual({ custom: 'value' });
    });

    it('should preserve response_metadata after trimming string content', async () => {
      /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
      const responseMetadata = { model: 'claude-3-5-sonnet-20241022', stop_reason: 'end_turn' };
      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nResponse',
          response_metadata: responseMetadata,
        }),
      );
      /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Response');
      expect(result.response_metadata).toEqual(responseMetadata);
    });

    it('should preserve usage_metadata after trimming string content', async () => {
      /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
      const usageMetadata = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 80, cache_creation: 20 },
      };
      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nResponse',
          usage_metadata: usageMetadata,
        }),
      );
      /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Response');
      expect(result.usage_metadata).toEqual(usageMetadata);
    });

    it('should preserve all metadata properties together when trimming string content', async () => {
      /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
      const toolCalls = [{ id: 'call_1', name: 'read_file', args: { path: '/main.ts' } }];
      const responseMetadata = { model: 'claude-3-5-sonnet-20241022' };
      const usageMetadata = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { cache_read: 80, cache_creation: 20 },
      };
      const additionalKwargs = { custom: 'value' };

      handler.mockResolvedValue(
        new AIMessage({
          content: '\n\nTrimmed response',
          id: 'msg_full_check',
          tool_calls: toolCalls,
          additional_kwargs: additionalKwargs,
          response_metadata: responseMetadata,
          usage_metadata: usageMetadata,
        }),
      );
      /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      expect(result.content).toBe('Trimmed response');
      expect(result.id).toBe('msg_full_check');
      expect(result.tool_calls).toEqual(toolCalls);
      expect(result.additional_kwargs).toEqual(additionalKwargs);
      expect(result.response_metadata).toEqual(responseMetadata);
      expect(result.usage_metadata).toEqual(usageMetadata);
    });

    it('should preserve all metadata properties together when trimming array content', async () => {
      /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
      const toolCalls = [{ id: 'call_2', name: 'edit_file', args: {} }];
      const responseMetadata = { model: 'gpt-4o-2024-05-13' };
      const usageMetadata = {
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        input_token_details: { cache_read: 0, cache_creation: 0 },
      };
      const additionalKwargs = { function_call: { name: 'test' } };

      handler.mockResolvedValue(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: '\n\nLet me think' },
            { type: 'text', text: '\n\nHere is my answer' },
          ],
          id: 'msg_array_check',
          tool_calls: toolCalls,
          additional_kwargs: additionalKwargs,
          response_metadata: responseMetadata,
          usage_metadata: usageMetadata,
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- AIMessage constructor union type inference
        } as any),
      );
      /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

      const result = (await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [] }, handler)) as AIMessage;

      const blocks = result.content as Array<{ type: string; reasoning?: string; text?: string }>;
      expect(blocks[0]!.reasoning).toBe('Let me think');
      expect(blocks[1]!.text).toBe('Here is my answer');
      expect(result.id).toBe('msg_array_check');
      expect(result.tool_calls).toEqual(toolCalls);
      expect(result.additional_kwargs).toEqual(additionalKwargs);
      expect(result.response_metadata).toEqual(responseMetadata);
      expect(result.usage_metadata).toEqual(usageMetadata);
    });
  });

  // ===========================================================================
  // Handler passthrough
  // ===========================================================================

  describe('handler passthrough', () => {
    it('should forward the request to the handler unchanged', async () => {
      const humanMessage = new HumanMessage('Hello');
      handler.mockResolvedValue(new AIMessage({ content: 'Hi' }));

      await invokeWrapModelCall(newlineTrimmerMiddleware, { messages: [humanMessage] }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [passedRequest] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      expect(passedRequest.messages[0]).toBe(humanMessage);
    });
  });
});
