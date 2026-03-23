import type { ReasoningUIPart } from 'ai';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { MarkdownViewerChat } from '#components/markdown/markdown-viewer-chat.js';
import { useChatSelector } from '#hooks/use-chat.js';
import { ChatToolCard, ChatToolCardHeader, ChatToolCardTitle } from '#components/chat/chat-tool-card.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';

/**
 * Maximum characters rendered in preview mode.
 * Tail-truncation keeps the DOM lightweight while showing the most recent reasoning.
 * ~3000 chars fills roughly 20-30 lines of prose at text-sm, providing enough
 * context in the constrained viewport without building an oversized markdown tree.
 */
const previewTextBudget = 3000;

type ChatMessageReasoningProperties = {
  readonly part: ReasoningUIPart;
  /**
   * Whether the message has content parts after this reasoning part.
   * When true, reasoning auto-collapses to keep focus on the response.
   */
  readonly hasContent: boolean;
};

export function ChatMessageReasoning({ part, hasContent }: ChatMessageReasoningProperties): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');
  const [userToggleState, setUserToggleState] = useState<'expanded' | 'collapsed' | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const trimmedText = useMemo(() => part.text.trim(), [part.text]);
  const hasReasoningText = trimmedText !== '';

  // Three visual states:
  //   preview  — during streaming with no content after: half-height, auto-scroll
  //   collapsed — after completion (hasContent): header only
  //   expanded  — user explicitly toggled open: full height
  const isContentVisible = hasContent ? userToggleState === 'expanded' : userToggleState !== 'collapsed';

  const isExpanded = userToggleState === 'expanded';

  const displayText = useMemo(() => {
    if (!isContentVisible) {
      return '';
    }

    if (isExpanded || trimmedText.length <= previewTextBudget) {
      return trimmedText;
    }

    const tail = trimmedText.slice(-previewTextBudget);
    const paragraphBreak = tail.indexOf('\n\n');
    return paragraphBreak > 0 ? tail.slice(paragraphBreak + 2) : tail;
  }, [trimmedText, isExpanded, isContentVisible]);

  useEffect(() => {
    if (!isStreaming || !isContentVisible || isExpanded) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    });
  }, [displayText, isStreaming, isContentVisible, isExpanded]);

  const handleToggle = useCallback((): void => {
    setUserToggleState((previous) => {
      if (previous === 'expanded') {
        return 'collapsed';
      }

      return 'expanded';
    });
  }, []);

  if (!hasReasoningText) {
    return (
      <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
        <ChatToolCardHeader>
          <ChatToolCardTitle>Thinking...</ChatToolCardTitle>
        </ChatToolCardHeader>
      </ChatToolCard>
    );
  }

  return (
    <div>
      <Button
        variant='ghost'
        size='xs'
        className='-ml-2 max-w-full min-w-0 gap-1.5 overflow-hidden font-medium text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent'
        onClick={handleToggle}
      >
        <Brain className='size-3 shrink-0' />
        <span className='flex min-w-0 items-baseline gap-1'>Thought process</span>
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform duration-200', isContentVisible && 'rotate-90')}
        />
      </Button>

      {isContentVisible ? (
        <div className='pl-1.5'>
          <div
            ref={scrollContainerRef}
            className={cn(
              'border-l border-foreground/20 pl-4 text-sm italic',
              !isExpanded && 'max-h-48 overflow-y-auto',
            )}
          >
            <MarkdownViewerChat className='text-muted-foreground' isStreaming={isStreaming}>
              {displayText}
            </MarkdownViewerChat>
          </div>
        </div>
      ) : null}
    </div>
  );
}
