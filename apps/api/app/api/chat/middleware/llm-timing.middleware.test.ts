import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { AttributeKey } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import { createLlmTimingMiddleware } from '#api/chat/middleware/llm-timing.middleware.js';
import { invokeWrapModelCall } from '#testing/middleware-testing.utils.js';

const mockModelService = mock<ModelService>();
const metricsService = new MetricsService();

describe('createLlmTimingMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(metricsService.genAiOperationDuration, 'record');
  });

  it('should record duration with response_model on success', async () => {
    const middleware = createLlmTimingMiddleware(metricsService);

    mockModelService.getOtelProviderName.mockReturnValue('anthropic');

    /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
    const aiMessage = new AIMessage({
      content: 'Hello!',
      response_metadata: { model: 'claude-3-5-sonnet-20241022' },
    });
    /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

    const handler = vi.fn().mockResolvedValue(aiMessage);
    const request = {
      messages: [] as BaseMessage[],
      runtime: { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService } },
    };

    await invokeWrapModelCall(middleware, request, handler);

    expect(metricsService.genAiOperationDuration.record).toHaveBeenCalledTimes(1);
    const [duration, attributes] = (metricsService.genAiOperationDuration.record as ReturnType<typeof vi.fn>).mock
      .calls[0] as [number, Record<string, string>];
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(attributes).toEqual({
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'claude-3.5-sonnet',
      [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
      [AttributeKey.GEN_AI_RESPONSE_MODEL]: 'claude-3-5-sonnet-20241022',
    });
  });

  it('should fall back to model_name when model is not present in response_metadata', async () => {
    const middleware = createLlmTimingMiddleware(metricsService);

    mockModelService.getOtelProviderName.mockReturnValue('openai');

    /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
    const aiMessage = new AIMessage({
      content: 'Hi',
      response_metadata: { model_name: 'gpt-4o-2024-05-13' },
    });
    /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

    const handler = vi.fn().mockResolvedValue(aiMessage);
    const request = {
      messages: [] as BaseMessage[],
      runtime: { context: { modelId: 'gpt-4o', modelService: mockModelService } },
    };

    await invokeWrapModelCall(middleware, request, handler);

    const [, attributes] = (metricsService.genAiOperationDuration.record as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(attributes[AttributeKey.GEN_AI_RESPONSE_MODEL]).toBe('gpt-4o-2024-05-13');
  });

  it('should record duration with error.type on failure', async () => {
    const middleware = createLlmTimingMiddleware(metricsService);

    mockModelService.getOtelProviderName.mockReturnValue('anthropic');

    const handler = vi.fn().mockRejectedValue(new TypeError('Network failure'));
    const request = {
      messages: [] as BaseMessage[],
      runtime: { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService } },
    };

    await expect(invokeWrapModelCall(middleware, request, handler)).rejects.toThrow('Network failure');

    const [duration, attributes] = (metricsService.genAiOperationDuration.record as ReturnType<typeof vi.fn>).mock
      .calls[0] as [number, Record<string, string>];
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(attributes).toEqual({
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'claude-3.5-sonnet',
      [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
      [AttributeKey.ERROR_TYPE]: 'TypeError',
    });
  });

  it('should omit provider name when getOtelProviderName returns undefined', async () => {
    const middleware = createLlmTimingMiddleware(metricsService);

    mockModelService.getOtelProviderName.mockReturnValue(undefined);

    /* eslint-disable @typescript-eslint/naming-convention -- LangChain API uses snake_case */
    const aiMessage = new AIMessage({
      content: 'Test',
      response_metadata: { model: 'local-model' },
    });
    /* eslint-enable @typescript-eslint/naming-convention -- Re-enable naming convention after LangChain metadata */

    const handler = vi.fn().mockResolvedValue(aiMessage);
    const request = {
      messages: [] as BaseMessage[],
      runtime: { context: { modelId: 'local-model', modelService: mockModelService } },
    };

    await invokeWrapModelCall(middleware, request, handler);

    const [, attributes] = (metricsService.genAiOperationDuration.record as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(attributes).not.toHaveProperty(AttributeKey.GEN_AI_PROVIDER_NAME);
  });
});
