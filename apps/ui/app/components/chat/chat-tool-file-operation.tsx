import type { ToolUIPart } from 'ai';
import { useState } from 'react';
import { File, FilePlus, LoaderCircle, X, ChevronDown, ChevronRight, Check, RotateCcw, Play } from 'lucide-react';
import { CodeViewer } from '#components/code/code-viewer.js';
import { CopyButton } from '#components/copy-button.js';
import { FileLink } from '#components/files/file-link.js';
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
        <CodeViewer language={language} text={displayContent} className="overflow-x-auto px-2.5 py-1.5 text-xs" />
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
  /**
   * When true, wraps the filename with FileLink for file opening functionality.
   */
  readonly enableFileLink?: boolean;
};

export function CollapsibleFileOperationTrigger({
  targetFile,
  toolStatus,
  mode,
  isOpen,
  isSuccess = true,
  enableFileLink = false,
}: CollapsibleFileOperationTriggerProps): React.JSX.Element {
  const isStreaming = ['input-streaming', 'input-available'].includes(toolStatus);
  const isError = toolStatus === 'output-available' && !isSuccess;
  const filename = getFilename(targetFile);
  const hasPath = targetFile !== filename;

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

  // Filename element - clickable when enableFileLink is true
  const filenameElement =
    enableFileLink && !isStreaming ? (
      hasPath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <FileLink path={targetFile} className="min-w-0 truncate hover:text-foreground">
              {filenameContent}
            </FileLink>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {targetFile}
          </TooltipContent>
        </Tooltip>
      ) : (
        <FileLink path={targetFile} className="min-w-0 truncate hover:text-foreground">
          {filenameContent}
        </FileLink>
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
    <CollapsibleTrigger className="group flex h-7 min-w-0 flex-1 cursor-pointer flex-row items-center gap-1 pl-2 text-xs text-muted-foreground transition-colors">
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
   * When true, wraps the filename with FileLink for file opening functionality.
   */
  readonly enableFileLink?: boolean;
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
  enableFileLink = false,
}: CollapsibleFileOperationProps): React.JSX.Element {
  const isStreaming = ['input-streaming', 'input-available'].includes(toolStatus);
  // Default to open when content is available (after streaming completes)
  const [isOpen, setIsOpen] = useState(isDefaultOpen || (!isStreaming && Boolean(content)));
  const filename = getFilename(targetFile);
  const hasPath = targetFile !== filename;

  // For streaming, show last 4 lines without collapsible
  if (isStreaming && content) {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const lastFourLines = lines.slice(-4).join('\n');
    // Always show content area when we have 4+ lines to maintain consistent height,
    // otherwise only show if there's actual content
    const shouldShowContent = totalLines >= 4 || lastFourLines.trim().length > 0;

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
        {shouldShowContent ? (
          <div className="h-24 overflow-hidden border-t">
            <CodeViewer language="openscad" text={lastFourLines} className="overflow-x-auto p-3 text-xs" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="@container/code overflow-hidden rounded-md border bg-neutral/10">
        <div className="group/file-op flex items-center transition-colors hover:bg-foreground/5">
          <CollapsibleFileOperationTrigger
            targetFile={targetFile}
            toolStatus={toolStatus}
            mode={mode}
            isOpen={isOpen}
            isSuccess={isSuccess}
            enableFileLink={enableFileLink}
          />
          {actions ? (
            <div
              className="ml-auto flex shrink-0 items-center gap-1 pr-1 text-muted-foreground opacity-0 group-hover/file-op:opacity-100"
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
          {content ? <CodePreview content={content} /> : null}
          {children}
          {footer}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
