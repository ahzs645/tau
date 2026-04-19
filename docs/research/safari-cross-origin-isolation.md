---
title: 'Safari Cross-Origin Isolation and SharedArrayBuffer Degradation'
description: 'Investigation into Safari lack of COEP credentialless support and strategies for graceful SAB degradation across dev and production'
status: active
created: '2026-04-02'
updated: '2026-04-02'
category: investigation
related:
  - docs/research/geometry-pipeline-copy-audit.md
  - docs/research/geometry-data-transfer-architecture.md
---

# Safari Cross-Origin Isolation and SharedArrayBuffer Degradation

Investigation into why `SharedArrayBuffer` is unavailable in Safari when using `COEP: credentialless`, and strategies for enabling cross-origin isolation across all browsers while gracefully degrading when SAB is unavailable.

## Executive Summary

Safari does not support `Cross-Origin-Embedder-Policy: credentialless` (no version through 26.5, including iOS Safari). Tau currently sends `credentialless` in both development (Vite plugin) and production (Netlify headers), which means Safari never achieves `crossOriginIsolated = true` and `SharedArrayBuffer` is unavailable. The recommended fix is a two-layer approach: (1) send browser-appropriate COEP headers (`credentialless` for Chromium/Firefox, `require-corp` for Safari), and (2) maintain the existing code-level SAB fallbacks as defense-in-depth. Tau's architecture is well-positioned for `require-corp` since all external resources (PostHog, GitHub avatars) are same-origin proxied.

## Problem Statement

After implementing SAB hardening in `file-manager.machine.ts` and `runtime-client.ts`, Safari loads the app but runs without `SharedArrayBuffer` — losing zero-copy geometry transport, content pool sharing, and signal buffer communication. The console confirms the fallback is active:

```
[FileManager] SharedArrayBuffer unavailable, skipping content pool
```

Chrome and Firefox work correctly with full SAB support because they support `COEP: credentialless`.

### Root Cause

| Browser               | `COEP: credentialless` | `crossOriginIsolated` | SAB available |
| --------------------- | ---------------------- | --------------------- | ------------- |
| Chrome 96+            | Supported              | `true`                | Yes           |
| Firefox 119+          | Supported              | `true`                | Yes           |
| Safari (all versions) | **Not supported**      | `false`               | **No**        |
| Safari on iOS (all)   | **Not supported**      | `false`               | **No**        |

Source: [caniuse COEP credentialless](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)

WebKit's position on `credentialless` has been "no signal" since the feature was proposed in June 2021. There is no indication of future implementation.

## Methodology

- Analyzed caniuse browser compatibility data for COEP modes
- Reviewed WebKit bug tracker (bugs.webkit.org) for `credentialless` implementation status
- Studied `coi-serviceworker` (544 stars) — the dominant open-source solution for cross-origin isolation without server headers
- Analyzed ffmpeg.wasm's browser detection and fallback strategy
- Audited Tau's external resource loading to assess `require-corp` feasibility
- Reviewed Netlify Edge Functions API for conditional header delivery

## Findings

### Finding 1: Two COEP Modes with Different Trade-offs

| Aspect                | `require-corp`                                              | `credentialless`                             |
| --------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| Browser support       | All modern browsers (Safari 15.2+, Chrome 91+, Firefox 93+) | Chrome 96+, Firefox 119+ only                |
| SAB enabled           | Yes                                                         | Yes                                          |
| Third-party resources | Must have `CORS` or `Cross-Origin-Resource-Policy` header   | Loaded without credentials (no CORP needed)  |
| Strictness            | High — blocks non-CORS cross-origin subresources            | Low — strips credentials instead of blocking |

`credentialless` was designed to ease the adoption burden of cross-origin isolation by avoiding the need for third-party servers to send `Cross-Origin-Resource-Policy` headers. However, Safari has never implemented it, making `require-corp` the only universally supported option.

### Finding 2: Tau's External Resource Profile Supports `require-corp`

An audit of Tau's resource loading reveals that all external resources are proxied through same-origin routes:

| Resource          | External Origin                 | Same-Origin Proxy    | `require-corp` safe |
| ----------------- | ------------------------------- | -------------------- | ------------------- |
| PostHog analytics | `us.i.posthog.com`              | `/api/ph/*`          | Yes                 |
| PostHog assets    | `us-assets.i.posthog.com`       | `/api/ph/static/*`   | Yes                 |
| GitHub avatars    | `avatars.githubusercontent.com` | `/api/github-avatar` | Yes                 |
| Fonts             | Bundled (no CDN)                | N/A                  | Yes                 |
| Styles            | Bundled (Tailwind)              | N/A                  | Yes                 |

No cross-origin `<img>`, `<link>`, `<script>`, or `<iframe>` tags load external resources directly. This makes Tau an ideal candidate for `require-corp` without breaking any functionality.

### Finding 3: Browser Detection Strategies

Three approaches were identified for serving browser-appropriate COEP headers:

**A. `navigator.userAgentData.brands` (Chromium-only API)**

```typescript
const isChromium = navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium');
```

Only available in Chromium browsers — returns `undefined` in Safari and Firefox. Useful as a client-side check but not applicable to server-side header decisions.

**B. User-Agent string parsing (server-side)**

```typescript
const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
const supportsCredentialless = !isSafari;
```

Fragile but functional. Used at the server/edge layer to set response headers before the page loads.

**C. Universal `require-corp` (no detection needed)**

Since Tau's resources are all same-origin proxied, `require-corp` works in all browsers without needing browser detection. This is the simplest and most robust approach.

### Finding 4: `coi-serviceworker` Degradation Pattern

The `coi-serviceworker` project (the most popular solution for this problem) encountered the same `credentialless` vs Safari issue ([#20](https://github.com/gzuidhof/coi-serviceworker/issues/20)). Their final approach:

1. Default to `credentialless` for Chromium browsers
2. Fall back to `require-corp` for all others
3. If `require-corp` also fails (e.g., third-party resources blocked), degrade to no cross-origin isolation

Key insight from the community: browser detection via `window.chrome` or `window.netscape` is unreliable. The most robust approach uses either `navigator.userAgentData.brands` (Chromium-only) or server-side User-Agent parsing.

### Finding 5: Vite Dev Server Considerations

Vite serves resources under `/@fs/` paths which are same-origin (localhost). Under `require-corp`, all same-origin resources load without issues. The `.js.map` "access control" errors seen in Safari with `credentialless` would be resolved by switching to `require-corp`, as those sourcemap files are same-origin and don't need CORP headers.

The Vite HMR WebSocket also operates on the same origin (`ws://localhost:3000`), so `COOP: same-origin` does not affect it.

### Finding 6: Netlify Edge Functions for Production

Netlify's static `netlify.toml` headers cannot conditionally vary by browser. However, Netlify Edge Functions (Deno-based) can intercept responses and set headers dynamically:

```typescript
import type { Context } from 'netlify:edge';

export default async (request: Request, context: Context) => {
  const response = await context.next();

  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  const ua = request.headers.get('user-agent') ?? '';
  const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
  response.headers.set('Cross-Origin-Embedder-Policy', isSafari ? 'require-corp' : 'credentialless');

  return response;
};

export const config = { path: '/*' };
```

This approach adds latency (~1-5ms per request at the edge) and complexity. It is only necessary if `require-corp` cannot be used universally.

## Recommendations

| #   | Action                                                                                                                     | Priority | Effort | Impact                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------------------- |
| R1  | Switch to universal `require-corp` in both Vite plugin and Netlify                                                         | P0       | Low    | High — enables SAB in Safari immediately                                                                 |
| R2  | Keep code-level SAB fallbacks as defense-in-depth                                                                          | P0       | Done   | High — already implemented in `runtime-client.ts`, `runtime-worker-client.ts`, `file-manager.machine.ts` |
| R3  | Add `Cross-Origin-Resource-Policy: same-origin` to Vite plugin responses                                                   | P1       | Low    | Medium — ensures Vite-served resources pass CORP checks                                                  |
| R4  | If future third-party resources require `credentialless`, upgrade to browser-conditional headers via Netlify Edge Function | P2       | Medium | Medium — deferred until needed                                                                           |

### R1: Universal `require-corp` (Recommended)

Since all of Tau's external resources are same-origin proxied, `require-corp` is the simplest and most correct fix:

**Vite plugin** (`libs/vite/src/cross-origin-isolation.vite-plugin.ts`):

```typescript
const headers: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
```

**Netlify** (`apps/ui/netlify.toml`):

```toml
Cross-Origin-Embedder-Policy = "require-corp"
```

This enables `crossOriginIsolated = true` in Safari, Chrome, and Firefox — no browser detection needed.

### R2: Defense-in-Depth (Already Implemented)

The following code-level SAB fallbacks are already in place and should be preserved:

| Location                                       | Guard                                                          |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `runtime-client.ts` `connect()`                | try-catch around `new SharedArrayBuffer()` for pool allocation |
| `runtime-worker-client.ts` constructor         | try-catch around `new SharedArrayBuffer()` for signal buffer   |
| `file-manager.machine.ts` `connectWorkerActor` | try-catch around `new SharedArrayBuffer()` for content pool    |

These ensure the app works even if COEP headers are stripped by a proxy, CDN, or misconfiguration.

### R3: Add CORP Header to Vite Plugin

When using `require-corp`, the Vite dev server should also set `Cross-Origin-Resource-Policy` on its own responses to ensure resources served under `/@fs/` pass the CORP check:

```typescript
const headers: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
```

The Netlify production config already has `Cross-Origin-Resource-Policy = "same-origin"` (line 82).

### R4: Conditional Headers (Deferred)

If Tau ever needs to load third-party resources that lack CORP headers (e.g., a CDN-hosted font, external image embeds), the approach would be:

1. Use a Netlify Edge Function to serve `credentialless` for Chromium/Firefox and `require-corp` for Safari
2. Add `crossorigin="anonymous"` to affected resource tags for `require-corp` compatibility
3. Or proxy the resource through a same-origin route (preferred — matches existing pattern)

This is deferred because no such resources exist today.

## Trade-offs

| Approach                             | Safari SAB      | Third-party compat    | Complexity | Risk                                        |
| ------------------------------------ | --------------- | --------------------- | ---------- | ------------------------------------------- |
| Universal `credentialless` (current) | No SAB          | High                  | Low        | Safari broken                               |
| Universal `require-corp` (R1)        | SAB works       | Low (but Tau is safe) | Low        | Future third-party loads could break        |
| Browser-conditional (R4)             | SAB works       | High                  | Medium     | UA parsing fragility, edge function latency |
| No COEP headers                      | No SAB anywhere | Full compat           | Lowest     | No cross-origin isolation at all            |

**Verdict**: Universal `require-corp` is the correct choice for Tau given its same-origin proxy architecture.

## References

- [caniuse: COEP credentialless](https://caniuse.com/mdn-http_headers_cross-origin-embedder-policy_credentialless)
- [caniuse: SharedArrayBuffer](https://caniuse.com/sharedarraybuffer)
- [Chrome blog: COEP credentialless](https://developer.chrome.com/blog/coep-credentialless-origin-trial/)
- [web.dev: COOP/COEP guide](https://web.dev/articles/coop-coep)
- [WebKit Safari 15.2 features](https://webkit.org/blog/12140/new-webkit-features-in-safari-15-2/)
- [coi-serviceworker credentialless detection bug](https://github.com/gzuidhof/coi-serviceworker/issues/20)
- [Netlify Edge Functions API](https://docs.netlify.com/build/edge-functions/api)
- Related: `docs/research/geometry-pipeline-copy-audit.md`
- Related: `docs/research/geometry-data-transfer-architecture.md`
