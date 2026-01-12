import type { UIToolInvocation } from 'ai';
import { X } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { CollapsibleFileOperation } from '#components/chat/chat-tool-file-operation.js';

export function ChatMessageToolCreateFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.createFile]>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? '';
      const content = input?.content ?? '';

      return (
        <CollapsibleFileOperation targetFile={targetFile} toolStatus={part.state} mode="create" content={content} />
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { targetFile, content } = input;
      const { success, diffStats } = output;

      return (
        <CollapsibleFileOperation
          enableFileLink
          targetFile={targetFile}
          toolStatus={part.state}
          mode="create"
          content={success ? content : undefined}
          isSuccess={success}
          diffStats={diffStats}
        />
      );
    }

    case 'output-error': {
      return (
        <div className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <X className="size-4" />
          <span>Failed to create file</span>
        </div>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.createFile} state: ${part.state}`);
    }
  }
}
