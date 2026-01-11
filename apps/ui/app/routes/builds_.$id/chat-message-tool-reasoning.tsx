import type { UIToolInvocation } from 'ai';
import { useState } from 'react';
import { Brain } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { defaultMarkdownControls, MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { useChatSelector } from '#hooks/use-chat.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';

export function ChatMessageToolReasoning({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.reasoning]>;
}): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');
  const [isOpen, setIsOpen] = useState(false);

  const isThinking = part.state === 'input-streaming' || part.state === 'input-available';
  const thinking = part.input?.thinking ?? '';

  if (part.state === 'output-error') {
    return (
      <ChatToolCard variant="minimal" status="error" isDefaultOpen={false}>
        <ChatToolCardHeader>
          <ChatToolCardIcon isError icon={Brain} />
          <ChatToolCardTitle>Reasoning failed: {part.errorText}</ChatToolCardTitle>
        </ChatToolCardHeader>
      </ChatToolCard>
    );
  }

  // Determine if content should be visible
  const hasContent = thinking.trim() !== '';
  const shouldBeOpen = isThinking ? hasContent : isOpen;

  return (
    <ChatToolCard
      variant="minimal"
      status={isThinking ? 'loading' : 'ready'}
      isOpen={shouldBeOpen}
      onOpenChange={setIsOpen}
    >
      <ChatToolCardHeader>
        <ChatToolCardIcon icon={Brain} />
        <ChatToolCardTitle>{isThinking ? 'Thinking...' : 'Thought process'}</ChatToolCardTitle>
      </ChatToolCardHeader>
      {hasContent ? (
        <ChatToolCardContent className="border-l-0">
          <div className="border-l border-foreground/20 pl-4 text-sm italic">
            <MarkdownViewer
              className="text-muted-foreground"
              isStreaming={isStreaming}
              controls={{ ...defaultMarkdownControls, table: true }}
            >
              {thinking.trim()}
            </MarkdownViewer>
          </div>
        </ChatToolCardContent>
      ) : undefined}
    </ChatToolCard>
  );
}
