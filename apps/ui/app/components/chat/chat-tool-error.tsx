import { useState } from 'react';
import { Clock, Unplug, WifiOff, ChevronRight, TriangleAlert } from 'lucide-react';
import type { ToolExecutionError } from '@taucad/chat';
import { getToolErrorTitle, getToolErrorDescription } from '@taucad/chat';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { CodeBlockContent, Pre } from '#components/code/code-block.js';
import { cn } from '#utils/ui.utils.js';

type ChatToolErrorProps = {
  readonly error: ToolExecutionError;
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
  TOOL_OUTPUT_VALIDATION_FAILED: TriangleAlert,
} as const;

/**
 * Unified error display component for tool execution errors.
 * Renders different styles based on error type, with expandable details
 * for validation errors.
 */
export function ChatToolError({ error, className }: ChatToolErrorProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = errorIcons[error.errorCode];
  const title = getToolErrorTitle(error.errorCode);
  const description = getToolErrorDescription(error.errorCode);

  // Determine if we have expandable details
  const hasDetails =
    error.errorCode === 'TOOL_OUTPUT_VALIDATION_FAILED' &&
    (error.validationErrors.length > 0 || error.rawOutput !== undefined);

  if (!hasDetails) {
    // Simple non-expandable error display
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2',
          className,
        )}
      >
        <Icon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-destructive">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
    );
  }

  // Expandable error with validation details
  const validationError = error;

  return (
    <Collapsible
      open={isOpen}
      className={cn(
        'group/collapsible overflow-hidden rounded-md border border-destructive/30 bg-destructive/5',
        className,
      )}
      onOpenChange={setIsOpen}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 p-2 text-left hover:bg-destructive/10">
        <Icon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-destructive">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-destructive/20">
        <div className="space-y-3 p-3">
          {validationError.validationErrors.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-destructive">Validation Errors:</div>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {validationError.validationErrors.map((error_) => (
                  <li key={error_.path}>
                    <code className="text-destructive">{error_.path || 'root'}</code>: {error_.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {validationError.rawOutput !== undefined && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Output</summary>
              <CodeBlockContent className="mt-2">
                <Pre language="json" className="max-h-40 overflow-auto text-xs">
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
