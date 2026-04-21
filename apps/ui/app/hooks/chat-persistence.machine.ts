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
  // Persisted error - survives page reload
  persistedError?: ChatError;
  // Request queued while a previous request is being stopped; consumed on requestFinished
  pendingRequest?: ChatRequest;
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
  | ChatRetrievedEvent;

/**
 * Events emitted by the machine for the React shell (`ChatProvider`) to
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
  },
  guards: {
    hasValidChatId({ context, event }) {
      // Check event.chatId for setActiveChatId event, otherwise check context
      const chatId = 'chatId' in event ? event.chatId : context.activeChatId;

      return Boolean(chatId?.startsWith('chat_'));
    },
    hasPendingMessages: ({ context }) => Boolean(context.pendingMessages && context.pendingMessages.length >= 0),
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
      persistedError: undefined,
      pendingRequest: undefined,
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
              guard: 'canPersist',
              actions: assign({
                pendingMessages: ({ event }) => event.messages,
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
            input: ({ context }) => ({
              chatId: context.activeChatId!,
              messages: context.pendingMessages!,
            }),
            onDone: {
              target: 'idle',
              actions: assign({
                pendingMessages: undefined,
              }),
            },
            onError: {
              target: 'idle',
              actions: assign({
                pendingMessages: undefined,
              }),
            },
          },
          on: {
            // Queue new messages while persisting
            queuePersist: {
              actions: assign({
                pendingMessages: ({ event }) => event.messages,
              }),
            },
          },
        },
      },
    },
    // Chat request lifecycle - centralizes send/regenerate/edit/retry/stop so
    // every "request starts" path clears persistedError synchronously, eliminating
    // the stale error banner flicker. Side effects flow out via emits to the
    // ChatProvider listeners (which drive the AI SDK calls).
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
