import { FlaskConical, X, Lightbulb } from 'lucide-react';
import type { ToolInvocation, TestFailure } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { parseToolErrorText } from '@taucad/chat';
import { useChatSelector } from '#hooks/use-chat.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { RequirementIndicator } from '#components/chat/requirement-indicator.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';

/**
 * Renders a single test failure with reason and suggestion
 */
function TestFailureItem({
  failure,
  index,
}: {
  readonly failure: TestFailure;
  readonly index: number;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="mt-0.5 shrink-0">
        <X className="size-3.5 text-destructive" />
      </div>
      <div className="flex-1">
        <div className="text-foreground">
          {index + 1}. {failure.requirement}
        </div>
        <div className="mt-1 space-y-1.5">
          <div className="text-muted-foreground">{failure.reason}</div>
          <div className="text-warning-foreground flex items-start gap-1.5 rounded-md bg-warning/10 p-2">
            <Lightbulb className="mt-0.5 size-3 shrink-0 text-warning" />
            <span className="text-[11px] leading-relaxed">{failure.suggestion}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChatMessageToolTestModel({
  part,
}: {
  readonly part: ToolInvocation<typeof toolName.testModel>;
}): React.JSX.Element {
  const chatStatus = useChatSelector((state) => state.status);
  const isLoading = chatStatus === 'streaming' && ['input-streaming', 'input-available'].includes(part.state);

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      return (
        <ChatToolCard key="loading" variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={FlaskConical} />
            <ChatToolCardTitle>
              <ChatToolAction>Running</ChatToolAction> <ChatToolDescription>tests...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output: result } = part;
      const { failures = [], total = 0 } = result;
      const passedCount = total - failures.length;
      const failedCount = failures.length;

      // All tests passed
      if (failures.length === 0) {
        return (
          <ChatToolCard key="output" variant="minimal" status={isLoading ? 'loading' : 'ready'}>
            <ChatToolCardHeader>
              <ChatToolCardIcon icon={FlaskConical} />
              <ChatToolCardTitle>
                <ChatToolAction>All tests passed</ChatToolAction>
              </ChatToolCardTitle>
              <RequirementIndicator failedCount={0} passedCount={total} />
            </ChatToolCardHeader>
          </ChatToolCard>
        );
      }

      // Some tests failed - show details
      return (
        <ChatToolCard key="output" variant="card" status={isLoading ? 'loading' : 'ready'}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={FlaskConical} />
            <ChatToolCardTitle>Test Results</ChatToolCardTitle>
            <RequirementIndicator failedCount={failedCount} passedCount={passedCount} />
          </ChatToolCardHeader>
          <ChatToolCardContent forceMount>
            <div className="space-y-2 p-2">
              {failures.map((failure, index) => {
                const key = `${failure.id}-${index}`;

                return <TestFailureItem key={key} failure={failure} index={index} />;
              })}
            </div>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      const error = parseToolErrorText(part.errorText);
      if (error) {
        return <ChatToolError error={error} />;
      }

      return (
        <ChatToolCard variant="card" status="error" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon isError icon={FlaskConical} />
            <ChatToolCardTitle>Test run failed</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.testModel} state: ${part.state}`);
    }
  }
}
