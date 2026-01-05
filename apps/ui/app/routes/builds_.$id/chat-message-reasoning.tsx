import type { ReasoningUIPart } from 'ai';
import { useState } from 'react';
import { Brain } from 'lucide-react';
import { defaultMarkdownControls, MarkdownViewer } from '#components/markdown/markdown-viewer.js';
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

  // Force open if content is empty (still generating), otherwise let state handle it
  const shouldBeOpen = hasContent ? isOpen : true;

  return (
    <ChatToolCard variant="minimal" status="ready" isOpen={shouldBeOpen} onOpenChange={setIsOpen}>
      <ChatToolCardHeader>
        <ChatToolCardIcon icon={Brain} />
        <ChatToolCardTitle>Thought Process</ChatToolCardTitle>
      </ChatToolCardHeader>
      <ChatToolCardContent className="border-l-0">
        <div className="border-l border-foreground/20 pl-4 text-sm text-foreground/60 italic">
          <MarkdownViewer isStreaming={isStreaming} controls={{ ...defaultMarkdownControls, table: true }}>
            {part.text.trim()}
          </MarkdownViewer>
        </div>
      </ChatToolCardContent>
    </ChatToolCard>
  );
}
