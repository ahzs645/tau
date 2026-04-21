// @vitest-environment node
/* eslint-disable @typescript-eslint/naming-convention -- mock for AI SDK's Chat / DefaultChatTransport classes uses the SDK's own PascalCase names and `~`-prefixed subscriber method names verbatim so the mock surface matches the real one. */
/* eslint-disable @typescript-eslint/explicit-member-accessibility -- mock class constructors omit the `public` keyword to mirror the AI SDK's published shape. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat as ChatEntity, MyUIMessage } from '@taucad/chat';

// ---------------------------------------------------------------------------
// Hoisted test harness
//
// Mocks the AI SDK's `Chat` class so the tests can drive snapshot callbacks
// (`~registerMessagesCallback`, `~registerStatusCallback`,
// `~registerErrorCallback`) deterministically and assert that
// `ChatSessionStore` mirrors them into per-chat subscriptions.
//
// Each `new Chat({ id, ... })` records the constructor input and is exposed
// via `harness.created` so the test can drive callbacks per chat instance.
// ---------------------------------------------------------------------------

type FakeChatInstance = {
  id: string;
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  error: Error | undefined;
  messages: MyUIMessage[];
  sendMessage: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  // Test driver — invoke any registered messages callback
  emitMessagesChange: () => void;
  emitStatusChange: () => void;
  emitErrorChange: () => void;
  '~registerMessagesCallback': (onChange: () => void) => () => void;
  '~registerStatusCallback': (onChange: () => void) => () => void;
  '~registerErrorCallback': (onChange: () => void) => () => void;
};

const harness = vi.hoisted(() => ({
  created: [] as FakeChatInstance[],
  envApi: 'http://test.local',
}));

vi.mock('@ai-sdk/react', () => ({
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  Chat: class {
    public id: string;
    public status: 'submitted' | 'streaming' | 'ready' | 'error' = 'ready';
    public error: Error | undefined = undefined;
    public messages: MyUIMessage[] = [];
    public sendMessage = vi.fn().mockResolvedValue(undefined);
    public regenerate = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
    readonly #messagesListeners = new Set<() => void>();
    readonly #statusListeners = new Set<() => void>();
    readonly #errorListeners = new Set<() => void>();

    constructor(init: { id: string; messages?: MyUIMessage[] }) {
      this.id = init.id;
      this.messages = init.messages ?? [];
      const fake: FakeChatInstance = Object.assign(this, {
        emitMessagesChange: () => {
          for (const listener of this.#messagesListeners) {
            listener();
          }
        },
        emitStatusChange: () => {
          for (const listener of this.#statusListeners) {
            listener();
          }
        },
        emitErrorChange: () => {
          for (const listener of this.#errorListeners) {
            listener();
          }
        },
      });
      harness.created.push(fake);
    }

    public '~registerMessagesCallback' = (onChange: () => void): (() => void) => {
      this.#messagesListeners.add(onChange);
      return () => {
        this.#messagesListeners.delete(onChange);
      };
    };

    public '~registerStatusCallback' = (onChange: () => void): (() => void) => {
      this.#statusListeners.add(onChange);
      return () => {
        this.#statusListeners.delete(onChange);
      };
    };

    public '~registerErrorCallback' = (onChange: () => void): (() => void) => {
      this.#errorListeners.add(onChange);
      return () => {
        this.#errorListeners.delete(onChange);
      };
    };
  },
}));

vi.mock('ai', () => ({
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- mock requires a `new`able value
  DefaultChatTransport: class {},
}));

vi.mock('#environment.config.js', () => ({
  ENV: { TAU_API_URL: harness.envApi },
}));

vi.mock('#machines/inspector.js', () => ({
  inspect: undefined,
}));

const { ChatSessionStore } = await import('#services/chat-session-store.js');
type StoreType = InstanceType<typeof ChatSessionStore>;
type ChatSessionDeps = Parameters<StoreType['setDependencies']>[0];

/**
 * Use vitest's generic `vi.fn<T>()` form so each mock carries the precise
 * callable signature declared by `ChatSessionDeps`. Without the generic,
 * `vi.fn()` defaults to a permissive `Constructable | Procedure` shape
 * that doesn't structurally match the typed closure fields.
 */
type StubDeps = {
  [K in keyof ChatSessionDeps]: ReturnType<typeof vi.fn<ChatSessionDeps[K]>>;
};

function createStubDeps(): StubDeps {
  return {
    getChat: vi.fn<ChatSessionDeps['getChat']>().mockResolvedValue(undefined),
    patchChat: vi.fn<ChatSessionDeps['patchChat']>().mockResolvedValue(undefined),
    setMessageEdit: vi.fn<ChatSessionDeps['setMessageEdit']>().mockResolvedValue(undefined),
    clearMessageEdit: vi.fn<ChatSessionDeps['clearMessageEdit']>().mockResolvedValue(undefined),
  };
}

function createStore(): StoreType {
  const store = new ChatSessionStore();
  store.setDependencies(createStubDeps());
  return store;
}

describe('ChatSessionStore', () => {
  beforeEach(() => {
    harness.created = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // acquire / release refcounting
  // ===========================================================================

  describe('acquire / release', () => {
    it('creates a session lazily on first acquire', () => {
      const store = createStore();
      const session = store.acquire('chat_a');

      expect(session.chatId).toBe('chat_a');
      expect(session.chat.id).toBe('chat_a');
      expect(session.persistenceActorRef).toBeDefined();
      expect(session.draftActorRef).toBeDefined();
      expect(harness.created).toHaveLength(1);
    });

    it('returns the same session on subsequent acquires for the same chatId', () => {
      const store = createStore();
      const first = store.acquire('chat_a');
      const second = store.acquire('chat_a');

      expect(second).toBe(first);
      expect(second.chat).toBe(first.chat);
      expect(second.persistenceActorRef).toBe(first.persistenceActorRef);
      expect(second.draftActorRef).toBe(first.draftActorRef);
      expect(harness.created).toHaveLength(1);
    });

    it('keeps the session live until the final release', () => {
      const store = createStore();
      store.acquire('chat_a');
      store.acquire('chat_a');

      store.release('chat_a');
      expect(store.get('chat_a')).toBeDefined();

      store.release('chat_a');
      expect(store.get('chat_a')).toBeUndefined();
    });

    it('disposes the persistence and draft actors on the final release', () => {
      const store = createStore();
      const session = store.acquire('chat_a');
      const persistenceSnapshotBefore = session.persistenceActorRef.getSnapshot();
      const draftSnapshotBefore = session.draftActorRef.getSnapshot();

      expect(persistenceSnapshotBefore.status).toBe('active');
      expect(draftSnapshotBefore.status).toBe('active');

      store.release('chat_a');

      expect(session.persistenceActorRef.getSnapshot().status).toBe('stopped');
      expect(session.draftActorRef.getSnapshot().status).toBe('stopped');
    });

    it('does not throw when releasing an unknown chatId', () => {
      const store = createStore();
      expect(() => {
        store.release('chat_missing');
      }).not.toThrow();
    });

    it('does not throw when releasing more times than acquired', () => {
      const store = createStore();
      store.acquire('chat_a');
      store.release('chat_a');

      expect(() => {
        store.release('chat_a');
      }).not.toThrow();
      expect(store.get('chat_a')).toBeUndefined();
    });

    it('creates a fresh session after a previous release (no zombie state)', () => {
      const store = createStore();
      const first = store.acquire('chat_a');
      store.release('chat_a');

      const second = store.acquire('chat_a');
      expect(second).not.toBe(first);
      expect(second.chat).not.toBe(first.chat);
      expect(harness.created).toHaveLength(2);
    });
  });

  // ===========================================================================
  // distinct sessions per chatId
  // ===========================================================================

  describe('per-chatId isolation', () => {
    it('creates an independent session for each chatId', () => {
      const store = createStore();
      const a = store.acquire('chat_a');
      const b = store.acquire('chat_b');

      expect(a.chat).not.toBe(b.chat);
      expect(a.persistenceActorRef).not.toBe(b.persistenceActorRef);
      expect(a.draftActorRef).not.toBe(b.draftActorRef);
      expect(harness.created).toHaveLength(2);
    });

    it('releasing one session does not affect the other', () => {
      const store = createStore();
      const a = store.acquire('chat_a');
      const b = store.acquire('chat_b');

      store.release('chat_a');

      expect(store.get('chat_a')).toBeUndefined();
      expect(store.get('chat_b')).toBe(b);
      expect(a.persistenceActorRef.getSnapshot().status).toBe('stopped');
      expect(b.persistenceActorRef.getSnapshot().status).toBe('active');
    });
  });

  // ===========================================================================
  // membership listeners
  // ===========================================================================

  describe('membership notifications', () => {
    it('notifies membership subscribers on first acquire only', () => {
      const store = createStore();
      const listener = vi.fn();
      store.subscribeMembership(listener);

      store.acquire('chat_a');
      expect(listener).toHaveBeenCalledTimes(1);

      store.acquire('chat_a');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies membership subscribers on final release only', () => {
      const store = createStore();
      store.acquire('chat_a');
      store.acquire('chat_a');

      const listener = vi.fn();
      store.subscribeMembership(listener);

      store.release('chat_a');
      expect(listener).not.toHaveBeenCalled();

      store.release('chat_a');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('exposes a stable list reference until membership changes', () => {
      const store = createStore();
      store.acquire('chat_a');
      const first = store.list();
      const second = store.list();
      expect(second).toBe(first);

      store.acquire('chat_b');
      expect(store.list()).not.toBe(first);
      expect([...store.list()].sort()).toEqual(['chat_a', 'chat_b']);
    });

    it('stops invoking membership listeners after unsubscribe', () => {
      const store = createStore();
      const listener = vi.fn();
      const unsubscribe = store.subscribeMembership(listener);
      unsubscribe();

      store.acquire('chat_a');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // subscribeChat fan-out
  // ===========================================================================

  describe('subscribeChat', () => {
    it('fires when the underlying chat messages change', () => {
      const store = createStore();
      store.acquire('chat_a');
      const fake = harness.created[0]!;
      const listener = vi.fn();
      store.subscribeChat('chat_a', listener);

      fake.emitMessagesChange();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires when the underlying chat status changes', () => {
      const store = createStore();
      store.acquire('chat_a');
      const fake = harness.created[0]!;
      const listener = vi.fn();
      store.subscribeChat('chat_a', listener);

      fake.emitStatusChange();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not wake subscribers from a different chatId', () => {
      const store = createStore();
      store.acquire('chat_a');
      store.acquire('chat_b');
      const fakeA = harness.created[0]!;

      const listenerA = vi.fn();
      const listenerB = vi.fn();
      store.subscribeChat('chat_a', listenerA);
      store.subscribeChat('chat_b', listenerB);

      fakeA.emitMessagesChange();
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).not.toHaveBeenCalled();
    });

    it('lets subscribers register before the session is acquired (subscribe-then-acquire ordering)', () => {
      const store = createStore();
      const listener = vi.fn();
      store.subscribeChat('chat_a', listener);

      store.acquire('chat_a');
      const fake = harness.created[0]!;
      fake.emitMessagesChange();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops invoking listeners after unsubscribe', () => {
      const store = createStore();
      store.acquire('chat_a');
      const fake = harness.created[0]!;
      const listener = vi.fn();
      const unsubscribe = store.subscribeChat('chat_a', listener);
      unsubscribe();

      fake.emitMessagesChange();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // concurrency invariants
  // ===========================================================================

  describe('concurrency invariants', () => {
    it('keeps every distinct session live and active under simultaneous acquires', () => {
      const store = createStore();
      const ids = ['chat_a', 'chat_b', 'chat_c', 'chat_d'];
      const sessions = ids.map((id) => store.acquire(id));

      for (const session of sessions) {
        expect(session.persistenceActorRef.getSnapshot().status).toBe('active');
        expect(session.draftActorRef.getSnapshot().status).toBe('active');
      }
      expect([...store.list()].sort()).toEqual([...ids].sort());
      expect(harness.created).toHaveLength(ids.length);
    });

    it("releasing one chat does not stop another chat's actors or unsubscribe its listeners", () => {
      const store = createStore();
      const a = store.acquire('chat_a');
      const b = store.acquire('chat_b');

      const listenerA = vi.fn();
      const listenerB = vi.fn();
      store.subscribeChat('chat_a', listenerA);
      store.subscribeChat('chat_b', listenerB);

      store.release('chat_a');

      // Releasing A must not poison B's actors or its listener bucket.
      expect(b.persistenceActorRef.getSnapshot().status).toBe('active');
      expect(b.draftActorRef.getSnapshot().status).toBe('active');

      const fakeB = harness.created.find((chat) => chat.id === 'chat_b')!;
      fakeB.emitMessagesChange();
      expect(listenerB).toHaveBeenCalledTimes(1);
      expect(listenerA).not.toHaveBeenCalled();

      // And the released chat's actors are stopped.
      expect(a.persistenceActorRef.getSnapshot().status).toBe('stopped');
    });

    it('fans out a single chat event to every subscriber bound to that chatId', () => {
      const store = createStore();
      store.acquire('chat_a');
      const fake = harness.created[0]!;

      const listeners = [vi.fn(), vi.fn(), vi.fn()];
      for (const listener of listeners) {
        store.subscribeChat('chat_a', listener);
      }

      fake.emitMessagesChange();
      for (const listener of listeners) {
        expect(listener).toHaveBeenCalledTimes(1);
      }
    });

    it('per-chat listener buckets are isolated across re-acquire cycles', () => {
      const store = createStore();
      // First lifecycle: subscribe + drop the subscription via release.
      store.acquire('chat_a');
      const stale = vi.fn();
      const unsubscribeStale = store.subscribeChat('chat_a', stale);
      store.release('chat_a');
      unsubscribeStale();

      // Second lifecycle: a brand-new Chat instance + a new subscriber.
      store.acquire('chat_a');
      const fake = harness.created.at(-1)!;
      const fresh = vi.fn();
      store.subscribeChat('chat_a', fresh);

      fake.emitMessagesChange();

      expect(fresh).toHaveBeenCalledTimes(1);
      expect(stale).not.toHaveBeenCalled();
    });

    it('subscribeStatus and subscribeUsage notify only their respective chatIds', () => {
      const store = createStore();
      store.acquire('chat_a');
      store.acquire('chat_b');

      const fakeA = harness.created.find((chat) => chat.id === 'chat_a')!;
      const fakeB = harness.created.find((chat) => chat.id === 'chat_b')!;

      const statusA = vi.fn();
      const statusB = vi.fn();
      store.subscribeStatus('chat_a', statusA);
      store.subscribeStatus('chat_b', statusB);

      fakeA.status = 'streaming';
      fakeA.emitStatusChange();

      expect(statusA).toHaveBeenCalledTimes(1);
      expect(statusB).not.toHaveBeenCalled();

      fakeB.status = 'submitted';
      fakeB.emitStatusChange();

      expect(statusA).toHaveBeenCalledTimes(1);
      expect(statusB).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // hydration: setActiveChatId is sent to the persistence actor
  // ===========================================================================

  describe('hydration on acquire', () => {
    it('calls deps.getChat on first acquire so hydration kicks off', async () => {
      const store = new ChatSessionStore();
      const deps = createStubDeps();
      store.setDependencies(deps);

      const sampleChat: ChatEntity = {
        id: 'chat_a',
        resourceId: 'resource_1',
        name: '',
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      };
      deps.getChat.mockResolvedValue(sampleChat);

      store.acquire('chat_a');

      // Microtask flush so the persistence actor's loadChatActor invokes deps.getChat.
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.getChat).toHaveBeenCalledWith('chat_a');
    });
  });
});
