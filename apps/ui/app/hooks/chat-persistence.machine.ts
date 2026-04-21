/**
 * Chat Persistence Machine
 *
 * XState machine for managing chat persistence with debouncing.
 * Uses event-driven persistence triggered by onFinish callbacks from useChat.
 *
 * Actors are provided via machine.provide() in the consumer (use-chat.tsx)
 * following the pattern from use-project.tsx.
 */

import { setup, assign, emit } from 'xstate';
import type { Chat, MyUIMessage } from '@taucad/chat';
import type { ChatError } from '@taucad/types';
import type { KernelId } from '@taucad/types/constants';
import { fromSafeAsync } from '#lib/xstate.lib.js';

// Input types
export type ChatPersistenceMachineInput = {
  activeChatId?: string;
  resourceId?: string;
};

/**
 * A chat request kicked off by the UI. Routed through the requestLifecycle
 * sub-machine so every entry point clears persistedError synchronously.
 *
 * - `send`: brand-new user message
 * - `regenerate`: re-roll the last assistant turn with the existing message tail
 * - `edit`: replace a user message and regenerate from there
 * - `retry`: roll back to a prior user message (optionally re-targeting a model) and regenerate
 */
export type ChatRequest =
  | { kind: 'send'; message: MyUIMessage }
  | { kind: 'regenerate' }
  | { kind: 'edit'; messageId: string; content: string; model: string; imageUrls?: string[] }
  | { kind: 'retry'; messageId: string; modelId?: string };

// Context
export type ChatPersistenceMachineContext = {
  activeChatId?: string;
  resourceId?: string;
  // Loading state
  isLoadingChat: boolean;
  loadError?: Error;
  // Pending messages to persist (set by queuePersist, consumed by debounced persist)
  pendingMessages?: MyUIMessage[];
  /**
   * Snapshot of `activeChatId` captured at `queuePersist` time. The debounced
   * `persistMessagesActor` reads this — never `activeChatId` directly — so a
   * mid-pending `setActiveChatId` swap (focus flipping between chats inside
   * the 100 ms debounce window) cannot mis-target the write at the new chat.
   */
  pendingChatId?: string;
  // Persisted error - survives page reload
  persistedError?: ChatError;
  // Request queued while a previous request is being stopped; consumed on requestFinished
  pendingRequest?: ChatRequest;
  /**
   * Chat-scoped active model id. Hydrated from the loaded `Chat.activeModel`
   * row and updated by `setActiveModel`. Mirrors the chat row so consumers
   * can read the chat-local choice off the persistence machine snapshot
   * without an extra storage read per render.
   */
  activeModel?: string;
  /**
   * Chat-scoped active CAD kernel. Same hydration + propagation semantics
   * as {@link ChatPersistenceMachineContext.activeModel}.
   */
  activeKernel?: KernelId;
};

export type ChatRetrievedEvent = { type: 'chatRetrieved'; chat: Chat | undefined };

// Events
type ChatPersistenceMachineEvents =
  | { type: 'setActiveChatId'; chatId: string }
  | { type: 'queuePersist'; messages: MyUIMessage[] }
  | { type: 'handleError'; error: Error }
  | { type: 'setPersistedError'; error: ChatError }
  | { type: 'clearPersistedError' }
  // Flush pending state immediately (bypasses debounce, used on tab close)
  | { type: 'flushNow' }
  // Request lifecycle
  | { type: 'startRequest'; request: ChatRequest }
  | { type: 'stopRequest' }
  | { type: 'requestFinished'; messages: MyUIMessage[]; isAbort: boolean; isError: boolean }
  // Active selection (chat-scoped model / kernel)
  | { type: 'setActiveModel'; model: string | undefined }
  | { type: 'setActiveKernel'; kernel: KernelId | undefined }
  | ChatRetrievedEvent;

/**
 * Events emitted by the machine for the React shell (`<ChatInstance>`) to
 * translate into AI SDK side effects via `actor.on(...)` subscriptions.
 *
 * These run synchronously inside the originating transition, so any
 * `assign({ persistedError: undefined })` in the same transition lands
 * before the listener calls `chat.sendMessage`/`regenerate` and the AI
 * SDK clears its own `chat.error` — both error layers reset in a single
 * React frame, eliminating the stale-banner flicker.
 */
type ChatPersistenceMachineEmitted =
  | { type: 'dispatchRequest'; request: ChatRequest }
  | { type: 'dispatchStop' }
  | { type: 'applyFinishedRequest'; messages: MyUIMessage[] }
  | { type: 'applyStoppedRequest'; messages: MyUIMessage[] }
  | { type: 'applyResumedRequest'; messages: MyUIMessage[]; pendingRequest: ChatRequest };

const loadChatActor = fromSafeAsync<ChatRetrievedEvent, { chatId: string }>(async () => {
  throw new Error('loadChatActor not provided');
});

const persistMessagesActor = fromSafeAsync<void, { chatId: string; messages: MyUIMessage[] }>(async () => {
  throw new Error('persistMessagesActor not provided');
});

const persistErrorActor = fromSafeAsync<void, { chatId: string; error: ChatError }>(async () => {
  throw new Error('persistErrorActor not provided');
});

const clearErrorActor = fromSafeAsync<void, { chatId: string }>(async () => {
  throw new Error('clearErrorActor not provided');
});

const persistActiveModelActor = fromSafeAsync<void, { chatId: string; activeModel: string | undefined }>(async () => {
  throw new Error('persistActiveModelActor not provided');
});

const persistActiveKernelActor = fromSafeAsync<void, { chatId: string; activeKernel: KernelId | undefined }>(
  async () => {
    throw new Error('persistActiveKernelActor not provided');
  },
);

export const chatPersistenceMachine = setup({
  types: {
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate types
    context: {} as ChatPersistenceMachineContext,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate types
    events: {} as ChatPersistenceMachineEvents,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate types
    emitted: {} as ChatPersistenceMachineEmitted,
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- xstate types
    input: {} as ChatPersistenceMachineInput,
  },
  actors: {
    loadChatActor,
    persistMessagesActor,
    persistErrorActor,
    clearErrorActor,
    persistActiveModelActor,
    persistActiveKernelActor,
  },
  guards: {
    hasValidChatId({ context, event }) {
      // Check event.chatId for setActiveChatId event, otherwise check context
      const chatId = 'chatId' in event ? event.chatId : context.activeChatId;

      return Boolean(chatId?.startsWith('chat_'));
    },
    hasPendingMessages: ({ context }) =>
      Boolean(context.pendingMessages && context.pendingMessages.length > 0 && context.pendingChatId),
    /**
     * Allow `queuePersist` whenever a chat is selected — even while loading.
     * The actual write is gated separately so a brand-new chat that's still
     * hydrating can buffer the user's first message instead of swallowing it.
     */
    canQueuePersist({ context, event }) {
      const chatId = 'chatId' in event ? event.chatId : context.activeChatId;
      return Boolean(chatId?.startsWith('chat_'));
    },
    canPersist({ context, event }) {
      // Can persist if: not loading AND has valid chatId
      const chatId = 'chatId' in event ? event.chatId : context.activeChatId;

      return !context.isLoadingChat && Boolean(chatId?.startsWith('chat_'));
    },
  },
  delays: {
    persistDebounce: 100,
  },
}).createMachine({
  id: 'chatPersistence',
  context({ input }) {
    return {
      activeChatId: input.activeChatId,
      resourceId: input.resourceId,
      isLoadingChat: false,
      loadError: undefined,
      pendingMessages: undefined,
      pendingChatId: undefined,
      persistedError: undefined,
      pendingRequest: undefined,
      activeModel: undefined,
      activeKernel: undefined,
    };
  },
  type: 'parallel',
  states: {
    // Chat loading state
    chatLoading: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            setActiveChatId: {
              target: 'loading',
              guard: 'hasValidChatId',
              actions: assign({
                activeChatId: ({ event }) => event.chatId,
                isLoadingChat: true,
                loadError: undefined,
              }),
            },
          },
        },
        loading: {
          invoke: {
            src: 'loadChatActor',
            input: ({ context }) => ({
              chatId: context.activeChatId!,
            }),
            onDone: {
              target: 'idle',
              actions: assign({
                isLoadingChat: false,
              }),
            },
            onError: {
              target: 'idle',
              actions: assign({
                isLoadingChat: false,
                loadError: ({ event }) => event.error as Error,
              }),
            },
          },
          on: {
            chatRetrieved: {
              actions: assign({
                persistedError: ({ event }) => event.chat?.error,
                activeModel: ({ event }) => event.chat?.activeModel,
                activeKernel: ({ event }) => event.chat?.activeKernel,
              }),
            },
            setActiveChatId: {
              target: 'loading',
              reenter: true,
              actions: assign({
                activeChatId: ({ event }) => event.chatId,
                loadError: undefined,
              }),
            },
          },
        },
      },
    },
    // Message persistence with debouncing
    messagePersistence: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            queuePersist: {
              target: 'pending',
              guard: 'canQueuePersist',
              actions: assign({
                pendingMessages: ({ event }) => event.messages,
                pendingChatId: ({ context }) => context.activeChatId,
              }),
            },
          },
        },
        pending: {
          after: {
            persistDebounce: {
              target: 'persisting',
              guard: 'hasPendingMessages',
            },
          },
          on: {
            // Reset timer if new messages come in
            queuePersist: {
              target: 'pending',
              reenter: true,
              actions: assign({
                pendingMessages: ({ event }) => event.messages,
                pendingChatId: ({ context }) => context.activeChatId,
              }),
            },
            // Immediately bypass debounce and persist
            flushNow: {
              target: 'persisting',
              guard: 'hasPendingMessages',
            },
          },
        },
        persisting: {
          invoke: {
            src: 'persistMessagesActor',
            // Read the chatId snapshot, NOT context.activeChatId — the user
            // may have flipped focus to a different chat inside the debounce
            // window and we must still write to the chat the messages were
            // queued for.
            input: ({ context }) => ({
              chatId: context.pendingChatId!,
              messages: context.pendingMessages!,
            }),
            onDone: {
              target: 'idle',
              actions: assign({
                pendingMessages: undefined,
                pendingChatId: undefined,
              }),
            },
            onError: {
              target: 'idle',
              actions: assign({
                pendingMessages: undefined,
                pendingChatId: undefined,
              }),
            },
          },
          on: {
            // Queue new messages while persisting
            queuePersist: {
              actions: assign({
                pendingMessages: ({ event }) => event.messages,
                pendingChatId: ({ context }) => context.activeChatId,
              }),
            },
          },
        },
      },
    },
    // Chat request lifecycle - centralizes send/regenerate/edit/retry/stop so
    // every "request starts" path clears persistedError synchronously, eliminating
    // the stale error banner flicker. Side effects flow out via emits to the
    // ChatInstance listeners (which drive the AI SDK calls).
    requestLifecycle: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            startRequest: {
              target: 'invoking',
              actions: [
                assign({ persistedError: undefined }),
                emit(({ event }) => ({ type: 'dispatchRequest', request: event.request })),
              ],
            },
          },
        },
        invoking: {
          on: {
            // A new request while one is in flight: queue it, stop the in-flight one,
            // and resume the queued one in `requestFinished`.
            startRequest: {
              target: 'stopping',
              actions: [
                assign({
                  persistedError: undefined,
                  pendingRequest: ({ event }) => event.request,
                }),
                emit({ type: 'dispatchStop' }),
              ],
            },
            stopRequest: {
              target: 'stopping',
              actions: emit({ type: 'dispatchStop' }),
            },
            requestFinished: {
              target: 'idle',
              actions: [
                // Mid-stream errors keep persistedError (set by onError) visible.
                // Success/abort clear it as a safety net for any stale state.
                assign({
                  persistedError: ({ context, event }) => (event.isError ? context.persistedError : undefined),
                }),
                emit(({ event }) => ({ type: 'applyFinishedRequest', messages: event.messages })),
              ],
            },
          },
        },
        stopping: {
          on: {
            // Allow the queued request to be replaced by a newer tap before the
            // stop completes. The newest pendingRequest wins.
            startRequest: {
              actions: assign({
                persistedError: undefined,
                pendingRequest: ({ event }) => event.request,
              }),
            },
            requestFinished: [
              {
                guard: ({ context }) => context.pendingRequest !== undefined,
                target: 'invoking',
                actions: [
                  emit(({ context, event }) => ({
                    type: 'applyResumedRequest',
                    messages: event.messages,
                    pendingRequest: context.pendingRequest!,
                  })),
                  emit(({ context }) => ({
                    type: 'dispatchRequest',
                    request: context.pendingRequest!,
                  })),
                  assign({ pendingRequest: undefined }),
                ],
              },
              {
                target: 'idle',
                actions: emit(({ event }) => ({
                  type: 'applyStoppedRequest',
                  messages: event.messages,
                })),
              },
            ],
          },
        },
      },
    },
    // Active model persistence — chat-scoped active model.
    // Mirrors errorPersistence: idle → persisting → idle, where the second
    // `setActiveModel` while persisting re-enters so the latest value wins.
    activeModelPersistence: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            setActiveModel: {
              target: 'persisting',
              guard: 'hasValidChatId',
              actions: assign({
                activeModel: ({ event }) => event.model,
              }),
            },
          },
        },
        persisting: {
          invoke: {
            src: 'persistActiveModelActor',
            input: ({ context }) => ({
              chatId: context.activeChatId!,
              activeModel: context.activeModel,
            }),
            onDone: { target: 'idle' },
            onError: { target: 'idle' },
          },
          on: {
            setActiveModel: {
              target: 'persisting',
              reenter: true,
              guard: 'hasValidChatId',
              actions: assign({
                activeModel: ({ event }) => event.model,
              }),
            },
          },
        },
      },
    },
    // Active kernel persistence — chat-scoped active CAD kernel. Same shape
    // as activeModelPersistence.
    activeKernelPersistence: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            setActiveKernel: {
              target: 'persisting',
              guard: 'hasValidChatId',
              actions: assign({
                activeKernel: ({ event }) => event.kernel,
              }),
            },
          },
        },
        persisting: {
          invoke: {
            src: 'persistActiveKernelActor',
            input: ({ context }) => ({
              chatId: context.activeChatId!,
              activeKernel: context.activeKernel,
            }),
            onDone: { target: 'idle' },
            onError: { target: 'idle' },
          },
          on: {
            setActiveKernel: {
              target: 'persisting',
              reenter: true,
              guard: 'hasValidChatId',
              actions: assign({
                activeKernel: ({ event }) => event.kernel,
              }),
            },
          },
        },
      },
    },
    // Error persistence - persists errors to storage for display after page reload
    errorPersistence: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            setPersistedError: {
              target: 'persisting',
              guard: 'canPersist',
              actions: assign({
                persistedError: ({ event }) => event.error,
              }),
            },
            clearPersistedError: {
              target: 'clearing',
              guard: 'canPersist',
              actions: assign({
                persistedError: undefined,
              }),
            },
          },
        },
        persisting: {
          invoke: {
            src: 'persistErrorActor',
            input: ({ context }) => ({
              chatId: context.activeChatId!,
              error: context.persistedError!,
            }),
            onDone: {
              target: 'idle',
            },
            onError: {
              target: 'idle',
            },
          },
          on: {
            // If a new error comes in while persisting, update context and restart
            setPersistedError: {
              target: 'persisting',
              reenter: true,
              actions: assign({
                persistedError: ({ event }) => event.error,
              }),
            },
            // If clearing is requested while persisting, switch to clearing
            clearPersistedError: {
              target: 'clearing',
              actions: assign({
                persistedError: undefined,
              }),
            },
          },
        },
        clearing: {
          invoke: {
            src: 'clearErrorActor',
            input: ({ context }) => ({
              chatId: context.activeChatId!,
            }),
            onDone: {
              target: 'idle',
              actions: assign({
                persistedError: undefined,
              }),
            },
            onError: {
              target: 'idle',
              actions: assign({
                persistedError: undefined,
              }),
            },
          },
          on: {
            // If a new error comes in while clearing, switch to persisting
            setPersistedError: {
              target: 'persisting',
              actions: assign({
                persistedError: ({ event }) => event.error,
              }),
            },
          },
        },
      },
    },
  },
  on: {
    handleError: {
      actions({ event }) {
        console.error('Chat persistence error:', event.error);
      },
    },
  },
});

export type ChatPersistenceMachineState = ReturnType<typeof chatPersistenceMachine.getInitialSnapshot>;
export type ChatPersistenceMachineActor = typeof chatPersistenceMachine;
