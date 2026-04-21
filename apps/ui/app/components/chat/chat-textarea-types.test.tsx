// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ResolvedModel } from '#hooks/use-models.js';

const stableModel: ResolvedModel = {
  id: 'chat-scoped-model',
  details: { family: 'gpt' },
} as unknown as ResolvedModel;

let mockActiveModel: ResolvedModel = stableModel;
const mockSetActiveModel = vi.fn();

vi.mock('#hooks/use-active-chat-model.js', () => ({
  useActiveChatModel: () => ({
    modelId: mockActiveModel.id,
    model: mockActiveModel,
    setActiveModel: mockSetActiveModel,
  }),
}));

const mockUseChatSelector = vi.fn((selector: (state: unknown) => unknown) =>
  selector({
    status: 'idle',
    draftText: 'hello world',
    draftImages: [] as string[],
    draftToolChoice: 'auto',
    draftMode: 'agent',
    editDraftText: '',
    editDraftImages: [] as string[],
  }),
);

vi.mock('#hooks/use-chat.js', () => ({
  useChatActions: () => ({
    stop: vi.fn(),
    setDraftText: vi.fn(),
    addDraftImage: vi.fn(),
    removeDraftImage: vi.fn(),
    setDraftToolChoice: vi.fn(),
    setEditDraftText: vi.fn(),
    addEditDraftImage: vi.fn(),
    removeEditDraftImage: vi.fn(),
  }),
  useChatSelector: (selector: (state: unknown) => unknown) => mockUseChatSelector(selector),
}));

vi.mock('#hooks/use-keyboard.js', () => ({
  useKeybinding: () => ({ formattedKeyCombination: 'Ctrl+Backspace' }),
}));

vi.mock('#components/ui/sonner.js', () => ({
  toast: { error: vi.fn() },
}));

const { useChatTextareaLogic } = await import('#components/chat/chat-textarea-types.js');

describe('useChatTextareaLogic — chat-scoped model wiring (E1, R6/R11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveModel = stableModel;
  });

  it('should expose the chat-scoped model on selectedModel', () => {
    const { result } = renderHook(() =>
      useChatTextareaLogic({
        ref: undefined,
        onSubmit: vi.fn(async () => undefined),
      }),
    );

    expect(result.current.selectedModel.id).toBe('chat-scoped-model');
  });

  it('should stamp the chat-scoped model id onto onSubmit when handleSubmit fires', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { result } = renderHook(() => useChatTextareaLogic({ ref: undefined, onSubmit }));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello world',
        model: 'chat-scoped-model',
      }),
    );
  });

  it('should follow the chat-scoped model when it changes between submits (no cookie bleed)', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(() => useChatTextareaLogic({ ref: undefined, onSubmit }));

    await act(async () => {
      await result.current.handleSubmit();
    });

    mockActiveModel = { id: 'next-chat-scoped-model', details: { family: 'gpt' } } as unknown as ResolvedModel;
    rerender();

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSubmit).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'next-chat-scoped-model' }));
  });
});
