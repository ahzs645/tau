import { Globe } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { createFaviconUrl, extractDomainFromUrl, safeExtractDomainFromUrl } from '#utils/url.utils.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolLabel } from '#components/chat/chat-tool-label.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';
import { ExternalLink } from '#components/external-link.js';

function BrowseSourceItem({ url }: { readonly url: string }): React.JSX.Element {
  const domain = extractDomainFromUrl(url);
  const faviconUrl = createFaviconUrl(url);

  return (
    <ExternalLink
      href={url}
      arrowSize='xs'
      className='flex w-full min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground no-underline hover:text-foreground hover:underline'
    >
      <img src={faviconUrl} alt={domain} className='size-3.5 shrink-0 rounded-sm' />
      <span className='min-w-0 truncate font-medium'>{domain}</span>
    </ExternalLink>
  );
}

export function ChatMessageToolWebBrowser({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.webBrowser>;
}): React.JSX.Element | undefined {
  switch (part.state) {
    case 'input-available':
    case 'input-streaming': {
      const urls = (part.input?.urls ?? []).filter((url): url is string => typeof url === 'string');
      const domains = urls
        .map((url) => safeExtractDomainFromUrl(url, { includeTld: true }))
        .filter((domain): domain is string => domain !== undefined);

      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>
              <ChatToolLabel verb='Visiting pages'>
                {domains.length > 0 ? <ChatToolDescription>{domains.join(', ')}</ChatToolDescription> : undefined}
              </ChatToolLabel>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input } = part;
      const { urls } = input;
      const firstUrl = urls[0]!;
      const firstDomain = extractDomainFromUrl(firstUrl, { includeTld: true });
      const faviconUrl = createFaviconUrl(firstUrl);
      const remainingCount = urls.length - 1;

      return (
        <ChatToolCard variant='minimal' status='ready' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <img src={faviconUrl} alt={firstDomain} className='size-3 shrink-0 rounded-sm' />
            <ChatToolCardTitle>
              <ChatToolLabel verb='Visited'>
                <ChatToolDescription>
                  {firstDomain}
                  {remainingCount > 0 && (
                    <>
                      {' '}
                      and {remainingCount} other {remainingCount === 1 ? 'page' : 'pages'}
                    </>
                  )}
                </ChatToolDescription>
              </ChatToolLabel>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          {urls.length > 0 && (
            <ChatToolCardContent className='border-l-0'>
              <div className='border-l border-foreground/20 pl-4'>
                <div className='flex flex-col'>
                  {urls.map((url) => (
                    <BrowseSourceItem key={url} url={url} />
                  ))}
                </div>
              </div>
            </ChatToolCardContent>
          )}
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={Globe} fallbackTitle='Failed to browse the web' />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.webBrowser} state: ${part.state}`);
    }
  }
}
