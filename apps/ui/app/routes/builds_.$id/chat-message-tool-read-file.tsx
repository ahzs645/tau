import type { UIToolInvocation } from 'ai';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { FileLink } from '#components/files/file-link.js';
import { ChatToolInlineLink } from '#components/chat/chat-tool-inline.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';

function formatLineRange(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) {
    return '';
  }

  const startLine = offset ?? 1;

  if (limit === undefined) {
    return ` L${startLine}`;
  }

  const endLine = startLine + limit - 1;
  return ` L${startLine}-${endLine}`;
}

export function ChatMessageToolReadFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.readFile]>;
}): ReactNode {
  const { input } = part;
  const targetFile = input?.targetFile ?? 'file';
  const lineRange = formatLineRange(input?.offset, input?.limit);

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <ChatToolInlineLink status="loading">
          <ChatToolAction>Reading</ChatToolAction>{' '}
          <ChatToolDescription>
            {targetFile}
            {lineRange}...
          </ChatToolDescription>
        </ChatToolInlineLink>
      );
    }

    case 'output-available': {
      const { input } = part;
      const { targetFile } = input;
      const lineRange = formatLineRange(input.offset, input.limit);
      const startLine = input.offset ?? 1;

      return (
        <ChatToolInlineLink status="ready">
          <ChatToolAction>Read</ChatToolAction>{' '}
          <FileLink path={targetFile} lineNumber={startLine} className="text-foreground/50">
            {targetFile}
            {lineRange}
          </FileLink>
        </ChatToolInlineLink>
      );
    }

    case 'output-error': {
      return <span className="text-sm text-destructive">Failed to read file</span>;
    }
  }
}
