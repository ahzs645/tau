import { LoaderCircle, X } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { FileExtensionIcon } from '#components/icons/file-extension-icon.js';
import { AnimatedShinyText } from '#components/magicui/animated-shiny-text.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '#components/ui/tooltip.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

/**
 * Extract the filename from a path.
 */
function getFilename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

export function ChatMessageToolDeleteFile({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.deleteFile>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const { input } = part;
      const targetFile = input?.targetFile ?? 'file';
      const filename = getFilename(targetFile);
      const hasPath = targetFile !== filename;

      return (
        <div className="@container/code overflow-hidden rounded-md border bg-neutral/10">
          <div className="flex h-7 w-full flex-row items-center gap-1 pr-2 pl-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {hasPath ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 truncate">
                    <AnimatedShinyText>{filename}</AnimatedShinyText>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  {targetFile}
                </TooltipContent>
              </Tooltip>
            ) : (
              <AnimatedShinyText>{targetFile}</AnimatedShinyText>
            )}
          </div>
        </div>
      );
    }

    case 'output-available': {
      const { input } = part;
      const { targetFile } = input;
      const filename = getFilename(targetFile);
      const hasPath = targetFile !== filename;

      return (
        <div className="@container/code overflow-hidden rounded-md border bg-neutral/10">
          <div className="flex h-7 w-full flex-row items-center gap-1 pr-2 pl-2 text-xs text-muted-foreground">
            <FileExtensionIcon filename={filename} className="size-3" />
            {hasPath ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 truncate">{filename}</span>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  {targetFile}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="min-w-0 truncate">{filename}</span>
            )}
            <span className="text-destructive/80">Deleted</span>
          </div>
        </div>
      );
    }

    case 'output-error': {
      return <ChatToolError errorText={part.errorText} fallbackIcon={X} fallbackTitle="Failed to delete file" />;
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.deleteFile} state: ${part.state}`);
    }
  }
}
