import { Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { parseToolErrorText } from '@taucad/chat';
import { createFaviconUrl, extractDomainFromUrl } from '#utils/url.utils.js';
import { ChatToolInline } from '#components/chat/chat-tool-inline.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

export function ChatMessageToolWebBrowser({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.webBrowser>;
}): ReactNode | undefined {
  switch (part.state) {
    case 'input-available':
    case 'output-available': {
      const { input } = part;
      const { url } = input;
      const faviconUrl = createFaviconUrl(url);
      const domain = extractDomainFromUrl(url, { includeTld: true });

      if (part.state === 'input-available') {
        return (
          <ChatToolInline status="loading" icon={Globe}>
            Visiting {domain}...
          </ChatToolInline>
        );
      }

      return (
        <ChatToolInline status="success" image={{ src: faviconUrl, alt: domain }}>
          <ChatToolAction>Visited</ChatToolAction> <ChatToolDescription>{domain}</ChatToolDescription>
        </ChatToolInline>
      );
    }

    case 'input-streaming': {
      return null;
    }

    case 'output-error': {
      const error = parseToolErrorText(part.errorText);
      if (error) {
        return <ChatToolError error={error} />;
      }

      return (
        <ChatToolInline status="error" icon={Globe}>
          Web browser failed
        </ChatToolInline>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.webBrowser} state: ${part.state}`);
    }
  }
}
