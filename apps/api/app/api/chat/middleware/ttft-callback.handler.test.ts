import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AttributeKey } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import { TtftCallbackHandler } from '#api/chat/middleware/ttft-callback.handler.js';

const mockModelService = mock<ModelService>();
const metricsService = new MetricsService();

describe('TtftCallbackHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(metricsService.genAiTimeToFirstToken, 'record');
  });

  it('should record TTFT on first token', () => {
    mockModelService.getOtelProviderName.mockReturnValue('anthropic');
    const handler = new TtftCallbackHandler(metricsService, mockModelService, 'claude-3.5-sonnet');

    const runId = 'run-1';
    handler.handleChatModelStart(undefined, [[]], runId);
    handler.handleLLMNewToken('Hello', undefined, runId);

    expect(metricsService.genAiTimeToFirstToken.record).toHaveBeenCalledTimes(1);

    const [ttft, attributes] = (metricsService.genAiTimeToFirstToken.record as ReturnType<typeof vi.fn>).mock
      .calls[0] as [number, Record<string, string>];
    expect(ttft).toBeGreaterThanOrEqual(0);
    expect(attributes).toEqual({
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'claude-3.5-sonnet',
      [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
    });
  });

  it('should ignore subsequent tokens for the same runId', () => {
    mockModelService.getOtelProviderName.mockReturnValue('openai');
    const handler = new TtftCallbackHandler(metricsService, mockModelService, 'gpt-4o');

    const runId = 'run-2';
    handler.handleChatModelStart(undefined, [[]], runId);
    handler.handleLLMNewToken('First', undefined, runId);
    handler.handleLLMNewToken('Second', undefined, runId);
    handler.handleLLMNewToken('Third', undefined, runId);

    expect(metricsService.genAiTimeToFirstToken.record).toHaveBeenCalledTimes(1);
  });

  it('should gracefully skip when runId has no start time', () => {
    const handler = new TtftCallbackHandler(metricsService, mockModelService, 'test-model');

    handler.handleLLMNewToken('token', undefined, 'unknown-run');

    expect(metricsService.genAiTimeToFirstToken.record).not.toHaveBeenCalled();
  });

  it('should omit provider name when getOtelProviderName returns undefined', () => {
    mockModelService.getOtelProviderName.mockReturnValue(undefined);
    const handler = new TtftCallbackHandler(metricsService, mockModelService, 'local-model');

    handler.handleChatModelStart(undefined, [[]], 'run-3');
    handler.handleLLMNewToken('hi', undefined, 'run-3');

    const [, attributes] = (metricsService.genAiTimeToFirstToken.record as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      Record<string, string>,
    ];
    expect(attributes).toEqual({
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'local-model',
    });
  });

  it('should track multiple concurrent runs independently', () => {
    mockModelService.getOtelProviderName.mockReturnValue('anthropic');
    const handler = new TtftCallbackHandler(metricsService, mockModelService, 'claude-3.5-sonnet');

    handler.handleChatModelStart(undefined, [[]], 'run-a');
    handler.handleChatModelStart(undefined, [[]], 'run-b');

    handler.handleLLMNewToken('token-a', undefined, 'run-a');
    handler.handleLLMNewToken('token-b', undefined, 'run-b');

    expect(metricsService.genAiTimeToFirstToken.record).toHaveBeenCalledTimes(2);
  });
});
