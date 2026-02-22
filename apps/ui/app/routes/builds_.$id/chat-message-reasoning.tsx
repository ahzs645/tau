import type { ReasoningUIPart } from 'ai';
import { useState, useRef } from 'react';
import { Brain } from 'lucide-react';
import { MarkdownViewerChat } from '#components/markdown/markdown-viewer-chat.js';
import { useChatSelector } from '#hooks/use-chat.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';

type ChatMessageReasoningProperties = {
  readonly part: ReasoningUIPart;
  /**
   * Whether the message has content.
   *
   * This is used to determine if the reasoning content should be initially visible.
   */
  readonly hasContent: boolean;
};

export function ChatMessageReasoning({ part, hasContent }: ChatMessageReasoningProperties): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');
  const [isOpen, setIsOpen] = useState(false);
  const hasUserToggled = useRef(false);

  const handleOpenChange = (open: boolean): void => {
    hasUserToggled.current = true;
    setIsOpen(open);
  };

  const hasReasoningText = part.text.trim() !== '';

  // Show "Thinking..." label when there is no reasoning content yet
  if (!hasReasoningText) {
    return (
      <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
        <ChatToolCardHeader>
          <ChatToolCardTitle>Thinking...</ChatToolCardTitle>
        </ChatToolCardHeader>
      </ChatToolCard>
    );
  }

  // When message has text content after reasoning: respect user toggle (collapsed by default).
  // When no text content (still streaming or interrupted): open by default, but allow
  // user to collapse once they explicitly toggle.
  const shouldBeOpen = hasContent ? isOpen : !hasUserToggled.current || isOpen;

  return (
    <ChatToolCard variant="minimal" status="ready" isOpen={shouldBeOpen} onOpenChange={handleOpenChange}>
      <ChatToolCardHeader>
        <ChatToolCardIcon icon={Brain} />
        <ChatToolCardTitle>Thought process</ChatToolCardTitle>
      </ChatToolCardHeader>
      <ChatToolCardContent className="border-l-0">
        <div className="border-l border-foreground/20 pl-4 text-sm italic">
          <MarkdownViewerChat className="text-muted-foreground" isStreaming={isStreaming}>
            {part.text.trim()}
          </MarkdownViewerChat>
        </div>
      </ChatToolCardContent>
    </ChatToolCard>
  );
}
