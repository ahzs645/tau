import { FolderOpen, Folder, File } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
  ChatToolCardList,
  ChatToolCardListItem,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

export function ChatMessageToolListDirectory({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.listDirectory>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const path = input?.path ?? '/';

      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardTitle>
              <ChatToolAction>Listing</ChatToolAction>
              <ChatToolDescription>{path}...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { entries, path } = output;

      // Sort entries: directories first, then files
      const sortedEntries = [...entries].sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'dir' ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      });

      return (
        <ChatToolCard variant='minimal' status='ready' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={FolderOpen} />
            <ChatToolCardTitle>
              <ChatToolAction>Listed</ChatToolAction>
              <ChatToolDescription>
                {path || '/'} ({entries.length} items)
              </ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          <ChatToolCardContent>
            <ChatToolCardList maxHeight='max-h-40'>
              {sortedEntries.length === 0 ? (
                <ChatToolCardListItem className='text-muted-foreground/70 italic'>
                  (empty directory)
                </ChatToolCardListItem>
              ) : (
                sortedEntries.map((entry) => (
                  <ChatToolCardListItem
                    key={entry.name}
                    icon={entry.type === 'dir' ? Folder : File}
                    className={entry.type === 'dir' ? '[&_svg]:text-warning' : ''}
                  >
                    {entry.name}
                  </ChatToolCardListItem>
                ))
              )}
            </ChatToolCardList>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolError errorText={part.errorText} fallbackIcon={FolderOpen} fallbackTitle='Failed to list directory' />
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.listDirectory} state: ${part.state}`);
    }
  }
}
