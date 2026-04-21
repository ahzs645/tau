---
title: 'Concurrent Chat Streams and Agents Panel'
description: 'Architectural blueprint for adding a left-side agents panel that lists chats running concurrent streams in the project route, including the React/XState restructuring required to lift chat state from a single-active provider to a per-chat registry.'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
revision: 2
category: architecture
related:
  - docs/research/agentic-realtime-transport.md
  - docs/research/agent-loop-safeguards.md
  - docs/research/chat-error-persistence-stale-display.md
  - docs/policy/xstate-policy.md
---

# Concurrent Chat Streams and Agents Panel

Blueprint for a new left-side **Agents** panel that lists chats running concurrent AI streams in the project route, with the architectural restructuring required to lift the current single-active `ChatProvider` into a per-chat registry that keeps background streams alive while the user navigates.

## Executive Summary

Today the project route mounts exactly **one** `ChatProvider` whose `useChat` hook is keyed by `editorMachine.context.lastChatId`. Switching chats re-keys the AI SDK hook, which silently aborts the previous stream, drops in-flight tool calls, and resets the draft + persistence machines. The `ChatRpcSocketService` singleton is already chat-multiplexed (`Map<chatId, handler>` over a single Socket.IO connection), but `useChatRpcConnection` only ever joins the focused chat, so the multiplex capacity is unused. To support concurrent streams visible through an agents panel, the React shell must hold N headless `ChatInstance` subtrees in parallel, expose them via a registry context, and split today's "active chat" concept into "**focused** chat" (what the right-hand history panel shows) versus the "**running** set" (every chat with a live stream and live RPC handler).

The UX target (per the attached mockups) is a collapsible left-edge panel that mirrors Cursor's Agents Window: each row shows chat name, model badge, cost, status dot (streaming/idle/error), an icon-only collapsed state and an expanded list state, with the toggle pinned to the **top-left** of the existing `ChatHistoryStatus` row.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings: Current Architecture](#findings-current-architecture)
  - [F1: Layout and Panel Composition](#f1-layout-and-panel-composition)
  - [F2: Chat Provider Singularity](#f2-chat-provider-singularity)
  - [F3: AI SDK `useChat` Lifecycle and Stream Death on Switch](#f3-ai-sdk-usechat-lifecycle-and-stream-death-on-switch)
  - [F4: Persistence, Draft, and Error Machines](#f4-persistence-draft-and-error-machines)
  - [F5: RPC Socket Multiplexing — Capability vs. Usage](#f5-rpc-socket-multiplexing--capability-vs-usage)
  - [F6: Project-Scoped Singletons Tools Depend On](#f6-project-scoped-singletons-tools-depend-on)
  - [F7: Components That Read the Active Chat](#f7-components-that-read-the-active-chat)
  - [F8: Persisted Per-Chat State](#f8-persisted-per-chat-state)
- [Findings: Target Architecture](#findings-target-architecture)
  - [F9: Focused vs. Running Chat Decomposition](#f9-focused-vs-running-chat-decomposition)
  - [F10: ChatInstance Subtree and Registry](#f10-chatinstance-subtree-and-registry)
  - [F11: Per-Chat RPC Handler Wiring](#f11-per-chat-rpc-handler-wiring)
  - [F12: Concurrency Hazards in Tool Side-Effects](#f12-concurrency-hazards-in-tool-side-effects)
  - [F13: Per-Chat Status Surfaces for the Agents Panel](#f13-per-chat-status-surfaces-for-the-agents-panel)
- [Agents Panel UI](#agents-panel-ui)
- [Component Restructuring Catalog](#component-restructuring-catalog)
- [Implementation Roadmap](#implementation-roadmap)
- [Open Questions](#open-questions)
- [References](#references)
- [Appendix: File Inventory](#appendix-file-inventory)

## Problem Statement

A user editing a parametric design frequently wants more than one agent working at once — e.g. one chat refactoring `rotors.ts` while a second iterates on `skids.ts` and a third runs `test_model` to grade outputs. The current UI forces a serial workflow: opening another chat from the `ChatHistorySelector` re-keys the singleton `ChatProvider`, which aborts whatever the previous chat was streaming and prevents the user from inspecting or steering parallel agents. The mockup shows the desired state: a left-rail Agents Window that lists every chat with live status (model, cost, streaming indicator, error badge) and an icon-only collapsed mode, while the existing right-side `ChatHistory` panel continues to show only the **focused** chat in detail.

Concretely we need to:

1. Keep multiple chat streams alive simultaneously without the user re-focusing them.
2. Surface per-chat status (idle/streaming/error, last activity, model, cost) without mounting each chat's transcript renderer.
3. Add a new left-edge panel with two visual states (collapsed icon strip / expanded list) and a toggle pinned to the top-left of `chat-history-status.tsx`.
4. Avoid breaking the single-source-of-truth invariants in `editorMachine`, `chatPersistenceMachine`, and the `ChatRpcSocketService`.

## Methodology

Source-level analysis of the project route subtree (`apps/ui/app/routes/projects_.$id/`), the chat hooks (`apps/ui/app/hooks/use-chat*.tsx`, `chat-persistence.machine.ts`, `draft.machine.ts`), the chat RPC socket singleton (`apps/ui/app/services/chat-rpc-socket.service.ts`), the editor machine (`apps/ui/app/machines/editor.machine.ts`), and shared chat schemas (`libs/chat/src/types/chat.types.ts`). UI flow traced from `route.tsx` → `ChatWithProvider` → `ChatProvider` → `ChatInterfaceDesktop` → `ChatHistory`. Mockups compared against `chat-interface-desktop.tsx`'s left-side trigger column and `floating-panel.tsx` shell.

## Findings: Current Architecture

### F1: Layout and Panel Composition

The desktop layout in `apps/ui/app/routes/projects_.$id/chat-interface-desktop.tsx` is an `Allotment` split with eight toggleable panes around an always-visible center viewer. Pane visual order is the single source of truth `allotmentPanelOrder` from `apps/ui/app/constants/editor.constants.ts`:

```67:76:apps/ui/app/constants/editor.constants.ts
export const allotmentPanelOrder = [
  'chat',
  'files',
  'explorer',
  'kernel',
  'viewer',
  'parameters',
  'editor',
  'converter',
  'details',
] as const;
```

`chat` currently sits at the **left edge** as the leftmost pane, and the four left triggers (chat, files, explorer, kernel) are stacked top-to-left in a vertical column rendered inside the viewer pane:

```283:309:apps/ui/app/routes/projects_.$id/chat-interface-desktop.tsx
            <div className={cn('absolute top-10 z-10 flex flex-col gap-2', isAnyLeftPanelOpen ? 'left-2' : 'left-4')}>
              <ChatHistoryTrigger
                isOpen={isChatOpen}
                onToggle={() => {
                  setIsChatOpen((previous) => !previous);
                }}
              />
              <ChatFileTreeTrigger ... />
              <ChatExplorerTrigger ... />
              <ChatKernelTrigger ... />
            </div>
```

Both the open-state and the saved width of every pane live on `editorMachine.context.panelState` (see `defaultPanelState` in `editor.constants.ts`). Adding a new `agent` pane requires **all** of: `panelIds`, `desktopPanelIds`, `allotmentPanelOrder`, `defaultPanelState.openPanels`, `defaultPanelState.panelSizes`, the visibility map in `chat-interface-desktop.tsx`, the `ChatInterfaceState` type in `use-chat-interface-state.ts`, the `usePanePositionObserver` options bag, and the corresponding `Allotment.Pane` entry — the single source of truth fans out to ~6 sites that must stay in lockstep.

### F2: Chat Provider Singularity

`apps/ui/app/routes/projects_.$id/route.tsx` constructs exactly one `ChatProvider`, parameterised on the _current_ `lastChatId`:

```85:101:apps/ui/app/routes/projects_.$id/route.tsx
function ChatWithProvider(): React.JSX.Element {
  const { projectId, projectRef, editorRef } = useProject();
  const name = useSelector(projectRef, (state) => state.context.project?.name);
  const description = useSelector(projectRef, (state) => state.context.project?.description);
  const activeChatId = useSelector(editorRef, (state) => state.context.lastChatId);

  return (
    <ViewContextProvider>
      <ChatProvider chatId={activeChatId} resourceId={projectId}>
        ...
        <Chat />
      </ChatProvider>
    </ViewContextProvider>
  );
}
```

Inside `ChatProvider` (`apps/ui/app/hooks/use-chat.tsx`), four singletons are created per provider mount:

1. `useChat<MyUIMessage>({ id: activeChatId, transport, ... })` — the AI SDK hook.
2. `useActorRef(draftMachine.provide(...))` — draft + edit-draft state.
3. `useActorRef(chatPersistenceMachine.provide(...))` — load + persist + request-lifecycle.
4. A `ChatContextValue` exposed via `ChatContext` and consumed by `useChatContext`, `useChatSelector`, `useChatActions`.

When `activeChatId` changes:

- `useChat`'s `id` prop changes → AI SDK re-keys its internal stream and the previous fetch is aborted. There is no public "keep stream alive across `id` swap" API in `@ai-sdk/react@2.x`.
- `chatPersistenceMachine` is **not** restarted (the `useActorRef` instance is stable across renders), but the `setActiveChatId` event triggers `loadChatActor` which calls `setMessagesRef.current?.(loadedChat.messages)` on the _new_ `useChat` instance.
- `draftMachine` similarly receives `setChatId` and reloads its draft from the per-chat `Chat.draft` field.

So even though the XState actors persist across switches, the AI SDK stream does not. The mid-stream user message is preserved (because `loadChatActor` notices `lastMessage.role === 'user' && metadata.status === 'pending'` and triggers `regenerate()`), but tool calls in flight, partial reasoning blocks, and not-yet-persisted assistant tokens are lost.

### F3: AI SDK `useChat` Lifecycle and Stream Death on Switch

The transport is a stateless `DefaultChatTransport` that opens an HTTP fetch per request:

```199:216:apps/ui/app/hooks/use-chat.tsx
  const chat = useChat<MyUIMessage>({
    id: activeChatId,
    transport: new DefaultChatTransport({
      api: `${ENV.TAU_API_URL}/v1/chat`,
      credentials: 'include',
    }),
    generateId: () => generatePrefixedId(idPrefix.message),
    onFinish({ messages, isAbort, isError }) {
      persistenceActorRef.send({ type: 'requestFinished', messages, isAbort, isError });
    },
    onError(error) {
      persistenceActorRef.send({ type: 'handleError', error });
      persistenceActorRef.send({
        type: 'setPersistedError',
        error: parseErrorForPersistence(error),
      });
    },
  });
```

Each `useChat` instance owns one fetch + reader pair. To keep N streams alive concurrently we must mount N instances simultaneously — there is no AI-SDK-native multi-chat hook. Mounting N `useChat`s also creates N independent `messages` arrays, `status` flags, and `error` slots — exactly what we need for the per-chat status indicators.

**Note:** `DefaultChatTransport` is constructed inline on every render; this is wasteful but currently invisible because there is only one provider. Lifting it to a stable instance becomes cheap and required when multiplying providers.

### F4: Persistence, Draft, and Error Machines

`chatPersistenceMachine` is a four-region parallel machine (`chatLoading`, `messagePersistence`, `requestLifecycle`, `errorPersistence`) keyed by `context.activeChatId`. Notable invariants:

- Every actor (`loadChatActor`, `persistMessagesActor`, `persistErrorActor`, `clearErrorActor`) is provided in `use-chat.tsx` and **closes over the singleton** `chatRef`, `setMessagesRef`, `regenerateRef`, `initializeDraftRef`. These refs assume one provider — N providers would each need their own refs.
- `requestLifecycle` owns the queue-while-streaming and stop semantics via emits (`dispatchRequest`, `dispatchStop`, `applyFinishedRequest`, etc). The emits are subscribed by the _singleton_ `ChatProvider`'s `useEffect`, which dereferences `chatRef.current` (also singleton). Per-chat instances need per-chat emit listeners.
- `flushNow` is called from `FlushOnCloseGuard` for the focused chat only:

```107:122:apps/ui/app/routes/projects_.$id/route.tsx
function FlushOnCloseGuard(): React.JSX.Element {
  const { projectRef, editorRef } = useProject();
  const { persistenceActorRef, draftActorRef } = useChatContext();

  useFlushOnClose(() => {
    projectRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    editorRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    persistenceActorRef.send({ type: 'flushNow' });
  });
  useFlushOnClose(() => {
    draftActorRef.send({ type: 'flushNow' });
  });
```

When N chats are running, every running chat's persistence + draft machines must receive `flushNow` on tab close, otherwise unpersisted chunks are lost. The hook needs to fan out across the registry.

`draftMachine` has identical singleton assumptions — it receives `setChatId` to load a per-chat draft into a single context.

### F5: RPC Socket Multiplexing — Capability vs. Usage

The Socket.IO singleton is already designed for multiple simultaneous chats (see the class doc and `joinChat`/`leaveChat`/`chatHandlers` on `apps/ui/app/services/chat-rpc-socket.service.ts`):

```142:149:apps/ui/app/services/chat-rpc-socket.service.ts
  public joinChat(chatId: string, onRpcRequest: RpcRequestHandler): void {
    this.chatHandlers.set(chatId, onRpcRequest);

    if (this.socket?.connected) {
      void this.emitJoinWithRetry(chatId);
    }
  }
```

```438:469:apps/ui/app/services/chat-rpc-socket.service.ts
  private async handleRpcRequest(request: RpcRequest, ack: (response: RpcResponse) => void): Promise<void> {
    const { chatId } = request;
    const handler = this.chatHandlers.get(chatId);

    if (!handler) {
      console.warn(`[ChatRpcSocket] Received RPC request for unknown chat: ${chatId}`);
      ...
```

`useChatRpcConnection` joins exactly one room — the focused chat — at the route level:

```62:69:apps/ui/app/routes/projects_.$id/route.tsx
function Chat(): React.JSX.Element {
  const { activeChatId, isLoadingChat } = useChatContext();

  // Connect to Socket.IO for tool execution (uses singleton service)
  useChatRpcConnection({
    chatId: activeChatId,
    enabled: !isLoadingChat,
  });
```

So the multiplex _capacity_ exists, but a background chat that resumes mid-tool-call cannot answer the server's `rpc_request` because no handler is registered for its `chatId`. **This is the single most important blocker:** the RPC handler must move into per-chat scope.

### F6: Project-Scoped Singletons Tools Depend On

`createRpcHandlers` in `apps/ui/app/hooks/rpc-handlers.ts` is called per RPC request from `useChatRpcConnection` with these dependencies:

```143:150:apps/ui/app/hooks/use-chat-rpc-socket.tsx
  const depsRef = useRef<RpcHandlerDependencies | undefined>(undefined);
  depsRef.current = {
    fileManager,
    resolveGraphicsForFile,
    projectRef,
    treeService,
    screenshotQuality,
  };
```

All five dependencies are **project-singletons** (`useProject()`, `useFileManager()`) — they do **not** vary per chat. That is good news: a per-chat handler factory closes over the same project-level deps and only differs in which chat's `MyUIMessage` slice it operates on. The same `projectRef` and `treeService` can be safely shared across N concurrent chats from a _plumbing_ perspective (`useProject` returns a stable ref, not a copy). The hard problem is **semantic** concurrency, covered in F12.

### F7: Components That Read the Active Chat

Grepping `useChatContext|useChatSelector|useChatActions` returns these consumers (apps/ui only):

| File                                                    | Reads                               | Notes                                           |
| ------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `routes/projects_.$id/route.tsx`                        | `useChatContext`                    | `FlushOnCloseGuard`, `Chat()` connection wiring |
| `routes/projects_.$id/chat-history.tsx`                 | `useChatSelector`, `useChatActions` | Renders focused chat's transcript               |
| `routes/projects_.$id/chat-history-status.tsx`          | `useChatSelector`                   | Shows model + cost for focused chat             |
| `routes/projects_.$id/chat-history-settings.tsx`        | `useChatContext`                    | Export transcript                               |
| `routes/projects_.$id/chat-message.tsx`                 | `useChatSelector`, `useChatActions` | Per-message rendering                           |
| `routes/projects_.$id/chat-message-text.tsx`            | `useChatSelector`                   | Streaming flag                                  |
| `routes/projects_.$id/chat-message-reasoning.tsx`       | `useChatSelector`                   | Streaming flag for sticky-bottom scroll         |
| `routes/projects_.$id/chat-message-planning.tsx`        | `useChatSelector`                   | Planning UI streaming flag                      |
| `routes/projects_.$id/chat-message-tool-test-model.tsx` | `useChatSelector`                   | Test result hover                               |
| `routes/projects_.$id/chat-message-tool-transfer.tsx`   | `useChatSelector`                   | Transfer message lookup                         |
| `routes/projects_.$id/chat-error*.tsx` (5 files)        | `useChatSelector`, `useChatActions` | Error banner                                    |
| `routes/projects_.$id/chat-stack-trace.tsx`             | `useChatSelector`                   | Stack trace overlay                             |
| `routes/projects_.$id/chat-examples.tsx`                | `useChatActions.sendMessage`        | Quick-prompt buttons                            |
| `components/chat/chat-textarea.tsx`                     | `useChatActions`                    | Draft text                                      |
| `components/chat/chat-textarea-desktop.tsx`             | `useChatSelector`, `useChatActions` | Composer                                        |
| `components/chat/chat-textarea-types.ts`                | `useChatSelector`, `useChatActions` | Logic hook                                      |
| `components/chat/chat-context-indicator.tsx`            | `useChatSelector`                   | Context budget                                  |
| `routes/_index/route.tsx`                               | `useChatActions`                    | Marketing page demo                             |

All of these read the **focused** chat. Most can stay on `useChatSelector`/`useChatContext` if those hooks default to the focused chat. The Agents Panel rows, however, need a new `useChatById(id, selector)` hook so each row can render its own status without focusing the chat.

### F8: Persisted Per-Chat State

`Chat` is the persistence schema (`libs/chat/src/types/chat.types.ts`):

```40:51:libs/chat/src/types/chat.types.ts
export type Chat = {
  id: string;
  resourceId: string; // Links chat to a resource (e.g., build)
  name: string;
  messages: MyUIMessage[];
  draft?: MyUIMessage; // Main draft
  messageEdits?: Record<string, MyUIMessage>; // Edit drafts by messageId
  error?: ChatError; // Persisted error for display after page reload
  createdAt: number;
  updatedAt: number;
  deletedAt?: number; // Soft delete support
};
```

There is **no persisted `status` field**. Live streaming status is derived from `useChat({ status })`, which is in-memory only. To survive reloads (`agentic-realtime-transport.md` recommends Redis Streams resumability), we'd want a persisted `runState: 'idle' | 'streaming' | 'paused' | 'error'`, but the minimal implementation can compute it from `messages.at(-1)?.metadata.status` (the existing `pending` heuristic that `loadChatActor` already uses for auto-resume).

`useChats(projectId)` already returns the full chat list via `react-query` from `useProjectManager.getChatsForResource`. The Agents Panel can subscribe to this query for the static row data (name, model from last message, last activity, persisted error) without touching the live stream state.

## Findings: Target Architecture

### F9: Focused vs. Running Chat Decomposition

Today `editorMachine.context.lastChatId` conflates two concepts: which chat is _visible_ and which chat is _active_. After the refactor we need:

| Concept          | Definition                                                                                            | Source of truth                                                             | Persisted?          |
| ---------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| **Focused chat** | The chat whose transcript renders in the right-side `ChatHistory` panel and whose composer is visible | `editorMachine.context.focusedChatId` (renamed from `lastChatId`)           | Yes (existing slot) |
| **Pinned set**   | User-pinned chats that survive cross-session reloads as auto-mounted                                  | `editorMachine.context.pinnedChatIds: string[]` (new)                       | Yes                 |
| **Running set**  | Every chat with a mounted `ChatInstance` (live `useChat`, joined RPC room, hot persistence machine)   | In-memory React state on `ChatRegistryProvider`; **derived**, not persisted | No                  |

Persistence rule: only the two concepts that encode _user intent across sessions_ live in the editor state. The running set is presentation state for the React subtree and is rebuilt on every mount.

Derivation rule for the running set on mount:

```
runningChatIds = unique([
  focusedChatId,
  ...pinnedChatIds,
  ...chatsWhere(messages.at(-1)?.role === 'user' && metadata.status === 'pending'),
])
```

The third term is already detectable today via the existing `loadChatActor` heuristic in `chatPersistenceMachine` — it auto-regenerates pending mid-stream requests, so "this chat was streaming when I closed the tab" is recoverable from message data with no extra schema.

Invariants:

- The focused chat is always in the running set (the registry seeds it; explicit user stop falls back to focus-only).
- The user can explicitly stop a chat → removes from in-memory running set, RPC handler unregisters, AI SDK fetch aborts. `chatPersistenceMachine.stop` flips the trailing user message's `metadata.status` to `cancelled`, so the next reload will not auto-resume it — no "stopped" blacklist needed.
- Reload: the running set is rebuilt from the derivation rule above.
- Hard cap (e.g. 5 concurrent) with LRU eviction prompt to prevent memory blow-up; `agent-loop-safeguards.middleware.ts` has the precedent of guarding against runaway agent loops.

**P1 simplification.** Until the agents panel ships in P3, the user has no UI to express background opens or pins, so the seed reduces to `[focusedChatId]`. Phase 1 therefore needs **no** new persisted fields — only the `lastChatId → focusedChatId` rename. `pinnedChatIds` is added to the persisted schema in P3 alongside the UI that sets/reads it. See the roadmap below.

### F10: ChatInstance Subtree and Registry

Replace the singleton `ChatProvider` with a **registry** that mounts one `<ChatInstance chatId={id}>` per running chat. Each `ChatInstance` is a headless React component (returns `null` or just children when focused) that owns:

- `useChat<MyUIMessage>({ id })` instance
- `useActorRef(draftMachine.provide(...))` keyed by chatId
- `useActorRef(chatPersistenceMachine.provide(...))` keyed by chatId
- A subscription to the `ChatRpcSocketService` joining `chatId`'s room
- A side-effect listener for the persistence machine's `dispatchRequest`/`dispatchStop`/`applyFinishedRequest`/`applyStoppedRequest`/`applyResumedRequest` emits

```tsx
// pseudo-code
function ChatRegistryProvider({ children }: { children: ReactNode }) {
  const { projectId, editorRef } = useProject();
  const focusedChatId = useSelector(editorRef, (s) => s.context.focusedChatId);
  // P3+: const pinnedChatIds = useSelector(editorRef, (s) => s.context.pinnedChatIds);
  const [registry] = useState(() => new ChatInstanceRegistry());

  // In-memory running set. P1 = [focusedChatId]. P3+ unions pinned + auto-resume seeds.
  const runningChatIds = useMemo(
    () => (focusedChatId ? [focusedChatId] : []),
    [focusedChatId],
  );

  return (
    <ChatRegistryContext.Provider value={{ registry, focusedChatId }}>
      {/* Each instance is mounted in its own subtree; React state isolation
          guarantees they cannot interfere via re-renders. */}
      {runningChatIds.map((id) => (
        <ChatInstance key={id} chatId={id} resourceId={projectId} registry={registry} />
      ))}
      {children}
    </ChatRegistryContext.Provider>
  );
}

function ChatInstance({ chatId, resourceId, registry }: Props) {
  const persistenceActorRef = useActorRef(chatPersistenceMachine.provide(...), { input: { activeChatId: chatId, resourceId } });
  const draftActorRef       = useActorRef(draftMachine.provide(...),           { input: { chatId } });
  const chat                = useChat<MyUIMessage>({ id: chatId, transport: stableTransport, ... });

  // Same emit listeners as today's ChatProvider, but scoped to this instance.

  // Register with the registry so siblings can read this instance via context.
  useEffect(() => {
    registry.register(chatId, { chat, persistenceActorRef, draftActorRef });
    return () => registry.unregister(chatId);
  }, [chatId]);

  // Per-chat RPC join.
  useChatRpcConnection({ chatId, enabled: true });

  return null; // headless; rendering is done by consumers reading the registry
}
```

`useChatContext()` becomes `useChatContext(chatId?)` — defaults to the focused chat. `useChatSelector(selector)` becomes `useChatSelector(selector, chatId?)`. New: `useChatById(chatId, selector)` for the agents panel rows.

This is the same architectural pattern Tau already uses in `apps/ui/app/hooks/use-project.tsx` for `compilationUnits: Map<string, ActorRefFrom<typeof cadMachine>>` — a per-CU `cadMachine` is mounted dynamically and exposed via a Map on context. Reusing that pattern keeps the mental model consistent.

### F11: Per-Chat RPC Handler Wiring

`useChatRpcConnection` already accepts `chatId` and joins/leaves a single room. We can mostly keep it, but lift it inside `ChatInstance` so each instance owns its handler registration. The `depsRef` inside `useChatRpcConnection` reads `useProject()` and `useFileManager()` — both project singletons — so each instance gets the same dependency surface, which is fine.

One subtle refactor: the handler closure currently uses **only** project-scoped deps; tool execution does not look at chat-specific state on the front-end. That's exactly why this lifting is safe. The server stamps each request with its `chatId`, and the singleton `ChatRpcSocketService.handleRpcRequest` already routes by `request.chatId`.

### F12: Concurrency Hazards in Tool Side-Effects

Tools that mutate shared state can race when N agents run in parallel. The biggest risks (catalogued by inspection of `apps/ui/app/hooks/rpc-handlers.ts` and adjacent tool implementations):

| Tool family                                                                       | Shared resource                                                     | Race                                                                                                                                           | Mitigation                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit_file`, `create_file`, `delete_file`                                         | Per-project filesystem (`treeService`, `fileManager`)               | Two agents writing the same path produce last-writer-wins                                                                                      | Per-path mutex via `KeyedMutex` in `apps/ui/app/db/keyed-mutex.ts` (already exists for IndexedDB writes); error if conflict, never silently merge |
| `fetch_geometry`, `capture_screenshot`, `test_model` (per-CU)                     | Per-CU `cadMachine` + kernel worker (single SharedPool slot per CU) | Concurrent renders of same CU share the kernel worker queue serially (already safe), but a spurious rerender mid-test can invalidate snapshots | Existing `setRenderTimeout` + per-CU worker queue covers this; ensure agent-side test results capture geometry hash, not pointer                  |
| `edit_tests`                                                                      | `test.json` per CU                                                  | Same as `edit_file`                                                                                                                            | Same                                                                                                                                              |
| `web_search`, `web_browser`, `read_file`, `list_directory`, `grep`, `glob_search` | Read-only against project FS                                        | Safe                                                                                                                                           | None                                                                                                                                              |
| `transfer`                                                                        | Hand-off between chats                                              | Inherently cross-chat                                                                                                                          | Already designed for this; no new work                                                                                                            |

Recommendation: introduce a project-wide `AgentMutexRegistry` (a `KeyedMutex<AbsolutePath>`) that wraps every write tool's invocation. The existing `agent-safeguards.middleware.ts` (server side) already detects repeated identical tool failures — extend its scope to detect "this path is locked by another agent" so the LLM gets a structured rejection rather than a silent overwrite.

### F13: Per-Chat Status Surfaces for the Agents Panel

For the agents panel rows we need a _cheap_ per-chat status snapshot that does not require mounting the chat's transcript renderer. The `ChatInstanceRegistry` exposes the live `useChat` instance plus the persistence machine for each running chat. A `useChatRowState(chatId)` hook can derive:

```ts
type ChatRowState = {
  id: string;
  name: string; // from useChats() (react-query)
  status: 'idle' | 'streaming' | 'submitted' | 'error' | 'unmounted';
  isFocused: boolean;
  modelId: string | undefined; // last message metadata.model
  lastUserPrompt: string | undefined; // for the row subtitle
  totalCost: number; // sum across data-usage parts
  lastActivityAt: number; // chat.updatedAt
  persistedError: ChatError | undefined; // even when not running
  unreadAssistantText: boolean; // last message role 'assistant' since focus
};
```

For chats **not** in the running set, `status` is `unmounted` and the row pulls everything from the persisted `Chat` entity via `useChats()`. For chats in the running set, `status` reads from the registry's `chat.status` and `messages` are read live.

A subtlety: each row shouldn't subscribe to the entire `chat.messages` array (that would re-render every row on every token). Instead the registry exposes a `subscribe(chatId, statusOnlyListener)` whose listener fires only when `chat.status` changes, and a `subscribeUsage(chatId)` that fires only when a `data-usage` part is appended. AI SDK's `useChat` does not natively expose a status-only subscription; the registry can throttle/derive its own using `useSyncExternalStore`.

## Agents Panel UI

### Position

The new `agent` panel sits to the **left of** the existing `chat` panel — i.e. it becomes the leftmost entry in `allotmentPanelOrder`:

```ts
export const allotmentPanelOrder = [
  'agent', // ← new
  'chat',
  'files',
  'explorer',
  'kernel',
  'viewer',
  'parameters',
  'editor',
  'converter',
  'details',
] as const;
```

### Two-State Toggle

Per mockup #2, the panel has two visual states:

- **Expanded** (~280–320 px wide): full list of agents grouped by `groupItemsByTimeHorizon` ("Pinned", "Today", "Yesterday", etc.) — same util the `ChatHistorySelector` uses.
- **Collapsed** (~44 px wide rail): icon-only column showing one round avatar/initial per running agent with a status dot. Click to focus that agent (also expands the chat panel if collapsed). Hover a row to reveal a tooltip with the chat name + status.

The toggle button is pinned to the **top-left of `chat-history-status.tsx`**, replacing today's left padding. Per the mockup it sits inline with the relative-time clock icon. The button:

- Shows a chevron pointing left (panel open) or right (panel collapsed).
- Doubles as the panel trigger when the panel is closed entirely (third state: hidden).

To avoid colliding with the existing left trigger column (chat/files/explorer/kernel buttons), the agents panel either (a) renders **inside** that left trigger zone as the first item (consistent with sibling panels), or (b) reserves the leftmost rail as a permanent agents strip with the existing triggers shifted right. The mockup matches (b): the agents panel itself is the rail when collapsed, and existing pane triggers stay to its right.

### Row Anatomy

Each agents-panel row mirrors the Cursor mockup (image 1):

```
┌─────────────────────────────────────────────────────┐
│ ●  Initial design           Now ⊟ ⋯               │
│    +1239 -50 · 7 files                              │
└─────────────────────────────────────────────────────┘
```

Mapping to Tau:

- Status dot (left): `idle` (gray), `streaming` (blue, pulsing — reuse the warning-dot animation in `chat-history-selector.tsx` lines 243–246), `error` (warning), `submitted` (amber).
- Title: chat name; if `streaming`, animate the title with `text-shimmer` (already used in `chat-message-tool-read-file.tsx`).
- Subtitle row 1: model badge (`<SvgIcon id={model.details.family} />` per `chat-message-data-usage.tsx`) + cost (`formatCurrency`).
- Subtitle row 2: live activity summary — last tool call verb (`Reading skids.ts`, `Rendering 1 CU`, `Thinking…`) using the existing `chat-tool-label.tsx` summary text. Falls back to `formatRelativeTime(updatedAt)` when idle.
- Trailing: hover-reveal action menu (rename, duplicate, delete, pin) — reuse `chat-history-selector.tsx`'s row affordances; right-click context menu mirrors `chat-parameters.tsx`.

When focused, the row gets `text-primary` and a left border accent (parallel to `isActive` styling in `renderChatLabel`).

### Sticky Header

Above the list:

- Search input (`Search agents…`) — reuse `ComboBoxResponsive` filter logic.
- "New agent" button — equivalent of today's `+ New chat` in the selector.
- Settings overflow.

## Component Restructuring Catalog

The table below is the practical work list. Each row maps a current responsibility to its new home.

| #   | Current location                                                       | Current responsibility                                 | Target location                                                  | Target responsibility                                                                                                                                                              |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `route.tsx` `ChatWithProvider`                                         | Mounts singleton `ChatProvider`                        | `route.tsx`                                                      | Mounts `ChatRegistryProvider` (no chatId prop)                                                                                                                                     |
| 2   | `route.tsx` `Chat`                                                     | Calls `useChatRpcConnection` for active id             | (deleted)                                                        | RPC join lifted into per-`ChatInstance`                                                                                                                                            |
| 3   | `route.tsx` `FlushOnCloseGuard`                                        | Flushes one persistence + draft machine                | `route.tsx`                                                      | Iterates registry; flushes every running chat's machines                                                                                                                           |
| 4   | `hooks/use-chat.tsx` `ChatProvider`                                    | Owns `useChat` + machines + ChatContext                | `hooks/use-chat.tsx` `ChatInstance`                              | Per-chat headless component; registers self in `ChatInstanceRegistry`                                                                                                              |
| 5   | `hooks/use-chat.tsx` `ChatContext`                                     | Single context value                                   | `hooks/use-chat.tsx` `ChatRegistryContext` + `ActiveChatContext` | Registry + active-chat scope (the chat this subtree is bound to; equals the focused chat in the project route)                                                                     |
| 6   | `hooks/use-chat.tsx` `useChatContext()`                                | Returns focused chat record                            | (same)                                                           | Defaults to focused chat; accepts optional `chatId`                                                                                                                                |
| 7   | `hooks/use-chat.tsx` `useChatSelector(s)`                              | Reads focused chat                                     | (same)                                                           | `useChatSelector(s, chatId?)`; new `useChatById(chatId, s)` hook for non-focused reads                                                                                             |
| 8   | `hooks/use-chat.tsx` `useChatActions()`                                | Mutates focused chat                                   | (same)                                                           | Accepts optional `chatId` for retry/stop/regenerate against background chats                                                                                                       |
| 9   | `hooks/use-chat-rpc-socket.tsx` `useChatRpcConnection`                 | One join per route                                     | (same; semantic only)                                            | Called inside each `ChatInstance`                                                                                                                                                  |
| 10  | `machines/editor.machine.ts` `lastChatId`                              | Single active id                                       | (same machine)                                                   | Renamed `focusedChatId` (P1). `pinnedChatIds: string[]` added in P3 alongside the agents panel UI. **Running set is not persisted** — derived in-memory by `ChatRegistryProvider`. |
| 11  | `machines/editor.machine.ts` events                                    | `setLastChatId`                                        | (same machine)                                                   | `setFocusedChatId` (P1). `pinChat` / `unpinChat` added in P3. No `addRunningChat`/`removeRunningChat` events — running set lives in React state, not the machine.                  |
| 12  | `routes/projects_.$id/chat-history.tsx`                                | Renders focused chat                                   | (same)                                                           | No change — still reads focused chat via `useChatSelector`                                                                                                                         |
| 13  | `routes/projects_.$id/chat-history-status.tsx`                         | Reads focused chat                                     | (same)                                                           | Add agents-panel toggle button to left side; rest unchanged                                                                                                                        |
| 14  | `routes/projects_.$id/chat-history-selector.tsx`                       | Combobox list of chats                                 | (same)                                                           | Optional: replace combobox with link that opens the new agents panel for parity                                                                                                    |
| 15  | (new)                                                                  | —                                                      | `routes/projects_.$id/agents-panel.tsx`                          | The new panel; expanded list + collapsed rail                                                                                                                                      |
| 16  | (new)                                                                  | —                                                      | `routes/projects_.$id/agents-panel-row.tsx`                      | Per-chat row using `useChatById` + `useChats`                                                                                                                                      |
| 17  | (new)                                                                  | —                                                      | `routes/projects_.$id/agents-panel-trigger.tsx`                  | Left-rail trigger button for `chat-interface-desktop.tsx`                                                                                                                          |
| 18  | (new)                                                                  | —                                                      | `routes/projects_.$id/use-chat-row-state.ts`                     | Hook that combines registry + react-query into `ChatRowState`                                                                                                                      |
| 19  | (new)                                                                  | —                                                      | `hooks/chat-instance-registry.ts`                                | Class wrapping `Map<chatId, ChatInstanceRecord>` with `subscribe`/`subscribeStatus`/`subscribeUsage`                                                                               |
| 20  | `constants/editor.constants.ts`                                        | `panelIds`/`allotmentPanelOrder`/`defaultPanelState`   | (same)                                                           | Add `'agent'` to all three; default `openPanels.agent: false`, `panelSizes.agent: 280`                                                                                             |
| 21  | `routes/projects_.$id/use-chat-interface-state.ts`                     | `ChatInterfaceState` shape + `usePanePositionObserver` | (same)                                                           | Add `isAgentOpen`/`setIsAgentOpen` and pass through                                                                                                                                |
| 22  | `routes/projects_.$id/chat-interface-desktop.tsx`                      | `Allotment.Pane` list                                  | (same)                                                           | Insert `AgentsPanel` pane as first left pane; add trigger to left column                                                                                                           |
| 23  | `routes/projects_.$id/chat-interface-mobile.tsx`                       | Tab-based layout                                       | (same)                                                           | Add `agents` tab; lower priority for mobile                                                                                                                                        |
| 24  | `services/chat-rpc-socket.service.ts`                                  | Multi-room handlers                                    | (same)                                                           | No change                                                                                                                                                                          |
| 25  | `hooks/chat-persistence.machine.ts`                                    | Per-chat machine                                       | (same)                                                           | No structural change; instantiated N times                                                                                                                                         |
| 26  | `hooks/draft.machine.ts`                                               | Per-chat machine                                       | (same)                                                           | No structural change; instantiated N times                                                                                                                                         |
| 27  | `routes/projects_.$id/chat-history-selector.tsx` `handleSelectChat`    | Calls `setLastChatId`                                  | (same)                                                           | Calls `setFocusedChatId` (which auto-adds to running set)                                                                                                                          |
| 28  | `routes/projects_.$id/chat-history-selector.tsx` connection-status dot | One global dot                                         | (deleted from selector)                                          | Move to per-row dot in agents panel                                                                                                                                                |
| 29  | (server, optional) `apps/api/app/api/chat/chat.gateway.ts`             | Allows multi-room joins per session                    | (same)                                                           | Audit per-user concurrency caps; ensure no per-socket "single active chat" assumption                                                                                              |

## Implementation Roadmap

### P1 — Headless Refactor (no UX change yet)

Goal: ship a behaviour-equivalent rewrite where the in-memory running set equals `[focusedChatId]`. This validates the registry plumbing without exposing concurrency to users and without inventing persisted schema before the UI exists. Breaking renames are acceptable; no migration shim.

1. Rename `editorMachine.context.lastChatId → focusedChatId` and the matching event `setLastChatId → setFocusedChatId`. **Do not** add `runningChatIds` or `pinnedChatIds` to the machine yet — running set is React state, pinning has no UI until P3.
2. Extract `ChatInstance` from `ChatProvider`; `ChatRegistryProvider` mounts one `<ChatInstance chatId={focusedChatId}/>` derived from the editor machine's focused id.
3. Build `ChatInstanceRegistry` and rewrite `useChatContext`/`useChatSelector`/`useChatActions` against it. Keep call sites unchanged.
4. Move `useChatRpcConnection` call inside `ChatInstance`. Verify the singleton socket service still routes correctly.
5. Update `FlushOnCloseGuard` to iterate the registry.
6. Add tests:
   - Switching focused chat does **not** drop a streaming background chat. Test harness mounts two `<ChatInstance>` siblings directly (bypassing the P1 single-instance derivation in `ChatRegistryProvider`), drives `chat_a` to `streaming`, then asserts that re-rendering with focus on `chat_b` does not call `chat_a.stop()`/`setMessages()` and does not unjoin its RPC room. This is the explicit P1 acceptance criterion.
   - `flushNow` reaches every running persistence machine via the registry fan-out.
   - Singleton `DefaultChatTransport` instance is reused across instances.

### P2 — Concurrency Safety

Goal: make tools safe for parallel execution before any user can trigger it from the UI.

1. Add `AgentMutexRegistry` keyed by absolute project path; wrap `edit_file`/`create_file`/`delete_file`/`edit_tests` write paths.
2. Extend `agent-safeguards.middleware.ts` with a "path locked by agent X" structured rejection.
3. Reproducer test: two `ChatInstance`s both call `edit_file` against `main.ts` simultaneously; assert one gets the lock and the other gets a deterministic error.
4. Audit `cadMachine` per-CU queue for fairness under N concurrent producers; document expected serialization.

### P3 — Agents Panel UI

Goal: ship the visible feature.

0. Add `pinnedChatIds: string[]` (default `[]`) to `EditorStateContext` + `EditorState` + `object-store.worker.ts` seed/migration; add `pinChat` / `unpinChat` events on `editorMachine`. Extend `ChatRegistryProvider` to derive `runningChatIds = unique([focusedChatId, ...pinnedChatIds, ...autoResumeSeeds])`.
1. Add `'agent'` to `panelIds`, `desktopPanelIds`, `allotmentPanelOrder`, `defaultPanelState.openPanels`, `defaultPanelState.panelSizes`. Update `useChatInterfaceState` and `usePanePositionObserver`.
2. Build `agents-panel.tsx` (expanded list + collapsed rail). Reuse `FloatingPanel` shell, `ComboBoxResponsive` search, `groupItemsByTimeHorizon`.
3. Build `agents-panel-row.tsx` consuming `useChatRowState`. Use `text-shimmer` for active titles, `chat-tool-label.tsx` for live activity summary, `SvgIcon id={model.details.family}` for model badge.
4. Add the toggle button to the top-left of `chat-history-status.tsx`. Wire it to `setIsAgentOpen`.
5. Update `chat-interface-desktop.tsx` with the new `Allotment.Pane` and trigger.
6. Mobile: add an `agents` tab to `chat-interface-mobile.tsx` (defer behind sub-flag if mobile is out of scope for v1).
7. Tests:
   - Row updates when its background chat advances (status, cost, last activity).
   - Click row → focuses chat without dropping the previously focused chat's stream.
   - Rail tooltip + a11y labels.

### P4 — Lifecycle Polish

Goal: durability and resource limits.

1. Hard cap on the in-memory running set size (e.g. 5). On overflow, prompt user to evict the oldest non-pinned chat.
2. Persist optional `Chat.runState` field for cross-tab visibility (other tabs can show "running elsewhere" badge).
3. Telemetry: per-chat `streamDurationMs`, `concurrentChatsAtPeak`, `mutexConflictCount`.

(The auto-resume seed for the running set was specified in F9 and is enabled in P3 alongside `pinnedChatIds` — by P4 it already works.)

### P5 — Server Resumability (stretch)

Per `agentic-realtime-transport.md`'s recommendation, decouple LLM generation from client connection via Redis Streams so a chat that was streaming when the user closed the tab can resume on next open. This is independent of the UI work but synergistic — it's the only way an `agent` panel feels truly "running" rather than "running while the tab is open".

## Open Questions

1. ~~**Feature-flag scope.**~~ **Resolved (R2):** No feature flag. P1 ships as a clean-break rename + registry refactor; behaviour is equivalent to today because the in-memory running set defaults to `[focusedChatId]`. Test matrix in the implementation plan covers regression risk.
2. **Stop-all UX.** Should the agents panel have a single "stop all" affordance, or only per-row stop? Cursor's panel has both via a hidden right-click menu.
3. **Cross-project agents.** Should an agent in project A be visible from project B? Today the chat is scoped to `resourceId === projectId`, and `useChats(projectId)` filters. A future "global agents tray" sits outside the project route but is out of scope here.
4. **Mobile.** The mockup is desktop. Mobile drawer has limited screen real estate and the existing `chat-interface-mobile.tsx` is tab-based. Defer or add as a tab?
5. **Cost attribution.** Should the cost shown per row be just this chat, or include downstream effects (e.g. tool-triggered re-renders)? Stick with the chat's own `data-usage` parts for v1.
6. **Agent termination semantics.** When the user removes a chat from the running set, do we (a) `stop()` the AI SDK fetch and persist the partial result with `metadata.status: 'cancelled'`, or (b) detach the UI but let the server keep generating until completion? (a) matches today's `stopRequest` flow.
7. **Edit-message racing.** The current `requestLifecycle.invoking → stopping` queue assumes one stream per chat. With N chats, the queue is per-chat (each `ChatInstance` has its own machine), so no interference — but if the user submits an edit on chat A while chat B's tool just wrote to the same file, the **mutex** (F12) is the only safety net.

## References

- AI SDK `useChat` hook source: `node_modules/@ai-sdk/react/dist/index.mjs` (transport + id-keyed instance)
- Cursor agents window UX (mockup #1 attached by user)
- Mockup #2 (collapsed rail vs expanded panel) attached by user
- Related: `docs/research/agentic-realtime-transport.md` (server-side resumability)
- Related: `docs/research/agent-loop-safeguards.md` (server-side rate-limit/repeat detection that needs path-mutex extension)
- Related: `docs/research/chat-error-persistence-stale-display.md` (request-lifecycle invariants this refactor must preserve)
- Policy: `docs/policy/xstate-policy.md` (machines own lifecycle; UI sends events only)

## Appendix: File Inventory

### Files modified (existing)

| Path                                                           | Change kind                                                                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/app/routes/projects_.$id/route.tsx`                   | Replace `ChatProvider` with `ChatRegistryProvider`; rewrite `FlushOnCloseGuard` to fan out                                                                                         |
| `apps/ui/app/hooks/use-chat.tsx`                               | Split `ChatProvider` → `ChatRegistryProvider` + `ChatInstance`; rewrite hooks                                                                                                      |
| `apps/ui/app/hooks/use-chat-rpc-socket.tsx`                    | Move `useChatRpcConnection` call site (inside `ChatInstance`); no API change                                                                                                       |
| `apps/ui/app/hooks/chat-persistence.machine.ts`                | No structural change; verify `provide` actors are pure (no shared closure across instances)                                                                                        |
| `apps/ui/app/hooks/draft.machine.ts`                           | Same                                                                                                                                                                               |
| `apps/ui/app/machines/editor.machine.ts`                       | P1: rename `lastChatId` → `focusedChatId` (codemod call sites). P3: add `pinnedChatIds: string[]` + `pinChat`/`unpinChat` events. **Running set is not persisted on the machine.** |
| `apps/ui/app/constants/editor.constants.ts`                    | Add `'agent'` panel id; widen `defaultPanelState`                                                                                                                                  |
| `apps/ui/app/routes/projects_.$id/chat-interface-desktop.tsx`  | Add `AgentsPanel` pane + trigger                                                                                                                                                   |
| `apps/ui/app/routes/projects_.$id/chat-interface-mobile.tsx`   | Add agents tab (deferrable)                                                                                                                                                        |
| `apps/ui/app/routes/projects_.$id/use-chat-interface-state.ts` | Add `isAgentOpen` plumbing                                                                                                                                                         |
| `apps/ui/app/routes/projects_.$id/chat-history-status.tsx`     | Add toggle button at top-left                                                                                                                                                      |
| `apps/ui/app/routes/projects_.$id/chat-history-selector.tsx`   | Use `setFocusedChatId`; remove global connection dot (moves to row-level)                                                                                                          |
| `apps/ui/app/services/chat-rpc-socket.service.ts`              | No change (already multi-room)                                                                                                                                                     |

### Files added (new)

| Path                                                                                               | Purpose                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/ui/app/hooks/chat-instance-registry.ts`                                                      | Per-chat `Map<chatId, ChatInstanceRecord>` with status/usage subscriptions |
| `apps/ui/app/hooks/use-chat-row-state.ts`                                                          | Composes registry + `useChats()` into `ChatRowState` for agents-panel rows |
| `apps/ui/app/routes/projects_.$id/agents-panel.tsx`                                                | The new panel (expanded list + collapsed rail)                             |
| `apps/ui/app/routes/projects_.$id/agents-panel-row.tsx`                                            | Per-chat row component                                                     |
| `apps/ui/app/routes/projects_.$id/agents-panel-trigger.tsx`                                        | Left-rail trigger for `chat-interface-desktop.tsx`                         |
| `apps/ui/app/routes/projects_.$id/agents-panel-rail.tsx`                                           | Collapsed icon-only rail variant                                           |
| `apps/ui/app/utils/agent-mutex-registry.ts`                                                        | Per-path lock for parallel write tools                                     |
| `apps/api/app/api/chat/middleware/agent-mutex.middleware.ts` (or extension to existing safeguards) | Server-side awareness so the LLM gets a structured "path locked" rejection |

### Files deleted

None — all current responsibilities relocate, none disappear.
