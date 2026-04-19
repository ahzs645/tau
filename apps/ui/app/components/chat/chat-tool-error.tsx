import { useState } from 'react';
import { Clock, Unplug, WifiOff, ChevronRight, TriangleAlert, CircleStop, SearchX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolExecutionError } from '@taucad/chat';
import { getToolErrorTitle, getToolErrorDescription, parseToolErrorText } from '@taucad/chat/utils';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction } from '#components/chat/chat-tool-text.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { CodeBlockContent, Pre } from '#components/code/code-block.js';
import { cn } from '#utils/ui.utils.js';

type ChatToolErrorProps = {
  /** Raw error text from the tool invocation's output-error state */
  readonly errorText: string;
  /** Icon to display in the fallback error UI */
  readonly fallbackIcon: LucideIcon;
  /** Title to display in the fallback error UI */
  readonly fallbackTitle: string;
  readonly className?: string;
};

const errorIcons = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_EXECUTION_TIMEOUT: Clock,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  CLIENT_DISCONNECTED: Unplug,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  NO_CLIENT_CONNECTION: WifiOff,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_INPUT_VALIDATION_FAILED: TriangleAlert,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_OUTPUT_VALIDATION_FAILED: TriangleAlert,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_EXECUTION_ERROR: TriangleAlert,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  USER_INTERRUPTED: CircleStop,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_NO_RESULTS: SearchX,
} as const;

/**
 * Formats tool name for display (e.g., "read_file" -> "read_file").
 */
function formatToolName(toolName: string): string {
  return toolName;
}

/**
 * Unified error display component for tool execution errors.
 * Parses the error text and renders either a structured error display
 * or a simple fallback with the provided icon and title.
 */
export function ChatToolError({
  errorText,
  fallbackIcon,
  fallbackTitle,
  className,
}: ChatToolErrorProps): React.JSX.Element {
  const error = parseToolErrorText(errorText);

  if (!error) {
    return (
      <ChatToolCard variant='minimal' status='error' isCollapsible={false} className={className}>
        <ChatToolCardHeader>
          <ChatToolCardIcon icon={fallbackIcon} isError />
          <ChatToolCardTitle>
            <ChatToolAction className='text-destructive'>{fallbackTitle}</ChatToolAction>
          </ChatToolCardTitle>
        </ChatToolCardHeader>
      </ChatToolCard>
    );
  }

  return <StructuredToolError error={error} className={className} />;
}

type StructuredToolErrorProps = {
  readonly error: ToolExecutionError;
  readonly className?: string;
};

/**
 * Component for rendering structured tool execution errors.
 * Use this when you already have a parsed ToolExecutionError object.
 * Renders different styles based on error type, with expandable details
 * for validation errors.
 */
export function StructuredToolError({ error, className }: StructuredToolErrorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = errorIcons[error.errorCode];
  const title = getToolErrorTitle(error.errorCode);
  // Use the actual error message from backend, falling back to static description
  const description = error.message || getToolErrorDescription(error.errorCode);
  const toolName = formatToolName(error.toolName);

  // Determine if we have expandable details (validation errors have extra info)
  const hasDetails =
    (error.errorCode === 'TOOL_INPUT_VALIDATION_FAILED' || error.errorCode === 'TOOL_OUTPUT_VALIDATION_FAILED') &&
    (error.validationErrors.length > 0 || error.rawOutput !== undefined);

  const isMuted = error.errorCode === 'USER_INTERRUPTED' || error.errorCode === 'TOOL_NO_RESULTS';

  if (!hasDetails) {
    return (
      <ChatToolCard variant='minimal' status='error' isCollapsible={false} className={className}>
        <ChatToolCardHeader>
          <ChatToolCardIcon icon={Icon} isError={!isMuted} />
          <ChatToolCardTitle>
            <ChatToolAction className={isMuted ? undefined : 'text-destructive'}>{title}</ChatToolAction>
            <span className='text-muted-foreground/50'>·</span>
            <code className='text-muted-foreground'>{toolName}</code>
            <span className='text-muted-foreground/50'>·</span>
            <span className='min-w-0 truncate text-muted-foreground'>{description}</span>
          </ChatToolCardTitle>
        </ChatToolCardHeader>
      </ChatToolCard>
    );
  }

  // Expandable error with validation details
  const validationError = error;

  return (
    <Collapsible
      open={isOpen}
      className={cn('group/collapsible @container/error overflow-hidden rounded-md border bg-neutral/10', className)}
      onOpenChange={setIsOpen}
    >
      <CollapsibleTrigger className='flex h-7 w-full items-center gap-1 px-2 text-left text-xs hover:bg-accent/50'>
        <Icon className='size-3 shrink-0 text-destructive' />
        <span className='shrink-0 font-medium whitespace-nowrap text-destructive'>{title}</span>
        <span className='text-muted-foreground/50'>·</span>
        <code className='text-muted-foreground'>{toolName}</code>
        <span className='text-muted-foreground/50'>·</span>
        <span className='min-w-0 truncate text-muted-foreground'>{description}</span>
        <div className='flex-1' />
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className='border-t'>
        <div className='space-y-2 p-2'>
          {validationError.validationErrors.length > 0 && (
            <div className='space-y-1'>
              <div className='text-xs font-medium text-destructive'>Validation Errors:</div>
              <ul className='space-y-0.5 text-xs text-muted-foreground'>
                {validationError.validationErrors.map((error_, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- ensure uniqueness for same path errors.
                  <li key={`${error_.path}-${index}`}>
                    <code className='text-destructive'>{error_.path || 'root'}</code>: {error_.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {validationError.rawOutput !== undefined && (
            <details className='text-xs'>
              <summary className='cursor-pointer text-muted-foreground hover:text-foreground'>Raw Output</summary>
              <CodeBlockContent className='mt-2'>
                <Pre language='json' className='max-h-40 overflow-auto text-xs'>
                  {JSON.stringify(validationError.rawOutput, null, 2)}
                </Pre>
              </CodeBlockContent>
            </details>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
