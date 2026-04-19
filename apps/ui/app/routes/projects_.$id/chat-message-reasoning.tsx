import type { ReasoningUIPart } from 'ai';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
// `useState` setter functions are stable across renders, so passing them as
// callback refs is safe — React only invokes them when the underlying element
// changes. Storing the elements in state (rather than refs) is what makes the
// auto-pin effect re-run the moment the scroll container actually attaches,
// even when an earlier render took a different JSX path that omitted the refs.
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

/**
 * Distance (px) from the bottom that still counts as "stuck to bottom".
 * Handles sub-pixel rounding and lets the user be effectively at the bottom
 * without having to land exactly on `scrollHeight - clientHeight`.
 */
const bottomTolerance = 8;

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
  const [scrollContainer, setScrollContainerState] = useState<HTMLDivElement | undefined>(undefined);
  const [content, setContentState] = useState<HTMLDivElement | undefined>(undefined);

  // Callback refs receive `null` from React on unmount; normalize to `undefined`
  // so the state matches our `null`-free convention while still letting the
  // effect re-run on attach/detach.
  // oxlint-disable @typescript-eslint/no-restricted-types -- React's callback ref contract passes `null` on unmount.
  const setScrollContainer = useCallback((element: HTMLDivElement | null): void => {
    setScrollContainerState(element ?? undefined);
  }, []);
  const setContent = useCallback((element: HTMLDivElement | null): void => {
    setContentState(element ?? undefined);
  }, []);
  // oxlint-enable @typescript-eslint/no-restricted-types
  // Tracks whether auto-pinning is active. Defaults to true so the initial mount
  // and any open-during-streaming transition snap to the latest reasoning. Flips
  // to false only when the user scrolls away from the bottom; flips back to true
  // when the user returns to within `bottomTolerance` of the bottom.
  const stickToBottomRef = useRef(true);

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

    if (!scrollContainer || !content) {
      return;
    }

    // The browser dispatches scroll events as deferred tasks after a scrollTop
    // write, with the *final* scrollTop reflecting any clamps. Under continuous
    // streaming, scrollHeight grows between the pin write and the deferred
    // scroll event, which would make a naive distance-from-bottom calculation
    // see a stale (small) scrollTop against a fresh (large) scrollHeight and
    // wrongly conclude the user moved away. We sidestep this by only mutating
    // stickiness when an actual user-input event preceded the scroll event.
    let userInteracting = false;
    let interactionTimer: ReturnType<typeof setTimeout> | undefined;
    let pinFrame = 0;

    const pinNow = (): void => {
      if (!stickToBottomRef.current) {
        return;
      }
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    };

    // ResizeObserver callbacks that synchronously mutate layout can trip the
    // browser's "ResizeObserver loop limit exceeded" guard. Defer the write to
    // the next animation frame; multiple resize bursts within one frame
    // coalesce into a single pin.
    const schedulePin = (): void => {
      if (pinFrame !== 0) {
        return;
      }
      pinFrame = globalThis.requestAnimationFrame(() => {
        pinFrame = 0;
        pinNow();
      });
    };

    // 150ms covers the next-task delivery window for the queued scroll event
    // following a user input burst, while staying short enough that subsequent
    // programmatic pin scrolls fall outside it.
    const markUserInteraction = (): void => {
      userInteracting = true;
      globalThis.clearTimeout(interactionTimer);
      interactionTimer = globalThis.setTimeout(() => {
        userInteracting = false;
      }, 150);
    };

    const handleScroll = (): void => {
      if (!userInteracting) {
        return;
      }
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
      stickToBottomRef.current = distanceFromBottom <= bottomTolerance;
    };

    pinNow();

    // `pointerdown` catches scrollbar-thumb drags (no wheel/touch precursor).
    scrollContainer.addEventListener('wheel', markUserInteraction, { passive: true });
    scrollContainer.addEventListener('touchstart', markUserInteraction, { passive: true });
    scrollContainer.addEventListener('keydown', markUserInteraction, { passive: true });
    scrollContainer.addEventListener('pointerdown', markUserInteraction, { passive: true });
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    // ResizeObserver fires post-layout, so reads of scrollHeight are accurate
    // even when Streamdown / KaTeX / Shiki reflow asynchronously.
    const observer = new ResizeObserver(schedulePin);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (pinFrame !== 0) {
        globalThis.cancelAnimationFrame(pinFrame);
      }
      globalThis.clearTimeout(interactionTimer);
      scrollContainer.removeEventListener('wheel', markUserInteraction);
      scrollContainer.removeEventListener('touchstart', markUserInteraction);
      scrollContainer.removeEventListener('keydown', markUserInteraction);
      scrollContainer.removeEventListener('pointerdown', markUserInteraction);
      scrollContainer.removeEventListener('scroll', handleScroll);
    };
  }, [isStreaming, isContentVisible, isExpanded, scrollContainer, content]);

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
        className='-ml-2 h-4 max-w-full min-w-0 gap-1.5 overflow-hidden font-medium text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent'
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
            ref={setScrollContainer}
            className={cn(
              'border-l border-foreground/20 pl-4 text-sm italic',
              !isExpanded && 'max-h-48 overflow-y-auto',
            )}
          >
            <div ref={setContent}>
              <MarkdownViewerChat className='text-muted-foreground' isStreaming={isStreaming}>
                {displayText}
              </MarkdownViewerChat>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
