import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AttributeKey, GenAiTokenType } from '@taucad/telemetry';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import type { ModelService } from '#api/models/model.service.js';
import type { MetricsService } from '#telemetry/metrics.js';

/**
 * Context schema for usage tracking middleware.
 * Requires modelId and modelService to calculate token costs.
 */
const usageContextSchema = z.object({
  modelId: z.string(),
  modelService: z.custom<ModelService>(),
});

/**
 * Create a middleware that tracks token usage and costs after each model call.
 *
 * Uses the `afterModel` hook to:
 * 1. Extract `usage_metadata` from the last AIMessage
 * 2. Normalize tokens using ModelService.normalizeUsageTokens()
 * 3. Calculate costs using ModelService.getModelCost()
 * 4. Write usage data to the stream via runtime.writer()
 *
 * The usage data is emitted as a custom stream event with type 'usage',
 * which gets transformed to a 'data-usage' part in the UI message stream.
 */
export const createUsageTrackingMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'UsageTracking',
    contextSchema: usageContextSchema,

    afterModel(state, runtime) {
      const { context } = runtime;
      const { modelId, modelService } = context;

      /* oxlint-disable-next-line typescript-eslint/no-unsafe-call -- LangChain state.messages is typed as any */
      const lastMessage = state.messages.at(-1) as AIMessage | undefined;

      if (lastMessage?.usage_metadata) {
        const usage = lastMessage.usage_metadata;

        let cacheReadTokens = usage.input_token_details?.cache_read ?? 0;
        let cacheWriteTokens = usage.input_token_details?.cache_creation ?? 0;

        // Some providers (like Anthropic) have cache values doubled due to streaming
        // aggregation - both message_start and message_delta report cache values,
        // which get summed during chunk concatenation. We need to halve them.
        if (modelService.streamingDoublesCacheTokens(modelId)) {
          cacheReadTokens = Math.round(cacheReadTokens / 2);
          cacheWriteTokens = Math.round(cacheWriteTokens / 2);
        }

        const reasoningTokens = usage.output_token_details?.reasoning ?? 0;

        const rawUsage = {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
        };

        const normalizedUsage = modelService.normalizeUsageTokens(modelId, rawUsage);
        const usageCost = modelService.getModelCost(modelId, normalizedUsage);
        const usageId = generatePrefixedId(idPrefix.data);

        const otelProviderName = modelService.getOtelProviderName(modelId);
        const responseModel = String(
          (lastMessage.response_metadata['model'] as string | undefined) ??
            lastMessage.response_metadata.model_name ??
            '',
        );
        const metricAttributes: Record<string, string> = {
          [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
          [AttributeKey.GEN_AI_REQUEST_MODEL]: modelId,
          ...(otelProviderName ? { [AttributeKey.GEN_AI_PROVIDER_NAME]: otelProviderName } : {}),
          ...(responseModel ? { [AttributeKey.GEN_AI_RESPONSE_MODEL]: responseModel } : {}),
        };
        metricsService.genAiTokenUsage.record(usage.input_tokens, {
          ...metricAttributes,
          [AttributeKey.GEN_AI_TOKEN_TYPE]: GenAiTokenType.INPUT,
        });
        metricsService.genAiTokenUsage.record(usage.output_tokens, {
          ...metricAttributes,
          [AttributeKey.GEN_AI_TOKEN_TYPE]: GenAiTokenType.OUTPUT,
        });
        if (usageCost.totalCost) {
          metricsService.genAiCost.add(usageCost.totalCost, metricAttributes);
        }

        const { writer } = runtime;
        if (writer) {
          writer({
            type: 'usage',
            id: usageId,
            model: modelId,
            ...normalizedUsage,
            ...usageCost,
          });
        }
      }
    },
  });
