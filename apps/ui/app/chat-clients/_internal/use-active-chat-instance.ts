import type { Chat } from '@ai-sdk/react';
import type { MyUIMessage } from '@taucad/chat';
import { useChatContext } from '#hooks/use-chat.js';

/**
 * Module-private accessor for the live AI SDK `Chat` instance bound to the
 * active chat session. Throws when no session is mounted — chat clients are
 * the only legal consumers of the raw `Chat` instance (R9), so the call site
 * always runs inside an `<ActiveChatProvider>` with an acquired session.
 *
 * Keeping this hook under `_internal/` (and importing it only from the three
 * chat-client files) is what stops the `body` / `metadata` literal sprawl
 * the blueprint removes — UI sites must reach the wire through a profile-
 * scoped client, never directly through `chat.sendMessage`.
 *
 * @internal
 */
// oxlint-disable-next-line tau-lint/require-public-export-jsdoc -- @internal, scoped to chat-clients
export const useActiveChatInstance = (): Chat<MyUIMessage> => {
  const { chat, activeChatId } = useChatContext();
  if (!chat) {
    throw new Error(
      `useActiveChatInstance: no AI SDK Chat instance for chatId=${activeChatId ?? '<unknown>'}. ` +
        'Mount <ActiveChatProvider chatId={...}> with an acquired session before composing a chat client.',
    );
  }
  return chat;
};
