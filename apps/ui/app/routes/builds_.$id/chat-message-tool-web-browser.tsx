import { Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { parseToolErrorText } from '@taucad/chat';
import { createFaviconUrl, extractDomainFromUrl } from '#utils/url.utils.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';
import { ExternalLink } from '#components/external-link.js';

export function ChatMessageToolWebBrowser({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.webBrowser>;
}): ReactNode | undefined {
  switch (part.state) {
    case 'input-available':
    case 'input-streaming': {
      const url = part.input?.url ?? '';
      const domain = url ? extractDomainFromUrl(url, { includeTld: true }) : '';

      return (
        <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>
              {domain ? (
                <>
                  <ChatToolAction>Visiting</ChatToolAction> <ChatToolDescription>{domain}...</ChatToolDescription>
                </>
              ) : (
                'Visiting page...'
              )}
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input } = part;
      const { url } = input;
      const faviconUrl = createFaviconUrl(url);
      const domain = extractDomainFromUrl(url, { includeTld: true });

      return (
        <ChatToolCard variant="minimal" status="ready" isCollapsible={false}>
          <ChatToolCardHeader>
            <img src={faviconUrl} alt={domain} className="size-3 shrink-0 rounded-sm" />
            <ChatToolCardTitle>
              <ChatToolAction>Visited</ChatToolAction>{' '}
              <ExternalLink
                href={url}
                arrowSize="xs"
                className="text-muted-foreground no-underline hover:text-foreground hover:underline"
              >
                {domain}
              </ExternalLink>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      const error = parseToolErrorText(part.errorText);
      if (error) {
        return <ChatToolError error={error} />;
      }

      return (
        <ChatToolCard variant="minimal" status="error" isCollapsible={false}>
          <ChatToolCardHeader className="text-destructive">
            <ChatToolCardIcon icon={Globe} />
            <ChatToolCardTitle>Web browser failed</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.webBrowser} state: ${part.state}`);
    }
  }
}
