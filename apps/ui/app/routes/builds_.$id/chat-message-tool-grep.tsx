import { Search } from 'lucide-react';
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

export function ChatMessageToolGrep({ part }: { readonly part: ToolInvocation<typeof toolName.grep> }): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const pattern = input?.pattern ?? 'pattern';

      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardTitle>
              <ChatToolAction>Searching for</ChatToolAction>
              <ChatToolDescription>&quot;{pattern}&quot;...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { pattern } = input;
      const { matches, totalMatches, truncated } = output;

      // Group matches by file
      const matchesByFile = new Map<string, typeof matches>();
      for (const match of matches) {
        if (!matchesByFile.has(match.file)) {
          matchesByFile.set(match.file, []);
        }

        matchesByFile.get(match.file)?.push(match);
      }

      return (
        <ChatToolCard variant='minimal' status='ready' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Search} />
            <ChatToolCardTitle>
              <ChatToolAction className='min-w-0 shrink truncate'>
                <span className='font-mono'>/{pattern}/</span>
              </ChatToolAction>
              <ChatToolDescription className='shrink-0'>
                ({totalMatches} match{totalMatches === 1 ? '' : 'es'}
                {truncated ? ', truncated' : ''})
              </ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          <ChatToolCardContent>
            <ChatToolCardList maxHeight='max-h-40'>
              {matches.length === 0 ? (
                <ChatToolCardListItem className='text-muted-foreground/70 italic'>
                  No matches found
                </ChatToolCardListItem>
              ) : (
                [...matchesByFile.entries()].slice(0, 5).map(([file, fileMatches]) => (
                  <div key={file} className='py-1'>
                    <div className='text-xs font-medium text-foreground/80'>{file}</div>
                    {fileMatches.slice(0, 3).map((match) => (
                      <div
                        key={`${match.file}:${match.line}`}
                        className='flex gap-2 pl-2 text-xs text-muted-foreground'
                      >
                        <span className='shrink-0 font-mono opacity-60'>{match.line}:</span>
                        <span className='truncate font-mono'>{match.content.trim()}</span>
                      </div>
                    ))}
                    {fileMatches.length > 3 ? (
                      <div className='pl-2 text-xs text-muted-foreground/70 italic'>
                        ... {fileMatches.length - 3} more matches
                      </div>
                    ) : undefined}
                  </div>
                ))
              )}
              {matchesByFile.size > 5 ? (
                <ChatToolCardListItem className='text-muted-foreground/70 italic'>
                  ... {matchesByFile.size - 5} more files
                </ChatToolCardListItem>
              ) : undefined}
            </ChatToolCardList>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={Search} fallbackTitle='Search failed' />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.grep} state: ${part.state}`);
    }
  }
}
