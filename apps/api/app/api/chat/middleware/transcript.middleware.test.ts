/* eslint-disable @typescript-eslint/naming-convention -- LangChain message properties use snake_case */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createTranscriptMiddleware } from '#api/chat/middleware/transcript.middleware.js';
import type { ChatRpcService } from '#api/chat/chat-rpc.service.js';
import { invokeWrapToolCall, resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

describe('createTranscriptMiddleware', () => {
  let chatRpcService: ReturnType<typeof mock<ChatRpcService>>;

  beforeEach(() => {
    vi.clearAllMocks();
    chatRpcService = mock<ChatRpcService>();
    chatRpcService.sendRpcRequest.mockResolvedValue({
      success: true,
      message: 'Appended',
      bytesWritten: 100,
    });
  });

  describe('beforeModel', () => {
    it('should append user message with full content', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const beforeModel = resolveMiddlewareHook(middleware.beforeModel);

      const humanMessage = new HumanMessage('Create a cube with 20mm sides');

      beforeModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [humanMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      expect(call).toMatchObject({
        chatId: 'chat-1',
        rpcName: 'append_file',
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining returns any
        args: expect.objectContaining({
          targetFile: '.tau/transcripts/chat-1.jsonl',
        }),
      });

      const { content } = (call as { args: { content: string } }).args;
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        role: 'user',
        content: 'Create a cube with 20mm sides',
      });
      expect(parsed['timestamp']).toBeDefined();
    });

    it('should only log user message once across multiple beforeModel calls', () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const beforeModel = resolveMiddlewareHook(middleware.beforeModel);

      const humanMessage = new HumanMessage('hello');
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Partial mock state/runtime for middleware testing
      const state = { messages: [humanMessage] } as any;
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Partial mock state/runtime for middleware testing
      const runtime = { context: { chatId: 'chat-1' } } as any;

      beforeModel(state, runtime);
      beforeModel(state, runtime);
      beforeModel(state, runtime);

      expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
    });

    it('should find the last HumanMessage in messages array', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const beforeModel = resolveMiddlewareHook(middleware.beforeModel);

      const messages = [
        new HumanMessage('first question'),
        new AIMessage('first answer'),
        new HumanMessage('second question'),
      ];

      beforeModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed['content']).toBe('second question');
    });

    it('should not append when no HumanMessage exists', () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const beforeModel = resolveMiddlewareHook(middleware.beforeModel);

      beforeModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [new AIMessage('only AI')] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      expect(chatRpcService.sendRpcRequest).not.toHaveBeenCalled();
    });
  });

  describe('afterModel', () => {
    it('should append assistant message with full string content', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage('I will create a box with 20mm sides using OpenSCAD. Here is the code...');

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        role: 'assistant',
        content: 'I will create a box with 20mm sides using OpenSCAD. Here is the code...',
      });
      expect(parsed['timestamp']).toBeDefined();
      expect(parsed['type']).toBeUndefined();
    });

    it('should batch reasoning and text content blocks into a single RPC', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage({
        content: [
          { type: 'reasoning', reasoning: 'The user wants a cube.', signature: 'opaque-binary-data-here' },
          { type: 'text', text: 'I will create a cube for you.' },
        ],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const rawContent = (call as { args: { content: string } }).args.content;
      const lines = rawContent.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed0 = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed0).toMatchObject({
        role: 'assistant',
        type: 'thinking',
        content: 'The user wants a cube.',
      });

      const parsed1 = JSON.parse(lines[1]!) as Record<string, unknown>;
      expect(parsed1).toMatchObject({
        role: 'assistant',
        content: 'I will create a cube for you.',
      });
      expect(parsed1['type']).toBeUndefined();
    });

    it('should drop signatures from reasoning blocks', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage({
        content: [
          {
            type: 'reasoning',
            reasoning: 'Let me analyze this.',
            signature: 'Et0BCkYIDBgCKkCZX5oIyZ+UmUCy25Wpj5QGh+jfttJs==',
          },
        ],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      expect(content).not.toContain('signature');
      expect(content).not.toContain('Et0BCkY');
      expect(content).not.toContain('"reasoning"');
    });

    it('should skip tool_use blocks (captured by wrapToolCall)', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage({
        content: [
          { type: 'text', text: 'Let me read the file.' },
          { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'main.scad' } },
        ],
        tool_calls: [{ name: 'read_file', id: 'tc1', args: { path: 'main.scad' } }],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const rawContent = (call as { args: { content: string } }).args.content;
      expect(rawContent).not.toContain('tool_use');
      expect(rawContent).not.toContain('read_file');
    });

    it('should store full content, not a truncated preview', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const longContent = 'A'.repeat(1000);
      const aiMessage = new AIMessage(longContent);

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed['content']).toBe(longContent);
      expect((parsed['content'] as string).length).toBe(1000);
    });

    it('should emit all expected blocks for a realistic reasoning+text+tool_use message', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage({
        content: [
          { type: 'reasoning', reasoning: 'The user wants a cube with 20mm sides. I need to write OpenSCAD code.' },
          { type: 'text', text: "I'll create a 20mm cube for you." },
          { type: 'tool_use', id: 'tc1', name: 'edit_file', input: { path: 'main.scad', content: 'cube(20);' } },
        ],
        tool_calls: [{ name: 'edit_file', id: 'tc1', args: { path: 'main.scad', content: 'cube(20);' } }],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const rawContent = (call as { args: { content: string } }).args.content;
      const jsonLines = rawContent.trim().split('\n');
      expect(jsonLines).toHaveLength(2);

      const parsed0 = JSON.parse(jsonLines[0]!) as Record<string, unknown>;
      expect(parsed0).toMatchObject({
        role: 'assistant',
        type: 'thinking',
        content: 'The user wants a cube with 20mm sides. I need to write OpenSCAD code.',
      });
      expect(parsed0['timestamp']).toBeDefined();

      const parsed1 = JSON.parse(jsonLines[1]!) as Record<string, unknown>;
      expect(parsed1).toMatchObject({
        role: 'assistant',
        content: "I'll create a 20mm cube for you.",
      });
      expect(parsed1['type']).toBeUndefined();
      expect(parsed1['timestamp']).toBeDefined();
    });

    it('should coalesce adjacent reasoning blocks into a single thinking entry', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const aiMessage = new AIMessage({
        content: [
          { type: 'reasoning', reasoning: 'First thought: analyze the request.' },
          { type: 'reasoning', reasoning: 'Second thought: plan the implementation.' },
          { type: 'text', text: 'Here is my plan.' },
        ],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const rawContent = (call as { args: { content: string } }).args.content;
      const jsonLines = rawContent.trim().split('\n');
      expect(jsonLines).toHaveLength(2);

      const parsed0 = JSON.parse(jsonLines[0]!) as Record<string, unknown>;
      expect(parsed0).toMatchObject({
        role: 'assistant',
        type: 'thinking',
        content: 'First thought: analyze the request.Second thought: plan the implementation.',
      });

      const parsed1 = JSON.parse(jsonLines[1]!) as Record<string, unknown>;
      expect(parsed1).toMatchObject({ role: 'assistant', content: 'Here is my plan.' });
      expect(parsed1['type']).toBeUndefined();
    });

    it('should coalesce hundreds of streaming reasoning chunks into one RPC', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      const chunkCount = 500;
      const reasoningChunks = Array.from(
        { length: chunkCount },
        (_, i) =>
          ({
            type: 'reasoning',
            reasoning: `chunk${i} `,
          }) as const,
      );

      const aiMessage = new AIMessage({
        content: [...reasoningChunks, { type: 'text', text: 'Done thinking.' } as const],
      });

      afterModel(
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { messages: [aiMessage] } as any,
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
        { context: { chatId: 'chat-1' } } as any,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalledTimes(1);
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const rawContent = (call as { args: { content: string } }).args.content;
      const jsonLines = rawContent.trim().split('\n');
      expect(jsonLines).toHaveLength(2);

      const parsed0 = JSON.parse(jsonLines[0]!) as Record<string, unknown>;
      expect(parsed0['type']).toBe('thinking');
      expect((parsed0['content'] as string).startsWith('chunk0 chunk1 ')).toBe(true);
      expect((parsed0['content'] as string).endsWith(`chunk${chunkCount - 1} `)).toBe(true);
    });

    it('should not throw when no last message', () => {
      const middleware = createTranscriptMiddleware(chatRpcService);
      const afterModel = resolveMiddlewareHook(middleware.afterModel);

      expect(() => {
        afterModel(
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
          { messages: [] } as any,
          // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
          { context: { chatId: 'chat-1' } } as any,
        );
      }).not.toThrow();
    });
  });

  describe('wrapToolCall', () => {
    it('should append tool result as metadata-only JSONL line', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);

      const toolResult = new ToolMessage({
        content: 'file contents here...',
        tool_call_id: 'tc1',
        name: 'read_file',
      });

      const handler = vi.fn().mockResolvedValue(toolResult);

      await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'read_file', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        role: 'tool',
        toolName: 'read_file',
        toolCallId: 'tc1',
      });
      expect(parsed['contentLength']).toBe('file contents here...'.length);
    });

    it('should handle appendFile RPC failures gracefully', async () => {
      chatRpcService.sendRpcRequest.mockRejectedValue(new Error('RPC failed'));

      const middleware = createTranscriptMiddleware(chatRpcService);

      const toolResult = new ToolMessage({
        content: 'result',
        tool_call_id: 'tc1',
        name: 'read_file',
      });

      const handler = vi.fn().mockResolvedValue(toolResult);

      const result = await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'read_file', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      expect(result).toBe(toolResult);
    });

    it('should not include full tool result content in transcript', async () => {
      const middleware = createTranscriptMiddleware(chatRpcService);

      const largeContent = 'X'.repeat(10_000);
      const toolResult = new ToolMessage({
        content: largeContent,
        tool_call_id: 'tc1',
        name: 'read_file',
      });

      const handler = vi.fn().mockResolvedValue(toolResult);

      await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'read_file', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      await vi.waitFor(() => {
        expect(chatRpcService.sendRpcRequest).toHaveBeenCalled();
      });

      const call = chatRpcService.sendRpcRequest.mock.calls[0]![0];
      const { content } = (call as { args: { content: string } }).args;
      expect(content.length).toBeLessThan(largeContent.length);
      const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(parsed['contentLength']).toBe(10_000);
    });
  });
});
