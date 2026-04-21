// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KernelIssue } from '@taucad/runtime';

const { mockCreateChat, mockSendMessage, mockSetFocusedChatId, mockEditorSend, mockReadFile } = vi.hoisted(() => ({
  mockCreateChat: vi.fn(),
  mockSendMessage: vi.fn(),
  mockSetFocusedChatId: vi.fn(),
  mockEditorSend: vi.fn(),
  mockReadFile: vi.fn(),
}));

let mockKernelIssues = new Map<string, KernelIssue[]>();
let mockSelectedModelId = 'cookie-model';
let mockKernel: 'openscad' | 'manifold' = 'openscad';

vi.mock('#hooks/use-project.js', () => ({
  useProject: () => ({
    getMainFilename: async () => 'main.scad',
    editorRef: { send: mockEditorSend },
    projectId: 'project_test',
    setFocusedChatId: mockSetFocusedChatId,
  }),
}));

vi.mock('#hooks/use-cad.js', () => ({
  useCad: () => ({ id: 'cad-project_test-main.scad' }),
  useCadSelector: <S,>(selector: (state: { context: { kernelIssues: Map<string, KernelIssue[]> } }) => S): S =>
    selector({ context: { kernelIssues: mockKernelIssues } }),
}));

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ sendMessage: mockSendMessage }),
}));

vi.mock('#hooks/use-chats.js', () => ({
  useChats: () => ({ createChat: mockCreateChat }),
}));

// E7: production code now reads from the chat-scoped resolvers — guard
// the cookie-only hooks with throwing mocks so any regression that
// re-introduces them is caught immediately.
vi.mock('#hooks/use-active-chat-model.js', () => ({
  useActiveChatModel: () => ({
    modelId: mockSelectedModelId,
    model: { id: mockSelectedModelId, name: mockSelectedModelId, isResolved: true },
    setActiveModel: vi.fn(),
  }),
}));

vi.mock('#hooks/use-active-chat-kernel.js', () => ({
  useActiveChatKernel: () => ({
    kernelId: mockKernel,
    kernel: { id: mockKernel, name: mockKernel },
    setActiveKernel: vi.fn(),
  }),
}));

vi.mock('#hooks/use-models.js', () => ({
  useModels: () => {
    throw new Error('chat-stack-trace should no longer call useModels — switch to useActiveChatModel');
  },
}));

vi.mock('#hooks/use-kernel.js', () => ({
  useKernel: () => {
    throw new Error('chat-stack-trace should no longer call useKernel — switch to useActiveChatKernel');
  },
}));

vi.mock('#hooks/use-chat-snapshot.js', () => ({
  useChatSnapshot: () => undefined,
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useModifiers: () => ({ shift: true }),
}));

vi.mock('#hooks/use-file-manager.js', () => ({
  useFileManager: () => ({ readFile: mockReadFile }),
}));

vi.mock('#components/files/file-link.js', () => ({
  FileLink: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('#components/markdown/markdown-viewer.js', () => ({
  MarkdownViewer: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('#components/ui/key-shortcut.js', () => ({
  KeyShortcut: ({ children }: { readonly children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('#components/ui/tooltip.js', () => ({
  Tooltip: ({ children }: { readonly children: React.ReactNode }): React.ReactNode => children,
  TooltipTrigger: ({ children }: { readonly children: React.ReactNode }): React.ReactNode => children,
  TooltipContent: ({ children }: { readonly children: React.ReactNode }): React.ReactNode => children,
}));

vi.mock('#components/ui/collapsible.js', () => ({
  Collapsible: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/ui/button.js', () => ({
  Button: ({ children, onClick }: { readonly children: React.ReactNode; readonly onClick?: () => void }) => (
    <button type='button' onClick={onClick} data-testid='fix-with-ai'>
      {children}
    </button>
  ),
}));

vi.mock('#utils/chat.utils.js', () => ({
  createMessage: (options: Record<string, unknown>) => ({ id: 'msg-fix', ...options }),
}));

vi.mock('#utils/filesystem.utils.js', () => ({
  decodeTextFile: (_bytes: Uint8Array<ArrayBuffer>) => 'cube(10);',
}));

const { ChatStackTrace } = await import('#routes/projects_.$id/chat-stack-trace.js');

const issue: KernelIssue = {
  message: 'Boom',
  severity: 'error',
  location: { fileName: 'main.scad', startLineNumber: 1, startColumn: 1 },
  stackFrames: [],
};

describe('ChatStackTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockCreateChat.mockResolvedValue({ id: 'chat_new' });
    mockKernelIssues = new Map([['main.scad', [issue]]]);
    mockSelectedModelId = 'cookie-model';
    mockKernel = 'openscad';
  });

  it('should seed activeModel and activeKernel on the new chat when Fix-with-AI creates a new chat (D3, R3)', async () => {
    render(<ChatStackTrace entryFile='main.scad' side='top' />);
    fireEvent.click(await screen.findByTestId('fix-with-ai'));

    await waitFor(() => {
      expect(mockCreateChat).toHaveBeenCalledOnce();
    });

    const callArgs = mockCreateChat.mock.calls[0]?.[0] as { activeModel?: string; activeKernel?: string };
    expect(callArgs.activeModel).toBe('cookie-model');
    expect(callArgs.activeKernel).toBe('openscad');
  });

  it('should focus the newly created chat after seeding (D3)', async () => {
    render(<ChatStackTrace entryFile='main.scad' side='top' />);
    fireEvent.click(await screen.findByTestId('fix-with-ai'));

    await waitFor(() => {
      expect(mockSetFocusedChatId).toHaveBeenCalledWith('chat_new');
    });
  });

  it('should stamp the chat-scoped model + kernel onto the new chat metadata (E7, R6)', async () => {
    // Diverge the chat-scoped values from the cookie defaults so a
    // regression that reads from the global hooks would surface as
    // 'cookie-model' / 'openscad' instead of these chat-local values.
    mockSelectedModelId = 'chat-local-model';
    mockKernel = 'manifold';

    render(<ChatStackTrace entryFile='main.scad' side='top' />);
    fireEvent.click(await screen.findByTestId('fix-with-ai'));

    await waitFor(() => {
      expect(mockCreateChat).toHaveBeenCalledOnce();
    });

    const callArgs = mockCreateChat.mock.calls[0]?.[0] as {
      activeModel?: string;
      activeKernel?: string;
      messages?: Array<{ metadata?: { model?: string; kernel?: string } }>;
    };
    expect(callArgs.activeModel).toBe('chat-local-model');
    expect(callArgs.activeKernel).toBe('manifold');
    expect(callArgs.messages?.[0]?.metadata?.model).toBe('chat-local-model');
    expect(callArgs.messages?.[0]?.metadata?.kernel).toBe('manifold');
  });

  it('should send to the current chat with the chat-scoped model/kernel when shift is not held', async () => {
    // Override the modifier mock for this single test to bypass the
    // new-chat branch and exercise the in-place sendMessage path.
    const useModifiersMock = (await import('#hooks/use-keyboard.js')) as { useModifiers: () => { shift: boolean } };
    const original = useModifiersMock.useModifiers;
    useModifiersMock.useModifiers = () => ({ shift: false });

    mockSelectedModelId = 'chat-local-model';
    mockKernel = 'manifold';

    try {
      render(<ChatStackTrace entryFile='main.scad' side='top' />);
      fireEvent.click(await screen.findByTestId('fix-with-ai'));

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledOnce();
      });

      const sentMessage = mockSendMessage.mock.calls[0]?.[0] as {
        metadata?: { model?: string; kernel?: string };
      };
      expect(sentMessage.metadata?.model).toBe('chat-local-model');
      expect(sentMessage.metadata?.kernel).toBe('manifold');
      expect(mockCreateChat).not.toHaveBeenCalled();
    } finally {
      useModifiersMock.useModifiers = original;
    }
  });
});
