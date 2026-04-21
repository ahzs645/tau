// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// E8 (R9): clicking a quick-start example must stamp the user message
// with the chat-scoped model id from useActiveChatModel — never the raw
// cookie value via useModels — so a cookie change in another tab cannot
// silently retag the model used for one-click prompts.

const mockSendMessage = vi.fn();
const activeModelState: { current: string } = { current: 'cookie-model' };

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({ sendMessage: mockSendMessage }),
}));

vi.mock('#hooks/use-active-chat-model.js', () => ({
  useActiveChatModel: () => ({
    modelId: activeModelState.current,
    model: { id: activeModelState.current, name: activeModelState.current, isResolved: true },
    setActiveModel: vi.fn(),
  }),
}));

vi.mock('#hooks/use-models.js', () => ({
  useModels: () => {
    throw new Error('chat-examples should no longer call useModels — switch to useActiveChatModel');
  },
}));

vi.mock('#hooks/use-chat-snapshot.js', () => ({
  useChatSnapshot: () => undefined,
}));

vi.mock('#constants/chat-prompt-examples.js', () => ({
  getRandomExamples: () => [
    { title: 'Cube', prompt: 'Make a cube' },
    { title: 'Sphere', prompt: 'Make a sphere' },
  ],
}));

vi.mock('#utils/chat.utils.js', () => ({
  createMessage: (options: Record<string, unknown>) => ({ id: 'msg-test', ...options }),
}));

vi.mock('#components/ui/button.js', () => ({
  Button: ({ children, onClick }: { readonly children: React.ReactNode; readonly onClick?: () => void }) => (
    <button type='button' onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('#components/ui/empty-items.js', () => ({
  EmptyItems: ({ children }: { readonly children: React.ReactNode }) => <div>{children}</div>,
}));

const { ChatExamples } = await import('#routes/projects_.$id/chat-examples.js');

describe('ChatExamples — chat-scoped model stamp (E8, R9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeModelState.current = 'cookie-model';
  });

  it('stamps the chat-scoped model id onto the example user message', () => {
    activeModelState.current = 'chat-local-model';
    render(<ChatExamples />);
    fireEvent.click(screen.getByText('Cube'));

    expect(mockSendMessage).toHaveBeenCalledOnce();
    const sent = mockSendMessage.mock.calls[0]?.[0] as { metadata: { model: string } };
    expect(sent.metadata.model).toBe('chat-local-model');
  });
});
