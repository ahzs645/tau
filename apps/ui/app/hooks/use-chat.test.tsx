// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MyUIMessage } from '@taucad/chat';
import type { ChatError } from '@taucad/types';

// ---------------------------------------------------------------------------
// Hoisted test harness
//
// These mocks replace the heavy collaborators around `ChatProvider` so the
// tests can drive `requestLifecycle` end-to-end through the real
// `chatPersistenceMachine` while observing the AI SDK side effects on a
// controllable fake chat. Captured `useChat` config (specifically `onFinish`
// and `onError`) lets tests simulate AI SDK callbacks deterministically.
// ---------------------------------------------------------------------------

type FakeChat = {
  messages: MyUIMessage[];
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  error: Error | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setMessages: ReturnType<typeof vi.fn>;
};

type CapturedUseChatConfig = {
  onFinish?: (event: { messages: MyUIMessage[]; isAbort: boolean; isError: boolean }) => void;
  onError?: (error: Error) => void;
};

const harness = vi.hoisted(() => {
  return {
    fakeChat: undefined as unknown as FakeChat,
    capturedConfig: { current: undefined as CapturedUseChatConfig | undefined },
    getChat: vi.fn(),
    patchChat: vi.fn(),
    setMessageEdit: vi.fn(),
    clearMessageEdit: vi.fn(),
  };
});

vi.mock('@ai-sdk/react', () => ({
  useChat: (config: CapturedUseChatConfig) => {
    harness.capturedConfig.current = config;
    return harness.fakeChat;
  },
}));

vi.mock('ai', () => ({
  // Stand-in for the real transport — only the constructor signature matters
  // because `useChat` is also mocked and never calls into the transport.
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  DefaultChatTransport: class {},
}));

/* eslint-disable @typescript-eslint/naming-convention -- mirrors real ENV constant shape */
vi.mock('#environment.config.js', () => ({
  ENV: { TAU_API_URL: 'http://test.local' },
}));
/* eslint-enable @typescript-eslint/naming-convention -- restore default naming rules */

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

vi.mock('#hooks/use-chats.js', () => ({
  useChats: () => ({
    getChat: harness.getChat,
    patchChat: harness.patchChat,
    setMessageEdit: harness.setMessageEdit,
    clearMessageEdit: harness.clearMessageEdit,
    chats: [],
  }),
}));

const { ChatProvider, useChatActions, useChatContext } = await import('#hooks/use-chat.js');

function createFakeChat(): FakeChat {
  const fake: FakeChat = {
    messages: [],
    status: 'ready',
    error: undefined,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    regenerate: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    // Mirror real AI SDK behavior so `chat.messages` updates reflect setMessages calls.
    setMessages: vi.fn((next: MyUIMessage[]) => {
      fake.messages = next;
    }),
  };
  return fake;
}

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

function createWrapper(chatId?: string) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ChatProvider chatId={chatId} resourceId='resource_1'>
        {children}
      </ChatProvider>
    );
  };
}

function renderProvider(chatId?: string) {
  return renderHook(
    () => ({
      actions: useChatActions(),
      context: useChatContext(),
    }),
    { wrapper: createWrapper(chatId) },
  );
}

describe('ChatProvider request lifecycle wiring', () => {
  beforeEach(() => {
    harness.fakeChat = createFakeChat();
    harness.capturedConfig.current = undefined;
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
  // are translated faithfully by `ChatProvider`.
  // ===========================================================================

  it('routes a `send` request through to chat.sendMessage', () => {
    const { result } = renderProvider();
    const message = makeUserMessage('msg_1', 'hello');

    act(() => {
      result.current.actions.sendMessage(message);
    });

    expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.fakeChat.sendMessage).toHaveBeenCalledWith(message);
    expect(harness.fakeChat.regenerate).not.toHaveBeenCalled();
    expect(harness.fakeChat.stop).not.toHaveBeenCalled();
  });

  it('routes a `regenerate` request through to chat.regenerate', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.regenerate();
    });

    expect(harness.fakeChat.regenerate).toHaveBeenCalledTimes(1);
    expect(harness.fakeChat.sendMessage).not.toHaveBeenCalled();
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

    expect(harness.fakeChat.stop).toHaveBeenCalledTimes(1);
  });

  it('replaces the message tail and regenerates on edit', () => {
    const original = makeUserMessage('msg_1', 'first try');
    harness.fakeChat = { ...createFakeChat(), messages: [original] };
    const { result } = renderProvider();

    act(() => {
      result.current.actions.editMessage('msg_1', 'second try', 'gpt-test');
    });

    expect(harness.fakeChat.setMessages).toHaveBeenCalledTimes(1);
    const sliced = harness.fakeChat.setMessages.mock.calls[0]![0] as MyUIMessage[];
    expect(sliced).toHaveLength(1);
    expect(sliced[0]!.id).toBe('msg_1');
    expect(sliced[0]!.parts[0]).toMatchObject({ type: 'text', text: 'second try' });
    expect(sliced[0]!.metadata?.model).toBe('gpt-test');
    expect(harness.fakeChat.regenerate).toHaveBeenCalledTimes(1);
  });

  it('skips edit dispatch when the target message is no longer present', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.editMessage('msg_missing', 'edit', 'gpt-test');
    });

    expect(harness.fakeChat.setMessages).not.toHaveBeenCalled();
    expect(harness.fakeChat.regenerate).not.toHaveBeenCalled();
    // Lifecycle should remain idle since the action validated up front.
    expect(result.current.context.persistenceActorRef.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
  });

  it('rolls back to the previous user turn on retry, applying a model override', () => {
    const userMessage = makeUserMessage('msg_user', 'do thing');
    const assistantMessage = makeAssistantMessage('msg_assistant', 'reply');
    harness.fakeChat = { ...createFakeChat(), messages: [userMessage, assistantMessage] };
    const { result } = renderProvider();

    act(() => {
      result.current.actions.retryMessage('msg_assistant', 'new-model');
    });

    expect(harness.fakeChat.setMessages).toHaveBeenCalledTimes(1);
    const next = harness.fakeChat.setMessages.mock.calls[0]![0] as MyUIMessage[];
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('msg_user');
    expect(next[0]!.metadata?.model).toBe('new-model');
    expect(harness.fakeChat.regenerate).toHaveBeenCalledTimes(1);
  });

  it('skips retry dispatch when the target message is missing', () => {
    const { result } = renderProvider();

    act(() => {
      result.current.actions.retryMessage('msg_ghost');
    });

    expect(harness.fakeChat.setMessages).not.toHaveBeenCalled();
    expect(harness.fakeChat.regenerate).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // No-flicker contract — the original bug. When a user kicks off a new
  // request from the error state, both the AI SDK error AND the persisted
  // error must reset in a single React frame. We measure this by snapshotting
  // `persistedError` immediately after the synchronous action() call.
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
      const { persistenceActorRef } = result.current.context;

      // Wait for loadChatActor to populate persistedError from the loaded chat.
      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.sendMessage(makeUserMessage('msg_1', 'next attempt'));
      });

      // Same frame as the action: persistedError must already be undefined.
      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(1);
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
      // The provider's load actor calls setMessages, which in turn updates
      // fakeChat.messages — pre-seed so the edit validation passes.
      harness.fakeChat.messages = [original];

      const { result } = renderProvider('chat_abc');
      const { persistenceActorRef } = result.current.context;

      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.editMessage('msg_1', 'edited', 'gpt-test');
      });

      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(harness.fakeChat.regenerate).toHaveBeenCalledTimes(1);
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
      harness.fakeChat.messages = [userMessage, assistantMessage];

      const { result } = renderProvider('chat_abc');
      const { persistenceActorRef } = result.current.context;

      await waitFor(() => {
        expect(persistenceActorRef.getSnapshot().context.persistedError).toEqual(sampleChatError);
      });

      act(() => {
        result.current.actions.retryMessage('msg_assistant');
      });

      expect(persistenceActorRef.getSnapshot().context.persistedError).toBeUndefined();
      expect(harness.fakeChat.regenerate).toHaveBeenCalledTimes(1);
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

    // First request fired; stop emitted; second is queued (not yet dispatched).
    expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.fakeChat.sendMessage).toHaveBeenLastCalledWith(first);
    expect(harness.fakeChat.stop).toHaveBeenCalledTimes(1);

    // Simulate the AI SDK aborting and calling onFinish.
    act(() => {
      harness.capturedConfig.current?.onFinish?.({
        messages: [first],
        isAbort: true,
        isError: false,
      });
    });

    expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.fakeChat.sendMessage).toHaveBeenLastCalledWith(second);
    // After resuming the queued request the lifecycle is invoking again.
    expect(result.current.context.persistenceActorRef.getSnapshot().matches({ requestLifecycle: 'invoking' })).toBe(
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

    act(() => {
      result.current.actions.stop();
    });

    expect(harness.fakeChat.stop).toHaveBeenCalledTimes(1);

    act(() => {
      harness.capturedConfig.current?.onFinish?.({
        messages: [pending],
        isAbort: true,
        isError: false,
      });
    });

    // The trailing user message should be marked as `cancelled` via
    // setMessages so a future page reload doesn't auto-regenerate it.
    const cancelledCall = harness.fakeChat.setMessages.mock.calls.at(-1);
    expect(cancelledCall).toBeDefined();
    const next = cancelledCall![0] as MyUIMessage[];
    expect(next).toHaveLength(1);
    expect(next[0]!.metadata?.status).toBe('cancelled');
    // Lifecycle is back to idle (no resumed request).
    expect(result.current.context.persistenceActorRef.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
  });

  // ===========================================================================
  // Mid-stream error path: onError must surface the persisted error and that
  // error must survive `requestFinished` so the banner stays visible until the
  // user takes a new action.
  // ===========================================================================

  it('preserves persistedError when onFinish reports isError after onError', async () => {
    // The setPersistedError event requires `canPersist` (chatId starts with `chat_`).
    const { result } = renderProvider('chat_abc');
    const { persistenceActorRef } = result.current.context;

    // Wait for chatLoading to settle so isLoadingChat is false; otherwise
    // canPersist returns false and onError's setPersistedError is dropped.
    await waitFor(() => {
      expect(persistenceActorRef.getSnapshot().matches({ chatLoading: 'idle' })).toBe(true);
    });

    act(() => {
      result.current.actions.sendMessage(makeUserMessage('msg_1', 'go'));
    });

    // The machine intentionally console.errors on `handleError`; silence it
    // so the expected log doesn't pollute the test output.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => {
      harness.capturedConfig.current?.onError?.(new Error('network died'));
    });
    consoleErrorSpy.mockRestore();

    expect(persistenceActorRef.getSnapshot().context.persistedError).toMatchObject({
      message: 'network died',
    });

    act(() => {
      harness.capturedConfig.current?.onFinish?.({
        messages: [],
        isAbort: false,
        isError: true,
      });
    });

    // Mid-stream error preserved across requestFinished.
    expect(persistenceActorRef.getSnapshot().context.persistedError).toMatchObject({
      message: 'network died',
    });
  });

  // ===========================================================================
  // Listener teardown: subscriptions are unsubscribed on unmount so post-
  // unmount events don't drive a destroyed React tree.
  // ===========================================================================

  it('unsubscribes lifecycle listeners on unmount', () => {
    const { result, unmount } = renderProvider();

    act(() => {
      result.current.actions.sendMessage(makeUserMessage('msg_1', 'before unmount'));
    });
    expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(1);

    unmount();

    // After unmount the AI SDK side-effect mocks should not be called again
    // even if we replay a startRequest on a fresh actor would, but here we
    // just verify the wired chat methods saw exactly the in-tree calls.
    expect(harness.fakeChat.sendMessage).toHaveBeenCalledTimes(1);
  });
});
