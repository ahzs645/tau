import { useChat } from '@ai-sdk/react';
import { useState, useEffect, useCallback } from 'react';
import { useSelector } from '@xstate/react';
import type { MyUIMessage } from '@taucad/chat';
import { defaultProjectName } from '#constants/project-names.js';
import { useProject } from '#hooks/use-project.js';
import { useProjectManager } from '#hooks/use-project-manager.js';
import { useChatConstants } from '#utils/chat.utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';
import { Loader } from '#components/ui/loader.js';
import { InlineTextEditor } from '#components/inline-text-editor.js';

const animationDuration = 2000;

export function ProjectNameEditor(): React.JSX.Element {
  const { projectRef, editorRef, updateName } = useProject();
  const projectName = useSelector(projectRef, (state) => state.context.project?.name) ?? '';
  const isLoading = useSelector(projectRef, (state) => state.context.isLoading);
  const isProjectError = useSelector(projectRef, (state) => state.matches('error'));
  const activeChatId = useSelector(editorRef, (state) => state.context.lastChatId);
  const { getChat } = useProjectManager();

  const [displayName, setDisplayName] = useState<string>(projectName);
  const [isNameAnimating, setIsNameAnimating] = useState(false);
  const [activeChatFirstMessage, setActiveChatFirstMessage] = useState<MyUIMessage | undefined>(undefined);

  const { sendMessage } = useChat({
    ...useChatConstants,
    onFinish({ message }) {
      const textPart = message.parts.find((part) => part.type === 'text');
      if (textPart) {
        updateName(textPart.text);
        setDisplayName(textPart.text);
        setIsNameAnimating(true);
        // Reset the animation flag after animation completes
        setTimeout(() => {
          setIsNameAnimating(false);
        }, animationDuration);
      }
    },
  });

  // Load active chat's first message for name generation
  const loadActiveChatFirstMessage = useCallback(async () => {
    if (!activeChatId) {
      setActiveChatFirstMessage(undefined);
      return;
    }

    const chat = await getChat(activeChatId);
    setActiveChatFirstMessage(chat?.messages[0]);
  }, [activeChatId, getChat]);

  useEffect(() => {
    void loadActiveChatFirstMessage();
  }, [loadActiveChatFirstMessage]);

  // Set initial name and trigger generation if needed
  useEffect(() => {
    if (isLoading || !projectName) {
      return;
    }

    if (projectName === defaultProjectName && activeChatFirstMessage) {
      // Create and send message for name generation
      const message = {
        ...activeChatFirstMessage,
        metadata: {
          model: 'name-generator',
        },
      } as const satisfies MyUIMessage;
      void sendMessage(message);
    } else {
      setDisplayName(projectName);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only run after loading completes
  }, [projectName, isLoading, activeChatFirstMessage]);

  // Render display content based on state
  const renderDisplayContent = (value: string): React.ReactNode => {
    if (isProjectError) {
      return 'Build not found';
    }

    if (value === '') {
      return <Loader />;
    }

    return value;
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InlineTextEditor
          value={displayName}
          isDisabled={isProjectError}
          className='h-7 [&_[data-slot=button]]:w-auto [&_[data-slot=button]]:max-w-48'
          renderDisplay={(value) => (
            <span data-animate={isNameAnimating} className='truncate data-[animate=true]:animate-typewriter-20'>
              {renderDisplayContent(value)}
            </span>
          )}
          onSave={(value) => {
            updateName(value);
            setDisplayName(value);
          }}
        />
      </TooltipTrigger>
      <TooltipContent>{isProjectError ? 'Build not found' : 'Edit name'}</TooltipContent>
    </Tooltip>
  );
}
