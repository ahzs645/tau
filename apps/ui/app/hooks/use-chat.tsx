/**
 * Chat Provider and Hooks
 *
 * Event-driven architecture using AI SDK callbacks + XState debouncing.
 * - useChat from AI SDK is the source of truth for messages
 * - chatPersistenceMachine handles message persistence with debouncing
 * - draftMachine handles drafts/edits with direct persistence
 * - useChatRpcConnection handles RPC execution via Socket.IO
 */

import { useChat } from '@ai-sdk/react';
import { useActorRef, useSelector } from '@xstate/react';
import { createContext, useContext, useEffect, useRef, useMemo, useCallback } from 'react';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import type { MyUIMessage } from '@taucad/chat';
import { DefaultChatTransport } from 'ai';
import { generatePrefixedId } from '@taucad/utils/id';
import { idPrefix } from '@taucad/types/constants';
import type { ChatError } from '@taucad/types';
import { draftMachine } from '#hooks/draft.machine.js';
import { chatPersistenceMachine } from '#hooks/chat-persistence.machine.js';
import type { ChatRequest } from '#hooks/chat-persistence.machine.js';
import { useChats } from '#hooks/use-chats.js';
import { inspect } from '#machines/inspector.js';
import { ENV } from '#environment.config.js';
import { parseErrorForPersistence } from '#utils/error.utils.js';
import { extractMimeTypeFromDataUrl, finalizeInterruptedToolParts } from '#utils/chat.utils.js';
import type { ChatMode } from '#routes/projects_.$id/chat-mode-selector.js';

type UseChatReturn = ReturnType<typeof useChat<MyUIMessage>>;

type SendMessageInput = Parameters<UseChatReturn['sendMessage']>[0];

/**
 * Build the user message that replaces an edited message in the transcript.
 * Mirrors the prior inline construction in `useChatActions.editMessage`.
 */
function buildEditedMessage(request: Extract<ChatRequest, { kind: 'edit' }>): MyUIMessage {
  return {
    id: request.messageId,
    role: 'user',
    parts: [
      { type: 'text', text: request.content },
      ...(request.imageUrls?.map(
        (url) =>
          ({
            type: 'file',
            url,
            mediaType: extractMimeTypeFromDataUrl(url),
          }) as const,
      ) ?? []),
    ],
    metadata: {
      createdAt: Date.now(),
      status: 'pending',
      model: request.model,
    },
  };
}

/**
 * Build the message slice that retry replaces. Returns `undefined` if the
 * target message is no longer in the transcript (race with a concurrent
 * setMessages). Mirrors the prior inline logic in `useChatActions.retryMessage`.
 */
function buildRetryMessages(
  messages: MyUIMessage[],
  request: Extract<ChatRequest, { kind: 'retry' }>,
): MyUIMessage[] | undefined {
  const messageIndex = messages.findIndex((m) => m.id === request.messageId);
  if (messageIndex === -1) {
    return undefined;
  }

  const sliceIndex = Math.max(messageIndex - 1, 0);
  const previousMessage = messages[sliceIndex];

  if (previousMessage && request.modelId) {
    return [
      ...messages.slice(0, sliceIndex),
      {
        ...previousMessage,
        metadata: { ...previousMessage.metadata, model: request.modelId },
      },
    ];
  }

  return messages.slice(0, messageIndex);
}

// Single context for all chat state
type ChatContextValue = {
  chat: UseChatReturn;
  activeChatId: string | undefined;
  resourceId: string | undefined;
  chatName: string;
  isLoadingChat: boolean;
  queuePersist: (messages: MyUIMessage[]) => void;
  draftActorRef: ReturnType<typeof useActorRef<typeof draftMachine>>;
  persistenceActorRef: ReturnType<typeof useActorRef<typeof chatPersistenceMachine>>;
};

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

// Provider component - manages all chat state
export function ChatProvider({
  children,
  resourceId,
  chatId: activeChatId,
}: {
  readonly children: React.ReactNode;
  readonly resourceId?: string;
  readonly chatId?: string;
}): React.JSX.Element {
  const { getChat, patchChat, setMessageEdit, clearMessageEdit, chats } = useChats(resourceId ?? '');

  // Refs for functions that actors need access to (set after useChat is created)
  const setMessagesRef = useRef<UseChatReturn['setMessages'] | undefined>(undefined);
  const regenerateRef = useRef<(() => void) | undefined>(undefined);
  const initializeDraftRef = useRef<((chat: NonNullable<Awaited<ReturnType<typeof getChat>>>) => void) | undefined>(
    undefined,
  );

  // Create draft machine with provided actors (like use-project.tsx pattern)
  const draftActorRef = useActorRef(
    draftMachine.provide({
      actors: {
        persistDraftActor: fromSafeAsync(async ({ input }) => {
          await patchChat(input.chatId, 'draft', input.draft);
        }),
        persistEditDraftActor: fromSafeAsync(async ({ input }) => {
          await setMessageEdit(input.chatId, input.messageId, input.draft);
        }),
        clearMessageEditActor: fromSafeAsync(async ({ input }) => {
          await clearMessageEdit(input.chatId, input.messageId);
        }),
      },
    }),
    {
      input: {
        chatId: activeChatId,
      },
      inspect,
    },
  );

  // Create persistence machine with provided actors
  // Actors handle the complete load flow: fetch → setMessages → initialize draft
  // The machine's onDone action sets persistedError from the returned chat
  const persistenceActorRef = useActorRef(
    chatPersistenceMachine.provide({
      actors: {
        loadChatActor: fromSafeAsync(async ({ input }) => {
          const loadedChat = await getChat(input.chatId);

          if (loadedChat) {
            setMessagesRef.current?.(loadedChat.messages);
            initializeDraftRef.current?.(loadedChat);

            const lastMessage = loadedChat.messages.at(-1);
            if (lastMessage?.role === 'user' && lastMessage.metadata?.status === 'pending') {
              void regenerateRef.current?.();

              return { type: 'chatRetrieved', chat: { ...loadedChat, error: undefined } };
            }
          } else {
            setMessagesRef.current?.([]);
          }

          return { type: 'chatRetrieved', chat: loadedChat };
        }),
        persistMessagesActor: fromSafeAsync(async ({ input }) => {
          await patchChat(input.chatId, 'messages', input.messages);
        }),
        persistErrorActor: fromSafeAsync(async ({ input }) => {
          await patchChat(input.chatId, 'error', input.error);
        }),
        clearErrorActor: fromSafeAsync(async ({ input }) => {
          await patchChat(input.chatId, 'error', undefined);
        }),
      },
    }),
    {
      input: {
        activeChatId,
        resourceId,
      },
      inspect,
    },
  );

  // Track loading state from persistence machine
  const isLoadingChat = useSelector(persistenceActorRef, (state) => state.context.isLoadingChat);

  // Initialize useChat. The lifecycle (send/regenerate/edit/retry/stop, queue-while-streaming)
  // is owned by `chatPersistenceMachine.requestLifecycle`; the callbacks below just forward
  // events into the machine, which then emits side-effect requests for the listeners installed
  // in the useEffect further down.
  const chat = useChat<MyUIMessage>({
    id: activeChatId,
    transport: new DefaultChatTransport({
      api: `${ENV.TAU_API_URL}/v1/chat`,
      credentials: 'include',
    }),
    generateId: () => generatePrefixedId(idPrefix.message),
    onFinish({ messages, isAbort, isError }) {
      persistenceActorRef.send({ type: 'requestFinished', messages, isAbort, isError });
    },
    onError(error) {
      persistenceActorRef.send({ type: 'handleError', error });
      persistenceActorRef.send({
        type: 'setPersistedError',
        error: parseErrorForPersistence(error),
      });
    },
  });

  // Stable ref so emit listeners always read the latest AI SDK chat instance
  // without requiring the effect to resubscribe on every render.
  const chatRef = useRef<UseChatReturn>(chat);
  chatRef.current = chat;

  // Update refs so actors can access current functions
  setMessagesRef.current = chat.setMessages;
  regenerateRef.current = () => {
    persistenceActorRef.send({ type: 'startRequest', request: { kind: 'regenerate' } });
  };
  initializeDraftRef.current = (loadedChat) => {
    draftActorRef.send({ type: 'initializeFromChat', chat: loadedChat });
  };

  // Subscribe to lifecycle emits from the persistence machine. These run
  // synchronously inside the originating transition, so any persistedError
  // assign in the same transition lands before the AI SDK clears its own
  // chat.error — both layers reset in a single React frame (no flicker).
  useEffect(() => {
    const dispatchSubscription = persistenceActorRef.on('dispatchRequest', ({ request }) => {
      const c = chatRef.current;
      switch (request.kind) {
        case 'send': {
          void c.sendMessage(request.message);
          return;
        }

        case 'regenerate': {
          void c.regenerate();
          return;
        }

        case 'edit': {
          const messageIndex = c.messages.findIndex((m) => m.id === request.messageId);
          if (messageIndex === -1) {
            return;
          }
          const next = [...c.messages.slice(0, messageIndex), buildEditedMessage(request)];
          c.setMessages(next);
          void c.regenerate();
          return;
        }

        case 'retry': {
          const next = buildRetryMessages(c.messages, request);
          if (!next) {
            return;
          }
          c.setMessages(next);
          void c.regenerate();
        }
      }
    });

    const stopSubscription = persistenceActorRef.on('dispatchStop', () => {
      void chatRef.current.stop();
    });

    const finishedSubscription = persistenceActorRef.on('applyFinishedRequest', ({ messages }) => {
      const sanitized = finalizeInterruptedToolParts(messages);
      // Only update messages when sanitization changed something to avoid
      // unnecessary AI SDK state churn on the success path.
      if (sanitized !== messages) {
        chatRef.current.setMessages(sanitized);
      }
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    const stoppedSubscription = persistenceActorRef.on('applyStoppedRequest', ({ messages }) => {
      let sanitized = finalizeInterruptedToolParts(messages);

      // If stopped before any AI response, the last message is the user's
      // pending message. Mark it as cancelled to prevent auto-regeneration
      // on page reload (loadChatActor checks for pending user messages).
      const last = sanitized.at(-1);
      if (last?.role === 'user' && last.metadata?.status === 'pending') {
        sanitized = sanitized.with(-1, {
          ...last,
          metadata: { ...last.metadata, status: 'cancelled' },
        });
      }

      chatRef.current.setMessages(sanitized);
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    const resumedSubscription = persistenceActorRef.on('applyResumedRequest', ({ messages }) => {
      const sanitized = finalizeInterruptedToolParts(messages);
      chatRef.current.setMessages(sanitized);
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    return () => {
      dispatchSubscription.unsubscribe();
      stopSubscription.unsubscribe();
      finishedSubscription.unsubscribe();
      stoppedSubscription.unsubscribe();
      resumedSubscription.unsubscribe();
    };
  }, [persistenceActorRef]);

  // Load chat when activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      return;
    }

    // Tell persistence machine to load chat (actor handles setMessages)
    persistenceActorRef.send({ type: 'setActiveChatId', chatId: activeChatId });

    // Update draft machine with new chat ID
    draftActorRef.send({ type: 'setChatId', chatId: activeChatId });
  }, [activeChatId, persistenceActorRef, draftActorRef]);

  // Queue persistence function for use by actions
  const queuePersist = useCallback(
    (messages: MyUIMessage[]) => {
      if (activeChatId) {
        persistenceActorRef.send({ type: 'queuePersist', messages });
      }
    },
    [activeChatId, persistenceActorRef],
  );

  const chatName = useMemo(
    () => chats.find((c) => c.id === activeChatId)?.name ?? 'Chat Transcript',
    [chats, activeChatId],
  );

  const contextValue = useMemo<ChatContextValue>(
    () => ({
      chat,
      activeChatId,
      resourceId,
      chatName,
      isLoadingChat,
      queuePersist,
      draftActorRef,
      persistenceActorRef,
    }),
    [chat, activeChatId, resourceId, chatName, isLoadingChat, queuePersist, draftActorRef, persistenceActorRef],
  );

  return <ChatContext.Provider value={contextValue}>{children}</ChatContext.Provider>;
}

/**
 * Hook to get the chat context values.
 * Returns activeChatId, isLoadingChat, and other context values.
 */
export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChatContext must be used within a ChatProvider');
  }

  return context;
}

// Combined state type for useChatSelector - the primary way to read chat state
type CombinedChatState = {
  messages: MyUIMessage[];
  messagesById: Map<string, MyUIMessage>;
  messageOrder: string[];
  status: UseChatReturn['status'];
  error: Error | undefined;
  // Persisted error - survives page reload (from chat entity)
  persistedError: ChatError | undefined;
  isLoading: boolean;
  chatName: string;
  // Draft state from machine
  draftText: string;
  draftImages: string[];
  draftToolChoice: string | string[];
  draftMode: ChatMode;
  messageEdits: Record<string, MyUIMessage>;
  activeEditMessageId: string | undefined;
  editDraftText: string;
  editDraftImages: string[];
};

// Cache for messagesById to avoid recreating on every render
const messagesByIdCache = new WeakMap<MyUIMessage[], Map<string, MyUIMessage>>();

function getMessagesById(messages: MyUIMessage[]): Map<string, MyUIMessage> {
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

/**
 * Primary hook for reading chat state.
 * Combines AI SDK useChat state with draft machine state and persistence state.
 */
export function useChatSelector<T>(selector: (state: CombinedChatState) => T): T {
  const { chat, chatName, draftActorRef, persistenceActorRef } = useChatContext();
  const draftContext = useSelector(draftActorRef, (state) => state.context);
  const persistedError = useSelector(persistenceActorRef, (state) => state.context.persistedError);

  // Use cached messagesById based on messages array identity
  const messagesById = getMessagesById(chat.messages);
  const messageOrder = useMemo(() => chat.messages.map((m) => m.id), [chat.messages]);

  // Combine chat state with draft state and persistence state
  const combinedState = useMemo<CombinedChatState>(
    () => ({
      messages: chat.messages,
      messagesById,
      messageOrder,
      status: chat.status,
      error: chat.error,
      persistedError,
      isLoading: chat.status === 'streaming',
      chatName,
      // Draft state
      draftText: draftContext.draftText,
      draftImages: draftContext.draftImages,
      draftToolChoice: draftContext.draftToolChoice,
      draftMode: draftContext.draftMode as ChatMode,
      messageEdits: draftContext.messageEdits,
      activeEditMessageId: draftContext.activeEditMessageId,
      editDraftText: draftContext.editDraftText,
      editDraftImages: draftContext.editDraftImages,
    }),
    [chat.messages, messagesById, messageOrder, chat.status, chat.error, persistedError, chatName, draftContext],
  );

  return selector(combinedState);
}

// Hook for chat actions
export function useChatActions(): {
  sendMessage: (message: SendMessageInput) => void;
  regenerate: () => void;
  stop: () => void;
  setMessages: (messages: MyUIMessage[]) => void;
  setDraftText: (text: string) => void;
  addDraftImage: (image: string) => void;
  removeDraftImage: (index: number) => void;
  setDraftToolChoice: (toolChoice: string | string[]) => void;
  setDraftMode: (mode: string) => void;
  clearDraft: () => void;
  startEditingMessage: (messageId: string) => void;
  exitEditMode: () => void;
  setEditDraftText: (text: string) => void;
  addEditDraftImage: (image: string) => void;
  removeEditDraftImage: (index: number) => void;
  clearMessageEdit: (messageId: string) => void;
  // oxlint-disable-next-line max-params -- callback signature shared across chat components; refactoring would require updating many call sites
  editMessage: (messageId: string, content: string, model: string, metadata?: unknown, imageUrls?: string[]) => void;
  retryMessage: (messageId: string, modelId?: string) => void;
} {
  const { chat, draftActorRef, persistenceActorRef } = useChatContext();

  return useMemo(
    () => ({
      // Lifecycle actions: thin event forwarders. The persistence machine's
      // requestLifecycle owns clear-error / queue-while-streaming / interrupt
      // semantics — see chat-persistence.machine.ts.
      sendMessage(message: SendMessageInput) {
        draftActorRef.send({ type: 'clearDraft' });
        // The 'send' kind requires a full MyUIMessage. All in-app callers pass
        // a full message (chat-textarea constructs one via createMessage); the
        // text/files convenience union is not exercised internally.
        persistenceActorRef.send({
          type: 'startRequest',
          // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- AI SDK sendMessage union narrows to MyUIMessage at all call sites
          request: { kind: 'send', message: message as MyUIMessage },
        });
      },
      regenerate() {
        persistenceActorRef.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      },
      stop() {
        persistenceActorRef.send({ type: 'stopRequest' });
      },
      setMessages(messages: MyUIMessage[]) {
        chat.setMessages(messages);
      },

      // Draft actions (via XState)
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
        draftActorRef.send({
          type: 'setDraftMode',
          mode: mode as 'agent' | 'plan',
        });
      },
      clearDraft() {
        draftActorRef.send({ type: 'clearDraft' });
      },

      // Edit actions (via XState)
      startEditingMessage(messageId: string) {
        const originalMessage = chat.messages.find((m) => m.id === messageId);
        draftActorRef.send({
          type: 'startEditingMessage',
          messageId,
          originalMessage,
        });
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
        // Validate before transitioning — avoids leaving requestLifecycle in a
        // partially-driven state if the message is gone.
        if (!chat.messages.some((m) => m.id === messageId)) {
          return;
        }
        persistenceActorRef.send({
          type: 'startRequest',
          request: { kind: 'edit', messageId, content, model, imageUrls },
        });
      },

      retryMessage(messageId: string, modelId?: string) {
        if (!chat.messages.some((m) => m.id === messageId)) {
          return;
        }
        persistenceActorRef.send({
          type: 'startRequest',
          request: { kind: 'retry', messageId, modelId },
        });
      },
    }),
    [chat, draftActorRef, persistenceActorRef],
  );
}
