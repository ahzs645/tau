// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/naming-convention -- mock for AI SDK's Chat class uses the SDK's own `~`-prefixed subscriber method names verbatim so the mock surface matches the real one. */
/* eslint-disable @typescript-eslint/explicit-member-accessibility -- mock class constructor omits the `public` keyword to mirror the AI SDK's published shape. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MyUIMessage } from '@taucad/chat';
import type { ChatError } from '@taucad/types';

// ---------------------------------------------------------------------------
// Hoisted test harness
//
// The store-based architecture wires the AI SDK `Chat` constructor's
// `onFinish` / `onError` callbacks into the persistence machine inside
// `ChatSessionStore.#createSession`. To exercise that wiring end-to-end
// without a real network, we mock `@ai-sdk/react`'s `Chat` class so the
// tests can:
//
// 1. Capture the per-chat `onFinish` / `onError` closures the store passes
//    to `new Chat({...})`.
// 2. Drive `~registerMessagesCallback` / `~registerStatusCallback`
//    listeners deterministically.
// 3. Spy on `sendMessage` / `regenerate` / `stop`.
// 4. Mutate the public `messages` field so the dispatch emits flowing out
//    of `chatPersistenceMachine` (which assign `chat.messages = next`)
//    visibly update the snapshot.
//
// Each `new Chat({ id, ... })` registers itself in `harness.created` so
// tests scoped to multiple chatIds can drive each one independently.
// ---------------------------------------------------------------------------

type FakeChat = {
  id: string;
  messages: MyUIMessage[];
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  error: Error | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onFinish: (event: { messages: MyUIMessage[]; isAbort: boolean; isError: boolean }) => void;
  onError: (error: Error) => void;
};

const harness = vi.hoisted(() => ({
  created: [] as FakeChat[],
  patchChat: vi.fn(),
  setMessageEdit: vi.fn(),
  clearMessageEdit: vi.fn(),
  getChat: vi.fn(),
}));

function getFake(chatId: string): FakeChat {
  const fake = harness.created.find((chat) => chat.id === chatId);
  if (!fake) {
    throw new Error(`No fake Chat created for ${chatId}`);
  }
  return fake;
}

vi.mock('@ai-sdk/react', () => ({
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  Chat: class {
    public id: string;
    public status: 'submitted' | 'streaming' | 'ready' | 'error' = 'ready';
    public error: Error | undefined = undefined;
    public messages: MyUIMessage[];
    public sendMessage = vi.fn().mockResolvedValue(undefined);
    public regenerate = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
    readonly #messagesListeners = new Set<() => void>();
    readonly #statusListeners = new Set<() => void>();
    readonly #errorListeners = new Set<() => void>();

    constructor(init: {
      id: string;
      messages?: MyUIMessage[];
      onFinish?: (event: { messages: MyUIMessage[]; isAbort: boolean; isError: boolean }) => void;
      onError?: (error: Error) => void;
    }) {
      this.id = init.id;
      this.messages = init.messages ?? [];
      const fake: FakeChat = Object.assign(this, {
        // oxlint-disable-next-line no-empty-function -- default no-op until store wires its callback
        onFinish: init.onFinish ?? (() => {}),
        // oxlint-disable-next-line no-empty-function -- default no-op until store wires its callback
        onError: init.onError ?? (() => {}),
      });
      harness.created.push(fake);
    }

    public '~registerMessagesCallback' = (onChange: () => void): (() => void) => {
      this.#messagesListeners.add(onChange);
      return () => {
        this.#messagesListeners.delete(onChange);
      };
    };

    public '~registerStatusCallback' = (onChange: () => void): (() => void) => {
      this.#statusListeners.add(onChange);
      return () => {
        this.#statusListeners.delete(onChange);
      };
    };

    public '~registerErrorCallback' = (onChange: () => void): (() => void) => {
      this.#errorListeners.add(onChange);
      return () => {
        this.#errorListeners.delete(onChange);
      };
    };
  },
}));

vi.mock('ai', () => ({
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  DefaultChatTransport: class {},
}));

vi.mock('#environment.config.js', () => ({
  ENV: { TAU_API_URL: 'http://test.local' },
}));

vi.mock('#machines/inspector.js', () => ({
  inspect: undefined,
}));

vi.mock('#utils/error.utils.js', () => ({
  parseErrorForPersistence: (error: Error): ChatError => ({
    category: 'generic',
    title: 'Stub error',
    message: error.message,
    code: 'INTERNAL_ERROR',
  }),
}));

vi.mock('#hooks/use-project-manager.js', () => ({
  useProjectManager: () => ({
    patchChat: harness.patchChat,
    setMessageEdit: harness.setMessageEdit,
    clearMessageEdit: harness.clearMessageEdit,
    getChat: harness.getChat,
  }),
}));

const { ChatSessionStoreProvider } = await import('#hooks/chat-session-store-provider.js');
const { ActiveChatProvider, useActiveChatId } = await import('#hooks/active-chat-provider.js');
const { useChatActions, useChatContext, useChatSelector, useChatById } = await import('#hooks/use-chat.js');

function makeUserMessage(id: string, text: string): MyUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { createdAt: 0, status: 'pending' },
  };
}

/**
 * `loadChatActor` auto-regenerates when the trailing user message is
 * `pending`, which would unintentionally clear `persistedError` mid-test.
 * Tests that pre-load a chat use this `success`-status variant instead.
 */
function makeLoadedUserMessage(id: string, text: string): MyUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { createdAt: 0, status: 'success' },
  };
}

function makeAssistantMessage(id: string, text: string): MyUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text, state: 'done' }],
    metadata: { createdAt: 0 },
  };
}

const sampleChatError: ChatError = {
  category: 'generic',
  title: 'Boom',
  message: 'Something failed',
  code: 'INTERNAL_ERROR',
};

const defaultTestChatId = 'chat_test_default';

/**
 * Mounts the full new-architecture stack: `<ChatSessionStoreProvider>`
 * (singleton vanilla store) → `<ActiveChatProvider>` (per-subtree active
 * chat + draft binding which acquires the session from the store when a
 * chatId is provided). Pass `chatId={undefined}` to exercise the
 * marketing / draft-only path.
 */
function createWrapper(chatId: string | undefined = defaultTestChatId) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId={chatId}>{children}</ActiveChatProvider>
      </ChatSessionStoreProvider>
    );
  };
}

function renderProvider(chatId: string | undefined = defaultTestChatId) {
  return renderHook(
    () => ({
      actions: useChatActions(),
      context: useChatContext(),
    }),
    { wrapper: createWrapper(chatId) },
  );
}

describe('chat session lifecycle wiring (via ChatSessionStore)', () => {
  beforeEach(() => {
    harness.created = [];
    harness.getChat.mockReset().mockResolvedValue(undefined);
    harness.patchChat.mockReset().mockResolvedValue(undefined);
    harness.setMessageEdit.mockReset().mockResolvedValue(undefined);
    harness.clearMessageEdit.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Direct emit listener wiring: each request kind lands on the correct AI
  // SDK call. These tests anchor the contract that `requestLifecycle` emits
  // are translated faithfully by the store-side dispatch listeners.
  // ===========================================================================

  it('routes a `send` request through to chat.sendMessage', () => {
    const { result } = renderProvider();
    const message = makeUserMessage('msg_1', 'hello');

    act(() => {
      result.current.actions.sendMessage(message);
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    expect(fake.sendMessage).toHaveBeenCalledWith(message);
    expect(fake.regenerate).not.toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it('routes a `regenerate` request through to chat.regenerate', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.regenerate();
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.regenerate).toHaveBeenCalledTimes(1);
    expect(fake.sendMessage).not.toHaveBeenCalled();
  });

  it('routes a `stop` request through to chat.stop', () => {
    const { result } = renderProvider();

    // Need an in-flight request so stopRequest is accepted by the lifecycle.
    act(() => {
      result.current.actions.regenerate();
    });

    act(() => {
      result.current.actions.stop();
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('replaces the message tail and regenerates on edit', () => {
    const original = makeUserMessage('msg_1', 'first try');
    const { result } = renderProvider();
    const fake = getFake(defaultTestChatId);
    fake.messages = [original];

    act(() => {
      result.current.actions.editMessage('msg_1', 'second try', 'gpt-test');
    });

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.id).toBe('msg_1');
    expect(fake.messages[0]!.parts[0]).toMatchObject({ type: 'text', text: 'second try' });
    expect(fake.messages[0]!.metadata?.model).toBe('gpt-test');
    expect(fake.regenerate).toHaveBeenCalledTimes(1);
  });

  it('skips edit dispatch when the target message is no longer present', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.editMessage('msg_missing', 'edit', 'gpt-test');
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.regenerate).not.toHaveBeenCalled();
    expect(result.current.context.persistenceActorRef!.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
  });

  it('rolls back to the previous user turn on retry, applying a model override', () => {
    const userMessage = makeUserMessage('msg_user', 'do thing');
    const assistantMessage = makeAssistantMessage('msg_assistant', 'reply');
    const { result } = renderProvider();
    const fake = getFake(defaultTestChatId);
    fake.messages = [userMessage, assistantMessage];

    act(() => {
      result.current.actions.retryMessage('msg_assistant', 'new-model');
    });

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.id).toBe('msg_user');
    expect(fake.messages[0]!.metadata?.model).toBe('new-model');
    expect(fake.regenerate).toHaveBeenCalledTimes(1);
  });

  it('skips retry dispatch when the target message is missing', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.retryMessage('msg_ghost');
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.regenerate).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // No-flicker contract — when a user kicks off a new request from the error
  // state, both the AI SDK error AND the persisted error must reset in a
  // single React frame. We measure this by snapshotting `persistedError`
  // immediately after the synchronous action() call.
  // ===========================================================================

  describe('no-flicker contract', () => {
    it('clears persistedError synchronously when sendMessage starts', async () => {
      harness.getChat.mockResolvedValue({
        id: 'chat_abc',
        resourceId: 'resource_1',
        name: '',
        messages: [],
        createdAt: 0,
        updatedAt: 0,
        error: sampleChatError,
      });

      const { result } = renderProvider('chat_abc');
      const persistenceActorRef = result.current.context.persistenceActorRef!;

      // Wait for loadChatActor to populate persistedError from the loaded chat.
      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.sendMessage(makeUserMessage('msg_1', 'next attempt'));
      });

      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(getFake('chat_abc').sendMessage).toHaveBeenCalledTimes(1);
    });

    it('clears persistedError synchronously when editMessage starts', async () => {
      const original = makeLoadedUserMessage('msg_1', 'first');
      harness.getChat.mockResolvedValue({
        id: 'chat_abc',
        resourceId: 'resource_1',
        name: '',
        messages: [original],
        createdAt: 0,
        updatedAt: 0,
        error: sampleChatError,
      });

      const { result } = renderProvider('chat_abc');
      const persistenceActorRef = result.current.context.persistenceActorRef!;

      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.editMessage('msg_1', 'edited', 'gpt-test');
      });

      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(getFake('chat_abc').regenerate).toHaveBeenCalledTimes(1);
    });

    it('clears persistedError synchronously when retryMessage starts', async () => {
      const userMessage = makeLoadedUserMessage('msg_user', 'q');
      const assistantMessage = makeAssistantMessage('msg_assistant', 'a');
      harness.getChat.mockResolvedValue({
        id: 'chat_abc',
        resourceId: 'resource_1',
        name: '',
        messages: [userMessage, assistantMessage],
        createdAt: 0,
        updatedAt: 0,
        error: sampleChatError,
      });

      const { result } = renderProvider('chat_abc');
      const persistenceActorRef = result.current.context.persistenceActorRef!;

      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.retryMessage('msg_assistant');
      });

      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(getFake('chat_abc').regenerate).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Queue-while-streaming flow: starting a second request while one is in
  // flight should stop the current request, then once onFinish fires with
  // isAbort, transparently dispatch the queued request.
  // ===========================================================================

  it('queues a second request, stops the first, then dispatches on abort', () => {
    const { result } = renderProvider();
    const first = makeUserMessage('msg_first', 'one');
    const second = makeUserMessage('msg_second', 'two');

    act(() => {
      result.current.actions.sendMessage(first);
    });

    act(() => {
      result.current.actions.sendMessage(second);
    });

    const fake = getFake(defaultTestChatId);
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    expect(fake.sendMessage).toHaveBeenLastCalledWith(first);
    expect(fake.stop).toHaveBeenCalledTimes(1);

    // Simulate the AI SDK aborting and calling onFinish — the store wired
    // this callback into `persistenceActorRef.send({ type: 'requestFinished', ... })`.
    act(() => {
      fake.onFinish({ messages: [first], isAbort: true, isError: false });
    });

    expect(fake.sendMessage).toHaveBeenCalledTimes(2);
    expect(fake.sendMessage).toHaveBeenLastCalledWith(second);
    expect(result.current.context.persistenceActorRef!.getSnapshot().matches({ requestLifecycle: 'invoking' })).toBe(
      true,
    );
  });

  // ===========================================================================
  // Pure-stop cancellation: stopping with no queued request marks the trailing
  // pending user message as `cancelled` so reload doesn't auto-regenerate.
  // ===========================================================================

  it('marks the trailing pending user message as cancelled on a pure stop', () => {
    const pending = makeUserMessage('msg_pending', 'in flight');
    const { result } = renderProvider();

    act(() => {
      result.current.actions.sendMessage(pending);
    });

    const fake = getFake(defaultTestChatId);
    // The store seeds chat.messages from the AI SDK's view; in our mock
    // sendMessage doesn't update messages, so we mirror that the trailing
    // pending user is what onFinish will report.
    fake.messages = [pending];

    act(() => {
      result.current.actions.stop();
    });

    expect(fake.stop).toHaveBeenCalledTimes(1);

    act(() => {
      fake.onFinish({ messages: [pending], isAbort: true, isError: false });
    });

    // Store's `applyStoppedRequest` listener marks the trailing pending
    // user message as `cancelled` and writes back to chat.messages.
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.metadata?.status).toBe('cancelled');
    expect(result.current.context.persistenceActorRef!.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
  });

  // ===========================================================================
  // Mid-stream error path: onError must surface the persisted error and that
  // error must survive `requestFinished` so the banner stays visible until the
  // user takes a new action.
  // ===========================================================================

  it('preserves persistedError when onFinish reports isError after onError', async () => {
    const { result } = renderProvider('chat_abc');
    const persistenceActorRef = result.current.context.persistenceActorRef!;

    await waitFor(() => {
      expect(persistenceActorRef.getSnapshot().matches({ chatLoading: 'idle' })).toBe(true);
    });

    act(() => {
      result.current.actions.sendMessage(makeUserMessage('msg_1', 'go'));
    });

    const fake = getFake('chat_abc');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => {
      fake.onError(new Error('network died'));
    });
    consoleErrorSpy.mockRestore();

    expect(persistenceActorRef.getSnapshot().context.persistedError).toMatchObject({
      message: 'network died',
    });

    act(() => {
      fake.onFinish({ messages: [], isAbort: false, isError: true });
    });

    expect(persistenceActorRef.getSnapshot().context.persistedError).toMatchObject({
      message: 'network died',
    });
  });
});

// ---------------------------------------------------------------------------
// Hooks resolution rules — store-resolved `useChatContext` /
// `useChatSelector` / `useChatActions` plus `useChatById` and
// `useActiveChatId`.
// ---------------------------------------------------------------------------

describe('hooks resolution rules', () => {
  beforeEach(() => {
    harness.created = [];
    harness.getChat.mockReset().mockResolvedValue(undefined);
    harness.patchChat.mockReset().mockResolvedValue(undefined);
    harness.setMessageEdit.mockReset().mockResolvedValue(undefined);
    harness.clearMessageEdit.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useActiveChatId returns the active id provided by ActiveChatProvider', () => {
    const { result } = renderHook(() => useActiveChatId(), {
      wrapper: createWrapper('chat_active'),
    });

    expect(result.current).toBe('chat_active');
  });

  it('useActiveChatId returns undefined when no ActiveChatProvider is in scope', () => {
    const { result } = renderHook(() => useActiveChatId());
    expect(result.current).toBeUndefined();
  });

  it('useChatContext throws when used outside an ActiveChatProvider', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useChatContext())).toThrow(/activechatprovider/i);
    consoleErrorSpy.mockRestore();
  });

  it('useChatActions().setDraftText works without a session (draft-only mode)', () => {
    function Wrapper({ children }: { readonly children: ReactNode }) {
      return (
        <ChatSessionStoreProvider>
          <ActiveChatProvider chatId={undefined}>{children}</ActiveChatProvider>
        </ChatSessionStoreProvider>
      );
    }
    const { result } = renderHook(() => ({ actions: useChatActions(), text: useChatSelector((s) => s.draftText) }), {
      wrapper: Wrapper,
    });

    expect(result.current.text).toBe('');

    act(() => {
      result.current.actions.setDraftText('hello world');
    });

    expect(result.current.text).toBe('hello world');
  });

  it('useChatActions lifecycle no-ops with a console.warn when no session exists for the active chatId', () => {
    function Wrapper({ children }: { readonly children: ReactNode }) {
      return (
        <ChatSessionStoreProvider>
          <ActiveChatProvider chatId={undefined}>{children}</ActiveChatProvider>
        </ChatSessionStoreProvider>
      );
    }
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatActions(), { wrapper: Wrapper });

    act(() => {
      result.current.sendMessage(makeUserMessage('msg_1', 'no session'));
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringMatching(/sendMessage ignored/));
    expect(harness.created).toHaveLength(0);

    consoleWarnSpy.mockRestore();
  });

  it('useChatById reads a non-active chat by explicit id', () => {
    function MultiChatWrapper({ children }: { readonly children: ReactNode }) {
      return (
        <ChatSessionStoreProvider>
          {/* Background session: ActiveChatProvider acquires chat_background from the store. */}
          <ActiveChatProvider chatId='chat_background'>
            {/* Inner foreground binding: ActiveChatProvider acquires chat_foreground. */}
            <ActiveChatProvider chatId='chat_foreground'>{children}</ActiveChatProvider>
          </ActiveChatProvider>
        </ChatSessionStoreProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        active: useChatSelector((s) => s.status),
        background: useChatById('chat_background', (s) => s.status),
      }),
      { wrapper: MultiChatWrapper },
    );

    expect(result.current.active).toBe('ready');
    expect(result.current.background).toBe('ready');
  });

  it('useChatSelector falls back to empty messages when no session is mounted for the resolved chatId', () => {
    function Wrapper({ children }: { readonly children: ReactNode }) {
      // ActiveChatProvider with chatId=undefined — no acquire, no session.
      return (
        <ChatSessionStoreProvider>
          <ActiveChatProvider chatId={undefined}>{children}</ActiveChatProvider>
        </ChatSessionStoreProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        messages: useChatSelector((s) => s.messages),
        status: useChatSelector((s) => s.status),
        order: useChatSelector((s) => s.messageOrder),
      }),
      { wrapper: Wrapper },
    );

    expect(result.current.messages).toEqual([]);
    expect(result.current.status).toBe('ready');
    expect(result.current.order).toEqual([]);
  });

  // =========================================================================
  // B2: activeModel / activeKernel surfaced through CombinedChatState so
  // chat-scoped consumers can read them without poking the persistence
  // machine directly.
  // =========================================================================

  it('surfaces activeModel and activeKernel on the chat snapshot once the persistence machine reports them', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_active_selection',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      activeModel: 'gpt-5.4-medium',
      activeKernel: 'manifold',
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(
      () => ({
        activeModel: useChatSelector((s) => s.activeModel),
        activeKernel: useChatSelector((s) => s.activeKernel),
      }),
      { wrapper: createWrapper('chat_active_selection') },
    );

    await waitFor(() => {
      expect(result.current.activeModel).toBe('gpt-5.4-medium');
      expect(result.current.activeKernel).toBe('manifold');
    });
  });

  it('returns undefined activeModel/activeKernel for chats with no chat-scoped selection', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_no_selection',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(
      () => ({
        activeModel: useChatSelector((s) => s.activeModel),
        activeKernel: useChatSelector((s) => s.activeKernel),
      }),
      { wrapper: createWrapper('chat_no_selection') },
    );

    await waitFor(() => {
      // Wait for the load to settle so the snapshot reflects the persisted
      // (undefined) values rather than the pre-load default.
      expect(result.current.activeModel).toBeUndefined();
    });
    expect(result.current.activeKernel).toBeUndefined();
  });
});
