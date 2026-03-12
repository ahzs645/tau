import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import type { IssueSeverity, KernelIssue } from '@taucad/runtime';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
  ChatToolCardList,
  ChatToolCardListItem,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { FileLink } from '#components/files/file-link.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

/**
 * Maps issue severity to appropriate icon component.
 */
function getSeverityIcon(severity: IssueSeverity): typeof AlertTriangle {
  switch (severity) {
    case 'error': {
      return XCircle;
    }

    case 'warning': {
      return AlertTriangle;
    }

    case 'info': {
      return Info;
    }
  }
}

/**
 * Maps issue severity to appropriate icon color class.
 */
function getSeverityIconClass(severity: IssueSeverity): string {
  switch (severity) {
    case 'error': {
      return 'text-destructive';
    }

    case 'warning': {
      return 'text-warning';
    }

    case 'info': {
      return 'text-muted-foreground';
    }
  }
}

/**
 * Counts issues by severity and returns formatted summary.
 */
function getIssueSummary(issues: KernelIssue[]): {
  summary: string;
  hasErrors: boolean;
} {
  const counts = {
    error: 0,
    warning: 0,
    info: 0,
  };

  for (const issue of issues) {
    counts[issue.severity]++;
  }

  const parts: string[] = [];

  if (counts.error > 0) {
    parts.push(`${counts.error} ${counts.error === 1 ? 'error' : 'errors'}`);
  }

  if (counts.warning > 0) {
    parts.push(`${counts.warning} ${counts.warning === 1 ? 'warning' : 'warnings'}`);
  }

  if (counts.info > 0) {
    parts.push(`${counts.info} ${counts.info === 1 ? 'info' : 'infos'}`);
  }

  return {
    summary: `Found ${parts.join(', ')}`,
    hasErrors: counts.error > 0,
  };
}

export function ChatMessageToolGetKernelResult({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.getKernelResult>;
}): React.JSX.Element {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <ChatToolCard variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={CheckCircle} />
            <ChatToolCardTitle>
              <ChatToolAction>Checking</ChatToolAction>
              <ChatToolDescription>kernel status...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output } = part;
      const { status, kernelIssues } = output;

      const hasIssues = kernelIssues && kernelIssues.length > 0;

      // Success state with no issues - use minimal card with success icon
      if (status === 'ready' && !hasIssues) {
        return (
          <ChatToolCard variant='minimal' status='ready' isCollapsible={false}>
            <ChatToolCardHeader className='text-success'>
              <ChatToolCardIcon icon={CheckCircle} />
              <ChatToolCardTitle>Kernel compilation successful</ChatToolCardTitle>
            </ChatToolCardHeader>
          </ChatToolCard>
        );
      }

      // Has issues - determine severity for styling
      const { summary, hasErrors } = hasIssues ? getIssueSummary(kernelIssues) : { summary: '', hasErrors: false };
      const headerColorClass = hasErrors
        ? 'text-destructive hover:text-destructive'
        : 'text-warning hover:text-warning';
      const headerIcon = hasErrors ? XCircle : AlertTriangle;
      const borderClass = hasErrors ? 'border-destructive/30' : 'border-warning/30';
      const cardStatus = hasErrors ? 'error' : 'warning';

      return (
        <ChatToolCard isCookieDefaultOpen variant='minimal' status={cardStatus} isDefaultOpen={false}>
          <ChatToolCardHeader className={headerColorClass}>
            <ChatToolCardIcon isError={hasErrors} icon={headerIcon} />
            <ChatToolCardTitle>{summary}</ChatToolCardTitle>
          </ChatToolCardHeader>
          {hasIssues ? (
            <ChatToolCardContent>
              <ChatToolCardList maxHeight='max-h-48' className={borderClass}>
                {kernelIssues.map((issue, index) => {
                  const { location, severity } = issue;
                  const key = `${location?.startLineNumber ?? index}-${issue.message}`;
                  const issueIcon = getSeverityIcon(severity);
                  const issueIconClass = getSeverityIconClass(severity);

                  return (
                    <ChatToolCardListItem key={key} icon={issueIcon} iconClassName={issueIconClass}>
                      <span className='flex flex-1 flex-col items-start gap-0.5 @xs:flex-row @xs:gap-1'>
                        {location ? (
                          <FileLink
                            path={location.fileName}
                            lineNumber={location.startLineNumber}
                            column={location.startColumn}
                            className='shrink-0 font-mono text-xs text-muted-foreground/70 hover:text-foreground'
                          >
                            {location.fileName}:{location.startLineNumber}:{location.startColumn}
                          </FileLink>
                        ) : undefined}
                        <MarkdownViewer className='inline w-auto font-mono text-xs text-inherit'>
                          {issue.message}
                        </MarkdownViewer>
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
        <ChatToolError
          errorText={part.errorText}
          fallbackIcon={XCircle}
          fallbackTitle='Failed to check kernel status'
        />
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.getKernelResult} state: ${part.state}`);
    }
  }
}
