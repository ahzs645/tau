import type { UIToolInvocation } from 'ai';
import { Eye, Camera, ListChecks } from 'lucide-react';
import type { MyTools } from '@taucad/chat';
import type { toolName } from '@taucad/chat/constants';
import { useChatSelector } from '#hooks/use-chat.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#components/ui/hover-card.js';
import { CopyButton } from '#components/copy-button.js';
import {
  ChatToolCard,
  ChatToolCardHeader,
  ChatToolCardIcon,
  ChatToolCardTitle,
  ChatToolCardActions,
  ChatToolCardContent,
  ChatToolCardSection,
} from '#components/chat/chat-tool-card.js';
import { ChatToolAction, ChatToolDescription } from '#components/chat/chat-tool-text.js';
import { cookieName } from '#constants/cookie.constants.js';

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
        <ChatToolCard variant="minimal" status="loading" isDefaultOpen={false}>
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

      return (
        <ChatToolCard isDefaultOpen variant="card" status={isLoading ? 'loading' : 'ready'}>
          <ChatToolCardHeader>
            <ChatToolCardIcon icon={Eye} />
            <ChatToolCardTitle>Visual Analysis</ChatToolCardTitle>
            <ChatToolCardActions>
              <CopyButton
                size="xs"
                className="[&_[data-slot=label]]:hidden @xs/chat-tool-card:[&_[data-slot=label]]:flex"
                getText={() => result.analysis}
              />
            </ChatToolCardActions>
          </ChatToolCardHeader>
          <ChatToolCardContent>
            {/* Screenshot Section - Now collapsible */}
            {result.screenshot ? (
              <ChatToolCardSection
                isDefaultOpen
                isCookieDefaultOpen
                title="Model Screenshot"
                icon={Camera}
                cookieName={cookieName.chatToolImageScreenshot}
              >
                <HoverCard>
                  <HoverCardTrigger asChild>
                    <div className="cursor-pointer rounded-md border bg-neutral/5 hover:bg-neutral/10">
                      <img
                        src={result.screenshot}
                        alt="Model screenshot"
                        className="size-full rounded-sm object-cover object-top"
                      />
                    </div>
                  </HoverCardTrigger>
                  <HoverCardContent asChild side="top" align="start" className="w-96">
                    <img src={result.screenshot} alt="Model screenshot (full size)" className="max-w-full" />
                  </HoverCardContent>
                </HoverCard>
              </ChatToolCardSection>
            ) : undefined}

            {/* Requirements Section */}
            {requirements.length > 0 ? (
              <ChatToolCardSection
                title={`${requirements.length} Requirement${requirements.length > 1 ? 's' : ''}`}
                icon={ListChecks}
                isDefaultOpen={false}
                cookieName={cookieName.chatToolImageRequirements}
                isCookieDefaultOpen={false}
              >
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
              </ChatToolCardSection>
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
  }
}
