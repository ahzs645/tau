---
title: 'Safari `blob://nullhttp//` Sourcemap Errors from rrweb Canvas Worker'
description: 'WebKit URL-resolver bug surfaces a malformed sourcemap fetch from the rrweb canvas snapshot worker bundled inside PostHog session recording'
status: active
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/safari-localhost-build-coep-worker-loading.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/safari-replicad-empty-geometry-investigation.md
  - docs/research/safari-cross-origin-isolation.md
---

# Safari `blob://nullhttp//` Sourcemap Errors from rrweb Canvas Worker

Why Safari prints three "Not allowed to load local resource: `blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map`" errors that Chrome never prints, what creates the worker, and how to silence the errors at source.

## Executive Summary

The worker is **not** Three.js's `ImageBitmapLoader` (as `staging-cors-coep-safari-rendering-audit.md` Finding 9 and `safari-localhost-build-coep-worker-loading.md` Finding 8 previously assumed). It is **rrweb's canvas snapshot worker** (`image-bitmap-data-url-worker.ts`), bundled into PostHog's lazily-loaded `recorder.js`. rrweb instantiates it via `URL.createObjectURL(new Blob([source]))` whenever canvas recording is enabled; the inlined worker source carries a relative `//# sourceMappingURL=image-bitmap-data-url-worker-<hash>.js.map` directive (added by `rollup-plugin-web-worker-loader` since rrweb PR [#1309](https://github.com/rrweb-io/rrweb/pull/1309)). WebKit's URL resolver mis-stringifies that relative URL against the blob's "inner URL" base — Chrome resolves it cleanly and silently 404s, Safari produces the malformed `blob://nullhttp//<host>/...` and refuses to fetch it under "local resource" security checks. The errors are functionally benign (only a missing sourcemap), but the canvas worker itself wastes Safari main-thread/memory cycles snapshotting our Three.js WebGL panes for no analytics value. **Fix**: explicitly opt out of canvas recording in `apps/ui/app/lib/posthog.lib.ts` via `session_recording.captureCanvas.recordCanvas = false`. This stops the worker from being instantiated at all, eliminating the noise and the per-canvas snapshot overhead.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: The worker is from rrweb, not Three.js](#finding-1-the-worker-is-from-rrweb-not-threejs)
  - [Finding 2: PostHog instantiates the worker only when canvas recording is enabled](#finding-2-posthog-instantiates-the-worker-only-when-canvas-recording-is-enabled)
  - [Finding 3: rrweb's worker source carries a relative sourceMappingURL](#finding-3-rrwebs-worker-source-carries-a-relative-sourcemappingurl)
  - [Finding 4: Safari's URL resolver mis-stringifies the blob: base URL](#finding-4-safaris-url-resolver-mis-stringifies-the-blob-base-url)
  - [Finding 5: Why Chrome stays quiet](#finding-5-why-chrome-stays-quiet)
  - [Finding 6: The errors are benign — but the worker is not free](#finding-6-the-errors-are-benign--but-the-worker-is-not-free)
  - [Finding 7: Prior research mis-identified the source](#finding-7-prior-research-mis-identified-the-source)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [References](#references)

## Problem Statement

Loading `http://localhost:3000/` in Safari (after the `nx serve ui` Express + COI fix shipped) produces three console errors per session:

```text
[Error] Not allowed to load local resource: blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map
[Error] Not allowed to request resource
[Error] Cannot load blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map due to access control checks.
```

Chrome (latest) loads the same page with no equivalent error. The errors fire after `[FM-Worker] module evaluated`, are repeatable on every refresh, and are pinned to a worker file (`image-bitmap-data-url-worker-Ca9A-vl6.js`) that does **not** exist anywhere on disk in `apps/ui/build/client/assets/` or in any `node_modules` package shipped with the bundle. The user-facing question: who creates this worker, why does Safari treat the URL differently than Chrome, and what is the actual fix.

## Methodology

| Step                                                                                                                                                                                    | Purpose                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ls apps/ui/build/client/assets/ \| grep -E 'image\|bitmap\|worker'`                                                                                                                    | Confirm no `image-bitmap-data-url-worker-*.js` exists in our build output                                                                                                                                                     |
| `curl -o /tmp/x http://localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js`                                                                                                         | Confirm the URL resolves to the SPA-shell HTML (no real asset)                                                                                                                                                                |
| `rg image-bitmap-data-url node_modules/`                                                                                                                                                | Confirm no installed package contains the literal string                                                                                                                                                                      |
| Web search for `"image-bitmap-data-url-worker"`                                                                                                                                         | Identify the symbol's origin: rrweb's `_virtual/image-bitmap-data-url-worker.js`                                                                                                                                              |
| Read `posthog-js@1.353.1/lib/src/extensions/replay/external/lazy-loaded-session-recorder.js`                                                                                            | Confirm PostHog wires `session_recording.captureCanvas.recordCanvas` (client) and `_remoteConfig.canvasRecording.enabled` (server) → `sessionRecordingOptions.recordCanvas`                                                   |
| Fetch `rrweb/.../canvas-manager.ts` from GitHub                                                                                                                                         | Confirm `new ImageBitmapDataURLWorker()` is gated behind `recordCanvas && (sampling === 'all' \|\| typeof sampling === 'number')`                                                                                             |
| Fetch `rrweb/.../image-bitmap-data-url-worker.ts` from GitHub                                                                                                                           | Inspect the actual worker source (uses `OffscreenCanvas.convertToBlob` + `base64-arraybuffer.encode`)                                                                                                                         |
| Read `apps/ui/app/lib/posthog.lib.ts` and `apps/ui/app/hooks/use-analytics.tsx`                                                                                                         | Confirm Tau enables session recording (deferred via `requestIdleCallback`) but does **not** explicitly opt out of canvas recording, so PostHog's remote config decides                                                        |
| Cross-reference [ampproject/amphtml#29101](https://github.com/ampproject/amphtml/issues/29101) and [PostHog/posthog-flutter#306](https://github.com/PostHog/posthog-flutter/issues/306) | Confirm the malformed `blob://nullhttps//<host>/<path>.js.map` shape is a long-standing WebKit URL-resolver behaviour reported across multiple ecosystems (AMP web workers, PostHog Flutter, rrweb) — not specific to our app |

## Findings

### Finding 1: The worker is from rrweb, not Three.js

The literal hash-named file `image-bitmap-data-url-worker-Ca9A-vl6.js` is not produced by our Vite build (`apps/ui/build/client/assets/` contains no such asset) and is not present in any `node_modules` package on disk. It originates from **rrweb 2.x**'s `packages/rrweb/src/record/observers/canvas/canvas-manager.ts`:

```typescript
import ImageBitmapDataURLWorker from 'web-worker:../../workers/image-bitmap-data-url-worker.ts';
// ...
const worker = new ImageBitmapDataURLWorker() as ImageBitmapDataURLRequestWorker;
```

`web-worker:` is a `rollup-plugin-web-worker-loader` virtual prefix. Since rrweb [PR #1309](https://github.com/rrweb-io/rrweb/pull/1309) (merged Oct 2023, present in 2.0.0-alpha.12+), the plugin emits the worker as `createInlineWorkerFactory(/* preserveSource */ function() { …source… })` rather than a base64-encoded blob. The worker module ends up bundled directly into rrweb's distribution chunk, which itself is bundled into PostHog's lazily-loaded `recorder.js` chunk that PostHog fetches from `https://us.i.posthog.com/static/recorder.js?v=…` after `posthog.startSessionRecording()` is invoked.

The Tau call site is `apps/ui/app/hooks/use-analytics.tsx:116-138` (`DeferredSessionRecording`), which schedules `posthog.startSessionRecording()` via `requestIdleCallback` after the page is idle. This explains why the errors appear several seconds after the FM worker boots, not at initial page load.

### Finding 2: PostHog instantiates the worker only when canvas recording is enabled

Reading `posthog-js@1.353.1/lib/src/extensions/replay/external/lazy-loaded-session-recorder.js:434-442`:

```javascript
get _canvasRecording() {
  var canvasRecording_client_side = this._instance.config.session_recording.captureCanvas;
  var canvasRecording_server_side = this._remoteConfig?.canvasRecording;
  var enabled =
    canvasRecording_client_side?.recordCanvas
    ?? canvasRecording_server_side?.enabled
    ?? false;
  // ...fps, quality...
}

// later (line 1332)
if (this._canvasRecording && this._canvasRecording.enabled) {
  sessionRecordingOptions.recordCanvas = true;
  sessionRecordingOptions.sampling = { canvas: this._canvasRecording.fps };
  sessionRecordingOptions.dataURLOptions = { type: 'image/webp', quality: this._canvasRecording.quality };
}
```

When (and only when) `recordCanvas: true` is passed into rrweb's `record({ ... })`, rrweb's `CanvasManager` constructor takes the `initCanvasFPSObserver` branch and runs `new ImageBitmapDataURLWorker()`, which creates the inline blob worker.

`apps/ui/app/lib/posthog.lib.ts` does not set `captureCanvas`, so the value is purely driven by the PostHog project's server-side remote config (`/decide` response). The fact that the worker is being created in our user's session means canvas recording has been turned on for the project remotely (likely via the PostHog dashboard's Session Replay → Canvas option). Tau itself never opts into it client-side, but it never opts out either.

### Finding 3: rrweb's worker source carries a relative sourceMappingURL

`rollup-plugin-web-worker-loader` with `preserveSource: true` (the default since rrweb #1309) inlines the bundled worker as a JS string that includes the trailing source-map directive:

```text
…<minified worker body>…
//# sourceMappingURL=image-bitmap-data-url-worker-<hash>.js.map
```

The directive is **relative** — there is no absolute URL or `data:` URI — so the consuming browser must resolve it against the worker's own script URL.

When `createInlineWorkerFactory` runs at runtime, it does:

```javascript
const blob = new Blob([source], { type: 'application/javascript' });
const url = URL.createObjectURL(blob); // "blob:http://localhost:3000/<uuid>"
const worker = new Worker(url);
```

So the worker's "script URL" is a `blob:` URL whose **inner URL** is the page's origin (`http://localhost:3000`) and whose **inner path** is a freshly generated UUID. The browser's source-map fetcher sees the relative `image-bitmap-data-url-worker-<hash>.js.map` and must compute `new URL(directive, blobUrl)`.

### Finding 4: Safari's URL resolver mis-stringifies the blob: base URL

The malformed URL `blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map` parses as:

| Component | Value                                                           |
| --------- | --------------------------------------------------------------- |
| scheme    | `blob`                                                          |
| authority | `nullhttp` (host `nullhttp`, no port)                           |
| path      | `//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map` |

Reverse-engineering the bug from this shape, WebKit appears to serialize the resolved blob URL as the concatenation:

```text
blob:  +  //  +  <origin = "null">  +  <innerURL minus its scheme separator>
                                                ^^^ "http" + "//localhost:3000/foo.js.map"
                                                = "http//localhost:3000/foo.js.map"
```

Yielding the literal string `blob://null` + `http//localhost:3000/...` = `blob://nullhttp//localhost:3000/...`. The leading `blob://null` is WebKit's representation of an opaque-origin blob URL; the lost `:` between `http` and `//localhost:3000` is the actual stringification bug — the inner URL's scheme separator is dropped during the rebuild.

WebKit's loader then submits this URL to the resource-loading pipeline, which classifies it as a "local" (i.e., non-HTTP, non-HTTPS, non-data) resource and rejects it with the canonical three-line cascade:

```text
[Error] Not allowed to load local resource: blob://nullhttp//…js.map
[Error] Not allowed to request resource
[Error] Cannot load blob://nullhttp//…js.map due to access control checks.
```

Identical error shapes have been reported against unrelated projects across years:

| Year | Project                                                                                      | URL pattern                                                                     |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 2020 | [ampproject/amphtml#29101](https://github.com/ampproject/amphtml/issues/29101) (web worker)  | `blob://nullhttps//playground.amp.dev/ww.js.map`                                |
| 2024 | [PostHog/posthog-flutter#306](https://github.com/PostHog/posthog-flutter/issues/306) (rrweb) | `blob://nullhttp//localhost:64231/image-bitmap-data-url-worker-ChEIhO0o.js.map` |
| 2026 | This investigation (rrweb + Tau)                                                             | `blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map`  |

The bug has persisted across multiple Safari major versions and is unrelated to our COI/COEP fix or our Express server migration. PostHog maintainers acknowledge it as a Safari URL-construction bug "of no consequence".

### Finding 5: Why Chrome stays quiet

Chrome (Blink) implements blob-URL-relative resolution by using the blob URL's **opaque path** as the base. `new URL('foo.js.map', 'blob:http://localhost:3000/<uuid>')` returns a well-formed URL whose path-stem replacement yields a URL that the source-map subsystem then attempts to fetch — typically returning 404. Critically, Chrome's DevTools-emitted "Source map error" lives in the **DevTools panel**, not in the page console, so production users never see it. Safari conflates source-map fetch failures into the page console as `[Error]` entries, amplifying the noise.

A second contributing factor: Chrome only fetches sourcemaps when DevTools is open (or `Settings → Sources → Enable JavaScript source maps` is on). Safari fetches sourcemaps eagerly under more conditions, including when the Web Inspector has ever been opened in the current profile. Together these explain why the same blob-worker behaves silently in Chrome and noisily in Safari for the same page load.

### Finding 6: The errors are benign — but the worker is not free

The functional impact of the error is zero: only a single missing sourcemap, which only matters when debugging rrweb's worker (which we never do). However, **the worker itself is not free**:

1. Every canvas in the page (including all of Tau's Three.js viewer/preview WebGL contexts) is snapshotted at the configured FPS (default 4 fps on PostHog's remote config) by calling `OffscreenCanvas.convertToBlob` → base64-encode → postMessage back to main → packaged into an rrweb `IncrementalSnapshot` event → uploaded to PostHog.
2. PostHog/rrweb has a [known per-snapshot allocation pressure issue on Safari](https://github.com/PostHog/posthog-flutter/issues/306) (each snapshot allocates a new `OffscreenCanvas` and `Blob`); the same issue thread documents network-tab inflation in Safari that is invisible in Chrome.
3. The captured snapshots of CAD WebGL surfaces have low replay value (most pixels are dynamic geometry the analyst cannot reason about) and consume PostHog ingest quota.

Disabling canvas recording deletes the worker entirely (instantiation gate at `lazy-loaded-session-recorder.js:1332`), which simultaneously:

- Removes the Safari console errors at source.
- Removes the per-frame canvas-snapshot main-thread cost.
- Removes the snapshot upload bandwidth.
- Preserves all other session-replay coverage (DOM mutations, inputs, console, network).

### Finding 7: Prior research mis-identified the source

Two prior Tau research docs documented this error message but attributed it to Three.js's `ImageBitmapLoader`:

| Doc                                                                                | Wording                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/research/safari-localhost-build-coep-worker-loading.md` Finding 8 (line 271) | "Safari sourcemap quirk for workers created from blob URLs by Three.js's `ImageBitmapLoader` (used unconditionally by `GLTFLoader`)"                                                    |
| `docs/research/staging-cors-coep-safari-rendering-audit.md` Finding 9              | "`ImageBitmapLoader` (in `node_modules/three/.../GLTFLoader.js`) creates a worker from a Blob URL to decode image data URLs off-thread."                                                |
| `docs/research/safari-replicad-empty-geometry-investigation.md` Finding 8          | "the `//# sourceMappingURL=…` directive embedded in the inline `image-bitmap-data-url-worker.js` blob that Three.js's `GLTFLoader` instantiates via `URL.createObjectURL(new Blob(…))`" |

This investigation contradicts those: Three.js's `ImageBitmapLoader` (`packages/three/src/loaders/ImageBitmapLoader.js`) does **not** create a Web Worker — it uses `fetch()` + `createImageBitmap()` on the main thread. `GLTFLoader.js` uses Three's `FileLoader`/`ImageBitmapLoader` and the only worker pools in three.js's `examples/jsm/loaders/` belong to `KTX2Loader`, `DRACOLoader`, and `3DMLoader` (verified via `grep -n 'new Worker' three/examples/jsm/loaders/`). The literal string `image-bitmap-data-url` does not appear anywhere in `node_modules/.pnpm/three@0.179.1/`.

The prior docs should be back-corrected to point at this investigation as the canonical source of truth.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                   | Priority | Effort | Impact |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `captureCanvas: { recordCanvas: false }` under `session_recording` in `apps/ui/app/lib/posthog.lib.ts`. This client-side opt-out takes precedence over PostHog remote config, prevents `new ImageBitmapDataURLWorker()` from running, and removes the Safari console errors **at source**.                                                                                                                                           | P1       | XS     | High   |
| R2  | Add a Vitest assertion in `apps/ui/app/lib/posthog.lib.test.ts` that pins `posthogConfig.options.session_recording.captureCanvas.recordCanvas === false`, so a future contributor cannot silently re-enable canvas recording (which would re-introduce the Safari noise and the per-frame snapshot cost on every CAD viewer).                                                                                                            | P1       | XS     | High   |
| R3  | Update the three prior research docs (`safari-localhost-build-coep-worker-loading.md` Finding 8, `staging-cors-coep-safari-rendering-audit.md` Finding 9, `safari-replicad-empty-geometry-investigation.md` Finding 8) with a back-pointer to this document and a short correction noting that the worker is rrweb-bundled-via-PostHog, not three.js. Keep the original Findings (they are still useful for tracing the misattribution). | P2       | XS     | Med    |
| R4  | If/when canvas snapshotting becomes desirable (e.g. for non-WebGL `<canvas>` UI), revisit by setting `recordCanvas: true` on the specific PostHog projects that need it via the dashboard, and verify the Safari sourcemap noise has been fixed upstream by then. Track `apps/ui/app/lib/posthog.lib.ts` opt-out as the project-wide default until rrweb stops emitting a relative sourceMappingURL in inline workers.                   | P3       | XS     | Low    |
| R5  | (Upstream, optional) File an issue against rrweb requesting that production builds either (a) drop the trailing `//# sourceMappingURL=` from the inlined worker, or (b) emit it as an absolute `data:` URI. Either change makes the worker silent on Safari for every downstream consumer (PostHog, FullStory, Highlight, etc.). PR [#1309](https://github.com/rrweb-io/rrweb/pull/1309) is the regression reference.                    | P3       | S      | Low    |

## Trade-offs

| Approach                                                      | Pros                                                                                                                   | Cons                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(R1) Client-side `captureCanvas.recordCanvas: false`**      | One-line fix. Source-level remediation. Reduces Safari memory/CPU. Saves PostHog ingest. Survives remote-config drift. | Loses canvas snapshots from session replays — but our canvases are WebGL CAD viewers with low replay value, and we already blur sensitive data via DOM masking.                                                              |
| Disable session recording entirely                            | Zero analytics overhead.                                                                                               | Loses replay coverage of UI bugs (chat composer, dialogs, file manager) — high-value for a multi-feature SDK product.                                                                                                        |
| Suppress the console errors via global `console.error` filter | Zero impact on functionality.                                                                                          | Band-aid: hides the symptom, leaves the per-frame canvas snapshot cost in place. Risks suppressing legitimate `Not allowed to load local resource` errors in unrelated paths. Anti-pattern per CLAUDE.md ("never band-aid"). |
| Patch rrweb / posthog-recorder to strip the sourceMappingURL  | Definitive upstream fix.                                                                                               | rrweb's recorder bundle is fetched at runtime from PostHog's CDN — we cannot patch it. Self-hosting the recorder would be net-new infra.                                                                                     |
| Switch session recording to a different vendor                | Could avoid rrweb specifically.                                                                                        | Massive refactor. Most session-replay vendors use rrweb under the hood and would inherit the same issue.                                                                                                                     |

R1 is the only Pareto-optimal choice today.

## Code Examples

### Current `apps/ui/app/lib/posthog.lib.ts` (excerpt)

```typescript
export const posthogConfig: { options: Partial<PostHogConfig>; apiKey: string } = {
  options: {
    api_host: '/api/ph',
    ui_host: ENV.POSTHOG_UI_HOST,
    defaults: '2025-11-30',
    cookieless_mode: 'on_reject',
    __preview_deferred_init_extensions: true,
    disable_session_recording: true,
  },
  apiKey: ENV.POSTHOG_CLIENT_KEY ?? '',
};
```

### Proposed change (R1)

```typescript
export const posthogConfig: { options: Partial<PostHogConfig>; apiKey: string } = {
  options: {
    api_host: '/api/ph',
    ui_host: ENV.POSTHOG_UI_HOST,
    defaults: '2025-11-30',
    cookieless_mode: 'on_reject',
    __preview_deferred_init_extensions: true,
    disable_session_recording: true,
    session_recording: {
      // Hard-disable canvas snapshotting. PostHog's remote config can still flip it on
      // for our project, which would (a) re-introduce the Safari `blob://nullhttp//…js.map`
      // sourcemap-fetch errors from rrweb's inline canvas worker, and (b) cost a per-frame
      // OffscreenCanvas allocation per WebGL viewer with no replay value for our CAD
      // surfaces. See docs/research/safari-blob-worker-sourcemap-null-origin.md.
      captureCanvas: { recordCanvas: false },
    },
  },
  apiKey: ENV.POSTHOG_CLIENT_KEY ?? '',
};
```

### Test pinning (R2)

```typescript
// apps/ui/app/lib/posthog.lib.test.ts
it('keeps canvas snapshotting disabled (Safari rrweb sourcemap quirk)', () => {
  expect(posthogConfig.options.session_recording?.captureCanvas?.recordCanvas).toBe(false);
});
```

## Diagrams

### Trigger chain (current)

```text
   AnalyticsProvider (apps/ui/app/hooks/use-analytics.tsx:140)
     └─ DeferredSessionRecording (line 116)
         └─ requestIdleCallback → posthog.startSessionRecording()
             └─ PostHog lazy-loads recorder.js from us.i.posthog.com
                 └─ Bundled rrweb sees recordCanvas=true (server remote config)
                     └─ new CanvasManager({ recordCanvas: true, sampling: { canvas: fps } })
                         └─ initCanvasFPSObserver
                             └─ new ImageBitmapDataURLWorker()
                                 └─ createInlineWorkerFactory(source)
                                     └─ URL.createObjectURL(new Blob([source]))
                                         └─ blob:http://localhost:3000/<uuid>
                                             └─ Worker fetches source
                                                 └─ //# sourceMappingURL=…-Ca9A-vl6.js.map
                                                     └─ Safari URL resolver
                                                         └─ blob://nullhttp//localhost:3000/…js.map  ← MALFORMED
                                                             └─ "Not allowed to load local resource"
```

### Trigger chain (after R1)

```text
   AnalyticsProvider
     └─ DeferredSessionRecording
         └─ requestIdleCallback → posthog.startSessionRecording()
             └─ PostHog lazy-loads recorder.js
                 └─ Bundled rrweb sees recordCanvas=false (client opt-out wins)
                     └─ CanvasManager skips initCanvasFPSObserver
                         └─ ImageBitmapDataURLWorker is never instantiated
                             └─ Blob URL never created
                                 └─ Source-map directive never resolved
                                     └─ Safari console: clean
```

## References

- [rrweb PR #1309: Enable preserveSource of rollup-plugin-web-worker-loader](https://github.com/rrweb-io/rrweb/pull/1309) — introduced the inline-worker source that carries the relative sourceMappingURL
- [rrweb canvas-manager.ts (master)](https://raw.githubusercontent.com/stackblitz/rrweb/master/packages/rrweb/src/record/observers/canvas/canvas-manager.ts) — `new ImageBitmapDataURLWorker()` instantiation site
- [rrweb image-bitmap-data-url-worker.ts (master)](https://github.com/rrweb-io/rrweb/blob/master/packages/rrweb/src/record/workers/image-bitmap-data-url-worker.ts) — worker source
- [posthog-flutter#306](https://github.com/PostHog/posthog-flutter/issues/306) — PostHog maintainers' confirmation that the Safari error is harmless WebKit URL-construction
- [ampproject/amphtml#29101](https://github.com/ampproject/amphtml/issues/29101) — same `blob://nullhttps//…` shape, different consumer (AMP web worker), 2020
- [WebKit Bug 156125: Fetching blob URLs with query parameters result in 404](https://bugs.webkit.org/show_bug.cgi?id=156125) — adjacent (different) WebKit blob-URL bug demonstrating long-standing edge cases in WebKit's blob-URL handling
- Related: `docs/research/safari-localhost-build-coep-worker-loading.md` (the investigation that surfaced this error alongside the COEP fix)
- Related: `docs/research/staging-cors-coep-safari-rendering-audit.md` Finding 9 (mis-identified the source as Three.js)
- Related: `docs/research/safari-replicad-empty-geometry-investigation.md` Finding 8 (mis-identified the source as Three.js)
- Source: `apps/ui/app/lib/posthog.lib.ts` (proposed fix site)
- Source: `apps/ui/app/hooks/use-analytics.tsx:116-138` (`DeferredSessionRecording` — trigger for `startSessionRecording`)
- Source: `node_modules/.pnpm/posthog-js@1.353.1/.../lazy-loaded-session-recorder.js:434-442, 1332-1335` (canvas-recording resolution and rrweb option wiring)
