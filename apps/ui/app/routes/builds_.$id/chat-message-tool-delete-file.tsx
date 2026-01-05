import type { UIToolInvocation } from 'ai';
import { Trash2, Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { ChatToolInline } from '#components/chat/chat-tool-inline.js';

export function ChatMessageToolDeleteFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.deleteFile]>;
}): ReactNode {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? 'file';

      return (
        <ChatToolInline status="loading" icon={Trash2}>
          Deleting {targetFile}...
        </ChatToolInline>
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { targetFile } = input;
      const { success } = output;

      return (
        <ChatToolInline status={success ? 'success' : 'error'} icon={success ? Check : X}>
          {success ? `Deleted ${targetFile}` : `Failed to delete ${targetFile}`}
        </ChatToolInline>
      );
    }

    case 'output-error': {
      return (
        <ChatToolInline status="error" icon={X}>
          Failed to delete file
        </ChatToolInline>
      );
    }
  }
}
