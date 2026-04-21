// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MyUIMessage } from '@taucad/chat';

// Hoisted harness mirrors the use-chat.test.tsx pattern: stub the AI SDK's
// `Chat` class and the project manager so the persistence machine wires up
// without a real network/IDB. `harness.patchChat` is the spy we assert on
// for dual-write behavior (decision C: write to both chat row + cookie).
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
  setSelectedModelId: vi.fn(),
  selectedModelId: 'cookie-model',
  selectedModelName: 'Cookie Model',
}));

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

    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility -- mock constructor mirrors AI SDK shape
    constructor(init: {
      id: string;
      messages?: MyUIMessage[];
      onFinish?: (event: { messages: MyUIMessage[]; isAbort: boolean; isError: boolean }) => void;
      onError?: (error: Error) => void;
    }) {
      this.id = init.id;
      this.messages = init.messages ?? [];
      const fake: FakeChat = Object.assign(this, {
        // oxlint-disable-next-line no-empty-function -- mock stub
        onFinish: init.onFinish ?? (() => {}),
        // oxlint-disable-next-line no-empty-function -- mock stub
        onError: init.onError ?? (() => {}),
      });
      harness.created.push(fake);
    }

    /* oxlint-disable @typescript-eslint/naming-convention -- mock mirrors AI SDK's `~`-prefixed methods */
    /* eslint-disable @typescript-eslint/naming-convention -- mock mirrors AI SDK's `~`-prefixed methods */
    public '~registerMessagesCallback' = (): (() => void) => () => undefined;
    public '~registerStatusCallback' = (): (() => void) => () => undefined;
    public '~registerErrorCallback' = (): (() => void) => () => undefined;
    /* eslint-enable @typescript-eslint/naming-convention -- end mock mirroring of AI SDK's `~`-prefixed methods */
    /* oxlint-enable @typescript-eslint/naming-convention -- end mock mirroring of AI SDK's `~`-prefixed methods */
  },
}));

vi.mock('ai', () => ({
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  DefaultChatTransport: class {},
}));

vi.mock('#environment.config.js', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention -- ENV/TAU_API_URL match the runtime env shape
  ENV: { TAU_API_URL: 'http://test.local' },
}));

vi.mock('#machines/inspector.js', () => ({
  inspect: undefined,
}));

vi.mock('#hooks/use-project-manager.js', () => ({
  useProjectManager: () => ({
    patchChat: harness.patchChat,
    setMessageEdit: harness.setMessageEdit,
    clearMessageEdit: harness.clearMessageEdit,
    getChat: harness.getChat,
  }),
}));

// `useActiveChatModel` composes `useModels` for cookie fallback and to expose
// the resolved display model. The cookie is stubbed via this mock so we can
// drive both the "cookie wins" and "chat wins" assertions without touching
// `document.cookie` (which jsdom shares across tests in a file). The mock
// memoises the resolved-model object on `(id, name)` so referential
// stability tests behave the same way the real `useModels` does (it
// memoises via `useMemo`).
// Cache the resolved-model objects + the mock returns so subsequent
// renders observe referential stability (the real `useModels` does this
// via `useMemo`/`useCallback`).
const resolvedModelCache = new Map<string, unknown>();
function stableResolvedModel(id: string, name: string): unknown {
  const key = `${id}|${name}`;
  let cached = resolvedModelCache.get(key);
  if (!cached) {
    cached = {
      id,
      name,
      family: 'unknown',
      provider: { id: 'unknown', name: 'Unknown' },
      isResolved: true,
    };
    resolvedModelCache.set(key, cached);
  }
  return cached;
}
const stableResolveModel = (id: string): unknown =>
  stableResolvedModel(id, id === harness.selectedModelId ? harness.selectedModelName : id);
const useModelsReturnCache = new Map<string, unknown>();
function getStableUseModelsReturn(): unknown {
  const key = `${harness.selectedModelId}|${harness.selectedModelName}`;
  let cached = useModelsReturnCache.get(key);
  if (!cached) {
    cached = {
      selectedModelId: harness.selectedModelId,
      setSelectedModelId: harness.setSelectedModelId,
      selectedModel: stableResolvedModel(harness.selectedModelId, harness.selectedModelName),
      resolveModel: stableResolveModel,
      data: [],
      isLoading: false,
    };
    useModelsReturnCache.set(key, cached);
  }
  return cached;
}
vi.mock('#hooks/use-models.js', () => ({
  useModels: () => getStableUseModelsReturn(),
}));

const { ChatSessionStoreProvider } = await import('#hooks/chat-session-store-provider.js');
const { ActiveChatProvider } = await import('#hooks/active-chat-provider.js');
const { useActiveChatModel } = await import('#hooks/use-active-chat-model.js');

function createWrapper(chatId: string | undefined) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId={chatId}>{children}</ActiveChatProvider>
      </ChatSessionStoreProvider>
    );
  };
}

describe('useActiveChatModel', () => {
  beforeEach(() => {
    harness.created = [];
    harness.getChat.mockReset().mockResolvedValue(undefined);
    harness.patchChat.mockReset().mockResolvedValue(undefined);
    harness.setSelectedModelId.mockReset();
    harness.selectedModelId = 'cookie-model';
    harness.selectedModelName = 'Cookie Model';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cookie value when no active chat is set', () => {
    const { result } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper(undefined),
    });

    expect(result.current.modelId).toBe('cookie-model');
    expect(result.current.model.id).toBe('cookie-model');
  });

  it('returns chat.activeModel when present', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_with_model',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      activeModel: 'chat-local-model',
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper('chat_with_model'),
    });

    await waitFor(() => {
      expect(result.current.modelId).toBe('chat-local-model');
    });
    expect(result.current.model.id).toBe('chat-local-model');
  });

  it('falls back to cookie when chat.activeModel is undefined', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_no_model',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper('chat_no_model'),
    });

    // Wait for the chat load to settle so we know the fallback path took over.
    await waitFor(() => {
      // Re-render at least once after chat loads (status flip ensures the
      // selector re-evaluates) — value remains the cookie default.
      expect(result.current.modelId).toBe('cookie-model');
    });
  });

  it('ignores cookie updates from other tabs while a chat-local value exists', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_cookie_isolated',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      activeModel: 'pinned-model',
      createdAt: 0,
      updatedAt: 0,
    });

    const { result, rerender } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper('chat_cookie_isolated'),
    });

    await waitFor(() => {
      expect(result.current.modelId).toBe('pinned-model');
    });

    // Simulate a concurrent settings tab updating the cookie default.
    harness.selectedModelId = 'cookie-flipped';
    harness.selectedModelName = 'Cookie Flipped';
    rerender();

    expect(result.current.modelId).toBe('pinned-model');
  });

  it('writes to both the chat row and the cookie when setActiveModel is called (decision C)', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_dual_write',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper('chat_dual_write'),
    });

    // Wait for the persistence machine to load before dispatching.
    await waitFor(() => {
      expect(result.current.modelId).toBe('cookie-model');
    });

    act(() => {
      result.current.setActiveModel('new-model');
    });

    await waitFor(() => {
      expect(harness.patchChat).toHaveBeenCalledWith('chat_dual_write', 'activeModel', 'new-model');
    });
    expect(harness.setSelectedModelId).toHaveBeenCalledWith('new-model');
  });

  it('still writes the cookie when no active chat is bound (homepage / pre-chat path)', () => {
    const { result } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper(undefined),
    });

    act(() => {
      result.current.setActiveModel('new-model');
    });

    expect(harness.setSelectedModelId).toHaveBeenCalledWith('new-model');
    // No chat row exists to patch, so patchChat must NOT be called.
    expect(harness.patchChat).not.toHaveBeenCalled();
  });

  it('keeps the returned object referentially stable across rerenders when nothing changed', () => {
    const { result, rerender } = renderHook(() => useActiveChatModel(), {
      wrapper: createWrapper(undefined),
    });

    const first = result.current;
    rerender();
    const second = result.current;

    expect(second).toBe(first);
  });
});
