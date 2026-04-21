/**
 * ActiveChatProvider
 *
 * Per-subtree binding to a "currently active" chat for chat-input UIs (the
 * composer, message editor, etc.). Resolves the draft actor for that chat
 * in two modes derived from a single `chatId` prop:
 *
 * - **Real chat id** (e.g. `"chat_abc"`): the draft actor is sourced from
 *   the app-shell `ChatSessionStore` via `useChatSession`. Persistence to
 *   `Chat.draft` in IndexedDB is wired by the store; hydration of any
 *   existing draft is also owned by the store. The provider itself is a
 *   pure adapter.
 * - **`undefined`**: ephemeral mode. A throwaway draft actor is created
 *   with no-op persist actors so the composer's draft surface still works
 *   on marketing pages (CTA section, library empty state) where there is
 *   no chat row to attach to yet.
 *
 * The provider intentionally does not own `Chat`/streaming/RPC — the store
 * does. Splitting draft visibility (per provider) from chat lifetime (per
 * store) lets the future agents panel keep N background chat sessions
 * alive while only the currently-active subtree is wrapped here.
 */

import { useActorRef } from '@xstate/react';
import { createContext, useContext, useMemo } from 'react';
import type { ActorRefFrom } from 'xstate';
import type { MyUIMessage } from '@taucad/chat';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { draftMachine } from '#hooks/draft.machine.js';
import { inspect } from '#machines/inspector.js';
import { useChatSession } from '#hooks/use-chat-session.js';

export type ActiveChatContextValue = {
  activeChatId: string | undefined;
  draftActorRef: ActorRefFrom<typeof draftMachine>;
};

const ActiveChatContext = createContext<ActiveChatContextValue | undefined>(undefined);

const noopPersistDraftActor = fromSafeAsync<void, { chatId: string; draft: MyUIMessage }>(async () => undefined);
const noopPersistEditDraftActor = fromSafeAsync<void, { chatId: string; messageId: string; draft: MyUIMessage }>(
  async () => undefined,
);
const noopClearMessageEditActor = fromSafeAsync<void, { chatId: string; messageId: string }>(async () => undefined);

type ActiveChatProviderProps = {
  readonly children: React.ReactNode;
  /**
   * The chat id this subtree is bound to. `undefined` puts the provider in
   * ephemeral mode — the draft is held in-memory only and no IndexedDB
   * writes happen. Marketing routes pass `undefined`; the project route
   * passes the editor machine's `focusedChatId`; the homepage passes its
   * sticky `chat_homepage_main`.
   */
  readonly chatId: string | undefined;
};

export function ActiveChatProvider({ children, chatId }: ActiveChatProviderProps): React.JSX.Element {
  // Component identity is keyed on whether a real chatId is bound. This is
  // a stable distinction per route — the homepage always passes a sticky
  // id, the project route always passes a `focusedChatId`, and marketing
  // pages always pass `undefined`. A swap at runtime would unmount the
  // ephemeral inner branch which is fine because no draft state needs to
  // survive that transition.
  if (chatId) {
    return <SessionBackedActiveChatProvider chatId={chatId}>{children}</SessionBackedActiveChatProvider>;
  }
  return <EphemeralActiveChatProvider>{children}</EphemeralActiveChatProvider>;
}

function SessionBackedActiveChatProvider({
  children,
  chatId,
}: {
  readonly children: React.ReactNode;
  readonly chatId: string;
}): React.JSX.Element {
  const session = useChatSession(chatId);

  const value = useMemo<ActiveChatContextValue>(
    () => ({ activeChatId: chatId, draftActorRef: session.draftActorRef }),
    [chatId, session.draftActorRef],
  );

  return <ActiveChatContext.Provider value={value}>{children}</ActiveChatContext.Provider>;
}

function EphemeralActiveChatProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const draftActorRef = useActorRef(
    draftMachine.provide({
      actors: {
        persistDraftActor: noopPersistDraftActor,
        persistEditDraftActor: noopPersistEditDraftActor,
        clearMessageEditActor: noopClearMessageEditActor,
      },
    }),
    {
      input: { chatId: undefined },
      inspect,
    },
  );

  const value = useMemo<ActiveChatContextValue>(() => ({ activeChatId: undefined, draftActorRef }), [draftActorRef]);

  return <ActiveChatContext.Provider value={value}>{children}</ActiveChatContext.Provider>;
}

/**
 * Returns the active chat id for the nearest `<ActiveChatProvider>`, or
 * `undefined` when used outside one (which is valid — marketing pages render
 * chat-input UI without a real chat to attach to).
 */
export function useActiveChatId(): string | undefined {
  return useContext(ActiveChatContext)?.activeChatId;
}

/**
 * Returns the full active chat context (active chat id + draft actor ref).
 *
 * @throws when used outside an `<ActiveChatProvider>`.
 */
export function useActiveChat(): ActiveChatContextValue {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error('useActiveChat must be used within an ActiveChatProvider');
  }

  return context;
}
