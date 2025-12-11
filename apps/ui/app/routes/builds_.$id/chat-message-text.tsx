import type { TextUIPart } from 'ai';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import { useChatSelector } from '#hooks/use-chat.js';

export function ChatMessageText({ part }: { readonly part: TextUIPart }): React.JSX.Element {
  const isStreaming = useChatSelector((state) => state.status === 'streaming');

  return <MarkdownViewer isStreaming={isStreaming}>{part.text}</MarkdownViewer>;
}
