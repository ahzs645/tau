/* eslint-disable @typescript-eslint/naming-convention -- LangChain message properties use snake_case */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ToolMessage } from '@langchain/core/messages';
import {
  createToolOffloadingMiddleware,
  compactLargeStrings,
} from '#api/chat/middleware/tool-offloading.middleware.js';
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

  it.each([
    'list_directory',
    'glob_search',
    'grep',
    'read_file',
    'edit_file',
    'create_file',
    'delete_file',
    'screenshot',
  ])('should skip excluded tool: %s', async (toolName) => {
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
  });

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

  // =========================================================================
  // Structure-preserving compaction
  // =========================================================================

  describe('structure-preserving compaction', () => {
    it('should compact large string values within JSON structure', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const toolOutput = {
        images: [{ view: 'composite', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(2000) }],
      };
      const jsonContent = JSON.stringify(toolOutput);
      const largeResult = new ToolMessage({
        content: jsonContent,
        tool_call_id: 'tc1',
        name: 'test_model',
      });

      const handler = vi.fn().mockResolvedValue(largeResult);

      const result = await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'test_model', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      const content = (result as ToolMessage).content as string;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const images = parsed['images'] as Array<Record<string, unknown>>;

      expect(images).toHaveLength(1);
      expect(images[0]!['view']).toBe('composite');
      expect(images[0]!['dataUrl']).toMatch(/^\[offloaded: \d+ chars]$/);
      expect(parsed['_offloadedTo']).toBe('.tau/offloaded-tool-results/tc1.txt');
    });

    it('should preserve small string values within the structure', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const output = {
        title: 'short title',
        description: 'X'.repeat(2000),
      };
      const jsonContent = JSON.stringify(output);
      const largeResult = new ToolMessage({
        content: jsonContent,
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

      const content = (result as ToolMessage).content as string;
      const parsed = JSON.parse(content) as Record<string, unknown>;

      expect(parsed['title']).toBe('short title');
      expect(parsed['description']).toMatch(/^\[offloaded: \d+ chars]$/);
    });

    it('should handle deeply nested structures', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const output = {
        level1: {
          level2: {
            small: 'keep',
            large: 'B'.repeat(2000),
          },
          items: [{ name: 'a', data: 'C'.repeat(2000) }],
        },
      };
      const jsonContent = JSON.stringify(output);
      const largeResult = new ToolMessage({
        content: jsonContent,
        tool_call_id: 'tc1',
        name: 'test_model',
      });

      const handler = vi.fn().mockResolvedValue(largeResult);

      const result = await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'test_model', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      const content = (result as ToolMessage).content as string;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const level1 = parsed['level1'] as Record<string, unknown>;
      const level2 = level1['level2'] as Record<string, unknown>;
      const items = level1['items'] as Array<Record<string, unknown>>;

      expect(level2['small']).toBe('keep');
      expect(level2['large']).toMatch(/^\[offloaded: 2000 chars]$/);
      expect(items[0]!['name']).toBe('a');
      expect(items[0]!['data']).toMatch(/^\[offloaded: 2000 chars]$/);
    });

    it('should fall back to flat-string replacement for non-JSON content', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const plainText = 'not valid JSON '.repeat(100);
      const largeResult = new ToolMessage({
        content: plainText,
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

      const content = (result as ToolMessage).content as string;
      expect(content).toContain('Tool result too large');
      expect(content).toContain('.tau/offloaded-tool-results/tc1.txt');
    });

    it('should write full original content to offloaded file', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const toolOutput = {
        images: [{ view: 'front', dataUrl: 'data:image/png;base64,' + 'D'.repeat(2000) }],
      };
      const jsonContent = JSON.stringify(toolOutput);
      const largeResult = new ToolMessage({
        content: jsonContent,
        tool_call_id: 'tc1',
        name: 'web_search',
      });

      const handler = vi.fn().mockResolvedValue(largeResult);

      await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'web_search', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      expect(mockBackend.write).toHaveBeenCalledWith('.tau/offloaded-tool-results/tc1.txt', jsonContent);
    });

    it('should omit _offloadedTo for array-root JSON content', async () => {
      const middleware = createToolOffloadingMiddleware(rpcBackendFactory, { tokenThreshold: 10 });

      const arrayOutput = [
        { url: 'https://example.com', content: 'E'.repeat(2000) },
        { url: 'https://other.com', content: 'short' },
      ];
      const jsonContent = JSON.stringify(arrayOutput);
      const largeResult = new ToolMessage({
        content: jsonContent,
        tool_call_id: 'tc1',
        name: 'web_browser',
      });

      const handler = vi.fn().mockResolvedValue(largeResult);

      const result = await invokeWrapToolCall(
        middleware,
        {
          toolCall: { name: 'web_browser', id: 'tc1', args: {} },
          runtime: { context: { chatId: 'chat-1' } },
        },
        handler,
      );

      const content = (result as ToolMessage).content as string;
      const parsed = JSON.parse(content) as Array<Record<string, unknown>>;

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!['url']).toBe('https://example.com');
      expect(parsed[0]!['content']).toMatch(/^\[offloaded: 2000 chars]$/);
      expect(parsed[1]!['content']).toBe('short');
      expect((parsed as unknown as Record<string, unknown>)['_offloadedTo']).toBeUndefined();
    });
  });

  // =========================================================================
  // compactLargeStrings unit tests
  // =========================================================================

  describe('compactLargeStrings', () => {
    it('should pass through primitives unchanged', () => {
      expect(compactLargeStrings(42, 100)).toBe(42);
      expect(compactLargeStrings(true, 100)).toBe(true);
      expect(compactLargeStrings(null, 100)).toBeNull();
    });

    it('should pass through empty objects and arrays unchanged', () => {
      expect(compactLargeStrings({}, 100)).toEqual({});
      expect(compactLargeStrings([], 100)).toEqual([]);
    });

    it('should compact strings exceeding the threshold', () => {
      const result = compactLargeStrings('A'.repeat(101), 100);
      expect(result).toBe('[offloaded: 101 chars]');
    });

    it('should preserve strings at exactly the threshold', () => {
      const exact = 'B'.repeat(100);
      expect(compactLargeStrings(exact, 100)).toBe(exact);
    });
  });
});
