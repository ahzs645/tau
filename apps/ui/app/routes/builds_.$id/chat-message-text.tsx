import type { TextUIPart } from 'ai';
import { defaultMarkdownControls, MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { useChatSelector } from '#hooks/use-chat.js';

export function ChatMessageText({ part }: { readonly part: TextUIPart }): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');

  return (
    <MarkdownViewer className="my-1" isStreaming={isStreaming} controls={{ ...defaultMarkdownControls, table: true }}>
      {part.text}
    </MarkdownViewer>
  );
}
