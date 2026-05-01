---
title: 'Runtime Cross-Origin Isolation Distribution Strategy'
description: 'How `@taucad/runtime` should ship middleware/plugins so external consumers can enable cross-origin isolation in Vite, React Router, Node servers, edge functions, and static hosts'
status: draft
created: '2026-04-20'
updated: '2026-04-20'
category: architecture
related:
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/netlify-ui-deployment-strategy.md
  - docs/research/shared-memory-geometry-pipeline.md
  - docs/research/geometry-data-transfer-architecture.md
---

# Runtime Cross-Origin Isolation Distribution Strategy

How `@taucad/runtime` should ship middleware/plugins so external consumers (and our own apps) can enable cross-origin isolation across every realistic host topology — Vite, React Router SSR, Node servers, edge functions, and static hosts — from a single canonical header source of truth.

## Executive Summary

`@taucad/runtime` is a SAB-first runtime: file pool, geometry pool, signal-buffer abort channel, and (transitively) multi-threaded WASM kernels all need `crossOriginIsolated === true`. Today every consumer must independently figure out COOP/COEP/CORP, learn that Vite's `server.headers` doesn't cover all responses, that Netlify's `[[headers]]` doesn't cover SSR, that Safari needs `require-corp` (not `credentialless`), and that their backend API needs CORP `cross-origin`. There is no shared library code that captures these invariants — only a single internal `@taucad/vite/cross-origin-isolation` plugin (Vite-only) and prose in `safari-cross-origin-isolation.md`.

The recommended architecture is a thin, layered set of exports:

1. **One canonical headers module** in `@taucad/runtime` (`@taucad/runtime/cross-origin-isolation`) that owns the header set and a runtime-side capability check.
2. **Adapter sub-paths** that wrap the canonical headers in idiomatic forms for each layer: a React Router `entry.server` helper, an Express/Fastify/Hono `apply` helper, an edge-function `Response` wrapper, and a service-worker fallback file.
3. **Keep the existing `@taucad/vite/cross-origin-isolation` Vite plugin** (build-time / dev concern) but reimplement it as a thin re-export of the canonical headers from `@taucad/runtime`.

This keeps `@taucad/runtime` framework-agnostic while giving every consumer a one-liner per layer. There is no auto-magic — consumers still wire it up — but they no longer hand-roll header tables, mis-spell `require-corp`, or accidentally drift between dev and prod.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
- [Recommended Distribution Surface](#recommended-distribution-surface)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [Diagrams](#diagrams)
- [Recommendations](#recommendations)
- [Scope and Non-Goals](#scope-and-non-goals)
- [References](#references)

## Problem Statement

Two questions from `chat-editor-dockview` debugging keep recurring:

1. **Is COI header injection achievable through "middleware of a kind"?** — across React Router SSR, Node API servers, Vite dev, edge functions, static hosts, and the browser itself.
2. **How do we make the solution shareable with consumers of `@taucad/runtime`?** — i.e. what new exports should `@taucad/runtime` (and adjacent packages) ship so a third-party app can adopt the runtime without re-discovering every footgun.

Today the situation is:

- `apps/ui` uses `@taucad/vite/cross-origin-isolation` for dev (`apps/ui/vite.config.ts:15`) — works.
- `apps/ui` relies on `apps/ui/netlify.toml` `[[headers]]` for prod — **does not cover SSR HTML**, only static assets.
- `apps/ui/app/machines/file-manager.machine.ts` and `packages/runtime/src/client/runtime-client.ts:633` swallow the SAB error silently.
- An external consumer of `@taucad/runtime` has no shared helper. They must read `safari-cross-origin-isolation.md` (if they even find it), hand-roll headers across layers, and gamble that they got Safari right.

The cost of not solving this:

- Silent perf cliffs — file pool/geometry pool are off, the user only sees "the runtime feels slower"; no error.
- Each new consumer (CLI, future SDK, partner integrations, docs site, demos) reinvents the same five header strings.
- Existing internal apps drift — `netlify.toml` and the Vite plugin already disagreed about which COEP mode to use until R1 in `safari-cross-origin-isolation.md` aligned them.

## Methodology

- Read the current `@taucad/vite` package surface and existing `cross-origin-isolation.vite-plugin.ts`.
- Audited `packages/runtime/src` for every site that touches `SharedArrayBuffer` to confirm the runtime is genuinely the consumer of these headers (not just incidentally).
- Web-searched the canonical patterns for COI in Vite (`server.headers`, `configureServer` middleware), Remix/React Router v7 (`entry.server.tsx` + `handleRequest`, route `headers()`, the new pre-stable `v8_middleware`), and static-host fallbacks (`coi-serviceworker`, `mini-coi`).
- Cross-checked the existing `safari-cross-origin-isolation.md` research for the agreed canonical header set (universal `require-corp`, `same-origin` COOP, `same-origin` CORP).
- Listed every layer where the header **must** appear for `crossOriginIsolated` to flip to `true`, then asked: which package owns each layer in our codebase?

## Findings

### Finding 1: COI is a multi-layer requirement, not a single header

For `crossOriginIsolated === true` to hold in the browser, the **document response** AND **every cross-origin subresource** must cooperate. The list of layers a runtime consumer must touch:

| #   | Layer                     | What it serves                      | Who owns the header in Tau today                  |
| --- | ------------------------- | ----------------------------------- | ------------------------------------------------- |
| L1  | App dev server (Vite)     | HTML + module graph in dev          | `@taucad/vite/cross-origin-isolation` ✅          |
| L2  | App SSR runtime           | Production HTML doc                 | **Nothing** — `netlify.toml` doesn't cover it ❌  |
| L3  | App static asset CDN      | JS, WASM, fonts, images             | `apps/ui/netlify.toml` `[[headers]]` ✅           |
| L4  | API server (cross-origin) | XHR/WS responses; needs CORP        | `apps/api/app/main.ts` `helmet` config ✅         |
| L5  | Third-party subresources  | CDN images, scripts, fonts          | N/A — Tau proxies all of them                     |
| L6  | Service worker (fallback) | Static hosts that can't set headers | **Nothing** — no SW shipped                       |
| L7  | Browser runtime check     | Detect if SAB is actually usable    | Try/catch around `new SharedArrayBuffer()` ✅     |
| L8  | Edge function (optional)  | Browser-conditional COEP if needed  | Not used — universal `require-corp` is sufficient |

`@taucad/runtime` consumers care about L1-L4, L6-L7. Each is a different "middleware" surface, but the data is the same three headers. **The answer to "is it achievable with middleware?" is yes — at every layer except L3 (static CDN), which is config not code.**

### Finding 2: "Middleware" means different things in different layers

The word "middleware" is overloaded. To answer the user's question properly, it helps to enumerate what exists at each layer:

| Layer            | "Middleware" form                                                                    | Universally available?                                         |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Vite dev/preview | `configureServer(server)` → `server.middlewares.use(fn)`                             | Yes, stable                                                    |
| Vite dev/preview | `server.headers: { ... }` config option                                              | Yes, but doesn't cover responses produced by framework plugins |
| React Router v7  | `entry.server.tsx` `handleRequest()` mutation of `responseHeaders`                   | Yes, stable, **the canonical place for global SSR headers**    |
| React Router v7  | Route `headers()` export                                                             | Per-route only; not global; overridden by `entry.server`       |
| React Router v7  | `future.v8_middleware` `unstable_setHeader`                                          | Pre-stable as of 7.x; flagged out                              |
| Node servers     | Express `app.use((req,res,next) => …)` / Fastify `addHook` / Hono `app.use(c, next)` | Yes — all map cleanly to a header-setter callback              |
| Edge functions   | Netlify/Vercel/Cloudflare `Response` wrapping                                        | Yes, framework-specific signatures                             |
| Static hosts     | Service worker `fetch` listener that synthesises a new `Response`                    | Yes — `coi-serviceworker` / `mini-coi` are the standard        |
| Hosting config   | `_headers`, `netlify.toml`, `vercel.json` static rules                               | Yes, but text not code                                         |

Every one of these reduces to: _"add this `Record<string, string>` to the response headers"_. Which means a single canonical headers source can drive every adapter — they differ only in signature shape.

### Finding 3: `@taucad/runtime` already ships middleware-shaped APIs — but not for headers

The runtime has a mature middleware concept already (`./middleware/runtime-middleware`, `./middleware/parameter-cache`, `./middleware/geometry-cache`, etc.) — these are runtime _render-pipeline_ middleware, not HTTP middleware. The export naming is therefore a slight collision, but the precedent (sub-path exports, narrow surface per export) is exactly the model we want.

`@taucad/vite` already follows the sub-path adapter pattern (`./cross-origin-isolation`, `./ts-module-url`, `./base64-loader`, etc.). It is the right home for the Vite plugin. The current plugin (`libs/vite/src/cross-origin-isolation.vite-plugin.ts`) hard-codes the headers — this is the duplication we want to eliminate.

### Finding 4: One canonical header set, three real variants

`safari-cross-origin-isolation.md` settled the policy debate:

```typescript
{
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}
```

But adapters need three subtly different variants:

| Variant              | Used by                                              | Difference                                                                             |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `documentHeaders`    | App SSR, Vite dev, static `_headers`, edge functions | All three: COOP + COEP + CORP `same-origin`                                            |
| `apiHeaders`         | Cross-origin API (Tau API, future microservices)     | CORP `cross-origin` only — must NOT set COEP `require-corp` on responses to other apps |
| `subresourceHeaders` | Same-origin assets (images served by API, etc.)      | CORP `same-origin` (or `cross-origin` if served to a different app origin)             |

The single source of truth must distinguish these. A naive single `coiHeaders` constant has already caused regressions (the Tau API helmet config had the wrong CORP value at one point — see the parent thread).

### Finding 5: Every adapter is < 30 lines

The full adapter surface, sketched:

| Adapter                             | Wrapper                                                      | LOC          |
| ----------------------------------- | ------------------------------------------------------------ | ------------ |
| Vite dev/preview                    | `configureServer` + `configurePreviewServer` middleware      | ~25          |
| React Router `entry.server.tsx`     | `applyDocumentHeaders(responseHeaders)` Headers mutator      | ~10          |
| React Router v8 middleware (future) | `coiMiddleware` middleware function calling `setHeader`      | ~12          |
| Express                             | `(req, res, next) => { applyDocumentHeaders(res); next(); }` | ~10          |
| Fastify                             | `onSend` hook setting headers                                | ~12          |
| Hono                                | `c.header(...)` middleware                                   | ~10          |
| Netlify Edge                        | Wrap `await context.next()` and mutate `response.headers`    | ~14          |
| Cloudflare Worker / Vercel Edge     | Wrap `Response` in a `new Response(body, { headers })`       | ~14          |
| Service worker (static fallback)    | Ship `coi-serviceworker.js` as a copy-able asset             | ~80 (vendor) |

The total cost of providing a complete adapter set is small enough that "ship them all from `@taucad/runtime`" is realistic — but only the most reused ones need to live in the runtime; tail-end adapters can live in docs.

### Finding 6: The runtime can do its own capability check

The runtime already swallows the SAB error silently at `runtime-client.ts:633`. A small public helper would let consumers — and our own DevTools panel — surface the degradation:

```typescript
export function inspectCrossOriginIsolation(): {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  reason?: 'no-secure-context' | 'no-coep' | 'no-sab-constructor';
};
```

Today, the only way a consumer learns the runtime is degraded is by reading the console. That is unacceptable for an external SDK. A typed helper closes this gap and gives consumers a programmatic path to show their own warning UI.

### Finding 7: Service-worker fallback is genuinely useful for runtime consumers

External consumers may be deploying to GitHub Pages, S3 + CloudFront with no edge function, internal corp networks behind a CDN they can't configure, etc. `coi-serviceworker` (gzuidhof, 546 stars) and `mini-coi` (WebReflection, last push Dec 2025) are the standard fallbacks. They're MIT-licensed and small enough to vendor. Shipping `coi-serviceworker.js` from `@taucad/runtime` (with a thin auto-register helper) would unlock a real class of consumers we can't reach today.

The constraints (must be served same-origin, must be in a separate file, must register as the first script) are honest limitations to document — the runtime cannot magically work around them, but it can vendor the file and ship documentation.

### Finding 8: Tau's existing structure already partitions concerns correctly

Looking at the package boundaries:

- `@taucad/runtime` — framework-agnostic CAD runtime, browser + Node. **Knows it needs SAB.**
- `@taucad/vite` — build-time integrations for Vite users. **Already owns dev-server header injection.**
- `apps/ui` — one specific consumer.
- `apps/api` — one specific server (uses helmet directly, fine).

The architectural answer that respects this is: **`@taucad/runtime` owns the canonical header data and runtime checks; `@taucad/vite` consumes it**. The Vite plugin shouldn't move into `@taucad/runtime` — Vite is build-time, runtime is run-time.

For other framework adapters (React Router, Express, Hono, Fastify, edge): they belong in `@taucad/runtime` sub-path exports, because there is no separate `@taucad/react-router` package today and creating one per framework just for COI is overkill. The peer-dependency surface is zero — every adapter is a pure function that takes a `Headers` or `Record<string, string>`.

## Recommended Distribution Surface

The proposed surface has three tiers, ordered by how much each consumer needs:

### Tier 1: Canonical data + runtime check (everyone uses this)

`@taucad/runtime/cross-origin-isolation` — new sub-path export. Pure, no framework deps.

```typescript
// Header sets, by audience
export const documentHeaders: Readonly<Record<string, string>>;
export const apiHeaders: Readonly<Record<string, string>>; // CORP cross-origin only
export const subresourceHeaders: Readonly<Record<string, string>>;

// Universal mutator — works against any Headers instance OR a Record<string, string>
export function applyDocumentHeaders(target: Headers | Record<string, string>): void;
export function applyApiHeaders(target: Headers | Record<string, string>): void;

// Runtime capability check — consumers can branch UI on this
export function inspectCrossOriginIsolation(): IsolationStatus;

// Constants for static-host config files (consumers paste into _headers / netlify.toml / vercel.json)
export const documentHeaderEntries: ReadonlyArray<[string, string]>;
```

This single module replaces every hand-rolled header table in the workspace — including the constants currently inlined in `cross-origin-isolation.vite-plugin.ts:14-18` and the helmet config in `apps/api/app/main.ts:77-79`.

### Tier 2: Framework adapters (idiomatic per layer)

Each adapter is a < 30 LOC sub-path export that imports from Tier 1:

| Sub-path                                              | Purpose                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@taucad/vite/cross-origin-isolation` (existing)      | Vite dev/preview plugin (already shipped; reimplement on Tier 1)                 |
| `@taucad/runtime/cross-origin-isolation/react-router` | `applyHandleRequestHeaders(responseHeaders)` for `entry.server.tsx`              |
| `@taucad/runtime/cross-origin-isolation/express`      | `coiMiddleware()` — Connect/Express compatible                                   |
| `@taucad/runtime/cross-origin-isolation/fastify`      | `coiPlugin` — Fastify plugin (`fastifyPlugin(...)`)                              |
| `@taucad/runtime/cross-origin-isolation/hono`         | `coiMiddleware()` — Hono `MiddlewareHandler`                                     |
| `@taucad/runtime/cross-origin-isolation/edge`         | `withCrossOriginIsolation(handler)` — wraps any `(Request) => Promise<Response>` |

The `react-router` adapter is the most important because that's what Tau itself needs. Express/Fastify/Hono/Edge are bonus: they're cheap to ship and unblock the API-side and edge-side of the consumer's deployment.

### Tier 3: Service-worker fallback (static-host consumers)

`@taucad/runtime/cross-origin-isolation/sw` — vendored `coi-serviceworker.js` as a string export, plus an auto-register helper:

```typescript
export const serviceWorkerSource: string; // raw JS, ready to write to disk
export function registerCoiServiceWorker(options?: { path?: string }): Promise<ServiceWorkerRegistration | undefined>;
```

Consumers either bundle the script via their build system (Vite plugin can copy it, or an `npm postinstall` hook), or call the register helper from their app entry. This unlocks GitHub Pages, S3, etc.

## Trade-offs

### Should the Vite plugin move into `@taucad/runtime`?

| Option                                                  | Pros                                                                                                                                                                         | Cons                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Keep in `@taucad/vite`, re-export Tier 1                | Clean concern split (build-time vs run-time); consumers already importing `@taucad/vite` for other plugins get COI alongside; `vite` peer-dep stays out of `@taucad/runtime` | Two packages must be installed for a Vite consumer; the canonical header set lives in one repo but is consumed in another |
| Move into `@taucad/runtime/cross-origin-isolation/vite` | One install for Vite consumers                                                                                                                                               | `@taucad/runtime` grows a `vite` peer dependency; concern split blurs                                                     |

**Verdict**: keep in `@taucad/vite`, reimplement on top of Tier 1. The concern split is more valuable than saving one install.

### Single `coiHeaders` vs `documentHeaders` / `apiHeaders` / `subresourceHeaders`

| Option                       | Pros                              | Cons                                                                                            |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Single `coiHeaders` constant | Simplest                          | API/asset responses must NOT have `same-origin` CORP — silent breakage when someone copy-pastes |
| Three named header sets      | Each consumer picks the right one | Three names to learn                                                                            |

**Verdict**: three named sets. The single-constant approach already misled the API helmet config once. Names are a forcing function for "is this a doc, an API response, or a same-origin asset?".

### Auto-detect Safari vs universal `require-corp`

`safari-cross-origin-isolation.md` already concluded universal `require-corp` works for Tau. For external consumers who load third-party CDN resources without CORP, auto-detection (Netlify Edge / UA parsing) might be needed. **Out of scope** for the runtime — consumers in that situation can bring their own edge function. The runtime ships `require-corp` only and documents the trade-off.

### Should `@taucad/runtime` auto-register the service worker on import?

| Option             | Pros                          | Cons                                                                         |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| Auto-register      | Zero-config in the happy path | Side effect on import; clashes with other SWs; opaque magic; can break tests |
| Opt-in helper call | Explicit, debuggable          | Consumers must remember to call it                                           |

**Verdict**: opt-in. The runtime should never auto-register a service worker — too many ways to surprise the consumer.

### React Router v8 `unstable_setHeader` middleware

| Option                                | Pros                   | Cons                                                                  |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Ship a v8 middleware adapter          | Forward-looking        | Pre-stable; gated behind `future.v8_middleware`; signature can change |
| Stick with `entry.server.tsx` adapter | Stable since Remix 1.x | Doesn't compose with route-level header logic                         |

**Verdict**: ship the `entry.server.tsx` adapter now. Add a v8 middleware adapter when the flag stabilises.

## Code Examples

### The canonical module (Tier 1)

```typescript
// packages/runtime/src/cross-origin-isolation/index.ts
const COOP_SAME_ORIGIN = 'Cross-Origin-Opener-Policy';
const COEP_REQUIRE_CORP = 'Cross-Origin-Embedder-Policy';
const CORP = 'Cross-Origin-Resource-Policy';

export const documentHeaders: Readonly<Record<string, string>> = Object.freeze({
  [COOP_SAME_ORIGIN]: 'same-origin',
  [COEP_REQUIRE_CORP]: 'require-corp',
  [CORP]: 'same-origin',
});

export const apiHeaders: Readonly<Record<string, string>> = Object.freeze({
  [CORP]: 'cross-origin',
});

export const subresourceHeaders: Readonly<Record<string, string>> = Object.freeze({
  [CORP]: 'same-origin',
});

export const documentHeaderEntries = Object.freeze(Object.entries(documentHeaders));

export function applyDocumentHeaders(target: Headers | Record<string, string>): void {
  applyTo(target, documentHeaders);
}

export function applyApiHeaders(target: Headers | Record<string, string>): void {
  applyTo(target, apiHeaders);
}

export type IsolationStatus =
  | { crossOriginIsolated: true; sharedArrayBuffer: true }
  | { crossOriginIsolated: false; sharedArrayBuffer: boolean; reason: IsolationFailure };

export function inspectCrossOriginIsolation(): IsolationStatus {
  /* … */
}

function applyTo(target: Headers | Record<string, string>, headers: Record<string, string>): void {
  if (target instanceof Headers) {
    for (const [name, value] of Object.entries(headers)) target.set(name, value);
    return;
  }
  Object.assign(target, headers);
}
```

### Vite adapter (re-implements existing plugin on Tier 1)

```typescript
// libs/vite/src/cross-origin-isolation.vite-plugin.ts (proposed reimplementation)
import { documentHeaders } from '@taucad/runtime/cross-origin-isolation';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

export function crossOriginIsolation(): Plugin {
  function applyHeaders(server: ViteDevServer | PreviewServer): void {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(documentHeaders)) res.setHeader(name, value);
      next();
    });
  }
  return {
    name: 'vite:cross-origin-isolation',
    configureServer: applyHeaders,
    configurePreviewServer: applyHeaders,
  };
}
```

### React Router adapter (Tier 2)

```typescript
// packages/runtime/src/cross-origin-isolation/react-router.ts
import { applyDocumentHeaders } from './index.js';

export function applyHandleRequestHeaders(responseHeaders: Headers): void {
  applyDocumentHeaders(responseHeaders);
}
```

Consumer usage in `apps/ui/app/entry.server.tsx`:

```typescript
import { applyHandleRequestHeaders } from '@taucad/runtime/cross-origin-isolation/react-router';

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  applyHandleRequestHeaders(responseHeaders);
  // … existing renderToReadableStream / renderToPipeableStream flow
}
```

### Express adapter (Tier 2)

```typescript
// packages/runtime/src/cross-origin-isolation/express.ts
import type { NextFunction, Request, Response } from 'express';
import { documentHeaders } from './index.js';

export function coiMiddleware() {
  return (_req: Request, res: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(documentHeaders)) res.setHeader(name, value);
    next();
  };
}
```

### Edge function adapter (Tier 2)

```typescript
// packages/runtime/src/cross-origin-isolation/edge.ts
import { documentHeaders } from './index.js';

export function withCrossOriginIsolation<T extends (req: Request) => Promise<Response>>(handler: T): T {
  return (async (req: Request) => {
    const response = await handler(req);
    for (const [name, value] of Object.entries(documentHeaders)) response.headers.set(name, value);
    return response;
  }) as T;
}
```

### Service worker fallback (Tier 3)

```typescript
// packages/runtime/src/cross-origin-isolation/sw.ts
import coiServiceWorkerSource from './coi-serviceworker.js?raw'; // bundler-imported

export { coiServiceWorkerSource };

export async function registerCoiServiceWorker(options: { path?: string } = {}) {
  if (!('serviceWorker' in navigator) || self.crossOriginIsolated) return undefined;
  return navigator.serviceWorker.register(options.path ?? '/coi-serviceworker.js');
}
```

## Diagrams

### Layered header injection responsibility

```
                          ┌──────────────────────────────────────────────┐
                          │   @taucad/runtime/cross-origin-isolation     │
                          │   documentHeaders | apiHeaders | apply…()    │
                          │   inspectCrossOriginIsolation()              │
                          └─────────────────────┬────────────────────────┘
                                                │ depends on
                ┌────────────┬───────────┬──────┼─────────┬───────────┬───────────┐
                ▼            ▼           ▼      ▼         ▼           ▼           ▼
       @taucad/vite/coi   /react-router  /express  /fastify   /hono     /edge       /sw
       (dev/preview)       (entry.server) (Connect) (plugin)   (Hono)    (Cloudflare/   (static
                                                                          Vercel/Netlify) hosts)
                │            │           │      │         │           │           │
                ▼            ▼           ▼      ▼         ▼           ▼           ▼
              L1           L2          L4    L4        L4           L8         L6
             dev          SSR          API   API        API          edge        SW
```

### Where Tau's apps land today vs proposed

```
  apps/ui ──────► Vite plugin (L1) ─── ✅ already on @taucad/vite/coi
                    │
                    ├─ entry.server.tsx (L2) ─── ❌ TODO: use new react-router adapter
                    │
                    └─ Netlify _headers (L3) ─── ✅ static-asset CORP via netlify.toml

  apps/api ─────► Fastify + helmet (L4) ─── ⚠ helmet is fine but headers
                                              are hand-rolled; switch to apiHeaders
                                              from canonical module to prevent drift
```

## Recommendations

| #   | Action                                                                                                                                                                  | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `@taucad/runtime/cross-origin-isolation` (Tier 1: headers + apply + inspect)                                                                                        | P0       | Low    | High   |
| R2  | Reimplement `@taucad/vite/cross-origin-isolation` on top of Tier 1 (eliminate duplication)                                                                              | P0       | Low    | High   |
| R3  | Add `@taucad/runtime/cross-origin-isolation/react-router` adapter and adopt in `apps/ui`                                                                                | P0       | Low    | High   |
| R4  | Migrate `apps/api` helmet `crossOriginResourcePolicy` to import from `apiHeaders`                                                                                       | P1       | Low    | Medium |
| R5  | Add Express / Fastify / Hono / Edge adapters (Tier 2)                                                                                                                   | P1       | Low    | Medium |
| R6  | Vendor `coi-serviceworker.js` and ship as `@taucad/runtime/cross-origin-isolation/sw` (Tier 3)                                                                          | P2       | Low    | Medium |
| R7  | Document the surface in `apps/ui/content/docs/(runtime)/` with a copy-paste recipe per layer                                                                            | P1       | Medium | High   |
| R8  | Add a startup smoke test: if `@taucad/runtime` boots with `crossOriginIsolated === false`, log a single structured warning with `inspectCrossOriginIsolation()` payload | P2       | Low    | Medium |

### R1 — Tier 1 module

Smallest surface, biggest payoff. Once it exists, every other adapter is < 30 LOC and the existing Vite plugin loses its hand-rolled constants.

### R2 — Reimplement Vite plugin on Tier 1

Pure refactor; behaviour identical. Eliminates duplication and proves the canonical module survives a real consumer.

### R3 — React Router adapter + entry.server adoption

Closes the L2 gap that broke staging UI in the first place. The adapter is ten lines; the `entry.server.tsx` change is roughly ten more.

### R4 — API helmet alignment

The Tau API hand-rolls `crossOriginResourcePolicy: { policy: 'cross-origin' }` in `main.ts:77-79`. Importing `apiHeaders.['Cross-Origin-Resource-Policy']` from the runtime canonicalises the value and prevents future drift.

### R5 — Other framework adapters

Cheap to ship; unlocks external consumers running Express/Fastify/Hono backends or Cloudflare/Vercel edge functions. Each is a < 30 LOC file with one test.

### R6 — Service worker fallback

Vendor `coi-serviceworker.js` (MIT, by gzuidhof) into the package. Ship it as a `?raw` import string plus a small `register()` helper. Consumers on GitHub Pages / S3 can adopt the runtime without server-side header control.

### R7 — Docs

The runtime docs site already has `(runtime)/` and `(editor)/` sections. Add a "Cross-origin isolation" page with a recipe per layer, including the static-host fallback. The Tier 1 + Tier 2 adapters are the surface; the docs are how consumers find them.

### R8 — Boot-time visibility

Today the runtime swallows SAB failure silently. After R1, log a single structured warning at boot when `crossOriginIsolated === false` so consumers in dev see the degradation in their console without us having to write a separate doc page.

## Scope and Non-Goals

**In scope**: distribution of COI header injection across `@taucad/runtime` consumers, package surface design, adapter shapes, runtime capability check, fallback strategy.

**Out of scope**:

- Browser-conditional header logic (`safari-cross-origin-isolation.md` already concluded universal `require-corp` works for Tau and any consumer with the same proxy posture; consumers with different needs can ship their own edge function).
- The internals of `SharedArrayBuffer`-backed runtime features (covered by `shared-memory-geometry-pipeline.md`).
- Fixing the API crash loop (`Dockerfile` `NODE_OPTIONS` issue) — separate concern.
- The Netlify SSR header gap closure plan — that's the consumer of R3, not a separate piece of work.

## References

- Existing canonical research: `docs/research/safari-cross-origin-isolation.md`
- Existing Netlify deployment context: `docs/research/netlify-ui-deployment-strategy.md`
- Runtime SAB consumers: `packages/runtime/src/client/runtime-client.ts:158-228`, `packages/runtime/src/framework/runtime-worker-client.ts:200-203`, `apps/ui/app/machines/file-manager.machine.ts`
- Existing Vite plugin: `libs/vite/src/cross-origin-isolation.vite-plugin.ts`
- API helmet config: `apps/api/app/main.ts:77-79`
- [web.dev: Cross-origin isolation with COOP/COEP](https://web.dev/articles/coop-coep)
- [Vite issue #3909 — COOP/COEP on dev server](https://github.com/vitejs/vite/issues/3909)
- [Remix `entry.server.tsx` docs (applies to React Router v7)](https://remix.run/docs/file-conventions/entry.server)
- [`@nichtsam/helmet` — symmetric helmet for Web Fetch / Remix / React Router](https://github.com/nichtsam/helmet) (alternative to a hand-rolled adapter)
- [`coi-serviceworker` — MIT, the standard static-host fallback](https://github.com/gzuidhof/coi-serviceworker)
- [`mini-coi` — minimalist alternative, last push Dec 2025](https://github.com/WebReflection/mini-coi)
