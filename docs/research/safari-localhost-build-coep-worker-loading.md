---
title: 'Safari Worker COEP Block on `react-router-serve` Localhost Build'
description: 'Built UI on localhost:3000 (react-router-serve) blank-loads in Safari: express.static mounts ship worker scripts without Cross-Origin-Resource-Policy, and WebKit refuses workers without explicit CORP under require-corp where Chromium passes same-origin implicitly.'
status: active
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/runtime-cross-origin-isolation-distribution.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
---

# Safari Worker COEP Block on `react-router-serve` Localhost Build

Root-cause investigation: when serving the built `apps/ui` bundle locally with `react-router-serve build/server/index.js` on `http://localhost:3000`, Safari renders the homepage shell but stalls in the eternal "loading" state because `FileManagerWorker` and `ObjectStoreWorker` fail to instantiate. Chrome works. The browser console reports `Refused to load '/assets/file-manager.worker-XXX.js' worker because of Cross-Origin-Embedder-Policy`. This document identifies the smoking gun, explains why Chrome silently tolerates the same misconfiguration, and lists the concrete requirements to fix the localhost build (and the broader gap in our prod-parity story).

## Implementation Status (2026-04-23)

| Recommendation | Status                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1             | ✅ RESOLVED — `coiMiddleware()` shipped at `packages/runtime/src/cross-origin-isolation/express.ts` with parity tests against `documentHeaders`.                        |
| R2             | ✅ RESOLVED — `apps/ui/server.ts` boots Express via `@react-router/express` + `coiMiddleware()`; `apps/ui/project.json` `serve` runs it.                                |
| R3             | ✅ RESOLVED — `apps/ui/server.test.ts` boots the bootstrap on an ephemeral port and asserts COOP+COEP+CORP on `/`, `/assets/*.worker-*.js`, `/draco_decoder_gltf.wasm`. |
| R4             | ✅ RESOLVED — `apps/ui/content/docs/(runtime)/guides/cross-origin-isolation.mdx` documents the four hosting topologies (Vite, RR SSR, Express, static host).            |
| R5             | ⏸ DEFERRED — Fastify, Hono, Edge adapters are out of scope per Express-only request; tracked in `docs/research/runtime-cross-origin-isolation-distribution.md`.         |
| R6             | ✅ RESOLVED — `RuntimeClient` boot warning lives at `packages/runtime/src/client/runtime-client.ts` with regression coverage in `runtime-client-coi-warning.test.ts`.   |
| R7             | ❌ SUPERSEDED — Migrated to `@react-router/express` per the official React Router migration path, eliminating the need to fork or patch `react-router-serve`.           |

## Executive Summary

The SSR HTML response served by `react-router-serve` carries the canonical cross-origin isolation header set (`Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`) because `apps/ui/app/entry.server.tsx` calls `applyHandleRequestHeaders(responseHeaders)`. **But `react-router-serve` mounts three separate `express.static` middlewares for `build/client/assets/*`, the rest of `build/client/`, and the `public/` directory _before_ delegating to React Router, and none of them set `Cross-Origin-Resource-Policy` on the response.** Curl proves it: the document gets all three headers, every asset gets none.

Safari's WebKit refuses to start a worker whose script response lacks `Cross-Origin-Resource-Policy` whenever the embedder is `require-corp`, even when the script is same-origin (the spec says same-origin should pass implicitly; WebKit requires the explicit CORP header — see WebKit bug 245346 and the predr.ag write-up cited in this incident's scenario by another developer). Chromium and Firefox honour the implicit-same-origin rule and load the worker without complaint, which is exactly why the bug only manifests on Safari and why production (Netlify) is unaffected — Netlify's `[[headers]] for = "/*"` block applies CORP `same-origin` to every response uniformly.

`apps/ui/build/client/assets/` contains 28 worker bundles plus the OCJS / Manifold / Draco / assimp WASM artefacts; none of them are reachable in Safari today. The `public/` tree is in the same boat — `draco_decoder_gltf.wasm`, `entry.worker.js`, fonts, and the textures used by the viewer all fail.

The fix is twofold: (1) close the missing-middleware gap so every static-asset response carries `Cross-Origin-Resource-Policy: same-origin` when running under `react-router-serve`, and (2) ship that as a first-party adapter from `@taucad/runtime` so external consumers and our own `react-router-serve`-style hosting topologies inherit the right headers without re-discovering the gap. The Vite dev plugin and the React Router SSR adapter both already exist; the missing piece is a Node/Express asset-CORP middleware (Tier 2 R5 in `runtime-cross-origin-isolation-distribution.md`).

## Problem Statement

User reports a blank-loading Safari window when viewing `http://localhost:3000`, served from `cd apps/ui && react-router-serve build/server/index.js` (i.e. the **built** UI, not Vite dev). Chrome on the same machine renders correctly. The Safari Web Inspector console shows the following sequence:

```text
[Debug] [BuildManager] state → initializing
[Debug] [BuildManager] state → creatingWorker
[Debug] [BuildManager] initializeWorkerActor: start
[Debug] [BuildManager] initializeWorkerActor: success
[Debug] [FileManager] connectWorkerActor: start +504ms
[Debug] [FileManager] worker created +0.2ms
[Debug] [BuildManager] state → ready

[Error] Refused to load 'http://localhost:3000/assets/file-manager.worker-BPQjkaOu.js'
        worker because of Cross-Origin-Embedder-Policy.
[Error] Worker load was blocked by Cross-Origin-Embedder-Policy
[Error] Cannot load http://localhost:3000/assets/file-manager.worker-BPQjkaOu.js
        due to access control checks.
[Error] Failed to load resource: Worker load was blocked by Cross-Origin-Embedder-Policy
        (file-manager.worker-BPQjkaOu.js, line 0)

[Error] Refused to load 'http://localhost:3000/assets/object-store.worker-BuCWpTnR.js'
        worker because of Cross-Origin-Embedder-Policy.
[Error] Worker load was blocked by Cross-Origin-Embedder-Policy
[Error] Cannot load http://localhost:3000/assets/object-store.worker-BuCWpTnR.js
        due to access control checks.

[Error] [FileManager] worker error: (2)
        "Worker script failed to load (likely 404 served as HTML, COEP/CORP block,
         MIME-type mismatch, or SyntaxError before module evaluation). …"
[Error] [FileManager] state → error
```

Plus the (benign — see Finding 9 of `staging-cors-coep-safari-rendering-audit.md`):

```text
[Error] Not allowed to load local resource: blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map
```

The eternal-loading screen in the user's screenshot is the FM machine sitting in `error` state with no further progress. The Safari error message (`Worker load was blocked by Cross-Origin-Embedder-Policy`) is the canonical WebKit phrasing for the COEP-on-worker-script enforcement path.

## Methodology

| Tool                                                                                                 | Purpose                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Read of `apps/ui/app/entry.server.tsx`                                                               | Confirm SSR HTML applies `applyHandleRequestHeaders` (COEP + CORP + COOP)                                                 |
| Read of `packages/runtime/src/cross-origin-isolation/index.ts`                                       | Confirm canonical header set                                                                                              |
| Read of `packages/runtime/src/react-router/index.ts`                                                 | Confirm `applyHandleRequestHeaders` only mutates the SSR `Headers`                                                        |
| Read of `packages/runtime/src/vite/index.ts`                                                         | Confirm the Vite plugin uses `configureServer` middleware (covers all Vite responses)                                     |
| Read of `node_modules/.pnpm/@react-router+serve@7.12.0_*/dist/cli.js`                                | Confirm `react-router-serve` mounts `express.static` _before_ React Router and never sets CORP                            |
| `cat apps/ui/project.json`                                                                           | Confirm `serve` target is `react-router-serve build/server/index.js`                                                      |
| `PORT=3001 npx react-router-serve build/server/index.js` + `curl -sI`                                | Live evidence: HTML carries COEP/COOP/CORP; `/assets/*` carries none; `public/*` carries none                             |
| Read of `apps/ui/netlify.toml`                                                                       | Confirm production sets `[[headers]] for = "/*"` so the bug does not exist on Netlify                                     |
| WebKit bug 245346, MDN COEP reference, predr.ag's "Debugging Safari" write-up                        | Confirm WebKit requires explicit CORP on worker scripts under `require-corp` while Chromium passes same-origin implicitly |
| Cross-reference with `docs/research/runtime-cross-origin-isolation-distribution.md` Findings 1, 4, 8 | Confirm this layer (L2-static-asset / Express middleware) was already identified as a gap (R5)                            |

## Findings

### Finding 1: SSR document carries the full COI header set; static assets carry none

Live `curl` against a freshly-started `react-router-serve` on port 3001 (same code path Nx uses for `pnpm nx serve ui`):

```text
$ curl -sI http://localhost:3001/
HTTP/1.1 200 OK
cross-origin-embedder-policy: require-corp
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
Date: …

$ curl -sI http://localhost:3001/assets/file-manager.worker-BPQjkaOu.js
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: public, max-age=31536000, immutable
Content-Type: application/javascript; charset=UTF-8
Content-Length: 58275
                                ← NO cross-origin-embedder-policy
                                ← NO cross-origin-resource-policy
                                ← NO cross-origin-opener-policy

$ curl -sI http://localhost:3001/assets/assimpjs-all-rMyuPSGP.wasm
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
Content-Type: application/wasm
                                ← (same — no COI headers)

$ curl -sI http://localhost:3001/draco_decoder_gltf.wasm
HTTP/1.1 200 OK
Cache-Control: public, max-age=0
Content-Type: application/wasm
                                ← (same — no COI headers)
```

The HTML response is correct. The asset responses are not. The discrepancy exists because of where each header gets applied:

| Layer                    | Code path                                                                        | Headers applied                           |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| HTML SSR response        | `apps/ui/app/entry.server.tsx` → `applyHandleRequestHeaders(responseHeaders)`    | ✅ COOP + COEP + CORP `same-origin`       |
| `/assets/*` static files | `react-router-serve`'s `express.static(.../assets, { immutable, maxAge: '1y' })` | ❌ none — only `Cache-Control` and `ETag` |
| Other `build/client/*`   | `react-router-serve`'s second `express.static(build.assetsBuildDirectory)`       | ❌ none                                   |
| `public/*` files         | `react-router-serve`'s third `express.static('public', { maxAge: '1h' })`        | ❌ none                                   |

The three `express.static` mounts run **before** React Router's request handler in `cli.js:121-129`:

```javascript
app.use(
  import_node_path.default.posix.join(build.publicPath, "assets"),
  import_express2.default.static(import_node_path.default.join(build.assetsBuildDirectory, "assets"), {
    immutable: true,
    maxAge: "1y"
  })
);
app.use(build.publicPath, import_express2.default.static(build.assetsBuildDirectory));
app.use(import_express2.default.static("public", { maxAge: "1h" }));
…
app.all("*", (0, import_node_fetch_server.createRequestListener)(build.fetch));
```

`@taucad/runtime/react-router`'s `applyHandleRequestHeaders` is only reachable through the final `app.all("*")` handler — every request that `express.static` short-circuits never sees it.

### Finding 2: The smoking gun — Safari blocks workers whose scripts lack CORP, even same-origin

Per the [HTML spec](https://html.spec.whatwg.org/multipage/origin.html#coep), when a document has `Cross-Origin-Embedder-Policy: require-corp`, every subresource fetched in `no-cors` mode must satisfy the cross-origin resource policy check. The spec says **same-origin responses pass implicitly** without needing a CORP header (the equivalent of treating same-origin as `Cross-Origin-Resource-Policy: same-origin`).

WebKit does not honour the implicit pass for **worker scripts**. Reproduced by independent investigators since 2022 ([WebKit bug 245346](https://bugs.webkit.org/show_bug.cgi?id=245346), [predr.ag — "Debugging Safari: If at first you succeed, don't try again"](https://predr.ag/blog/debugging-safari-if-at-first-you-succeed/)):

> If a worker's script is delivered without [the `Cross-Origin-Resource-Policy: same-origin`] header, the browser will refuse to start the worker:
>
> ```text
> Refused to load 'https://play.predr.ag/broken_script.js' worker because of Cross-Origin-Embedder-Policy.
> Worker load was blocked by Cross-Origin-Embedder-Policy
> Cannot load https://play.predr.ag/broken_script.js due to access control checks.
> Failed to load resource: Worker load was blocked by Cross-Origin-Embedder-Policy
> ```

Note the **byte-for-byte identical** error sequence to the user's report. The same root cause (WebKit demanding CORP on worker scripts under `require-corp`) is responsible.

| Browser                                   | COEP `require-corp`, same-origin worker script, no CORP header                                        | Outcome                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Chromium 96+ (Chrome, Edge, Brave, Opera) | Implicit same-origin pass per spec                                                                    | ✅ Worker starts                                                                      |
| Firefox 119+                              | Implicit same-origin pass per spec                                                                    | ✅ Worker starts                                                                      |
| Safari (all WebKit versions through 26.x) | Strict enforcement: requires explicit `Cross-Origin-Resource-Policy: same-origin` (or `cross-origin`) | ❌ Worker refused — `[Error] Worker load was blocked by Cross-Origin-Embedder-Policy` |

This is why Chrome works on `localhost:3000` and Safari does not: the bug exists on every browser, but only WebKit surfaces it.

The user's earlier `staging-cors-coep-safari-rendering-audit.md` (Finding 9) and `safari-cross-origin-isolation.md` already settled that Tau ships universal `require-corp` (not `credentialless`) precisely because Safari does not implement `credentialless`. That decision is correct and must not be revisited; the asset-CORP gap is a separate problem that surfaces under the `require-corp` policy we already ship.

### Finding 3: Why production (Netlify) is unaffected

`apps/ui/netlify.toml:90-107` sets:

```toml
[[headers]]
for = "/*"
[headers.values]
…
Cross-Origin-Opener-Policy = "same-origin"
Cross-Origin-Resource-Policy = "same-origin"
Cross-Origin-Embedder-Policy = "require-corp"
```

The `for = "/*"` selector matches every response Netlify serves — HTML, JS, WASM, fonts, images. There is no separate static-asset handler that bypasses the rule. Workers loaded from `https://taucad.dev/assets/file-manager.worker-XXX.js` therefore arrive with `Cross-Origin-Resource-Policy: same-origin`, Safari's strict check passes, and the worker starts.

The localhost-build path runs through `react-router-serve` instead of Netlify's edge — and `react-router-serve` has no equivalent of Netlify's `for = "/*"`. The bug is invisible in CI deploys and only surfaces when a developer (or the `pnpm nx serve ui` workflow) exercises the local production-parity path.

### Finding 4: The `public/` tree (entry.worker.js, Draco WASM, fonts) is in the same boat

`apps/ui/build/client/` after `pnpm nx build ui` contains:

```text
android-chrome-192x192.png   apple-touch-icon.png   avatar-sample.png
draco_decoder_gltf.js        draco_decoder_gltf.wasm   draco_encoder.wasm
draco_wasm_wrapper_gltf.js   entry.worker.js           favicon-96x96.png
favicon.ico                  favicon.svg               fonts/
package.json                 placeholder.svg           robot.glb
textures/                    assets/
```

Several of these are loaded by app code:

- `entry.worker.js` — a copied service-worker / web-worker artefact
- `draco_decoder_gltf.wasm` / `draco_encoder.wasm` — pulled in by the GLTF mesh decompression pipeline
- `robot.glb` and `textures/` — used by the model viewer

All of these route through `react-router-serve`'s third `express.static('public', { maxAge: '1h' })` mount, which does not set CORP. They therefore exhibit the same Safari failure mode the moment the runtime tries to fetch them. The first failure (`file-manager.worker-XXX.js`) just happens to occur first in the boot sequence, masking the others.

### Finding 5: `apps/ui/build/client/assets/` enumerates 28 worker bundles affected

```text
$ ls apps/ui/build/client/assets/ | grep -iE 'worker' | wc -l
28
```

Worker bundles in the build output include:

| Worker family              | Files                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| File system / object store | `file-manager.worker-*.js`, `object-store.worker-*.js`                                                 |
| Monaco LSP                 | `editor.worker-*.js`, `css.worker-*.js`, `html.worker-*.js`, `json.worker-*.js`, `kcl-lsp-worker-*.js` |
| Filesystem import          | `import.worker-*.js`                                                                                   |
| Three.js GLTF              | `image-bitmap-data-url-worker-*.js`                                                                    |
| Kernel runtime             | (loaded via `new URL('runtime/worker', import.meta.url)` resolution; same `assets/` directory)         |

Every one of these will be refused by Safari under `require-corp` until CORP is set on the response. The current FM-error message ("Worker script failed to load (likely 404, COEP/CORP block, MIME-type mismatch, …)") is the same text from `apps/ui/app/machines/file-manager-worker-error.ts:122-134` and is the only signal the user sees, but the underlying failure cascades across every worker the app instantiates.

### Finding 6: The runtime distribution architecture already anticipated this gap

`docs/research/runtime-cross-origin-isolation-distribution.md` Findings 1, 2, 4, 5 explicitly enumerate the layers a runtime consumer must touch to keep `crossOriginIsolated === true`:

```text
| L1 | App dev server (Vite)     | HTML + module graph in dev      | @taucad/vite/coi (now @taucad/runtime/vite) ✅
| L2 | App SSR runtime           | Production HTML doc             | @taucad/runtime/react-router ✅
| L3 | App static asset CDN      | JS, WASM, fonts, images         | apps/ui/netlify.toml [[headers]] ✅ for Netlify, ❌ for react-router-serve
| L4 | API server (cross-origin) | XHR/WS responses; needs CORP    | apps/api/app/main.ts helmet ✅
```

The L3 row is **the gap exercised by `react-router-serve`**. The recommendation table in that document already proposed an **Express adapter (R5)** to ship from `@taucad/runtime/cross-origin-isolation/express`. R5 is currently unshipped. That proposal addresses exactly the bug this incident reports — and the moment it ships, both `react-router-serve` (Express under the hood) and any external consumer doing the same hosting pattern get the right headers for free.

The relevant text from R5:

> Add Express / Fastify / Hono / Edge adapters (Tier 2)

`react-router-serve` is the canonical Express consumer in the workspace; the absence of the adapter is felt first by Tau itself.

### Finding 7: Why the FM machine end-state is "error" and not "loading"

`apps/ui/app/machines/file-manager-worker-error.ts:122` formats the worker `error` event into a `Worker script failed to load (likely 404 served as HTML, COEP/CORP block, MIME-type mismatch, or SyntaxError before module evaluation).` message. The FM machine then transitions to the `error` state via `entry: setError` (lines 140-147). The UI shell renders the homepage but the file manager never reaches `ready`, so the project picker / new-project flow never advances past the spinner — exactly the "eternal loading" screenshot the user provided.

There is no race or retry — the FM machine settles permanently in `error` after the first failed worker load. Reload behaves identically because the asset still has no CORP header.

### Finding 8: The `image-bitmap-data-url-worker.js.map` `blob://nullhttp` errors are unrelated

Per `staging-cors-coep-safari-rendering-audit.md` Finding 9: this is a Safari sourcemap quirk for workers created from blob URLs by Three.js's `ImageBitmapLoader` (used unconditionally by `GLTFLoader`). It is benign and not the cause of the FM-worker failure. Resolving the COEP bug above does not affect these messages and they can be ignored.

## Trade-offs

### Where to fix the headers (consumer-app vs runtime adapter)

| Option                                                                                                           | Where                                                                                                     | Pros                                                                                                                                                                                                                                                                                                        | Cons                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Add an Express middleware locally in `apps/ui`                                                                | One-off `apps/ui/server.js` wrapper, run via custom serve target instead of `react-router-serve` directly | Smallest blast radius; ships in one commit                                                                                                                                                                                                                                                                  | Doesn't help external consumers; new bespoke server entry point we now have to maintain; diverges from the canonical RR-serve recipe                        |
| B. Ship `@taucad/runtime/cross-origin-isolation/express` adapter and **wrap** `react-router-serve`'s Express app | `packages/runtime` + `apps/ui`                                                                            | Closes the runtime-distribution gap; one canonical place for the headers; symmetric with `@taucad/runtime/vite` and `@taucad/runtime/react-router`                                                                                                                                                          | Couples to `react-router-serve`'s private `cli.js` mount order; requires reaching into framework internals to inject middleware before its terminal handler |
| C. Patch `react-router-serve` upstream                                                                           | `@react-router/serve`                                                                                     | Solves the bug for the entire ecosystem                                                                                                                                                                                                                                                                     | Slow PR cycle, debatable spec-vs-practice argument, Tau still needs a stop-gap                                                                              |
| D. Add a service-worker fallback (`coi-serviceworker`)                                                           | `apps/ui/public/coi-serviceworker.js` + register                                                          | Universal fix at the browser layer; no server changes                                                                                                                                                                                                                                                       | Heavyweight for a localhost-only problem; introduces a real service worker into prod where it isn't needed                                                  |
| **E. Drop `@react-router/serve`, migrate to `@react-router/express`** (selected)                                 | `packages/runtime` (adapter) + `apps/ui` (server.ts)                                                      | Official React Router migration path for "I need to customize the server"; Tau owns the Express app entirely; no coupling to RR-serve's CLI internals; same `coiMiddleware()` shape from R1 still ships and benefits external Express consumers; future hooks (compression, auth, telemetry) trivial to add | Adds `@react-router/express` + `express` to the dep graph (already pulled in transitively by RR-dev); minor bootstrap file owned by `apps/ui`               |

**Verdict**: Option E. The React Router team's documented answer for "customize the server" is to replace `@react-router/serve` with `@react-router/express`; that path keeps the COI fix surface (`coiMiddleware()` from `@taucad/runtime/cross-origin-isolation/express`) identical to Option B for external Express consumers while letting Tau own the Express app cleanly without poking into framework internals. Options A and B remain valid for repos that cannot migrate.

### Two-line static fix vs. universal "/\*" middleware

| Option                                                                                          | Pros                                                   | Cons                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Add `setHeaders` to each `express.static(…)` mount only                                         | Minimal; preserves `Cache-Control` semantics per mount | Three call sites to keep in sync; misses any future mount                                             |
| Single `app.use((_, res, next) => { applyDocumentHeaders(res); next(); })` _before_ the statics | One place; covers every response (statics + SSR)       | Duplicates the SSR-side header set (harmless — same values); slight overhead per request (negligible) |

**Verdict**: Single-middleware approach mirrors Netlify's `for = "/*"` and matches the Vite-plugin pattern already in `packages/runtime/src/vite/index.ts` (which uses `server.middlewares.use(...)` rather than per-route headers). Less drift, easier to reason about.

### `Cross-Origin-Resource-Policy` value: `same-origin` vs `cross-origin`

The localhost build serves everything from one origin (`http://localhost:3000`), so `same-origin` is correct and matches `documentHeaders` from `@taucad/runtime/cross-origin-isolation`. Using `cross-origin` would also work for the immediate Safari fix but would weaken isolation unnecessarily and diverge from the production `netlify.toml` value. **Verdict**: `same-origin` (i.e. reuse `documentHeaders`).

## Code Examples

### Reproducing the bug (current state)

```bash
cd apps/ui
pnpm nx build ui
PORT=3001 \
  TAU_API_URL=http://localhost:4000 \
  TAU_FRONTEND_URL=http://localhost:3001 \
  TAU_WEBSOCKET_URL=ws://localhost:4001 \
  npx react-router-serve build/server/index.js &

curl -sI http://localhost:3001/                                    | grep -i cross-origin
# cross-origin-embedder-policy: require-corp
# cross-origin-opener-policy: same-origin
# cross-origin-resource-policy: same-origin

curl -sI http://localhost:3001/assets/file-manager.worker-BPQjkaOu.js | grep -i cross-origin
# (no output — the bug)
```

Open `http://localhost:3001/` in Safari → eternal loading + COEP errors in the Web Inspector console. Open in Chrome → loads correctly.

### Proposed Tier 2 Express adapter (matches R5 in the distribution doc)

````typescript
// packages/runtime/src/cross-origin-isolation/express.ts (proposed)
import type { NextFunction, Request, Response } from 'express';
import { documentHeaders } from './index.js';

/**
 * Express/Connect middleware that applies the canonical cross-origin
 * isolation headers to every response. Mount this BEFORE any static-asset
 * middleware so worker scripts and WASM responses carry the headers Safari
 * requires under `Cross-Origin-Embedder-Policy: require-corp`.
 *
 * @public
 *
 * @example <caption>Wrap react-router-serve's Express app</caption>
 * ```typescript
 * import express from 'express';
 * import { coiMiddleware } from '@taucad/runtime/cross-origin-isolation/express';
 *
 * const app = express();
 * app.use(coiMiddleware());
 * // ... existing react-router-serve mounts (express.static, app.all) ...
 * ```
 */
export function coiMiddleware() {
  return (_request: Request, response: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(documentHeaders)) {
      response.setHeader(name, value);
    }
    next();
  };
}
````

### Proposed `apps/ui` wrapper that replaces the `react-router-serve` CLI

```typescript
// apps/ui/server.js (proposed)
import compression from 'compression';
import express from 'express';
import { createRequestListener } from '@mjackson/node-fetch-server';
import { coiMiddleware } from '@taucad/runtime/cross-origin-isolation/express';
import * as build from './build/server/index.js';

const app = express();
app.disable('x-powered-by');

app.use(coiMiddleware()); // <-- the fix; one line, applies BEFORE every static

app.use(compression());
app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
app.use(express.static('build/client'));
app.use(express.static('public', { maxAge: '1h' }));

app.all('*', createRequestListener(build.default?.fetch ?? build.fetch));

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
app.listen(port, () => {
  console.log(`[tau-serve] http://localhost:${port}`);
});
```

Update `apps/ui/project.json:serve.command` to `node server.js` (with `dependsOn: ['build']` retained). The `entry.server.tsx` `applyHandleRequestHeaders` call stays — it's now redundant for the COEP/COOP/CORP headers (the middleware already set them) but is the canonical SSR-layer guard for when this app runs on a different host, so leave it in place.

### Stop-gap (no runtime change required) — emergency hotfix only

If shipping the runtime adapter is blocked, the same outcome can be achieved entirely inside `apps/ui` with a one-file Express wrapper that hardcodes the headers:

```typescript
// apps/ui/server.js (emergency hotfix only — prefer the adapter above)
import express from 'express';
import { createRequestListener } from '@mjackson/node-fetch-server';
import * as build from './build/server/index.js';

const app = express();
app.use((_, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});
app.use('/assets', express.static('build/client/assets', { immutable: true, maxAge: '1y' }));
app.use(express.static('build/client'));
app.use(express.static('public'));
app.all('*', createRequestListener(build.default?.fetch ?? build.fetch));
app.listen(Number.parseInt(process.env.PORT ?? '3000', 10));
```

Mark the duplicated header set with a `// TODO: replace with @taucad/runtime/cross-origin-isolation/express once shipped` comment so the adapter migration is unmissable when R5 lands.

## Diagrams

### Request flow under `react-router-serve` (current — broken on Safari)

```text
                          Browser (Safari) on http://localhost:3000
                                          │
              ┌───────────── document GET ─┴────────────── worker GET ────────────────┐
              ▼                                                                       ▼
     ┌────────────────────┐                                              ┌────────────────────┐
     │  GET /             │                                              │ GET /assets/       │
     │                    │                                              │   file-manager.    │
     │                    │                                              │   worker-XXX.js    │
     └────────┬───────────┘                                              └────────┬───────────┘
              │                                                                   │
              ▼                                                                   ▼
     ┌────────────────────┐                                              ┌────────────────────┐
     │ react-router-serve │                                              │ react-router-serve │
     │ Express:           │                                              │ Express:           │
     │   app.use('/'         │                                            │  app.use('/assets',│
     │     express.static)│                                              │     express.static)│
     │   ── no match ──   │                                              │   ── matches ──    │
     │   app.use('/assets')                                              │   serves bytes     │
     │   ── no match ──   │                                              │                    │
     │   app.use(public)  │                                              │   ✗ no setHeaders  │
     │   ── no match ──   │                                              │   ✗ no CORP        │
     │   app.all('*')     │                                              │   ✗ no COEP        │
     │     → RR fetch     │                                              │                    │
     └────────┬───────────┘                                              └────────┬───────────┘
              │                                                                   │
              ▼                                                                   ▼
     ┌────────────────────┐                                              ┌────────────────────┐
     │  entry.server.tsx  │                                              │  Response:         │
     │  applyHandleReq…() │                                              │   200 OK           │
     │  → COOP same-origin│                                              │   Content-Type: js │
     │  → COEP require-…  │                                              │   Cache-Control:…  │
     │  → CORP same-origin│                                              │   (no COI headers) │
     └────────┬───────────┘                                              └────────┬───────────┘
              │                                                                   │
              ▼                                                                   ▼
     ✅ Document loads;                                                  Safari sees: parent has
     crossOriginIsolated = true                                          require-corp; worker
                                                                         response has no CORP
                                                                         → Worker load BLOCKED
                                                                         → "Refused to load …
                                                                            because of COEP"
                                                                         → FM machine → error
                                                                         → Eternal loading UI
```

### Request flow under `react-router-serve` with the proposed middleware (fixed)

```text
                          Browser (Safari/Chrome/Firefox) on http://localhost:3000
                                          │
              ┌───────────── document GET ─┴────────────── worker GET ────────────────┐
              ▼                                                                       ▼
     ┌────────────────────────────────── Express ────────────────────────────────┐
     │  app.use(coiMiddleware())   ← NEW — runs first for every request           │
     │    sets COOP same-origin, COEP require-corp, CORP same-origin              │
     ├────────────────────────────────────────────────────────────────────────────┤
     │  app.use('/assets', express.static, …)                                    │
     │  app.use(express.static('build/client'))                                  │
     │  app.use(express.static('public'))                                        │
     │  app.all('*', RR fetch handler)                                           │
     └─────────────────────┬────────────────────────────────────────┬─────────────┘
                           ▼                                        ▼
                  ✅ HTML response                          ✅ Worker script response
                     COOP + COEP + CORP                       COOP + COEP + CORP
                                                              → Safari accepts worker
                                                              → FM machine → ready
```

### Layered isolation responsibility (per `runtime-cross-origin-isolation-distribution.md`)

```text
                          ┌──────────────────────────────────────────────────┐
                          │   @taucad/runtime/cross-origin-isolation         │
                          │   documentHeaders | apply…() | inspect…()        │
                          └─────────────────────┬────────────────────────────┘
                                                │ depends on
              ┌─────────────────┬───────────────┼───────────────┬──────────────┐
              ▼                 ▼               ▼               ▼              ▼
       /vite (✅)       /react-router (✅)   /express (❌)   /fastify (❌)   /sw (❌)
       dev/preview      SSR HTML            Node HTTP     Node HTTP    static-host
              │                 │               │               │              │
              ▼                 ▼               ▼               ▼              ▼
       Vite dev/preview   apps/ui SSR    react-router-serve  …Tau API…   GitHub Pages
                                              │
                                          ◀── L3 GAP exercised by THIS bug
```

The Express row is the missing tile. R5 in the distribution doc proposed it; this bug is the forcing function for shipping it.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort | Impact | Status                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ | ----------------------------------------------------------- |
| R1  | **Ship `@taucad/runtime/cross-origin-isolation/express` adapter** (Tier 2 R5 from `runtime-cross-origin-isolation-distribution.md`). Pure 10-line file; imports `documentHeaders` from the canonical `@taucad/runtime/cross-origin-isolation` Tier 1 module; exports a `coiMiddleware()` factory.                                                                                                                                                              | P0       | XS     | High   | ✅ RESOLVED                                                 |
| R2  | **Add `apps/ui/server.ts`** — a thin Express bootstrap that uses `@react-router/express`'s `createRequestHandler` (replacing the upstream `react-router-serve` CLI) and inserts `app.use(coiMiddleware())` **before** `express.static`. Wire `apps/ui/project.json:serve.command` to `node --import @oxc-node/core/register server.ts`. Keep `applyHandleRequestHeaders` in `entry.server.tsx` as defence-in-depth for when this app runs on a different host. | P0       | S      | High   | ✅ RESOLVED                                                 |
| R3  | **Add a parity smoke test** in `apps/ui` (vitest, node env) that boots the bootstrap from R2 on an ephemeral port, fetches `/`, `/assets/<known-worker>.js`, and `/draco_decoder_gltf.wasm`, and asserts each response carries `cross-origin-resource-policy: same-origin` + `cross-origin-embedder-policy: require-corp`. Prevents regression if `apps/ui/server.ts` is later refactored.                                                                     | P1       | S      | High   | ✅ RESOLVED                                                 |
| R4  | **Document the requirement in `apps/ui/content/docs/(runtime)/guides/cross-origin-isolation.mdx`** — list the four hosting topologies (Vite dev, React Router SSR, Express, static host) with copy-paste snippets pulled from the new adapter. Single source of truth for external consumers.                                                                                                                                                                  | P1       | M      | Medium | ✅ RESOLVED                                                 |
| R5  | **Add Fastify, Hono, and Edge adapters in the same PR** if low-cost (each ~12 LOC). Optional but the marginal cost is tiny once the express adapter exists, and it closes the rest of Tier 2 in `runtime-cross-origin-isolation-distribution.md` (R5 there).                                                                                                                                                                                                   | P2       | S      | Medium | ⏸ DEFERRED (Express-only scope)                             |
| R6  | **Surface a structured boot-time warning when `inspectCrossOriginIsolation()` reports `crossOriginIsolated === false`** — a one-line `console.warn` from `@taucad/runtime` startup so the next consumer in this state sees an explicit "your headers are misconfigured" message instead of a misleading "FM worker failed to load" trail. (R8 in the distribution doc.)                                                                                        | P2       | XS     | Medium | ✅ RESOLVED                                                 |
| R7  | **Patch `react-router-serve` upstream** — open a PR that accepts a `setHeaders` option on its `express.static` mounts. Long-cycle; no Tau dependency.                                                                                                                                                                                                                                                                                                          | P3       | M      | Low    | ❌ SUPERSEDED — migrated to `@react-router/express` instead |

### Resolution requirements (must be satisfied to declare the bug fixed)

The following list is the acceptance criterion for closing this bug — every item is required, none are optional, in the order listed.

1. **Worker script responses on `localhost:3000`** (built UI, `react-router-serve`-equivalent path) must carry **`Cross-Origin-Resource-Policy: same-origin`**. Verified by `curl -sI http://localhost:3000/assets/file-manager.worker-*.js | grep -i cross-origin-resource-policy`.
2. **Same applies to every other static-asset response**: `/assets/*.js`, `/assets/*.wasm`, `/assets/*.css`, `/assets/*.map`, `/draco_decoder_gltf.wasm`, `/entry.worker.js`, `/fonts/*`, `/textures/*`, `/robot.glb`. Verified by the smoke test in R3 enumerating these and asserting the header on each response.
3. **HTML SSR responses continue to carry COOP + COEP + CORP** (regression guard against accidentally removing `applyHandleRequestHeaders`).
4. **Safari (latest stable on macOS and iOS) loads `http://localhost:3000`, instantiates `FileManagerWorker` and `ObjectStoreWorker` without console errors, and reaches the FM machine `ready` state**. Verified manually until R3 lands; verified by R3's parity test thereafter.
5. **Chrome and Firefox continue to load `http://localhost:3000` with no regression** (smoke test in R3 covers this).
6. **Production (Netlify) behaviour unchanged** — `netlify.toml` `[[headers]]` block remains the source of truth in prod; no overlap or conflict introduced. Verified by re-running an existing prod-build smoke test if one exists, otherwise by `curl -sI https://taucad.dev/` after the change is deployed to staging.
7. **`inspectCrossOriginIsolation()` returns `{ crossOriginIsolated: true, sharedArrayBuffer: true }`** on `localhost:3000` in all three browsers, asserted in DevTools.
8. **The asset-CORP fix is owned by `@taucad/runtime`**, not duplicated in `apps/ui` — `apps/ui/server.js` imports `coiMiddleware` from `@taucad/runtime/cross-origin-isolation/express`, does not hand-roll the header set. (Stop-gap that hand-rolls the headers is acceptable for ≤ 1 PR but must be replaced with the adapter import in the same milestone.)
9. **Every benign console error documented in this report** (`blob://nullhttp` sourcemap, `Module "fs" externalized`) **explicitly remains** — they are not regressions and not in scope. Resolution does not block on them.

## References

- `docs/research/safari-cross-origin-isolation.md` — canonical decision: ship universal `require-corp`, do not use `credentialless` (Safari-incompatible)
- `docs/research/runtime-cross-origin-isolation-distribution.md` — Tier 1/2/3 architecture; R5 already proposes the missing Express adapter that this bug forces us to ship
- `docs/research/staging-cors-coep-safari-rendering-audit.md` — adjacent Safari investigation (different bug: cert mis-binding for `api.taucad.dev`); Finding 9 documents the benign `image-bitmap-data-url-worker.js.map` `blob://nullhttp` Safari quirk also visible in this incident
- `apps/ui/app/entry.server.tsx` — current SSR header injection (correct — no change needed)
- `apps/ui/app/machines/file-manager-worker-error.ts:122-134` — origin of the user-facing "Worker script failed to load (likely 404, COEP/CORP block, MIME-type mismatch, …)" message
- `apps/ui/netlify.toml:90-107` — production `[[headers]] for = "/*"` block that prevents this bug on Netlify
- `node_modules/.pnpm/@react-router+serve@7.12.0_*/node_modules/@react-router/serve/dist/cli.js:121-141` — three `express.static` mounts with no `setHeaders` callback (the proximate cause)
- `packages/runtime/src/cross-origin-isolation/index.ts` — Tier 1 canonical headers / `applyDocumentHeaders` / `inspectCrossOriginIsolation`
- `packages/runtime/src/react-router/index.ts` — Tier 2 React Router adapter (already shipped)
- `packages/runtime/src/vite/index.ts` — Tier 2 Vite adapter (already shipped) — proves the `configureServer`/middleware pattern is the right shape; the proposed Express adapter mirrors it exactly
- [WebKit bug 245346 — "Cross-Origin-Embedder-Policy incorrectly blocks scripts on cache hit"](https://bugs.webkit.org/show_bug.cgi?id=245346) — independent reproduction of the same Safari error sequence
- [predr.ag — "Debugging Safari: If at first you succeed, don't try again"](https://predr.ag/blog/debugging-safari-if-at-first-you-succeed/) — long-form write-up of the WebKit COEP-on-worker enforcement semantics and the byte-identical error message
- [WebKit bug 261734 — "CORP headers mishandled inside Worker"](https://bugs.webkit.org/show_bug.cgi?id=261734) — adjacent WebKit COEP/CORP-on-worker bug
- [MDN — `Cross-Origin-Embedder-Policy`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy) — spec reference for `require-corp` / `credentialless` semantics
- [HTML spec — cross-origin opener policies and embedder policies](https://html.spec.whatwg.org/multipage/origin.html#coep) — the implicit-same-origin pass that Chromium/Firefox honour and WebKit does not

## Appendix: Raw evidence

### `react-router-serve` CLI source (the proximate cause)

```javascript
// node_modules/.pnpm/@react-router+serve@7.12.0_*/node_modules/@react-router/serve/dist/cli.js:121-141
app.use(
  import_node_path.default.posix.join(build.publicPath, 'assets'),
  import_express2.default.static(import_node_path.default.join(build.assetsBuildDirectory, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }),
);
app.use(build.publicPath, import_express2.default.static(build.assetsBuildDirectory));
app.use(import_express2.default.static('public', { maxAge: '1h' }));
app.use((0, import_morgan.default)('tiny'));
if (build.fetch) {
  app.all('*', (0, import_node_fetch_server.createRequestListener)(build.fetch));
} else {
  app.all(
    '*',
    (0, import_express.createRequestHandler)({
      build: buildModule,
      mode: process.env.NODE_ENV,
    }),
  );
}
```

`express.static` does not accept a `setHeaders` callback in any of these mount calls (it does support one — `setHeaders(res, path, stat)` — but `react-router-serve` never passes it).

### Live header capture from a freshly-started `react-router-serve`

```text
$ cd apps/ui && pnpm nx build ui   # produces apps/ui/build/{client,server}
$ PORT=3001 \
  TAU_API_URL=http://localhost:4000 \
  TAU_FRONTEND_URL=http://localhost:3001 \
  TAU_WEBSOCKET_URL=ws://localhost:4001 \
  npx react-router-serve build/server/index.js &

$ curl -sI http://localhost:3001/
HTTP/1.1 200 OK
cross-origin-embedder-policy: require-corp           ← from entry.server.tsx
cross-origin-opener-policy: same-origin              ← from entry.server.tsx
cross-origin-resource-policy: same-origin            ← from entry.server.tsx

$ curl -sI http://localhost:3001/assets/file-manager.worker-BPQjkaOu.js
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: public, max-age=31536000, immutable
Last-Modified: Thu, 23 Apr 2026 04:27:22 GMT
ETag: W/"e3a3-19db897b15d"
Content-Type: application/javascript; charset=UTF-8
Content-Length: 58275                                 ← no COI headers — Safari refuses

$ curl -sI http://localhost:3001/assets/assimpjs-all-rMyuPSGP.wasm
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
Content-Type: application/wasm
Content-Length: 10774632                              ← no COI headers

$ curl -sI http://localhost:3001/draco_decoder_gltf.wasm
HTTP/1.1 200 OK
Cache-Control: public, max-age=0
Content-Type: application/wasm
Content-Length: 192593                                ← no COI headers
```

### `apps/ui/build/client/assets/` worker enumeration

```text
$ ls apps/ui/build/client/assets/ | grep -iE 'worker' | wc -l
28

$ ls apps/ui/build/client/assets/ | grep -iE 'worker' | sort
css.worker-DXzwbUec.js
css.worker-DXzwbUec.js.map
editor.worker-CJeg_Dv_.js
editor.worker-CJeg_Dv_.js.map
file-manager.worker-BPQjkaOu.js
file-manager.worker-BPQjkaOu.js.map
html.worker-CYcnUrU3.js
html.worker-CYcnUrU3.js.map
import.worker-860GdVMh.js
import.worker-860GdVMh.js.map
json.worker-DG882fsS.js
json.worker-DG882fsS.js.map
kcl-lsp-worker-S79KLU25.js
kcl-lsp-worker-S79KLU25.js.map
object-store.worker-BuCWpTnR.js
object-store.worker-BuCWpTnR.js.map
…
```

(Plus `image-bitmap-data-url-worker-*.js`, the inline workers spawned via `new URL('…', import.meta.url)` from runtime kernels, and the FM/RT worker pair that boots first.)

### `apps/ui/project.json` `serve` target

```json
"serve": {
  "executor": "nx:run-commands",
  "continuous": true,
  "dependsOn": ["build"],
  "options": {
    "cwd": "{projectRoot}",
    "command": "react-router-serve build/server/index.js"
  }
}
```

R2 changes the `command` to `node server.js` and adds the `apps/ui/server.js` bootstrap shown in the Code Examples section.

### `apps/ui/netlify.toml` headers block (production — works correctly)

```toml
[[headers]]
for = "/*"
[headers.values]
…
Cross-Origin-Opener-Policy = "same-origin"
Cross-Origin-Resource-Policy = "same-origin"
Cross-Origin-Embedder-Policy = "require-corp"
…
```

The `for = "/*"` selector applies to every response — HTML, JS, WASM, fonts, images. This is the equivalent of `app.use(coiMiddleware())` in Express and is why production never exhibits this bug.
