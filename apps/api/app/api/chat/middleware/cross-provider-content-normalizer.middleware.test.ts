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
    const tool = new ToolMessage({
      content: '{}',
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
      tool_call_id: 't1',
      name: 'read_file',
    });
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

  /* eslint-disable @typescript-eslint/naming-convention -- LangChain/OpenAI native content blocks use snake_case (image_url, input_image) throughout these test fixtures */
  describe('OpenAI ToolMessage content rewriting', () => {
    const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA';

    it('rewrites text + image_url (object form) to input_text + input_image for openai target', async () => {
      const middleware = createCrossProviderContentNormalizerMiddleware('openai');
      const tool = new ToolMessage({
        content: [
          { type: 'text', text: 'Inspector prompt' },
          { type: 'image_url', image_url: { url: screenshotDataUrl } },
        ],
        tool_call_id: 'call_screenshot',
        name: 'screenshot',
      });

      await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

      const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      const out = request.messages[0] as ToolMessage;
      expect(out.content).toEqual([
        { type: 'input_text', text: 'Inspector prompt' },
        { type: 'input_image', image_url: screenshotDataUrl, detail: 'auto' },
      ]);
      expect(out.tool_call_id).toBe('call_screenshot');
      expect(out.name).toBe('screenshot');
    });

    it('rewrites image_url string form to input_image for openai target', async () => {
      const middleware = createCrossProviderContentNormalizerMiddleware('openai');
      const tool = new ToolMessage({
        content: [{ type: 'image_url', image_url: screenshotDataUrl }],
        tool_call_id: 'call_screenshot_str',
        name: 'screenshot',
      });

      await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

      const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      const out = request.messages[0] as ToolMessage;
      expect(out.content).toEqual([{ type: 'input_image', image_url: screenshotDataUrl, detail: 'auto' }]);
    });

    it('produces a homogeneous input_* array (every block must be input_text|input_image|input_file)', async () => {
      const middleware = createCrossProviderContentNormalizerMiddleware('openai');
      const tool = new ToolMessage({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image_url', image_url: { url: screenshotDataUrl } },
          { type: 'text', text: 'two' },
        ],
        tool_call_id: 'call_mixed',
      });

      await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

      const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      const out = request.messages[0] as ToolMessage;
      const blocks = out.content as Array<{ type: string }>;
      const allInput = blocks.every(
        (b) => b.type === 'input_text' || b.type === 'input_image' || b.type === 'input_file',
      );
      expect(allInput).toBe(true);
      expect(blocks.find((b) => b.type === 'text')).toBeUndefined();
      expect(blocks.find((b) => b.type === 'image_url')).toBeUndefined();
    });

    it('passes through already-native input_image / input_text blocks unchanged', async () => {
      const middleware = createCrossProviderContentNormalizerMiddleware('openai');
      const native = [
        { type: 'input_text', text: 'already native' },
        { type: 'input_image', image_url: screenshotDataUrl, detail: 'high' },
      ];
      const tool = new ToolMessage({
        content: native,
        tool_call_id: 'call_native',
      });

      await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

      const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      expect(request.messages[0]).toBe(tool);
    });

    it('leaves string tool content untouched for openai target', async () => {
      const middleware = createCrossProviderContentNormalizerMiddleware('openai');
      const tool = new ToolMessage({
        content: '{"foo":"bar"}',
        tool_call_id: 'call_string',
        name: 'read_file',
      });

      await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

      const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
      expect(request.messages[0]).toBe(tool);
    });

    it.each(['anthropic', 'vertexai', 'cerebras', 'together', 'ollama'] as const)(
      'leaves screenshot-shaped ToolMessage byte-identical for %s target (cache-stability guard)',
      async (provider) => {
        const middleware = createCrossProviderContentNormalizerMiddleware(provider);
        const original = [
          { type: 'text', text: 'Inspector prompt' },
          { type: 'image_url', image_url: { url: screenshotDataUrl } },
        ];
        const tool = new ToolMessage({
          content: original,
          tool_call_id: 'call_screenshot',
          name: 'screenshot',
        });

        await invokeWrapModelCall(middleware, { messages: [tool] }, handler);

        const [request] = handler.mock.calls[0] as [{ messages: BaseMessage[] }];
        expect(request.messages[0]).toBe(tool);
        expect((request.messages[0] as ToolMessage).content).toBe(original);
      },
    );
  });
  /* eslint-enable @typescript-eslint/naming-convention -- end of LangChain/OpenAI native shape fixtures */
});
