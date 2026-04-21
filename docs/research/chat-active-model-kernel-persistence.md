---
title: 'Chat-Scoped Active Model & Kernel Persistence'
description: 'The chat textarea reads model and kernel from globally-shared cookies, so changing them anywhere mutates the in-flight chat. Investigate per-chat persistence with cookie fallback for fresh chats.'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
category: architecture
related:
  - docs/policy/storage-policy.md
  - docs/policy/xstate-policy.md
  - docs/research/chat-draft-resurrection-race.md
---

# Chat-Scoped Active Model & Kernel Persistence

Investigate moving the "currently selected chat model" and "currently selected CAD kernel" from a single global cookie into per-`Chat` persistence, with the cookie demoted to a default-only role for fresh chats.

## Executive Summary

`useModels()` and `useKernel()` are thin wrappers around `useCookie(cookieName.chatModel)` / `useCookie(cookieName.cadKernel)`. The cookie store is a process-wide reactive `useSyncExternalStore`, so every component subscribed to either cookie re-renders whenever any consumer (any selector, any settings dialog, any other open chat) writes to it. The chat textarea has no chat-local state for model/kernel — it reads the cookie, captures it via a `kernelRef` at submit time, and stamps the value into outgoing `MyUIMessage.metadata`. The wire format is already per-message (`apps/api/app/api/chat/chat.controller.ts:204` reads `lastHumanMessage.metadata.model`/`kernel`), but the UI has no concept of a chat owning its own active model/kernel between turns or across reloads. Adding `activeModel`/`activeKernel` fields to the `Chat` row and a `useActiveChatModel()` / `useActiveChatKernel()` hook that resolves chat-local state first and falls back to the cookie cleanly fixes the cross-chat bleed without changing the wire format or the message-level metadata.

## Problem Statement

The user-visible symptom: with chat A in flight (using model X / kernel `openscad`), opening Settings → Models or simply switching the model on a different chat tab updates the cookie. The textarea on chat A snaps to the new model/kernel because it is subscribed to the same cookie store. The user's next message in chat A is sent with the wrong model/kernel — typically a kernel mismatch is the worst case because it changes the system prompt, tool surface, and code-format the agent generates against the remaining conversation context.

The root architectural issue: the cookie is treated as the _only_ source of truth for "what model/kernel does this chat use right now". There is no per-chat state. Two independent surfaces want to mutate the same value:

1. **Global default** — what model/kernel does a _new_ chat start with? Naturally a user-level preference, cookie-shaped.
2. **In-chat selection** — what model/kernel is _this_ chat currently configured for? Naturally chat-shaped.

Today (1) and (2) are conflated.

## Methodology

- Mapped every consumer of `useModels()` / `useKernel()` via Grep across `apps/ui`.
- Read the cookie store implementation (`apps/ui/app/hooks/use-cookie.ts`) to confirm the global notification model.
- Traced the submit pipeline from `chat-textarea-types.ts` through `chat-history.tsx` to `useChatActions.sendMessage`, then to the API.
- Verified the API extracts model/kernel from per-message metadata in `apps/api/app/api/chat/chat.controller.ts`.
- Inspected the `Chat` schema (`libs/chat/src/types/chat.types.ts`) and `StorageProvider` contract (`apps/ui/app/types/storage.types.ts`) to confirm no existing per-chat fields and to identify the atomic write primitive (`patchChat`).

## Findings

### Finding 1: Cookie store broadcasts to every subscriber globally

`apps/ui/app/hooks/use-cookie.ts` implements a singleton `cookieStore` with a `Map<string, Set<Listener>>`. Every `useCookie(name, default)` call subscribes via `useSyncExternalStore` to `name`, and any `update(name, v)` calls all listeners. There is no concept of scope.

```81:127:apps/ui/app/hooks/use-cookie.ts
export const useCookie = <T>(name: CookieName, defaultValue: T) => {
  const cookieName = `${metaConfig.cookiePrefix}${name}`;
  // ...
  const value = useSyncExternalStore((listener) => store.subscribe(cookieName, listener), selector, selector);
  return [value, update, remove] as const;
};
```

This is the right primitive for _user preferences_ but the wrong primitive for _per-resource configuration_.

### Finding 2: `useModels` and `useKernel` are pure cookie wrappers

Both hooks have no chat-awareness. They return the cookie value plus a setter that writes back to the cookie. There is no `chatId` parameter, no opt-in to chat-scoped behavior.

```52:80:apps/ui/app/hooks/use-models.tsx
export const useModels = () => {
  // ...
  const [selectedModelId, setSelectedModelId] = useCookie(cookieName.chatModel, defaultChatModel);
  // ...
  const selectedModel = useMemo<ResolvedModel>(
    () => buildResolved(selectedModelId, modelById.get(selectedModelId)),
    [modelById, selectedModelId],
  );
  return { data, isLoading, selectedModel, selectedModelId, setSelectedModelId, resolveModel };
};
```

```10:17:apps/ui/app/hooks/use-kernel.tsx
export const useKernel = () => {
  const [kernel, setKernel] = useCookie<KernelProvider>(cookieName.cadKernel, defaultKernel);
  const selectedKernel = kernelById.get(kernel);
  return { kernel, setKernel, selectedKernel };
};
```

### Finding 3: The wire format is already per-message; only the UI is global

The textarea hands the cookie-derived `model` / `kernel` to `chat-history.tsx`'s `onSubmit`, which stamps them into the user message's metadata before `sendMessage`:

```117:136:apps/ui/app/routes/projects_.$id/chat-history.tsx
const onSubmit: ChatTextareaProperties['onSubmit'] = useCallback(
  async ({ content, model, metadata, imageUrls }) => {
    const userMessage = createMessage({
      content,
      role: messageRole.user,
      metadata: {
        ...metadata,
        kernel: kernelRef.current,
        model,
        status: messageStatus.pending,
        testingEnabled: testingEnabledRef.current,
      },
      imageUrls,
    });
    sendMessage(userMessage);
  },
  [sendMessage],
);
```

The API extracts both fields from the _last user message_:

```204:228:apps/api/app/api/chat/chat.controller.ts
private extractRequestConfig(body: CreateChatDto): ChatRequestConfig {
  const lastHumanMessage = body.messages.findLast((message) => message.role === 'user');
  // ...
  const messageModel = lastHumanMessage.metadata?.model;
  if (!messageModel) {
    throw new Error('Message model is required');
  }
  return {
    modelId: messageModel,
    kernel: lastHumanMessage.metadata?.kernel ?? 'openscad',
    // ...
  };
}
```

**Implication**: chat-scoped persistence is purely a UI concern. The API contract does not change. Existing message history is untouched. Backfilling chat-local fields can derive from the last `metadata.model` / `metadata.kernel` already present in `chat.messages`.

### Finding 4: `Chat` schema has no model/kernel fields

```40:51:libs/chat/src/types/chat.types.ts
export type Chat = {
  id: string;
  resourceId: string;
  name: string;
  messages: MyUIMessage[];
  draft?: MyUIMessage;
  messageEdits?: Record<string, MyUIMessage>;
  error?: ChatError;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};
```

No `activeModel` or `activeKernel`. The only per-chat persistence of these values today is implicit: the most recent message in `messages` happens to carry them in its metadata.

### Finding 5: Storage layer already has the atomic primitive we need

`StorageProvider.patchChat<K extends keyof Chat>(chatId, key, value)` is the field-scoped atomic writer mandated by the storage policy (the same primitive that fixed the draft-resurrection race in `docs/research/chat-draft-resurrection-race.md`):

```49:49:apps/ui/app/types/storage.types.ts
patchChat<K extends keyof Chat>(chatId: string, key: K, value: Chat[K]): Promise<Chat | undefined>;
```

Adding `activeModel` and `activeKernel` to `Chat` automatically yields type-safe atomic patches: `patchChat(id, 'activeModel', 'gpt-5')` with no read-modify-write race risk.

### Finding 6: Inventory of model/kernel consumers

| File                                                           | Reads                             | Writes                        | Scope       | Risk                                                                 |
| -------------------------------------------------------------- | --------------------------------- | ----------------------------- | ----------- | -------------------------------------------------------------------- |
| `apps/ui/app/components/chat/chat-textarea-types.ts`           | `selectedModel` (for submit)      | —                             | Per-chat    | **High**: cookie change rewrites in-flight selection.                |
| `apps/ui/app/components/chat/chat-textarea-desktop.tsx`        | `selectedKernel` (for label)      | —                             | Per-chat    | **High**: label flips when cookie changes elsewhere.                 |
| `apps/ui/app/components/chat/chat-textarea-mobile.tsx`         | hardcoded `'openscad'` (line 155) | —                             | Per-chat    | **Bug**: kernel selector label always says OpenSCAD on mobile.       |
| `apps/ui/app/components/chat/chat-model-selector.tsx`          | `selectedModel`                   | `setSelectedModelId` → cookie | Mixed       | **High**: clicking from inside chat A changes chat B's textarea too. |
| `apps/ui/app/components/chat/chat-kernel-selector.tsx`         | `kernel`                          | `setKernel` → cookie          | Mixed       | **High**: same as above.                                             |
| `apps/ui/app/routes/projects_.$id/chat-history.tsx`            | `kernel` (for outgoing metadata)  | —                             | Per-chat    | **High**: stamps cookie value at submit.                             |
| `apps/ui/app/routes/projects_.$id/chat-stack-trace.tsx`        | `selectedModel`, `kernel`         | —                             | Per-chat    | **High**: "Fix with AI" uses cookie, ignores chat history.           |
| `apps/ui/app/routes/projects_.$id/chat-history-status.tsx`     | derives model from last message   | —                             | Per-chat    | None — already chat-scoped.                                          |
| `apps/ui/app/routes/projects_.$id/chat-message-data-usage.tsx` | derives from per-turn usage data  | —                             | Per-message | None.                                                                |
| `apps/ui/app/routes/projects_.$id/chat-examples.tsx`           | `selectedModel` (icon)            | —                             | Per-chat    | Cosmetic.                                                            |
| `apps/ui/app/components/settings/model-settings.tsx`           | `selectedModel`                   | `setSelectedModelId` → cookie | Global pref | None — settings is the right place to set the global default.        |
| `apps/ui/app/routes/_index/cta-section.tsx`                    | `kernel` (project creation)       | `setKernel` → cookie          | Pre-chat    | None — no chat exists yet; cookie is the legitimate source.          |
| `apps/ui/app/routes/_index/route.tsx`                          | `kernel` (project creation)       | `setKernel` → cookie          | Pre-chat    | None.                                                                |
| `apps/ui/app/routes/projects_.new/route.tsx`                   | `kernel` (project creation)       | `setKernel` → cookie          | Pre-chat    | None.                                                                |
| `apps/ui/app/routes/projects_.library/route.tsx`               | `kernel` (project list view)      | `setKernel` → cookie          | Global pref | None.                                                                |
| `apps/ui/app/hooks/use-all-usage.ts`                           | `resolveModel` (helper)           | —                             | Read-only   | None.                                                                |

The high-risk callers cluster in two locations: the chat textarea (read path) and the model/kernel selectors (write path). All of them sit inside a `ChatSessionProvider` or its analogue, so they have a `chatId` available.

### Finding 7: Mobile textarea has a separate hardcoded-kernel bug

```155:155:apps/ui/app/components/chat/chat-textarea-mobile.tsx
const selectedKernel = kernelConfigurations.find((k) => k.id === 'openscad');
```

Independent of the broader refactor, this line reads as a placeholder that was never wired up. Any fix here should consume the same chat-scoped resolution path as desktop.

### Finding 8: `chat-history-status.tsx` already does the "right thing" by reading the last message

The status row scans messages backward looking for the most recent `metadata.model`. This is effectively a read-only derived view of "the chat's current model". A fully consistent design would have this view read the chat's `activeModel` field (which is itself derived from the last successful turn) so that _display_ and _next-turn target_ never disagree.

### Finding 9: `ChatSession` does not own model/kernel today

`ChatSessionStore` and `ChatSession` types in `apps/ui/app/services/chat-session-store.ts` carry the AI SDK `Chat` instance and the persistence actor, but no model/kernel state. Adding chat-local state without pushing it through the store is fine because `Chat` already lives in IndexedDB and is the canonical source of truth — we just need a hook to read+subscribe.

## Trade-offs

Comparison of design options for where chat-active model/kernel state lives:

| Option                                                                       | Persistence    | Cookie role                                        | First-message scoping | Refactor cost | Multi-chat correctness |
| ---------------------------------------------------------------------------- | -------------- | -------------------------------------------------- | --------------------- | ------------- | ---------------------- |
| **A. Status quo + derive from last message**                                 | Implicit (msg) | Sole authority                                     | None                  | Trivial       | ❌ Cookie still bleeds |
| **B. `Chat.activeModel`/`activeKernel` fields**                              | Chat row       | Default for new chat                               | ✅ Yes                | Medium        | ✅ Full                |
| **C. `useActiveChatModel()`/`useActiveChatKernel()` hook + chat row fields** | Chat row       | Fallback only (read), default for new chat (write) | ✅ Yes                | Medium        | ✅ Full                |
| **D. Refactor `useModels`/`useKernel` to take a chatId**                     | Chat row       | Default + opt-out                                  | ✅ Yes                | High          | ✅ Full but invasive   |

**Recommendation**: **Option C** (the user's stated design intuition). Add `Chat.activeModel`/`Chat.activeKernel` (Option B's data shape) and introduce a thin chat-scoped hook layer that resolves chat-local first, cookie second. Leave `useModels()`/`useKernel()` as-is for the legitimate global-default surfaces (settings, project creation pre-chat). This minimises blast radius — only the chat-scoped surfaces (~6 files) flip to the new hook.

## Recommendations

| #   | Action                                                                                                                                                                                                                  | Priority | Effort  | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------ |
| R1  | Extend `Chat` schema with optional `activeModel?: string` and `activeKernel?: KernelProvider` fields.                                                                                                                   | P0       | Low     | High   |
| R2  | Bump `IndexedDbStorageProvider.version` and write a migration that backfills `activeModel`/`activeKernel` from the last user message metadata.                                                                          | P0       | Low     | High   |
| R3  | Seed `activeModel = cookie.chatModel` and `activeKernel = cookie.cadKernel ?? 'openscad'` on `createChat`.                                                                                                              | P0       | Low     | High   |
| R4  | Add `useActiveChatModel()` and `useActiveChatKernel()` hooks that read from the focused `Chat` row first, fall back to `useModels()` / `useKernel()`.                                                                   | P0       | Medium  | High   |
| R5  | Make the setters from R4 call `patchChat(chatId, 'activeModel', id)` (and optionally also write the cookie if a "set as default" UX is desired).                                                                        | P0       | Low     | High   |
| R6  | Flip `chat-textarea-types.ts`, `chat-textarea-desktop.tsx`, `chat-textarea-mobile.tsx`, `chat-model-selector.tsx`, `chat-kernel-selector.tsx`, `chat-history.tsx`, and `chat-stack-trace.tsx` to consume the new hooks. | P0       | Medium  | High   |
| R7  | Fix `chat-textarea-mobile.tsx`'s hardcoded `'openscad'` lookup as part of the R6 refactor.                                                                                                                              | P0       | Trivial | Medium |
| R8  | Make `chat-history-status.tsx` read `chat.activeModel` instead of scanning `messages` so display and next-turn target never disagree.                                                                                   | P1       | Low     | Low    |
| R9  | Leave settings, project-creation, and library surfaces on `useModels()` / `useKernel()` — those are legitimate global-default writes.                                                                                   | P0       | None    | High   |
| R10 | Consider exposing a "set as default for new chats" affordance in the in-chat selectors so power users can promote a chat-local choice to the cookie.                                                                    | P2       | Low     | Low    |
| R11 | Keep the wire format unchanged — continue stamping `metadata.model` and `metadata.kernel` on outgoing user messages from the chat-local active values.                                                                  | P0       | None    | High   |

## Proposed Architecture

### Data shape

```typescript
// libs/chat/src/types/chat.types.ts
export type Chat = {
  id: string;
  resourceId: string;
  name: string;
  messages: MyUIMessage[];
  draft?: MyUIMessage;
  messageEdits?: Record<string, MyUIMessage>;
  error?: ChatError;
  /** Default model for this chat's next turn. Seeded from cookie at creation. */
  activeModel?: string;
  /** Default CAD kernel for this chat's next turn. Seeded from cookie at creation. */
  activeKernel?: KernelProvider;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};
```

### Hook surface

```typescript
// apps/ui/app/hooks/use-active-chat-model.ts
export const useActiveChatModel = () => {
  const { chatId } = useChatSession(); // existing context
  const { selectedModel: cookieModel, resolveModel, setSelectedModelId: setCookieModel } = useModels();
  const { patchChat } = useChats(/* resourceId */);
  const chat = useChatSelector((s) => s.chat); // the persisted Chat row

  const activeModel = useMemo(
    () => (chat.activeModel ? resolveModel(chat.activeModel) : cookieModel),
    [chat.activeModel, cookieModel, resolveModel],
  );

  const setActiveModel = useCallback(
    async (id: string) => {
      await patchChat(chatId, 'activeModel', id);
      // optional: setCookieModel(id) when called from a "set as default" UX
    },
    [chatId, patchChat],
  );

  return { selectedModel: activeModel, setActiveModel };
};
```

`useActiveChatKernel()` mirrors this shape against `cookieName.cadKernel`.

### Selector behavior

`ChatModelSelector` / `ChatKernelSelector` already accept `onSelect`. Their internal `useModels()`/`useKernel()` consumption is the only thing that needs to change — swap to `useActiveChatModel()`/`useActiveChatKernel()`. Because they live inside the chat panel they always have a chat session in context, so the resolution is unambiguous.

For `model-settings.tsx` (Settings → Models) and the homepage / project-creation surfaces, no change: they continue to use `useModels()`/`useKernel()` directly because they really do mean "global preference".

### Wire format

Unchanged. `chat-history.tsx` still stamps `metadata.model = activeModel.id` and `metadata.kernel = activeKernel` into the outgoing message. The API still reads from `lastHumanMessage.metadata`. Backfill from message history is therefore lossless and re-derivable.

## Diagrams

### Current state

```
┌──────────────┐  read    ┌─────────────────────┐
│  Chat A      │ ───────▶ │ cookieStore         │ ◀───── write ── Settings
│  textarea    │          │   chatModel         │ ◀───── write ── Chat B selector
└──────────────┘          │   cadKernel         │ ◀───── write ── Chat C selector
       │                  └─────────────────────┘
       │ stamps cookie value
       ▼
   metadata.model
   metadata.kernel  ──▶ POST /v1/chat
```

### Proposed state

```
┌──────────────┐  read   ┌────────────────────┐
│  Chat A      │ ──────▶ │ Chat.activeModel   │ ◀── patchChat(A, 'activeModel') ── Chat A selector only
│  textarea    │         │ Chat.activeKernel  │
└──────────────┘         └────────────────────┘
       │                          │ fallback when undefined
       │                          ▼
       │                  ┌────────────────┐
       │                  │ cookieStore    │ ◀── Settings, project-creation
       │                  └────────────────┘
       │
       │ stamps Chat A's activeModel/activeKernel
       ▼
   metadata.model
   metadata.kernel  ──▶ POST /v1/chat   (unchanged)
```

## Migration

The IDB version bump is purely additive (two optional fields on existing rows). The migration runs once on next open and backfills:

```typescript
// Pseudo-code inside the upgrade callback
for (const chat of allChats) {
  if (chat.activeModel === undefined || chat.activeKernel === undefined) {
    const lastUserMessage = chat.messages.findLast((m) => m.role === 'user');
    const activeModel = chat.activeModel ?? lastUserMessage?.metadata?.model;
    const activeKernel = chat.activeKernel ?? lastUserMessage?.metadata?.kernel;
    if (activeModel || activeKernel) {
      // single put; updatedAt unchanged (noUpdatedAt path)
      await store.put({ ...chat, activeModel, activeKernel });
    }
  }
}
```

For chats with no user messages yet, leaving the fields undefined is correct — the runtime resolver falls back to the cookie.

## Edge Cases

- **"Fix with AI" from a stack trace** (`chat-stack-trace.tsx`): currently reads cookies. Should consume `useActiveChatModel()` / `useActiveChatKernel()` so the synthetic message inherits the chat's current configuration, not a possibly-unrelated cookie value.
- **Project creation from homepage**: no chat exists yet, so the cookie is the only available default. The newly created chat's `activeModel`/`activeKernel` should be initialised from the cookie at creation time so the choice on the homepage carries forward to the seeded chat.
- **Duplicating a chat** (`duplicateChat` in storage): copy `activeModel`/`activeKernel` along with messages so the duplicate behaves identically.
- **Branching from a past message** (if/when implemented): the new chat should inherit `activeModel`/`activeKernel` from the source chat at branch time, not the cookie.
- **Chat with messages but no user message yet** (rare, e.g. system-generated): backfill yields undefined → cookie fallback applies.
- **Cookie missing on first visit** (cleared/private window): `useCookie` already returns `defaultChatModel` / `'openscad'`. Behaviour is identical to today.
- **Multiple browser tabs editing the same chat**: cross-tab sync goes through the existing `CrossTabCoordinator`. `patchChat` is atomic; the IDB row is the single source of truth across tabs.

## Out of Scope

- **Per-message model/kernel override UI**. The wire format already supports it (each message carries its own metadata), but exposing it in the UI is a separate feature.
- **Backend-side chat-level model/kernel persistence**. The server is stateless w.r.t. defaults; it reads what the client sends.
- **Replacing the cookie entirely**. The cookie remains the legitimate default-of-defaults for fresh chats and for non-chat surfaces (settings, project creation). Eliminating it would push that responsibility into a separate user-preferences store, which is a larger refactor with its own design questions.
- **Cross-device sync of the chat-local choice**. Today chats are local-first in IDB; if/when chats sync server-side, `activeModel`/`activeKernel` will sync along with the rest of the row.

## Cookie Surface Audit (E8 / R9)

Confirms which `useModels()` / `useKernel()` call sites are intentionally cookie-bound (no chat scope) vs which were flipped to the chat-scoped resolvers. The chat-scoped resolvers (`useActiveChatModel`, `useActiveChatKernel`) are the only legitimate readers/writers when a chat is in scope; everywhere else the cookie remains the canonical default.

### Flipped to chat-scoped resolvers

| Call site                                               | Previously                              | Now                                                | Test                             |
| ------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- | -------------------------------- |
| `apps/ui/app/components/chat/chat-textarea-types.ts`    | `useModels` (selectedModel)             | `useActiveChatModel`                               | `chat-textarea-types.test.tsx`   |
| `apps/ui/app/components/chat/chat-textarea-desktop.tsx` | `useKernel` (label)                     | `useActiveChatKernel`                              | `chat-textarea-desktop.test.tsx` |
| `apps/ui/app/components/chat/chat-textarea-mobile.tsx`  | hardcoded `'openscad'`                  | `useActiveChatKernel`                              | `chat-textarea-mobile.test.tsx`  |
| `apps/ui/app/components/chat/chat-model-selector.tsx`   | `useModels.setSelectedModelId`          | `useActiveChatModel.setActiveModel` (dual-write)   | `chat-model-selector.test.tsx`   |
| `apps/ui/app/components/chat/chat-kernel-selector.tsx`  | `useKernel.setKernel`                   | `useActiveChatKernel.setActiveKernel` (dual-write) | `chat-kernel-selector.test.tsx`  |
| `apps/ui/app/routes/projects_.$id/chat-history.tsx`     | `useKernel` (metadata stamp)            | `useActiveChatKernel`                              | `chat-history.test.tsx`          |
| `apps/ui/app/routes/projects_.$id/chat-stack-trace.tsx` | `useModels` + `useKernel` (Fix-with-AI) | `useActiveChatModel` + `useActiveChatKernel`       | `chat-stack-trace.test.tsx`      |
| `apps/ui/app/routes/projects_.$id/chat-examples.tsx`    | `useModels` (one-click prompts)         | `useActiveChatModel`                               | `chat-examples.test.tsx`         |

### Intentionally cookie-bound (no chat scope, do NOT flip)

| Call site                                                      | Reason                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/app/routes/_index/route.tsx`                          | Homepage — chat does not exist yet; cookie is the only legitimate default and is read into `createProject({ activeModel, activeKernel })` to seed the row. |
| `apps/ui/app/routes/_index/cta-section.tsx`                    | Landing CTA, same as above.                                                                                                                                |
| `apps/ui/app/routes/projects_.library/route.tsx`               | Project creation flow — no active chat in scope.                                                                                                           |
| `apps/ui/app/routes/projects_.new/route.tsx`                   | Same.                                                                                                                                                      |
| `apps/ui/app/components/settings/model-settings.tsx`           | Settings dialog updates the cookie _as a default_; chat-scoped overrides win for in-flight chats per `useActiveChatModel`.                                 |
| `apps/ui/app/routes/projects_.$id/chat-message-data-usage.tsx` | Calls `resolveModel(messageMetadata.model)` to look up _historical_ per-message model ids; not the active selection.                                       |
| `apps/ui/app/hooks/use-all-usage.ts`                           | Same: catalogue lookup over historical usage rows.                                                                                                         |
| `apps/ui/app/root.tsx`                                         | Imports the `getModels()` fetcher (not the hook).                                                                                                          |
| `apps/ui/app/hooks/use-active-chat-model.ts`                   | Composes `useModels` for cookie fallback — by design.                                                                                                      |
| `apps/ui/app/hooks/use-active-chat-kernel.ts`                  | Composes `useKernel` for cookie fallback — by design.                                                                                                      |

### `ResolvedModel` type imports

`chat-textarea-types.ts`, `chat-textarea-desktop.tsx`, `chat-textarea-mobile.tsx`, and the corresponding tests import `ResolvedModel` as a type-only symbol from `#hooks/use-models.js`. This stays — it is the canonical resolved-display type, owned by `useModels` for both cookie and chat-scoped resolvers.

## References

- Storage policy: `docs/policy/storage-policy.md` — `patchChat` is the atomic field-scoped writer mandated for single-field updates.
- Related race fix: `docs/research/chat-draft-resurrection-race.md` — same atomic-write primitive pattern.
- AI SDK chat lifecycle: `apps/ui/app/services/chat-session-store.ts`.
- API request shape: `apps/api/app/api/chat/chat.controller.ts:204` (`extractRequestConfig`).
- Cookie store: `apps/ui/app/hooks/use-cookie.ts`.
