---
title: 'Pinning the Last User Message to the Top During Streaming'
description: 'Cross-browser strategies for ChatGPT/Cursor-style scroll behavior that anchors the latest user message to the top of the chat viewport while the assistant streams below.'
status: active
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/chat-rendering-audit.md
  - docs/policy/ui-policy.md
  - docs/policy/react-policy.md
---

# Pinning the Last User Message to the Top During Streaming

Investigation of how Cursor, ChatGPT, Claude.ai, t3.chat, and HuggingChat anchor the most recently submitted user message at the top of the chat viewport while the assistant reply streams in below — and how to bring that behavior to Tau's `apps/ui/app/routes/projects_.$id/chat-history.tsx` while keeping the existing `react-virtuoso` virtualization.

## Executive Summary

Every shipping AI chat UI converges on the same shape: **a virtual "spacer" of viewport height is reserved below the just-submitted user message so that a single jump to the bottom positions the user message flush at the top, and the streaming assistant reply fills downward into that reservation.** The mechanism is overwhelmingly CSS-led (a `min-height` applied to the last assistant slot or a sized footer), with a one-shot programmatic scroll triggered on submit and natural overflow handling everything thereafter.

The browser primitive that _would_ make this trivial — `overflow-anchor` — is still effectively unusable because Safari shipped support only in Safari TP / 26.x at the time of writing, with stable Safari 26.5 still listed as **not supported** on Can I Use. Any production design must work without it.

For Tau's `react-virtuoso`-based history, the recommended approach is a hybrid:

1. A pure-CSS `min-height: calc(100% - <breathing>)` reservation applied to the **last** Virtuoso item wrapper (the existing `MessageItem` div).
2. A Virtuoso `Footer` whose height is computed (via a `ResizeObserver` on the streaming assistant message) so that the user message stays pinned even as the assistant reply grows past one viewport height.
3. A single `requestAnimationFrame`-deferred `virtuosoRef.current.scrollToIndex({ index: 'LAST', align: 'end' })` triggered on user-message submit (not on every streaming token), with `followOutput` flipped from `'smooth'` to a guarded function that only follows when the user is at the bottom.

This avoids `overflow-anchor` entirely, requires no JS during streaming (the spacer + Virtuoso's existing measurement loop handle growth), and stays compatible with the free `react-virtuoso` package (`@virtuoso.dev/message-list` is **commercial**, $168/seat/year, and is not an option for Tau).

## Problem Statement

When a user submits a message in Cursor (and ChatGPT, Claude.ai, Gemini, Grok, t3.chat), the chat viewport behavior is:

1. The just-submitted user message animates/snaps to the **top** of the visible scroll viewport.
2. The previous conversation is pushed up out of view (still scrollable).
3. The assistant reply streams into the empty space _below_ the user message, filling it top-down.
4. The scroll position **stays pinned at the bottom** of the scroller even as content grows, so the user's message remains at the top of the viewport for as long as the assistant's reply fits in roughly one viewport.
5. Once the assistant reply outgrows the viewport, the user message scrolls off the top naturally, and the bottom of the streaming reply becomes the new "stick to bottom" anchor.

Tau's current implementation in `apps/ui/app/routes/projects_.$id/chat-history.tsx` (lines 205–227) uses `<Virtuoso followOutput='smooth' />` with no spacer or pinning logic. The result: when a user submits a message at the bottom of a long chat, the new message appears at the **bottom** of the viewport (a single line tall), and the assistant reply pushes it upward as it streams. There is no "blank canvas" effect; the eye has to chase a moving target.

The user's request is for the Cursor-style behavior, achieved primarily through CSS, with cross-browser support (including Safari).

## Methodology

1. Read `chat-history.tsx` and the surrounding Virtuoso wiring to inventory current scroll behavior.
2. Surveyed published implementations in: HuggingChat (`huggingface/chat-ui#2226`, merged Apr 2026), t3code (`pingdotgg/t3code#145`), Vercel AI Elements (`Conversation`), Coder/coder (`#23451`, Apr 2026), Vercel AI chatbot (`#638`, `#577`), and the Stack Overflow canonical question (`#79698278`).
3. Audited the `use-stick-to-bottom` library used by `bolt.new` to understand the production-grade JS-side approach.
4. Verified Can I Use data for `overflow-anchor`, `100dvh`, `scroll-padding-block-start`, and `scroll-snap-*` to scope the cross-browser baseline.
5. Cross-referenced `react-virtuoso` (free) vs `@virtuoso.dev/message-list` (paid) capabilities to determine which Virtuoso primitives are usable.

## Findings

### Finding 1: The "viewport-height spacer" is the universal pattern

Every single production chat we surveyed uses some variant of "reserve approximately one viewport's worth of vertical space below the latest user message, then scroll to the bottom once on submit." The space-reservation mechanism is the only meaningful axis of variation.

| App / Library               | Spacer mechanism                                                                                                              | Trigger         | Browser-API dependency |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------- |
| **ChatGPT** (DOM inspect)   | `min-height` on the last assistant slot, `~100vh` minus chrome                                                                | Submit + stream | none (pure CSS)        |
| **Claude.ai** (DOM inspect) | `min-height: calc(100dvh - <composer>)` on a wrapper around the latest exchange                                               | Submit + stream | none (pure CSS)        |
| **Cursor IDE**              | Container in `flex-col-reverse`, `ResizeObserver` re-pins to bottom on growth                                                 | Submit + stream | `ResizeObserver`       |
| **HuggingChat (#2226)**     | Dynamic `<div>` spacer below the message list, height computed each render, `transition: height 300ms`                        | Submit + stream | `ResizeObserver`       |
| **Vercel AI Elements**      | `<Conversation>` wraps `use-stick-to-bottom` (spring + `ResizeObserver`)                                                      | Submit + stream | `ResizeObserver`       |
| **t3code (#145)**           | TanStack Virtual with last 8 rows unvirtualized + `rAF`-scheduled stick-to-bottom + `ResizeObserver` for composer             | Submit + stream | `ResizeObserver`       |
| **Coder/coder (#23451)**    | `flex-col-reverse` + `ResizeObserver` on inner content; sign-aware scrollTop compensation (Chrome negative, Firefox positive) | Submit + stream | `ResizeObserver`       |
| **`use-stick-to-bottom`**   | `ResizeObserver` + custom spring algorithm; scroll-anchors without `overflow-anchor`                                          | Continuous      | `ResizeObserver`       |

**The minimum viable mechanism is just CSS `min-height`** on the last item plus a single `scrollTop = scrollHeight` (or `scrollIntoView({ block: 'start' })`) on submit. Everything beyond that — `ResizeObserver`-driven dynamic spacer, spring animations, scroll-anchor compensation — is polish for the "user scrolled away mid-stream" edge cases.

### Finding 2: `overflow-anchor` is not yet a viable cross-browser primitive

`overflow-anchor: auto` (the spec's intended solution to the problem) is the CSS feature that would let the browser keep an anchored element visually static while content above it grows. Setting it to `none` disables the browser's automatic anchoring; setting (or leaving) it to `auto` enables it.

**Can I Use snapshot (April 2026):**

| Engine            | Status                                                      |
| ----------------- | ----------------------------------------------------------- |
| Chrome 56+        | Supported                                                   |
| Edge 79+          | Supported                                                   |
| Firefox 66+       | Supported                                                   |
| **Safari stable** | **Not supported** through 26.5 (TP shows the first support) |
| iOS Safari        | Not supported                                               |
| Samsung Internet  | Not supported on most versions                              |

**Implication:** Tau cannot rely on `overflow-anchor` as the _primary_ mechanism for pinning, since Safari/iOS users would experience the message jumping on every token. We can still set `overflow-anchor: none` as a defensive disable on browsers that _do_ support it, to prevent the auto-anchor heuristic from fighting our explicit scroll calls.

### Finding 3: The HuggingChat dynamic-spacer pattern is the closest production reference

`huggingface/chat-ui#2226` (merged Apr 2026 by the HF team, authored with Claude Code) implements the exact behavior the user is asking for. The mechanic is:

```tsx
// Pseudocode from PR #2226
function computeSpacerHeight(container: HTMLElement, lastUserMsg: HTMLElement): number {
  const scrollerHeight = container.clientHeight;
  const lastUserTop = lastUserMsg.offsetTop;
  const lastChildBottom = container.scrollHeight;
  const distance = lastChildBottom - lastUserTop;
  // Reserve enough so that scrolling to bottom puts lastUserMsg at the top.
  return Math.max(MIN_SPACER, scrollerHeight - distance - TOP_OFFSET);
}

<div className="messages">
  {messages.map(...)}
  <div
    style={{ height: spacerHeight }}
    className="transition-[height] duration-300"
  />
</div>
```

A `ResizeObserver` on the messages wrapper recomputes `spacerHeight` whenever the streaming assistant message grows. The spacer shrinks as the assistant reply expands, so the bottom of the conversation always coincides with the bottom of the visible viewport, and the user message stays glued to the top until the reply outgrows the viewport.

Notable refinements from the PR commit timeline:

- **50–80px top offset**: pure-pinned-to-edge looks claustrophobic; HF settled on a 50px breathing room above the user message (`06a4109` → `a1968e8`).
- **Smooth scroll on submit**: instant scroll feels jarring (`ef1b5c4`).
- **Skip the spacer for the first exchange**: in an empty chat, a viewport-tall spacer below a single greeting feels broken (`6f3ed71` → `a1de5b3`).
- **Off-by-one in spacer activation**: the spacer must be active starting from the message _just_ submitted, not the previous one (`536c315`).

These match the same edge-case knobs visible in t3.chat and Cursor.

### Finding 4: `react-virtuoso` (free) supports this; `@virtuoso.dev/message-list` (paid) is not an option

Tau's `package.json` pins `react-virtuoso ^4.18.1`. The `<Virtuoso>` component used in `chat-history.tsx` is the free, MIT-licensed component.

`<VirtuosoMessageList>` (a separate package, `@virtuoso.dev/message-list`) has first-class support for this exact pattern via its `data` `scrollModifier` API (`'auto-scroll-to-bottom'`, `{ type: 'item-location', purgeItemSizes: true }`, etc.) and a `StickyFooter` component. **It is a commercial product**: $168/seat/year (Standard) or $312/seat/year (Pro), per-developer, annual. Adopting it would require a license purchase per active contributor and would couple Tau to a paid dependency. Out of scope unless the budget is approved.

The free `<Virtuoso>` component still supports the spacer pattern through three usable surfaces:

1. **`itemContent` per-item wrapper**: a `min-height` set on the **last** item's wrapper div is measured by Virtuoso's height tracker and treated as part of the item's natural size. This is the simplest way to reserve viewport-tall space.
2. **`Footer` component**: Virtuoso renders a `Footer` after the last item; its height is included in `scrollHeight`. We can render a `<div style={{ height: spacerHeight }} />` here and update `spacerHeight` via a `ResizeObserver` on the streaming assistant message (the HuggingChat pattern, adapted).
3. **`increaseViewportBy={{ bottom: N }}`**: Virtuoso's prop that adds invisible viewport overflow used for over-scan; **not** appropriate for spacer reservation (it doesn't extend `scrollHeight`).

Watch-outs specific to Virtuoso:

- `followOutput='smooth'` (current setting on line 209) is a **boolean-or-function** prop. As a string `'smooth'`, it auto-follows on every item-content change, which fights against the "stay at bottom" heuristic during streaming. We need `followOutput={(isAtBottom) => isAtBottom && 'smooth'}` so we only chase when the user hasn't escaped.
- A sticky-positioned `Footer` interferes with `scrollToIndex({ index: 'LAST', align: 'end' })` (see `petyosi/react-virtuoso#1071`). Our spacer Footer must not be `position: sticky`.
- When the spacer's height changes, Virtuoso re-measures the footer, but the scroll position is preserved — no extra `scrollTo` calls are needed mid-stream.

### Finding 5: A pure-CSS variant exists and is sufficient for the common case

If we accept the trade-off of _not_ shrinking the spacer as the assistant reply grows (i.e., the "blank canvas" stays at constant viewport-height, and once the reply overflows it, behavior reverts to standard scroll-to-bottom), the entire feature collapses to one CSS rule and one `scrollToIndex` call:

```tsx
// Inside MessageItem renderer:
const isLast = index === messageIds.length - 1;

<div
  className={cn(
    'py-1',
    // Only the last item reserves the canvas.
    isLast && 'min-h-[calc(100%_-_var(--chat-top-breathing))]',
  )}
>
  <ChatMessage messageId={messageId} />
</div>;
```

with `--chat-top-breathing: 3rem` (so the user message has 48px of breathing room at the top of the viewport).

This is exactly the technique in Jerrick Hakim's blog (`jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps`): `last:min-h-[calc(100dvh-200px)]` on the last message with Tailwind's `last:` modifier. It works because:

1. The Virtuoso scroller's `clientHeight` is the available viewport.
2. A `min-height: 100%` on the last item makes that item at least as tall as the scroller.
3. After a single `scrollToIndex({ index: 'LAST', align: 'end' })` on submit, the scroller's `scrollTop` puts the start of the last item at the top of the viewport, and the rest of the item (the reserved canvas) fills downward.
4. As the assistant reply streams and grows the _content_ of that last item, the item's actual height grows past `min-height` naturally — the user message stays pinned because Virtuoso preserves `scrollTop` during measurement updates, and the assistant reply expands downward into the reserved space.

The trade-off vs. the HuggingChat dynamic-spacer pattern:

| Trait                                   | Pure CSS `min-height`                           | Dynamic spacer                                              |
| --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| **Lines of JS**                         | ~3 (single `scrollToIndex` on submit)           | ~50 (`ResizeObserver` + `computeSpacerHeight` + transition) |
| **Stays pinned past viewport overflow** | No — once reply exceeds viewport, normal scroll | Yes — spacer shrinks below 0                                |
| **Animation polish**                    | Snaps on submit                                 | CSS `transition: height` smooths it                         |
| **Bug surface**                         | Minimal                                         | `ResizeObserver` × Virtuoso × layout thrashing              |
| **Works in Safari**                     | Yes                                             | Yes                                                         |
| **Plays with virtualization**           | Native (Virtuoso measures the item)             | Requires `Footer` slot, not item                            |

For Tau's first iteration, **the pure-CSS variant is the recommended starting point.** It is genuinely "elegant via pure CSS" as the user requested, requires almost no new code, and matches the Vercel AI SDK starter pattern that the broader ecosystem has converged on.

### Finding 6: `100dvh` is required, not `100vh`

Mobile Safari and iOS Chrome dynamically resize `100vh` based on URL bar visibility; the viewport unit refers to the _largest_ possible viewport, not the currently visible one. Using `100vh` for the spacer means iOS users see the user message scroll under the URL bar.

`100dvh` (dynamic viewport height) is the correct unit. It refers to the _currently visible_ viewport and updates as browser chrome shows/hides. Browser support is universal in modern browsers (Tailwind ships `min-h-dvh` since v3.4.0).

For Tau, we should compute the spacer relative to the **scroller's `clientHeight`**, not the page viewport, since `chat-history.tsx` lives inside a `FloatingPanel` whose height is bounded by the parent layout. `min-h-[calc(100%-3rem)]` (where `100%` resolves to the scroller height) is more correct than `min-h-dvh`. This sidesteps the `vh` vs. `dvh` debate entirely.

### Finding 7: `scroll-padding-block-start` does not solve this

Several Stack Overflow answers (and the AI search syntheses in our research) suggest `scroll-padding-block-start` as the solution. This is incorrect for our use case.

`scroll-padding-block-start` only affects:

- `scrollIntoView()` calls (it offsets where the browser considers "the start" to be).
- `scroll-snap-*` snap points.

It does **not** create real space. If we set `scroll-padding-block-start: 50px` and call `scrollIntoView({ block: 'start' })`, the target element lands 50px below the scroll edge — but only if there is room above it. It cannot reserve canvas below the last message.

`scroll-padding-block-start` is useful as a _complement_ (a one-line addition to give the user message its 50px breathing room on `scrollIntoView`), but it cannot be the primary mechanism.

### Finding 8: Disable `overflow-anchor` on the scroller anyway

Even though we cannot rely on `overflow-anchor` for pinning (Finding 2), browsers that support it (Chrome, Firefox, Edge) will _automatically_ try to keep some anchor element visually stable as content above changes. During streaming, this auto-anchor heuristic can fight our explicit `scrollToIndex` call and cause perceptible jitter.

The fix is one rule on the Virtuoso scroller:

```css
.chat-scroller {
  overflow-anchor: none;
}
```

This is a no-op in Safari (which doesn't support the property) and disables the conflicting auto-anchor in every other browser. This is the same defensive disable used by HuggingChat, Vercel AI Elements, and the Stack Overflow answer.

### Finding 9: `followOutput` must become a guarded function

The current `followOutput='smooth'` (line 209 of `chat-history.tsx`) auto-follows on **every** content change — including assistant token streams. This means:

- The user cannot scroll up to read earlier messages mid-stream without being yanked back down.
- It actively conflicts with the spacer pattern: as the assistant reply grows, Virtuoso scrolls to keep the _last item's tail_ in view, defeating the "user message pinned to top" effect.

The correct shape is:

```tsx
followOutput={(isAtBottom: boolean) => isAtBottom && 'smooth'}
```

Read literally: "if the user is currently at the bottom (i.e., engaged with the streaming reply), keep them at the bottom smoothly; otherwise leave them alone." This is the same heuristic Cursor (`autoScrollRef.current` in coder/coder #23451) and the Vercel AI chatbot's `useScrollToBottom` hook implement.

### Finding 10: A single-RAF deferred submit-time scroll handles the "clean canvas" effect

The pure-CSS spacer (Finding 5) and guarded `followOutput` (Finding 9) handle steady-state behavior, but the **submit moment itself** still needs an explicit scroll: when the user presses Enter, we need to position the new user message at the top of the viewport in one motion.

The minimum mechanism (Stack Overflow `#79698278`):

```tsx
const previousLengthRef = useRef(messageIds.length);
useEffect(() => {
  if (messageIds.length > previousLengthRef.current) {
    const lastMessage = messages[messageIds.length - 1];
    if (lastMessage?.role === messageRole.user) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          align: 'start',
          behavior: 'smooth',
        });
      });
    }
  }
  previousLengthRef.current = messageIds.length;
}, [messageIds]);
```

Two non-obvious details:

1. `align: 'start'` (not `'end'`) — we want the user message's top edge at the viewport's top edge. With the `min-height` spacer in place, this aligns identically to `align: 'end'` because the item is taller than the viewport, but `'start'` is the intent-matching name.
2. `requestAnimationFrame` is mandatory — `scrollToIndex` before the new item is laid out is a no-op. (Virtuoso's own internal heuristics also defer this, but the explicit `rAF` documents intent and guards against future refactors.)

### Finding 11: Mobile and Safari quirks

| Quirk                                                 | Mitigation                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| iOS momentum scrolling can race with `scrollTo`       | `behavior: 'smooth'` rather than `'instant'` lets WebKit settle first       |
| Safari rejects `scrollIntoView` mid-momentum-scroll   | Use Virtuoso's `scrollToIndex` (which goes through its own scroll loop)     |
| iOS URL-bar height changes shift layout during stream | `100dvh` / `min-h-dvh` (we use `100%` of the scroller, sidestepping this)   |
| `overflow-anchor` not supported in Safari             | Don't rely on it; explicitly set `overflow-anchor: none` for other browsers |
| `ResizeObserver` not supported in Safari < 13.1       | Modern Safari (≥ 13.1, 2020) supports it; Tau already uses it elsewhere     |

## Recommendations

R1–R5 landed in `apps/ui/app/routes/projects_.$id/chat-history.tsx` and `apps/ui/app/styles/global.css` on 2026-04-23. R6–R8 remain deferred per the original plan.

| #   | Action                                                                                                                                                                                                                                                            | Priority | Effort  | Impact         | Status           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | -------------- | ---------------- |
| R1  | Apply `min-h-[calc(100%-3rem)]` (or equivalent CSS variable) on the **last** Virtuoso item wrapper inside `MessageItem`. Lift `index === messageIds.length - 1` into the `renderItem` callback so the wrapper knows when to apply it.                             | P0       | Low     | High           | Implemented      |
| R2  | Change `followOutput='smooth'` → `followOutput={(isAtBottom) => isAtBottom && 'smooth'}` in `chat-history.tsx` line 209 so streaming token growth doesn't fight the spacer.                                                                                       | P0       | Trivial | High           | Implemented      |
| R3  | Add `overflow-anchor: none` (`[&_[data-virtuoso-scroller]]:overflow-anchor-none` or a class on the Virtuoso `style`) to the Virtuoso scroller so Chrome/Firefox/Edge don't auto-anchor against our explicit scrolls.                                              | P0       | Trivial | Medium         | Implemented      |
| R4  | On user-message submit, schedule one `virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'start', behavior: 'smooth' })` inside `requestAnimationFrame` so the just-submitted user message lands flush at the top in a single motion.                     | P0       | Low     | High           | Implemented      |
| R5  | Optional polish (after R1–R4 land): add a CSS variable `--chat-top-breathing: 3rem` consumed by both the spacer `min-height` and `scroll-padding-block-start` on the scroller so the user message has consistent breathing room above.                            | P1       | Low     | Medium         | Implemented      |
| R6  | Optional polish: replace the static `min-height` with a `ResizeObserver`-driven dynamic spacer (HuggingChat pattern) so the user message stays pinned even when the assistant reply outgrows the viewport. Defer until R1–R4 prove insufficient in user testing.  | P2       | Medium  | Low            | Deferred         |
| R7  | Document the chosen mechanism in `docs/policy/ui-policy.md` under a "Chat scroll behavior" subsection so future chat surfaces (mobile composer, agents panel) inherit the same pattern.                                                                           | P2       | Low     | Medium         | Deferred         |
| R8  | Do **not** adopt `@virtuoso.dev/message-list` for this feature alone. Re-evaluate only as part of a broader chat-virtualization audit if/when its other features (sticky headers, scroll modifiers, message-list-aware data prop) become independently desirable. | P0       | n/a     | n/a (decision) | Decision honored |

### Implementation Notes (2026-04-23)

R1–R5 shipped together as a single, surgical change to `chat-history.tsx` (one new `MessageItem` `isLast` prop, one new `ChatScroller` wrapper, one memoized `followOutput` callback, one `useEffect` that fires a `requestAnimationFrame`-deferred `scrollToIndex` on user-message submit) plus a one-line CSS variable `--chat-top-breathing: 3rem` in `global.css`. The R5 "polish" half — `scroll-padding-block-start` on the scroller — was folded directly into the custom `ChatScroller` (alongside `overflow-anchor: none` for R3) rather than left for a follow-up, since the same forwardRef wrapper was already needed for R3 and adding the second utility class was zero marginal cost. `ScrollerProps` from `react-virtuoso` only picks `children | style | tabIndex` from div props, so the `ChatScroller` widens its prop type with `{ readonly className?: string }` to receive Virtuoso's runtime-forwarded `className` without losing the upstream class. No new dependencies, no state-machine changes, no test churn; verified via `pnpm nx typecheck ui` and `pnpm nx lint ui --files='app/routes/**/chat-history.tsx'`.

## Trade-offs

### Pure CSS spacer vs. dynamic spacer

| Dimension                  | Pure CSS `min-h-[calc(100%-…)]` (R1)                                                                           | Dynamic `ResizeObserver` spacer (R6)                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Implementation cost        | ~5 lines                                                                                                       | ~50 lines                                               |
| Runtime cost               | Zero JS during stream                                                                                          | One `ResizeObserver` callback per growth tick           |
| Pin-past-viewport behavior | Reverts to natural scroll                                                                                      | Stays pinned indefinitely                               |
| Animation feel on submit   | CSS `scroll-behavior: smooth` only                                                                             | `transition: height 300ms` + CSS `smooth`               |
| Layout-thrashing risk      | None                                                                                                           | Real (must use `entry.contentRect.height`, batch reads) |
| Mobile reliability         | Identical to desktop                                                                                           | `ResizeObserver` quirks on iOS during URL-bar shifts    |
| First-message edge case    | Naturally broken (only a single greeting in viewport with reserved space below) — solve with `index > 0` guard | Same fix                                                |

### `react-virtuoso` (free) vs. `@virtuoso.dev/message-list` (paid)

| Dimension           | `react-virtuoso` (current)    | `@virtuoso.dev/message-list`                                       |
| ------------------- | ----------------------------- | ------------------------------------------------------------------ |
| License             | MIT, free                     | Commercial, $168/seat/year (Std), $312/seat/year (Pro)             |
| Spacer mechanism    | Item `min-height` or `Footer` | First-class via `scrollModifier`                                   |
| Sticky footer       | Workaround (CSS hack)         | Native `StickyFooter`                                              |
| Reverse mode quirks | Manual handling required      | Encapsulated                                                       |
| Migration cost      | n/a                           | Non-trivial: API differs (data-driven, not totalCount/itemContent) |
| Per-developer cost  | $0                            | Scales with team size                                              |

Verdict: stay on `react-virtuoso`.

### Library: roll-our-own vs. `use-stick-to-bottom`

`use-stick-to-bottom` (powering bolt.new) provides a battle-tested spring-based implementation that handles the "stick to bottom" half of the problem extremely well, with explicit cross-browser support including Safari (it does not require `overflow-anchor`). However:

- It is designed to wrap a **plain scrollable div**, not a virtualized list. Coupling it with Virtuoso means owning the `scrollRef` from one library and `contentRef` from the other — fragile and not a documented integration.
- It solves "stick the bottom of the content to the bottom of the viewport" — it does **not** solve "pin the latest user message to the top." That pinning still needs the spacer mechanism.

Verdict: don't adopt `use-stick-to-bottom`. The CSS spacer + guarded `followOutput` (R1, R2, R4) gives Tau the same UX with one library instead of two.

## Code Examples

### Recommended minimum-viable implementation

```tsx
// apps/ui/app/routes/projects_.$id/chat-history.tsx (excerpt — proposed shape)

const MessageItem = memo(function ({
  messageId,
  isLast,
}: {
  readonly messageId: string;
  readonly isLast: boolean;
}) {
  return (
    <div
      className={cn(
        'py-1',
        // R1: reserve roughly one viewport of canvas below the latest message so
        // a single scroll-to-bottom puts it flush at the top with breathing room.
        isLast && 'min-h-[calc(100%-var(--chat-top-breathing,3rem))]',
      )}
    >
      <ChatMessage messageId={messageId} />
    </div>
  );
});

// inside ChatHistory ...
const renderItem = useCallback(
  (index: number) => {
    const messageId = messageIds[index]!;
    const isLast = index === messageIds.length - 1;
    return <MessageItem key={`message-${messageId}`} messageId={messageId} isLast={isLast} />;
  },
  [messageIds],
);

// R4: on user-message submit, scroll the new message flush to the top in one motion.
const previousLengthRef = useRef(messageIds.length);
useEffect(() => {
  if (messageIds.length > previousLengthRef.current) {
    const lastId = messageIds[messageIds.length - 1];
    const lastRole = /* ...look up role from chat state for lastId... */;
    if (lastRole === messageRole.user) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          align: 'start',
          behavior: 'smooth',
        });
      });
    }
  }
  previousLengthRef.current = messageIds.length;
}, [messageIds]);

// R2 + R3: replace the props on <Virtuoso>:
<Virtuoso
  ref={virtuosoRef}
  totalCount={messageIds.length}
  itemContent={renderItem}
  followOutput={useCallback(
    (atBottom: boolean) => (atBottom ? 'smooth' : false),
    [],
  )}
  className='mt-1 h-full [&>[data-virtuoso-scroller]]:overflow-anchor-none'
  atBottomStateChange={handleAtBottomStateChange}
  components={{ Header: () => null, EmptyPlaceholder, Footer }}
/>
```

### Optional polish: dynamic spacer (HuggingChat pattern)

```tsx
// Only adopt if R1–R4 prove insufficient (e.g., users complain that long replies
// unpin the user message too aggressively).

function DynamicFooterSpacer({
  scrollerRef,
  lastUserMessageRef,
}: {
  readonly scrollerRef: RefObject<HTMLElement>;
  readonly lastUserMessageRef: RefObject<HTMLElement>;
}) {
  const [height, setHeight] = useState(208); // pb-52 baseline

  useEffect(() => {
    const scroller = scrollerRef.current;
    const userMsg = lastUserMessageRef.current;
    if (!scroller || !userMsg) return;

    const observer = new ResizeObserver(() => {
      const scrollerHeight = scroller.clientHeight;
      const distanceFromUserMsgToBottom = scroller.scrollHeight - userMsg.offsetTop;
      const TOP_BREATHING = 50;
      const next = Math.max(208, scrollerHeight - distanceFromUserMsgToBottom - TOP_BREATHING);
      setHeight(next);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollerRef, lastUserMessageRef]);

  return <div style={{ height }} className='transition-[height] duration-300' aria-hidden />;
}
```

## Diagrams

### Steady-state submit flow (R1 + R4 in effect)

```
TIME T₀ — before submit                        TIME T₁ — at submit (after rAF)
───────────────────────────────                ───────────────────────────────
┌────────────── viewport ─────────────┐        ┌────────────── viewport ─────────────┐
│ ...older assistant reply (visible)  │        │ NEW USER MESSAGE  ◄── pinned to top │
│                                     │        │                                     │
│ ...older user message (visible)     │        │ (empty canvas reserved by min-h)    │
│                                     │        │                                     │
│ ...assistant reply tail             │        │                                     │
│ ┌─────────────────────────────────┐ │        │                                     │
│ │ chat composer (fixed)           │ │        │ ┌─────────────────────────────────┐ │
│ └─────────────────────────────────┘ │        │ │ chat composer (fixed)           │ │
└─────────────────────────────────────┘        │ └─────────────────────────────────┘ │
                                               └─────────────────────────────────────┘

TIME T₂ — assistant streaming (auto)           TIME T₃ — assistant overflows viewport
───────────────────────────────                ───────────────────────────────
┌────────────── viewport ─────────────┐        ┌────────────── viewport ─────────────┐
│ NEW USER MESSAGE  ◄── still pinned  │        │ ...user message scrolls off top      │
│                                     │        │                                     │
│ Assistant reply (streaming…)        │        │ Assistant reply (still streaming…)  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                 │        │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
│                                     │        │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ◄── tail   │
│ ┌─────────────────────────────────┐ │        │ ┌─────────────────────────────────┐ │
│ │ chat composer (fixed)           │ │        │ │ chat composer (fixed)           │ │
│ └─────────────────────────────────┘ │        │ └─────────────────────────────────┘ │
└─────────────────────────────────────┘        └─────────────────────────────────────┘
```

### CSS layering

```
┌────────────────────────────────────────────────────────────┐
│ FloatingPanelContent                                       │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ Virtuoso scroller (overflow-y: auto)                 │   │
│ │   overflow-anchor: none                              │   │
│ │ ┌────────────────────────────────────────────────┐   │   │
│ │ │ item[0]   (regular height)                     │   │   │
│ │ │ item[1]   (regular height)                     │   │   │
│ │ │ ...                                            │   │   │
│ │ │ item[N-2] (regular height)                     │   │   │
│ │ │ item[N-1] (min-h: calc(100% - --top-breathing))│   │   │
│ │ │   └── ChatMessage (intrinsic height grows)     │   │   │
│ │ └────────────────────────────────────────────────┘   │   │
│ │ Footer (ChatError)                                   │   │
│ └──────────────────────────────────────────────────────┘   │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ ChatTextarea (composer, fixed below scroller)        │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

## References

- Stack Overflow #79698278 — [How to scroll the last message from user to the top of chat container](https://stackoverflow.com/questions/79698278/how-to-scroll-the-last-message-from-user-to-the-top-of-chat-container)
- HuggingFace `chat-ui` PR #2226 — [Implement dynamic bottom spacer for ChatGPT-style scroll behavior](https://github.com/huggingface/chat-ui/pull/2226) (merged 2026-04-09)
- Coder/coder commit `be5e080` — [fix(AgentsPage): preserve chat scroll position when away from bottom](https://github.com/coder/coder/commit/be5e080de697bf7555ec0deb90db168d15d9683c) (Apr 2026)
- Vercel `ai-chatbot` PR #638 — [Fixed autoscroll on hovering messaged + update messages](https://github.com/vercel/ai-chatbot/pull/638)
- Vercel AI Elements — [`<Conversation>` component reference](https://sdk.vercel.ai/elements/components/conversation)
- pingdotgg `t3code` PR #145 — [Fix chat scroll restoration across thread switches](https://github.com/pingdotgg/t3code/pull/145)
- StackBlitz Labs — [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom) (powers bolt.new)
- Jerrick Hakim — [Handling Scroll Behavior for AI Chat Apps](https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps)
- Can I Use — [`overflow-anchor`](https://caniuse.com/css-overflow-anchor) (Safari support TP-only as of April 2026)
- MDN — [`scroll-padding-block-start`](https://developer.mozilla.org/docs/Web/CSS/scroll-padding-block-start)
- `react-virtuoso` issues — [#1071 (sticky Footer + scrollToIndex)](https://github.com/petyosi/react-virtuoso/issues/1071), [#270 (reverse-mode Footer)](https://github.com/petyosi/react-virtuoso/issues/270)
- Virtuoso Message List — [Licensing](https://virtuoso.dev/message-list/licensing/) and [Pricing](https://virtuoso.dev/pricing/) (commercial; not adopted)
- Related: `docs/research/chat-rendering-audit.md`

## Appendix: Existing `chat-history.tsx` shape

For grounding, the relevant excerpt of the current implementation:

```205:227:apps/ui/app/routes/projects_.$id/chat-history.tsx
          <Virtuoso
            ref={virtuosoRef}
            totalCount={messageIds.length}
            itemContent={renderItem}
            followOutput='smooth'
            className='mt-1 h-full'
            atBottomStateChange={handleAtBottomStateChange}
            components={{
              Header: () => null,
              EmptyPlaceholder: () => (
                <div className='-mb-12 h-full p-2 pt-1'>
                  <ChatHistoryEmpty className='m-0 flex-1 justify-end' />
                </div>
              ),
              Footer: () => (
                <ChatError
                  className='px-4 pb-4'
                  isOpen={isErrorCollapsibleOpen}
                  onOpenChange={setIsErrorCollapsibleOpen}
                />
              ),
            }}
          />
```

The `Footer` slot is already wired — adding a sized spacer there (R6) is structurally a no-op refactor of the existing `ChatError` wrapper. The `MessageItem` already exists as a memoized boundary — passing `isLast` through it (R1) requires only adding one prop to the `renderItem` callback.
