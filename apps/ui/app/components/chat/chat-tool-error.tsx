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
  TOOL_INPUT_VALIDATION_FAILED: TriangleAlert,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_OUTPUT_VALIDATION_FAILED: TriangleAlert,
  // eslint-disable-next-line @typescript-eslint/naming-convention -- error code
  TOOL_EXECUTION_ERROR: TriangleAlert,
} as const;

/**
 * Formats tool name for display (e.g., "read_file" -> "read_file").
 */
function formatToolName(toolName: string): string {
  return toolName;
}

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
  const toolName = formatToolName(error.toolName);

  // Determine if we have expandable details (validation errors have extra info)
  const hasDetails =
    (error.errorCode === 'TOOL_INPUT_VALIDATION_FAILED' || error.errorCode === 'TOOL_OUTPUT_VALIDATION_FAILED') &&
    (error.validationErrors.length > 0 || error.rawOutput !== undefined);

  if (!hasDetails) {
    // Simple non-expandable error display - single line layout
    return (
      <div className={cn('@container/error overflow-hidden rounded-md border bg-neutral/10', className)}>
        <div className="flex h-7 w-full flex-row items-center gap-1.5 px-2 text-xs">
          <Icon className="size-3 shrink-0 text-destructive" />
          <span className="font-medium text-destructive">{title}</span>
          <span className="text-muted-foreground/50">·</span>
          <code className="text-muted-foreground">{toolName}</code>
          <span className="hidden text-muted-foreground/50 @xs/error:inline">·</span>
          <span className="hidden min-w-0 truncate text-muted-foreground @xs/error:inline">{description}</span>
        </div>
      </div>
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
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs hover:bg-accent/50">
        <Icon className="size-3 shrink-0 text-destructive" />
        <span className="font-medium text-destructive">{title}</span>
        <span className="text-muted-foreground/50">·</span>
        <code className="text-muted-foreground">{toolName}</code>
        <span className="hidden text-muted-foreground/50 @xs/error:inline">·</span>
        <span className="hidden min-w-0 truncate text-muted-foreground @xs/error:inline">{description}</span>
        <div className="flex-1" />
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        <div className="space-y-2 p-2">
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
