/**
 * Subscribes to a `draftMachine` actor's `imageResizeFailed` emit and surfaces
 * a single global `toast.error` per failure. This is the **only** site in the
 * app that toasts on image-resize errors — `<ActiveChatProvider>` mounts one
 * subscriber per active chat, so the 12 image entry points (drag/drop, paste,
 * file picker, capture-view, …) never need their own try/catch around the
 * resize step. See `docs/research/chat-image-resize-coverage-audit.md` for
 * the audit (F5 — Tiptap paste swallowed errors silently before this hook).
 */

import { useEffect } from 'react';
import type { ActorRefFrom } from 'xstate';
import type { draftMachine } from '#hooks/draft.machine.js';
import { toast } from '#components/ui/sonner.js';

export function useDraftImageErrorToast(draftActorRef: ActorRefFrom<typeof draftMachine>): void {
  useEffect(() => {
    const subscription = draftActorRef.on('imageResizeFailed', (event) => {
      toast.error('Failed to process image', {
        description: event.error.message,
      });
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [draftActorRef]);
}
