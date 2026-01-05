import type { UIToolInvocation } from 'ai';
import { useRef, useEffect, useState } from 'react';
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

/**
 * Format duration display.
 */
function formatDuration(seconds: number): string {
  if (seconds < 1) {
    return '<1 second';
  }

  if (seconds === 1) {
    return '1 second';
  }

  return `${seconds} seconds`;
}

export function ChatMessageToolReasoning({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.reasoning]>;
}): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');
  const [isOpen, setIsOpen] = useState(false);

  // Capture start time when component mounts (tool call begins)
  const startTimeRef = useRef<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Update elapsed time while in streaming/input states
  useEffect(() => {
    if (part.state === 'input-streaming' || part.state === 'input-available') {
      const interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      return () => {
        clearInterval(interval);
      };
    }

    return undefined;
  }, [part.state]);

  const isThinking = part.state === 'input-streaming' || part.state === 'input-available';
  const thinking = part.input?.thinking ?? '';

  // Calculate final duration when output is available
  const finalDurationSeconds =
    part.state === 'output-available' && part.output.durationMs
      ? Math.round(part.output.durationMs / 1000)
      : elapsedSeconds;

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
        <ChatToolCardTitle>
          {isThinking ? 'Thinking...' : `Thought for ${formatDuration(finalDurationSeconds)}`}
        </ChatToolCardTitle>
      </ChatToolCardHeader>
      {hasContent ? (
        <ChatToolCardContent className="border-l-0">
          <div className="border-l border-foreground/20 pl-4 text-sm text-foreground/60 italic">
            <MarkdownViewer isStreaming={isStreaming} controls={{ ...defaultMarkdownControls, table: true }}>
              {thinking.trim()}
            </MarkdownViewer>
          </div>
        </ChatToolCardContent>
      ) : undefined}
    </ChatToolCard>
  );
}
