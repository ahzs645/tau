import { Clock, Unplug, WifiOff, TriangleAlert, CircleStop, SearchX } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolExecutionError } from '@taucad/chat';
import { getToolErrorTitle, getToolErrorDescription, parseToolErrorText } from '@taucad/chat/utils';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolLabel } from '#components/chat/chat-tool-label.js';
import { CodeBlockContent, Pre } from '#components/code/code-block.js';

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
 * Unified error display component for tool execution errors.
 *
 * Always renders an expandable {@link ChatToolCard} (`variant='minimal'`):
 * the header carries the error title + tool name with proper inline spacing
 * via {@link ChatToolLabel}/{@link ChatToolDescription}, and the body holds
 * the actual error message (plus validation details and raw output, when
 * present). When the error text cannot be parsed, falls back to the caller's
 * `fallbackTitle`/`fallbackIcon` and renders the raw `errorText` inside the
 * collapsible body so it remains inspectable.
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
      <ChatToolCard variant='minimal' status='error' isDefaultOpen={false} className={className}>
        <ChatToolCardHeader>
          <ChatToolCardIcon icon={fallbackIcon} tone='destructive' />
          <ChatToolCardTitle>
            <ChatToolLabel verb={fallbackTitle} />
          </ChatToolCardTitle>
        </ChatToolCardHeader>
        <ChatToolCardContent>
          <div className='space-y-2 px-2 py-2 text-xs'>
            <CodeBlockContent>
              <Pre className='max-h-40 overflow-auto text-xs'>{errorText}</Pre>
            </CodeBlockContent>
          </div>
        </ChatToolCardContent>
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
 * Use this when you already have a parsed {@link ToolExecutionError} object.
 *
 * Renders the same shape as the unparseable fallback in {@link ChatToolError}:
 * a {@link ChatToolCard} `variant='minimal'` with the header showing the
 * error title (verb) and the tool name (mono description), and the body
 * holding the resolved error message plus any validation errors and raw
 * output. `USER_INTERRUPTED` and `TOOL_NO_RESULTS` use a muted (non-
 * destructive) colour ramp.
 */
export function StructuredToolError({ error, className }: StructuredToolErrorProps): React.JSX.Element {
  const Icon = errorIcons[error.errorCode];
  const title = getToolErrorTitle(error.errorCode);
  const description = error.message || getToolErrorDescription(error.errorCode);
  const { toolName } = error;

  const hasValidationDetails =
    (error.errorCode === 'TOOL_INPUT_VALIDATION_FAILED' || error.errorCode === 'TOOL_OUTPUT_VALIDATION_FAILED') &&
    (error.validationErrors.length > 0 || error.rawOutput !== undefined);

  const isMuted = error.errorCode === 'USER_INTERRUPTED' || error.errorCode === 'TOOL_NO_RESULTS';
  const cardStatus = isMuted ? 'warning' : 'error';

  return (
    <ChatToolCard variant='minimal' status={cardStatus} isDefaultOpen={false} className={className}>
      <ChatToolCardHeader>
        <ChatToolCardIcon icon={Icon} tone={isMuted ? undefined : 'destructive'} />
        <ChatToolCardTitle>
          <ChatToolLabel verb={title}>
            <ChatToolDescription className='font-mono'>{toolName}</ChatToolDescription>
          </ChatToolLabel>
        </ChatToolCardTitle>
      </ChatToolCardHeader>
      <ChatToolCardContent>
        <div className='space-y-2 px-2 py-2 text-xs'>
          {description ? <p className='text-muted-foreground'>{description}</p> : undefined}
          {hasValidationDetails && error.validationErrors.length > 0 ? (
            <div className='space-y-1'>
              <div className='text-xs font-medium text-destructive/50'>Validation Errors:</div>
              <ul className='space-y-0.5 text-xs text-muted-foreground'>
                {error.validationErrors.map((validationError, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- ensure uniqueness for same path errors.
                  <li key={`${validationError.path}-${index}`}>
                    <code className='text-destructive/50'>{validationError.path || 'root'}</code>:{' '}
                    {validationError.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : undefined}
          {hasValidationDetails && error.rawOutput !== undefined ? (
            <details className='text-xs'>
              <summary className='cursor-pointer text-muted-foreground hover:text-foreground'>Raw Output</summary>
              <CodeBlockContent className='mt-2'>
                <Pre language='json' className='max-h-40 overflow-auto text-xs'>
                  {JSON.stringify(error.rawOutput, null, 2)}
                </Pre>
              </CodeBlockContent>
            </details>
          ) : undefined}
        </div>
      </ChatToolCardContent>
    </ChatToolCard>
  );
}
