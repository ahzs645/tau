import { useState, useRef } from 'react';
import { Brain } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { MarkdownViewerChat } from '#components/markdown/markdown-viewer-chat.js';
import { useChatSelector } from '#hooks/use-chat.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

export function ChatMessageToolReasoning({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.reasoning>;
}): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');
  const [isOpen, setIsOpen] = useState(false);
  const hasUserToggled = useRef(false);

  const handleOpenChange = (open: boolean): void => {
    hasUserToggled.current = true;
    setIsOpen(open);
  };

  const isThinking = part.state === 'input-streaming' || part.state === 'input-available';
  const thinking = part.input?.thinking ?? '';

  if (part.state === 'output-error') {
    return <ChatToolError errorText={part.errorText} fallbackIcon={Brain} fallbackTitle="Reasoning failed" />;
  }

  if (part.state === 'approval-requested' || part.state === 'approval-responded' || part.state === 'output-denied') {
    throw new Error(`Unexpected ${toolName.reasoning} state: ${part.state}`);
  }

  // Determine if content should be visible
  const hasContent = thinking.trim() !== '';
  // When thinking: open if has content and user hasn't explicitly toggled.
  // When done: user-controlled (collapsed by default).
  const shouldBeOpen = isThinking ? hasContent && (!hasUserToggled.current || isOpen) : isOpen;

  return (
    <ChatToolCard
      variant="minimal"
      status={isThinking ? 'loading' : 'ready'}
      isOpen={shouldBeOpen}
      onOpenChange={handleOpenChange}
    >
      <ChatToolCardHeader>
        <ChatToolCardIcon icon={Brain} />
        <ChatToolCardTitle>{isThinking ? 'Thinking...' : 'Thought process'}</ChatToolCardTitle>
      </ChatToolCardHeader>
      {hasContent ? (
        <ChatToolCardContent className="border-l-0">
          <div className="border-l border-foreground/20 pl-4 text-sm italic">
            <MarkdownViewerChat className="text-muted-foreground" isStreaming={isStreaming}>
              {thinking}
            </MarkdownViewerChat>
          </div>
        </ChatToolCardContent>
      ) : undefined}
    </ChatToolCard>
  );
}
