import type { ToolUIPart } from 'ai';
import { useState } from 'react';
import { File, FilePlus, LoaderCircle, X, ChevronDown, ChevronRight, Check, RotateCcw, Play } from 'lucide-react';
import type { CodeError, KernelError } from '@taucad/types';
import { CodeViewer } from '#components/code/code-viewer.js';
import { CopyButton } from '#components/copy-button.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';

/**
 * Extract the filename from a path.
 */
function getFilename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

/**
 * Type guard to check if an error is a CodeError (has startLineNumber directly)
 */
function isCodeError(error: CodeError | KernelError): error is CodeError {
  return 'startLineNumber' in error && typeof error.startLineNumber === 'number';
}

/**
 * Get line number from an error, handling both CodeError and KernelError types
 */
function getErrorLineNumber(error: CodeError | KernelError): number | undefined {
  if (isCodeError(error)) {
    return error.startLineNumber;
  }

  return error.location?.startLineNumber;
}

/**
 * Get column number from an error, handling both CodeError and KernelError types
 */
function getErrorColumn(error: CodeError | KernelError): number | undefined {
  if (isCodeError(error)) {
    return error.startColumn;
  }

  return error.location?.startColumn;
}

type ErrorSectionProps = {
  readonly type: string;
  readonly errors: Array<CodeError | KernelError>;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly isInitiallyOpen?: boolean;
  readonly className?: string;
};

export function ErrorSection({
  type,
  errors,
  icon: Icon,
  isInitiallyOpen = false,
  className,
}: ErrorSectionProps): React.JSX.Element | undefined {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);

  if (errors.length === 0) {
    return undefined;
  }

  return (
    <Collapsible open={isOpen} className={className} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group flex h-auto w-full justify-start gap-2 rounded-none p-2 text-warning hover:bg-transparent"
        >
          <span className="relative flex items-center">
            <ChevronDown
              className={cn(
                'absolute left-0 size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100',
                isOpen ? 'rotate-180' : '',
              )}
            />
            <Icon
              className={cn('size-3 shrink-0 transition-opacity duration-200', 'group-hover:opacity-0', 'opacity-100')}
            />
          </span>
          <span className="text-left text-xs font-normal">
            {Number(errors.length)} {type} error{errors.length > 1 ? 's' : ''}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        <div className="space-y-2 px-2 py-2 text-xs">
          {errors.map((error) => {
            const lineNumber = getErrorLineNumber(error);
            const column = getErrorColumn(error);
            const key = `${lineNumber ?? 'unknown'}-${error.message}`;

            return (
              <div key={key} className="flex items-start text-xs">
                {lineNumber !== undefined && column !== undefined ? (
                  <div className="flex flex-row items-center gap-1 text-muted-foreground">
                    <div className="shrink-0 font-mono">
                      {lineNumber}:{column}
                    </div>
                  </div>
                ) : null}
                <div className="ml-2 flex-1 font-mono">{error.message}</div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type StatusIconProps = {
  readonly toolStatus: ToolUIPart['state'];
  readonly mode: 'edit' | 'create';
};

export function StatusIcon({ toolStatus, mode }: StatusIconProps): React.JSX.Element {
  if (['input-streaming', 'input-available'].includes(toolStatus)) {
    return <LoaderCircle className="size-3 animate-spin" />;
  }

  return mode === 'create' ? <FilePlus className="size-3" /> : <File className="size-3" />;
}

type FilenameProps = {
  readonly targetFile: string;
  readonly toolStatus: ToolUIPart['state'];
};

export function Filename({ targetFile, toolStatus }: FilenameProps): React.JSX.Element {
  if (['input-streaming', 'input-available'].includes(toolStatus)) {
    return <AnimatedShinyText>{targetFile}</AnimatedShinyText>;
  }

  return <span>{targetFile}</span>;
}

type ApplyButtonProps = {
  readonly state: 'idle' | 'applying' | 'success' | 'error';
  readonly error?: string;
  readonly onApply: () => void;
  readonly isDisabled?: boolean;
};

export function ApplyButton({ state, error, onApply, isDisabled }: ApplyButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="flex"
          disabled={state === 'applying' || isDisabled}
          onClick={onApply}
        >
          <span className="hidden @xs/code:block">
            {state === 'applying'
              ? 'Applying...'
              : state === 'success'
                ? 'Applied'
                : state === 'error'
                  ? 'Retry'
                  : 'Apply'}
          </span>
          {state === 'applying' ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : state === 'success' ? (
            <Check className="size-3" />
          ) : state === 'error' ? (
            <RotateCcw className="size-3" />
          ) : (
            <Play />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {state === 'applying'
          ? 'Applying changes...'
          : state === 'success'
            ? 'Changes applied successfully'
            : state === 'error'
              ? `Failed: ${error ?? 'Unknown error'}. Click to retry.`
              : 'Apply changes'}
      </TooltipContent>
    </Tooltip>
  );
}

type CodePreviewProps = {
  readonly content: string;
  readonly language?: 'typescript' | 'kcl' | 'openscad' | 'javascript' | 'jsx' | 'tsx' | 'bash' | 'json';
  readonly isExpanded?: boolean;
  readonly onToggleExpand?: () => void;
  readonly maxCollapsedLines?: number;
};

export function CodePreview({
  content,
  language = 'openscad',
  isExpanded: controlledIsExpanded,
  onToggleExpand,
  maxCollapsedLines = 4,
}: CodePreviewProps): React.JSX.Element {
  const [internalIsExpanded, setInternalIsExpanded] = useState(false);
  const isExpanded = controlledIsExpanded ?? internalIsExpanded;
  const handleToggle =
    onToggleExpand ??
    ((): void => {
      setInternalIsExpanded((previous) => !previous);
    });

  const lines = content.split('\n');
  const displayContent = isExpanded ? content : lines.slice(0, maxCollapsedLines).join('\n');
  const hasMoreLines = lines.length > maxCollapsedLines;

  return (
    <div className={cn('relative border-t', isExpanded ? '' : 'max-h-32 overflow-y-auto')}>
      <div className="leading-0">
        <CodeViewer language={language} text={displayContent} className="overflow-x-auto p-3 text-xs" />
        {hasMoreLines ? (
          <Button
            size="xs"
            className="sticky bottom-0 h-4 w-full rounded-none bg-neutral/10 text-center text-foreground/50 hover:bg-neutral/40"
            onClick={handleToggle}
          >
            <ChevronDown className={cn('transition-transform', isExpanded ? 'rotate-x-180' : '')} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type DiffLine = {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNumber?: number;
};

/**
 * Simple diff algorithm that compares lines
 */
export function computeDiff(originalContent: string, newContent: string): DiffLine[] {
  const originalLines = originalContent.split('\n');
  const newLines = newContent.split('\n');
  const result: DiffLine[] = [];

  // Simple line-by-line diff (not optimal but works for display)
  let originalIndex = 0;
  let newIndex = 0;

  while (originalIndex < originalLines.length || newIndex < newLines.length) {
    const originalLine = originalLines[originalIndex];
    const newLine = newLines[newIndex];

    if (originalLine === newLine) {
      result.push({ type: 'unchanged', content: originalLine ?? '', lineNumber: newIndex + 1 });
      originalIndex++;
      newIndex++;
    } else if (originalLine !== undefined && !newLines.includes(originalLine)) {
      result.push({ type: 'removed', content: originalLine });
      originalIndex++;
    } else if (newLine !== undefined && !originalLines.includes(newLine)) {
      result.push({ type: 'added', content: newLine, lineNumber: newIndex + 1 });
      newIndex++;
    } else {
      // Lines exist in both but at different positions - treat as change
      if (originalLine !== undefined) {
        result.push({ type: 'removed', content: originalLine });
        originalIndex++;
      }

      if (newLine !== undefined) {
        result.push({ type: 'added', content: newLine, lineNumber: newIndex + 1 });
        newIndex++;
      }
    }
  }

  return result;
}

type DiffViewProps = {
  readonly originalContent: string;
  readonly newContent: string;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
  readonly maxCollapsedLines?: number;
};

export function DiffView({
  originalContent,
  newContent,
  isExpanded,
  onToggleExpand,
  maxCollapsedLines = 8,
}: DiffViewProps): React.JSX.Element {
  const diffLines = computeDiff(originalContent, newContent);
  const displayLines = isExpanded ? diffLines : diffLines.slice(0, maxCollapsedLines);
  const hasMoreLines = diffLines.length > maxCollapsedLines;

  return (
    <div className={cn('relative border-t', isExpanded ? '' : 'max-h-48 overflow-y-auto')}>
      <div className="font-mono text-xs leading-relaxed">
        {displayLines.map((line, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key -- Index is stable for diff display
            key={index}
            className={cn(
              'flex px-3 py-0.5',
              line.type === 'added' && 'bg-success/20 text-success',
              line.type === 'removed' && 'bg-destructive/20 text-destructive line-through',
              line.type === 'unchanged' && 'text-muted-foreground',
            )}
          >
            <span className="mr-2 w-4 shrink-0 text-right opacity-50 select-none">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            <span className="whitespace-pre">{line.content}</span>
          </div>
        ))}
      </div>
      {hasMoreLines ? (
        <Button
          size="xs"
          className="sticky bottom-0 h-4 w-full rounded-none bg-neutral/10 text-center text-foreground/50 hover:bg-neutral/40"
          onClick={onToggleExpand}
        >
          <ChevronDown className={cn('transition-transform', isExpanded ? 'rotate-x-180' : '')} />
        </Button>
      ) : null}
    </div>
  );
}

type FileOperationHeaderProps = {
  readonly targetFile: string;
  readonly toolStatus: ToolUIPart['state'];
  readonly mode: 'edit' | 'create';
  readonly content?: string;
  readonly applyState?: 'idle' | 'applying' | 'success' | 'error';
  readonly applyError?: string;
  readonly onApply?: () => void;
};

export function FileOperationHeader({
  targetFile,
  toolStatus,
  mode,
  content,
  applyState,
  applyError,
  onApply,
}: FileOperationHeaderProps): React.JSX.Element {
  const isOutputAvailable = toolStatus === 'output-available';

  return (
    <div className="sticky top-0 flex flex-row items-center justify-between py-1 pr-1 pl-2 text-foreground/50">
      <div className="flex flex-row items-center gap-1 text-xs text-muted-foreground">
        <StatusIcon toolStatus={toolStatus} mode={mode} />
        <Filename targetFile={targetFile} toolStatus={toolStatus} />
      </div>
      {isOutputAvailable && content && onApply ? (
        <div className="flex flex-row gap-1">
          <CopyButton
            size="xs"
            className="**:data-[slot=label]:hidden @xs/code:**:data-[slot=label]:flex"
            getText={() => content}
          />
          <ApplyButton state={applyState ?? 'idle'} error={applyError} onApply={onApply} />
        </div>
      ) : null}
    </div>
  );
}

type CollapsibleFileOperationTriggerProps = {
  readonly targetFile: string;
  readonly toolStatus: ToolUIPart['state'];
  readonly mode: 'edit' | 'create';
  readonly isOpen: boolean;
  readonly isSuccess?: boolean;
  readonly onFileClick?: () => void;
};

export function CollapsibleFileOperationTrigger({
  targetFile,
  toolStatus,
  mode,
  isOpen,
  isSuccess = true,
  onFileClick,
}: CollapsibleFileOperationTriggerProps): React.JSX.Element {
  const isStreaming = ['input-streaming', 'input-available'].includes(toolStatus);
  const isError = toolStatus === 'output-available' && !isSuccess;
  const filename = getFilename(targetFile);
  const hasPath = targetFile !== filename;

  // Handle click on filename to open file (stops propagation to prevent collapsible toggle)
  const handleFilenameClick = (event: React.MouseEvent): void => {
    if (onFileClick && !isStreaming) {
      event.stopPropagation();
      onFileClick();
    }
  };

  // Render the filename content
  const filenameContent = isStreaming ? (
    <AnimatedShinyText>{filename || 'file'}</AnimatedShinyText>
  ) : isError ? (
    <span>
      Failed to {mode === 'create' ? 'create' : 'edit'} {filename}
    </span>
  ) : (
    <span>{filename}</span>
  );

  // Filename element - clickable only if onFileClick is provided
  const filenameElement =
    onFileClick && !isStreaming ? (
      hasPath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate underline-offset-2 hover:text-foreground hover:underline"
              onClick={handleFilenameClick}
            >
              {filenameContent}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {targetFile}
          </TooltipContent>
        </Tooltip>
      ) : (
        <button
          type="button"
          className="min-w-0 cursor-pointer truncate underline-offset-2 hover:text-foreground hover:underline"
          onClick={handleFilenameClick}
        >
          {filenameContent}
        </button>
      )
    ) : hasPath && !isStreaming ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 truncate">{filenameContent}</span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
          {targetFile}
        </TooltipContent>
      </Tooltip>
    ) : (
      <span className="min-w-0 truncate">{filenameContent}</span>
    );

  // Entire header is the collapsible trigger
  return (
    <CollapsibleTrigger className="group flex h-7 min-w-0 flex-1 cursor-pointer flex-row items-center gap-1 pl-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/5">
      {/* Status icon - visible by default, hidden on hover */}
      <span className="relative flex size-3 items-center justify-center">
        {isStreaming ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <>
            <span className={cn('transition-opacity duration-150', 'group-hover:opacity-0')}>
              {isError ? (
                <X className="size-3 text-destructive" />
              ) : mode === 'create' ? (
                <FilePlus className="size-3" />
              ) : (
                <File className="size-3" />
              )}
            </span>
            {/* Caret - hidden by default, visible on hover */}
            <ChevronRight
              className={cn(
                'absolute size-3 transition-all duration-150',
                'opacity-0 group-hover:opacity-100',
                isOpen ? 'rotate-90' : 'rotate-0',
              )}
            />
          </>
        )}
      </span>
      {filenameElement}
    </CollapsibleTrigger>
  );
}

type CollapsibleFileOperationProps = {
  readonly targetFile: string;
  readonly toolStatus: ToolUIPart['state'];
  readonly mode: 'edit' | 'create';
  readonly content?: string;
  readonly isSuccess?: boolean;
  readonly children?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly isDefaultOpen?: boolean;
  /**
   * Callback when the filename is clicked. Use this to open the file in the editor.
   */
  readonly onFileClick?: () => void;
};

export function CollapsibleFileOperation({
  targetFile,
  toolStatus,
  mode,
  content,
  isSuccess = true,
  children,
  actions,
  footer,
  isDefaultOpen = false,
  onFileClick,
}: CollapsibleFileOperationProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(isDefaultOpen);
  const isStreaming = ['input-streaming', 'input-available'].includes(toolStatus);
  const filename = getFilename(targetFile);
  const hasPath = targetFile !== filename;

  // For streaming, show last 4 lines without collapsible
  if (isStreaming && content) {
    const lines = content.split('\n');
    const lastFourLines = lines.slice(-4).join('\n');
    const hasContent = lastFourLines.trim().length > 0;

    return (
      <div className="@container/code overflow-hidden rounded-md border bg-neutral/10">
        <div className="flex h-7 w-full flex-row items-center gap-1 pr-1 pl-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          {hasPath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate">
                  <AnimatedShinyText>{filename || 'file'}</AnimatedShinyText>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" align="start">
                {targetFile}
              </TooltipContent>
            </Tooltip>
          ) : (
            <AnimatedShinyText>{targetFile || 'file'}</AnimatedShinyText>
          )}
        </div>
        {hasContent ? (
          <div className="max-h-24 overflow-hidden border-t">
            <CodeViewer language="openscad" text={lastFourLines} className="overflow-x-auto p-3 text-xs" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="group/file-op @container/code overflow-hidden rounded-md border bg-neutral/10">
        <div className="flex items-center">
          <CollapsibleFileOperationTrigger
            targetFile={targetFile}
            toolStatus={toolStatus}
            mode={mode}
            isOpen={isOpen}
            isSuccess={isSuccess}
            onFileClick={onFileClick}
          />
          {actions ? (
            <div
              className="ml-auto flex shrink-0 items-center gap-1 pr-1 opacity-0 group-hover/file-op:opacity-100"
              onClick={(event) => {
                // Prevent triggering the collapsible when clicking actions
                event.stopPropagation();
              }}
            >
              {actions}
            </div>
          ) : undefined}
        </div>
        <CollapsibleContent>
          {children}
          {footer}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
