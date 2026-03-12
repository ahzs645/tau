import { Files, File } from 'lucide-react';
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

export function ChatMessageToolGlobSearch({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.globSearch>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const pattern = input?.pattern ?? 'pattern';

      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardTitle>
              <ChatToolAction>Finding files matching</ChatToolAction>
              <ChatToolDescription>&quot;{pattern}&quot;...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { pattern } = input;
      const { files, totalFiles } = output;

      return (
        <ChatToolCard variant='minimal' status='ready' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Files} />
            <ChatToolCardTitle>
              <ChatToolAction className='min-w-0 shrink truncate'>
                <span className='font-mono'>{pattern}</span>
              </ChatToolAction>
              <ChatToolDescription className='shrink-0'>
                ({totalFiles} file{totalFiles === 1 ? '' : 's'})
              </ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          <ChatToolCardContent>
            <ChatToolCardList maxHeight='max-h-32'>
              {files.length === 0 ? (
                <ChatToolCardListItem className='text-muted-foreground/70 italic'>No files found</ChatToolCardListItem>
              ) : (
                <>
                  {files.slice(0, 10).map((file) => (
                    <ChatToolCardListItem key={file} icon={File}>
                      <span className='font-mono'>{file}</span>
                    </ChatToolCardListItem>
                  ))}
                  {files.length > 10 ? (
                    <ChatToolCardListItem className='text-muted-foreground/70 italic'>
                      ... {files.length - 10} more files
                    </ChatToolCardListItem>
                  ) : undefined}
                </>
              )}
            </ChatToolCardList>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={Files} fallbackTitle='File search failed' />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.globSearch} state: ${part.state}`);
    }
  }
}
