import { useState } from 'react';
import { ChevronRight, Globe } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ExternalLink } from '#components/external-link.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { extractDomainFromUrl, createFaviconUrl } from '#utils/url.utils.js';
import { cn } from '#utils/ui.utils.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

const maxVisibleSources = 5;

type WebSource = {
  url: string;
  title: string;
  content: string;
};

function SourceItem({ source }: { readonly source: WebSource }): React.JSX.Element {
  const domain = extractDomainFromUrl(source.url);
  const faviconUrl = createFaviconUrl(source.url);

  return (
    <ExternalLink
      href={source.url}
      arrowSize='xs'
      className='flex items-center gap-2 py-0.5 text-xs text-muted-foreground no-underline hover:text-foreground hover:underline'
    >
      <img src={faviconUrl} alt={domain} className='size-3.5 shrink-0 rounded-sm' />
      <span className='shrink-0 font-medium'>{domain}</span>
      <span className='text-muted-foreground/50'>-</span>
      <span className='min-w-0 truncate'>{source.title}</span>
    </ExternalLink>
  );
}

function SourcesList({ sources }: { readonly sources: WebSource[] }): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);

  const visibleSources = sources.slice(0, maxVisibleSources);
  const hiddenSources = sources.slice(maxVisibleSources);
  const hasMoreSources = hiddenSources.length > 0;

  return (
    <div className='flex flex-col'>
      {/* Always visible sources */}
      {visibleSources.map((source) => (
        <SourceItem key={source.url} source={source} />
      ))}

      {/* Expandable section for additional sources */}
      {hasMoreSources ? (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger className='group flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'>
            <ChevronRight
              className={cn('size-3 shrink-0 transition-transform duration-200', isExpanded && 'rotate-90')}
            />
            <span>...and {hiddenSources.length} more</span>
            <div className='flex items-center gap-0.5'>
              {hiddenSources.slice(0, 6).map((source) => {
                const domain = extractDomainFromUrl(source.url);
                const faviconUrl = createFaviconUrl(source.url);

                return (
                  <img key={source.url} src={faviconUrl} alt={domain} className='size-3.5 rounded-sm opacity-60' />
                );
              })}
              {hiddenSources.length > 6 ? (
                <span className='ml-0.5 text-[10px] text-muted-foreground/50'>+{hiddenSources.length - 6}</span>
              ) : undefined}
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className='flex flex-col pl-4'>
              {hiddenSources.map((source) => (
                <SourceItem key={source.url} source={source} />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : undefined}
    </div>
  );
}

export function ChatMessageToolWebSearch({
  part,
  hasContent,
}: {
  readonly part: ToolInvocation<typeof toolName.webSearch>;
  /**
   * Whether there is subsequent content in the message after this tool.
   * When true, the sources list will collapse. When false, it stays open.
   */
  readonly hasContent: boolean;
}): React.JSX.Element | undefined {
  const [isOpen, setIsOpen] = useState(false);

  switch (part.state) {
    case 'input-available':
    case 'input-streaming': {
      const query = part.input?.query ?? '';

      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>
              {query ? (
                <>
                  <ChatToolAction>Searching web</ChatToolAction>
                  <ChatToolDescription>
                    <span className='italic'>{query}</span>
                  </ChatToolDescription>
                </>
              ) : (
                'Searching the web...'
              )}
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={Globe} fallbackTitle='Web search failed' />;
    }

    case 'output-available': {
      const sources = part.output;
      const { query } = part.input;

      if (sources.length === 0) {
        return (
          <ChatToolCard variant='minimal' status='ready' isCollapsible={false}>
            <ChatToolCardHeader>
              <ChatToolCardIcon icon={Globe} />
              <ChatToolCardTitle>No sources found</ChatToolCardTitle>
            </ChatToolCardHeader>
          </ChatToolCard>
        );
      }

      // Show sources while there's no subsequent content, collapse when content arrives
      const shouldBeOpen = !hasContent || isOpen;

      return (
        <ChatToolCard variant='minimal' status='ready' isOpen={shouldBeOpen} onOpenChange={setIsOpen}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>
              <ChatToolAction>Searched web</ChatToolAction>
              <ChatToolDescription>
                <span className='italic'>{query}</span>
              </ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          <ChatToolCardContent className='border-l-0'>
            <div className='border-l border-foreground/20 pl-4'>
              <SourcesList sources={sources} />
            </div>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.webSearch} state: ${part.state}`);
    }
  }
}
