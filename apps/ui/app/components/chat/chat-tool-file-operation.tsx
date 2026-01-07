import type { ToolUIPart } from 'ai';
import type { DiffStats } from '@taucad/chat';
import type { CodeLanguage } from '@taucad/types';
import { useState, useEffect, useRef } from 'react';
import { File, FilePlus, LoaderCircle, X, ChevronRight, Check, RotateCcw, Play } from 'lucide-react';
import { languageFromExtension } from '@taucad/types/constants';
import { CodeViewer } from '#components/code/code-viewer.js';
import { DiffViewer, getDiffLineCount } from '#components/code/diff-viewer.js';
import { CopyButton } from '#components/copy-button.js';
import { FileLink } from '#components/files/file-link.js';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '#components/ui/tooltip.js';
import { Button } from '#components/ui/button.js';
import { cn } from '#utils/ui.utils.js';
import { getFileExtension } from '#utils/filesystem.utils.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { CollapsibleContainer } from '#components/ui/collapsible-code-block.js';
import { useCookie } from '#hooks/use-cookie.js';
import { cookieName } from '#constants/cookie.constants.js';
import { ChangeIndicator } from '#components/chat/change-indicator.js';

/**
 * Extract the filename from a path.
 */
function getFilename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

/**
 * Get the code language for syntax highlighting based on a filename's extension.
 * Falls back to 'typescript' if the extension is not recognized.
 */
function getLanguageFromFilename(filename: string): CodeLanguage {
  const extension = getFileExtension(filename);
  if (extension in languageFromExtension) {
    return languageFromExtension[extension as keyof typeof languageFromExtension];
  }

  return 'typescript';
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
            <Play className="size-3" />
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
  readonly language?: CodeLanguage;
  readonly maxCollapsedLines?: number;
};

export function CodePreview({
  content,
  language = 'typescript',
  maxCollapsedLines = 4,
}: CodePreviewProps): React.JSX.Element {
  const lineCount = content.split('\n').length;

  return (
    <CollapsibleContainer lineCount={lineCount} collapsedLineCount={maxCollapsedLines} className="border-t">
      <CodeViewer language={language} text={content} className="overflow-x-auto px-2.5 py-1.5 text-xs" />
    </CollapsibleContainer>
  );
}

type DiffPreviewProps = {
  readonly originalContent: string;
  readonly modifiedContent: string;
  readonly language?: CodeLanguage;
  readonly maxCollapsedLines?: number;
};

export function DiffPreview({
  originalContent,
  modifiedContent,
  language = 'typescript',
  maxCollapsedLines = 4,
}: DiffPreviewProps): React.JSX.Element {
  // Get actual visible line count (with context collapsing applied)
  const lineCount = getDiffLineCount(originalContent, modifiedContent);

  return (
    <CollapsibleContainer
      lineCount={lineCount}
      collapsedLineCount={maxCollapsedLines}
      collapsedMaxHeight="max-h-24"
      className="border-t"
    >
      <DiffViewer originalContent={originalContent} modifiedContent={modifiedContent} language={language} />
    </CollapsibleContainer>
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
  /**
   * Diff statistics for displaying change indicator.
   */
  readonly diffStats?: DiffStats;
};

// eslint-disable-next-line complexity -- UI component with many conditional rendering paths
export function CollapsibleFileOperationTrigger({
  targetFile,
  toolStatus,
  mode,
  isOpen,
  isSuccess = true,
  enableFileLink = false,
  diffStats,
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
  // Uses asChild to avoid nesting buttons inside CollapsibleTrigger
  const filenameElement =
    enableFileLink && !isStreaming ? (
      hasPath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <FileLink asChild path={targetFile} className="min-w-0 truncate hover:text-foreground">
              <span>{filenameContent}</span>
            </FileLink>
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            {targetFile}
          </TooltipContent>
        </Tooltip>
      ) : (
        <FileLink asChild path={targetFile} className="min-w-0 truncate hover:text-foreground">
          <span>{filenameContent}</span>
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

  // Show change indicator when diffStats is available and there are changes
  const showChangeIndicator =
    diffStats !== undefined && (diffStats.linesAdded > 0 || diffStats.linesRemoved > 0) && !isStreaming && !isError;

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
              ) : (
                <FileExtensionIcon filename={filename} className="size-3" />
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
      {showChangeIndicator ? (
        <ChangeIndicator linesAdded={diffStats.linesAdded} linesRemoved={diffStats.linesRemoved} />
      ) : undefined}
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
  /**
   * Diff statistics for displaying change indicator.
   */
  readonly diffStats?: DiffStats;
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
  diffStats,
}: CollapsibleFileOperationProps): React.JSX.Element {
  const isStreaming = ['input-streaming', 'input-available'].includes(toolStatus);
  const [showCodePreview] = useCookie(cookieName.chatToolCodePreview, true);

  // Track the previous streaming state to detect transitions
  const wasStreamingRef = useRef(isStreaming);

  // Default to open when content is available (after streaming completes)
  const [isOpen, setIsOpen] = useState(isDefaultOpen || (!isStreaming && Boolean(content)));

  // When transitioning from streaming to non-streaming, open if showCodePreview is enabled
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && content && showCodePreview) {
      setIsOpen(true);
    }

    wasStreamingRef.current = isStreaming;
  }, [isStreaming, content, showCodePreview]);

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
            <CodeViewer
              language={getLanguageFromFilename(filename)}
              text={lastFourLines}
              className="overflow-x-auto p-3 text-xs"
            />
          </div>
        ) : null}
      </div>
    );
  }

  // Derive language from filename for syntax highlighting
  const language = getLanguageFromFilename(filename);

  // Render content: always show DiffPreview when diffStats is available
  const renderContent = (): React.ReactNode => {
    // Show diff view when diff data is available (primary view)
    if (diffStats) {
      return (
        <DiffPreview
          originalContent={diffStats.originalContent}
          modifiedContent={diffStats.modifiedContent}
          language={language}
        />
      );
    }

    // Fallback to code preview during streaming or when no diff data
    if (content) {
      return <CodePreview content={content} language={language} />;
    }

    return null;
  };

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
            diffStats={diffStats}
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
          {renderContent()}
          {children}
          {footer}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
