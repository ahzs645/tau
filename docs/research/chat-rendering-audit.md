---
title: 'Chat Message Rendering Performance Audit'
description: 'Systematic audit of the chat message component tree for rendering performance issues, memoization gaps, and virtualization opportunities.'
status: active
created: '2026-03-19'
updated: '2026-03-19'
category: audit
related:
  - docs/policy/ui-policy.md
  - docs/policy/rendering-policy.md
  - docs/policy/react-policy.md
---

# Chat Message Rendering Performance Audit

Systematic review of all chat message rendering components in `apps/ui/app/routes/projects_.$id/` for React performance anti-patterns, memoization gaps, and virtualization opportunities.

## Executive Summary

Audit of the full `ChatMessage` component tree (21 components) reveals zero critical issues but 10 medium-severity findings and 40+ low-severity findings. The primary patterns are: (1) missing `memo()` on child components that receive stable props, (2) inline object/function literals that defeat parent memoization, (3) expensive derivations computed on every render without `useMemo`, and (4) missing virtualization for variable-length lists inside tool results. The `ChatMessageReasoning` component is a priority target for improvement — large reasoning blocks create unbounded DOM trees with no height constraint or content budget.

## Methodology

1. Read every component imported by `chat-message.tsx` and its transitive dependencies (`ChatToolCard`, `MarkdownViewerChat`)
2. Categorized each component by: use of `memo()`, inline allocations in JSX, derived state without `useMemo`, event handlers without `useCallback`, virtualization needs
3. Severity rated as: **critical** (causes jank on every frame), **high** (causes jank on interaction), **medium** (unnecessary work per render cycle), **low** (marginal cost, defensive improvement)

## Architecture Context

```
ChatHistory (Virtuoso message list)
  └── MessageItem (memo) → ChatMessage (memo)
        ├── ChatMessageText → MarkdownViewerChat (memo)
        ├── ChatMessageReasoning → MarkdownViewerChat (memo)
        ├── ChatMessagePlanning
        ├── ChatMessageTool* → ChatToolCard (Collapsible)
        └── When (conditional sections)
```

The outer `ChatHistory` virtualizes the message list via `react-virtuoso`. Each message is wrapped in a memoized `MessageItem`. Inside each message, the part switch statement maps `displayMessage.parts` to child components. The outer virtualization is sound — performance issues live inside the per-message subtree.

## Findings

### Finding 1: ChatMessageReasoning — Unbounded DOM, No Content Budget

**Severity**: Medium
**File**: `chat-message-reasoning.tsx`

The reasoning component renders the full `part.text` through `MarkdownViewerChat` with no DOM size constraint. Long reasoning blocks (common with Claude, GPT-4o) produce thousands of DOM nodes. The `ChatToolCard` Collapsible hides content when collapsed but leaves it mounted if `forceMount` is used.

**Issues**:

- No height constraint on open content — reasoning can push other message parts off-screen
- No content truncation — full markdown tree is built regardless of visibility
- No auto-scroll — user must manually scroll to see latest reasoning during streaming
- Binary open/closed state doesn't support a "preview" mode showing recent content

**Recommendation**: Implement a height-constrained preview mode with tail-truncated text budget and auto-scroll to bottom during streaming. See `rendering-policy.md` §1 (Content Budget) and §2 (Auto-Scroll).

### Finding 2: Missing `memo()` on 18 of 20 Child Components

**Severity**: Low (individually), Medium (aggregate)

| Component                        | Uses `memo()` | Receives stable props |
| -------------------------------- | ------------- | --------------------- |
| `ChatMessage`                    | Yes           | `messageId` (string)  |
| `ChatMessageText`                | No            | `part` (object ref)   |
| `ChatMessageReasoning`           | No            | `part`, `hasContent`  |
| `ChatMessagePlanning`            | No            | `messageId`           |
| `ChatMessageDataUsage`           | No            | `usageParts`          |
| `ChatMessageFile`                | No            | `part`                |
| `ChatMessageToolWebSearch`       | No            | `part`, `hasContent`  |
| `ChatMessageToolWebBrowser`      | No            | `part`, `hasContent`  |
| `ChatMessageToolFileEdit`        | No            | `part`                |
| `ChatMessageToolTestModel`       | No            | `part`                |
| `ChatMessageToolEditTests`       | No            | `part`                |
| `ChatMessageToolReadFile`        | No            | `part`                |
| `ChatMessageToolListDirectory`   | No            | `part`                |
| `ChatMessageToolCreateFile`      | No            | `part`                |
| `ChatMessageToolDeleteFile`      | No            | `part`                |
| `ChatMessageToolGrep`            | No            | `part`                |
| `ChatMessageToolGlobSearch`      | No            | `part`                |
| `ChatMessageToolGetKernelResult` | No            | `part`                |
| `ChatMessageToolScreenshot`      | No            | `part`                |
| `ChatMessageToolTransfer`        | No            | `part`                |

The parent `ChatMessage` is memoized and receives a stable `messageId` string. However, its children are not individually memoized. When the parent re-renders (due to `useChatSelector` state changes), all children re-render even if their specific props haven't changed.

**Recommendation**: Add `memo()` to components that do non-trivial rendering: `ChatMessageText`, `ChatMessageReasoning`, `ChatMessagePlanning`, and any tool component with expensive derived data.

### Finding 3: Inline Object/Function Literals Breaking Memoization

**Severity**: Medium

| File                               | Issue                                                                                    | Line(s) |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------- |
| `markdown-viewer-chat.tsx`         | `controls={{ ...defaultMarkdownControls, table: false }}` creates new object each render | 67      |
| `chat-message-tool-edit-file.tsx`  | `getText={() => displayContent}` recreated each render                                   | 40      |
| `chat-message-tool-edit-tests.tsx` | `getText={() => displayContent}` recreated each render                                   | 41      |
| `chat-message-file.tsx`            | `onError={() => setImageError(true)}` recreated each render                              | 17-19   |
| `chat-tool-card.tsx`               | `onClick={(event) => event.stopPropagation()}` in `ChatToolCardActions`                  | 304     |

The `markdown-viewer-chat.tsx` issue is particularly impactful: the `controls` object is created fresh every render, which means the child `MarkdownViewer` (which is `memo()`-ed) re-renders on every parent update because the `controls` prop reference changes.

**Recommendation**: Hoist static objects to module scope or wrap in `useMemo`. Wrap callback functions in `useCallback`.

### Finding 4: Expensive Derivations Without `useMemo`

**Severity**: Medium

| File                                   | Derivation                                      | Cost                  |
| -------------------------------------- | ----------------------------------------------- | --------------------- |
| `chat-message-tool-list-directory.tsx` | `[...entries].sort()` on every render           | O(n log n) per render |
| `chat-message-tool-grep.tsx`           | `Map` construction from matches on every render | O(n) per render       |
| `chat-message-tool-unknown.tsx`        | `JSON.stringify(part, null, 2)` on every render | O(n) per render       |
| `chat-message-tool-web-browser.tsx`    | `domains` and `urls` derived without memo       | O(n) per render       |

**Recommendation**: Wrap each in `useMemo` with appropriate dependency arrays.

### Finding 5: Missing Virtualization for Variable-Length Lists

**Severity**: Medium (for large result sets)

| File                                      | List                                                   | Mitigation              |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------- |
| `chat-message-tool-get-kernel-result.tsx` | `kernelIssues` — each issue renders a `MarkdownViewer` | None                    |
| `chat-message-tool-test-model.tsx`        | `passes`/`failures` lists                              | None                    |
| `chat-message-tool-list-directory.tsx`    | Directory entries                                      | `max-h-40` CSS clamp    |
| `chat-message-tool-grep.tsx`              | Grep matches                                           | Sliced to first 5 files |

The grep and directory tools have partial mitigations (slicing, CSS clamping). The kernel result and test model tools render unbounded lists with heavyweight child components (`MarkdownViewer` per issue).

**Recommendation**: Apply the ChatToolCardList pattern with `max-h` clamping for all tool result lists. For lists exceeding 20 items, consider Virtuoso.

### Finding 6: `useChatSelector` Subscription Granularity

**Severity**: Low

Multiple components subscribe to `state.status === 'streaming'` via `useChatSelector`. When the chat status changes (e.g., streaming → idle), every component with this selector re-renders. This is correct behavior (they need to update), but the cascade affects all message parts simultaneously.

The `ChatMessage` parent also subscribes to `state.messagesById.get(messageId)` and `state.messageEdits[messageId]`. If the `messagesById` Map reference changes (even for a different message), this selector may trigger unnecessary re-renders depending on selector memoization.

**Recommendation**: Verify that `useChatSelector` uses referential equality checks (like `useSelector` with shallow compare). If not, wrap selectors in component-local `useMemo` or use a selector factory pattern.

### Finding 7: `ChatMessage` Part Switch Statement Complexity

**Severity**: Low
**File**: `chat-message.tsx` lines 216-341

The `displayMessage.parts.map()` contains a 20-case switch statement that runs on every render. While the switch itself is O(1) per part, the entire parts array is re-mapped every render. Since `displayMessage.parts` may be referentially stable (from the AI SDK), the map output could be memoized.

**Recommendation**: Wrap the parts mapping in `useMemo` keyed on `displayMessage.parts`. Alternatively, extract the switch into a separate `ChatMessagePart` component wrapped in `memo()`.

### Finding 8: Inline Component Definitions in Virtuoso Config

**Severity**: Low
**File**: `chat-history.tsx` lines 197-211

```tsx
components={{
  Header: () => null,
  EmptyPlaceholder: () => ( ... ),
  Footer: () => ( ... ),
}}
```

The `components` object and its inline function components are recreated every render. Virtuoso uses shallow comparison on the `components` prop, so this causes the Virtuoso internals to re-mount these components on every parent render.

**Recommendation**: Hoist `Header`, `EmptyPlaceholder`, and `Footer` to module-scoped components or memoize the `components` object.

### Finding 9: `handleEditClick` Not Wrapped in `useCallback`

**Severity**: Low
**File**: `chat-message.tsx` lines 143-153

The `handleEditClick` function is recreated every render because it's a plain function declaration inside the component body. It's passed as `onClick` to a `div`, which doesn't benefit from memoization (DOM elements don't do reference checks on event handlers). However, if the containing `div` were ever wrapped in `memo()`, this would defeat it.

**Recommendation**: Wrap in `useCallback` for defensive memoization.

### Finding 10: `ChatToolCardActions` Inline `stopPropagation`

**Severity**: Low
**File**: `chat-tool-card.tsx` line 304

```tsx
onClick={(event) => {
  event.stopPropagation();
}}
```

This inline handler is recreated every render. Since `ChatToolCardActions` is a simple component, the impact is minimal, but wrapping in `useCallback` or hoisting to a stable reference would be more consistent.

## Recommendations Summary

| #   | Action                                                                           | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Implement height-constrained reasoning preview with text budget and auto-scroll  | P0       | Medium | High   |
| R2  | Memoize `controls` in `MarkdownViewerChat` (module-scope constant)               | P1       | Low    | High   |
| R3  | Add `memo()` to `ChatMessageText`, `ChatMessageReasoning`, `ChatMessagePlanning` | P1       | Low    | Medium |
| R4  | Wrap `getText` callbacks in `useCallback` (edit-file, edit-tests)                | P2       | Low    | Low    |
| R5  | `useMemo` for `sortedEntries`, `matchesByFile`, `JSON.stringify`                 | P2       | Low    | Medium |
| R6  | Add `max-h` clamping to kernel result and test model issue lists                 | P2       | Low    | Medium |
| R7  | Hoist Virtuoso `components` object in `ChatHistory` to module scope              | P2       | Low    | Low    |
| R8  | Wrap `onError` in `ChatMessageFile` in `useCallback`                             | P3       | Low    | Low    |
| R9  | Extract parts switch into memoized `ChatMessagePart` component                   | P3       | Medium | Medium |

## References

- Related: `docs/policy/ui-policy.md`
- Related: `docs/policy/rendering-policy.md`
- Related: `docs/policy/react-policy.md`
