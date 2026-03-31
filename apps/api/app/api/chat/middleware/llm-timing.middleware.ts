import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AttributeKey } from '@taucad/telemetry';
import type { ModelService } from '#api/models/model.service.js';
import type { MetricsService } from '#telemetry/metrics.js';

const timingContextSchema = z.object({
  modelId: z.string(),
  modelService: z.custom<ModelService>(),
});

/**
 * Middleware that records LLM operation duration.
 *
 * Uses the `wrapModelCall` hook to measure the total wall-clock time of each
 * model invocation, recording `gen_ai.client.operation.duration`.
 *
 * TTFT is measured separately via TtftCallbackHandler (LangChain callbacks),
 * which fires per streaming token for true first-token latency.
 */
export const createLlmTimingMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'LlmTiming',
    contextSchema: timingContextSchema,

    async wrapModelCall(request, handler) {
      const { context } = request.runtime;
      const { modelId, modelService } = context;
      const otelProviderName = modelService.getOtelProviderName(modelId);
      const startTime = performance.now();

      const baseAttributes: Record<string, string> = {
        [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
        [AttributeKey.GEN_AI_REQUEST_MODEL]: modelId,
        ...(otelProviderName ? { [AttributeKey.GEN_AI_PROVIDER_NAME]: otelProviderName } : {}),
      };

      try {
        const result = await handler(request);

        const durationSeconds = (performance.now() - startTime) / 1000;
        const responseModel =
          result instanceof AIMessage
            ? String(
                (result.response_metadata['model'] as string | undefined) ?? result.response_metadata.model_name ?? '',
              )
            : undefined;
        metricsService.genAiOperationDuration.record(durationSeconds, {
          ...baseAttributes,
          ...(responseModel ? { [AttributeKey.GEN_AI_RESPONSE_MODEL]: responseModel } : {}),
        });

        return result;
      } catch (error) {
        const durationSeconds = (performance.now() - startTime) / 1000;
        metricsService.genAiOperationDuration.record(durationSeconds, {
          ...baseAttributes,
          [AttributeKey.ERROR_TYPE]: error instanceof Error ? error.constructor.name : 'UnknownError',
        });
        throw error;
      }
    },
  });
