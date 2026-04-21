import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage, UsageMetadata } from '@langchain/core/messages';
import { z } from 'zod';
import type { ModelService } from '#api/models/model.service.js';

const tokenUsageContextSchema = z.object({
  modelId: z.string(),
  modelService: z.custom<ModelService>(),
});

/**
 * Locate the most recent AIMessage that carries `usage_metadata`. Returns
 * `undefined` when no such message exists (turn 1, or when the provider
 * has not surfaced token counts yet).
 */
function findMostRecentUsage(messages: readonly BaseMessage[]): UsageMetadata | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message instanceof AIMessage) {
      const usage = message.usage_metadata as UsageMetadata | undefined;
      if (usage) {
        return usage;
      }
    }
  }
  return undefined;
}

/**
 * Build the deterministic `<system-reminder>` body. Output bytes depend only
 * on the three integers, satisfying the Cache-Safety Contract CS3
 * (byte-determinism for byte-identical input).
 */
function formatTokenUsageReminder(used: number, total: number | undefined): string {
  const lines = [`Token usage: ${used} used`];
  if (total !== undefined && total > 0) {
    const remaining = Math.max(0, total - used);
    lines[0] = `Token usage: ${used} used / ${total} total / ${remaining} remaining`;
  }
  return `<system-reminder>
${lines.join('\n')}
</system-reminder>`;
}

/**
 * Middleware that injects a per-turn token-usage `<system-reminder>` so the
 * agent can self-throttle as it approaches the context window (R22).
 *
 * Behaviour:
 *   - Turn 1 (no AIMessage with `usage_metadata`): pass-through, no inject.
 *   - Turn 2+: prepend a HumanMessage carrying `used / total / remaining`
 *     derived from the most recent `usage_metadata` and
 *     `modelService.getContextWindow(modelId)`.
 *
 * Cache-Safety Contract:
 *   - CS1 (no mutation): builds a fresh `messages` array with `[reminder, ...messages]`;
 *     never mutates input instances.
 *   - CS3 (byte-determinism): the reminder body depends only on three integers,
 *     so byte-identical input produces a byte-identical prepended message.
 *
 * Wiring order (chat.service.ts): inserted between `usage-tracking` (which
 * records the previous turn's `usage_metadata`) and `agent-safeguards` (which
 * also injects `<system-reminder>` nudges into the cacheable prefix).
 */
export const createTokenUsageContextMiddleware = (): AgentMiddleware =>
  createMiddleware({
    name: 'TokenUsageContext',
    contextSchema: tokenUsageContextSchema,

    async wrapModelCall(request, handler) {
      const usage = findMostRecentUsage(request.messages);
      if (!usage) {
        return handler(request);
      }

      const { modelId, modelService } = request.runtime.context;
      const used = usage.input_tokens + usage.output_tokens;
      const total = modelService.getContextWindow(modelId);
      const reminderBody = formatTokenUsageReminder(used, total);

      const reminder = new HumanMessage(reminderBody);
      const messages = [reminder, ...request.messages];

      return handler({ ...request, messages });
    },
  });
