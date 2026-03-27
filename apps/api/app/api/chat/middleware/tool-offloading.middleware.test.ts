/* eslint-disable @typescript-eslint/naming-convention -- LangChain message properties use snake_case */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ToolMessage } from '@langchain/core/messages';
import { createToolOffloadingMiddleware } from '#api/chat/middleware/tool-offloading.middleware.js';
import type { TauRpcBackendFactory, TauRpcBackend } from '#api/chat/tau-rpc-backend.js';
import { invokeWrapToolCall } from '#testing/middleware-testing.utils.js';

describe('createToolOffloadingMiddleware', () => {
  let rpcBackendFactory: ReturnType<typeof mock<TauRpcBackendFactory>>;
  let mockBackend: ReturnType<typeof mock<TauRpcBackend>>;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcBackendFactory = mock<TauRpcBackendFactory>();
    mockBackend = mock<TauRpcBackend>();
    rpcBackendFactory.create.mockReturnValue(mockBackend);
    mockBackend.write.mockResolvedValue({ path: 'test', filesUpdate: null });
  });

  it('should pass through small tool results unchanged', async () => {
    const middleware = createToolOffloadingMiddleware(rpcBackendFactory);

    const smallResult = new ToolMessage({
      content: 'small result',
      tool_call_id: 'tc1',
      name: 'web_search',
    });

    const handler = vi.fn().mockResolvedValue(smallResult);

    const result = await invokeWrapToolCall(
      middleware,
      {
        toolCall: { name: 'web_search', id: 'tc1', args: {} },
        runtime: { context: { chatId: 'chat-1' } },
      },
      handler,
    );

    expect(result).toBe(smallResult);
    expect(mockBackend.write).not.toHaveBeenCalled();
  });

  it('should offload results exceeding token threshold', async () => {
    const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

    const largeContent = 'X'.repeat(200);
    const largeResult = new ToolMessage({
      content: largeContent,
      tool_call_id: 'tc1',
      name: 'web_search',
    });

    const handler = vi.fn().mockResolvedValue(largeResult);

    const result = await invokeWrapToolCall(
      middleware,
      {
        toolCall: { name: 'web_search', id: 'tc1', args: {} },
        runtime: { context: { chatId: 'chat-1' } },
      },
      handler,
    );

    expect(result).toBeInstanceOf(ToolMessage);
    const toolResult = result as ToolMessage;
    expect(toolResult.content).toContain('Tool result too large');
    expect(toolResult.content).toContain('.tau/offloaded-tool-results/tc1.txt');
    expect(mockBackend.write).toHaveBeenCalledWith('.tau/offloaded-tool-results/tc1.txt', largeContent);
  });

  it('should create head+tail preview with truncation marker', async () => {
    const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const largeContent = lines.join('\n');
    const largeResult = new ToolMessage({
      content: largeContent,
      tool_call_id: 'tc2',
      name: 'web_search',
    });

    const handler = vi.fn().mockResolvedValue(largeResult);

    const result = await invokeWrapToolCall(
      middleware,
      {
        toolCall: { name: 'web_search', id: 'tc2', args: {} },
        runtime: { context: { chatId: 'chat-1' } },
      },
      handler,
    );

    const content = (result as ToolMessage).content as string;
    expect(content).toContain('line 1');
    expect(content).toContain('line 50');
    expect(content).toContain('lines truncated');
  });

  it.each(['list_directory', 'glob_search', 'grep', 'read_file', 'edit_file', 'create_file', 'delete_file'])(
    'should skip excluded tool: %s',
    async (toolName) => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const largeContent = 'X'.repeat(200);
      const largeResult = new ToolMessage({
        content: largeContent,
        tool_call_id: 'tc1',
        name: toolName,
      });

      const handler = vi.fn().mockResolvedValue(largeResult);

      const result = await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: toolName, id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      expect(result).toBe(largeResult);
    },
  );

  it('should handle RPC write failures gracefully', async () => {
    const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

    mockBackend.write.mockRejectedValue(new Error('Write failed'));

    const largeContent = 'X'.repeat(200);
    const largeResult = new ToolMessage({
      content: largeContent,
      tool_call_id: 'tc1',
      name: 'web_search',
    });

    const handler = vi.fn().mockResolvedValue(largeResult);

    const result = await invokeWrapToolCall(
      middleware,
      {
        toolCall: { name: 'web_search', id: 'tc1', args: {} },
        runtime: { context: { chatId: 'chat-1' } },
      },
      handler,
    );

    // Should return original result when write fails
    expect(result).toBe(largeResult);
  });
});
