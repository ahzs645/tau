import { FlaskConical } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { CollapsibleFileOperation } from '#components/chat/chat-tool-file-operation.js';
import { CopyButton } from '#components/copy-button.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

const testFile = 'test.json';

export function ChatMessageToolEditTests({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.editTests>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const { codeEdit = '' } = input ?? {};

      return <CollapsibleFileOperation targetFile={testFile} toolStatus={part.state} content={codeEdit} />;
    }

    case 'output-available': {
      const { output } = part;
      const { diffStats } = output;

      // Use the actual edited content for display
      const displayContent = diffStats.modifiedContent;

      return (
        <CollapsibleFileOperation
          enableFileLink
          targetFile={testFile}
          toolStatus={part.state}
          content={displayContent}
          diffStats={diffStats}
          actions={
            <CopyButton
              size='xs'
              className='**:data-[slot=label]:hidden @xs/code:**:data-[slot=label]:flex'
              getText={() => displayContent}
            />
          }
        />
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={FlaskConical} fallbackTitle='Edit tests failed' />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.editTests} state: ${part.state}`);
    }
  }
}
