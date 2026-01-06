import { memo } from 'react';
import type React from 'react';
import { AlertTriangle, ExternalLink, RefreshCcw } from 'lucide-react';
import { Button } from '#components/ui/button.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { cn } from '#utils/ui.utils.js';
import { useChatActions } from '#hooks/use-chat.js';

type ChatErrorToolProps = {
  readonly className?: string;
  readonly description?: string;
  readonly troubleshootingUrl?: string;
};

export const ChatErrorTool = memo(function ({
  className,
  description,
  troubleshootingUrl,
}: ChatErrorToolProps): React.JSX.Element {
  const { regenerate } = useChatActions();

  return (
    <div
      className={cn(
        'flex flex-col gap-2 overflow-hidden rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
        <p className="font-medium text-foreground">Processing Error</p>
      </div>
      <MarkdownViewer
        className={cn(
          'line-clamp-3 text-xs wrap-break-word text-muted-foreground',
          // Inline-code styles for error messages
          '[&_code]:text-destructive',
          '[&_code]:border-destructive/30',
          '[&_code]:bg-background/80',
        )}
      >
        {description ?? 'There was an error processing your message. Please try again.'}
      </MarkdownViewer>
      <div className="flex items-center justify-between gap-2">
        {troubleshootingUrl ? (
          <a
            href={troubleshootingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3 shrink-0" />
            Troubleshooting
          </a>
        ) : (
          <div />
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            regenerate();
          }}
        >
          <RefreshCcw className="size-3.5" />
          Retry
        </Button>
      </div>
    </div>
  );
});
