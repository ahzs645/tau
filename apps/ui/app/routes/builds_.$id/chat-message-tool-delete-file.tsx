import type { UIToolInvocation } from 'ai';
import { Trash2, XCircle } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';

export function ChatMessageToolDeleteFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.deleteFile]>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? 'file';

      return (
        <ChatToolCard variant="minimal" status="loading" isCollapsible={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Trash2} />
            <ChatToolCardTitle>
              <ChatToolAction>Deleting</ChatToolAction>{' '}
              <ChatToolDescription>{targetFile}...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { targetFile } = input;
      const { success } = output;

      if (success) {
        return (
          <ChatToolCard variant="minimal" status="ready" isCollapsible={false}>
            <ChatToolCardHeader>
              <ChatToolCardIcon icon={Trash2} />
              <ChatToolCardTitle>
                <ChatToolAction>Deleted</ChatToolAction>{' '}
                <ChatToolDescription>{targetFile}</ChatToolDescription>
              </ChatToolCardTitle>
            </ChatToolCardHeader>
          </ChatToolCard>
        );
      }

      return (
        <ChatToolCard variant="minimal" status="error" isCollapsible={false}>
          <ChatToolCardHeader className="text-destructive">
            <ChatToolCardIcon isError icon={XCircle} />
            <ChatToolCardTitle>
              <ChatToolAction>Failed to delete</ChatToolAction>{' '}
              <ChatToolDescription>{targetFile}</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolCard variant="minimal" status="error" isCollapsible={false}>
          <ChatToolCardHeader className="text-destructive">
            <ChatToolCardIcon isError icon={XCircle} />
            <ChatToolCardTitle>Failed to delete file</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }
  }
}
