import { Camera, XCircle } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

export function ChatMessageToolScreenshot({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.screenshot>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const mode = part.input?.mode;
      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Camera} />
            <ChatToolCardTitle>
              <ChatToolAction>Capturing</ChatToolAction>
              <ChatToolDescription>
                {mode === 'multi_angle' ? 'orthographic views...' : 'screenshot...'}
              </ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { images } = output;
      const isComposite = images.length === 1 && images[0]?.view === 'composite';

      return (
        <ChatToolCard variant='minimal' status='ready' isDefaultOpen={false}>
          <ChatToolCardHeader className='text-success'>
            <ChatToolCardIcon icon={Camera} />
            <ChatToolCardTitle>
              {isComposite
                ? 'Captured 6 screenshots'
                : `Captured ${images.length} ${images.length === 1 ? 'screenshot' : 'screenshots'}`}
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          {images.length > 0 ? (
            <ChatToolCardContent>
              <div className={`grid gap-2 ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2 @md:grid-cols-3'}`}>
                {images.map((image) => (
                  <div key={image.view} className='flex flex-col items-center gap-1'>
                    <img
                      src={image.dataUrl}
                      alt={isComposite ? 'Multi-angle composite view' : `${image.view} view`}
                      className='rounded-sm border bg-background object-contain'
                    />
                    {isComposite ? undefined : <span className='text-xs text-muted-foreground'>{image.view}</span>}
                  </div>
                ))}
              </div>
            </ChatToolCardContent>
          ) : undefined}
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolError errorText={part.errorText} fallbackIcon={XCircle} fallbackTitle='Failed to capture screenshot' />
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.screenshot} state: ${part.state}`);
    }
  }
}
