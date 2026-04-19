import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { idPrefix } from '@taucad/types/constants';
import { generatePrefixedId } from '@taucad/utils/id';
import type { ModelService } from '#api/models/model.service.js';

const contextUsageContextSchema = z.object({
  modelId: z.string(),
  modelService: z.custom<ModelService>(),
});

/**
 * Middleware that emits context window utilization after each model call.
 * Reads cumulative input tokens from the model response and compares
 * against the model's declared context window to produce a percentage.
 */
export const createContextUsageMiddleware = (): AgentMiddleware =>
  createMiddleware({
    name: 'ContextUsage',
    contextSchema: contextUsageContextSchema,

    afterModel(state, runtime) {
      const { context, writer } = runtime;
      if (!writer) {
        return;
      }

      const { modelId, modelService } = context;

      /* oxlint-disable-next-line typescript-eslint/no-unsafe-call -- LangChain state.messages typed as any */
      const lastMessage = state.messages.at(-1) as AIMessage | undefined;
      const inputTokens = lastMessage?.usage_metadata?.input_tokens;
      if (inputTokens === undefined) {
        return;
      }

      const contextWindow = modelService.getContextWindow(modelId);
      if (!contextWindow) {
        return;
      }

      const percentUsed = Math.min((inputTokens / contextWindow) * 100, 100);

      writer({
        type: 'context-usage',
        id: generatePrefixedId(idPrefix.data),
        totalInputTokens: inputTokens,
        contextWindow,
        percentUsed: Math.round(percentUsed * 10) / 10,
        modelId,
      });
    },
  });
