---
title: 'Chat Sticky User-Message Scroll-Jump Investigation'
description: 'Root-cause investigation of a multi-hundred-pixel viewport jump triggered by `position: sticky` user messages inside the virtualized chat history; documents every scoping attempt, why each failed, and the constraints any future "pin past user messages" attempt must satisfy.'
status: active
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/chat-pin-user-message-scroll.md
---

# Chat Sticky User-Message Scroll-Jump Investigation

Root-cause investigation of the viewport jump that appears whenever `position: sticky` is applied to user-message articles inside `apps/ui/app/routes/projects_.$id/chat-history.tsx`'s `react-virtuoso` scroller. Documents every scoping attempt that failed, the discarded fixes, and the contract any future "pin past user messages" implementation must satisfy.

## Executive Summary

After landing the live-turn pinning behaviour from [docs/research/chat-pin-user-message-scroll.md](docs/research/chat-pin-user-message-scroll.md) (one `TurnGroup` per turn, `min-h-(--chat-live-turn-min-h)` on the last group, one-shot `scrollToIndex(LAST, align: 'start')` on submit), we layered `position: sticky; top: 1` on user-message articles to keep the question visible while the assistant reply scrolled underneath. Every scoping of that sticky declaration — every `TurnGroup`, past `TurnGroup`s only, live `TurnGroup` only, edit-mode only — produced the same regression: the first wheel-up notch from the scroll-bottom of a multi-turn chat snaps the viewport hundreds of pixels upward, skipping past content.

We exhausted the structural fixes that could be implemented without forking `react-virtuoso` or accepting wasted screen real-estate ("page per turn", `Footer` spacers, `increaseViewportBy`, custom `itemSize` callback that pins cached sizes on scroll-up). None resolved the jump; all introduced new failure modes (cache↔DOM desync, missing-content-at-bottom, imprecise size guesses).

**Resolution shipped**: drop `position: sticky` on user messages entirely. The live-TG `min-h` + `scrollToIndex(LAST, align: 'start')` pinning remains as the only pinning mechanism. Past user messages now scroll out of view naturally — the regression in `docs/research/chat-pin-user-message-scroll.md` Finding 1 ("user message stays pinned for the lifetime of its TurnGroup") is partially undone, accepted as a UX trade-off until a non-sticky pin is designed.

A regression guard test in [apps/ui/app/routes/projects\_.$id/chat-message.test.tsx](apps/ui/app/routes/projects_.$id/chat-message.test.tsx) now fails if `sticky`, `top-1`, or `z-10` reappear on the article wrapper, and points back to this document.

## Problem Statement

Reproduction steps in a multi-turn chat (two or more user-assistant pairs):

1. Refresh the page so the chat scrolls to the bottom.
2. Wheel up by one notch (a single mouse-wheel detent or trackpad gesture).
3. Observe: the viewport jumps by ~400-700px upward, snapping past the live turn into the previous turn's content rather than scrolling smoothly by ~100px.

Symptom only manifested after `position: sticky; top: 1` was added to user-message articles. Reverting the sticky declaration fixed the regression but lost the "user message visible while reading the assistant reply" UX. No browser-console errors are emitted; the jump is pure layout reconciliation.

The jump is **deterministic**: scroll position before the wheel and after the wheel land on identical pixel offsets every time, suggesting the cascade has a stable end state rather than fighting against further input.

## Methodology

1. Reviewed the implementation in [apps/ui/app/routes/projects\_.$id/chat-history.tsx](apps/ui/app/routes/projects_.$id/chat-history.tsx) and [apps/ui/app/routes/projects\_.$id/chat-message.tsx](apps/ui/app/routes/projects_.$id/chat-message.tsx) before and after each fix attempt.
2. Inspected `react-virtuoso`'s shipped bundle (`node_modules/react-virtuoso/dist/index.mjs`) to understand its `upwardScrollFixSystem`, `sizeSystem`, `scrollerSystem`, and `logLevel` plumbing.
3. Enabled `<Virtuoso logLevel={LogLevel.DEBUG} />` in DEV to capture every internal log line during the repro: `received item sizes`, `Adjusting position`, `Scrolling to`, `Upward scrolling compensation`, etc.
4. Cross-checked the same logic against an unrelated minified vendor bundle of the same scroll-handling subsystem to rule out a packaging-specific bug.
5. Iterated through five concrete fix attempts (Findings 4-8 below), running the repro between each iteration with DEV logging enabled and noting which logs fired and which were silent.
6. Audited browser scroll-anchor specs and `position: sticky` containing-block rules to identify which sticky behaviours interact with virtualized lists.

## Findings

### Finding 1: The jump is layout reconciliation, not a Virtuoso `scrollBy`

With `<Virtuoso logLevel={LogLevel.DEBUG} />` enabled, `react-virtuoso`'s `upwardScrollFixSystem` emits a `console.debug("react-virtuoso: %c%s %o", ..., "Upward scrolling compensation", { amount })` line whenever it programmatically adjusts `scrollTop` to compensate for a `totalHeight` delta from a stale size cache. **No such log appears during the repro.** Other DEBUG lines (`received item sizes`, `Adjusting top item`, `Scrolling to`) do appear, confirming the logger is wired and Virtuoso is processing the wheel — but the jump is happening without `Virtuoso` calling `scrollBy` or `scrollTo`.

The jump is therefore caused by the **browser's own layout/anchor reconciliation** in response to a layout shift Virtuoso made (mounting an item from cache, adjusting padding) — not by Virtuoso explicitly correcting the scroll position.

### Finding 2: The live `TurnGroup`'s sticky range boundary coincides with `scrollTop_max`

The live (last) `TurnGroup` has `min-h: var(--chat-live-turn-min-h)` ≈ `100dvh - 64px - 10.25rem`, which evaluates to roughly the visible scroller height minus a few rems of chrome. Substituting:

```text
liveTGHeight   = max(naturalHeight, min-h ≈ viewport_height)
scrollHeight   = sumOfPastTGs + liveTGHeight
scrollTop_max  = scrollHeight − viewport_height
              ≈ sumOfPastTGs + viewport_height − viewport_height
              ≈ sumOfPastTGs
              ≈ startOf(liveTG)
```

So `scrollTop_max ≈ startOf(liveTG)` — the scrollbar's lower bound _is_ the top of the live TG. A user message styled `position: sticky; top: 1` inside the live TG has its sticky range `[startOf(liveTG) + 1, endOf(liveTG) − userMsgHeight]`. At `scrollTop_max`, the user message is sitting at the lower edge of that range, pinned at `top: 1px`.

The very first 1px of upward wheel sets `scrollTop = scrollTop_max − 1 < startOf(liveTG) + 1`, which **unsticks the live user message**. This is structural, not coincidental: any time a sticky element lives inside a container whose `min-h ≈ viewport_height`, the container's start coincides with `scrollTop_max`, so the sticky range's lower boundary lives exactly at the scroll-bottom and every wheel-up triggers an unstick.

### Finding 3: Browser scroll-anchoring excludes sticky elements as anchor candidates

Per the CSS Scroll Anchoring spec and Chromium implementation, `position: sticky` (and `position: fixed`, `position: absolute`) elements are explicitly excluded from the candidate set the browser considers when picking an anchor for `overflow-anchor: auto`. The browser walks the DOM under the scroll container looking for an in-flow element near the top of the viewport whose post-shift position should be preserved.

Inside the live TG, when sticky is engaged, the user message is the visually-topmost element — but it is excluded from anchor candidacy. The next eligible candidate is the assistant content below it. As Virtuoso mounts item N-1 (the previous TG that had been virtualized away while at the bottom) and adjusts `padding-top` accordingly, the browser tries to keep the anchored assistant element at its current visual offset — but the anchor reference's pre-shift coordinates and post-shift coordinates differ by the size delta of the newly-mounted item. The browser corrects `scrollTop` by that delta. With items of natural height several hundred pixels, the correction is several hundred pixels.

This pairing — sticky boundary at `scrollTop_max` + anchor exclusion of sticky elements — is the structural root cause. The unstick triggers a layout shift, the layout shift triggers a Virtuoso mount, the Virtuoso mount changes layout above the viewport, and the browser's scroll anchor falls through to a candidate whose post-mount position differs sharply from its pre-mount position.

### Finding 4: Cached size vs natural DOM size disagree at the live↔past TG transition

The live TG is at least viewport-tall via `min-h`. Past TGs render at their natural (smaller) heights. When the live TG transitions to "past" status (a new turn arrives), or when a previously-live TG is being remeasured after virtualization, its measured size flips between the two regimes:

| State                      | Effective height                                                       |
| -------------------------- | ---------------------------------------------------------------------- |
| TG is currently `isLast`   | `max(natural, ~viewport_height)`                                       |
| TG was previously `isLast` | `natural`                                                              |
| TG re-mounted from cache   | Last cached value (likely viewport) until next ResizeObserver callback |

Virtuoso's size cache stores whatever `data-known-size` was last measured. If it cached the live TG at viewport height and that TG is later remounted as a past TG with natural height, the cache and the DOM disagree by `viewport - natural` pixels (often 400-700px). The first ResizeObserver callback after mount reconciles the cache, but the `padding-top` adjustment that follows is the layout shift that triggers Finding 3's anchor cascade.

This finding makes the live-TG sticky boundary the _trigger_, but the live-TG `min-h` itself is the _amplifier_ — it's the source of the size delta that anchor reconciliation has to absorb.

### Finding 5: Scoping sticky to past TGs only does not help

Hypothesis tested: if the live-TG sticky transition is the unique trigger (Finding 2), suppressing sticky on the live TG should eliminate the jump while preserving the UX for past TGs.

Implementation: thread an `isLiveTurn` boolean from `TurnGroup` into `ChatMessage`, condition the sticky classes on `isUser && !isLiveTurn`. Past TGs keep sticky; live TG does not.

Result: **jump persists**. With sticky removed from the live TG, the live user message scrolls naturally out of view as expected on the first wheel-up. But once the previous TG enters the viewport, _its_ sticky engages, and a similar cascade fires through Finding 3 — the previous TG's user message becomes the now-topmost element, browser anchor candidates re-scan, Virtuoso reads bounding rects for the next item up, layout reconciles, jump.

The trigger generalises: any sticky element inside any virtualized item that mounts during a wheel event participates in the cascade. Restricting to past TGs reduces the _frequency_ (you have to scroll through one full TG before the next jump fires) but doesn't eliminate the _kind_.

### Finding 6: Custom `itemSize` callback that pins cached sizes on scroll-up does not help either

Hypothesis tested: if the cache↔DOM disagreement (Finding 4) is what feeds the anchor cascade, suppressing `Virtuoso`'s remeasurement on scroll-up should freeze the cache against the offending update.

Implementation: a custom `itemSize: (element, field) => number` Virtuoso prop reads `scrollerElementRef.current?.scrollTop` synchronously inside the measurement callback, compares against `lastObservedScrollTopRef`, and returns `Number.parseFloat(element.dataset['knownSize'])` (the cached size) when scrolling up — so the resize observer's measurement is discarded. Self-corrects on the next downward scroll.

Result: **jump persists**. The DEBUG log confirms that `Upward scrolling compensation` does not fire (so the suppression is doing what it claims to do) but the browser-driven cascade in Finding 3 is independent of Virtuoso's own scroll compensation — it fires from the layout shift of mounting item N-1 from cache, regardless of what value `itemSize` returns. Worse, the suppression now makes Virtuoso's internal cache permanently disagree with the DOM until the user scrolls down and re-measures, which can cause its own subtle scroll glitches over time.

This finding rules out "patch the cache" as a viable fix and shows that the smoking gun lives in the browser's layout/anchor reconciliation, not Virtuoso's internal accounting.

### Finding 7: Footer-slot pinning would break the bottom UX

Hypothesis tested: move the `min-h` reservation out of virtualized items into a static `Footer` slot so all `TurnGroup`s render at natural height (eliminating Finding 4's amplification), and replace sticky with a fixed-position overlay near viewport top that JS positions based on the topmost in-view user message.

Result: rejected without implementation. Two structural problems:

1. With `min-h` moved to a `Footer` and the live TG at natural height, `scrollToIndex(LAST, align: 'start')` would land the live user message at viewport top, but the trailing space below it would be the static Footer — not interactive content. The user message at the bottom of the chat (when no assistant reply yet exists) would visually float in the upper third of the viewport with empty footer space below it.
2. Wheeling past the live TG into the Footer would scroll the live user message above the viewport entirely (sticky no longer applies — the Footer is outside its containing block), leaving no user message visible at all when fully scrolled to the bottom of content.

Both regressions break the "live user message always visible at top while at bottom of chat" requirement from [docs/research/chat-pin-user-message-scroll.md](docs/research/chat-pin-user-message-scroll.md).

### Finding 8: "Page per turn" wastes screen real-estate

Hypothesis tested: give every TG `min-h: 100dvh` so each turn occupies its own viewport, eliminating the live↔past size delta entirely.

Result: rejected. Wastes vertical space when assistant replies are short (a one-line answer occupies a full viewport), introduces visible empty bands between turns, and forces the user to scroll an entire viewport to reach the next turn. UX regression unacceptable.

### Finding 9: `increaseViewportBy` / `defaultItemHeight` are imprecise guesses

Hypothesis tested: tune `react-virtuoso`'s `increaseViewportBy` and `defaultItemHeight` props so item N-1 is mounted before the user wheels into it, removing the mid-wheel mount that drives the cascade.

Result: rejected without shipping. Both props accept pixel guesses; correct values depend on each conversation's content and would need re-tuning per user. Even when tuned, mounting item N-1 earlier just shifts _when_ the cascade fires, not _whether_ — Finding 3's mechanism is independent of mount timing.

## Approaches Considered

| #   | Approach                                             | Status      | Reason                                                                                                 |
| --- | ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| A1  | Sticky on every user-message article                 | Failed      | Finding 2 — first wheel-up at bottom unsticks live user msg, cascades via Finding 3                    |
| A2  | Sticky only on live TG's user message                | Failed      | Same trigger as A1 (only the live-TG sticky is involved at scroll-bottom anyway)                       |
| A3  | Sticky only on past TGs' user messages (skip live)   | Failed      | Finding 5 — cascade just shifts to the next TG with sticky engaged                                     |
| A4  | Custom `itemSize` pinning cached sizes on scroll-up  | Failed      | Finding 6 — suppresses Virtuoso compensation but not browser anchor cascade; cache↔DOM desync risk     |
| A5  | `Footer`-slot min-h + JS-positioned floating overlay | Rejected    | Finding 7 — breaks "live user message visible at bottom" UX                                            |
| A6  | "Page per turn" min-h on every TG                    | Rejected    | Finding 8 — wastes screen real-estate                                                                  |
| A7  | `increaseViewportBy` / `defaultItemHeight` tuning    | Rejected    | Finding 9 — imprecise guesses; only shifts cascade timing                                              |
| A8  | Drop `position: sticky` entirely                     | **Shipped** | Live TG pin via `min-h` + `scrollToIndex(LAST, align: 'start')` is preserved; past-TG pinning deferred |

## Resolution

Implementation in this PR:

- Removed all `position: sticky` declarations from [apps/ui/app/routes/projects\_.$id/chat-message.tsx](apps/ui/app/routes/projects_.$id/chat-message.tsx); the article wrapper no longer carries `sticky`, `top-1`, or `z-10` tokens.
- Removed the `isLiveTurn` plumbing (`ChatMessageProperties.isLiveTurn`, the `TurnGroup` prop pass-through) since no consumer needs it.
- Reverted the `itemSize` / `Scroller`-ref / `LogLevel` / `lastObservedScrollTopRef` band-aid from [apps/ui/app/routes/projects\_.$id/chat-history.tsx](apps/ui/app/routes/projects_.$id/chat-history.tsx) — Finding 6 made it net-negative.
- Kept the live-TG pin: `min-h-(--chat-live-turn-min-h)` on the last `TurnGroup` plus `requestAnimationFrame`-deferred `scrollToIndex({ index: 'LAST', align: 'start', behavior: 'instant' })` on user-message submit.
- Added a regression-guard `describe` block in [apps/ui/app/routes/projects\_.$id/chat-message.test.tsx](apps/ui/app/routes/projects_.$id/chat-message.test.tsx) — `ChatMessage article wrapper — no sticky positioning (regression guard)` — that asserts `sticky`, `top-1`, and `z-10` are absent on user, assistant, and editing-mode user articles. The describe header points back to this document.

Accepted UX trade-off: past user messages now scroll out of view as the user reads the assistant reply. Cursor-style "always know which question you're reading the answer to" remains an open requirement, deferred until a non-sticky implementation exists (Recommendation R3 below).

## Recommendations

| #   | Action                                                                                                                                                                                                                                                             | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | ------ |
| R1  | Do not reintroduce `position: sticky` on any element rendered inside a `react-virtuoso` item                                                                                                                                                                       | P0       | Low    | High   |
| R2  | Keep `min-h-(--chat-live-turn-min-h)` + `scrollToIndex(LAST, align: 'start')` as the live-TG pin                                                                                                                                                                   | P0       | Low    | High   |
| R3  | If past-TG pinning is reprioritised, prototype a JS-positioned floating overlay outside the scroller (single absolute-positioned element whose `textContent` is mirrored from the topmost in-view user message, driven by `IntersectionObserver` per article)      | P3       | High   | Medium |
| R4  | Keep the regression-guard test pointing at this doc; do not relax it without re-running the repro on the proposed mechanism                                                                                                                                        | P0       | None   | High   |
| R5  | If we ever consider re-enabling `<Virtuoso logLevel={LogLevel.DEBUG} />` to debug a related symptom, the prior diagnostic plumbing (capturing scroller `scrollTop` via a ref-aware Scroller wrapper) is documented in git history — do not re-add it speculatively | P3       | None   | Low    |

## Constraints for Future Work

Any future attempt to re-pin past user messages must:

1. **Not use `position: sticky` on any descendant of a `react-virtuoso` item.** The cascade described in Findings 2-5 is structural to sticky + anchor exclusion + virtualized layout shifts.
2. **Not introduce a `Footer` reservation that would push the live user message out of view at the scroll-bottom** (Finding 7).
3. **Not require `min-h: 100dvh` on every TG** (Finding 8).
4. **Not require a custom `itemSize` callback that diverges from natural DOM measurement** (Finding 6).
5. **Stay with the upstream `react-virtuoso` package** — no fork, no migration to a paid alternative.
6. **Validate by running the repro at the bottom of a multi-turn conversation with `<Virtuoso logLevel={LogLevel.DEBUG} />` enabled.** If `Upward scrolling compensation` fires, the proposed mechanism reintroduces a Virtuoso-driven jump. If no log fires but the viewport still snaps, the mechanism reintroduces the browser-anchor cascade.

The most likely viable shape (untested) is an overlay sibling to the Virtuoso scroller whose content is synthesised in JS from whichever past user message is currently topmost in view, driven by `IntersectionObserver` callbacks rather than CSS sticky. That overlay never participates in scroll-anchor candidacy and never lives inside a virtualized item, so neither Finding 3 nor Finding 5 applies.

## Code Examples

The shipped article-wrapper className after the fix:

```startLine:endLine:apps/ui/app/routes/projects_.$id/chat-message.tsx
  return (
    <article
      className={cn(
        'group/chat-message flex w-full flex-row items-start',
        isUser && 'items-end gap-2 space-x-reverse',
        // No `position: sticky` on user messages. Every sticky scoping we
        // tried — every TG, past TGs only, live TG only — produced a
        // multi-hundred-px viewport jump on the first wheel-up from the
        // scroll-bottom of a multi-turn chat. Root cause is a layout-
        // reconciliation cascade between sticky stuck/unstuck transitions
        // and Virtuoso's measurement/anchor path; full investigation,
        // hypotheses, and discarded approaches are documented in
        // `docs/research/chat-sticky-user-message-scroll-jump.md`. The
        // live (last) TurnGroup is still pinned to viewport top via
        // `min-h-(--chat-live-turn-min-h)` on the TG and
        // `scrollToIndex(LAST, align: 'start')` on submit (chat-history.tsx).
        // Past user messages scroll out of view naturally — accepted UX
        // trade-off until we have a non-sticky pinning mechanism.
      )}
    >
```

The regression guard test that fails if any future edit reintroduces sticky tokens:

```typescript
describe('ChatMessage article wrapper — no sticky positioning (regression guard)', () => {
  const stickyTokens = ['sticky', 'top-1', 'z-10'];

  const expectNoStickyTokens = (article: HTMLElement): void => {
    for (const token of stickyTokens) {
      expect(article.className).not.toContain(token);
    }
  };

  it('should not apply sticky positioning classes to a user-message article', () => {
    setMessages([userMessage('msg-1', 'go')]);
    render(<ChatMessage messageId='msg-1' />);
    expectNoStickyTokens(screen.getByRole('article'));
  });

  // ...further cases for assistant-message, editing-mode...
});
```

## References

- Predecessor design: [docs/research/chat-pin-user-message-scroll.md](docs/research/chat-pin-user-message-scroll.md) — the live-TG `min-h` + `scrollToIndex` pinning that this document keeps; the past-TG sticky pinning that this document removes.
- Browser scroll anchoring spec: [CSS Scroll Anchoring Module Level 1](https://drafts.csswg.org/css-scroll-anchoring/) — defines the anchor candidate set and exclusion rules referenced in Finding 3.
- `position: sticky` containing block rules: [CSS Positioned Layout Module Level 3](https://drafts.csswg.org/css-position/#stickypos-insets) — defines the sticky range and how it interacts with the nearest scroll container.
- `react-virtuoso` source bundle: `node_modules/react-virtuoso/dist/index.mjs` — `upwardScrollFixSystem` is defined around line 2046 in the v4.x release we ship; `LogLevel` enum exposes the diagnostic gate used in Finding 1.
