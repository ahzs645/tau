import { describe, it, expect, vi, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createActor, waitFor } from 'xstate';
import type { MyUIMessage } from '@taucad/chat';
import type { ChatMode } from '@taucad/chat/constants';
import { draftMachine } from '#hooks/draft.machine.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

function createTestActor(options?: { chatId?: string }) {
  const machine = draftMachine.provide({
    actors: {
      // oxlint-disable-next-line no-empty-function -- mock stub
      persistDraftActor: fromSafeAsync(async () => {}),
      // oxlint-disable-next-line no-empty-function -- mock stub
      persistEditDraftActor: fromSafeAsync(async () => {}),
      // oxlint-disable-next-line no-empty-function -- mock stub
      clearMessageEditActor: fromSafeAsync(async () => {}),
    },
  });

  return createActor(machine, {
    input: { chatId: options?.chatId },
  });
}

describe('draftMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Context initialization
  // ===========================================================================
  describe('context initialization', () => {
    it('should initialize with correct defaults', () => {
      const actor = createTestActor();
      actor.start();
      const { context } = actor.getSnapshot();
      expect(context.draftText).toBe('');
      expect(context.draftImages).toEqual([]);
      expect(context.draftToolChoice).toBe('auto');
      expect(context.draftMode).toBe('agent');
      expect(context.messageEdits).toEqual({});
      expect(context.activeEditMessageId).toBeUndefined();
      expect(context.editDraftText).toBe('');
      expect(context.editDraftImages).toEqual([]);
      actor.stop();
    });
  });

  // ===========================================================================
  // Draft text events
  // ===========================================================================
  describe('draft text events', () => {
    it('should set draft text', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setDraftText', text: 'hello world' });
      expect(actor.getSnapshot().context.draftText).toBe('hello world');
      actor.stop();
    });

    it('should add draft image', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'addDraftImage', image: 'data:image/png;base64,abc' });
      expect(actor.getSnapshot().context.draftImages).toEqual(['data:image/png;base64,abc']);
      actor.send({ type: 'addDraftImage', image: 'data:image/png;base64,def' });
      expect(actor.getSnapshot().context.draftImages).toHaveLength(2);
      actor.stop();
    });

    it('should remove draft image by index', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'addDraftImage', image: 'img-a' });
      actor.send({ type: 'addDraftImage', image: 'img-b' });
      actor.send({ type: 'addDraftImage', image: 'img-c' });
      actor.send({ type: 'removeDraftImage', index: 1 });
      expect(actor.getSnapshot().context.draftImages).toEqual(['img-a', 'img-c']);
      actor.stop();
    });

    it('should clear draft (text, images, tool choice)', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setDraftText', text: 'some text' });
      actor.send({ type: 'addDraftImage', image: 'img-a' });
      actor.send({ type: 'setDraftToolChoice', toolChoice: 'required' });
      actor.send({ type: 'clearDraft' });
      const { context } = actor.getSnapshot();
      expect(context.draftText).toBe('');
      expect(context.draftImages).toEqual([]);
      expect(context.draftToolChoice).toBe('auto');
      actor.stop();
    });

    it('should set draft mode', () => {
      const actor = createTestActor();
      actor.start();
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally invalid value for error-path testing
      actor.send({ type: 'setDraftMode', mode: 'edit' as unknown as ChatMode });
      expect(actor.getSnapshot().context.draftMode).toBe('edit');
      actor.stop();
    });

    it('should set draft tool choice', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setDraftToolChoice', toolChoice: 'required' });
      expect(actor.getSnapshot().context.draftToolChoice).toBe('required');
      actor.stop();
    });
  });

  // ===========================================================================
  // inputSaving state
  // ===========================================================================
  describe('inputSaving', () => {
    it('should enter pending on setDraftText', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setDraftText', text: 'typing...' });
      expect(actor.getSnapshot().matches({ inputSaving: 'pending' })).toBe(true);
      actor.stop();
    });

    it('should persist after debounce (200ms) when chatId is valid', async () => {
      vi.useFakeTimers();
      try {
        const actor = createTestActor({ chatId: 'chat_abc' });
        actor.start();
        actor.send({ type: 'setDraftText', text: 'save me' });
        expect(actor.getSnapshot().matches({ inputSaving: 'pending' })).toBe(true);

        await vi.advanceTimersByTimeAsync(200);
        await waitFor(actor, (s) => s.matches({ inputSaving: 'idle' }));
        expect(actor.getSnapshot().matches({ inputSaving: 'idle' })).toBe(true);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should NOT persist when chatId is invalid (no chat_ prefix)', async () => {
      vi.useFakeTimers();
      try {
        const actor = createTestActor({ chatId: 'invalid-id' });
        actor.start();
        actor.send({ type: 'setDraftText', text: 'no save' });
        expect(actor.getSnapshot().matches({ inputSaving: 'pending' })).toBe(true);

        await vi.advanceTimersByTimeAsync(200);

        // Guard fails so it falls back to idle without persisting
        expect(actor.getSnapshot().matches({ inputSaving: 'idle' })).toBe(true);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // Edit mode
  // ===========================================================================
  describe('edit mode', () => {
    it('should start editing a message', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({
        type: 'startEditingMessage',
        messageId: 'msg-1',
        originalMessage: mock<MyUIMessage>({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'original text' }],
          metadata: { createdAt: Date.now(), status: 'pending' },
        }),
      });
      expect(actor.getSnapshot().context.activeEditMessageId).toBe('msg-1');
      expect(actor.getSnapshot().context.editDraftText).toBe('original text');
      actor.stop();
    });

    it('should set edit draft text', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({
        type: 'startEditingMessage',
        messageId: 'msg-1',
        originalMessage: mock<MyUIMessage>({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'original' }],
          metadata: { createdAt: Date.now(), status: 'pending' },
        }),
      });
      actor.send({ type: 'setEditDraftText', text: 'edited text' });
      expect(actor.getSnapshot().context.editDraftText).toBe('edited text');
      actor.stop();
    });

    it('should exit edit mode and save to messageEdits', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({
        type: 'startEditingMessage',
        messageId: 'msg-1',
        originalMessage: mock<MyUIMessage>({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'original' }],
          metadata: { createdAt: Date.now(), status: 'pending' },
        }),
      });
      actor.send({ type: 'setEditDraftText', text: 'edited' });
      actor.send({ type: 'exitEditMode' });

      const { context } = actor.getSnapshot();
      expect(context.activeEditMessageId).toBeUndefined();
      expect(context.editDraftText).toBe('');
      expect(context.messageEdits['msg-1']).toBeDefined();
      const savedParts = context.messageEdits['msg-1']!.parts;
      const textPart = savedParts.find((p) => p.type === 'text');
      expect(textPart?.text).toBe('edited');
      actor.stop();
    });

    it('should clear message edit', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({
        type: 'startEditingMessage',
        messageId: 'msg-1',
        originalMessage: mock<MyUIMessage>({
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'original' }],
          metadata: { createdAt: Date.now(), status: 'pending' },
        }),
      });
      actor.send({ type: 'exitEditMode' });
      expect(actor.getSnapshot().context.messageEdits['msg-1']).toBeDefined();

      actor.send({ type: 'clearMessageEdit', messageId: 'msg-1' });
      expect(actor.getSnapshot().context.messageEdits['msg-1']).toBeUndefined();
      actor.stop();
    });
  });

  // ===========================================================================
  // editSaving state
  // ===========================================================================
  describe('editSaving', () => {
    it('should enter pending on setEditDraftText', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setEditDraftText', text: 'editing...' });
      expect(actor.getSnapshot().matches({ editSaving: 'pending' })).toBe(true);
      actor.stop();
    });
  });
});
