---
title: 'Chat Draft Resurrection: IndexedDB Read‑Modify‑Write Race'
description: 'Sent chat messages reappear as drafts after reload because IndexedDbStorageProvider.updateChat is a non-atomic read-modify-write that races between the draft and message persistence pipelines.'
status: superseded
created: '2026-04-20'
updated: '2026-04-20'
category: investigation
related:
  - docs/policy/xstate-policy.md
  - docs/policy/filesystem-policy.md
  - docs/policy/storage-policy.md
---

# Chat Draft Resurrection: IndexedDB Read‑Modify‑Write Race

Investigation into why a chat message that was just sent reappears as a draft in the composer after switching chats or reloading the project.

## Executive Summary

Two independent XState actors persist into the same chat row in IndexedDB through `IndexedDbStorageProvider.updateChat`:

- **`persistDraftActor`** writes `{ draft }` (in `apps/ui/app/hooks/use-chat.tsx:76`).
- **`persistMessagesActor`** writes `{ messages }` (in `apps/ui/app/hooks/use-chat.tsx:130`).

`updateChat` performs `getChat → deepmerge → put` across **two separate IndexedDB transactions** with no per‑chat lock. When the user sends a message, the draft pipeline writes `draft=""` and the message pipeline writes the new `messages[]` concurrently. If the message pipeline's `getChat` lands inside the gap between the draft pipeline's read and write, it sees the old `draft="hello"`, then `deepmerge`s its own `{ messages }` patch over that stale snapshot and last‑writes wins — re‑saving the just‑sent text into the `draft` field. On the next chat load, `loadChatActor` populates the editor from `chat.draft`, and the previously sent message resurrects in the input box.

Recommended fix: collapse `getChat`/`put` into a single readwrite IndexedDB transaction (or serialize updates per `chatId` at the storage layer). Optionally, narrow the patch surface so each writer only mutates its declared field.

## Problem Statement

Symptom: Immediately after a user sends a message in a chat (e.g. "hello"), the message appears in the transcript and streams a response. Then, after one of the following events:

- Switching to another chat and back.
- Refreshing the project page.
- Cross‑tab sync from a peer tab.

…the previously sent message reappears in the chat composer as a draft. The user has not retyped it, did not press up‑arrow, and never invoked any "edit" affordance. It silently materializes inside the TipTap editor as if they were composing it again.

This is functionally a "ghost message" — the same text the user thought they shipped is now staring back at them, ready to be sent a second time.

## Methodology

The investigation walked the chat send/persist/load pipeline end to end, starting from `apps/ui/app/routes/projects_.$id/route.tsx` and following:

1. The TipTap editor → draft state path (`chat-textarea-desktop.tsx`, `use-chat-editor.ts`, `chat-textarea-types.ts`).
2. `useChatActions().sendMessage` (`apps/ui/app/hooks/use-chat.tsx`).
3. `draftMachine` and `chatPersistenceMachine` (`apps/ui/app/hooks/draft.machine.ts`, `apps/ui/app/hooks/chat-persistence.machine.ts`).
4. Storage layer (`apps/ui/app/db/indexeddb-storage.ts`) and the `updateChat` contract.
5. The reload path (`loadChatActor` → `initializeDraftRef` → `draftMachine.initializeFromChat`).

Cross‑referenced with the corresponding XState test suites for both machines to confirm the in‑process behavior is correct in isolation; the bug is at the storage boundary.

## Findings

### Finding 1: Two writers fight over the same chat row

Both pipelines call the same storage method but with different `ignoreKeys`:

```77:78:apps/ui/app/hooks/use-chat.tsx
        persistDraftActor: fromSafeAsync(async ({ input }) => {
          await updateChat(input.chatId, { draft: input.draft }, { ignoreKeys: ['draft'] });
        }),
```

```130:132:apps/ui/app/hooks/use-chat.tsx
        persistMessagesActor: fromSafeAsync(async ({ input }) => {
          await updateChat(input.chatId, { messages: input.messages }, { ignoreKeys: ['messages'] });
        }),
```

`ignoreKeys` only protects the _named_ key from being merged with the existing value (`customMerge` returns `target` instead of merging arrays/objects). It does **not** scope the write to that key — the entire `Chat` object is `put` back, including every other field that was read into `existingChat`.

So both actors are full‑row writers; the only thing that varies is which field they "intend" to mutate.

### Finding 2: `updateChat` is a non-atomic read‑modify‑write across two transactions

```242:305:apps/ui/app/db/indexeddb-storage.ts
  public async updateChat(
    chatId: string,
    update: PartialDeep<Chat>,
    options?: {
      ignoreKeys?: string[];
      noUpdatedAt?: boolean;
    },
  ): Promise<Chat | undefined> {
    const db = await this.getDb();
    const existingChat = await this.getChat(chatId);

    if (!existingChat) {
      return undefined;
    }
    // …deepmerge…
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.chatsStoreName, 'readwrite');
      const store = transaction.objectStore(this.chatsStoreName);
      const request = store.put(updatedChat);
      // …
    });
  }
```

The shape is:

1. `await this.getChat(chatId)` — opens its **own** `readonly` transaction (see `getChat` at line 307).
2. JavaScript microtask runs `deepmerge` synchronously.
3. A **separate** `readwrite` transaction is opened to `put(updatedChat)`.

There is no per‑`chatId` mutex, no transaction reuse, no version/etag check. The entire window between step 1's `request.onsuccess` and step 3's `transaction.oncomplete` is interruptible by another `updateChat` invocation that itself can interleave its own get/put.

IndexedDB serializes overlapping `readwrite` transactions on a store, but it does **not** prevent a fresh `readonly` transaction from observing the row _before_ a queued `readwrite` from another caller has been opened. The races below exploit exactly that.

### Finding 3: The sender pipeline schedules both writes back‑to‑back

```412:431:apps/ui/app/hooks/use-chat.tsx
      sendMessage(message: Parameters<UseChatReturn['sendMessage']>[0]) {
        // Clear draft when sending
        draftActorRef.send({ type: 'clearDraft' });

        // Clear any persisted error when starting a new request
        persistenceActorRef.send({ type: 'clearPersistedError' });

        // If currently streaming or submitted, queue the message and stop.
        // The pending message will be processed in onFinish(isAbort) after
        // the old makeRequest fully completes, avoiding concurrent requests.
        if (chat.status === 'streaming' || chat.status === 'submitted') {
          pendingMessageRef.current = message;
          void chat.stop();
          return;
        }

        // Normal path: no request in progress
        queuePersist([...chat.messages, message as MyUIMessage]);
        void chat.sendMessage(message);
      },
```

`clearDraft` enters `inputSaving.persisting` and immediately invokes `persistDraftActor` with an empty draft (no debounce):

```215:221:apps/ui/app/hooks/draft.machine.ts
        clearDraft: {
          actions: assign({
            draftText: '',
            draftImages: [],
            draftToolChoice: 'auto',
          }),
        },
```

```338:343:apps/ui/app/hooks/draft.machine.ts
            // Handle draft clearing with immediate persistence
            clearDraft: {
              target: 'persisting',
              guard: 'canPersist',
            },
```

`queuePersist` enters `messagePersistence.pending` and waits **100 ms** before invoking `persistMessagesActor`:

```95:95:apps/ui/app/hooks/chat-persistence.machine.ts
    persistDebounce: 100,
```

```181:202:apps/ui/app/hooks/chat-persistence.machine.ts
        pending: {
          after: {
            persistDebounce: {
              target: 'persisting',
              guard: 'hasPendingMessages',
            },
          },
```

So the _intent_ is: "draft cleared first, then 100 ms later messages are written." That is true at the actor‑invocation boundary, but as soon as both actors enter their async I/O, both are racing for the IndexedDB row independently — and the `getChat` inside each `updateChat` can resolve in any order.

### Finding 4: There is also an in‑flight typing writer that can extend the race window

While the user is typing "hello", `setDraftText` keeps re‑entering `inputSaving.pending` with a 200 ms debounce (`saveDebounce: 200` at `apps/ui/app/hooks/draft.machine.ts:137`). When the user stops typing for 200 ms (or simply releases focus and clicks Send), an in‑flight `persistDraftActor` may still be mid‑`getChat`/`put` writing `draft="hello"` at the moment `clearDraft` and `queuePersist` fire.

That gives **three** concurrent `updateChat` calls competing for the same row in a tight window: `persist(draft=hello)` (typing), `persist(draft="")` (clear), `persist(messages=[…hello])` (send). Each performs its own non‑atomic `get → merge → put`.

### Finding 5: The race that resurrects the draft

Concrete interleaving that produces the bug. `txn` denotes an IndexedDB transaction; `JS` denotes JS microtask work between transactions.

```
time   actor          op
────   ─────          ──
t0     A (typing)     getChat (txn R1) → existingChat { draft:"hell", messages:M0 }
t1     A              [JS] deepmerge → { draft:"hello", messages:M0 }
t2     A              put (txn W1) → row now { draft:"hello", messages:M0 }   ✓ committed

t3     User clicks Send
t4     B (clearDraft) getChat (txn R2) → existingChat { draft:"hello", messages:M0 }
t5     B              [JS] deepmerge → { draft:"", messages:M0 }
                       (B is still computing; put not yet scheduled)

t6     C (sendMsg)    getChat (txn R3) → existingChat { draft:"hello", messages:M0 }
                       (R3 runs concurrently with R2 because both are readonly,
                        and B has not yet opened its write txn)
t7     C              [JS] deepmerge → { draft:"hello", messages:M1 }
                                                ^^^^^^^^
                                          STALE — read before B's write committed

t8     B              put (txn W2) → row now { draft:"", messages:M0 }
t9     C              put (txn W3) → row now { draft:"hello", messages:M1 }   ✗ resurrected
```

After `t9`, IndexedDB stores `{ draft: "hello", messages: [user:hello, assistant:…] }`. The chat looks fine on screen because `useChat` keeps the live `messages` array in memory and the `draftMachine` context still has `draftText=""`. The corruption is invisible until the chat is reloaded.

### Finding 6: Reload faithfully resurrects the stale draft

`loadChatActor` is the only reader that re‑hydrates the `draftMachine`:

```111:129:apps/ui/app/hooks/use-chat.tsx
        loadChatActor: fromSafeAsync(async ({ input }) => {
          const loadedChat = await getChat(input.chatId);

          if (loadedChat) {
            setMessagesRef.current?.(loadedChat.messages);
            initializeDraftRef.current?.(loadedChat);
            // …
          }
          // …
          return { type: 'chatRetrieved', chat: loadedChat };
        }),
```

```243:245:apps/ui/app/hooks/use-chat.tsx
  initializeDraftRef.current = (loadedChat) => {
    draftActorRef.send({ type: 'initializeFromChat', chat: loadedChat });
  };
```

`initializeFromChat` reads `chat.draft.parts` and writes them straight into `context.draftText`/`context.draftImages`. The TipTap editor then syncs from `inputText` via the effect in `chat-textarea-desktop.tsx`, and the user sees their previously sent message in the composer.

Triggers for `loadChatActor`:

- Initial mount when `activeChatId` is set from `editor.machine.lastChatId` (page reload, route change).
- `setActiveChatId` on chat switch from `chat-history-selector.tsx`.
- Re‑mount of the `ChatProvider` (e.g. project switch or HMR).

### Finding 7: `ignoreKeys` is a partial mitigation, not a fix

Each call passes `ignoreKeys: [<own field>]`. This makes `customMerge` return `target` (the patch) for that key, so a stale array/object in `existingChat` does not get deep‑merged on top of the new value. That correctly protects the writer's own field from itself.

It does **not** protect:

- Other fields that the writer is not patching but is nonetheless re‑writing because `put` is full‑row.
- Concurrent writers from observing each other's pre‑commit state.

In other words `ignoreKeys` solves a merge‑shape problem; it does not solve a transactional isolation problem.

### Finding 8: Same hazard exists for every `updateChat` caller

`updateChat` is invoked from at least seven sites across the chat layer (`apps/ui/app/hooks/use-chat.tsx` lines 77, 80, 92, 131, 134, 137, plus `deleteChat` at line 367). Any pair of these can race against each other in the same way. For example:

- `persistErrorActor` ({ error }) racing with `persistMessagesActor` ({ messages }) on stream error.
- `persistEditDraftActor` racing with `persistDraftActor` while a user is editing one message and typing in the composer at the same time.
- Cross‑tab updates landing through `CrossTabCoordinator` while the active tab is mid‑update.

The draft resurrection is the most user‑visible manifestation; other races are likely silently corrupting `messageEdits`, `error`, or `messages` under load.

## Trade‑offs of Candidate Fixes

| Option                                             | Description                                                                                                                                                | Pros                                                                                                  | Cons                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Single‑transaction `updateChat`**             | Open one `readwrite` txn, perform `get` + `put` inside it via the same `IDBObjectStore`.                                                                   | Eliminates the read/write gap. IndexedDB guarantees atomicity within a transaction. Smallest change.  | Still operates on the full row; concurrent updates serialize but each still re‑writes every field.                         |
| **B. Per‑`chatId` async mutex in storage**         | Wrap `updateChat` in a `Map<chatId, Promise>` queue so calls for the same chat never overlap.                                                              | Independent of IDB semantics; covers any future storage backend. Simple to add.                       | Adds in‑process queue; only works inside one tab — needs `CrossTabCoordinator` integration to be airtight.                 |
| **C. Field‑scoped patches**                        | Replace `updateChat(chatId, { draft })` etc. with a `patchChat(chatId, key, value)` that only `put`s the changed field via a typed updater inside one txn. | Smallest blast radius; impossible to overwrite a sibling field. Plays well with conflict‑free merges. | Requires API churn at every call site; deepmerge semantics for nested fields (e.g. `messageEdits`) need explicit handling. |
| **D. In‑process serialization at the actor layer** | Funnel both `persistDraftActor` and `persistMessagesActor` through a single XState machine that owns a write queue.                                        | Zero storage changes; aligns with the "state machines own lifecycle" principle.                       | Doesn't help any non‑actor caller of `updateChat`; still leaves the storage primitive unsafe.                              |

Combining **A + C** (single‑txn updates, narrowed patch) is the most defensible fix: it makes the storage primitive safe for any caller and removes the "writer accidentally re‑saves a stale field" failure mode entirely.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                   | Priority | Effort | Impact                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------- |
| R1  | Refactor `IndexedDbStorageProvider.updateChat` (and `updateProject`, which has the same shape) to perform `get → merge → put` inside a **single `readwrite` transaction**. Use the existing `transaction` to read via `store.get(chatId)` and only resolve once `transaction.oncomplete` fires.          | P0       | Low    | High — removes the resurrection race for every caller.                                 |
| R2  | Add a per‑`chatId` async mutex around `updateChat` (in addition to R1) so the in‑process actors do not even attempt to interleave. This protects against future storage backends and provides a single chokepoint for `CrossTabCoordinator` invalidation.                                                | P1       | Low    | High — defense in depth, makes other races (error vs. messages) impossible too.        |
| R3  | Introduce a `patchChat<K extends keyof Chat>(chatId, key, value)` helper used by `persistDraftActor`, `persistMessagesActor`, `persistErrorActor`, etc. The helper writes only the named field (no full‑row `put`) and removes the need for `ignoreKeys`.                                                | P1       | Medium | High — eliminates the entire class of "I read everything, I write everything" hazards. |
| R4  | Add a regression test in `apps/ui/app/db/indexeddb-storage.test.ts` (or a new file) that fires `updateChat({ draft: "x" })` and `updateChat({ messages: [...] })` concurrently a few hundred times and asserts the final row equals `{ draft: "x", messages: [...] }`. Should fail today, pass after R1. | P0       | Low    | High — locks the fix in.                                                               |
| R5  | Audit `loadChatActor` to drop `chat.draft` when it equals the text of the most recent user message in `chat.messages` (or when the most recent message metadata indicates it was just sent). Belt‑and‑suspenders mitigation that masks any future regressions.                                           | P3       | Low    | Low — last‑resort guard, not a fix.                                                    |
| R6  | Document in `docs/policy/xstate-policy.md` (or a new storage‑policy doc) that any storage primitive consumed by multiple actors must guarantee atomic read‑modify‑write per logical row.                                                                                                                 | P2       | Low    | Medium — prevents the same shape of bug elsewhere.                                     |

R1 + R4 alone resolve the user‑visible bug. R2 and R3 harden the storage layer against the broader family of races that the same primitive enables.

## Code Examples

### Sketch of R1: single‑transaction `updateChat`

```typescript
public async updateChat(
  chatId: string,
  update: PartialDeep<Chat>,
  options?: { ignoreKeys?: string[]; noUpdatedAt?: boolean },
): Promise<Chat | undefined> {
  const db = await this.getDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(this.chatsStoreName, 'readwrite');
    const store = transaction.objectStore(this.chatsStoreName);

    const getRequest = store.get(chatId);
    let updatedChat: Chat | undefined;

    getRequest.onsuccess = () => {
      const existingChat = getRequest.result as Chat | undefined;
      if (!existingChat) {
        return; // resolve(undefined) on transaction.oncomplete
      }

      const isFullChat = 'id' in update && update.id === chatId;
      if (isFullChat) {
        updatedChat = update as Chat;
      } else {
        const mergeIgnoreKeys = new Set(options?.ignoreKeys ?? []);
        const optionalParameters = options?.noUpdatedAt ? {} : { updatedAt: Date.now() };
        updatedChat = deepmerge(existingChat, { ...update, ...optionalParameters }, {
          customMerge(key) {
            if (mergeIgnoreKeys.has(key)) {
              return (_source: unknown, target: unknown) => target;
            }
            return undefined;
          },
        }) as Chat;
      }

      store.put(updatedChat);
    };

    getRequest.onerror = () => reject(getRequest.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => {
      db.close();
      resolve(updatedChat);
    };
  });
}
```

The critical change: `store.get` and `store.put` execute inside the same `readwrite` transaction. Any other `updateChat` call for the same store is queued behind this one by IndexedDB itself.

### Sketch of R4: regression test

```typescript
it('does not lose concurrent updates to disjoint fields', async () => {
  const storage = new IndexedDbStorageProvider();
  const chat = await storage.createChat({
    /* … */
  });

  await Promise.all([
    storage.updateChat(chat.id, { draft: makeDraft('hello') }, { ignoreKeys: ['draft'] }),
    storage.updateChat(chat.id, { messages: [userMessage('hello')] }, { ignoreKeys: ['messages'] }),
  ]);

  // Caller A's intent: draft becomes 'hello'.
  // Caller B's intent: messages becomes [userMessage('hello')].
  // Without atomic updateChat, the final row may have draft='' AND messages=[hello]
  // (race won by A→B) or draft='hello' AND messages=[hello] (race won by B→A
  // reading stale draft). Either is acceptable as long as both writers' fields are
  // their last-written values:
  const finalChat = await storage.getChat(chat.id);
  expect(finalChat?.messages).toEqual([userMessage('hello')]);
  expect(finalChat?.draft.parts.find((p) => p.type === 'text')?.text).toBe('hello');
});
```

A stricter version of this test should run the pair many times and assert the invariant holds every iteration; the bug is timing‑dependent and a single run may pass by luck.

## Diagrams

```mermaid
sequenceDiagram
    participant U as User
    participant DM as draftMachine
    participant CPM as chatPersistenceMachine
    participant DB as IndexedDB

    Note over U,DB: User has typed "hello"; persistDraftActor (A) just committed draft="hello"

    U->>DM: clearDraft (via sendMessage)
    activate DM
    DM->>DB: updateChat({ draft: "" }) [B]
    Note right of DB: B.getChat (txn R2)<br/>→ { draft:"hello", messages:M0 }
    deactivate DM

    U->>CPM: queuePersist([…, hello]) (via sendMessage)
    Note right of CPM: 100ms debounce
    CPM-->>CPM: debounce expires
    activate CPM
    CPM->>DB: updateChat({ messages: M1 }) [C]
    Note right of DB: C.getChat (txn R3) runs concurrently<br/>with R2 (both readonly)<br/>→ { draft:"hello", messages:M0 }
    deactivate CPM

    DB->>DB: B.put (txn W2) commits<br/>{ draft:"", messages:M0 }
    DB->>DB: C.put (txn W3) commits<br/>{ draft:"hello", messages:M1 }

    Note over DB: Final row: { draft:"hello", messages:M1 }<br/>Stale draft survived.

    U->>U: Reload
    U->>DB: loadChatActor.getChat
    DB-->>U: { draft:"hello", messages:M1 }
    U->>DM: initializeFromChat
    Note over U,DM: Composer shows "hello" again.
```

## References

- `apps/ui/app/db/indexeddb-storage.ts` — `updateChat`, `getChat` (the broken primitive).
- `apps/ui/app/hooks/use-chat.tsx` — `persistDraftActor`, `persistMessagesActor`, `loadChatActor`, `initializeDraftRef`.
- `apps/ui/app/hooks/draft.machine.ts` — `clearDraft`, `inputSaving` parallel state, `initializeFromChat`.
- `apps/ui/app/hooks/chat-persistence.machine.ts` — `messagePersistence` debounce and persistence flow.
- [IndexedDB transaction lifetime — MDN](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction#transaction_lifetime).
- Related policy: `docs/policy/xstate-policy.md` (state machines own lifecycle and state logic).

## Appendix: All `updateChat` call sites

| Site                       | Field patched      | `ignoreKeys`       | Hazard                                                                             |
| -------------------------- | ------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| `use-chat.tsx:77`          | `draft`            | `['draft']`        | Races with messages, error, edits.                                                 |
| `use-chat.tsx:80`          | `messageEdits`     | `['messageEdits']` | Races with draft and messages.                                                     |
| `use-chat.tsx:92`          | `messageEdits`     | `['messageEdits']` | Same as above.                                                                     |
| `use-chat.tsx:131`         | `messages`         | `['messages']`     | Races with draft and error.                                                        |
| `use-chat.tsx:134`         | `error`            | `['error']`        | Races with messages.                                                               |
| `use-chat.tsx:137`         | `error: undefined` | `['error']`        | Same as above.                                                                     |
| `indexeddb-storage.ts:367` | `deletedAt`        | none               | Will lose any in‑flight draft/message writes that started before but commit after. |

Every row in this table is exposed to the same race shape; R1 fixes the lot.
