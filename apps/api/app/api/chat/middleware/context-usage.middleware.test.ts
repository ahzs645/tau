/* eslint-disable @typescript-eslint/naming-convention -- LangChain message properties use snake_case */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { createContextUsageMiddleware } from '#api/chat/middleware/context-usage.middleware.js';
import { resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

describe('createContextUsageMiddleware', () => {
  const mockModelService = {
    getContextWindow: vi.fn(),
    buildModel: vi.fn(),
    getModelCost: vi.fn(),
    normalizeUsageTokens: vi.fn(),
    streamingDoublesCacheTokens: vi.fn(),
    getOtelProviderName: vi.fn(),
  };

  const createRuntime = (overrides?: { writer?: ReturnType<typeof vi.fn> }) => ({
    context: {
      modelId: 'anthropic-claude-haiku-4.5',
      modelService: mockModelService,
    },
    writer: overrides?.writer ?? vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should emit context usage data with correct percentage', () => {
    mockModelService.getContextWindow.mockReturnValue(200_000);
    const writer = vi.fn();
    const runtime = createRuntime({ writer });

    const middleware = createContextUsageMiddleware();
    const afterModel = resolveMiddlewareHook(middleware.afterModel);

    const state = {
      messages: [
        new AIMessage({
          content: 'Hello',
          usage_metadata: { input_tokens: 50_000, output_tokens: 100, total_tokens: 50_100 },
        }),
      ],
    };

    afterModel(state, runtime);

    expect(writer).toHaveBeenCalledOnce();
    const emitted = writer.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitted['type']).toBe('context-usage');
    expect(emitted['totalInputTokens']).toBe(50_000);
    expect(emitted['contextWindow']).toBe(200_000);
    expect(emitted['percentUsed']).toBe(25);
    expect(emitted['modelId']).toBe('anthropic-claude-haiku-4.5');
    expect(emitted['id']).toMatch(/^data_/);
  });

  it('should cap percentage at 100', () => {
    mockModelService.getContextWindow.mockReturnValue(100_000);
    const writer = vi.fn();
    const runtime = createRuntime({ writer });

    const middleware = createContextUsageMiddleware();
    const state = {
      messages: [
        new AIMessage({
          content: 'x',
          usage_metadata: { input_tokens: 150_000, output_tokens: 0, total_tokens: 150_000 },
        }),
      ],
    };

    resolveMiddlewareHook(middleware.afterModel)(state, runtime);

    expect(writer.mock.calls[0]![0].percentUsed).toBe(100);
  });

  it('should not emit when writer is not available', () => {
    mockModelService.getContextWindow.mockReturnValue(200_000);
    const runtime = { context: createRuntime().context, writer: undefined };

    const middleware = createContextUsageMiddleware();
    const state = {
      messages: [
        new AIMessage({
          content: 'x',
          usage_metadata: { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 },
        }),
      ],
    };

    resolveMiddlewareHook(middleware.afterModel)(state, runtime);
  });

  it('should not emit when model has no context window', () => {
    mockModelService.getContextWindow.mockReturnValue(undefined);
    const writer = vi.fn();
    const runtime = createRuntime({ writer });

    const middleware = createContextUsageMiddleware();
    const state = {
      messages: [
        new AIMessage({
          content: 'x',
          usage_metadata: { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 },
        }),
      ],
    };

    resolveMiddlewareHook(middleware.afterModel)(state, runtime);

    expect(writer).not.toHaveBeenCalled();
  });

  it('should not emit when last message has no usage metadata', () => {
    mockModelService.getContextWindow.mockReturnValue(200_000);
    const writer = vi.fn();
    const runtime = createRuntime({ writer });

    const middleware = createContextUsageMiddleware();
    const state = {
      messages: [new AIMessage({ content: 'x' })],
    };

    resolveMiddlewareHook(middleware.afterModel)(state, runtime);

    expect(writer).not.toHaveBeenCalled();
  });

  it('should round percentage to one decimal place', () => {
    mockModelService.getContextWindow.mockReturnValue(300_000);
    const writer = vi.fn();
    const runtime = createRuntime({ writer });

    const middleware = createContextUsageMiddleware();
    const state = {
      messages: [
        new AIMessage({
          content: 'x',
          usage_metadata: { input_tokens: 100_000, output_tokens: 0, total_tokens: 100_000 },
        }),
      ],
    };

    resolveMiddlewareHook(middleware.afterModel)(state, runtime);

    expect(writer.mock.calls[0]![0].percentUsed).toBe(33.3);
  });
});
