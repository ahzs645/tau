import type { UIToolInvocation } from 'ai';
import { useCallback } from 'react';
import { X } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { CollapsibleFileOperation, CodePreview } from '#components/chat/chat-tool-file-operation.js';
import { useBuild } from '#hooks/use-build.js';

export function ChatMessageToolCreateFile({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.createFile]>;
}): React.JSX.Element {
  const build = useBuild({ enableNoContext: true });

  const handleFileClick = useCallback(
    (path: string) => {
      if (!build) {
        return;
      }

      build.fileExplorerRef.send({
        type: 'openFile',
        path,
        lineNumber: 1,
        column: 1,
      });
    },
    [build],
  );

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? 'file';
      const content = input?.content ?? '';

      return (
        <CollapsibleFileOperation targetFile={targetFile} toolStatus={part.state} mode="create" content={content} />
      );
    }

    case 'output-available': {
      const { input, output } = part;
      const { targetFile, content } = input;
      const { success } = output;

      return (
        <CollapsibleFileOperation
          targetFile={targetFile}
          toolStatus={part.state}
          mode="create"
          isSuccess={success}
          onFileClick={() => {
            handleFileClick(targetFile);
          }}
        >
          {success && content ? <CodePreview content={content} /> : null}
        </CollapsibleFileOperation>
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
  }
}
