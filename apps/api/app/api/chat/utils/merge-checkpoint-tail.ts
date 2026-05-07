import { ToolMessage } from '@langchain/core/messages';
import type { MyUIMessage } from '@taucad/chat';
import { isToolPart } from '@taucad/chat';

/**
 * Parses LangGraph checkpoint `channel_values.messages` into settled tool outputs
 * keyed by OpenAI-style tool call id.
 */
export function settleToolOutputsFromCheckpointMessages(
  checkpointMessages: readonly unknown[] | undefined,
): Map<string, unknown> {
  const settledByToolCallId = new Map<string, unknown>();
  if (!checkpointMessages) {
    return settledByToolCallId;
  }

  for (const message of checkpointMessages) {
    if (ToolMessage.isInstance(message)) {
      settledByToolCallId.set(message.tool_call_id, coerceToolMessageContent(message.content));
    }
  }

  return settledByToolCallId;
}

function coerceToolMessageContent(content: ToolMessage['content']): unknown {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  }

  // Multimodal / structured LangChain content blocks — best-effort stringify
  return content;
}

export type MergeCheckpointTailInput = {
  readonly requestMessages: readonly MyUIMessage[];
  readonly checkpointMessages: readonly unknown[] | undefined;
};

/**
 * When the UI sends a stale tail (e.g. in-flight tool parts) but Postgres already
 * recorded {@link ToolMessage} results for matching `tool_call_id`s, splice
 * `output-available` tool parts from the checkpoint before `toBaseMessages`.
 */
export function mergeCheckpointTail(input: MergeCheckpointTailInput): MyUIMessage[] {
  const { requestMessages, checkpointMessages } = input;
  const settledByToolCallId = settleToolOutputsFromCheckpointMessages(checkpointMessages);

  if (settledByToolCallId.size === 0) {
    return [...requestMessages];
  }

  const lastIndex = requestMessages.length - 1;
  const last = requestMessages[lastIndex];
  if (last?.role !== 'assistant') {
    return [...requestMessages];
  }

  const newParts = last.parts.map((part) => {
    if (!isToolPart(part)) {
      return part;
    }

    // Only splice when the checkpoint has a finalized tool input boundary. Streaming
    // partial inputs lack the required `Input` typing for `output-available`.
    if (part.state !== 'input-available') {
      return part;
    }

    const settled = settledByToolCallId.get(part.toolCallId);
    if (settled === undefined) {
      return part;
    }

    // oxlint-disable-next-line typescript-eslint/consistent-type-assertions -- checkpoint `ToolMessage` JSON is already canonical on the server; widened here because per-tool output types are not re-derived from `unknown`.
    return {
      ...part,
      state: 'output-available',
      output: settled,
    } as MyUIMessage['parts'][number];
  });

  const tailChanged = newParts.some((part, index) => part !== last.parts[index]);
  if (!tailChanged) {
    return [...requestMessages];
  }

  return [...requestMessages.slice(0, lastIndex), { ...last, parts: newParts }];
}
