import { memo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { messageRole, messageStatus } from '@taucad/chat/constants';
import { getRandomExamples } from '#constants/chat-prompt-examples.js';
import type { ChatExample } from '#constants/chat-prompt-examples.js';
import { Button } from '#components/ui/button.js';
import { useChatActions } from '#hooks/use-chat.js';
import { useActiveChatModel } from '#hooks/use-active-chat-model.js';
import { createMessage } from '#utils/chat.utils.js';
import { EmptyItems } from '#components/ui/empty-items.js';
import { useChatSnapshot } from '#hooks/use-chat-snapshot.js';

export const ChatExamples = memo(function () {
  // Use lazy initialization to ensure consistent examples across renders
  const [examples, setExamples] = useState(() => getRandomExamples(3));
  const { sendMessage } = useChatActions();
  // R6/E8: stamp messages with the chat-scoped model so quickly-clicked
  // examples respect the chat's pinned selection rather than a stale
  // cookie that may have shifted in another tab.
  const { modelId } = useActiveChatModel();
  const snapshot = useChatSnapshot();

  const handleExampleClick = (example: ChatExample) => {
    const userMessage = createMessage({
      content: example.prompt,
      role: messageRole.user,
      metadata: {
        model: modelId,
        status: messageStatus.pending,
        snapshot,
      },
    });
    sendMessage(userMessage);
  };

  const handleRefreshExamples = () => {
    setExamples(getRandomExamples(3));
  };

  return (
    <EmptyItems>
      <div className='mb-2 flex items-center justify-between'>
        <h3 className='text-sm font-medium'>Get started with 3D model examples</h3>
        <Button variant='ghost' size='icon' className='size-7' onClick={handleRefreshExamples}>
          <RefreshCw className='size-4' />
        </Button>
      </div>
      <div className='flex w-full flex-wrap justify-between gap-2'>
        {examples.map((example) => (
          <Button
            key={example.title}
            variant='outline'
            className='flex-1'
            onClick={() => {
              handleExampleClick(example);
            }}
          >
            {example.title}
          </Button>
        ))}
      </div>
    </EmptyItems>
  );
});
