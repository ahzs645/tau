import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AttributeKey } from '@taucad/telemetry';
import { MetricsService } from '#telemetry/metrics.js';
import type { ModelService } from '#api/models/model.service.js';
import { createAgentIterationsMiddleware } from '#api/chat/middleware/agent-iterations.middleware.js';
import { resolveMiddlewareHook } from '#testing/middleware-testing.utils.js';

const mockModelService = mock<ModelService>();
const metricsService = new MetricsService();

describe('createAgentIterationsMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(metricsService.genAiAgentIterations, 'record');
  });

  it('should increment iteration count per afterModel call', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const afterModel = resolveMiddlewareHook(middleware.afterModel);

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Partial mock state/runtime for middleware testing
    const state1 = afterModel({ _iterationCount: 0 } as any);
    expect(state1).toEqual({ _iterationCount: 1 });

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Partial mock state/runtime for middleware testing
    const state2 = afterModel({ _iterationCount: 3 } as any);
    expect(state2).toEqual({ _iterationCount: 4 });
  });

  it('should record histogram with correct count and attributes in afterAgent', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const afterAgent = resolveMiddlewareHook(middleware.afterAgent);

    mockModelService.getOtelProviderName.mockReturnValue('anthropic');

    afterAgent(
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { _iterationCount: 5 } as any,
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { context: { modelId: 'claude-3.5-sonnet', modelService: mockModelService } } as any,
    );

    expect(metricsService.genAiAgentIterations.record).toHaveBeenCalledWith(5, {
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'claude-3.5-sonnet',
      [AttributeKey.GEN_AI_PROVIDER_NAME]: 'anthropic',
    });
  });

  it('should omit provider name when getOtelProviderName returns undefined', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const afterAgent = resolveMiddlewareHook(middleware.afterAgent);

    mockModelService.getOtelProviderName.mockReturnValue(undefined);

    afterAgent(
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { _iterationCount: 2 } as any,
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { context: { modelId: 'test-model', modelService: mockModelService } } as any,
    );

    expect(metricsService.genAiAgentIterations.record).toHaveBeenCalledWith(2, {
      [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
      [AttributeKey.GEN_AI_REQUEST_MODEL]: 'test-model',
    });
  });

  it('should not record when iteration count is zero', () => {
    const middleware = createAgentIterationsMiddleware(metricsService);
    const afterAgent = resolveMiddlewareHook(middleware.afterAgent);

    afterAgent(
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { _iterationCount: 0 } as any,
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock state/runtime for middleware testing
      { context: { modelId: 'test-model', modelService: mockModelService } } as any,
    );

    expect(metricsService.genAiAgentIterations.record).not.toHaveBeenCalled();
  });
});
