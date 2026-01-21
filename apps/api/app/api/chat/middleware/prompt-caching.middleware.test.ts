import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promptCachingMiddleware } from '#api/chat/middleware/prompt-caching.middleware.js';

// Helper type for the request shape we're testing
type TestRequest = { messages: BaseMessage[] };

// Helper to call wrapModelCall with proper typing
async function callWrapModelCall(request: TestRequest, handler: ReturnType<typeof vi.fn>): Promise<void> {
  const { wrapModelCall } = promptCachingMiddleware;
  if (!wrapModelCall) {
    throw new Error('wrapModelCall is not defined on middleware');
  }

  // Cast to the expected types - in tests we only care about messages
  await wrapModelCall(request as Parameters<typeof wrapModelCall>[0], handler);
}

/**
 * Type for content block with cache control.
 */
type ContentBlockWithCacheControl = {
  type: string;
  text?: string;
  cache_control?: { type: 'ephemeral' };
};

describe('promptCachingMiddleware', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue({ content: 'response' });
  });

  describe('caching HumanMessage (last message)', () => {
    it('should add cache_control to last HumanMessage with string content', async () => {
      const messages: BaseMessage[] = [new HumanMessage('What is the capital of France?')];

      await callWrapModelCall({ messages }, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const [request] = handler.mock.calls[0] as [TestRequest];

      const lastMessage = request.messages[0] as HumanMessage;
      expect(lastMessage.content).toBeInstanceOf(Array);

      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];
      expect(contentBlocks).toHaveLength(1);
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'What is the capital of France?',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should add cache_control to the last content block when HumanMessage has array content', async () => {
      const humanMessage = new HumanMessage({
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      });

      const messages: BaseMessage[] = [humanMessage];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const lastMessage = request.messages[0] as HumanMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];

      // First block should NOT have cache_control
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'First part',
      });

      // Last block SHOULD have cache_control
      expect(contentBlocks[1]).toEqual({
        type: 'text',
        text: 'Second part',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });
  });

  describe('caching AIMessage (last message)', () => {
    it('should add cache_control to last AIMessage with string content', async () => {
      const messages: BaseMessage[] = [new HumanMessage('Hello'), new AIMessage('Hi there!')];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // First message (HumanMessage) should NOT be modified
      const firstMessage = request.messages[0] as HumanMessage;
      expect(firstMessage.content).toBe('Hello');

      // Last message (AIMessage) should have cache_control
      const lastMessage = request.messages[1] as AIMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];
      expect(contentBlocks).toHaveLength(1);
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'Hi there!',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should add cache_control to AIMessage with array content', async () => {
      const aiMessage = new AIMessage({
        content: [
          { type: 'text', text: 'First thought' },
          { type: 'text', text: 'Second thought' },
        ],
      });

      const messages: BaseMessage[] = [aiMessage];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const lastMessage = request.messages[0] as AIMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];

      // First block should NOT have cache_control
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'First thought',
      });

      // Last block SHOULD have cache_control
      expect(contentBlocks[1]).toEqual({
        type: 'text',
        text: 'Second thought',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should add cache_control to AIMessage with empty content but tool_calls', async () => {
      const aiMessage = new AIMessage({
        content: '',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_calls: [{ id: 'call_123', name: 'read_file', args: { path: '/test.txt' } }],
      });

      const messages: BaseMessage[] = [aiMessage];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const lastMessage = request.messages[0] as AIMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];

      // Should create a text block with empty string and cache_control
      expect(contentBlocks).toHaveLength(1);
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: '',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });

      // Tool calls should be preserved
      expect(lastMessage.tool_calls).toHaveLength(1);
      expect(lastMessage.tool_calls?.[0]?.name).toBe('read_file');
    });
  });

  describe('caching ToolMessage (last message)', () => {
    it('should add cache_control to last ToolMessage with string content', async () => {
      const messages: BaseMessage[] = [
        new HumanMessage('Read the file'),
        new AIMessage({
          content: '',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [{ id: 'call_123', name: 'read_file', args: {} }],
        }),
        new ToolMessage({
          content: '{"content": "file contents", "totalLines": 10}',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_123',
          name: 'read_file',
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // First two messages should NOT be modified
      const humanMessage = request.messages[0] as HumanMessage;
      expect(humanMessage.content).toBe('Read the file');

      // Last message (ToolMessage) should have cache_control
      const toolMessage = request.messages[2] as ToolMessage;
      const contentBlocks = toolMessage.content as ContentBlockWithCacheControl[];
      expect(contentBlocks).toHaveLength(1);
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: '{"content": "file contents", "totalLines": 10}',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });

      // Tool call ID and name should be preserved
      expect(toolMessage.tool_call_id).toBe('call_123');
      expect(toolMessage.name).toBe('read_file');
    });

    it('should add cache_control to ToolMessage with array content', async () => {
      const toolMessage = new ToolMessage({
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_456',
        name: 'some_tool',
      });

      const messages: BaseMessage[] = [toolMessage];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const lastMessage = request.messages[0] as ToolMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];

      // First block should NOT have cache_control
      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'Part 1',
      });

      // Last block SHOULD have cache_control
      expect(contentBlocks[1]).toEqual({
        type: 'text',
        text: 'Part 2',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });
  });

  describe('agent turn simulation (multiple tool calls)', () => {
    it('should cache the last message in a typical agent turn flow', async () => {
      // Simulate: User → AI with tool_calls → Tool results (last message)
      const messages: BaseMessage[] = [
        new HumanMessage('Build a rounded rectangle plate'),
        new AIMessage({
          content: 'I will create the plate for you.',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_calls: [
            { id: 'call_1', name: 'create_file', args: { targetFile: 'main.ts' } },
            { id: 'call_2', name: 'get_kernel_result', args: {} },
          ],
        }),
        new ToolMessage({
          content: '{"success": true}',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_1',
          name: 'create_file',
        }),
        new ToolMessage({
          content: '{"status": "ready"}',
          // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
          tool_call_id: 'call_2',
          name: 'get_kernel_result',
        }),
      ];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // Only the LAST message should have cache_control
      // First 3 messages should NOT be modified
      expect((request.messages[0] as HumanMessage).content).toBe('Build a rounded rectangle plate');
      expect((request.messages[1] as AIMessage).content).toBe('I will create the plate for you.');
      expect((request.messages[2] as ToolMessage).content).toBe('{"success": true}');

      // Last ToolMessage should have cache_control
      const lastMessage = request.messages[3] as ToolMessage;
      const contentBlocks = lastMessage.content as ContentBlockWithCacheControl[];
      expect(contentBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', async () => {
      const messages: BaseMessage[] = [];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      expect(request.messages).toHaveLength(0);
    });

    it('should handle single message of any type', async () => {
      const messages: BaseMessage[] = [new HumanMessage('Hello!')];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];
      const message = request.messages[0] as HumanMessage;
      const contentBlocks = message.content as ContentBlockWithCacheControl[];

      expect(contentBlocks[0]).toEqual({
        type: 'text',
        text: 'Hello!',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        cache_control: { type: 'ephemeral' },
      });
    });
  });

  describe('immutability', () => {
    it('should not mutate the original messages array', async () => {
      const originalMessage = new HumanMessage('Original message');
      const messages: BaseMessage[] = [originalMessage];
      const originalMessagesLength = messages.length;

      await callWrapModelCall({ messages }, handler);

      // Original array should not be mutated
      expect(messages).toHaveLength(originalMessagesLength);
      // Original message should still have string content
      expect(originalMessage.content).toBe('Original message');
    });

    it('should create a new array with modified messages', async () => {
      const messages: BaseMessage[] = [new HumanMessage('Test')];

      await callWrapModelCall({ messages }, handler);

      const [request] = handler.mock.calls[0] as [TestRequest];

      // The returned array should be different from the input
      expect(request.messages).not.toBe(messages);
    });

    it('should not mutate original ToolMessage', async () => {
      const originalToolMessage = new ToolMessage({
        content: '{"result": "success"}',
        // eslint-disable-next-line @typescript-eslint/naming-convention -- LangChain API uses snake_case
        tool_call_id: 'call_123',
        name: 'test_tool',
      });
      const messages: BaseMessage[] = [originalToolMessage];

      await callWrapModelCall({ messages }, handler);

      // Original message should still have string content
      expect(originalToolMessage.content).toBe('{"result": "success"}');
    });
  });
});
