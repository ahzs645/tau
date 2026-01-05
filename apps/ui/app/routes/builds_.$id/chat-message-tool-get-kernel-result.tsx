import type { UIToolInvocation } from 'ai';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
  ChatToolCardList,
  ChatToolCardListItem,
} from '#components/chat/chat-tool-card.js';
import { cookieName } from '#constants/cookie.constants.js';

export function ChatMessageToolGetKernelResult({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.getKernelResult]>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={CheckCircle} />
            <ChatToolCardTitle>Checking kernel status...</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { status, kernelErrors, message } = output;

      const hasErrors = kernelErrors && kernelErrors.length > 0;

      // Success state - use minimal card with success icon, no collapsible content
      if (status === 'ready' && !hasErrors) {
        return (
          <ChatToolCard variant="minimal" status="ready" isCollapsible={false}>
            <ChatToolCardHeader className="text-success">
              <ChatToolCardIcon icon={CheckCircle} />
              <ChatToolCardTitle>{message ?? 'Kernel compilation successful'}</ChatToolCardTitle>
            </ChatToolCardHeader>
          </ChatToolCard>
        );
      }

      // Error state - use minimal card with error list
      return (
        <ChatToolCard
          isCookieDefaultOpen
          variant="minimal"
          status="error"
          isDefaultOpen={false}
          cookieName={cookieName.chatToolKernelErrors}
        >
          <ChatToolCardHeader className="text-destructive">
            <ChatToolCardIcon isError icon={XCircle} />
            <ChatToolCardTitle>{message ?? `Found ${kernelErrors?.length ?? 0} error(s)`}</ChatToolCardTitle>
          </ChatToolCardHeader>
          {hasErrors ? (
            <ChatToolCardContent>
              <ChatToolCardList maxHeight="max-h-48" className="border-destructive/30">
                {kernelErrors.map((error, index) => {
                  const { location } = error;
                  const key = `${location?.startLineNumber ?? index}-${error.message}`;

                  return (
                    <ChatToolCardListItem key={key} icon={AlertTriangle} className="text-muted-foreground">
                      <span className="flex flex-1 items-start gap-1">
                        {location ? (
                          <span className="shrink-0 font-mono text-muted-foreground/70">
                            {location.fileName}:{location.startLineNumber}:{location.startColumn}
                          </span>
                        ) : undefined}
                        <span className="font-mono">{error.message}</span>
                      </span>
                    </ChatToolCardListItem>
                  );
                })}
              </ChatToolCardList>
            </ChatToolCardContent>
          ) : undefined}
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolCard variant="minimal" status="error" isCollapsible={false}>
          <ChatToolCardHeader className="text-destructive">
            <ChatToolCardIcon isError icon={XCircle} />
            <ChatToolCardTitle>Failed to check kernel status: {part.errorText}</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }
  }
}
