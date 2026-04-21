// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { KernelId } from '@taucad/types/constants';

// E6 (R6, R11): the user-message metadata stamp inside ChatHistory.onSubmit
// must read the chat-scoped kernel from useActiveChatKernel — never the
// global cookie via useKernel — so a cookie change in another tab cannot
// silently retag the kernel for the active chat.

const activeKernelState: { current: KernelId } = { current: 'manifold' };
const useActiveChatKernelMock = vi.fn(() => ({
  kernelId: activeKernelState.current,
  kernel: { id: activeKernelState.current, name: activeKernelState.current },
  setActiveKernel: vi.fn(),
}));

vi.mock('#hooks/use-active-chat-kernel.js', () => ({
  useActiveChatKernel: () => useActiveChatKernelMock(),
}));

// `useKernel` must NOT be called from chat-history anymore — guard with a
// throwing mock so any regression is caught loudly.
vi.mock('#hooks/use-kernel.js', () => ({
  useKernel: () => {
    throw new Error('chat-history should no longer call useKernel — switch to useActiveChatKernel');
  },
}));

const sendMessage = vi.fn();
vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ sendMessage }),
  useChatSelector: (selector: (state: unknown) => unknown) => selector({ messageOrder: [] }),
}));

// Capture the textarea onSubmit callback so the test can invoke it
// directly without driving the full draft pipeline.
const capturedTextarea: { onSubmit?: (payload: unknown) => Promise<void> } = {};
vi.mock('#components/chat/chat-textarea.js', () => ({
  ChatTextarea: (properties: { readonly onSubmit?: (payload: unknown) => Promise<void> }): React.JSX.Element => {
    capturedTextarea.onSubmit = properties.onSubmit;
    return <div data-testid='chat-textarea' />;
  },
}));

vi.mock('#routes/projects_.$id/chat-message.js', () => ({
  ChatMessage: () => null,
}));

vi.mock('#routes/projects_.$id/scroll-down-button.js', () => ({
  ScrollDownButton: () => null,
}));

vi.mock('#routes/projects_.$id/chat-error.js', () => ({
  ChatError: () => null,
}));

vi.mock('#routes/projects_.$id/chat-history-selector.js', () => ({
  ChatHistorySelector: () => null,
}));

vi.mock('#routes/projects_.$id/chat-history-status.js', () => ({
  ChatHistoryStatus: () => null,
}));

vi.mock('#routes/projects_.$id/chat-history-empty.js', () => ({
  ChatHistoryEmpty: () => null,
}));

vi.mock('#components/ui/floating-panel.js', () => ({
  FloatingPanel: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelClose: () => null,
  FloatingPanelContent: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelContentHeader: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  FloatingPanelErrorContent: () => null,
  FloatingPanelTrigger: () => null,
}));

vi.mock('#components/ui/key-shortcut.js', () => ({
  KeyShortcut: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useKeybinding: () => ({ formattedKeyCombination: 'Ctrl+C' }),
}));

vi.mock('#hooks/use-cookie.js', () => ({
  useCookie: () => [true, vi.fn()],
}));

vi.mock('#components/chat/at-reference-context.js', () => ({
  AtReferenceProvider: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({ treeService: undefined }),
}));

vi.mock('#hooks/use-chats.js', () => ({
  useChats: () => ({ chats: [] }),
}));

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({ projectId: 'project_test' }),
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: () => <div data-testid='virtuoso' />,
}));

const { ChatHistory } = await import('#routes/projects_.$id/chat-history.js');

const submitDraft = async (model = 'cookie-model') => {
  await capturedTextarea.onSubmit?.({
    content: 'hello',
    model,
    metadata: {},
    imageUrls: [],
  });
};

describe('ChatHistory — chat-scoped kernel stamp (E6, R6, R11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeKernelState.current = 'manifold';
    capturedTextarea.onSubmit = undefined;
  });

  it('stamps user-message metadata.kernel from useActiveChatKernel (manifold)', async () => {
    render(<ChatHistory />);
    await submitDraft();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as { metadata: { kernel: string } };
    expect(sent.metadata.kernel).toBe('manifold');
  });

  it('reflects the chat-scoped kernel switch on subsequent submits (jscad)', async () => {
    // ChatHistory is wrapped in `memo` and takes no props, so the only way to
    // re-evaluate its hooks is to force a fresh mount via key changes — that
    // also exercises the `kernelRef` re-initialisation path.
    activeKernelState.current = 'jscad';
    render(<ChatHistory key='second-mount' />);
    await submitDraft();

    const sent = sendMessage.mock.calls[0]?.[0] as { metadata: { kernel: string } };
    expect(sent.metadata.kernel).toBe('jscad');
  });

  // G3 / R11: wire-format invariant. Every outgoing user message must
  // carry BOTH `metadata.model` and `metadata.kernel`, both resolved from
  // chat-scoped active values. The API (`apps/api/app/api/chat/chat.controller.ts`)
  // depends on these two fields together; if either drops or drifts to the
  // cookie source, the agent silently runs with the wrong system prompt or
  // tool surface — the regression that motivated this whole refactor.
  it('stamps BOTH metadata.model and metadata.kernel together (wire-format invariant)', async () => {
    activeKernelState.current = 'replicad';
    render(<ChatHistory />);
    await submitDraft('chat-scoped-model');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as {
      metadata: { kernel?: string; model?: string };
    };
    expect(sent.metadata.kernel).toBe('replicad');
    expect(sent.metadata.model).toBe('chat-scoped-model');
    expect(sent.metadata.model).toBeDefined();
    expect(sent.metadata.kernel).toBeDefined();
  });
});
