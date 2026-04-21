import { useCallback, useMemo } from 'react';
import type { KernelId } from '@taucad/types/constants';
import { kernelConfigurations } from '@taucad/types/constants';
import { useActiveChatId } from '#hooks/active-chat-provider.js';
import { useChatActions, useChatSelector } from '#hooks/use-chat.js';
import { useKernel } from '#hooks/use-kernel.js';

// Mirror `useKernel`'s untyped Map so the resolved value preserves the
// literal `id` union (`KernelId`) rather than widening to `string` — keeps
// the SvgIcon brand-icon prop strictly typed at consumer sites.
const kernelById = new Map(kernelConfigurations.map((k) => [k.id, k]));

/**
 * Display-resolved kernel as returned by the resolver. Type matches
 * {@link useKernel}'s `selectedKernel` so consumers can swap between hooks
 * without widening the `id` field to `string`.
 */
export type ActiveChatKernelEntry = ReturnType<typeof kernelById.get>;

/**
 * Resolved chat-scoped CAD kernel state. Mirrors the shape returned by
 * {@link useKernel} for the focused chat.
 */
export type ActiveChatKernel = {
  /**
   * The id of the chat-scoped active kernel. Falls back to the cookie
   * default when the chat has no chat-local selection (or there is no
   * active chat at all — e.g. on the homepage prior to chat creation).
   */
  kernelId: KernelId;
  /**
   * Display-resolved view of {@link ActiveChatKernel.kernelId}. May be
   * `undefined` if the kernel id is not present in
   * {@link kernelConfigurations} (defensive — should never happen for ids
   * coming from the cookie or chat row).
   */
  kernel: ActiveChatKernelEntry;
  /**
   * Patch the chat-scoped active kernel. Per decision C in
   * `chat-active-model-kernel-persistence.md`, this writes BOTH the chat
   * row AND the cookie. When no active chat is bound only the cookie is
   * updated.
   */
  setActiveKernel: (kernelId: KernelId) => void;
};

/**
 * Chat-scoped resolver hook for the active CAD kernel. Prefers
 * `Chat.activeKernel` from the persistence machine when present,
 * otherwise falls back to the cookie-backed `useKernel().kernel`.
 */
export function useActiveChatKernel(): ActiveChatKernel {
  const activeChatId = useActiveChatId();
  const chatActiveKernel = useChatSelector((state) => state.activeKernel);
  const { kernel: cookieKernel, setKernel: setCookieKernel } = useKernel();
  const { setActiveKernel: persistChatActiveKernel } = useChatActions();

  const kernelId: KernelId = chatActiveKernel ?? cookieKernel;
  const kernel = kernelById.get(kernelId);

  const setActiveKernel = useCallback(
    (next: KernelId) => {
      setCookieKernel(next);
      if (activeChatId) {
        persistChatActiveKernel(next);
      }
    },
    [activeChatId, persistChatActiveKernel, setCookieKernel],
  );

  return useMemo<ActiveChatKernel>(() => ({ kernelId, kernel, setActiveKernel }), [kernelId, kernel, setActiveKernel]);
}
