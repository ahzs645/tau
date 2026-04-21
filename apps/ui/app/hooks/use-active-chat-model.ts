import { useCallback, useMemo } from 'react';
import { useActiveChatId } from '#hooks/active-chat-provider.js';
import { useChatActions, useChatSelector } from '#hooks/use-chat.js';
import type { ResolvedModel } from '#hooks/use-models.js';
import { useModels } from '#hooks/use-models.js';

/**
 * Resolved chat-scoped model state. Mirrors the shape returned by
 * {@link useModels} for the focused chat: `modelId` is the live, possibly
 * chat-local id and `model` is the same id resolved against the global
 * model catalogue. Consumers render `model` for display and stamp
 * `modelId` onto outgoing message metadata.
 */
export type ActiveChatModel = {
  /**
   * The id of the chat-scoped active model. Falls back to the cookie
   * default when the chat has no chat-local selection (or there is no
   * active chat at all — e.g. on the homepage prior to chat creation).
   */
  modelId: string;
  /**
   * Display-resolved view of {@link ActiveChatModel.modelId}, sourced from
   * {@link useModels}. Always non-null so call sites can render without
   * `??` fallbacks.
   */
  model: ResolvedModel;
  /**
   * Patch the chat-scoped active model. Per decision C in
   * `chat-active-model-kernel-persistence.md`, this writes BOTH the chat
   * row (so reload preserves the chat-local choice) AND the cookie (so
   * future *new* chats inherit the most recently chosen model). When no
   * active chat is bound only the cookie is updated.
   */
  setActiveModel: (modelId: string) => void;
};

/**
 * Chat-scoped resolver hook for the active model. Prefers
 * `Chat.activeModel` from the persistence machine when present, otherwise
 * falls back to the cookie-backed `useModels().selectedModelId`. This is
 * the single source of truth for the model id rendered in the chat
 * textarea, the model selector, and the message metadata stamp.
 */
export function useActiveChatModel(): ActiveChatModel {
  const activeChatId = useActiveChatId();
  const chatActiveModel = useChatSelector((state) => state.activeModel);
  const { selectedModelId, selectedModel, setSelectedModelId, resolveModel } = useModels();
  const { setActiveModel: persistChatActiveModel } = useChatActions();

  const modelId = chatActiveModel ?? selectedModelId;
  const model = useMemo<ResolvedModel>(
    () => (modelId === selectedModelId ? selectedModel : resolveModel(modelId)),
    [modelId, selectedModel, selectedModelId, resolveModel],
  );

  const setActiveModel = useCallback(
    (next: string) => {
      // Decision C: dual-write so future new chats inherit this choice via
      // the cookie default, and reload of THIS chat sees the chat-local
      // value.
      setSelectedModelId(next);
      if (activeChatId) {
        persistChatActiveModel(next);
      }
    },
    [activeChatId, persistChatActiveModel, setSelectedModelId],
  );

  return useMemo<ActiveChatModel>(() => ({ modelId, model, setActiveModel }), [modelId, model, setActiveModel]);
}
