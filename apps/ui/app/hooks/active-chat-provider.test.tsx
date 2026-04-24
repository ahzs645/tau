// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Chat } from '@taucad/chat';
import { fromSafeAsync } from '#lib/xstate.lib.js';

// ---------------------------------------------------------------------------
// Hoisted harness — mocks the project-manager surface that ActiveChatProvider
// reaches for to back its draft persistence actors. Keeps the test focused on
// the provider's contract without spinning up the full IndexedDB worker.
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  patchChat: vi.fn(),
  setMessageEdit: vi.fn(),
  clearMessageEdit: vi.fn(),
  getChat: vi.fn(),
  toastError: vi.fn(),
  resize: vi.fn<(image: string) => Promise<string>>(),
}));

vi.mock('#hooks/use-project-manager.js', () => ({
  useProjectManager: () => ({
    patchChat: harness.patchChat,
    setMessageEdit: harness.setMessageEdit,
    clearMessageEdit: harness.clearMessageEdit,
    getChat: harness.getChat,
  }),
}));

vi.mock('#machines/inspector.js', () => ({
  inspect: undefined,
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: {
    error: harness.toastError,
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// Override the production resize actor so the active-chat-provider's R1 toast
// subscriber can be exercised against a controllable fake. The same actor is
// provided by both `EphemeralActiveChatProvider` and `ChatSessionStore`, so a
// single mock covers both branches.
vi.mock('#hooks/resize-image.actor.js', () => ({
  resizeImageActor: fromSafeAsync<{ type: 'imageResized'; resized: string }, { image: string }>(async ({ input }) => {
    const resized = await harness.resize(input.image);
    return { type: 'imageResized', resized };
  }),
}));

const { ActiveChatProvider, useActiveChatId, useActiveChat } = await import('#hooks/active-chat-provider.js');
const { ChatSessionStoreProvider } = await import('#hooks/chat-session-store-provider.js');

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat_homepage_main',
    resourceId: 'home',
    name: '',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function createWrapper(chatId: string | undefined) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId={chatId}>{children}</ActiveChatProvider>
      </ChatSessionStoreProvider>
    );
  };
}

beforeEach(() => {
  harness.patchChat.mockReset().mockResolvedValue(undefined);
  harness.setMessageEdit.mockReset().mockResolvedValue(undefined);
  harness.clearMessageEdit.mockReset().mockResolvedValue(undefined);
  harness.getChat.mockReset().mockResolvedValue(undefined);
  harness.toastError.mockReset();
  harness.resize.mockReset().mockImplementation(async (image: string) => image);
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ActiveChatProvider', () => {
  it('should expose the activeChatId via useActiveChatId', () => {
    const { result } = renderHook(() => useActiveChatId(), {
      wrapper: createWrapper('chat_active'),
    });

    expect(result.current).toBe('chat_active');
  });

  it('should expose undefined via useActiveChatId when chatId prop is undefined', () => {
    const { result } = renderHook(() => useActiveChatId(), {
      wrapper: createWrapper(undefined),
    });

    expect(result.current).toBeUndefined();
  });

  it('should return undefined from useActiveChatId when used outside the provider', () => {
    const { result } = renderHook(() => useActiveChatId());

    expect(result.current).toBeUndefined();
  });

  it('should throw when useActiveChat is used outside the provider', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => renderHook(() => useActiveChat())).toThrow(/activechatprovider/i);

    consoleErrorSpy.mockRestore();
  });

  it('should expose a draftActorRef via useActiveChat', () => {
    const { result } = renderHook(() => useActiveChat(), {
      wrapper: createWrapper('chat_active'),
    });

    expect(result.current.draftActorRef).toBeDefined();
    expect(result.current.activeChatId).toBe('chat_active');
  });

  it('should persist draft to IndexedDB when chatId is defined', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useActiveChat(), {
      wrapper: createWrapper('chat_persist'),
    });

    act(() => {
      result.current.draftActorRef.send({ type: 'setDraftText', text: 'hello world' });
    });

    // SaveDebounce is 200ms — push past it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(harness.patchChat).toHaveBeenCalledTimes(1);
    expect(harness.patchChat).toHaveBeenCalledWith('chat_persist', 'draft', expect.objectContaining({ id: 'draft' }));
  });

  it('should NOT call persistDraftActor when chatId is undefined (ephemeral mode)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useActiveChat(), {
      wrapper: createWrapper(undefined),
    });

    act(() => {
      result.current.draftActorRef.send({ type: 'setDraftText', text: 'hello ephemeral' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(harness.patchChat).not.toHaveBeenCalled();
  });

  it('should switch draft state cleanly when chatId prop changes', async () => {
    function Probe(): ReactNode {
      return null;
    }

    const { rerender } = render(
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId='chat_first'>
          <Probe />
        </ActiveChatProvider>
      </ChatSessionStoreProvider>,
    );

    expect(harness.getChat).toHaveBeenCalledWith('chat_first');

    rerender(
      <ChatSessionStoreProvider>
        <ActiveChatProvider chatId='chat_second'>
          <Probe />
        </ActiveChatProvider>
      </ChatSessionStoreProvider>,
    );

    await waitFor(() => {
      expect(harness.getChat).toHaveBeenCalledWith('chat_second');
    });
  });

  it('should load the existing Chat.draft from IndexedDB when chatId is defined and a record exists', async () => {
    harness.getChat.mockResolvedValue(
      makeChat({
        id: 'chat_with_draft',
        draft: {
          id: 'draft',
          role: 'user',
          metadata: { createdAt: 0, status: 'pending' },
          parts: [{ type: 'text', text: 'preserved homepage draft' }],
        },
      }),
    );

    const { result } = renderHook(() => useActiveChat(), {
      wrapper: createWrapper('chat_with_draft'),
    });

    await waitFor(() => {
      const snapshot = result.current.draftActorRef.getSnapshot();
      expect(snapshot.context.draftText).toBe('preserved homepage draft');
    });
  });

  it('should not throw when no Chat row exists for the given chatId (homepage first-visit)', async () => {
    harness.getChat.mockResolvedValue(undefined);

    const { result } = renderHook(() => useActiveChat(), {
      wrapper: createWrapper('chat_homepage_main'),
    });

    await waitFor(() => {
      expect(harness.getChat).toHaveBeenCalledWith('chat_homepage_main');
    });

    expect(result.current.draftActorRef.getSnapshot().context.draftText).toBe('');
  });

  it('should not invoke getChat when chatId is undefined', async () => {
    renderHook(() => useActiveChat(), {
      wrapper: createWrapper(undefined),
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(harness.getChat).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // R1 — image-resize toast subscriber (single global error site)
  // ===========================================================================
  describe('imageResizeFailed toast subscriber', () => {
    it('should toast.error when the draft actor emits imageResizeFailed (session-backed)', async () => {
      harness.resize.mockRejectedValueOnce(new Error('boom'));

      const { result } = renderHook(() => useActiveChat(), {
        wrapper: createWrapper('chat_toast'),
      });

      act(() => {
        result.current.draftActorRef.send({ type: 'addDraftImage', image: 'data:image/png;base64,raw' });
      });

      await waitFor(() => {
        expect(harness.toastError).toHaveBeenCalledOnce();
      });
      expect(harness.toastError).toHaveBeenCalledWith('Failed to process image', expect.any(Object));
    });

    it('should toast.error when the draft actor emits imageResizeFailed (ephemeral)', async () => {
      harness.resize.mockRejectedValueOnce(new Error('boom'));

      const { result } = renderHook(() => useActiveChat(), {
        wrapper: createWrapper(undefined),
      });

      act(() => {
        result.current.draftActorRef.send({ type: 'addDraftImage', image: 'data:image/png;base64,raw' });
      });

      await waitFor(() => {
        expect(harness.toastError).toHaveBeenCalledOnce();
      });
    });

    it('should not toast on successful resize', async () => {
      harness.resize.mockResolvedValueOnce('data:image/jpeg;base64,resized');

      const { result } = renderHook(() => useActiveChat(), {
        wrapper: createWrapper('chat_no_toast'),
      });

      act(() => {
        result.current.draftActorRef.send({ type: 'addDraftImage', image: 'data:image/png;base64,raw' });
      });

      await waitFor(() => {
        expect(result.current.draftActorRef.getSnapshot().context.draftImages).toEqual([
          'data:image/jpeg;base64,resized',
        ]);
      });

      expect(harness.toastError).not.toHaveBeenCalled();
    });

    it('should unsubscribe the listener on unmount (no toast after unmount)', async () => {
      // Block the resize promise so the failure fires AFTER unmount.
      let rejectResize!: (error: Error) => void;
      harness.resize.mockImplementationOnce(
        async () =>
          new Promise<string>((_resolve, reject) => {
            rejectResize = reject;
          }),
      );

      const { result, unmount } = renderHook(() => useActiveChat(), {
        wrapper: createWrapper(undefined),
      });

      const { draftActorRef } = result.current;

      act(() => {
        draftActorRef.send({ type: 'addDraftImage', image: 'data:image/png;base64,raw' });
      });

      unmount();

      rejectResize(new Error('post-unmount failure'));

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(harness.toastError).not.toHaveBeenCalled();
    });
  });
});
