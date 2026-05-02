import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCrossProviderContentNormalizerMiddleware } from '#api/chat/middleware/cross-provider-content-normalizer.middleware.js';
import { invokeWrapModelCall } from '#testing/middleware-testing.utils.js';

describe('createCrossProviderContentNormalizerMiddleware', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue({ content: 'response' });
  });

  it('maps Anthropic thinking to reasoning and keeps signature when target is anthropic', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('anthropic');
    const aiMessage = new AIMessage({
      content: [
        {
          type: 'thinking',
          thinking: 'plan step',
          signature: 'sig-anthropic',
        },
      ],
    });
    const messages: BaseMessage[] = [new HumanMessage('hi'), aiMessage];

    await invokeWrapModelCall(middleware, { messages }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    const out = request.messages[1] as AIMessage;
    expect(out.content).toEqual([{ type: 'reasoning', reasoning: 'plan step', signature: 'sig-anthropic' }]);
  });

  it('maps thinking to reasoning and drops signature when target is not anthropic', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('vertexai');
    const aiMessage = new AIMessage({
      content: [{ type: 'thinking', thinking: 'plan step', signature: 'sig-anthropic' }],
    });

    await invokeWrapModelCall(middleware, { messages: [aiMessage] }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect((request.messages[0] as AIMessage).content).toEqual([{ type: 'reasoning', reasoning: 'plan step' }]);
  });

  it('wraps redacted_thinking and compaction as non_standard', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('openai');
    const redacted = { type: 'redacted_thinking', data: 'x' };
    const compaction = { type: 'compaction', id: 'c1' };
    const aiMessage = new AIMessage({
      content: [redacted, compaction],
    });

    await invokeWrapModelCall(middleware, { messages: [aiMessage] }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect((request.messages[0] as AIMessage).content).toEqual([
      { type: 'non_standard', value: redacted },
      { type: 'non_standard', value: compaction },
    ]);
  });

  it('passes through V1 reasoning unchanged when already normalized (idempotent)', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('anthropic');
    const aiMessage = new AIMessage({
      content: [{ type: 'reasoning', reasoning: 'already v1', signature: 's' }],
    });

    await invokeWrapModelCall(middleware, { messages: [aiMessage] }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect(request.messages[0]).toBe(aiMessage);
  });

  it('strips signature from reasoning when target is not anthropic', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('together');
    const aiMessage = new AIMessage({
      content: [{ type: 'reasoning', reasoning: 'r', signature: 'sig' }],
    });

    await invokeWrapModelCall(middleware, { messages: [aiMessage] }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect((request.messages[0] as AIMessage).content).toEqual([{ type: 'reasoning', reasoning: 'r' }]);
  });

  it('does not modify HumanMessage, ToolMessage, or string AIMessage content', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('vertexai');
    const human = new HumanMessage('hello');
    const tool = new ToolMessage({ content: '{}', tool_call_id: 't1', name: 'read_file' });
    const aiString = new AIMessage('plain');

    await invokeWrapModelCall(middleware, { messages: [human, tool, aiString] }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect(request.messages[0]).toBe(human);
    expect(request.messages[1]).toBe(tool);
    expect(request.messages[2]).toBe(aiString);
  });

  it('rewrites thinking in multiple AIMessages in one pass', async () => {
    const middleware = createCrossProviderContentNormalizerMiddleware('openai');
    const messages: BaseMessage[] = [
      new AIMessage({ content: [{ type: 'thinking', thinking: 'a', signature: 'x' }] }),
      new AIMessage({ content: [{ type: 'thinking', thinking: 'b', signature: 'y' }] }),
    ];

    await invokeWrapModelCall(middleware, { messages }, handler);

    const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
    expect((request.messages[0] as AIMessage).content).toEqual([{ type: 'reasoning', reasoning: 'a' }]);
    expect((request.messages[1] as AIMessage).content).toEqual([{ type: 'reasoning', reasoning: 'b' }]);
  });
});
