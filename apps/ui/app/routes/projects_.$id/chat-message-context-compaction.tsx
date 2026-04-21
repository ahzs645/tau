import { Archive } from 'lucide-react';
import type { ContextCompactionData } from '@taucad/chat';
import { FileLink } from '#components/files/file-link.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
} from '#components/chat/chat-tool-card.js';
import { ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolLabel } from '#components/chat/chat-tool-label.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#components/ui/hover-card.js';
import { formatNumberAbbreviation } from '#utils/number.utils.js';

/**
 * Renders a "Chat context summarized." line inline in the message stream,
 * styled consistently with other tool rows (see chat-message-tool-read-file).
 * Shows compression details on hover via HoverCard.
 */
export function ChatMessageContextCompaction({ data }: { readonly data: ContextCompactionData }): React.JSX.Element {
  const reductionPercent = ((1 - data.compressionRatio) * 100).toFixed(0);

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div className='cursor-help'>
          <ChatToolCard variant='minimal' status='ready' isCollapsible={false}>
            <ChatToolCardHeader>
              <ChatToolCardIcon icon={Archive} />
              <ChatToolCardTitle>
                <ChatToolLabel verb='Summarized'>
                  <ChatToolDescription>chat context</ChatToolDescription>
                </ChatToolLabel>
              </ChatToolCardTitle>
            </ChatToolCardHeader>
          </ChatToolCard>
        </div>
      </HoverCardTrigger>
      <HoverCardContent className='w-auto p-3'>
        <div className='flex flex-col gap-1.5 text-xs'>
          <p className='font-medium'>Context compaction</p>
          <div className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
            <span className='text-muted-foreground'>Before</span>
            <span className='font-mono'>{formatNumberAbbreviation(data.tokensBeforeCompaction)} tokens</span>
            <span className='text-muted-foreground'>After</span>
            <span className='font-mono'>{formatNumberAbbreviation(data.tokensAfterCompaction)} tokens</span>
            <span className='text-muted-foreground'>Reduction</span>
            <span className='font-mono'>{reductionPercent}%</span>
            <span className='text-muted-foreground'>Messages evicted</span>
            <span className='font-mono'>{data.messagesEvicted}</span>
          </div>
          {data.transcriptFilePath ? (
            <p className='mt-1 text-muted-foreground'>
              Transcript{' '}
              <FileLink path={data.transcriptFilePath} className='font-mono text-[10px] text-muted-foreground'>
                {data.transcriptFilePath}
              </FileLink>
            </p>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
