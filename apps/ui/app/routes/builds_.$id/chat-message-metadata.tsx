import type { MyMetadata } from '@taucad/chat';
import { ChatMessageMetadataUsage } from '#routes/builds_.$id/chat-message-metadata-usage.js';

// Controller component for rendering message metadata
export function ChatMessageMetadata({ metadata }: { readonly metadata: MyMetadata }): React.JSX.Element | undefined {
  // Only render if there are conversation turns
  if (!metadata.turns || metadata.turns.length === 0) {
    return undefined;
  }

  return <ChatMessageMetadataUsage metadata={metadata} />;
}
