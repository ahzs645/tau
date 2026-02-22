import { useState } from 'react';
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
import { ChatToolAction } from '#components/chat/chat-tool-text.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';
import { ExternalLink } from '#components/external-link.js';

function BrowseSourceItem({ url }: { readonly url: string }): React.JSX.Element {
  const domain = extractDomainFromUrl(url);
  const faviconUrl = createFaviconUrl(url);

  return (
    <ExternalLink
      href={url}
      arrowSize="xs"
      className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground no-underline hover:text-foreground hover:underline"
    >
      <img src={faviconUrl} alt={domain} className="size-3.5 shrink-0 rounded-sm" />
      <span className="min-w-0 truncate font-medium">{domain}</span>
    </ExternalLink>
  );
}

export function ChatMessageToolWebBrowser({
  part,
  hasContent,
}: {
  readonly part: ToolInvocation<typeof toolName.webBrowser>;
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
      const urls = (part.input?.urls ?? []).filter((url): url is string => typeof url === 'string');
      const domains = urls
        .map((url) => safeExtractDomainFromUrl(url, { includeTld: true }))
        .filter((domain): domain is string => domain !== undefined);

      return (
        <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>
              {domains.length > 0 ? (
                <>
                  <ChatToolAction>Visiting</ChatToolAction>{' '}
                  <span className="text-muted-foreground">{domains.join(', ')}...</span>
                </>
              ) : (
                'Visiting pages...'
              )}
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

      // Show sources while there's no subsequent content, collapse when content arrives
      const shouldBeOpen = !hasContent || isOpen;

      return (
        <ChatToolCard variant="minimal" status="ready" isOpen={shouldBeOpen} onOpenChange={setIsOpen}>
          <ChatToolCardHeader>
            <img src={faviconUrl} alt={firstDomain} className="size-3 shrink-0 rounded-sm" />
            <ChatToolCardTitle>
              <ChatToolAction>Visited</ChatToolAction>{' '}
              <span className="text-muted-foreground">
                {firstDomain}
                {remainingCount > 0 && (
                  <>
                    {' '}
                    and {remainingCount} other {remainingCount === 1 ? 'page' : 'pages'}
                  </>
                )}
              </span>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          {urls.length > 0 && (
            <ChatToolCardContent className="border-l-0">
              <div className="border-l border-foreground/20 pl-4">
                <div className="flex flex-col">
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
      return <ChatToolError errorText={part.errorText} fallbackIcon={Globe} fallbackTitle="Web browser failed" />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.webBrowser} state: ${part.state}`);
    }
  }
}
