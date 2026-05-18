/**
 * ChatSessionStore
 *
 * Vanilla, reference-counted store that owns the long-lived per-chat objects:
 * the AI SDK `Chat` instance, the `chatPersistenceMachine` actor, and the
 * `draftMachine` actor. React components subscribe but never own — every
 * lifetime survives subtree unmount/remount cycles, eliminating the class of
 * "headless component reuse" races that plagued the prior `<ChatInstance>`
 * design (load wipes in-flight messages, persist dropped while loading,
 * draft `setChatId` lost across an async hop, draft state leaking across
 * chats, cross-chat persist mis-targeting).
 *
 * Reference counting:
 * - `acquire(chatId)` lazily creates the session on first call and bumps a
 *   refcount on every subsequent call.
 * - `release(chatId)` decrements; the session stops both XState actors at
 *   refcount zero and is GC'd along with its `Chat` instance.
 *
 * Subscriptions:
 * - `subscribeMembership` wakes on first acquire / final release per chatId.
 * - `subscribeChat(chatId, listener)` wakes on the underlying `Chat`'s
 *   messages/status/error callbacks (mirrored via the `~register*Callback`
 *   APIs) — scoped per chatId so a token streaming into chat A never wakes
 *   subscribers bound to chat B.
 *
 * Dependencies (`setDependencies`) are mirrored on every render of the
 * provider so the store always invokes the latest closures from
 * `useProjectManager()` (mirrors the `useProjectManager` ref pattern used
 * by `useChatRpcConnection`).
 */

import type { Chat } from '@ai-sdk/react';
import type { ChatStatus } from 'ai';
import { createActor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { Chat as ChatEntity, MyUIMessage } from '@taucad/chat';
import { isToolPart } from '@taucad/chat';
import { fromSafeAsync } from '#lib/xstate.lib.js';
import { chatPersistenceMachine } from '#hooks/chat-persistence.machine.js';
import type { ChatRequest } from '#hooks/chat-persistence.machine.js';
import { draftMachine } from '#hooks/draft.machine.js';
import { resizeImageActor } from '#hooks/resize-image.actor.js';
import { inspect } from '#machines/inspector.js';
import { clearLedger } from '#services/rpc-ledger.js';
import { parseErrorForPersistence } from '#utils/error.utils.js';
import { extractMimeTypeFromDataUrl, finalizeInterruptedToolParts } from '#utils/chat.utils.js';
import { createChatInstance } from '#chat-clients/_internal/shared-chat-transport.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Closures the store needs from the project manager. Stored in a single
 * object so `setDependencies` is one atomic swap (no torn reads if a render
 * mid-acquire updates one closure at a time).
 */
export type ChatSessionDeps = {
  getChat: (chatId: string) => Promise<ChatEntity | undefined>;
  patchChat: <K extends keyof ChatEntity>(
    chatId: string,
    key: K,
    value: ChatEntity[K],
  ) => Promise<ChatEntity | undefined>;
  setMessageEdit: (chatId: string, messageId: string, draft: MyUIMessage) => Promise<ChatEntity | undefined>;
  clearMessageEdit: (chatId: string, messageId: string) => Promise<ChatEntity | undefined>;
};

/** Snapshot of the latest aggregated cost for a chat (derived from `data-usage` parts). */
export type UsageSnapshot = {
  totalCost: number;
  /** Wall-clock millis when the snapshot was last updated. */
  lastUpdatedAt: number;
};

export type ChatSession = {
  readonly chatId: string;
  readonly chat: Chat<MyUIMessage>;
  readonly persistenceActorRef: ActorRefFrom<typeof chatPersistenceMachine>;
  readonly draftActorRef: ActorRefFrom<typeof draftMachine>;
};

// ---------------------------------------------------------------------------
// Module-scoped singletons / helpers
// ---------------------------------------------------------------------------

/**
 * Rebuilds the user message currently being edited. Resets only the
 * user-facing fields — text/image parts, `createdAt`, and `status` — and
 * spreads the original message's metadata through untouched. Per-turn
 * agent config travels via `body.agent` on the wire (composed by the
 * chat-client from `useCadAgentConfig`), never via per-message metadata.
 */
function buildEditedMessage(original: MyUIMessage, request: Extract<ChatRequest, { kind: 'edit' }>): MyUIMessage {
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
      ...original.metadata,
      createdAt: Date.now(),
      status: 'pending',
    },
  };
}

/**
 * Slices the message tail so a subsequent `chat.regenerate(...)` re-runs
 * the assistant turn after the retried message. Model overrides (e.g. "Try
 * with a different model") travel via `request.body.agent.model` composed
 * by `useCadChatClient.retry`, not by mutating persisted metadata.
 */
function buildRetryMessages(
  messages: MyUIMessage[],
  request: Extract<ChatRequest, { kind: 'retry' }>,
): MyUIMessage[] | undefined {
  const messageIndex = messages.findIndex((m) => m.id === request.messageId);
  if (messageIndex === -1) {
    return undefined;
  }
  return messages.slice(0, messageIndex);
}

function aggregateUsageCost(messages: readonly MyUIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'data-usage') {
        total += part.data.totalCost;
      }
    }
  }
  return total;
}

function countPersistMilestones(message: MyUIMessage): number {
  let count = 0;
  for (const part of message.parts) {
    if (isToolPart(part) && (part.state === 'output-available' || part.state === 'output-error')) {
      count += 1;
      continue;
    }

    if (part.type === 'text' && 'state' in part && part.state === 'done') {
      count += 1;
      continue;
    }

    if (part.type === 'reasoning' && 'state' in part && part.state === 'done') {
      count += 1;
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// ChatSessionStore
// ---------------------------------------------------------------------------

type InternalSession = ChatSession & {
  refcount: number;
  status: ChatStatus;
  usage: UsageSnapshot | undefined;
  /**
   * Latest per-request body the active profile-scoped chat client has
   * computed for this chat. Populated via {@link ChatSessionStore.setLatestAgentBody}
   * from `useCadChatClient` on every render. The `dispatchRequest` listener
   * falls back to this body when a request enters the persistence machine
   * without an explicit `body` (currently the only such path is the
   * hydration auto-regenerate on pending-tail in `loadChatActor`).
   */
  latestAgentBody: Readonly<Record<string, unknown>> | undefined;
  /** Cleanups for the per-chat subscriptions wired up at session creation. */
  dispose: () => void;
};

export class ChatSessionStore {
  readonly #sessions = new Map<string, InternalSession>();
  readonly #membershipListeners = new Set<() => void>();
  readonly #chatListeners = new Map<string, Set<() => void>>();
  readonly #statusListeners = new Map<string, Set<() => void>>();
  readonly #usageListeners = new Map<string, Set<() => void>>();
  #snapshot: readonly string[] = [];
  /**
   * Coalesces membership notifications onto a microtask so an `acquire`/
   * `release` triggered during another component's render (e.g. the React
   * `useChatSession` lazy initializer) never schedules a `setState` on a
   * concurrently-rendering subscriber. Without this, `<ProjectChatRpcBindings>`'s
   * `useSyncExternalStore` would wake mid-render of `<SessionBackedActiveChatProvider>`
   * and React would log the "Cannot update a component while rendering a
   * different component" warning. Snapshot mutation stays synchronous so
   * `getSnapshot` callers always observe the latest membership.
   */
  #membershipNotifyScheduled = false;
  // Default deps throw — `setDependencies` must be called before any acquire.
  // Stored as a single object so swaps are atomic (no torn reads).
  #deps: ChatSessionDeps = {
    async getChat() {
      throw new Error('ChatSessionStore: getChat not provided');
    },
    async patchChat() {
      throw new Error('ChatSessionStore: patchChat not provided');
    },
    async setMessageEdit() {
      throw new Error('ChatSessionStore: setMessageEdit not provided');
    },
    async clearMessageEdit() {
      throw new Error('ChatSessionStore: clearMessageEdit not provided');
    },
  };

  /**
   * Update the closures the store invokes on behalf of every session. Safe to
   * call on every render — closures are read through `this.#deps` at call
   * time, so swapping never tears in-flight work.
   */
  public setDependencies(deps: ChatSessionDeps): void {
    this.#deps = deps;
  }

  public acquire(chatId: string): ChatSession {
    const existing = this.#sessions.get(chatId);
    if (existing) {
      existing.refcount += 1;
      return existing;
    }

    const session = this.#createSession(chatId);
    this.#sessions.set(chatId, session);
    this.#refreshSnapshot();
    this.#notifyMembership();
    return session;
  }

  public release(chatId: string): void {
    const session = this.#sessions.get(chatId);
    if (!session) {
      return;
    }
    session.refcount -= 1;
    if (session.refcount > 0) {
      return;
    }

    session.dispose();
    session.persistenceActorRef.stop();
    session.draftActorRef.stop();
    this.#sessions.delete(chatId);
    clearLedger(chatId);
    this.#refreshSnapshot();
    this.#notifyMembership();
  }

  public get(chatId: string): ChatSession | undefined {
    return this.#sessions.get(chatId);
  }

  public list(): readonly string[] {
    return this.#snapshot;
  }

  public subscribeMembership(listener: () => void): () => void {
    this.#membershipListeners.add(listener);
    return () => {
      this.#membershipListeners.delete(listener);
    };
  }

  public subscribeChat(chatId: string, listener: () => void): () => void {
    return this.#addPerChatListener(this.#chatListeners, chatId, listener);
  }

  public getStatus(chatId: string): ChatStatus | undefined {
    return this.#sessions.get(chatId)?.status;
  }

  public subscribeStatus(chatId: string, listener: () => void): () => void {
    return this.#addPerChatListener(this.#statusListeners, chatId, listener);
  }

  public getUsage(chatId: string): UsageSnapshot | undefined {
    return this.#sessions.get(chatId)?.usage;
  }

  public subscribeUsage(chatId: string, listener: () => void): () => void {
    return this.#addPerChatListener(this.#usageListeners, chatId, listener);
  }

  /**
   * Publish the latest per-request body the active profile-scoped chat
   * client (`useCadChatClient` today, future name/commit clients tomorrow)
   * has composed for this chat. The `dispatchRequest` listener inside
   * `#createSession` falls back to this when a request hits the persistence
   * machine without an explicit `body` (the only such path today is the
   * hydration-driven auto-regenerate on a pending-tail user message — see
   * `loadChatActor` in `#createSession`).
   *
   * Stored as a snapshot, not subscribed to, because the listener only
   * needs a single read at dispatch time.
   */
  public setLatestAgentBody(chatId: string, body: Readonly<Record<string, unknown>> | undefined): void {
    const session = this.#sessions.get(chatId);
    if (!session) {
      return;
    }
    session.latestAgentBody = body;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #createSession(chatId: string): InternalSession {
    // Defensive aliases so closures bound to the AI SDK's internal scheduler
    // always read through `this.#deps` (the latest provider snapshot).
    const depsRef = (): ChatSessionDeps => this.#deps;

    const persistenceActorRef = createActor(
      chatPersistenceMachine.provide({
        actors: {
          loadChatActor: fromSafeAsync(async ({ input }) => {
            const loadedChat = await depsRef().getChat(input.chatId);

            if (loadedChat) {
              // Defensive guard: only seed messages from the loaded chat when
              // the live `Chat` instance has not started accumulating its own
              // (a brand-new chat that's already in-flight). Prevents the
              // classic "load wipes in-flight messages" race.
              if (session.chat.messages.length === 0) {
                session.chat.messages = loadedChat.messages;
              }

              session.draftActorRef.send({ type: 'initializeFromChat', chat: loadedChat });

              const lastMessage = session.chat.messages.at(-1);
              if (lastMessage?.role === 'user' && lastMessage.metadata?.status === 'pending') {
                persistenceActorRef.send({
                  type: 'startRequest',
                  request: { kind: 'regenerate' },
                });

                return { type: 'chatRetrieved', chat: { ...loadedChat, error: undefined } };
              }
            } else if (session.chat.messages.length === 0) {
              session.chat.messages = [];
            }

            return { type: 'chatRetrieved', chat: loadedChat };
          }),
          persistMessagesActor: fromSafeAsync(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'messages', input.messages);
          }),
          persistErrorActor: fromSafeAsync(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'error', input.error);
          }),
          clearErrorActor: fromSafeAsync(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'error', undefined);
          }),
          persistActiveModelActor: fromSafeAsync(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'activeModel', input.activeModel);
          }),
          persistActiveKernelActor: fromSafeAsync(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'activeKernel', input.activeKernel);
          }),
        },
      }),
      {
        input: {
          activeChatId: chatId,
          resourceId: undefined,
        },
        inspect,
      },
    );

    const draftActorRef = createActor(
      draftMachine.provide({
        actors: {
          persistDraftActor: fromSafeAsync<void, { chatId: string; draft: MyUIMessage }>(async ({ input }) => {
            await depsRef().patchChat(input.chatId, 'draft', input.draft);
          }),
          persistEditDraftActor: fromSafeAsync<void, { chatId: string; messageId: string; draft: MyUIMessage }>(
            async ({ input }) => {
              await depsRef().setMessageEdit(input.chatId, input.messageId, input.draft);
            },
          ),
          clearMessageEditActor: fromSafeAsync<void, { chatId: string; messageId: string }>(async ({ input }) => {
            await depsRef().clearMessageEdit(input.chatId, input.messageId);
          }),
          resizeImageActor,
        },
      }),
      {
        input: { chatId },
        inspect,
      },
    );

    const chat = createChatInstance({
      chatId,
      onFinish({ messages, isAbort, isError, isDisconnect }) {
        persistenceActorRef.send({ type: 'requestFinished', messages, isAbort, isError, isDisconnect });
      },
      onError(error) {
        persistenceActorRef.send({ type: 'handleError', error });
        persistenceActorRef.send({
          type: 'setPersistedError',
          error: parseErrorForPersistence(error),
        });
      },
    });

    const milestonePersistState = {
      lastPersistedMilestoneIndex: -1,
      lastPersistedMilestonePartCount: 0,
    };

    const resetMilestonePersistTracking = (): void => {
      milestonePersistState.lastPersistedMilestoneIndex = -1;
      milestonePersistState.lastPersistedMilestonePartCount = 0;
    };

    // Translate persistence-actor emits into AI SDK side effects on the
    // store-owned `Chat`. Identical wiring to the prior `<ChatInstance>` —
    // moved outside React so the listeners outlive any subtree mount cycle.
    //
    // The listener body is deferred onto a microtask so that
    // `chat.sendMessage` / `chat.regenerate` / `chatShim.makeRequest` never
    // run nested inside another `Chat.makeRequest`'s `finally` block. AI SDK
    // v6's `makeRequest` clobbers `this.activeResponse = void 0` AFTER its
    // `onFinish` callback returns; a synchronous re-entry from `onFinish` →
    // `requestFinished` → `stopping → invoking` → emit `dispatchRequest`
    // would let the new `makeRequest` assign `this.activeResponse =
    // activeResponse_B` only to have the outer finally null it back out.
    // The new `makeRequest`'s own finally would then access
    // `this.activeResponse.state.message` (no optional chaining in ai@6.0.175)
    // and throw a TypeError that the surrounding try/catch swallows,
    // suppressing `onFinish` and stranding the persistence machine in
    // `invoking`. See docs/research/chat-followup-message-swallow.md.
    //
    // The microtask deferral is strictly local to this listener: the
    // sibling `applyResumedRequest` listener still runs synchronously so
    // its `chat.messages = sanitized` mutation is observable to the deferred
    // `chat.sendMessage(B)` call when it fires on the next tick.
    const dispatchSubscription = persistenceActorRef.on('dispatchRequest', ({ request }) => {
      queueMicrotask(() => {
        // The chat-client always supplies `request.body` when it dispatches
        // (submit / retry / regenerateTail / stop). The hydration auto-regen
        // on pending-tail (see `loadChatActor`) is the one path that fires
        // a request through the persistence machine *before* the chat-client
        // has had a chance to attach a body — fall back to the latest body
        // the chat-client published via `setLatestAgentBody` so the API
        // still receives a complete `agent` payload on first turn.
        const requestBody = request.body ?? session.latestAgentBody;
        switch (request.kind) {
          case 'send': {
            if (requestBody) {
              void chat.sendMessage(request.message, { body: requestBody });
            } else {
              void chat.sendMessage(request.message);
            }
            return;
          }

          case 'regenerate': {
            if (requestBody) {
              void chat.regenerate({ body: requestBody });
            } else {
              void chat.regenerate();
            }
            return;
          }

          case 'edit': {
            const messageIndex = chat.messages.findIndex((m) => m.id === request.messageId);
            if (messageIndex === -1) {
              return;
            }
            const originalMessage = chat.messages[messageIndex]!;
            chat.messages = [...chat.messages.slice(0, messageIndex), buildEditedMessage(originalMessage, request)];
            if (requestBody) {
              void chat.regenerate({ body: requestBody });
            } else {
              void chat.regenerate();
            }
            return;
          }

          case 'retry': {
            const next = buildRetryMessages(chat.messages, request);
            if (!next) {
              return;
            }
            chat.messages = next;
            if (requestBody) {
              void chat.regenerate({ body: requestBody });
            } else {
              void chat.regenerate();
            }
            return;
          }

          // Resume an interrupted stream WITHOUT slicing chat.messages.
          // AI SDK's public surface only ships `sendMessage`/`regenerate`/
          // `resumeStream` (the latter requires a server-side resumable-stream
          // backend we don't run yet -- see docs/research/resumable-chat-streams.md).
          // The private `Chat.makeRequest({ trigger: 'submit-message' })` is the
          // exact pathway both `sendMessage` and `regenerate` use internally,
          // minus the message mutation step. Pinned to ai@6.0.x; the contract
          // test in chat-session-store.contract.test.ts fails loudly the moment
          // AI SDK renames or removes this method.
          case 'continue': {
            type ChatMakeRequestShim = {
              makeRequest: (args: {
                trigger: 'submit-message' | 'resume-stream' | 'regenerate-message';
              }) => Promise<void>;
            };
            // `makeRequest` is declared `private` in AI SDK's source so a direct
            // intersection collapses to `never`. We hop through `unknown` to
            // forcibly re-shape the runtime value -- the contract test in
            // chat-session-store.contract.test.ts asserts the method exists at
            // runtime so this assertion can never silently rot.
            // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- typed shim over AI SDK's private method, guarded by chat-session-store.contract.test.ts
            const chatShim = chat as unknown as ChatMakeRequestShim;
            void chatShim.makeRequest({ trigger: 'submit-message' });
          }
        }
      });
    });

    const stopSubscription = persistenceActorRef.on('dispatchStop', () => {
      void chat.stop();
    });

    const finishedSubscription = persistenceActorRef.on('applyFinishedRequest', ({ messages, cause }) => {
      resetMilestonePersistTracking();
      const sanitized = finalizeInterruptedToolParts(messages, chatId, cause);
      if (sanitized !== messages) {
        chat.messages = sanitized;
      }
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    const stoppedSubscription = persistenceActorRef.on('applyStoppedRequest', ({ messages, cause }) => {
      resetMilestonePersistTracking();
      let sanitized = finalizeInterruptedToolParts(messages, chatId, cause);

      const last = sanitized.at(-1);
      if (last?.role === 'user' && last.metadata?.status === 'pending') {
        sanitized = sanitized.with(-1, {
          ...last,
          metadata: { ...last.metadata, status: 'cancelled' },
        });
      }

      chat.messages = sanitized;
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    const resumedSubscription = persistenceActorRef.on('applyResumedRequest', ({ messages, cause }) => {
      resetMilestonePersistTracking();
      const sanitized = finalizeInterruptedToolParts(messages, chatId, cause);
      chat.messages = sanitized;
      persistenceActorRef.send({ type: 'queuePersist', messages: sanitized });
    });

    // Wire the AI SDK Chat's snapshot callbacks into per-chatId subscriber
    // sets. `~registerMessagesCallback` etc. are public (the `~` prefix is
    // the AI SDK's "internal-but-intended-for-subscribers" marker — see
    // node_modules/@ai-sdk/react/dist/index.d.ts).
    const unregisterMessages = chat['~registerMessagesCallback'](() => {
      const lastIndex = chat.messages.length - 1;
      const last = chat.messages[lastIndex];
      if (last?.role === 'assistant') {
        const milestoneCount = countPersistMilestones(last);
        if (
          lastIndex !== milestonePersistState.lastPersistedMilestoneIndex ||
          milestoneCount > milestonePersistState.lastPersistedMilestonePartCount
        ) {
          milestonePersistState.lastPersistedMilestoneIndex = lastIndex;
          milestonePersistState.lastPersistedMilestonePartCount = milestoneCount;
          persistenceActorRef.send({ type: 'queuePersist', messages: chat.messages });
        }
      }

      // Track per-turn cost aggregated across `data-usage` parts.
      const totalCost = aggregateUsageCost(chat.messages);
      if (totalCost > 0 && totalCost !== session.usage?.totalCost) {
        session.usage = { totalCost, lastUpdatedAt: Date.now() };
        for (const listener of this.#usageListeners.get(chatId) ?? []) {
          listener();
        }
      }
      for (const listener of this.#chatListeners.get(chatId) ?? []) {
        listener();
      }
    });
    const unregisterStatus = chat['~registerStatusCallback'](() => {
      const next = chat.status;
      if (session.status !== next) {
        session.status = next;
        if (next === 'streaming') {
          persistenceActorRef.send({ type: 'streamResumed' });
        }
        for (const listener of this.#statusListeners.get(chatId) ?? []) {
          listener();
        }
      }
      for (const listener of this.#chatListeners.get(chatId) ?? []) {
        listener();
      }
    });
    const unregisterError = chat['~registerErrorCallback'](() => {
      for (const listener of this.#chatListeners.get(chatId) ?? []) {
        listener();
      }
    });

    persistenceActorRef.start();
    draftActorRef.start();

    // Kick off chat hydration. Sent after start() so the persistence machine
    // is in `chatLoading.idle` and ready to transition into `loading`.
    persistenceActorRef.send({ type: 'setActiveChatId', chatId });

    const session: InternalSession = {
      chatId,
      chat,
      persistenceActorRef,
      draftActorRef,
      refcount: 1,
      status: chat.status,
      usage: undefined,
      latestAgentBody: undefined,
      dispose: () => {
        dispatchSubscription.unsubscribe();
        stopSubscription.unsubscribe();
        finishedSubscription.unsubscribe();
        stoppedSubscription.unsubscribe();
        resumedSubscription.unsubscribe();
        unregisterMessages();
        unregisterStatus();
        unregisterError();
      },
    };

    return session;
  }

  #addPerChatListener(bucket: Map<string, Set<() => void>>, chatId: string, listener: () => void): () => void {
    let listeners = bucket.get(chatId);
    if (!listeners) {
      listeners = new Set();
      bucket.set(chatId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = bucket.get(chatId);
      current?.delete(listener);
      if (current?.size === 0) {
        bucket.delete(chatId);
      }
    };
  }

  #refreshSnapshot(): void {
    this.#snapshot = [...this.#sessions.keys()];
  }

  #notifyMembership(): void {
    if (this.#membershipNotifyScheduled) {
      return;
    }
    this.#membershipNotifyScheduled = true;
    queueMicrotask(() => {
      this.#membershipNotifyScheduled = false;
      for (const listener of this.#membershipListeners) {
        listener();
      }
    });
  }
}
