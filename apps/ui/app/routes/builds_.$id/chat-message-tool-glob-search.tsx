import type { UIToolInvocation } from 'ai';
import { Files, File } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
  ChatToolCardList,
  ChatToolCardListItem,
} from '#components/chat/chat-tool-card.js';

export function ChatMessageToolGlobSearch({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.globSearch]>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const pattern = input?.pattern ?? 'pattern';

      return (
        <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardTitle>Finding files matching &quot;{pattern}&quot;...</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { pattern } = input;
      const { files, totalFiles } = output;

      return (
        <ChatToolCard variant="minimal" status="ready" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Files} />
            <ChatToolCardTitle>
              <span className="font-mono">{pattern}</span> ({totalFiles} file{totalFiles === 1 ? '' : 's'})
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          <ChatToolCardContent>
            <ChatToolCardList maxHeight="max-h-32">
              {files.length === 0 ? (
                <ChatToolCardListItem className="text-muted-foreground/70 italic">No files found</ChatToolCardListItem>
              ) : (
                <>
                  {files.slice(0, 10).map((file) => (
                    <ChatToolCardListItem key={file} icon={File}>
                      <span className="font-mono">{file}</span>
                    </ChatToolCardListItem>
                  ))}
                  {files.length > 10 ? (
                    <ChatToolCardListItem className="text-muted-foreground/70 italic">
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
      return (
        <ChatToolCard variant="minimal" status="error" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon isError icon={Files} />
            <ChatToolCardTitle>File search failed</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }
  }
}
