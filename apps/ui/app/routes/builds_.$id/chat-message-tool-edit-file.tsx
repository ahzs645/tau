import type { UIToolInvocation } from 'ai';
import { useCallback } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { waitFor } from 'xstate';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { CollapsibleFileOperation, ApplyButton } from '#components/chat/chat-tool-file-operation.js';
import { CopyButton } from '#components/copy-button.js';
import { useBuild } from '#hooks/use-build.js';
import { fileEditMachine } from '#machines/file-edit.machine.js';
import { decodeTextFile, encodeTextFile } from '#utils/filesystem.utils.js';
import { useFileManager } from '#hooks/use-file-manager.js';

export function ChatMessageToolFileEdit({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.editFile]>;
}): React.JSX.Element {
  const { getMainFilename } = useBuild();

  // Create file edit machine
  const fileEditRef = useActorRef(fileEditMachine);
  const fileEditState = useSelector(fileEditRef, (state) => state.value);
  const fileEditError = useSelector(fileEditRef, (state) => state.context.error);
  const fileManager = useFileManager();

  const handleApplyEdit = useCallback(
    async (targetFile: string, editInstructions: string) => {
      const mainFilename = await getMainFilename();
      const resolvedPath = targetFile || mainFilename;

      const currentCode = await fileManager.readFile(resolvedPath);

      fileEditRef.start();
      fileEditRef.send({
        type: 'applyEdit',
        request: {
          targetFile: resolvedPath,
          originalContent: decodeTextFile(currentCode),
          codeEdit: editInstructions,
        },
      });

      const snapshot = await waitFor(fileEditRef, (state) => state.matches('success') || state.matches('error'));
      if (snapshot.matches('success')) {
        const { result } = snapshot.context;
        if (!result?.editedContent) {
          throw new Error('No content received from file edit service');
        }

        void fileManager.writeFile(resolvedPath, encodeTextFile(result.editedContent), { source: 'external' });
      }

      if (snapshot.matches('error')) {
        const { error } = snapshot.context;
        throw new Error(`File edit failed: ${error}`);
      }
    },
    [fileEditRef, fileManager, getMainFilename],
  );

  const getApplyState = (): 'idle' | 'applying' | 'success' | 'error' => {
    if (fileEditState === 'applying') {
      return 'applying';
    }

    if (fileEditState === 'success') {
      return 'success';
    }

    if (fileEditState === 'error') {
      return 'error';
    }

    return 'idle';
  };

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
      const { targetFile = '', codeEdit = '' } = input;
      const { diffStats } = output;

      // Use the actual edited content for display if available, otherwise fallback to codeEdit
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
            <>
              <CopyButton
                size="xs"
                className="**:data-[slot=label]:hidden @xs/code:**:data-[slot=label]:flex"
                getText={() => displayContent}
              />
              <ApplyButton
                state={getApplyState()}
                error={fileEditError}
                onApply={() => {
                  void handleApplyEdit(targetFile, codeEdit);
                }}
              />
            </>
          }
        />
      );
    }

    case 'output-error': {
      return <div>File edit failed</div>;
    }
  }
}
