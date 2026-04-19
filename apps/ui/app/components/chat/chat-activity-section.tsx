import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { Button } from '#components/ui/button.js';
import { ChatActivitySummary } from '#components/chat/chat-activity-summary.js';
import { ActivityFoldContext } from '#components/chat/chat-activity-fold-context.js';

const foldDisabledValue = { disableInnerFold: true } as const;

type ChatActivitySectionProps = {
  /** Verb fragment, e.g. `"Explored"`. Rendered with emphasis in the header. */
  readonly summaryVerb: string;
  /** Detail fragment, e.g. `"12 searches, 2 fetches"`. Rendered de-emphasized. */
  readonly summaryDetail: string;
  readonly children: React.ReactNode;
  /**
   * When true, the section defaults to collapsed — the final answer text is
   * already visible, so the activity trace can be tucked away.
   */
  readonly hasDownstreamText?: boolean;
  /** When true, auto-opens this section (it is the trailing activity with no text after it yet). */
  readonly isLast?: boolean;
};

/**
 * Outer fold for the entire activity prefix of an assistant message.
 * Wraps reasoning + aggregated tool groups in a single collapsible region.
 *
 * Uses controlled open state driven by `isLast` / `hasDownstreamText` (auto)
 * with user toggle override. Header label matches the inner
 * `ChatActivityGroup` header via the shared {@link ChatActivitySummary}
 * component so both fold levels share the same verb/detail typography.
 */
export function ChatActivitySection({
  summaryVerb,
  summaryDetail,
  children,
  hasDownstreamText = false,
  isLast = false,
}: ChatActivitySectionProps): React.JSX.Element {
  const [userToggleState, setUserToggleState] = useState<'expanded' | 'collapsed' | undefined>(undefined);

  const isOpen =
    userToggleState === 'expanded' ? true : userToggleState === 'collapsed' ? false : isLast || !hasDownstreamText;

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(nextOpen) => {
        setUserToggleState(nextOpen ? 'expanded' : 'collapsed');
      }}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant='ghost'
          size='xs'
          className='-ml-2 flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden hover:bg-transparent dark:hover:bg-transparent'
        >
          <ChevronRight className='size-3 shrink-0 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-90' />
          <ChatActivitySummary verb={summaryVerb} detail={summaryDetail} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='flex flex-col pl-4'>
          <ActivityFoldContext.Provider value={foldDisabledValue}>{children}</ActivityFoldContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
