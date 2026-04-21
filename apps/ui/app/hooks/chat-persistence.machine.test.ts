import { describe, it, expect, vi, afterEach } from 'vitest';
import { createActor, waitFor } from 'xstate';
import type { Chat, MyUIMessage } from '@taucad/chat';
import type { ChatError } from '@taucad/types';
import { chatPersistenceMachine } from '#hooks/chat-persistence.machine.js';
import type { ChatRequest } from '#hooks/chat-persistence.machine.js';
import { fromSafeAsync } from '#lib/xstate.lib.js';

type MockMessage = { id: string; role: string; parts: Array<{ type: string; text?: string }> };

function createMockChat(overrides?: Partial<Chat>): Chat {
  return {
    id: 'chat_test',
    resourceId: '',
    name: '',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function createTestActor(options?: {
  loadResult?: Chat | undefined | (() => Promise<Chat | undefined>);
  persistResult?: () => Promise<void>;
  persistErrorResult?: () => Promise<void>;
  clearErrorResult?: () => Promise<void>;
  activeChatId?: string;
}) {
  const machine = chatPersistenceMachine.provide({
    actors: {
      loadChatActor: fromSafeAsync(async () => {
        const chat = typeof options?.loadResult === 'function' ? await options.loadResult() : options?.loadResult;
        return { type: 'chatRetrieved', chat };
      }),
      persistMessagesActor: fromSafeAsync(async () => {
        // oxlint-disable-next-line no-empty-function -- mock stub
        await (options?.persistResult ?? (async () => {}))();
      }),
      persistErrorActor: fromSafeAsync(async () => {
        // oxlint-disable-next-line no-empty-function -- mock stub
        await (options?.persistErrorResult ?? (async () => {}))();
      }),
      clearErrorActor: fromSafeAsync(async () => {
        // oxlint-disable-next-line no-empty-function -- mock stub
        await (options?.clearErrorResult ?? (async () => {}))();
      }),
    },
  });

  return createActor(machine, {
    input: { activeChatId: options?.activeChatId },
  });
}

type EmittedEvent =
  | { type: 'dispatchRequest'; request: ChatRequest }
  | { type: 'dispatchStop' }
  | { type: 'applyFinishedRequest'; messages: MyUIMessage[] }
  | { type: 'applyStoppedRequest'; messages: MyUIMessage[] }
  | { type: 'applyResumedRequest'; messages: MyUIMessage[]; pendingRequest: ChatRequest };

/**
 * Variant of `createTestActor` that also captures every requestLifecycle
 * emit into an `emitLog`. Listeners are registered before `actor.start()`
 * so the log captures the very first transition.
 */
function createTestActorWithEmits(options?: Parameters<typeof createTestActor>[0]) {
  const actor = createTestActor(options);
  const emitLog: EmittedEvent[] = [];

  actor.on('dispatchRequest', (event) => emitLog.push(event));
  actor.on('dispatchStop', (event) => emitLog.push(event));
  actor.on('applyFinishedRequest', (event) => emitLog.push(event));
  actor.on('applyStoppedRequest', (event) => emitLog.push(event));
  actor.on('applyResumedRequest', (event) => emitLog.push(event));

  return { actor, emitLog };
}

const sampleMessage: MyUIMessage = {
  id: 'msg_user_1',
  role: 'user',
  parts: [{ type: 'text', text: 'hi' }],
  metadata: { createdAt: 0, status: 'pending' },
};

const sampleChatError: ChatError = {
  category: 'generic',
  title: 'Boom',
  message: 'Something failed',
  code: 'INTERNAL_ERROR',
};

describe('chatPersistenceMachine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // chatLoading
  // ===========================================================================
  describe('chatLoading', () => {
    it('should start with chatLoading in idle state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().matches({ chatLoading: 'idle' })).toBe(true);
      actor.stop();
    });

    it('should transition to loading on setActiveChatId with valid chat ID', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setActiveChatId', chatId: 'chat_abc123' });
      expect(actor.getSnapshot().matches({ chatLoading: 'loading' })).toBe(true);
      expect(actor.getSnapshot().context.activeChatId).toBe('chat_abc123');
      expect(actor.getSnapshot().context.isLoadingChat).toBe(true);
      actor.stop();
    });

    it('should NOT load with invalid chat ID (no chat_ prefix)', () => {
      const actor = createTestActor();
      actor.start();
      actor.send({ type: 'setActiveChatId', chatId: 'invalid-id' });
      expect(actor.getSnapshot().matches({ chatLoading: 'idle' })).toBe(true);
      expect(actor.getSnapshot().context.isLoadingChat).toBe(false);
      actor.stop();
    });

    it('should set persistedError from loaded chat error field', async () => {
      const mockError: ChatError = {
        category: 'generic',
        title: 'Error',
        message: 'Something went wrong',
        code: 'INTERNAL_ERROR',
      };
      const mockChat = createMockChat({ id: 'chat_abc', error: mockError });
      const actor = createTestActor({ loadResult: mockChat });
      actor.start();
      actor.send({ type: 'setActiveChatId', chatId: 'chat_abc' });
      await waitFor(actor, (s) => s.matches({ chatLoading: 'idle' }));
      expect(actor.getSnapshot().context.persistedError).toEqual(mockError);
      actor.stop();
    });

    it('should clear isLoadingChat after load completes', async () => {
      const mockChat = createMockChat({ id: 'chat_abc' });
      const actor = createTestActor({ loadResult: mockChat });
      actor.start();
      actor.send({ type: 'setActiveChatId', chatId: 'chat_abc' });
      expect(actor.getSnapshot().context.isLoadingChat).toBe(true);
      await waitFor(actor, (s) => s.matches({ chatLoading: 'idle' }));
      expect(actor.getSnapshot().context.isLoadingChat).toBe(false);
      actor.stop();
    });

    it('should handle load error gracefully', async () => {
      const actor = createTestActor({
        loadResult: async () => {
          throw new Error('network failure');
        },
      });
      actor.start();
      actor.send({ type: 'setActiveChatId', chatId: 'chat_abc' });
      await waitFor(actor, (s) => s.matches({ chatLoading: 'idle' }));
      expect(actor.getSnapshot().context.isLoadingChat).toBe(false);
      expect(actor.getSnapshot().context.loadError).toBeDefined();
      expect(actor.getSnapshot().context.loadError?.message).toBe('network failure');
      actor.stop();
    });
  });

  // ===========================================================================
  // messagePersistence
  // ===========================================================================
  describe('messagePersistence', () => {
    it('should start with messagePersistence in idle state', () => {
      const actor = createTestActor();
      actor.start();
      expect(actor.getSnapshot().matches({ messagePersistence: 'idle' })).toBe(true);
      actor.stop();
    });

    it('should enter pending on queuePersist with valid chatId and not loading', () => {
      const actor = createTestActor({ activeChatId: 'chat_abc' });
      actor.start();
      const messages: MockMessage[] = [{ id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to MyUIMessage[]
      actor.send({ type: 'queuePersist', messages: messages as unknown as MyUIMessage[] });
      expect(actor.getSnapshot().matches({ messagePersistence: 'pending' })).toBe(true);
      actor.stop();
    });

    it('should persist after debounce (100ms)', async () => {
      vi.useFakeTimers();
      try {
        let persistCallCount = 0;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          persistResult: async () => {
            persistCallCount++;
          },
        });
        actor.start();
        const messages: MockMessage[] = [{ id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to MyUIMessage[]
        actor.send({ type: 'queuePersist', messages: messages as unknown as MyUIMessage[] });
        expect(actor.getSnapshot().matches({ messagePersistence: 'pending' })).toBe(true);

        await vi.advanceTimersByTimeAsync(100);
        await waitFor(actor, (s) => s.matches({ messagePersistence: 'idle' }));
        expect(persistCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset debounce on new queuePersist', async () => {
      vi.useFakeTimers();
      try {
        let persistCallCount = 0;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          persistResult: async () => {
            persistCallCount++;
          },
        });
        actor.start();

        const message1: MockMessage[] = [{ id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'first' }] }];
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to MyUIMessage[]
        actor.send({ type: 'queuePersist', messages: message1 as unknown as MyUIMessage[] });

        await vi.advanceTimersByTimeAsync(80);
        expect(persistCallCount).toBe(0);

        const message2: MockMessage[] = [{ id: 'msg2', role: 'user', parts: [{ type: 'text', text: 'second' }] }];
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to MyUIMessage[]
        actor.send({ type: 'queuePersist', messages: message2 as unknown as MyUIMessage[] });

        await vi.advanceTimersByTimeAsync(80);
        expect(persistCallCount).toBe(0);

        await vi.advanceTimersByTimeAsync(20);
        await waitFor(actor, (s) => s.matches({ messagePersistence: 'idle' }));
        expect(persistCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should flush immediately on flushNow', async () => {
      vi.useFakeTimers();
      try {
        let persistCallCount = 0;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          persistResult: async () => {
            persistCallCount++;
          },
        });
        actor.start();

        const messages: MockMessage[] = [{ id: 'msg1', role: 'user', parts: [{ type: 'text', text: 'flush me' }] }];
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock<T>() proxy not assignable to MyUIMessage[]
        actor.send({ type: 'queuePersist', messages: messages as unknown as MyUIMessage[] });
        expect(actor.getSnapshot().matches({ messagePersistence: 'pending' })).toBe(true);

        actor.send({ type: 'flushNow' });
        expect(actor.getSnapshot().matches({ messagePersistence: 'persisting' })).toBe(true);

        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ messagePersistence: 'idle' }));
        expect(persistCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // errorPersistence
  // ===========================================================================
  describe('errorPersistence', () => {
    it('should persist error on setPersistedError', async () => {
      vi.useFakeTimers();
      try {
        let persistErrorCallCount = 0;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          persistErrorResult: async () => {
            persistErrorCallCount++;
          },
        });
        actor.start();

        const error: ChatError = { category: 'generic', title: 'AI Error', message: 'AI failed', code: 'AI_ERROR' };
        actor.send({ type: 'setPersistedError', error });
        expect(actor.getSnapshot().matches({ errorPersistence: 'persisting' })).toBe(true);
        expect(actor.getSnapshot().context.persistedError).toEqual(error);

        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ errorPersistence: 'idle' }));
        expect(persistErrorCallCount).toBe(1);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clear error on clearPersistedError', async () => {
      vi.useFakeTimers();
      try {
        let clearErrorCallCount = 0;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          clearErrorResult: async () => {
            clearErrorCallCount++;
          },
        });
        actor.start();

        actor.send({ type: 'clearPersistedError' });
        expect(actor.getSnapshot().matches({ errorPersistence: 'clearing' })).toBe(true);

        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ errorPersistence: 'idle' }));
        expect(clearErrorCallCount).toBe(1);
        expect(actor.getSnapshot().context.persistedError).toBeUndefined();
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should clear persistedError from context immediately when clearPersistedError is sent from idle', async () => {
      vi.useFakeTimers();
      try {
        let clearResolve: (() => void) | undefined;
        const actor = createTestActor({
          activeChatId: 'chat_abc',
          persistErrorResult: async () => {
            // oxlint-disable-next-line no-empty-function -- mock stub
          },
          clearErrorResult: async () =>
            new Promise<void>((resolve) => {
              clearResolve = resolve;
            }),
        });
        actor.start();

        // Set an error and wait for persistence to complete → back to idle
        const error: ChatError = { category: 'generic', title: 'Error', message: 'fail', code: 'ERR' };
        actor.send({ type: 'setPersistedError', error });
        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ errorPersistence: 'idle' }));
        expect(actor.getSnapshot().context.persistedError).toEqual(error);

        // Send clearPersistedError — context must be cleared IMMEDIATELY,
        // even though the async IDB write (clearErrorActor) has not completed.
        actor.send({ type: 'clearPersistedError' });
        expect(actor.getSnapshot().matches({ errorPersistence: 'clearing' })).toBe(true);
        expect(actor.getSnapshot().context.persistedError).toBeUndefined();

        // Let the async actor finish
        clearResolve!();
        await vi.advanceTimersByTimeAsync(0);
        await waitFor(actor, (s) => s.matches({ errorPersistence: 'idle' }));
        expect(actor.getSnapshot().context.persistedError).toBeUndefined();
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // requestLifecycle
  // ===========================================================================
  describe('requestLifecycle', () => {
    it('should start with requestLifecycle in idle', () => {
      const { actor } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();
      expect(actor.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
      actor.stop();
    });

    it('should transition idle to invoking on startRequest and emit dispatchRequest with the request payload', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      const request: ChatRequest = { kind: 'send', message: sampleMessage };
      actor.send({ type: 'startRequest', request });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'invoking' })).toBe(true);
      expect(emitLog).toEqual([{ type: 'dispatchRequest', request }]);
      actor.stop();
    });

    it('should clear persistedError synchronously when entering invoking from idle', () => {
      const { actor } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      // Seed an error directly via the existing setPersistedError event.
      actor.send({ type: 'setPersistedError', error: sampleChatError });
      expect(actor.getSnapshot().context.persistedError).toEqual(sampleChatError);

      // The clear must happen in the same tick as startRequest (no await).
      actor.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      expect(actor.getSnapshot().context.persistedError).toBeUndefined();
      expect(actor.getSnapshot().matches({ requestLifecycle: 'invoking' })).toBe(true);
      actor.stop();
    });

    it('should transition invoking to stopping on a second startRequest, emit dispatchStop, store the new request as pendingRequest, and clear persistedError', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      const first: ChatRequest = { kind: 'send', message: sampleMessage };
      const second: ChatRequest = { kind: 'send', message: { ...sampleMessage, id: 'msg_user_2' } };

      actor.send({ type: 'startRequest', request: first });
      // Manually set persistedError to verify the second start clears it again.
      actor.send({ type: 'setPersistedError', error: sampleChatError });
      expect(actor.getSnapshot().context.persistedError).toEqual(sampleChatError);

      actor.send({ type: 'startRequest', request: second });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'stopping' })).toBe(true);
      expect(actor.getSnapshot().context.pendingRequest).toEqual(second);
      expect(actor.getSnapshot().context.persistedError).toBeUndefined();
      expect(emitLog.map((event) => event.type)).toEqual(['dispatchRequest', 'dispatchStop']);
      actor.stop();
    });

    it('should transition invoking to stopping on stopRequest with no pendingRequest stored', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      actor.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      actor.send({ type: 'stopRequest' });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'stopping' })).toBe(true);
      expect(actor.getSnapshot().context.pendingRequest).toBeUndefined();
      expect(emitLog.map((event) => event.type)).toEqual(['dispatchRequest', 'dispatchStop']);
      actor.stop();
    });

    it('should transition invoking to idle on requestFinished without isError, emit applyFinishedRequest, and clear persistedError', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      actor.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      // Stale error left over from a previous failed request: success path must clear it.
      actor.send({ type: 'setPersistedError', error: sampleChatError });

      const finalMessages: MyUIMessage[] = [sampleMessage];
      actor.send({ type: 'requestFinished', messages: finalMessages, isAbort: false, isError: false });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
      expect(actor.getSnapshot().context.persistedError).toBeUndefined();
      const lastEmit = emitLog.at(-1);
      expect(lastEmit).toEqual({ type: 'applyFinishedRequest', messages: finalMessages });
      actor.stop();
    });

    it('should transition invoking to idle on requestFinished with isError, emit applyFinishedRequest, and PRESERVE persistedError', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      actor.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      // Mid-stream error, set by ChatProvider's onError handler before onFinish fires.
      actor.send({ type: 'setPersistedError', error: sampleChatError });

      const finalMessages: MyUIMessage[] = [sampleMessage];
      actor.send({ type: 'requestFinished', messages: finalMessages, isAbort: false, isError: true });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
      expect(actor.getSnapshot().context.persistedError).toEqual(sampleChatError);
      const lastEmit = emitLog.at(-1);
      expect(lastEmit).toEqual({ type: 'applyFinishedRequest', messages: finalMessages });
      actor.stop();
    });

    it('should transition stopping to invoking on requestFinished when pendingRequest is set, emit applyResumedRequest then dispatchRequest, and clear pendingRequest', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      const first: ChatRequest = { kind: 'send', message: sampleMessage };
      const queued: ChatRequest = { kind: 'send', message: { ...sampleMessage, id: 'msg_user_2' } };

      actor.send({ type: 'startRequest', request: first });
      actor.send({ type: 'startRequest', request: queued });
      const interruptedMessages: MyUIMessage[] = [sampleMessage];
      actor.send({ type: 'requestFinished', messages: interruptedMessages, isAbort: true, isError: false });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'invoking' })).toBe(true);
      expect(actor.getSnapshot().context.pendingRequest).toBeUndefined();

      const types = emitLog.map((event) => event.type);
      expect(types).toEqual(['dispatchRequest', 'dispatchStop', 'applyResumedRequest', 'dispatchRequest']);

      const resumed = emitLog[2];
      const dispatched = emitLog[3];
      expect(resumed).toEqual({
        type: 'applyResumedRequest',
        messages: interruptedMessages,
        pendingRequest: queued,
      });
      expect(dispatched).toEqual({ type: 'dispatchRequest', request: queued });
      actor.stop();
    });

    it('should transition stopping to idle on requestFinished without pendingRequest and emit applyStoppedRequest', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      actor.send({ type: 'startRequest', request: { kind: 'regenerate' } });
      actor.send({ type: 'stopRequest' });
      const interruptedMessages: MyUIMessage[] = [sampleMessage];
      actor.send({ type: 'requestFinished', messages: interruptedMessages, isAbort: true, isError: false });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
      const lastEmit = emitLog.at(-1);
      expect(lastEmit).toEqual({ type: 'applyStoppedRequest', messages: interruptedMessages });
      actor.stop();
    });

    it('should replace pendingRequest if startRequest fires again while stopping', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      const first: ChatRequest = { kind: 'send', message: sampleMessage };
      const second: ChatRequest = { kind: 'send', message: { ...sampleMessage, id: 'msg_user_2' } };
      const third: ChatRequest = { kind: 'send', message: { ...sampleMessage, id: 'msg_user_3' } };

      actor.send({ type: 'startRequest', request: first });
      actor.send({ type: 'startRequest', request: second });
      // Third startRequest while still in stopping must REPLACE the pending request.
      actor.send({ type: 'startRequest', request: third });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'stopping' })).toBe(true);
      expect(actor.getSnapshot().context.pendingRequest).toEqual(third);
      // No additional dispatchStop emit on the third tap.
      expect(emitLog.filter((event) => event.type === 'dispatchStop').length).toBe(1);
      actor.stop();
    });

    it('should ignore requestFinished while requestLifecycle is idle', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      actor.send({
        type: 'requestFinished',
        messages: [sampleMessage],
        isAbort: false,
        isError: false,
      });

      expect(actor.getSnapshot().matches({ requestLifecycle: 'idle' })).toBe(true);
      expect(emitLog).toEqual([]);
      actor.stop();
    });

    it('should keep emit ordering deterministic across the resume path', () => {
      const { actor, emitLog } = createTestActorWithEmits({ activeChatId: 'chat_abc' });
      actor.start();

      const first: ChatRequest = { kind: 'regenerate' };
      const queued: ChatRequest = { kind: 'send', message: sampleMessage };

      actor.send({ type: 'startRequest', request: first });
      actor.send({ type: 'startRequest', request: queued });
      actor.send({
        type: 'requestFinished',
        messages: [sampleMessage],
        isAbort: true,
        isError: false,
      });

      expect(emitLog.map((event) => event.type)).toEqual([
        'dispatchRequest',
        'dispatchStop',
        'applyResumedRequest',
        'dispatchRequest',
      ]);
      actor.stop();
    });
  });
});
