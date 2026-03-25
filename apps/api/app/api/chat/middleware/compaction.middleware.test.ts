/* eslint-disable @typescript-eslint/naming-convention -- Langchain naming convetion */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ContextOverflowError } from '@langchain/core/errors';
import { createCompactionMiddleware, findSafeCutoffPoint } from '#api/chat/middleware/compaction.middleware.js';
import type { CompactionService } from '#api/chat/compaction.service.js';
import type { TauRpcBackend, TauRpcBackendFactory } from '#api/chat/tau-rpc-backend.js';
import type { ModelService } from '#api/models/model.service.js';
import type { ChatRpcService } from '#api/chat/chat-rpc.service.js';

vi.mock('@taucad/utils/id', () => ({
  generatePrefixedId: vi.fn(() => 'dat_test_123'),
}));

vi.mock('#api/chat/middleware/transcript.middleware.js', () => ({
  appendTranscriptLine: vi.fn(),
}));

describe('findSafeCutoffPoint', () => {
  it('should keep requested number of messages when no split needed', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('hello'),
      new AIMessage('hi'),
      new HumanMessage('question'),
      new AIMessage('answer'),
    ];

    expect(findSafeCutoffPoint(messages, 2)).toBe(2);
  });

  it('should never split AI/Tool message pairs', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('hello'),
      new AIMessage({ content: 'let me check', tool_calls: [{ name: 'read_file', id: 'tc1', args: {} }] }),
      new ToolMessage({ content: 'file contents', tool_call_id: 'tc1' }),
      new HumanMessage('thanks'),
      new AIMessage('you are welcome'),
    ];

    // Trying to keep 3 would split at index 2 (ToolMessage)
    // Should extend to keep the AIMessage before it too
    const keep = findSafeCutoffPoint(messages, 3);
    expect(keep).toBeGreaterThanOrEqual(3);

    const cutoff = messages.length - keep;
    const messageAtCutoff = messages[cutoff];
    expect(messageAtCutoff).not.toBeInstanceOf(ToolMessage);
  });

  it('should walk past consecutive ToolMessages to their AIMessage', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('start'),
      new AIMessage({
        content: 'calling tools',
        tool_calls: [
          { name: 'tool_a', id: 'tc1', args: {} },
          { name: 'tool_b', id: 'tc2', args: {} },
        ],
      }),
      new ToolMessage({ content: 'result a', tool_call_id: 'tc1' }),
      new ToolMessage({ content: 'result b', tool_call_id: 'tc2' }),
      new HumanMessage('follow up'),
      new AIMessage('final answer'),
    ];

    // Requesting keep=3 would place cutoff at index 3 (a ToolMessage).
    // Should walk back past both ToolMessages to the AIMessage at index 1.
    const keep = findSafeCutoffPoint(messages, 3);
    expect(keep).toBe(5); // Keeps indices 1-5

    const cutoff = messages.length - keep;
    expect(messages[cutoff]).toBeInstanceOf(AIMessage);
  });

  it('should handle empty messages array', () => {
    expect(findSafeCutoffPoint([], 5)).toBe(0);
  });
});

describe('createCompactionMiddleware', () => {
  let compactionService: ReturnType<typeof mock<CompactionService>>;
  let rpcBackendFactory: ReturnType<typeof mock<TauRpcBackendFactory>>;
  let mockBackend: ReturnType<typeof mock<TauRpcBackend>>;
  let chatRpcService: ReturnType<typeof mock<ChatRpcService>>;
  let mockModelService: { getContextWindow: ReturnType<typeof vi.fn> };
  let writer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    compactionService = mock<CompactionService>();
    rpcBackendFactory = mock<TauRpcBackendFactory>();
    mockBackend = mock<TauRpcBackend>();
    chatRpcService = mock<ChatRpcService>();
    rpcBackendFactory.create.mockReturnValue(mockBackend);
    mockBackend.append.mockResolvedValue({ path: 'test', filesUpdate: null });
    mockModelService = { getContextWindow: vi.fn().mockReturnValue(200_000) };
    writer = vi.fn();
  });

  const createMiddlewareInstance = () =>
    createCompactionMiddleware(compactionService, rpcBackendFactory, chatRpcService);

  const createContext = (contextWindow = 200_000) => {
    mockModelService.getContextWindow.mockReturnValue(contextWindow);
    return {
      chatId: 'chat-1',
      modelId: 'test-model',
      modelService: mockModelService as unknown as ModelService,
    };
  };

  it('should not trigger compaction below threshold', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const messages: BaseMessage[] = [new HumanMessage('short message'), new AIMessage('short reply')];

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(compactionService.compact).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ messages }));
  });

  it('should skip compaction when targetKeep covers all messages', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    // 4 messages with a tiny context window — triggers threshold but targetKeep = max(4, ...) = 4 = messages.length
    const longContent = 'A'.repeat(4000);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('recent'),
      new AIMessage('recent reply'),
    ];

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(1000), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(compactionService.compact).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should trigger compaction at threshold', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const longContent = 'A'.repeat(4000);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('middle question'),
      new AIMessage('middle answer'),
      new HumanMessage('recent'),
      new AIMessage('recent reply'),
    ];

    compactionService.compact.mockResolvedValue({
      compactedMessages: [new HumanMessage('[Compacted conversation history]\ncompacted')],
      stats: {
        tokensBeforeCompaction: 2000,
        tokensAfterCompaction: 50,
        compressionRatio: 0.025,
        messagesEvicted: 2,
      },
    });

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(1000), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(compactionService.compact).toHaveBeenCalled();
  });

  it('should return handler result after compaction (stream continues)', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const longContent = 'A'.repeat(4000);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('middle question'),
      new AIMessage('middle answer'),
      new HumanMessage('recent'),
      new AIMessage('recent reply'),
    ];

    compactionService.compact.mockResolvedValue({
      compactedMessages: [new HumanMessage('[Compacted conversation history]\ncompacted')],
      stats: {
        tokensBeforeCompaction: 2000,
        tokensAfterCompaction: 50,
        compressionRatio: 0.025,
        messagesEvicted: 2,
      },
    });

    const streamResult = { type: 'stream', chunks: ['chunk1', 'chunk2'] };
    const handler = vi.fn().mockResolvedValue(streamResult);

    const result = await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(1000), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(compactionService.compact).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toBe(streamResult);
  });

  it('should emit writer data part on compaction', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const longContent = 'A'.repeat(4000);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('middle question'),
      new AIMessage('middle answer'),
      new HumanMessage('recent question'),
      new AIMessage('recent answer'),
    ];

    compactionService.compact.mockResolvedValue({
      compactedMessages: [new HumanMessage('[Compacted conversation history]\ncompacted')],
      stats: {
        tokensBeforeCompaction: 2000,
        tokensAfterCompaction: 50,
        compressionRatio: 0.025,
        messagesEvicted: 2,
      },
    });

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(1000), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context-compaction',
        tokensBeforeCompaction: 2000,
        tokensAfterCompaction: 50,
      }),
    );
  });

  it('should catch ContextOverflowError and re-compact', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const messages: BaseMessage[] = [new HumanMessage('msg1'), new AIMessage('msg2')];

    const handler = vi
      .fn()
      .mockRejectedValueOnce(new ContextOverflowError('overflow'))
      .mockResolvedValueOnce(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should re-throw non-overflow errors', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const handler = vi.fn().mockRejectedValue(new Error('other error'));

    await expect(
      wrapModelCall(
        {
          messages: [new HumanMessage('test')],
          tools: [],
          systemMessage: '',
          runtime: { context: createContext(), writer },
        } as unknown as Parameters<typeof wrapModelCall>[0],
        handler,
      ),
    ).rejects.toThrow('other error');
  });

  it('should use model context window from modelService', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const longContent = 'A'.repeat(400);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('middle question'),
      new AIMessage('middle answer'),
      new HumanMessage('recent'),
      new AIMessage('recent reply'),
    ];

    compactionService.compact.mockResolvedValue({
      compactedMessages: [new HumanMessage('[Compacted conversation history]\ncompacted')],
      stats: {
        tokensBeforeCompaction: 200,
        tokensAfterCompaction: 10,
        compressionRatio: 0.05,
        messagesEvicted: 2,
      },
    });

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(100), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(mockModelService.getContextWindow).toHaveBeenCalledWith('test-model');
    expect(compactionService.compact).toHaveBeenCalled();
  });

  it('should fall back to truncated messages when Morph API fails', async () => {
    const middleware = createMiddlewareInstance();
    const { wrapModelCall } = middleware;
    if (!wrapModelCall) {
      throw new Error('wrapModelCall not defined');
    }

    const longContent = 'A'.repeat(4000);
    const messages: BaseMessage[] = [
      new HumanMessage(longContent),
      new AIMessage(longContent),
      new HumanMessage('middle question'),
      new AIMessage('middle answer'),
      new HumanMessage('recent'),
      new AIMessage('recent reply'),
    ];

    compactionService.compact.mockRejectedValue(new Error('Morph API down'));

    const handler = vi.fn().mockResolvedValue(undefined);

    await wrapModelCall(
      {
        messages,
        tools: [],
        systemMessage: '',
        runtime: { context: createContext(1000), writer },
      } as unknown as Parameters<typeof wrapModelCall>[0],
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context-compaction',
        compressionRatio: 1,
        messagesEvicted: 0,
      }),
    );
  });
});
