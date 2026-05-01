---
title: 'Chat Image Resize Coverage Audit'
description: 'Audit of every entry point that adds an image to AI chat draft state, identifying which ones bypass resizeImageForChat and proposing a single chokepoint architecture.'
status: active
created: '2026-04-24'
updated: '2026-04-24'
category: audit
related:
  - docs/research/image-context-management-gap-analysis.md
  - docs/research/image-storage-architecture.md
  - docs/research/multimodal-agent-image-storage-patterns.md
  - docs/research/agent-screenshot-rpc-resize-audit.md
---

# Chat Image Resize Coverage Audit

Systematic review of every code path that appends an image to an AI-chat draft (`draftImages` / `editDraftImages`), checking whether each path runs the image through `resizeImageForChat()` before persisting. Quantifies gaps where unbounded images can leak into IndexedDB / Postgres / the model context window.

## Implementation

**Status:** Shipped. The chokepoint moved into the draft XState machine itself — not a per-caller `await` wrapper as the original R1 sketch (further down) proposed. The wrapper-async approach was rejected during planning because it would have required `void addDraftImage(...)` at every one of the 12 entry points and broken the workspace's "machines own lifecycle and state logic" policy. See `docs/policy/xstate-policy.md` and the accompanying chat transcript for the full rationale.

The shipped architecture:

- **Chokepoint state machine** — `apps/ui/app/hooks/draft.machine.ts`. The new `imageProcessing` parallel sub-region owns a FIFO `imageQueue` populated by `addDraftImage` / `addEditDraftImage` events with raw data URLs. The `resizing` state invokes the production resize actor against the queue head, appends the resized URL on success, and shifts the queue + emits `imageResizeFailed` on error.
- **Production actor** — `apps/ui/app/hooks/resize-image.actor.ts` exports the single `resizeImageActor` (a `fromSafeAsync` wrapper around `resizeImageForChat`). It is provided to the machine via `.provide()` at both ownership sites: `apps/ui/app/services/chat-session-store.ts` (session-backed chats) and `apps/ui/app/hooks/active-chat-provider.tsx` (`EphemeralActiveChatProvider` for marketing/homepage routes).
- **Unified error surface** — `apps/ui/app/hooks/use-draft-image-error-toast.ts` is the only place in the app that toasts on resize failures. `<ActiveChatProvider>` mounts one subscriber per active chat, so all 12 entry points (drag/drop, paste, file picker, capture-view, …) inherit error reporting without per-caller `try/catch`. This is what closes F5 (the silent Tiptap paste rejection).
- **Caller cleanup** — `chat-textarea-types.ts`, `tiptap/use-chat-editor.ts`, and `capture-view-screenshot.utils.ts` no longer import `resizeImageForChat`. They forward raw data URLs straight to `addDraftImage` / `addEditDraftImage` / `onImagePaste`. Composite screenshot in `chat-textarea.tsx` and the three mobile `chat-context-actions.tsx` callbacks (F2, F1) close automatically because they already passed raw URLs to `addImage`.
- **Regression net** — `apps/ui/app/components/chat/chat-image-resize-contract.test.tsx` (R4 contract) drives the **real** `resizeImageForChat` through the machine for all 12 entry points plus a 5-file ordered drop and a corrupt-mid-batch case, asserting `length <= MAX_DATA_URL_LENGTH` and FIFO ordering. `apps/ui/app/hooks/draft.machine.test.ts` covers the FIFO/queue/emit invariants in isolation, `apps/ui/app/hooks/active-chat-provider.test.tsx` covers the toast wiring, and per-leak-site regression tests in `chat-textarea-types.test.tsx`, `tiptap/use-chat-editor.test.ts`, and `geometry/cad/capture-view-control.test.tsx` lock in that callers never re-introduce inline resizing.

The agent-side RPC screenshot path (`apps/ui/app/hooks/rpc-handlers.ts`) is **not** part of this chokepoint — it is tracked separately in `docs/research/agent-screenshot-rpc-resize-audit.md` as the R6 follow-up.

## Executive Summary

`resizeImageForChat()` (`apps/ui/app/utils/resize-image.ts`) is the canonical 1568×1568 / ≤1 MB JPEG normaliser for chat images. The user-facing OS file pipelines (drag-drop, file-picker, clipboard paste — both plain `<textarea>` and Tiptap variants) correctly funnel through it. However, **5 of the 12 image entry points bypass `resizeImageForChat()` entirely**, three of them on the mobile path and two on the desktop "orthographic 6-views" composite-screenshot path. The bypassed paths can produce base64 payloads up to ~5–10× the 1 MB cap, which then hit IndexedDB persistence, the chat-history wire format, and the LLM input window unmodified.

The structural root cause is that resize is enforced at every **caller site** rather than at the single chokepoint (the draft XState machine's `addDraftImage` / `addEditDraftImage` actions). Every new feature that adds an image is therefore one missed `await resizeImageForChat()` away from a leak. Recommendation R1 (move the resize into the draft-machine actions) eliminates the entire class of regressions in one change.

`apps/ui/app/routes/_index/route.tsx` (homepage chat) and the project-page chat (`apps/ui/app/routes/projects_.$id/`) both consume the shared `<ChatTextarea>` component, so they inherit the same coverage profile — the per-route `onSubmit` handlers do not handle images directly. The leaks are inside the shared component tree, which means fixing them once fixes them everywhere.

## Problem Statement

The user reported that `apps/ui/app/components/chat/chat-textarea.tsx` runs added images through a resize step before persisting them in chat, and asked whether the same protection exists on `apps/ui/app/routes/_index/route.tsx` (homepage) and on every other call site that can put an image into the chat draft. Without uniform coverage:

- Oversized base64 payloads inflate IndexedDB writes and the persisted chat row.
- Anthropic / OpenAI / Vertex requests carry raw multi-megabyte data URLs into every subsequent turn (Anthropic re-resizes server-side to 1568px anyway, so we are paying transmit + processing cost for nothing).
- Chat compaction and history scrollback re-emit the same oversized payload.
- The "leak" is silent — the agent loop still works, so there is no error to catch in tests.

## Methodology

1. Located `resizeImageForChat()` and enumerated every call site (5 found).
2. Enumerated every code path that ends in `addDraftImage` / `addEditDraftImage` / `addImage` on the draft machine, then traced backwards from each call site to confirm whether the data URL was first passed through `resizeImageForChat()`.
3. Cross-referenced the draft machine (`apps/ui/app/hooks/draft.machine.ts`) to confirm there is no resize gate inside the actions themselves.
4. Inspected the homepage (`_index/route.tsx`), project page (`projects_.$id/`), library page (`projects_.library/route.tsx`), and CTA section (`_index/cta-section.tsx`) to confirm each `<ChatTextarea>` consumer doesn't intercept images upstream.
5. Verified the existing test coverage around `resizeImageForChat` to understand what regressions tests would catch.

## Findings

### Coverage Inventory

Every code path that appends an image to chat draft state, classified by whether it passes through `resizeImageForChat()`:

| #   | Entry point                                                              | File:line                                                                                             | Resize? | Risk                                   |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------- | -------------------------------------- |
| 1   | OS file drag-drop on chat textarea                                       | `apps/ui/app/components/chat/chat-textarea-types.ts:445`                                              | ✅      | —                                      |
| 2   | OS file picker (paperclip button)                                        | `apps/ui/app/components/chat/chat-textarea-types.ts:472`                                              | ✅      | —                                      |
| 3   | Clipboard paste (plain `<textarea>` mobile path)                         | `apps/ui/app/components/chat/chat-textarea-types.ts:526`                                              | ✅      | —                                      |
| 4   | Clipboard paste (Tiptap desktop)                                         | `apps/ui/app/components/chat/tiptap/use-chat-editor.ts:302`                                           | ⚠️      | No try/catch — silent rejection        |
| 5   | Viewer-toolbar "Capture view" button                                     | `apps/ui/app/components/geometry/cad/capture-view-control.tsx` (both `CaptureViewControl` + overflow) | ✅      | — (via `captureViewScreenshot`)        |
| 6   | Viewer-pane drag-drop into chat composer                                 | `apps/ui/app/components/chat/chat-textarea.tsx:212`                                                   | ✅      | — (via `captureViewScreenshot`)        |
| 7   | Desktop `@`-suggestion screenshot action — **single view**               | `apps/ui/app/components/chat/chat-textarea.tsx:298`                                                   | ✅      | — (via `captureViewScreenshot`)        |
| 8   | Desktop `@`-suggestion screenshot action — **composite (6 ortho views)** | `apps/ui/app/components/chat/chat-textarea.tsx:284`                                                   | ❌      | **Leak** — ~6× 800px panels in one PNG |
| 9   | Mobile `@`-popover "Current view" screenshot                             | `apps/ui/app/components/chat/chat-context-actions.tsx:242` (`handleAddModelScreenshot`)               | ❌      | **Leak**                               |
| 10  | Mobile `@`-popover "Orthographic views x 6" composite                    | `apps/ui/app/components/chat/chat-context-actions.tsx:269` (`handleAddAllViewsScreenshots`)           | ❌      | **Leak** — largest single payload      |
| 11  | Mobile `@`-popover per-non-main-view screenshot                          | `apps/ui/app/components/chat/chat-context-actions.tsx:213` (`handleViewScreenshot`)                   | ❌      | **Leak**                               |
| 12  | Edit-mode draft (`<ChatTextarea mode='edit'>`) — re-uses entries 1–4     | `apps/ui/app/routes/projects_.$id/chat-message.tsx:519`                                               | ✅      | Inherits paths 1–4                     |

Five distinct leak sites (#8–#11), three of them mobile-only.

### Finding 1: The mobile `@`-context screenshot menu bypasses resize entirely

`apps/ui/app/components/chat/chat-context-actions.tsx` is the mobile-only context menu (the desktop equivalent lives in `chat-textarea.tsx` via Tiptap suggestions). It contains three callbacks that capture screenshots and feed them straight into `addImage(dataUrl)` — the prop comes from the parent and resolves to either `handleContextImageAdd` (popover variant) or `handleAddImage` (drawer variant), neither of which resizes:

```203:226:apps/ui/app/components/chat/chat-context-actions.tsx
  const handleViewScreenshot = useCallback(
    (graphicsRef: ActorRefFrom<typeof graphicsMachine>) => {
      if (asPopoverMenu) {
        onClose?.();
      }

      takeScreenshot(graphicsRef, {
        type: 'single',
        onSuccess(dataUrls) {
          const dataUrl = dataUrls[0];
          if (dataUrl) {
            addImage(dataUrl);
```

The same pattern repeats for `handleAddModelScreenshot` (line 242) and `handleAddAllViewsScreenshots` (line 269). The composite "Orthographic views x 6" call captures 6 panels at 800px each, composed into a single PNG — this is the largest payload of any leak site and the most likely to exceed 1 MB.

`ChatContextActions` is wired from two places in `chat-textarea-mobile.tsx`:

- L312 — the mobile drawer's "Add context" submenu (`addImage={handleDrawerAddImage}` → `handleAddImage` → `addDraftImage`)
- L374 — the inline `@`-mention popover (`addImage={handleContextImageAdd}` → `addImage` → `addDraftImage`)

Both wrappers append directly to draft state without resize.

### Finding 2: The desktop composite-screenshot path also bypasses resize

`chat-textarea.tsx` `handleScreenshotAction` has two branches: single-view (correctly delegates to `captureViewScreenshot`, which does resize) and composite. The composite branch is inline and does **not** resize:

```280:294:apps/ui/app/components/chat/chat-textarea.tsx
          onSuccess(dataUrls) {
            cleanup();
            const dataUrl = dataUrls[0];
            if (dataUrl) {
              handleAddImageRef.current(dataUrl);
            } else {
              toast.error('Failed to capture composite screenshot');
            }
          },
```

`handleAddImageRef.current` resolves to `logic.handleAddImage`, which in turn calls `addImage()` — no resize. The composite is captured at `maxResolution: 800` per panel, which the `screenshotRequestMachine` then assembles into a 3×2 grid with labels and dividers. Empirically, composites can exceed 1 MB before base64 expansion (1.33×).

### Finding 3: The draft machine has no resize gate — it trusts every caller

`apps/ui/app/hooks/draft.machine.ts` is the single source of truth for chat draft state. Its `addDraftImage` / `addEditDraftImage` actions are pure assigns that append the supplied string verbatim:

```195:205:apps/ui/app/hooks/draft.machine.ts
        addDraftImage: {
          actions: assign({
            draftImages: ({ context, event }) => [...context.draftImages, event.image],
          }),
        },
```

There is no validation, no normalization, no size cap. The contract is "callers must resize first". This is the structural root cause of the leaks — every new screenshot/upload flow has to remember to call `resizeImageForChat()` and there is no enforcement at the chokepoint.

### Finding 4: `handleAddImage` and `handleContextImageAdd` are unsafe public surface

`useChatTextareaLogic` exports two callbacks that are passed throughout the component tree as `(image: string) => void`:

```546:553:apps/ui/app/components/chat/chat-textarea-types.ts
  const handleAddImage = useCallback(
    (image: string): void => {
      addImage(image);
      focusInput();
    },
    [focusInput, addImage],
  );
```

The signature implies "the caller has already resized". But the type system can't enforce this — any consumer can pass a raw 4 MB data URL and silently leak it into the draft. Today, the in-tree callers do the right thing (modulo the leaks above), but the surface is fragile.

### Finding 5: Tiptap clipboard paste swallows resize errors silently

`apps/ui/app/components/chat/tiptap/use-chat-editor.ts:290-308` runs `resizeImageForChat()` inside an unawaited IIFE without try/catch:

```297:306:apps/ui/app/components/chat/tiptap/use-chat-editor.ts
                const reader = new FileReader();
                reader.addEventListener('load', (readerEvent) => {
                  const result = readerEvent.target?.result;
                  if (typeof result === 'string' && result !== '') {
                    void (async () => {
                      const resized = await resizeImageForChat(result);
                      onImagePasteRef.current?.(resized);
                    })();
                  }
                });
```

Compare with the equivalent flow in `chat-textarea-types.ts` which wraps every `resizeImageForChat()` call in try/catch and toasts on failure. If the resize throws (zero-dimension image, canvas context unavailable, decoder failure), the user sees no feedback and the paste silently disappears.

### Finding 6: Per-route consumers do not intercept images

The four routes that mount `<ChatTextarea>` — `_index/route.tsx`, `_index/cta-section.tsx`, `projects_.library/route.tsx`, `projects_.$id/chat-history.tsx` — only consume images at submit time via the `imageUrls` parameter:

```174:194:apps/ui/app/routes/_index/route.tsx
  const onSubmit: ChatTextareaProperties['onSubmit'] = useCallback(
    async ({ content, model, metadata, imageUrls }) => {
      try {
        const createProject = await projectManager.createProject({
          kernel,
          initialMessage: { content, model, metadata, imageUrls },
```

By the time `onSubmit` fires, the images are already in `draftImages`. Per-route handlers don't add images — they only forward the already-stored array. **Therefore the homepage inherits the exact same coverage profile as the project page**: the leaks are upstream in the shared component tree, not per-route. Fixing the leaks once fixes every route simultaneously.

### Finding 7: The 1 MB cap matters more than the 1568px cap

`MAX_DATA_URL_LENGTH = 1_398_102` (≈1 MB raw after base64 expansion) is the operational ceiling. The `MAX_DIMENSION = 1568` cap is a secondary optimization aligned with Anthropic's internal resize. A composite screenshot at 800×800 per panel × 6 panels in a 3×2 grid = 2400×1600 image — under the dimension cap but easily exceeding 1 MB at PNG/WebP encoding densities, especially with text labels overlaid. Without `resizeImageForChat()`, the JPEG quality ladder (0.85 → 0.7 → 0.5 → 0.3) and the 800px last-resort fallback never fire.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                    | Priority | Effort | Impact                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| R1  | Move `resizeImageForChat()` into the draft machine (`addDraftImage` / `addEditDraftImage` actions) so it becomes the single chokepoint and every caller is automatically covered                                                                                                          | P0       | Medium | Eliminates the entire class of leaks; future-proofs new features                                           |
| R2  | Until R1 lands, add `resizeImageForChat()` to the 4 leak sites (#8, #9, #10, #11)                                                                                                                                                                                                         | P0       | Low    | Closes today's leaks                                                                                       |
| R3  | Wrap the Tiptap paste's `resizeImageForChat()` call in try/catch + toast.error parity with `chat-textarea-types.ts`                                                                                                                                                                       | P1       | Low    | Restores user feedback on failed paste                                                                     |
| R4  | Add a contract test that exercises every entry-point pathway with a >1 MB synthetic data URL and asserts the resulting draft entry is ≤1 MB                                                                                                                                               | P1       | Medium | Prevents regression after R1                                                                               |
| R5  | After R1, inline-document the draft-machine actions: "All image data URLs pass through `resizeImageForChat()` here — never call from outside the machine"                                                                                                                                 | P2       | Low    | Codifies the contract                                                                                      |
| R6  | Audit the API-side `captureScreenshot` / `captureObservations` RPC outputs (`apps/ui/app/hooks/rpc-handlers.ts:328-452`) which return data URLs to the AI agent — these are not draft images but they are persisted in tool-output chat parts and incur the same Anthropic re-resize cost | P2       | Medium | Out of scope of this audit but adjacent leak class; see also `docs/research/image-storage-architecture.md` |

### Recommended implementation for R1

> **Updated:** the chokepoint moved into the draft machine itself (see the **Implementation** section near the top of this document) to avoid the `void`/`await` ceremony at every entry point and to keep the workspace's "machines own lifecycle" policy. The wrapper-async sketch below is preserved for historical context only — see `apps/ui/app/hooks/draft.machine.ts` and `apps/ui/app/hooks/resize-image.actor.ts` for the actual shipped implementation.

~~The draft machine's `addDraftImage` action becomes the chokepoint. Because XState `assign` actions are synchronous, the resize must run inside an actor (`fromPromise`) and the event must be re-issued after resize succeeds, OR — preferred — the resize stays in the calling layer but is hoisted into a dedicated action exported from `use-chat.tsx`:~~

```typescript
addDraftImage: async (image: string) => {
  const resized = await resizeImageForChat(image);
  draftActorRef.send({ type: 'addDraftImage', image: resized });
},
```

~~All current call sites already `await` the surrounding async flow, so the signature change from `(image: string) => void` to `(image: string) => Promise<void>` is non-breaking when callers are updated to `await`. The exported `useChatActions().addDraftImage` becomes the single chokepoint and `chat-context-actions.tsx`, the composite branch in `chat-textarea.tsx`, and any future consumer can pass a raw data URL safely.~~

~~Tests under `apps/ui/app/utils/resize-image.test.ts` already cover the resize semantics — R1 should add a parallel suite under `apps/ui/app/hooks/use-chat.test.ts` (or `draft.machine.test.ts`) that asserts the action resizes its input.~~

## Trade-offs

### Where to put the chokepoint

| Location                                                            | Pros                                                                                      | Cons                                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`useChatActions()` wrapper** (recommended)                        | Single import surface; no XState changes; existing async callers don't need restructuring | One layer of indirection between hook and machine                                                                                                |
| Inside the XState `addDraftImage` action via `fromPromise` actor    | Most architecturally pure — chokepoint at state machine boundary                          | Requires reworking actions into invoked actors; complicates the synchronous test surface; image events become async without callers expecting it |
| Inside `chat-persistence.machine.ts` (right before IndexedDB write) | Catches images even if a future bug bypasses the draft machine                            | Image is already in memory unsized; doesn't help the model-context leak (the unsized image is sent on the same submit)                           |
| Per-caller (current state)                                          | Simple, explicit                                                                          | Fragile — every new feature has to remember; today's audit found 5 leaks                                                                         |

The `useChatActions()` wrapper is the smallest change with the largest coverage gain.

## Code Examples

### Current leak — composite screenshot in `chat-textarea.tsx`

```280:294:apps/ui/app/components/chat/chat-textarea.tsx
          onSuccess(dataUrls) {
            cleanup();
            const dataUrl = dataUrls[0];
            if (dataUrl) {
              handleAddImageRef.current(dataUrl);
            } else {
              toast.error('Failed to capture composite screenshot');
            }
          },
```

### Proposed fix matching the single-view branch

```typescript
async onSuccess(dataUrls) {
  cleanup();
  const dataUrl = dataUrls[0];
  if (!dataUrl) {
    toast.error('Failed to capture composite screenshot');
    return;
  }
  try {
    const resized = await resizeImageForChat(dataUrl);
    handleAddImageRef.current(resized);
  } catch {
    toast.error('Failed to process composite screenshot');
  }
},
```

After R1 ships, the resize disappears from the call site — `handleAddImageRef.current(dataUrl)` becomes safe.

## Diagrams

```
                        ┌──────────────────────────────┐
                        │   Image entry sources        │
                        ├──────────────────────────────┤
  drag-drop ────────┐   │ 1  OS drag-drop          ✅  │
  file picker ──────┤   │ 2  File picker           ✅  │
  clipboard ────────┤   │ 3  Clipboard (textarea)  ✅  │
  Tiptap paste ─────┤   │ 4  Clipboard (Tiptap)    ⚠️  │
  viewer toolbar ───┤   │ 5  Viewer "Capture view" ✅  │
  viewer drag ──────┤   │ 6  Viewer pane drag      ✅  │
  desktop @-menu ───┤   │ 7  Desktop @ single      ✅  │
                    │   │ 8  Desktop @ composite   ❌  │
  mobile @-menu ────┤   │ 9  Mobile @ current      ❌  │
                    │   │ 10 Mobile @ ortho x6     ❌  │
                    │   │ 11 Mobile @ per-view     ❌  │
                    └─►┌┴──────────────────────────────┴─┐
                       │ resizeImageForChat()  (skipped) │
                       │   1568×1568 cap                 │
                       │   JPEG quality ladder           │
                       │   ≤1 MB output                  │
                       └─────────────────┬───────────────┘
                                         ▼
                       ┌─────────────────────────────────┐
                       │ draft.machine                   │
                       │   addDraftImage   (no gate)     │
                       │   addEditDraftImage (no gate)   │
                       └─────────────────┬───────────────┘
                                         ▼
                       ┌─────────────────────────────────┐
                       │ chat-persistence.machine        │
                       │   IndexedDB / Postgres          │
                       └─────────────────┬───────────────┘
                                         ▼
                       ┌─────────────────────────────────┐
                       │ submit → API → LLM context      │
                       └─────────────────────────────────┘
```

After R1 the chokepoint moves up one layer:

```
  every entry source ──► useChatActions().addDraftImage ──► resize ──► machine
```

## References

- Implementation: `apps/ui/app/utils/resize-image.ts`
- Tests: `apps/ui/app/utils/resize-image.test.ts`
- Prior research: `docs/research/image-context-management-gap-analysis.md` — original tracking doc that introduced `resizeImageForChat()` and asserted "Wired into all 4 image entry points" (correct at the time, but mobile screenshot menu and desktop composite have since drifted)
- Storage architecture: `docs/research/image-storage-architecture.md`
- External validation: `docs/research/multimodal-agent-image-storage-patterns.md` (notes Tau's resize approach is architecturally superior to API-side resize)

## Appendix: Call-graph trace for each leak

### Leak 8 — Desktop composite

```
ChatTextareaDesktop
  └─ useChatEditor (action items)
       └─ Suggestion menu picks 'Orthographic views x 6'
            └─ chat-textarea.tsx onScreenshotAction(item)
                 └─ handleScreenshotAction(item)
                      └─ if type === 'composite'  [chat-textarea.tsx:244]
                           └─ screenshotRequestMachine.send('requestCompositeScreenshot')
                                └─ onSuccess(dataUrls) → handleAddImageRef.current(dataUrl)
                                     └─ logic.handleAddImage → addImage → addDraftImage  ← UNSIZED
```

### Leak 9 — Mobile @-popover "Current view"

```
ChatTextareaMobile
  └─ ChatContextActions (asPopoverMenu, addImage = handleContextImageAdd)
       └─ contextItem 'add-current-view-screenshot'.action
            └─ handleAddModelScreenshot                              [chat-context-actions.tsx:228]
                 └─ takeScreenshot(mainGraphicsRef, type='single')
                      └─ onSuccess(dataUrls) → addImage(dataUrl)     [chat-context-actions.tsx:242]
                           └─ handleContextImageAdd → addImage → addDraftImage  ← UNSIZED
```

### Leak 10 — Mobile @-popover composite

```
…ChatContextActions → contextItem 'add-all-views-screenshots'.action
  └─ handleAddAllViewsScreenshots                                    [chat-context-actions.tsx:255]
       └─ takeScreenshot(mainGraphicsRef, type='composite')
            └─ onSuccess(dataUrls) → addImage(compositeDataUrl)      [chat-context-actions.tsx:269]
                 └─ handleContextImageAdd → addImage → addDraftImage ← UNSIZED (largest payload)
```

### Leak 11 — Mobile @-popover per-non-main-view

```
…ChatContextActions → per-view contextItem.action(graphicsRef)
  └─ handleViewScreenshot(graphicsRef)                               [chat-context-actions.tsx:202]
       └─ takeScreenshot(graphicsRef, type='single')
            └─ onSuccess(dataUrls) → addImage(dataUrl)               [chat-context-actions.tsx:213]
                 └─ handleContextImageAdd → addImage → addDraftImage ← UNSIZED
```

### Same-shape paths that DO resize (for contrast)

```
chat-textarea.tsx single-view handleScreenshotAction
  └─ captureViewScreenshot(...)                       [chat-textarea.tsx:298]
       └─ resizeImageForChat(dataUrl) ✅              [capture-view-screenshot.utils.ts:70]
            └─ onImage(resized) → handleAddImage → addImage → addDraftImage

CaptureViewControl toolbar button
  └─ captureViewScreenshot(...)                       [capture-view-control.tsx:49]
       └─ resizeImageForChat(dataUrl) ✅
            └─ onImage(resized) → addDraftImage
```

The single-view paths consolidate around `captureViewScreenshot()`, which owns the resize. The composite path on desktop and **all** the mobile paths in `chat-context-actions.tsx` were never refactored to use a similar shared helper, leaving them stranded with inline screenshot machines and no resize step.
