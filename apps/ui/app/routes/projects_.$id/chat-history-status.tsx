import { memo, useEffect, useMemo, useReducer } from 'react';
import { DollarSign, Clock, Cpu } from 'lucide-react';
import { useSelector } from '@xstate/react';
import { useChatSelector } from '#hooks/use-chat.js';
import { formatCurrency } from '#utils/currency.utils.js';
import { formatRelativeTime } from '#utils/date.utils.js';
import { cn } from '#utils/ui.utils.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { useModels } from '#hooks/use-models.js';
import { useProject } from '#hooks/use-project.js';
import { useChats } from '#hooks/use-chats.js';

type ChatHistoryStatusProps = {
  readonly className?: string;
};

export const ChatHistoryStatus = memo(function ({ className }: ChatHistoryStatusProps): React.JSX.Element {
  const [showModelCost] = useCookie(cookieName.chatModelCost, true);
  const { data: models } = useModels();

  // Get active chat info
  const { editorRef, projectId } = useProject();
  const activeChatId = useSelector(editorRef, (state) => state.context.lastChatId);
  const { chats } = useChats(projectId);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [chats, activeChatId]);
  const updatedAt = activeChat?.updatedAt;

  // Force re-render every minute to update relative time
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000); // Update every minute

    return () => {
      clearInterval(interval);
    };
  }, []);

  // Get the current model from the last message's metadata
  const currentModel = useChatSelector((state) => {
    const { messages } = state;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.metadata?.model) {
        return message.metadata.model;
      }
    }

    return undefined;
  });

  // Calculate total cost from all usage data parts
  const totalCost = useChatSelector((state) => {
    let cost = 0;
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (part.type === 'data-usage') {
          cost += part.data.totalCost;
        }
      }
    }

    return cost;
  });

  // Look up the model by ID to get the display name
  const model = useMemo(() => {
    if (!currentModel || !models) {
      return undefined;
    }

    return models.find((m) => m.id === currentModel);
  }, [currentModel, models]);

  // Use the model name if available, otherwise fall back to the ID
  const displayModel = model?.name ?? (currentModel ? (currentModel.split('/').pop() ?? currentModel) : undefined);

  return (
    <div
      className={cn(
        '@container',
        'sticky top-0 z-10 flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs',
        className,
      )}
    >
      {/* Left side: Last activity */}
      <div className='flex items-center gap-3'>
        {updatedAt ? (
          <div className='flex items-center gap-1 text-muted-foreground'>
            <Clock className='size-3' />
            <span className='@[20rem]:hidden'>{formatRelativeTime(updatedAt, { short: true })}</span>
            <span className='hidden @[20rem]:inline'>{formatRelativeTime(updatedAt)}</span>
          </div>
        ) : undefined}
      </div>

      {/* Right side: Model and cost */}
      <div className='flex items-center gap-3'>
        {displayModel ? (
          <div className='flex items-center gap-1 text-muted-foreground'>
            <Cpu className='size-3' />
            <span className='max-w-24 truncate'>{displayModel}</span>
          </div>
        ) : undefined}

        {showModelCost && totalCost > 0 ? (
          <div className='flex items-center gap-0.5 text-muted-foreground'>
            <DollarSign className='size-3' />
            <span>{formatCurrency(totalCost, { significantFigures: 2 })}</span>
          </div>
        ) : undefined}
      </div>
    </div>
  );
});
