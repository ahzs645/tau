import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';
import { AttributeKey } from '@taucad/telemetry';
import type { ModelService } from '#api/models/model.service.js';
import type { MetricsService } from '#telemetry/metrics.js';

/**
 * Middleware that counts agent loop iterations (model calls) per chat request
 * and records the total as a histogram value when the agent completes.
 *
 * Each `afterModel` call increments the counter. The final count is recorded
 * in `afterAgent`, providing visibility into how many model round-trips a
 * single user request triggers — useful for detecting runaway loops and
 * correlating cost with iteration depth.
 *
 * Uses stateSchema for cross-hook state (idiomatic LangChain pattern).
 */
export const createAgentIterationsMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'AgentIterations',
    contextSchema: z.object({
      modelId: z.string(),
      modelService: z.custom<ModelService>(),
    }),
    stateSchema: z.object({
      _iterationCount: z.number().default(0),
    }),

    afterModel(state) {
      return { _iterationCount: state._iterationCount + 1 };
    },

    afterAgent(state, runtime) {
      if (state._iterationCount > 0) {
        const { modelId, modelService } = runtime.context;
        const otelProviderName = modelService.getOtelProviderName(modelId);
        metricsService.genAiAgentIterations.record(state._iterationCount, {
          [AttributeKey.GEN_AI_OPERATION_NAME]: 'chat',
          [AttributeKey.GEN_AI_REQUEST_MODEL]: modelId,
          ...(otelProviderName ? { [AttributeKey.GEN_AI_PROVIDER_NAME]: otelProviderName } : {}),
        });
      }
    },
  });
