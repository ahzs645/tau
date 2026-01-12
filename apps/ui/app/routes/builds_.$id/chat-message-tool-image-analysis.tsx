import type { UIToolInvocation } from 'ai';
import { Eye, Check, X, Lightbulb, HelpCircle } from 'lucide-react';
import type { MyTools, RequirementResult } from '@taucad/chat';
import { toolName } from '@taucad/chat/constants';
import { useChatSelector } from '#hooks/use-chat.js';
import { cookieName } from '#constants/cookie.constants.js';
import { ImagePreviewGroup } from '#components/ui/image-preview-group.js';
import type { ImagePreviewItem } from '#components/ui/image-preview-group.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { RequirementIndicator } from '#components/chat/requirement-indicator.js';

/**
 * Returns the appropriate status icon for a requirement result
 */
function RequirementStatusIcon({ status }: { readonly status: RequirementResult['status'] }): React.JSX.Element {
  switch (status) {
    case 'passed': {
      return <Check className="size-3.5 text-success" />;
    }

    case 'failed': {
      return <X className="size-3.5 text-destructive" />;
    }

    case 'indeterminate': {
      return <HelpCircle className="size-3.5 text-muted-foreground" />;
    }
  }
}

/**
 * Renders a single requirement result with status icon, reason, and suggestion if failed
 */
function RequirementResultItem({
  result,
  index,
}: {
  readonly result: RequirementResult;
  readonly index: number;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-xs">
      <div className="mt-0.5 shrink-0">
        <RequirementStatusIcon status={result.status} />
      </div>
      <div className="flex-1">
        <div className="text-foreground">
          {index + 1}. {result.requirement}
        </div>
        {result.status === 'failed' ? (
          <div className="mt-1 space-y-1.5">
            <div className="text-muted-foreground">{result.reason}</div>
            {result.suggestion ? (
              <div className="text-warning-foreground flex items-start gap-1.5 rounded-md bg-warning/10 p-2">
                <Lightbulb className="mt-0.5 size-3 shrink-0 text-warning" />
                <span className="text-[11px] leading-relaxed">{result.suggestion}</span>
              </div>
            ) : undefined}
          </div>
        ) : undefined}
        {result.status === 'indeterminate' ? (
          <div className="mt-1 text-muted-foreground">{result.reason}</div>
        ) : undefined}
      </div>
    </div>
  );
}

export function ChatMessageToolImageAnalysis({
  part,
}: {
  readonly part: UIToolInvocation<MyTools[typeof toolName.imageAnalysis]>;
}): React.JSX.Element {
  const chatStatus = useChatSelector((state) => state.status);
  const isLoading = chatStatus === 'streaming' && ['input-streaming', 'input-available'].includes(part.state);

  switch (part.state) {
    case 'input-streaming':
    case 'input-available': {
      const input = part.input ?? {};
      const { requirements = [] } = input;

      return (
        <ChatToolCard key="loading" variant="minimal" status="loading" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Eye} />
            <ChatToolCardTitle>
              <ChatToolAction>Analyzing</ChatToolAction> <ChatToolDescription>model...</ChatToolDescription>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
          {requirements.length > 0 ? (
            <ChatToolCardContent>
              <div className="p-2 text-xs text-muted-foreground">
                Checking {requirements.length} requirement{requirements.length > 1 ? 's' : ''}...
              </div>
            </ChatToolCardContent>
          ) : undefined}
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { input, output: result } = part;
      const { requirements = [] } = input;
      const { observations = [], aggregatedResults = [] } = result;

      // Calculate pass/fail counts from aggregated results
      const passedCount = aggregatedResults.filter((r) => r.status === 'passed').length;
      const failedCount = aggregatedResults.filter((r) => r.status === 'failed').length;

      // Map observations to generic image preview items
      const imageItems: ImagePreviewItem[] = observations.map((observation) => ({
        id: observation.id,
        src: observation.src,
        label: observation.side,
      }));

      return (
        <ChatToolCard
          key="output"
          cookieName={cookieName.chatToolAnalysisImages}
          variant="card"
          status={isLoading ? 'loading' : 'ready'}
        >
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Eye} />
            <ChatToolCardTitle>Visual Analysis</ChatToolCardTitle>
            {aggregatedResults.length > 0 ? (
              <RequirementIndicator failedCount={failedCount} passedCount={passedCount} />
            ) : undefined}
          </ChatToolCardHeader>
          <ChatToolCardContent forceMount>
            {/* Observations Carousel */}
            {imageItems.length > 0 ? (
              <div className="mb-3 border-b p-2">
                <ImagePreviewGroup alt="Model screenshot" className="w-full" items={imageItems} />
              </div>
            ) : undefined}

            {/* Requirements List */}
            {aggregatedResults.length > 0 ? (
              <div className="space-y-2 px-2 pb-2">
                {aggregatedResults.map((resultItem, index) => {
                  const key = `${index}-${resultItem.requirement}`;

                  return <RequirementResultItem key={key} result={resultItem} index={index} />;
                })}
              </div>
            ) : requirements.length > 0 ? (
              // Fallback: Show original requirements if no results (shouldn't normally happen)
              <div className="space-y-1">
                {requirements.map((requirement, index) => {
                  const key = `${index}-${requirement}`;

                  return (
                    <div key={key} className="flex items-start text-xs">
                      <div className="mr-2 shrink-0 font-mono text-muted-foreground">{index + 1}.</div>
                      <div className="flex-1">{requirement}</div>
                    </div>
                  );
                })}
              </div>
            ) : undefined}
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolCard variant="card" status="error" isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon isError icon={Eye} />
            <ChatToolCardTitle>Image analysis failed</ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.imageAnalysis} state: ${part.state}`);
    }
  }
}
