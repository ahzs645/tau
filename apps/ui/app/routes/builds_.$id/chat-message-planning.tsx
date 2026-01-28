import { messageRole } from '@taucad/chat/constants';
import { useChatSelector } from '#hooks/use-chat.js';
import { ChatToolInlineLink } from '#components/chat/chat-tool-inline.js';
import { cn } from '#utils/ui.utils.js';

type ChatMessagePlanningProperties = {
  readonly messageId: string;
};

/** Part type for areAllPartsConcluded - only needs to check state property */
export type PartWithOptionalState = { [key: string]: unknown; state?: string };

/**
 * Check if all parts in a message have concluded.
 * Concluded states:
 * - Text/Reasoning: 'done' (or no state = complete)
 * - Tools: 'output-available' or 'output-error'
 *
 * Returns false if any part is still actively streaming or processing.
 */
export function areAllPartsConcluded(parts: readonly PartWithOptionalState[]): boolean {
  for (const part of parts) {
    // Skip parts without state (considered complete)
    if (!('state' in part) || part.state === undefined) {
      continue;
    }

    const { state } = part;

    // These are all concluded states:
    // - 'done': text/reasoning finished streaming
    // - 'output-available': tool completed successfully
    // - 'output-error': tool completed with error
    const isConcluded = state === 'done' || state === 'output-available' || state === 'output-error';

    if (!isConcluded) {
      return false;
    }
  }

  return true;
}

/**
 * Displays a "Planning next moves..." indicator when the AI is processing.
 * Shows after a user message or when an assistant message has all tool parts concluded.
 */
export function ChatMessagePlanning({ messageId }: ChatMessagePlanningProperties): React.JSX.Element | undefined {
  const isStreamingOrSubmitted = useChatSelector((state) => ['submitted', 'streaming'].includes(state.status));

  const message = useChatSelector((state) => state.messagesById.get(messageId));

  const isUser = message?.role === messageRole.user;

  // Check if this is the last message and whether we should show the planning indicator
  const shouldShowPlanningIndicator = useChatSelector((state) => {
    const { messages } = state;
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      return false;
    }

    // Case 1: Last message is user message (no assistant response yet)
    if (lastMessage.role === messageRole.user) {
      return lastMessage.id === messageId;
    }

    // Case 2: Last message is assistant message with all parts concluded (not actively streaming)
    if (lastMessage.role === messageRole.assistant && lastMessage.id === messageId) {
      return areAllPartsConcluded(lastMessage.parts);
    }

    return false;
  });

  // Show "Planning next moves" when streaming/submitted and this message qualifies for the indicator
  const shouldShowPlanning = isStreamingOrSubmitted && shouldShowPlanningIndicator;

  if (!shouldShowPlanning) {
    return undefined;
  }

  return (
    <div className={cn(isUser && 'mt-1 ml-4')}>
      <ChatToolInlineLink status="loading">Planning next moves...</ChatToolInlineLink>
    </div>
  );
}
