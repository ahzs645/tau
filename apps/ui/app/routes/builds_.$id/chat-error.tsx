import { memo, useMemo } from 'react';
import type React from 'react';
import { ChevronRight, RefreshCcw } from 'lucide-react';
import { errorCategory } from '@taucad/types';
import type { ErrorCategory, NormalizedChatError } from '@taucad/types';
import { Button } from '#components/ui/button.js';
import { useChatActions, useChatSelector } from '#hooks/use-chat.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.js';
import { CodeViewer } from '#components/code/code-viewer.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { cn } from '#utils/ui.utils.js';
import { ChatErrorUnauthorized } from '#routes/builds_.$id/chat-error-unauthorized.js';
import { ChatErrorServiceUnavailable } from '#routes/builds_.$id/chat-error-service-unavailable.js';
import { ChatErrorCredits } from '#routes/builds_.$id/chat-error-credits.js';
import { ChatErrorRateLimit } from '#routes/builds_.$id/chat-error-rate-limit.js';
import { ChatErrorTool } from '#routes/builds_.$id/chat-error-tool.js';

/**
 * Parsed error ready for UI display (uses NormalizedChatError from API).
 */
type ParsedError = NormalizedChatError;

/**
 * Checks if error is a client-side network error (never reaches the API).
 */
function isNetworkError(message: string): boolean {
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('net::ERR_') ||
    message.includes('Load failed')
  );
}

/**
 * Parses the JSON error from the API.
 */
function tryParseApiError(message: string): ParsedError | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

    if (
      typeof parsed['category'] === 'string' &&
      typeof parsed['title'] === 'string' &&
      typeof parsed['message'] === 'string'
    ) {
      return {
        category: parsed['category'] as ErrorCategory,
        title: parsed['title'],
        message: parsed['message'],
        code: typeof parsed['code'] === 'string' ? parsed['code'] : undefined,
        httpStatus: typeof parsed['httpStatus'] === 'number' ? parsed['httpStatus'] : undefined,
        raw: typeof parsed['raw'] === 'string' ? parsed['raw'] : undefined,
        requestId: typeof parsed['requestId'] === 'string' ? parsed['requestId'] : undefined,
        helpUrl: typeof parsed['helpUrl'] === 'string' ? parsed['helpUrl'] : undefined,
      };
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}

/**
 * Attempts to format a string as pretty-printed JSON.
 */
function tryFormatJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

export const ChatError = memo(function ({
  isOpen = false,
  onOpenChange,
  className,
}: {
  readonly isOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}): React.ReactNode {
  const error = useChatSelector((state) => state.error);
  const { regenerate } = useChatActions();

  const parsedError = useMemo((): ParsedError | undefined => {
    if (!error) {
      return undefined;
    }

    // Handle client-side network errors (these never reach the API)
    if (isNetworkError(error.message)) {
      return {
        category: errorCategory.network,
        title: 'Connection Error',
        message: 'Unable to connect to the server. Please check your internet connection.',
        raw: error.message,
      };
    }

    // Parse structured error from API
    const parsed = tryParseApiError(error.message);
    if (parsed) {
      return parsed;
    }

    // Fallback for unexpected formats
    return {
      category: errorCategory.generic,
      title: 'Error',
      message: error.message,
      raw: error.message,
    };
  }, [error]);

  if (!error || !parsedError) {
    return null;
  }

  // Render the generic/server error view with collapsible details
  const renderGenericError = (): React.ReactNode => {
    const formattedError = parsedError.raw ? tryFormatJson(parsedError.raw) : parsedError.message;

    return (
      <div className={cn('size-full', className)}>
        <Collapsible
          open={isOpen}
          className={cn(
            'group/collapsible flex flex-col justify-center rounded-md border border-destructive/20 bg-destructive/10 text-sm',
          )}
          onOpenChange={onOpenChange}
        >
          <CollapsibleTrigger asChild>
            <div className="flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5">
              <ChevronRight className="size-4 transition-transform duration-300 ease-in-out group-data-[state=open]/collapsible:rotate-90" />
              <div className="flex w-full items-center justify-between gap-2">
                <MarkdownViewer
                  className={cn(
                    'inline w-auto! text-sm text-foreground',
                    // Inline-code styles for error messages
                    '[&_code]:text-destructive',
                    '[&_code]:border-destructive/30',
                    '[&_code]:bg-background/80',
                    'line-clamp-none',
                  )}
                >
                  {parsedError.message || parsedError.title || 'Unable to send the message.'}
                </MarkdownViewer>
                <Button
                  variant="outline"
                  className="h-7 shrink-0 hover:border-neutral/50"
                  size="sm"
                  onClick={() => {
                    regenerate();
                  }}
                >
                  <RefreshCcw className="size-3.5" />
                  Retry
                </Button>
              </div>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-x-scroll px-2 pb-2">
            <CodeViewer text={formattedError} language="json" className="text-xs whitespace-pre-wrap" />
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  };

  // Route to specialized error components based on category
  // All cases from ErrorCategory are handled explicitly for exhaustive matching
  const { category } = parsedError;
  switch (category) {
    case errorCategory.auth: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorUnauthorized />
        </div>
      );
    }

    case errorCategory.network: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorServiceUnavailable />
        </div>
      );
    }

    case errorCategory.credits: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorCredits />
        </div>
      );
    }

    case errorCategory.rateLimit: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorRateLimit />
        </div>
      );
    }

    case errorCategory.overloaded: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorServiceUnavailable />
        </div>
      );
    }

    case errorCategory.toolError: {
      return (
        <div className={cn('size-full', className)}>
          <ChatErrorTool description={parsedError.message} helpUrl={parsedError.helpUrl} />
        </div>
      );
    }

    case errorCategory.server:
    case errorCategory.generic: {
      return renderGenericError();
    }
  }
});
