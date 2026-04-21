import { FlaskConical, X, Lightbulb, Check, Box } from 'lucide-react';
import type { ToolInvocation } from '@taucad/chat';
import type { TestFailure, TestPass } from '@taucad/testing';
import { toolName } from '@taucad/chat/constants';
import { useChatSelector } from '#hooks/use-chat.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardContent,
} from '#components/chat/chat-tool-card.js';
import { ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { ChatToolLabel } from '#components/chat/chat-tool-label.js';
import { RequirementIndicator } from '#components/chat/requirement-indicator.js';
import { ChatToolError } from '#components/chat/chat-tool-error.js';
import { FileLink } from '#components/files/file-link.js';
import { ViewerLink } from '#components/files/viewer-link.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

function TestPassItem({ pass, index }: { readonly pass: TestPass; readonly index: number }): React.JSX.Element {
  return (
    <div className='flex items-start gap-2 text-xs'>
      <div className='mt-0.5 shrink-0'>
        <Check className='size-3.5 text-muted-foreground' />
      </div>
      <div className='text-muted-foreground'>
        {index + 1}. {pass.requirement}
      </div>
    </div>
  );
}

function TestFailureItem({
  failure,
  index,
}: {
  readonly failure: TestFailure;
  readonly index: number;
}): React.JSX.Element {
  return (
    <div className='flex items-start gap-2 text-xs'>
      <div className='mt-0.5 shrink-0'>
        <X className='size-3.5 text-destructive' />
      </div>
      <div className='flex-1'>
        <div className='text-foreground'>
          {index + 1}. {failure.requirement}
        </div>
        <div className='mt-1 space-y-1.5'>
          <div className='text-muted-foreground'>{failure.reason}</div>
          <div className='text-warning-foreground flex items-start gap-1.5 rounded-md bg-warning/10 p-2'>
            <Lightbulb className='mt-0.5 size-3 shrink-0 text-warning' />
            <span className='text-[11px] leading-relaxed'>{failure.suggestion}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GeometryArtifactBadge({ artifactPath }: { readonly artifactPath: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ViewerLink asChild path={artifactPath}>
          <div className='flex cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground'>
            <Box className='size-3 shrink-0' />
            <span className='truncate'>{artifactPath}</span>
          </div>
        </ViewerLink>
      </TooltipTrigger>
      <TooltipContent side='top'>Open geometry in a new viewer tab</TooltipContent>
    </Tooltip>
  );
}

type FileGroup = {
  readonly targetFile: string;
  readonly passes: readonly TestPass[];
  readonly failures: readonly TestFailure[];
  readonly artifactPath: string | undefined;
};

const groupByTargetFile = (
  passes: readonly TestPass[],
  failures: readonly TestFailure[],
  artifacts: Readonly<Record<string, string>> | undefined,
): readonly FileGroup[] => {
  const order: string[] = [];
  const map = new Map<string, { passes: TestPass[]; failures: TestFailure[] }>();

  const ensure = (file: string): { passes: TestPass[]; failures: TestFailure[] } => {
    let entry = map.get(file);
    if (!entry) {
      entry = { passes: [], failures: [] };
      map.set(file, entry);
      order.push(file);
    }
    return entry;
  };

  // Failures first so files with failures sort ahead of pass-only files.
  for (const failure of failures) {
    ensure(failure.targetFile).failures.push(failure);
  }
  for (const pass of passes) {
    ensure(pass.targetFile).passes.push(pass);
  }

  // Surface any artifact-only files (no requirements but the agent still got geometry back).
  if (artifacts) {
    for (const file of Object.keys(artifacts)) {
      ensure(file);
    }
  }

  return order.map((targetFile) => {
    const entry = map.get(targetFile)!;
    return {
      targetFile,
      passes: entry.passes,
      failures: entry.failures,
      artifactPath: artifacts?.[targetFile],
    };
  });
};

function FileGroupSection({ group }: { readonly group: FileGroup }): React.JSX.Element {
  const { targetFile, passes, failures, artifactPath } = group;
  const hasFailures = failures.length > 0;

  return (
    <div data-target-file={targetFile} className='space-y-2 rounded-md border border-border/40 p-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5 text-[11px] font-medium text-foreground'>
          <FileLink path={targetFile}>
            <span className='truncate'>{targetFile}</span>
          </FileLink>
        </div>
        <RequirementIndicator failedCount={failures.length} passedCount={passes.length} />
      </div>

      {hasFailures && (
        <div className='space-y-2'>
          {failures.map((failure, index) => (
            <TestFailureItem key={`${targetFile}:${failure.id}`} failure={failure} index={index} />
          ))}
        </div>
      )}

      {passes.length > 0 && (
        <div className={hasFailures ? 'mt-2 space-y-1 border-t pt-2' : 'space-y-1'}>
          {passes.map((pass, index) => (
            <TestPassItem key={`${targetFile}:${pass.id}`} pass={pass} index={index} />
          ))}
        </div>
      )}

      {artifactPath ? <GeometryArtifactBadge artifactPath={artifactPath} /> : undefined}
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
        <ChatToolCard key='loading' variant='minimal' status='loading' isDefaultOpen={false}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={FlaskConical} />
            <ChatToolCardTitle>
              <ChatToolLabel verb='Running'>
                <ChatToolDescription>tests...</ChatToolDescription>
              </ChatToolLabel>
            </ChatToolCardTitle>
          </ChatToolCardHeader>
        </ChatToolCard>
      );
    }

    case 'output-available': {
      const { output: result } = part;
      const { failures = [], passes = [], geometryArtifactPaths } = result;
      const totalPassed = passes.length;
      const totalFailed = failures.length;
      const groups = groupByTargetFile(passes, failures, geometryArtifactPaths);
      const allPassed = totalFailed === 0;

      if (allPassed) {
        const requirementNoun = totalPassed === 1 ? 'requirement' : 'requirements';
        return (
          <ChatToolCard key='output' variant='minimal' status={isLoading ? 'loading' : 'ready'} isDefaultOpen={false}>
            <ChatToolCardHeader>
              <ChatToolCardIcon icon={FlaskConical} />
              <ChatToolCardTitle>
                <ChatToolLabel verb='Tested'>
                  <ChatToolDescription>
                    {totalPassed} {requirementNoun}
                  </ChatToolDescription>
                </ChatToolLabel>
              </ChatToolCardTitle>
            </ChatToolCardHeader>
            <ChatToolCardContent forceMount>
              <div className='space-y-2 border-l border-foreground/20 py-1 pl-2'>
                {groups.map((group) => (
                  <FileGroupSection key={group.targetFile} group={group} />
                ))}
              </div>
            </ChatToolCardContent>
          </ChatToolCard>
        );
      }

      const totalRequirements = totalPassed + totalFailed;
      const requirementNoun = totalRequirements === 1 ? 'requirement' : 'requirements';
      return (
        <ChatToolCard key='output' variant='card' status={isLoading ? 'loading' : 'ready'}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={FlaskConical} />
            <ChatToolCardTitle>
              <ChatToolLabel verb='Tested'>
                <ChatToolDescription>
                  {totalRequirements} {requirementNoun} ({totalFailed} failed)
                </ChatToolDescription>
              </ChatToolLabel>
            </ChatToolCardTitle>
            <RequirementIndicator failedCount={totalFailed} passedCount={totalPassed} />
          </ChatToolCardHeader>
          <ChatToolCardContent forceMount>
            <div className='space-y-2 p-2'>
              {groups.map((group) => (
                <FileGroupSection key={group.targetFile} group={group} />
              ))}
            </div>
          </ChatToolCardContent>
        </ChatToolCard>
      );
    }

    case 'output-error': {
      return (
        <ChatToolError errorText={part.errorText} fallbackIcon={FlaskConical} fallbackTitle='Failed to run tests' />
      );
    }

    case 'approval-requested':
    case 'approval-responded':
    case 'output-denied': {
      throw new Error(`Unexpected ${toolName.testModel} state: ${part.state}`);
    }
  }
}
