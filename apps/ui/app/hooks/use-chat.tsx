/**
 * Chat Hooks
 *
 * Store-resolved hooks for reading chat state and dispatching chat actions
 * from anywhere in the React tree. The streaming + persistence + draft +
 * RPC layer now lives in the vanilla `ChatSessionStore` (see
 * `apps/ui/app/services/chat-session-store.ts`); these hooks compose:
 *
 * - `useChatSessionSnapshot` for re-rendering on per-chatId AI SDK updates
 *   (messages / status / error)
 * - `<ActiveChatProvider>` for resolving the implicit "current chat" when
 *   no `chatId` is passed and for owning the ephemeral draft actor on
 *   marketing routes
 *
 * Resolution rules (mirrored across `useChatContext` / `useChatSelector` /
 * `useChatActions`):
 *
 * - Omitting `chatId` resolves to the active chat from the nearest
 *   `<ActiveChatProvider>` (project route's focused chat, homepage's
 *   sticky chat). Throws when neither an explicit id nor an active
 *   provider supply one.
 * - Passing `chatId` resolves to that exact chat from the store. The
 *   caller is responsible for keeping the session live (typically by
 *   wrapping the subtree in `<ActiveChatProvider chatId={chatId}>` or
 *   calling `useChatSession(chatId)` directly).
 *
 * Lifecycle vs draft:
 *
 * - `useChatContext()` / `useChatSelector()` reflect the live `ChatSession`.
 *   When no session exists for the resolved chat (cross-chat read before
 *   anything has acquired it), message-derived fields fall back to a
 *   stable empty snapshot (no error). Draft-derived fields always come
 *   from `<ActiveChatProvider>`.
 * - `useChatActions().setDraftText` / draft mutators always work as long
 *   as an `<ActiveChatProvider>` is in scope (no chat session required —
 *   covers marketing routes that render the composer without a real
 *   chat).
 * - `useChatActions().sendMessage` / lifecycle mutators are no-ops with a
 *   `console.warn` when no session is mounted for the resolved chat.
 */

import type { Chat as AiSdkChat } from '@ai-sdk/react';
import { useSelector } from '@xstate/react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MyUIMessage } from '@taucad/chat';
import type { ChatError } from '@taucad/types';
import type { KernelId } from '@taucad/types/constants';
import type { ActorRefFrom } from 'xstate';
import { useActiveChat } from '#hooks/active-chat-provider.js';
import { useChatSessionStore } from '#hooks/chat-session-store-provider.js';
import { useChatSessionSnapshot } from '#hooks/use-chat-session.js';
import type { ChatSession } from '#services/chat-session-store.js';
import type { chatPersistenceMachine } from '#hooks/chat-persistence.machine.js';
import type { draftMachine } from '#hooks/draft.machine.js';
import type { ChatMode } from '#routes/projects_.$id/chat-mode-selector.js';

type ChatInstance = AiSdkChat<MyUIMessage>;

type SendMessageInput = Parameters<ChatInstance['sendMessage']>[0];

const emptyMessages: readonly MyUIMessage[] = Object.freeze([]);
const emptyMessageOrder: readonly string[] = Object.freeze([]);
const emptyMessagesById: ReadonlyMap<string, MyUIMessage> = new Map();

const messagesByIdCache = new WeakMap<readonly MyUIMessage[], Map<string, MyUIMessage>>();

function getMessagesById(messages: readonly MyUIMessage[]): ReadonlyMap<string, MyUIMessage> {
  if (messages === emptyMessages) {
    return emptyMessagesById;
  }
  let cached = messagesByIdCache.get(messages);
  if (!cached) {
    cached = new Map<string, MyUIMessage>();
    for (const message of messages) {
      cached.set(message.id, message);
    }
    messagesByIdCache.set(messages, cached);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Context surface
// ---------------------------------------------------------------------------

export type ChatContextValue = {
  /**
   * The resolved chat id. Either the explicit `chatId` argument or the
   * `<ActiveChatProvider>` binding. `undefined` only when called outside
   * any `<ActiveChatProvider>` and without an explicit id (which throws —
   * `undefined` is therefore unreachable in practice and kept for callers
   * that pre-destructure the field defensively).
   */
  activeChatId: string | undefined;
  /**
   * The live AI SDK `Chat` instance for this chat. `undefined` when no
   * session is mounted for `activeChatId` (e.g. marketing pages or a
   * cross-chat read before anything has acquired it).
   */
  chat: ChatInstance | undefined;
  /**
   * Persistence machine for this chat. `undefined` when no session is
   * mounted for `activeChatId`.
   */
  persistenceActorRef: ActorRefFrom<typeof chatPersistenceMachine> | undefined;
  /**
   * Draft machine for this chat. Always defined — sourced from
   * `<ActiveChatProvider>`, so the composer's draft surface works even
   * when no session is mounted.
   */
  draftActorRef: ActorRefFrom<typeof draftMachine>;
};

type SessionSnapshotFields = {
  chat: ChatInstance | undefined;
  persistenceActorRef: ActorRefFrom<typeof chatPersistenceMachine> | undefined;
  messages: readonly MyUIMessage[];
  status: ChatInstance['status'];
  error: Error | undefined;
};

const emptySessionSnapshot: SessionSnapshotFields = {
  chat: undefined,
  persistenceActorRef: undefined,
  messages: emptyMessages,
  status: 'ready',
  error: undefined,
};

function selectSessionSnapshot(session: ChatSession | undefined): SessionSnapshotFields {
  if (!session) {
    return emptySessionSnapshot;
  }
  return {
    chat: session.chat,
    persistenceActorRef: session.persistenceActorRef,
    messages: session.chat.messages,
    status: session.chat.status,
    error: session.chat.error,
  };
}

/**
 * Resolve the live session snapshot + draft binding for the current (or
 * explicit) chat. Throws when no `<ActiveChatProvider>` is in scope.
 */
export function useChatContext(chatId?: string): ChatContextValue {
  const active = useActiveChat();
  const resolvedChatId = chatId ?? active.activeChatId;
  const snapshot = useChatSessionSnapshot(resolvedChatId ?? '', selectSessionSnapshot);

  return useMemo<ChatContextValue>(
    () => ({
      activeChatId: resolvedChatId,
      chat: snapshot.chat,
      persistenceActorRef: snapshot.persistenceActorRef,
      draftActorRef: active.draftActorRef,
    }),
    [resolvedChatId, snapshot.chat, snapshot.persistenceActorRef, active.draftActorRef],
  );
}

// ---------------------------------------------------------------------------
// State + selector surface
// ---------------------------------------------------------------------------

export type CombinedChatState = {
  messages: readonly MyUIMessage[];
  messagesById: ReadonlyMap<string, MyUIMessage>;
  messageOrder: readonly string[];
  status: ChatInstance['status'];
  error: Error | undefined;
  /** Persisted error survives reload (from the chat entity in IndexedDB). */
  persistedError: ChatError | undefined;
  isLoading: boolean;
  /**
   * Chat-scoped active model id, mirrored from the persistence machine's
   * `Chat.activeModel`. When undefined the consumer falls back to the
   * cookie default (see `useActiveChatModel`).
   */
  activeModel: string | undefined;
  /**
   * Chat-scoped active CAD kernel, mirrored from the persistence machine's
   * `Chat.activeKernel`. When undefined the consumer falls back to the
   * cookie default (see `useActiveChatKernel`).
   */
  activeKernel: KernelId | undefined;
  draftText: string;
  draftImages: string[];
  draftToolChoice: string | string[];
  draftMode: ChatMode;
  messageEdits: Record<string, MyUIMessage>;
  activeEditMessageId: string | undefined;
  editDraftText: string;
  editDraftImages: string[];
};

type PersistenceSliceFields = {
  persistedError: ChatError | undefined;
  activeModel: string | undefined;
  activeKernel: KernelId | undefined;
};

const emptyPersistenceSlice: PersistenceSliceFields = {
  persistedError: undefined,
  activeModel: undefined,
  activeKernel: undefined,
};

const persistenceSliceCache = new WeakMap<
  ActorRefFrom<typeof chatPersistenceMachine>,
  { context: unknown; slice: PersistenceSliceFields }
>();

/**
 * Subscribe to a possibly-undefined persistence actor's chat-scoped fields
 * (`persistedError`, `activeModel`, `activeKernel`) without violating the
 * rules of hooks when the actor is not yet present. Slices are cached per
 * actor + context reference so `useSyncExternalStore` returns the same
 * object reference across notifications that did not change the slice.
 */
function usePersistenceSlice(
  persistenceActorRef: ActorRefFrom<typeof chatPersistenceMachine> | undefined,
): PersistenceSliceFields {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!persistenceActorRef) {
        return () => undefined;
      }
      const sub = persistenceActorRef.subscribe(callback);
      return () => {
        sub.unsubscribe();
      };
    },
    [persistenceActorRef],
  );
  const getSnapshot = useCallback((): PersistenceSliceFields => {
    if (!persistenceActorRef) {
      return emptyPersistenceSlice;
    }
    const { context } = persistenceActorRef.getSnapshot();
    const cached = persistenceSliceCache.get(persistenceActorRef);
    if (
      cached &&
      cached.context === context &&
      cached.slice.persistedError === context.persistedError &&
      cached.slice.activeModel === context.activeModel &&
      cached.slice.activeKernel === context.activeKernel
    ) {
      return cached.slice;
    }
    const slice: PersistenceSliceFields = {
      persistedError: context.persistedError,
      activeModel: context.activeModel,
      activeKernel: context.activeKernel,
    };
    persistenceSliceCache.set(persistenceActorRef, { context, slice });
    return slice;
  }, [persistenceActorRef]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Primary hook for reading chat + draft state. Combines the live AI SDK
 * snapshot from the store with the draft state from `<ActiveChatProvider>`.
 * Selectors run on every notification — the `messagesById` and
 * `messageOrder` derivations are memoised on the message array reference
 * so equivalent reads are O(1).
 */
export function useChatSelector<T>(selector: (state: CombinedChatState) => T, chatId?: string): T {
  const { chat, persistenceActorRef, draftActorRef } = useChatContext(chatId);
  const draftContext = useSelector(draftActorRef, (state) => state.context);
  const persistenceSlice = usePersistenceSlice(persistenceActorRef);

  const messages = chat?.messages ?? emptyMessages;
  const status = chat?.status ?? 'ready';
  const error = chat?.error;
  const isLoading = status === 'streaming';

  const messagesById = getMessagesById(messages);
  const messageOrder = useMemo<readonly string[]>(
    () => (messages === emptyMessages ? emptyMessageOrder : messages.map((m) => m.id)),
    [messages],
  );

  const combinedState = useMemo<CombinedChatState>(
    () => ({
      messages,
      messagesById,
      messageOrder,
      status,
      error,
      persistedError: persistenceSlice.persistedError,
      isLoading,
      activeModel: persistenceSlice.activeModel,
      activeKernel: persistenceSlice.activeKernel,
      draftText: draftContext.draftText,
      draftImages: draftContext.draftImages,
      draftToolChoice: draftContext.draftToolChoice,
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- ChatMode is the agent/plan superset narrowed at the consumer layer
      draftMode: draftContext.draftMode as ChatMode,
      messageEdits: draftContext.messageEdits,
      activeEditMessageId: draftContext.activeEditMessageId,
      editDraftText: draftContext.editDraftText,
      editDraftImages: draftContext.editDraftImages,
    }),
    [messages, messagesById, messageOrder, status, error, persistenceSlice, isLoading, draftContext],
  );

  return selector(combinedState);
}

/**
 * Read state from a non-active chat (e.g. an agents-panel row showing a
 * background chat's status while a different chat is focused). The caller
 * is responsible for ensuring a session for `chatId` is alive (typically
 * by mounting `<ActiveChatProvider chatId={chatId}>` higher up or calling
 * `useChatSession(chatId)` in the same component).
 */
export function useChatById<T>(chatId: string, selector: (state: CombinedChatState) => T): T {
  return useChatSelector(selector, chatId);
}

// ---------------------------------------------------------------------------
// Action surface
// ---------------------------------------------------------------------------

export type ChatActions = {
  sendMessage: (message: SendMessageInput) => void;
  regenerate: () => void;
  stop: () => void;
  setMessages: (messages: MyUIMessage[]) => void;
  setDraftText: (text: string) => void;
  /**
   * Add a raw image data URL to the new-message draft. Synchronous: the
   * `draftMachine` enqueues the URL and resizes it through the single
   * `imageProcessing` chokepoint (see `apps/ui/app/hooks/draft.machine.ts`).
   * Pass the original (un-resized) data URL — the machine handles
   * dimension/compression caps via `resizeImageForChat()`. Failures surface
   * as a single global `toast.error` from `<ActiveChatProvider>`'s
   * `useDraftImageErrorToast` subscriber, so callers MUST NOT wrap this in
   * try/catch or await any resize step.
   */
  addDraftImage: (image: string) => void;
  removeDraftImage: (index: number) => void;
  setDraftToolChoice: (toolChoice: string | string[]) => void;
  setDraftMode: (mode: string) => void;
  clearDraft: () => void;
  startEditingMessage: (messageId: string) => void;
  exitEditMode: () => void;
  setEditDraftText: (text: string) => void;
  /**
   * Add a raw image data URL to the message-edit draft. Same contract as
   * {@link ChatActions.addDraftImage} — pass the raw URL synchronously; the
   * machine resizes via the FIFO chokepoint and surfaces errors via the
   * `<ActiveChatProvider>` toast subscriber.
   */
  addEditDraftImage: (image: string) => void;
  removeEditDraftImage: (index: number) => void;
  clearMessageEdit: (messageId: string) => void;
  // oxlint-disable-next-line max-params -- callback signature shared across chat components; refactoring would require updating many call sites
  editMessage: (messageId: string, content: string, model: string, metadata?: unknown, imageUrls?: string[]) => void;
  retryMessage: (messageId: string, modelId?: string) => void;
  /**
   * Patch the chat-scoped active model id. The persistence machine writes
   * `Chat.activeModel` so a reload preserves this choice independent of
   * the cookie default.
   */
  setActiveModel: (model: string | undefined) => void;
  /**
   * Patch the chat-scoped active CAD kernel. Same semantics as
   * {@link ChatActions.setActiveModel}.
   */
  setActiveKernel: (kernel: KernelId | undefined) => void;
};

function warnNoInstance(action: string, chatId: string | undefined): void {
  console.warn(`[useChatActions] ${action} ignored: no chat session for chatId=${chatId ?? '<unknown>'}.`);
}

/**
 * Returns the full action surface for the resolved chat. Lifecycle actions
 * (send/regenerate/stop/edit/retry/setMessages) require a live session in
 * the store; draft actions only require an `<ActiveChatProvider>`. See the
 * module docstring for resolution rules.
 *
 * For lifecycle actions we read the latest chat instance off the store at
 * dispatch time (instead of capturing it in the memoised closure). The
 * store outlives every render, so this always reflects the freshest state
 * — no stale-Chat hazard.
 */
export function useChatActions(chatId?: string): ChatActions {
  const store = useChatSessionStore();
  const { activeChatId, draftActorRef } = useChatContext(chatId);

  return useMemo<ChatActions>(() => {
    const resolveSession = (): ChatSession | undefined => (activeChatId ? store.get(activeChatId) : undefined);

    return {
      sendMessage(message: SendMessageInput) {
        draftActorRef.send({ type: 'clearDraft' });
        const session = resolveSession();
        if (!session) {
          warnNoInstance('sendMessage', activeChatId);
          return;
        }
        session.persistenceActorRef.send({
          type: 'startRequest',
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- AI SDK sendMessage union narrows to MyUIMessage at all call sites
          request: { kind: 'send', message: message as MyUIMessage },
        });
      },
      regenerate() {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('regenerate', activeChatId);
          return;
        }
        session.persistenceActorRef.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      },
      stop() {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('stop', activeChatId);
          return;
        }
        session.persistenceActorRef.send({ type: 'stopRequest' });
      },
      setMessages(messages: MyUIMessage[]) {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('setMessages', activeChatId);
          return;
        }
        session.chat.messages = messages;
      },

      setDraftText(text: string) {
        draftActorRef.send({ type: 'setDraftText', text });
      },
      addDraftImage(image: string) {
        draftActorRef.send({ type: 'addDraftImage', image });
      },
      removeDraftImage(index: number) {
        draftActorRef.send({ type: 'removeDraftImage', index });
      },
      setDraftToolChoice(toolChoice: string | string[]) {
        draftActorRef.send({ type: 'setDraftToolChoice', toolChoice });
      },
      setDraftMode(mode: string) {
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mode is one of the ChatMode literals at every call site
        draftActorRef.send({ type: 'setDraftMode', mode: mode as 'agent' | 'plan' });
      },
      clearDraft() {
        draftActorRef.send({ type: 'clearDraft' });
      },

      startEditingMessage(messageId: string) {
        const session = resolveSession();
        const originalMessage = session?.chat.messages.find((m) => m.id === messageId);
        draftActorRef.send({ type: 'startEditingMessage', messageId, originalMessage });
      },
      exitEditMode() {
        draftActorRef.send({ type: 'exitEditMode' });
      },
      setEditDraftText(text: string) {
        draftActorRef.send({ type: 'setEditDraftText', text });
      },
      addEditDraftImage(image: string) {
        draftActorRef.send({ type: 'addEditDraftImage', image });
      },
      removeEditDraftImage(index: number) {
        draftActorRef.send({ type: 'removeEditDraftImage', index });
      },
      clearMessageEdit(messageId: string) {
        draftActorRef.send({ type: 'clearMessageEdit', messageId });
      },

      // oxlint-disable-next-line max-params -- matches the callback signature used across chat components
      editMessage(messageId: string, content: string, model: string, _metadata?: unknown, imageUrls?: string[]) {
        draftActorRef.send({ type: 'clearMessageEdit', messageId });
        const session = resolveSession();
        if (!session) {
          warnNoInstance('editMessage', activeChatId);
          return;
        }
        // Validate before transitioning so requestLifecycle stays clean if
        // the message has gone (e.g. raced with a concurrent setMessages).
        if (!session.chat.messages.some((m) => m.id === messageId)) {
          return;
        }
        session.persistenceActorRef.send({
          type: 'startRequest',
          request: { kind: 'edit', messageId, content, model, imageUrls },
        });
      },

      retryMessage(messageId: string, modelId?: string) {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('retryMessage', activeChatId);
          return;
        }
        if (!session.chat.messages.some((m) => m.id === messageId)) {
          return;
        }
        session.persistenceActorRef.send({
          type: 'startRequest',
          request: { kind: 'retry', messageId, modelId },
        });
      },

      setActiveModel(model: string | undefined) {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('setActiveModel', activeChatId);
          return;
        }
        session.persistenceActorRef.send({ type: 'setActiveModel', model });
      },
      setActiveKernel(kernel: KernelId | undefined) {
        const session = resolveSession();
        if (!session) {
          warnNoInstance('setActiveKernel', activeChatId);
          return;
        }
        session.persistenceActorRef.send({ type: 'setActiveKernel', kernel });
      },
    };
  }, [store, activeChatId, draftActorRef]);
}
