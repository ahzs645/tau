---
title: 'UI Startup Performance Gap Analysis'
description: 'PostHog rrweb snapshot scales with DOM size: homepage 1,974 nodes = 2.48s vs editor 320 nodes = 64ms. Fix: defer init, reduce SSR DOM, disable auto-recording.'
status: active
created: '2026-04-02'
updated: '2026-04-02'
category: optimization
related:
  - docs/research/filesystem-gap-analysis.md
  - docs/research/vscode-fs-performance.md
  - docs/research/large-repo-import-performance.md
  - docs/policy/vision-policy.md
---

# UI Startup Performance Gap Analysis

Chrome trace analysis of the homepage (`localhost:3000/`) and project editor (`localhost:3000/projects/proj_*`) page loads in a **production build** (`nx serve ui`). Follows the filesystem gap analysis approach — evidence-based findings with prioritized recommendations.

## Executive Summary

Production traces (both **cold page refreshes** from steady state) confirm that **PostHog rrweb DOM snapshot cost scales super-linearly with DOM size**, making the homepage persistently slow on every reload.

**Root cause**: The homepage SSR renders **1,974 DOM nodes** (full landing page with community grid, hero image, kernel cards, integration sections). The editor SSR renders **320 DOM nodes** (bare layout containers — Monaco, Three.js, dockview panels are client-rendered after hydration). PostHog's rrweb serializes the entire DOM synchronously when session recording starts:

| Page              | DOM nodes at snapshot | rrweb snapshot | CPU samples |
| ----------------- | --------------------- | -------------- | ----------- |
| Homepage (+544ms) | **1,974**             | **2,480ms**    | 56,037      |
| Editor (+744ms)   | **320**               | **64ms**       | 1,591       |

A 6.2x DOM size difference produces a **38.8x snapshot time difference** due to per-node costs: attribute copying, computed style resolution, image handling, SVG serialization. The same rrweb functions (`n`, `_`, `w`, `p`, `Ni`, `Va`, `Ba`, `appendChild`) execute on both pages — the homepage simply has far more DOM to serialize.

**This is NOT about PostHog sessions, localStorage, or config caching.** Every homepage refresh is slow because SSR always produces ~1,974 nodes. Every editor refresh is fast because SSR always produces ~320 nodes.

### Critical Correction: Provider Reordering Is Ineffective

`PostHogProvider` calls `posthog.init()` in a **`useEffect`** (not during render). React fires useEffects bottom-up, so `FileManagerProvider` and `ProjectManagerProvider` effects fire **before** `AnalyticsProvider`'s. Workers are already spawned when `posthog.init()` runs. The blocking happens when `recorder.js` loads (async) and its `r.onload` handler freezes the main thread — independent of provider order. **Recommendation R3 (provider reordering) has been cancelled.**

### Progress Summary

Our first optimization pass (R5–R12) successfully addressed import chain bloat, JSZip eager loading, Shiki grammar deferral, ClientOnly fallbacks, ChatRpcSocketProvider scoping, PostHog extension deferral (partially), and HeroViewer lazy loading. The second pass (R15–R20) eliminated the rrweb snapshot from the critical path (R16), reduced homepage SSR DOM from ~1,974 to ~700 nodes via `LazySection` (R19+R20), fixed CLS with a NavHistory loading skeleton (R15/R4), deferred Three.js Environment loading (R17), and added TS worker cold start monitoring (R18). The remaining gap is **deferring `posthog.init()` itself** (R1), which is now lower priority since R16 removed session recording from the critical path.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Production Trace Comparison](#production-trace-comparison)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

Users loading `tau.new` for the first time experience a jarky loading sequence where the sidebar is empty for ~3 seconds before projects appear. The same page loads near-instantly on subsequent visits. This investigation identifies the root cause — PostHog's rrweb session recording cold start — using production trace evidence, and tracks implementation progress on all recommendations.

In service of Tau's [vision policy](../../docs/policy/vision-policy.md) — "no install, browser-native, open by default" — the first load experience must be fast and polished. A 3-second gap between first paint and content is unacceptable for a tool that aims to replace heavyweight desktop CAD software.

## Methodology

1. **Dev trace** (Trace-20260402T102904.json.gz): Cold navigation to `localhost:3000/` via `react-router dev` (Vite dev mode, unbundled ESM, 716 modules)
2. **Production homepage trace** (Trace-20260402T144553.json.gz): Page refresh (F5) of `localhost:3000/` via `nx serve ui` (production build, page at steady state before refresh)
3. **Production editor trace** (Trace-20260402T144723.json.gz): Page refresh (F5) of `localhost:3000/projects/proj_*` via `nx serve ui` (production build, page at steady state before refresh)

Both production traces are full page refreshes from steady state. The performance difference is explained by **DOM size at rrweb snapshot time** — the homepage SSR renders 1,974 nodes (full landing page) while the editor SSR renders 320 nodes (bare layout shell). Chrome DevTools Performance tab used for all captures.

## Production Trace Comparison

### Homepage (1,974 DOM Nodes at Snapshot)

| Metric                 | Dev Trace  | Production Trace | Change             |
| ---------------------- | ---------- | ---------------- | ------------------ |
| FCP                    | 391ms      | **211ms**        | -46%               |
| LCP                    | 391ms (H1) | **211ms** (H1)   | -46%               |
| Total Blocking Time    | 3,701ms    | **2,482ms**      | -33%               |
| Non-PostHog TBT        | —          | **32ms**         | —                  |
| Long Tasks             | 21         | **3**            | -86%               |
| CLS                    | 0.009      | **0.020**        | +122% (regression) |
| `__manifest` latency   | 2,778ms    | **66ms**         | -98%               |
| PostHog rrweb snapshot | 2,473ms    | **2,480ms**      | Same               |
| DOM nodes at snapshot  | —          | **1,974**        | —                  |
| Full interactive       | ~5,618ms   | **~3,122ms**     | -44%               |

### Production Homepage Timeline

All offsets relative to `navigationStart`. The homepage SSR renders the full landing page (1,974 DOM nodes) before PostHog's rrweb snapshot fires.

| Offset    | Event                  | Duration    | Details                                                                                                                                            |
| --------- | ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0ms       | Navigation start       | —           | `GET /` (cold page refresh)                                                                                                                        |
| 211ms     | FP / FCP / LCP         | —           | SSR shell renders instantly. H1 heading is LCP candidate                                                                                           |
| 367ms     | `auth/get-session`     | 17ms        | Auth check — fast                                                                                                                                  |
| 403ms     | React hydration        | 58ms        | Scheduler task — initial render, all providers mount                                                                                               |
| 409ms     | `/v1/models`           | 74ms        | Model list fetch                                                                                                                                   |
| 421ms     | `__manifest` (routes)  | 66ms        | 10-path route manifest — **fast in production**                                                                                                    |
| ~472ms    | useEffects fire        | —           | Workers spawn (FileManager, ObjectStore). `posthog.init()` fires in AnalyticsProvider useEffect                                                    |
| 477ms     | **Layout Shift #1**    | —           | CLS: 0.012 — sidebar rearrangement (projects absent)                                                                                               |
| 485ms     | PostHog `recorder.js`  | 19ms        | `EvaluateScript` — loaded from HTTP disk cache (0B transfer)                                                                                       |
| **544ms** | **PostHog `r.onload`** | **2,480ms** | rrweb serializes all **1,974 DOM nodes** synchronously. **Main thread frozen**. Workers continue on background threads but message responses queue |
| ~600ms    | Workers complete       | —           | FileManager/ObjectStore workers finish IDB queries on background threads. Results queued, cannot be processed                                      |
| 3024ms    | PostHog unblocks       | —           | Queued worker messages finally processed                                                                                                           |
| 3071ms    | **Layout Shift #2**    | —           | CLS: 0.008 — projects appear in sidebar                                                                                                            |
| 3122ms    | Last major event       | —           | Final React render with projects                                                                                                                   |

**Totals**: FCP: 211ms | Full interactive: ~3,122ms | TBT: 2,482ms (32ms without PostHog) | CLS: 0.020

### Project Editor Timeline (320 DOM Nodes at Snapshot)

The editor's SSR output is minimal — just sidebar and layout containers. Monaco, Three.js, dockview panels, and chat UI are all client-rendered after hydration, so they are **not present** when rrweb snapshots the DOM.

| Offset  | Event                | Duration | Details                                                               |
| ------- | -------------------- | -------- | --------------------------------------------------------------------- |
| 0ms     | Navigation start     | —        | `GET /projects/proj_*` (cold page refresh)                            |
| 706ms   | First Paint          | —        | SSR shell — only **320 DOM nodes**                                    |
| 744ms   | `r.onload`           | **64ms** | rrweb serializes **320 DOM nodes** — fast because minimal SSR surface |
| 1,081ms | FCP / LCP #1         | —        | **Projects already visible** in sidebar                               |
| 1,248ms | Layout Shift #1      | —        | CLS: 0.008                                                            |
| 1,264ms | LCP #2               | —        | More sidebar content                                                  |
| 1,701ms | Three.js Environment | 271ms    | `Environment-C-bwZVSL.js` + worker messages                           |
| 1,980ms | TS Worker            | 549ms    | `ts.worker-BzykM61u.js` TypeScript language service init              |
| 2,111ms | Layout Shift #2      | —        | CLS: 0.004                                                            |
| 2,131ms | Final LCP            | —        | Editor content fully visible                                          |

**Totals**: FCP: 1,081ms | LCP: 2,131ms | TBT: 1,290ms | CLS: 0.012

**Key difference**: PostHog `r.onload` takes **64ms** on the editor (320 DOM nodes) vs **2,480ms** on the homepage (1,974 DOM nodes). Same rrweb code runs on both pages — the cost is proportional to DOM size. The editor's heavy DOM (Monaco, Three.js, dockview) is client-rendered **after** the rrweb snapshot, so it never pays the serialization cost.

## Findings

### Finding 1: PostHog rrweb Snapshot Cost Scales Super-Linearly with DOM Size

**Severity**: P0 — The single dominant bottleneck, persistent across ALL homepage reloads

**Classification**: Production-persistent (confirmed in production trace)

**Root cause**: PostHog's rrweb session recording performs a **full synchronous DOM snapshot** on every page load, and the cost scales super-linearly with the number of DOM nodes at snapshot time. The homepage SSR renders **1,974 nodes** (full landing page), while the editor SSR renders only **320 nodes** (bare layout shell). This 6.2x DOM size difference produces a 38.8x snapshot time difference.

**Production evidence**: The trace shows a `FunctionCall` in `use-analytics-p5H5L0r9.js` (function: `r.onload`) starting at offset +544ms and lasting **2,480ms**. CPU profiling confirms both pages run the same rrweb serialization functions:

| Function                   | Homepage samples | Editor samples | Ratio   |
| -------------------------- | ---------------- | -------------- | ------- |
| `(anonymous)` recorder.js  | 18,154           | ~200           | 91x     |
| `n` (rrweb serializer)     | 121              | 115            | 1.1x    |
| `_` (rrweb serializer)     | 48               | 89             | 0.5x    |
| `appendChild` (native DOM) | 80               | 71             | 1.1x    |
| **Total CPU samples**      | **56,037**       | **1,591**      | **35x** |

The `n`, `_`, `appendChild` per-call counts are similar — the difference is in the anonymous wrapper that iterates over DOM nodes. More nodes = more iterations = more time.

**DOM node counts at snapshot time** (from `UpdateCounters`):

```
Homepage +544ms: 1,974 nodes, 5 docs, 670 event listeners
Editor   +744ms:   320 nodes, 2 docs, 276 event listeners
```

**Why the homepage has 1,974 nodes**: SSR renders the entire landing page including below-the-fold content:

| Section                          | Est. nodes               | Images for rrweb                | Position       |
| -------------------------------- | ------------------------ | ------------------------------- | -------------- |
| Chat input + H1                  | ~50                      | 0                               | Above fold     |
| CommunityProjectGrid (10 cards)  | ~300                     | 10 thumbnails + 10 avatars      | Straddles fold |
| HeroImage (2× Safari SVG chrome) | ~250                     | 2 hero JPGs + complex SVG paths | Below fold     |
| KernelsSection (6 cards)         | ~200                     | SVG icons                       | Below fold     |
| IntegrationSection               | ~60                      | SVG icons                       | Below fold     |
| ComingSoonSection                | ~50                      | 0                               | Below fold     |
| CtaSection                       | ~40                      | 0                               | Below fold     |
| AppSidebar + layout chrome       | ~300                     | 0                               | Above fold     |
| **Total**                        | **~1,250 from sections** | **22+ images**                  | —              |

**Why the editor has 320 nodes**: SSR renders only layout containers and sidebar. Monaco editor, Three.js viewport, dockview panels, and chat UI are all **client-rendered** after hydration (DOM jumps from 320 → 974 nodes at +808ms, well after the rrweb snapshot at +744ms).

**Impact**: The main thread is frozen from +544ms to +3,024ms on every homepage load. Workers complete on background threads but message responses queue. Without PostHog, homepage TBT would be **32ms**.

### Finding 2: Provider Ordering — Workers Already Spawn Before PostHog Blocks (Corrected)

**Severity**: ~~P0~~ → Informational — Provider reordering is **not** the fix

**Classification**: Corrected from initial analysis

**Corrected analysis**: `PostHogProvider` (from `posthog-js/react`) calls `posthog.init()` in a **`useEffect`**, not during render. React's useEffect execution order is children-first, parents-second. In the current tree structure:

```
AnalyticsProvider (outer)       → useEffect fires LAST
  FileManagerProvider (middle)  → useEffect fires SECOND
    ProjectManagerProvider (inner) → useEffect fires FIRST
```

**Worker spawning happens BEFORE `posthog.init()`**. The trace confirms:

- +403ms: React renders entire tree (all providers mount, ~69ms)
- ~+472ms: useEffects fire bottom-up: ProjectManager → FileManager → AnalyticsProvider
- +488ms: Worker scripts start compiling (spawned from FileManager/ProjectManager useEffects)
- +544ms: PostHog `r.onload` fires (async — when recorder.js finishes loading from cache)

Workers are already running on background threads when the PostHog freeze starts. They complete their IDB queries during the freeze (at ~+600ms). The problem is that their **message responses** sit in the main thread's event queue, unable to be processed until PostHog's `r.onload` unblocks at +3,024ms.

**Why reordering doesn't help**: Moving `AnalyticsProvider` below `FileManagerProvider` would make `AnalyticsProvider` an _inner_ provider, causing its useEffect to fire _before_ FileManager's — making things slightly worse. And regardless of useEffect order, the blocking happens when `recorder.js` loads (async), not during useEffect execution.

**Impact**: The fix is not provider reordering but **deferring `posthog.init()` itself** (R1), so the `r.onload` doesn't fire until after worker responses have been processed.

### Finding 3: Full Converter Package Eagerly Imported via Two Chains

**Severity**: P1 — ✅ Fixed

**Status**: Resolved. `@taucad/converter/formats` subpath export created. Format metadata split from heavy CAD loaders. `FileExtensionIcon` and `format-selector.tsx` updated to use the lightweight import.

### Finding 4: `__manifest` Latency — Dev-Only Issue

**Severity**: Downgraded from P1 to Informational

**Production evidence**: `__manifest` latency is **66ms** in production (vs 2,778ms in dev). The dev-mode latency was caused by on-demand route resolution in Vite's dev server. No action needed.

### Finding 5: JSZip Blocking

**Severity**: P1 — ✅ Fixed

**Status**: Resolved. JSZip moved to dynamic `import()` inside `FileService.getZippedDirectory()`. No longer part of the file-manager worker's initial bundle evaluation.

### Finding 6: Module Evaluation Long Tasks

**Severity**: P1 — ✅ Fixed (dev-amplified, resolved in production)

**Production evidence**: Only **3 long tasks** in the production homepage trace (vs 21 in dev). Module evaluation is no longer a significant contributor — production bundling eliminates the 716-module waterfall.

### Finding 7: Project Loading Blocked by PostHog `r.onload` Event Queue Starvation

**Severity**: P0 — Partially addressed (ChatRpcSocket scoped, but PostHog still blocks)

**Production evidence**: Workers spawn at +472ms and complete their IDB queries on background threads by ~+600ms. Results are posted back to the main thread as `message` events — but these events sit in the main thread's event queue behind PostHog's `r.onload` (which holds the main thread from +544ms to +3,024ms). Projects appear at +3,071ms (Layout Shift #2) only because the queued messages are finally processed.

This is **event queue starvation**, not a provider ordering issue. The workers are already running — their results just can't be delivered.

**NavHistory loading skeleton** (R4/R15): `NavHistory` now consumes `isLoading` from `useProjects()` and renders a skeleton placeholder instead of returning `null` during loading, preventing Layout Shift #2 (CLS: 0.008).

### Finding 8: ClientOnly Defers Chat Textarea

**Severity**: P2 — ✅ Fixed

**Status**: Resolved. `ClientOnly` enhanced with `fallback` prop. `ChatTextareaSkeleton` provides a placeholder during SSR, preventing layout shift.

### Finding 9: Layout Shifts — CLS Regression

**Severity**: P1 — **CLS regressed from 0.009 to 0.020 in production**

**Production evidence**:

- **Layout Shift #1** (+477ms, score: 0.012): Sidebar chrome rearrangement after hydration — projects section absent, sidebar elements shift
- **Layout Shift #2** (+3,071ms, score: 0.008): Projects pop into the sidebar after PostHog unblocks, pushing content down

Combined CLS: **0.020** — above the "good" threshold of 0.1 but notably higher than the dev-mode 0.009. The primary cause is Layout Shift #1 which is larger in production (0.012 vs 0.002 in dev), likely because production renders the SSR shell faster, making the hydration-triggered rearrangement more visible.

### Finding 10: Three.js and 3D Deps Eagerly Loaded

**Severity**: P2 — ✅ Fixed

**Status**: Resolved. `HeroViewer` lazy-loaded with `IntersectionObserver` gate + `React.lazy()` + `Suspense`. Three.js deps not loaded until the hero section enters the viewport.

### Finding 11: Root Provider Initialization Order

**Severity**: ~~P0~~ → ✅ Resolved (no longer a concern)

**Status**: `ChatRpcSocketProvider` successfully moved from root to `projects_.$id` route. **Provider reordering for `AnalyticsProvider` is unnecessary** — see corrected Finding 2. `PostHogProvider` uses `useEffect` for `posthog.init()`, and workers already spawn before PostHog in the current tree. The fix is deferring `posthog.init()` (R1), not reordering providers.

### Finding 12: Shiki Language Grammars

**Severity**: P2 — ✅ Fixed

**Status**: Resolved. Shiki highlighter converted to lazy `getHighlighter()` with memoization. Grammars load on first use, not at module evaluation time.

### Finding 13: CodeViewer Crash on Async Highlighter (New — Introduced and Fixed)

**Severity**: P0 — ✅ Fixed

**Classification**: Production-persistent (regression from Shiki lazy loading)

**Evidence**: After making Shiki lazy (Finding 12 fix), `CodeViewer` passed `undefined` as the highlighter to `useShikiHighlighter` from `react-shiki/core` on first render. `react-shiki/core`'s `validateCoreHighlighter()` **throws synchronously** when highlighter is falsy, crashing the component tree. The error propagated to React Router's error boundary, which rendered `ErrorPage` → `CollapsibleCodeBlock` → `CodeViewer` → another crash — creating an **infinite crash loop** that blanked the screen whenever the agent wrote a `test.json` file (which triggered a chat message re-render with code blocks).

**Fix**: Split `CodeViewer` into two components — outer renders plain `<pre><code>` while highlighter loads, inner `HighlightedCode` only mounts when highlighter is defined, safely calling the hook.

### Finding 14: Editor TS Worker Long Task (New)

**Severity**: P2 — Editor-specific

**Classification**: Production-persistent

**Production evidence**: The TypeScript language service worker (`ts.worker-BzykM61u.js`) processes its initial `onmessage` in a **549ms** long task at +1,980ms. This is the `Je.globalThis.onmessage` handler — likely TypeScript's initial compilation or language service bootstrap for the editor model.

**Impact**: This is the largest single long task on the editor page, but it runs in a **worker thread**, so the main thread impact is via the `onmessage` callback processing the result. The editor is already interactive before this completes.

### Finding 15: Editor Three.js Environment Loading (New)

**Severity**: P2 — Editor-specific

**Classification**: Production-persistent

**Production evidence**: At +1,701ms, a **271ms** long task includes Three.js `Environment` component initialization (`Environment-C-bwZVSL.js`, function `Rn`) plus worker messages from the kernel. Combined with worker `onmessage` handlers, this fragments the main thread during viewport setup.

**Impact**: Contributes to editor TBT (1,290ms total) but occurs after FCP. The 3D viewport is a core feature, so this is expected cost — but the Environment loading could potentially be deferred until the viewport is visible.

## Recommendations

### Homepage Critical Path (P0)

| #   | Status       | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Effort | Impact | Finding |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | ------- |
| R1  | ⏳           | **Defer PostHog initialization** — delay `posthog.init()` using `requestIdleCallback` (with `setTimeout` fallback) so it fires AFTER worker message responses have been processed and projects are visible. **Partially mitigated by R16** (`disable_session_recording: true` + `DeferredSessionRecording` component) which removes the rrweb snapshot from `posthog.init()`. The remaining init cost is network requests (`config.js`, feature flags) which are much lighter than rrweb serialization. Still recommended for completeness but no longer critical | Low    | Medium | F1, F7  |
| R3  | 🚫 Cancelled | ~~Move `AnalyticsProvider` below critical providers~~ — **Cancelled**: `PostHogProvider` calls `posthog.init()` in `useEffect`, not render. Workers already spawn before PostHog in the current tree (useEffects fire children-first). Reordering would make PostHog init fire BEFORE workers                                                                                                                                                                                                                                                                     | —      | —      | F2      |
| R4  | ✅           | **Add loading skeleton to `NavHistory`** — consume `isLoading` from `useProjects()` and render a placeholder skeleton instead of returning `null`. This prevents Layout Shift #2 (CLS: 0.008) and gives users immediate visual feedback that projects are loading. Implemented as part of R15                                                                                                                                                                                                                                                                     | Low    | High   | F7, F9  |

### Completed Optimizations (P1–P2)

| #   | Status | Action                                                                                                                                                                                                                                          | Effort | Impact  | Finding  |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- | -------- |
| R5  | ✅     | **Split `@taucad/converter` into formats-only entry point** — created `@taucad/converter/formats` subpath export with lightweight format arrays, updated consumers                                                                              | Medium | High    | F3       |
| R6  | ✅     | **Move JSZip to dynamic `import()`** — `FileService.getZippedDirectory()` now lazy-loads JSZip on first use                                                                                                                                     | Low    | High    | F5       |
| R7  | ✅     | **Defer Shiki grammar loading** — `getHighlighter()` lazy-initializes on first call. Fixed CodeViewer crash (F13) with component split                                                                                                          | Low    | Medium  | F12, F13 |
| R8  | ✅     | **Add fallback prop to `ClientOnly` + ChatTextarea skeleton** — `ClientOnly` accepts `fallback` ReactNode, `ChatTextareaSkeleton` provides SSR placeholder                                                                                      | Low    | Medium  | F8, F9   |
| R9  | ✅     | **Defer `ChatRpcSocketProvider` to `projects_.$id` route** — Socket.IO connection no longer initialized on the homepage                                                                                                                         | Medium | Medium  | F11      |
| R10 | ✅     | **Enable PostHog deferred extension init** — `__preview_deferred_init_extensions: true` added to PostHog config. Partially effective: defers extension _registration_ but does not prevent the session recording `r.onload` cold start (see F1) | Low    | Partial | F1       |
| R11 | ✅     | **Lazy-load HeroViewer with IntersectionObserver** — `React.lazy()` + `IntersectionObserver` gate defers Three.js/runtime deps until hero enters viewport                                                                                       | Medium | Medium  | F10      |
| R12 | ✅     | **ChatTextarea skeleton as `ClientOnly` fallback** — skeleton provides visual placeholder during SSR, preventing layout shift                                                                                                                   | Low    | Medium  | F8, F9   |

### Production Trace Validation

| #   | Status | Action                                                                                                                                                                                   | Effort | Impact | Finding |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | ------- |
| R13 | ✅     | **Capture production trace** — confirmed: `__manifest` is 66ms (not 2.8s), module evaluation is 3 long tasks (not 21), PostHog is 2.48s (same as dev). All dev-amplified issues resolved | Low    | High   | F4, F6  |
| R14 | ✅     | **Verify `__manifest` production latency** — confirmed 66ms for route manifest, 2ms for project routes. No action needed                                                                 | Low    | —      | F4      |

### New Recommendations

| #   | Status | Action                                                                                                                                                                                                                                                                                                                                                                                                             | Priority | Effort | Impact   | Finding |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | -------- | ------- |
| R15 | ✅     | **Fix Layout Shift #1 (CLS: 0.012)** — `NavHistory` now consumes `isLoading` from `useProjects()` and renders a skeleton `SidebarGroup` with pulsing placeholders when loading, instead of returning `null`. Reserves space for the "Recent Projects" section before data arrives, preventing CLS                                                                                                                  | P1       | Medium | Medium   | F9      |
| R16 | ✅     | **Disable session recording on initial load** — `posthogConfig` sets `disable_session_recording: true` to prevent rrweb from running during `posthog.init()`. `DeferredSessionRecording` component calls `posthog.startSessionRecording()` via `requestIdleCallback` (with `setTimeout` fallback for Safari) after the page is idle. Completely eliminates the DOM snapshot from the critical path                 | P0       | Low    | Critical | F1      |
| R17 | ✅     | **Defer Three.js Environment loading on editor** — `showEnvironment` in `lights.tsx` wrapped with `useDeferredValue()` so the `Environment` component mounts as a low-priority React update, avoiding main thread blocking during initial render                                                                                                                                                                   | P2       | Low    | Low      | F15     |
| R18 | ✅     | **Monitor TS worker cold start** — `performance.mark('ts-worker:create')` and `performance.measure('ts-worker:cold-start')` added to `monaco.lib.ts` around `new TsWorker()`. Appears in production Chrome traces for future monitoring of the 549ms TS worker init                                                                                                                                                | P3       | Low    | Low      | F14     |
| R19 | ✅     | **Reduce homepage SSR DOM surface area** — reusable `LazySection` component (`lazy-section.tsx`) uses `IntersectionObserver` to defer rendering until intersection. Wraps `HeroImage`, `KernelsSection`, `IntegrationSection`, `ComingSoonSection`, and `CtaSection` in `route.tsx`. Reduces DOM at snapshot time from ~1,974 to ~700 nodes. Combined with R16 (deferred recording), the eventual snapshot is fast | P0       | Medium | Critical | F1      |
| R20 | ✅     | **Lazy-render `CommunityProjectGrid` below the fold** — the 10-card grid (~300 nodes + 20 images) wrapped in `<LazySection rootMargin="200px">` for early loading before it enters the viewport. Defers the entire community section's DOM rendering until near-visible                                                                                                                                            | P1       | Low    | High     | F1      |

## Diagrams

### Production Homepage — Main Thread Activity

```
0ms        200ms       400ms       600ms       800ms       1000ms
|-----------|-----------|-----------|-----------|-----------|---
|           |           |           |           |           |
|  nav ──── ▓ FCP ───── ░░░░░░░░░░░░░░░░░░░░░░░ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
|           211ms       |           |  LS#1     | PostHog r.onload BLOCKS
|                       |           |  477ms    | 2480ms starts at +544ms
|                       | auth 17ms |  CLS .012 |
|                       | models 74ms            |
|                       | __manifest 66ms        |

1000ms      1500ms      2000ms      2500ms      3000ms      3500ms
|-----------|-----------|-----------|-----------|-----------|
|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|         |
| PostHog r.onload — rrweb DOM snapshot — NO PAINTS        |  render |
| initSessionRecording blocks main thread for 2480ms       |  LS#2   |
|                                                          |  3071ms |
|                                                          |  done   |
|                                                          |  3122ms |

▓ = main thread blocked    ░ = background work    | = idle
```

### Production Editor — Main Thread Activity

```
0ms        500ms       1000ms      1500ms      2000ms      2500ms
|-----------|-----------|-----------|-----------|-----------|---
|           |           |           |           |           |
|  nav ──── ░░ ▓▓ ░░ ▓▓ ░░ ▓▓ ░░░░ ▓▓▓▓ ░░░░░ ▓▓▓▓▓▓▓▓▓▓ ░░
|           |FP 706ms   |FCP 1081ms |env 271ms  |ts.worker  |
|           |           |projects!  |3D setup   |549ms      |
|           |           |sidebar    |           |           |
|           |PostHog    |LS#1 1248ms|           |LS#2 2111ms|
|           |64ms (warm)|           |           |LCP 2131ms |

▓ = long task    ░ = smaller tasks    | = idle
```

### Provider Hierarchy — Current State

```
root.tsx Layout
 ├─ AuthConfigProvider         [eager — auth UI config]
 ├─ QueryClientProvider        [eager — React Query client]
 ├─ AnalyticsProvider          [useEffect: posthog.init() — fires LAST (outermost)]
 │    ├── DeferredSessionRecording [✅ R16: startSessionRecording via requestIdleCallback]
 │    ╰── PostHog r.onload → NO rrweb snapshot (disable_session_recording: true)
 │        Recording starts later via requestIdleCallback with reduced DOM
 ├─ FileManagerProvider        [useEffect: spawns worker — fires SECOND ✅ already before PostHog]
 ├─ ProjectManagerProvider     [useEffect: spawns worker — fires FIRST ✅ already before PostHog]
 │    ╰── REQUIRED for sidebar projects (NavHistory → useProjects)
 ├─ ThemeProvider              [eager — theme from cookie]
 ├─ ColorProvider              [eager — accent color]
 ├─ TooltipProvider            [eager — Radix tooltip]
 ├─ KeyboardProvider           [eager — shortcuts]
 └─ UnloadProvider             [eager — beforeunload]
      └─ LayoutDocument
           └─ <Page>
                ├─ AppSidebar
                │    └─ NavHistory ← useProjects() [✅ R15: loading skeleton, no CLS]
                └─ <Outlet>
                     └─ ChatStart (index route)
                          ├─ ChatTextarea ← ClientOnly [✅ skeleton fallback]
                          ├─ CommunityProjectGrid [✅ R20: LazySection with rootMargin=200px]
                          ├─ HeroImage [✅ R19: LazySection]
                          ├─ KernelsSection [✅ R19: LazySection]
                          ├─ LazyHeroViewer ← [✅ IntersectionObserver gate]
                          ├─ IntegrationSection [✅ R19: LazySection]
                          ├─ ComingSoonSection [✅ R19: LazySection]
                          └─ CtaSection [✅ R19: LazySection]
```

**Proposed fix** (R1 + R16 + R19): Defer PostHog init, disable auto-recording, reduce SSR DOM surface.

```
Current timeline (homepage):           Proposed timeline (R1 + R16 + R19):
+211ms FP (1,974 DOM nodes)           +211ms FP (~700 DOM nodes — below-fold lazy)
+472ms workers spawn                   +472ms workers spawn
+472ms posthog.init()                  +472ms (no posthog.init yet)
+544ms rrweb snapshots 1,974 nodes     ~+600ms worker results processed
  ... 2,480ms frozen ...               ~+650ms projects appear ← 4.8x faster
+3,024ms unblocks                      ~+700ms requestIdleCallback fires
+3,071ms projects appear               ~+700ms posthog.init() (startManually: true)
                                        ~+700ms NO rrweb snapshot (manual start)
                                        ~+800ms posthog.startSessionRecording()
                                        ~+800ms rrweb snapshots ~700 nodes (~200ms)
```

**Expected result**: Projects appear at ~650ms, rrweb snapshot reduced from 2,480ms to ~200ms (smaller DOM + deferred), total page freeze eliminated from critical path.

## References

### Traces

- Dev trace: `Trace-20260402T102904.json.gz` (Vite dev mode, cold navigation to `/`)
- Production homepage trace: `Trace-20260402T144553.json.gz` (production build, page refresh of `/` from steady state, 1,974 DOM nodes at rrweb snapshot)
- Production editor trace: `Trace-20260402T144723.json.gz` (production build, page refresh of `/projects/proj_*` from steady state, 320 DOM nodes at rrweb snapshot)

### Related Documents

- `docs/research/filesystem-gap-analysis.md`
- `docs/research/vscode-fs-performance.md`
- `docs/research/large-repo-import-performance.md`
- `docs/policy/vision-policy.md`

### Source Files

- `apps/ui/app/root.tsx` — root layout, provider hierarchy
- `apps/ui/app/routes/_index/route.tsx` — index page
- `apps/ui/app/hooks/use-analytics.tsx` — PostHog provider
- `apps/ui/app/lib/posthog.lib.ts` — PostHog config (`disable_session_recording`, `__preview_deferred_init_extensions`)
- `apps/ui/app/hooks/use-project-manager.tsx` — project manager provider
- `apps/ui/app/hooks/use-projects.ts` — projects React Query hook
- `apps/ui/app/components/nav/nav-history.tsx` — sidebar project list (loading skeleton when `isLoading`)
- `apps/ui/app/components/chat/chat-textarea.tsx` — chat input with `ClientOnly` + skeleton
- `apps/ui/app/components/chat/chat-textarea-skeleton.tsx` — skeleton fallback
- `apps/ui/app/routes/_index/hero-viewer-gate.tsx` — lazy hero viewer with IntersectionObserver
- `apps/ui/app/components/code/code-viewer.tsx` — code viewer with lazy Shiki (split component)
- `apps/ui/app/components/ui/lazy-section.tsx` — reusable IntersectionObserver gate for below-fold sections
- `apps/ui/app/components/geometry/graphics/three/react/lights.tsx` — `useDeferredValue` for Environment gate
- `apps/ui/app/lib/monaco.lib.ts` — TS worker performance marks
- `packages/converter/src/formats.ts` — lightweight format arrays (new subpath export)
- `packages/filesystem/src/file-service.ts` — lazy JSZip import

### External

- [Chrome DevRel: Long Tasks API](https://developer.chrome.com/docs/lighthouse/performance/long-tasks-devtools)
- [React Router Lazy Route Modules](https://reactrouter.com/how-to/lazy)
- [PostHog `__preview_deferred_init_extensions`](https://posthog.com/docs/libraries/js)
- [rrweb Session Recording Performance](https://github.com/rrweb-io/rrweb/issues)
