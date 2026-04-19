import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { Button } from '#components/ui/button.js';
import { ChatActivitySummary } from '#components/chat/chat-activity-summary.js';
import { useActivityFoldContext } from '#components/chat/chat-activity-fold-context.js';

type ChatActivityGroupProps = {
  /** Verb fragment, e.g. `"Explored"`. Rendered with emphasis. */
  readonly summaryVerb: string;
  /** Detail fragment, e.g. `"5 files, 1 search"`. Rendered de-emphasized. */
  readonly summaryDetail: string;
  readonly children: React.ReactNode;
  /**
   * When true, this is the trailing live group: render children inline with no
   * header, no border, and no indent. The user can still explicitly collapse
   * to surface the header (escape hatch).
   */
  readonly isLast?: boolean;
};

/**
 * Inner fold for an aggregated tool group.
 *
 * Three render modes (checked in order):
 * - **Wrapped (`disableInnerFold=true` from {@link useActivityFoldContext}):**
 *   an ancestor (e.g. `ChatActivitySection`) is the canonical outer fold and
 *   already carries the summary, so this group renders children inline with no
 *   chrome at all. The user toggle does not surface a header in this mode —
 *   the ancestor's toggle is the user's control surface.
 * - **Live (`isLast=true` and not user-collapsed):** children render inline
 *   with no chrome at all — matches Cursor's streaming research UX where the
 *   latest group is visually flat until a downstream part closes it.
 * - **Closed (`isLast=false`, or user collapsed a live group):** a one-line
 *   two-tone summary header (verb + detail) with a chevron expands to reveal
 *   the same children flat (no border, no indent).
 *
 * User toggles are persistent across `isLast` transitions: once a user
 * explicitly opens or closes the group, that preference wins over the
 * automatic `isLast` behavior.
 */
export function ChatActivityGroup({
  summaryVerb,
  summaryDetail,
  children,
  isLast = false,
}: ChatActivityGroupProps): React.ReactNode {
  const { disableInnerFold } = useActivityFoldContext();
  const [userToggleState, setUserToggleState] = useState<'expanded' | 'collapsed' | undefined>(undefined);

  if (disableInnerFold) {
    return children;
  }

  if (isLast && userToggleState !== 'collapsed') {
    return children;
  }

  const isOpen = userToggleState === 'expanded';

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
        <div className='ml-4 flex flex-col'>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
