// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MyUIMessage } from '@taucad/chat';
import { kernelConfigurations } from '@taucad/types/constants';

// Mirror of `use-active-chat-model.test.tsx` for the CAD kernel. Uses the
// same hoisted-mock pattern so the persistence machine wires up inside
// jsdom without IDB or a real WebSocket.
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
  setKernel: vi.fn(),
  cookieKernel: 'openscad',
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

vi.mock('#hooks/use-kernel.js', () => ({
  useKernel: () => ({
    kernel: harness.cookieKernel,
    setKernel: harness.setKernel,
    selectedKernel: kernelConfigurations.find((k) => k.id === harness.cookieKernel),
  }),
}));

const { ChatSessionStoreProvider } = await import('#hooks/chat-session-store-provider.js');
const { ActiveChatProvider } = await import('#hooks/active-chat-provider.js');
const { useActiveChatKernel } = await import('#hooks/use-active-chat-kernel.js');

function createWrapper(chatId: string | undefined) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId={chatId}>{children}</ActiveChatProvider>
      </ChatSessionStoreProvider>
    );
  };
}

describe('useActiveChatKernel', () => {
  beforeEach(() => {
    harness.created = [];
    harness.getChat.mockReset().mockResolvedValue(undefined);
    harness.patchChat.mockReset().mockResolvedValue(undefined);
    harness.setKernel.mockReset();
    harness.cookieKernel = 'openscad';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cookie value when no active chat is set', () => {
    const { result } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper(undefined),
    });

    expect(result.current.kernelId).toBe('openscad');
    expect(result.current.kernel?.id).toBe('openscad');
  });

  it('returns chat.activeKernel when present', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_with_kernel',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      activeKernel: 'manifold',
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper('chat_with_kernel'),
    });

    await waitFor(() => {
      expect(result.current.kernelId).toBe('manifold');
    });
    expect(result.current.kernel?.id).toBe('manifold');
  });

  it('falls back to cookie when chat.activeKernel is undefined', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_no_kernel',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper('chat_no_kernel'),
    });

    await waitFor(() => {
      expect(result.current.kernelId).toBe('openscad');
    });
  });

  it('ignores cookie updates from other tabs while a chat-local value exists', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_kernel_pinned',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      activeKernel: 'manifold',
      createdAt: 0,
      updatedAt: 0,
    });

    const { result, rerender } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper('chat_kernel_pinned'),
    });

    await waitFor(() => {
      expect(result.current.kernelId).toBe('manifold');
    });

    harness.cookieKernel = 'replicad';
    rerender();

    expect(result.current.kernelId).toBe('manifold');
  });

  it('writes to both the chat row and the cookie when setActiveKernel is called (decision C)', async () => {
    harness.getChat.mockResolvedValue({
      id: 'chat_kernel_dual_write',
      resourceId: 'resource_1',
      name: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });

    const { result } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper('chat_kernel_dual_write'),
    });

    await waitFor(() => {
      expect(result.current.kernelId).toBe('openscad');
    });

    act(() => {
      result.current.setActiveKernel('manifold');
    });

    await waitFor(() => {
      expect(harness.patchChat).toHaveBeenCalledWith('chat_kernel_dual_write', 'activeKernel', 'manifold');
    });
    expect(harness.setKernel).toHaveBeenCalledWith('manifold');
  });

  it('still writes the cookie when no active chat is bound', () => {
    const { result } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper(undefined),
    });

    act(() => {
      result.current.setActiveKernel('manifold');
    });

    expect(harness.setKernel).toHaveBeenCalledWith('manifold');
    expect(harness.patchChat).not.toHaveBeenCalled();
  });

  it('keeps the returned object referentially stable across rerenders when nothing changed', () => {
    const { result, rerender } = renderHook(() => useActiveChatKernel(), {
      wrapper: createWrapper(undefined),
    });

    const first = result.current;
    rerender();
    const second = result.current;

    expect(second).toBe(first);
  });
});
