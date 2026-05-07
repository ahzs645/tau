/**
 * Interrupt-recovery middleware.
 *
 * After the user interrupts a turn, the UI persists the in-flight tool parts as
 * `output-error` with `errorCode: 'USER_INTERRUPTED'`
 * (see `apps/ui/app/utils/chat.utils.ts` `finalizeInterruptedToolParts`). On the
 * next user turn those persisted parts arrive on the API as
 * `ToolMessage(status: 'error', content: '{"errorCode":"USER_INTERRUPTED",...}')`.
 *
 * Without a turn-level signal the LLM has to infer the situation from a mix of
 * `output-available` and `output-error` parts. This middleware injects a single
 * `<system-reminder>` HumanMessage telling the model that the previous turn was
 * interrupted and to verify state before retrying — mirroring the pattern used
 * by Claude Code (`INTERRUPT_MESSAGE_FOR_TOOL_USE`) and Codex
 * (`<turn_aborted>...verify current state before retrying</turn_aborted>`).
 *
 * Cache-safety contract:
 * - The reminder body is byte-deterministic for byte-identical inputs (no
 *   timestamps, UUIDs, run identifiers, or counters in the body other than the
 *   completed/interrupted counts that are themselves derived from the
 *   parent AIMessage's `tool_calls`).
 * - Dedup keys are stored in LangGraph state
 *   (`_interruptReminderFiredFor: string[]`) so a multi-superstep recovery
 *   does not re-fire for the same parent AIMessage signature.
 */
import { createHash } from 'node:crypto';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AttributeKey, GenAiInterruptRecoveryOutcome } from '@taucad/telemetry';
import type { ModelService } from '#api/models/model.service.js';
import type { MetricsService } from '#telemetry/metrics.js';

// =============================================================================
// Public types
// =============================================================================

/**
 * The canonical errorCode emitted by `finalizeInterruptedToolParts` when a
 * user interrupt cancels an in-flight tool. Any ToolMessage whose JSON body
 * contains this code is considered an interrupted-tool result by the detector.
 */
export const userInterruptedErrorCode = 'USER_INTERRUPTED';

/**
 * Result of scanning the tail of `state.messages` for an interrupted turn.
 *
 * - `kind: 'clear'` — no contiguous interrupted tail detected.
 * - `kind: 'detected'` — at least one interrupted ToolMessage in the trailing
 *   tool block paired with the parent AIMessage; counts come from walking
 *   `parentAi.tool_calls` and matching by `tool_call_id`.
 */
export type InterruptDetection =
  | { kind: 'clear' }
  | {
      kind: 'detected';
      completedCount: number;
      interruptedCount: number;
      /** Stable signature derived from the parent AIMessage id. */
      signature: string;
    };

// =============================================================================
// Detection helpers
// =============================================================================

const messageContent = (message: BaseMessage): string =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

/**
 * True when the ToolMessage body decodes to an object with
 * `errorCode === 'USER_INTERRUPTED'`. Tolerant of non-JSON bodies (returns false).
 */
function isUserInterruptedToolMessage(message: ToolMessage): boolean {
  if (message.status !== 'error') {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(messageContent(message));
    if (parsed && typeof parsed === 'object' && 'errorCode' in parsed) {
      return (parsed as { errorCode: unknown }).errorCode === userInterruptedErrorCode;
    }
  } catch {
    // Opaque error body — not USER_INTERRUPTED by this contract.
  }
  return false;
}

/**
 * Walks the message tail looking for the most-recent contiguous block of
 * `ToolMessage`s. Returns the slice of ToolMessages and the parent AIMessage
 * that issued the corresponding tool_calls. Anything that isn't `[AIMessage,
 * ToolMessage…]` is treated as `clear`.
 */
function findTrailingToolBlock(
  messages: BaseMessage[],
): { parentAi: AIMessage; toolMessages: ToolMessage[] } | undefined {
  let lastIndex = messages.length - 1;
  while (lastIndex >= 0 && !(messages[lastIndex] instanceof ToolMessage)) {
    if (messages[lastIndex] instanceof HumanMessage) {
      // A fresh user turn between the parent AI and now suppresses detection
      // — the user has already moved on.
      return undefined;
    }
    lastIndex -= 1;
  }
  if (lastIndex < 0) {
    return undefined;
  }

  let firstToolIndex = lastIndex;
  while (firstToolIndex - 1 >= 0 && messages[firstToolIndex - 1] instanceof ToolMessage) {
    firstToolIndex -= 1;
  }

  const parent: BaseMessage | undefined = messages[firstToolIndex - 1];
  if (!parent || !AIMessage.isInstance(parent) || !parent.tool_calls || parent.tool_calls.length === 0) {
    return undefined;
  }
  const parentAi: AIMessage = parent;

  const toolMessages: ToolMessage[] = [];
  for (let index = firstToolIndex; index <= lastIndex; index++) {
    const candidate = messages[index];
    if (candidate && ToolMessage.isInstance(candidate)) {
      toolMessages.push(candidate);
    }
  }
  return { parentAi, toolMessages };
}

/**
 * Stable 16-hex-char SHA-256 of the parent AIMessage id (or, when absent, of
 * the canonical join of its tool_call ids). This is the dedup signature so
 * reruns of the same turn don't re-emit the reminder.
 */
function computeSignature(parentAi: AIMessage): string {
  const seed =
    typeof parentAi.id === 'string' && parentAi.id.length > 0
      ? parentAi.id
      : (parentAi.tool_calls ?? [])
          .map((call) => call.id ?? '')
          .filter((id) => id.length > 0)
          .sort()
          .join(':');
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Pure detection over the canonical message tail. Exposed for unit testing.
 */
export function detectInterruptedTurn(messages: BaseMessage[]): InterruptDetection {
  const block = findTrailingToolBlock(messages);
  if (!block) {
    return { kind: 'clear' };
  }

  const { parentAi, toolMessages } = block;
  const interruptedIds = new Set<string>();
  const completedIds = new Set<string>();
  for (const message of toolMessages) {
    if (isUserInterruptedToolMessage(message)) {
      interruptedIds.add(message.tool_call_id);
    } else {
      completedIds.add(message.tool_call_id);
    }
  }

  if (interruptedIds.size === 0) {
    return { kind: 'clear' };
  }

  const toolCalls = parentAi.tool_calls ?? [];
  const parentCallIds = new Set<string>();
  for (const call of toolCalls) {
    if (call.id) {
      parentCallIds.add(call.id);
    }
  }

  let completedCount = 0;
  let interruptedCount = 0;
  for (const callId of parentCallIds) {
    if (interruptedIds.has(callId)) {
      interruptedCount += 1;
    } else if (completedIds.has(callId)) {
      completedCount += 1;
    }
  }

  if (interruptedCount === 0) {
    return { kind: 'clear' };
  }

  return {
    kind: 'detected',
    completedCount,
    interruptedCount,
    signature: computeSignature(parentAi),
  };
}

// =============================================================================
// Reminder body (deterministic, byte-stable)
// =============================================================================

/**
 * Builds the canonical interrupt-recovery reminder. Inputs ⇒ output is a pure
 * function — there are no timestamps, UUIDs, or run identifiers in the body.
 * Required for prompt-cache-prefix stability (matches the same constraint the
 * agent-safeguards reminders honour).
 */
export function interruptRecoveryReminder(input: { completedCount: number; interruptedCount: number }): string {
  const { completedCount, interruptedCount } = input;
  return `The previous turn was interrupted by the user. ${completedCount} tool call(s)
completed successfully and ${interruptedCount} were cancelled before they
finished. Tools that mutate state (file writes, edits, deletes) may have
partially executed.

Before retrying, verify the current state of any file or resource you were
operating on (read_file / list_directory / get_kernel_result) and only then
decide whether to repeat, adjust, or skip the cancelled work. Do NOT assume
the cancelled tools left the system unchanged.`;
}

// =============================================================================
// State + context schemas
// =============================================================================

const interruptRecoveryContextSchema = z.object({
  modelId: z.string().optional(),
  modelService: z.custom<ModelService>().optional(),
});

const interruptRecoveryStateSchema = z.object({
  /** Signatures that have already triggered a reminder in this thread. De-duped. */
  _interruptReminderFiredFor: z.array(z.string()).default([]),
});

export type InterruptRecoveryState = z.infer<typeof interruptRecoveryStateSchema>;

// =============================================================================
// Middleware
// =============================================================================

function buildAttributes(input: {
  outcome: (typeof GenAiInterruptRecoveryOutcome)[keyof typeof GenAiInterruptRecoveryOutcome];
  modelId?: string;
  modelService?: ModelService;
}): Record<string, string> {
  const { outcome, modelId, modelService } = input;
  const attributes: Record<string, string> = {
    [AttributeKey.GEN_AI_INTERRUPT_RECOVERY_OUTCOME]: outcome,
  };
  if (modelId) {
    attributes[AttributeKey.GEN_AI_REQUEST_MODEL] = modelId;
    const otelProviderName = modelService?.getOtelProviderName(modelId);
    if (otelProviderName) {
      attributes[AttributeKey.GEN_AI_PROVIDER_NAME] = otelProviderName;
    }
  }
  return attributes;
}

/**
 * Creates the turn-level interrupt-recovery middleware. Detection runs in
 * `beforeModel` so the injected `<system-reminder>` HumanMessage becomes part
 * of the persisted state and the cacheable prompt prefix.
 *
 * @param metricsService Telemetry sink for the
 *   `gen_ai.agent.interrupt_recovery.reminders` counter.
 */
export const createInterruptRecoveryMiddleware = (metricsService: MetricsService): AgentMiddleware =>
  createMiddleware({
    name: 'InterruptRecovery',
    contextSchema: interruptRecoveryContextSchema,
    stateSchema: interruptRecoveryStateSchema,

    beforeModel(state, runtime) {
      const { messages } = state;
      const { modelId, modelService } = runtime.context;

      const detection = detectInterruptedTurn(messages);
      if (detection.kind === 'clear') {
        return {};
      }

      const alreadyFired = new Set(state._interruptReminderFiredFor);
      if (alreadyFired.has(detection.signature)) {
        metricsService.genAiInterruptRecoveryReminders.add(
          1,
          buildAttributes({
            outcome: GenAiInterruptRecoveryOutcome.ALREADY_FIRED,
            modelId,
            modelService,
          }),
        );
        return {};
      }

      const reminder = interruptRecoveryReminder({
        completedCount: detection.completedCount,
        interruptedCount: detection.interruptedCount,
      });

      const nudge = new HumanMessage({
        content: `<system-reminder>\n${reminder}\n</system-reminder>`,
      });

      metricsService.genAiInterruptRecoveryReminders.add(
        1,
        buildAttributes({
          outcome: GenAiInterruptRecoveryOutcome.EMITTED,
          modelId,
          modelService,
        }),
      );

      return {
        messages: [nudge],
        _interruptReminderFiredFor: [...state._interruptReminderFiredFor, detection.signature],
      };
    },
  });
