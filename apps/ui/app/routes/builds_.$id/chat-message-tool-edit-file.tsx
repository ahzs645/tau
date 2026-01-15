import type { UIToolInvocation } from 'ai';
import type { MyTools } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { isToolExecutionError } from '@taucad/chat';
import { CollapsibleFileOperation } from '#components/chat/chat-tool-file-operation.js';
import { CopyButton } from '#components/copy-button.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

export function ChatMessageToolFileEdit({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.editFile]>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const { targetFile = '', codeEdit = '' } = input ?? {};

      return (
        <CollapsibleFileOperation targetFile={targetFile} toolStatus={part.state} mode="edit" content={codeEdit} />
      );
    }

    case 'output-available': {
      const { input, output } = part;

      // Check for structured tool errors
      if (isToolExecutionError(output)) {
        return <ChatToolError error={output} />;
      }

      const { targetFile = '' } = input;
      const { diffStats } = output;

      // Use the actual edited content for display
      const displayContent = diffStats.modifiedContent;

      return (
        <CollapsibleFileOperation
          enableFileLink
          targetFile={targetFile}
          toolStatus={part.state}
          mode="edit"
          content={displayContent}
          diffStats={diffStats}
          actions={
            <CopyButton
              size="xs"
              className="**:data-[slot=label]:hidden @xs/code:**:data-[slot=label]:flex"
              getText={() => displayContent}
            />
          }
        />
      );
    }

    case 'output-error': {
      return <div>File edit failed</div>;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.editFile} state: ${part.state}`);
    }
  }
}
