import type { UIToolInvocation } from 'ai';
import { useCallback } from 'react';
import type { ReactNode, MouseEvent } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { useBuild } from '#hooks/use-build.js';
import { ChatToolInlineLink } from '#components/chat/chat-tool-inline.js';

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
  const build = useBuild({ enableNoContext: true });

  const handleClick = useCallback(
    (event: MouseEvent, path: string, lineNumber?: number) => {
      event.preventDefault();
      if (!build) {
        return;
      }

      build.fileExplorerRef.send({
        type: 'openFile',
        path,
        lineNumber,
        column: 1,
      });
    },
    [build],
  );

  const { input } = part;
  const targetFile = input?.targetFile ?? 'file';
  const lineRange = formatLineRange(input?.offset, input?.limit);
  const startLine = input?.offset ?? 1;

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <ChatToolInlineLink
          status="loading"
          onClick={(event) => {
            handleClick(event, targetFile, startLine);
          }}
        >
          Reading {targetFile}
          {lineRange}...
        </ChatToolInlineLink>
      );
    }

    case 'output-available': {
      const { input } = part;
      const { targetFile } = input;
      const lineRange = formatLineRange(input.offset, input.limit);
      const startLine = input.offset ?? 1;

      return (
        <ChatToolInlineLink
          status="ready"
          onClick={(event) => {
            handleClick(event, targetFile, startLine);
          }}
        >
          <span className="font-medium">Read</span> {targetFile}
          {lineRange}
        </ChatToolInlineLink>
      );
    }

    case 'output-error': {
      return <span className="text-sm text-destructive">Failed to read file</span>;
    }
  }
}
