---
title: 'Stale Asset Hash → Opaque Worker Error Diagnostics'
description: 'Root-cause investigation of `WORKER ERROR: undefined undefined undefined` and the four-part fix that turns stale-hash asset 404s into actionable diagnostics.'
status: active
created: '2026-04-23'
updated: '2026-04-23'
category: investigation
related:
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/safari-replicad-empty-geometry-investigation.md
  - docs/research/prod-staging-ui-deployment-status.md
---

# Stale Asset Hash → Opaque Worker Error Diagnostics

Root-cause investigation of the `[FileManager] WORKER ERROR: undefined undefined undefined` log line that surfaced after deploys, and the four-part fix that promotes those opaque worker load failures into actionable diagnostics surfaced through the FM XState machine.

## Executive Summary

After every UI deploy, returning users on stale browser caches saw the FileManager hang in the `connectingWorker` phase with a single console line — `WORKER ERROR: undefined undefined undefined` — and no recovery. The smoking gun is that hashed asset requests for chunks that no longer exist on disk fall through to the SPA's root splat route (`apps/ui/app/routes/$/route.tsx`), which answers with `200 OK + text/html` (the React-rendered `PageNotFound` page). The browser then tries to evaluate that HTML as JavaScript inside the worker, fires a `Worker.onerror` `Event` with `message`/`filename`/`lineno` all `undefined` (a load-failure event, not an `ErrorEvent`), and the FM machine's `connectWorkerActor` was awaiting `waitForWorkerReady(...)` with no crash channel — so the actor never resolved or rejected.

The fix is **four collaborating layers**, all already implemented and now landed file-based for the route piece:

1. **`/assets/*` returns a real `404`** so the browser surfaces a typed network failure instead of an HTML-as-JS parse error. Mounted via flat-routes' splat convention at `routes/assets.$/route.tsx` — no manual `route()` registration in `routes.ts`.
2. **`formatWorkerError`** distinguishes `ErrorEvent` (runtime), `Event` (opaque load failure), and `messageerror` (structured-clone failure) and emits an actionable, non-empty `message` for each.
3. **`WorkerErrorEnvelope`** is posted by the worker itself when its top-level await throws, so the main thread learns what crashed _before_ the browser fires its opaque load-failure `error`.
4. **`crashSignal` race in `connectWorkerActor`** plumbs all three error sources into `Promise.race(...)` against `waitForWorkerReady`, so the FM machine routes to its `error` state with a meaningful `context.error.message` instead of hanging.

Layers 2-4 were the original asks of the diagnostic refactor; layer 1 is the **upstream** fix that prevents the load failure from happening in the first place for the most common production trigger (returning user on a cached HTML page that points at deleted chunk hashes).

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Browser `Worker` `error` events are heterogeneous](#finding-1-browser-worker-error-events-are-heterogeneous)
  - [Finding 2: The SPA root splat answers `200 OK + HTML` for missing assets](#finding-2-the-spa-root-splat-answers-200-ok--html-for-missing-assets)
  - [Finding 3: The previous `connectWorkerActor` had no crash channel](#finding-3-the-previous-connectworkeractor-had-no-crash-channel)
  - [Finding 4: Worker top-level-await failures fire _before_ the opaque `error`](#finding-4-worker-top-level-await-failures-fire-before-the-opaque-error)
- [Recommendations](#recommendations)
- [Implementation](#implementation)
  - [Layer 1: File-based `/assets/*` 404 route](#layer-1-file-based-assets-404-route)
  - [Layer 2: `formatWorkerError` event triage](#layer-2-formatworkererror-event-triage)
  - [Layer 3: `WorkerErrorEnvelope` from the worker side](#layer-3-workererrorenvelope-from-the-worker-side)
  - [Layer 4: `crashSignal` race in `connectWorkerActor`](#layer-4-crashsignal-race-in-connectworkeractor)
- [Trade-offs](#trade-offs)
  - [File-based vs explicit route registration](#file-based-vs-explicit-route-registration)
- [References](#references)

## Problem Statement

Two related symptoms appeared after UI deploys:

1. Returning users (typically on Safari with aggressive page caching, or on a tab left open across a deploy) saw the file tree never populate; the FileManager pane stayed in its skeleton state indefinitely.
2. The only console signal was the literal log line:

   ```text
   [FileManager] WORKER ERROR: undefined undefined undefined
   ```

   produced by the previous handler:

   ```typescript
   worker.addEventListener('error', (error) => {
     console.error(`[FileManager] WORKER ERROR:`, error.message, error.filename, error.lineno);
   });
   ```

`event.message`, `event.filename`, and `event.lineno` were all `undefined` because the dispatched event was a plain `Event`, not an `ErrorEvent`. The XState `connectWorkerActor` was simultaneously awaiting `waitForWorkerReady(worker, signal)` — which never resolves when the worker module fails to evaluate — so the FM machine sat permanently in `connectingWorker` with no error transition fired.

This was the same family of failure mode catalogued for the API layer in [`staging-cors-coep-safari-rendering-audit.md`](./staging-cors-coep-safari-rendering-audit.md) (Finding 1) and for the kernel layer in [`safari-replicad-empty-geometry-investigation.md`](./safari-replicad-empty-geometry-investigation.md): a downstream consumer collapses every distinguishable failure mode onto the same opaque message, blinding observability.

## Methodology

1. Read the previous `connectWorkerActor` handler in `apps/ui/app/machines/file-manager.machine.ts` to confirm what fields were being logged and whether the actor had a crash channel.
2. Reproduced a stale-hash request locally by serving the production build, opening the app, then deleting one chunk from `apps/ui/build/client/assets/` and reloading. Captured the full network/console transcript in Chrome and Safari.
3. Read `apps/ui/app/routes/$/route.tsx` (the root splat) and `apps/ui/server.ts` to verify what the server returns for an unmatched `/assets/<hash>.js` request — confirmed `200 OK + text/html` from the SPA fallback.
4. Cross-referenced against the WHATWG HTML spec for [`AbstractWorker` error events](https://html.spec.whatwg.org/multipage/workers.html#handler-abstractworker-onerror) to confirm the spec'd contract: a worker that fails to fetch/parse fires a _plain_ `Event`, not an `ErrorEvent`.
5. Reviewed how the splat-route fall-through is avoided in `react-router-serve` (Express layer) — Express static middleware runs _before_ the React Router request handler, so a real on-disk asset always wins; only genuine cache misses reach the SPA splat.
6. Audited every other `routes/<segment>.$/` directory in `apps/ui/app/routes/` to confirm the file-based splat convention is already in use (`auth.$`, `docs.$`, `i.$`, `import.$`, `api.ph.$`, `llms[.]mdx.$`, `settings_.$`).

## Findings

### Finding 1: Browser `Worker` `error` events are heterogeneous

The HTML spec dispatches three different shapes on a `Worker`:

| Event type     | Constructor  | Trigger                                                                                                                                                     | Useful fields                                            |
| -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `error`        | `ErrorEvent` | Uncaught exception or rejected top-level await **inside an already-loaded module worker**                                                                   | `message`, `filename`, `lineno`, `colno`, `error`        |
| `error`        | `Event`      | The browser cannot **evaluate** the worker module (404 served as HTML, MIME mismatch, COEP block, syntax error before module evaluation, failed sub-import) | None — all string/number fields read as `''`/`undefined` |
| `messageerror` | `Event`      | Structured-clone failure on a `postMessage` payload                                                                                                         | None                                                     |

Logging `event.message`/`event.filename`/`event.lineno` unconditionally produces the string `"undefined undefined undefined"` for the second and third cases because both dispatch a plain `Event`, not an `ErrorEvent`. The previous handler hit this for every load failure.

### Finding 2: The SPA root splat answers `200 OK + HTML` for missing assets

`apps/ui/app/routes/$/route.tsx` renders `<PageNotFound />` for any path the rest of the route table does not match. Without an explicit `/assets/*` route, `react-router-serve` walks the request through:

1. **Express static middleware** — checks `apps/ui/build/client/assets/<hash>` on disk. **If present**: serves the file (200 OK, correct MIME). **If absent**: falls through.
2. **React Router request handler** — matches `/assets/<hash>.js` against the route table. The root splat (`$`) catches it and renders the `PageNotFound` React tree as **HTML**.
3. **Response**: `200 OK`, `Content-Type: text/html`, body `<!DOCTYPE html>...`.

The browser receives that HTML response, attempts to instantiate it as an ECMAScript module, fails before module evaluation, and dispatches the opaque load-failure `Event` documented in Finding 1. **A returning user on a stale page (cached HTML referencing chunk hashes that no longer exist on disk) hits this on every deploy**, which is why the symptom correlated 1:1 with deploy events.

The same fall-through affects other downstream consumers (worker chunks specifically are the most visible, but stylesheets, JSON manifests, and image assets all degrade the same way — they just don't manifest as a permanently-stuck XState actor).

### Finding 3: The previous `connectWorkerActor` had no crash channel

The actor structure was:

```typescript
const worker = context.sharedWorker ?? new FileManagerWorker({ name: `fm-root` });
worker.addEventListener('error', (error) => {
  console.error('[FileManager] WORKER ERROR:', error.message, error.filename, error.lineno);
});
if (!context.sharedWorker) {
  await waitForWorkerReady(worker, signal);
}
```

`waitForWorkerReady` resolves when the worker posts its `ready` envelope and rejects only on `signal.aborted`. A worker that **never evaluates** never posts `ready`, never aborts, and the actor's promise never settles. The `error` listener was console-only — it had no path back into the XState `onError` transition, so the FM machine stayed in `connectingWorker` until the user navigated away.

### Finding 4: Worker top-level-await failures fire _before_ the opaque `error`

The FM worker's module-evaluation phase runs `await fileService.mount('/', 'indexeddb')` and `await createNodeModulesMount()`. If either rejects, the module's top-level await throws, the worker terminates, and **then** the browser fires the load-failure `Event` (per spec, the browser cannot distinguish "rejected top-level await" from "syntax error before evaluation" once the module promise settles to rejected — both produce the same opaque event).

But the worker can catch its _own_ rejection synchronously inside the `try`/`catch` and `postMessage` a structured envelope to the main thread _before_ the unhandled rejection bubbles. That envelope arrives as a normal `message` event with `event.data` containing the original error's `message`, `stack`, `name`, and `cause` — fully structured-clone-safe and informative. The opaque `error` event still fires afterwards, but by then the main thread already has the actual cause.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                       | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Mount a `/assets/*` route that returns `404` so stale-hash asset requests are surfaced as real network failures instead of HTML-as-JS. Use the flat-routes splat convention (`routes/assets.$/route.tsx`) — no manual `route()` registration.                                                | **P0**   | XS     | High   |
| R2  | Triage worker `error` events through `formatWorkerError(event)` so each of the three event shapes (`ErrorEvent`/`Event`/`messageerror`) emits a non-empty, kind-tagged message. Never log `event.message` on a plain `Event`.                                                                | **P0**   | XS     | High   |
| R3  | Have the worker post a `WorkerErrorEnvelope` (`__worker_init_error__` / `__worker_runtime_error__`) when it catches its own top-level failures. This carries the real cause to the main thread before the browser's opaque load-failure `error` fires.                                       | **P0**   | S      | High   |
| R4  | Race `waitForWorkerReady` against a `crashSignal` Promise that all three error channels reject. The FM XState machine then routes to its `error` state with a meaningful `context.error.message` instead of hanging.                                                                         | **P0**   | S      | High   |
| R5  | Add the same `formatWorkerError` triage to the **kernel** workers (`packages/runtime/src/framework/runtime-worker-client.ts`) so opaque kernel-worker load failures (most common in production: `replicad-opencascadejs.wasm` MIME mismatch on misconfigured CDNs) get the same diagnostics. | P1       | S      | Med    |
| R6  | Add an integration test that loads the production build and requests `/assets/<garbage-hash>.js` via `fetch`, asserting `Response.status === 404` and `Content-Type: text/plain`. Prevents the SPA splat from silently re-claiming `/assets/*` if the route is renamed.                      | P2       | S      | Med    |

R1-R4 are **already landed** as of the working-tree changes captured by this document; R5 and R6 are follow-ups.

## Implementation

### Layer 1: File-based `/assets/*` 404 route

Mounted automatically by `@react-router/fs-routes` `flatRoutes()` via the splat directory convention. No manual registration in `routes.ts`.

```9:24:apps/ui/app/routes/assets.$/route.tsx
 * In production the UI is served by `react-router-serve`. Without an explicit
 * route for `/assets/*`, an asset hash that no longer exists on disk (e.g. a
 * stale browser cache pointing at an old chunk) falls through to the SPA's
 * root splat route (`routes/$/route.tsx`) and is answered with a `200 OK`
 * HTML response. The browser then tries to evaluate that HTML as JavaScript,
 * producing an opaque worker load failure that surfaces as the previous
 * `[FileManager] WORKER ERROR: undefined undefined undefined`.
 *
 * Returning a real `404` here turns those stale-hash requests into legitimate
 * network failures so the FileManager's worker-error diagnostics carry an
 * actionable filename + URL instead of a parse error.
 *
 * Real assets are served by Express static middleware *before* the React
 * Router request handler runs, so this loader only ever fires for genuine
 * cache-mismatch / 404 cases — it does not interfere with the normal asset
 * pipeline.
```

The loader throws a typed `Response`:

```typescript
throw new Response(`Asset not found: ${url.pathname}`, {
  status: 404,
  statusText: 'Not Found',
  headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
});
```

`Cache-Control: no-store` ensures Safari's aggressive disk cache does not persist the 404 across a subsequent deploy that _would_ have served the asset. `Content-Type: text/plain` ensures any consumer that mis-treats the body (e.g. a worker bootloader) sees plain text rather than HTML-shaped output.

`routes.ts` collapses to its pre-fix four-line shape (plus the test-file ignore that has always been required):

```1:18:apps/ui/app/routes.ts
import { flatRoutes } from '@react-router/fs-routes';

// Co-located route tests (e.g. `health.live.test.ts`, `assets.$/route.test.ts`)
// live next to the route module they exercise. Without these ignore globs,
// flatRoutes would treat `<segment>.test.ts(x)` as a real route, react-router's
// type generator would emit a matching `+types/<segment>.test.ts(x)` file under
// `.react-router/types/`, and vitest would then discover those generated
// .test.ts files and fail with "No test suite found in file ...".
//
// The `assets.$` directory itself is mounted by flatRoutes at `/assets/*`
// (splat convention), short-circuiting stale-asset-hash requests with a real
// 404 instead of letting them fall through to the SPA root splat — see
// `docs/research/stale-asset-hash-worker-error-diagnostics.md` for the
// design rationale.
export default flatRoutes({
  ignoredRouteFiles: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
});
```

### Layer 2: `formatWorkerError` event triage

Returns a `FormattedWorkerError` discriminated by `kind: 'runtime' | 'load' | 'messageerror'` so callers can route each shape distinctly. The plain-`Event` branch produces actionable guidance instead of an empty fragment:

```44:78:apps/ui/app/machines/file-manager-worker-error.ts
export function formatWorkerError(event: Event): FormattedWorkerError {
  if (event.type === 'messageerror') {
    return {
      kind: 'messageerror',
      message:
        'Worker `messageerror` — a message could not be deserialized (structured-clone failure or unsupported transferable). Check the most recent postMessage payload for non-cloneable values.',
    };
  }

  if (event instanceof ErrorEvent) {
    const errorObject = event.error instanceof Error ? event.error : undefined;
    const eventMessage = event.message === '' ? undefined : event.message;
    const eventFilename = event.filename === '' ? undefined : event.filename;
    const baseMessage = eventMessage ?? errorObject?.message ?? 'Unknown worker error';
    const where = eventFilename ? ` at ${eventFilename}:${event.lineno}:${event.colno}` : '';
    return {
      kind: 'runtime',
      message: `${baseMessage}${where}`,
      filename: eventFilename,
      lineno: event.lineno === 0 ? undefined : event.lineno,
      colno: event.colno === 0 ? undefined : event.colno,
      stack: errorObject?.stack,
      cause: errorObject,
    };
  }

  return {
    kind: 'load',
    message: loadFailureGuidance,
  };
}
```

Note the empty-string sentinel handling: cross-origin workers without proper headers fire `ErrorEvent` with `message === ''` and `filename === ''` (browser-side privacy guard); explicitly treating these as missing surfaces the underlying `error.message`/`error.stack` via the fallback chain instead of producing an empty fragment.

### Layer 3: `WorkerErrorEnvelope` from the worker side

The worker installs `error` and `unhandledrejection` listeners _and_ wraps each top-level await in a try/catch that posts a `__worker_init_error__` envelope before re-throwing:

```typescript
try {
  await fileService.mount('/', 'indexeddb');
} catch (error) {
  postWorkerInitError("mount('/', 'indexeddb')", error);
  throw error;
}
```

`postWorkerInitError` calls `serializeError(error)` to produce a structured-clone-safe payload (extracting `name`, `message`, `stack`, and `causeMessage` from `Error`/`Error.cause`/string/JSON-stringifiable objects). The main thread's listener guards on `isWorkerErrorEnvelope(event.data)` and routes via `formatWorkerErrorEnvelope`.

### Layer 4: `crashSignal` race in `connectWorkerActor`

The actor installs all three listeners (`error`, `messageerror`, `message`) **before** any await, so a synchronous load failure during worker creation is captured rather than swallowed. A `crashSignal` Promise is set up alongside; all three listeners route through `reportAndMaybeReject` which both `console.error`s the structured payload _and_ rejects `crashSignal` while `armed === true`:

```typescript
let armed = true;
let rejectOnCrash!: (error: Error) => void;
const crashSignal = new Promise<never>((_resolve, reject) => {
  rejectOnCrash = reject;
});
crashSignal.catch(() => {
  /* swallowed by design */
});

const reportAndMaybeReject = (formatted: ReturnType<typeof formatWorkerError>): void => {
  const error = toWorkerError(formatted);
  console.error('[FileManager] worker error:', formatted.message, formatted);
  if (armed) {
    rejectOnCrash(error);
  }
};
```

The worker-ready handshake then races against the crash channel:

```typescript
try {
  await Promise.race([waitForWorkerReady(worker, signal), crashSignal]);
} catch (error) {
  worker.removeEventListener('error', onWorkerError);
  worker.removeEventListener('messageerror', onWorkerMessageError);
  worker.removeEventListener('message', onWorkerEnvelope);
  safeDispose(() => {
    worker.terminate();
  });
  throw error;
}
armed = false;
```

After the readiness gate clears, `armed` flips to `false` so post-init crashes are still reported via `console.error` but no longer reject the (already-resolved) `crashSignal`. The listeners stay attached so steady-state worker crashes remain visible in the console.

## Trade-offs

### File-based vs explicit route registration

The first iteration of this fix registered the route explicitly via `route('assets/*', 'routes/assets-not-found.tsx')` and excluded the file from `flatRoutes` via `ignoredRouteFiles`. The current iteration uses the directory-form splat convention `routes/assets.$/route.tsx` so flat-routes auto-mounts it.

| Approach                              | Pros                                                                                                                                                                  | Cons                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Explicit `route()` registration       | Filename `assets-not-found.tsx` advertises intent; mounting URL is explicit in `routes.ts`.                                                                           | Two places to keep in sync (`route()` + `ignoredRouteFiles`); inconsistent with every other splat in this app.             |
| **File-based (`assets.$/route.tsx`)** | Single source of truth (filesystem layout); `routes.ts` returns to a 4-line config; consistent with `auth.$`, `docs.$`, `i.$`, `import.$`, `api.ph.$`, `settings_.$`. | Filename is less self-documenting (mitigated by the route's JSDoc, the co-located `route.test.ts`, and this research doc). |

Mounting precedence is unaffected: the root `$/` splat is at depth 0, `assets.$` is at depth 1, and React Router's longest-prefix matcher always picks the deeper route for `/assets/*`. Production behavior is unaffected: `react-router-serve`'s Express static middleware still serves real assets _before_ the React Router request handler runs, so this loader only fires on genuine cache-miss / 404 cases.

## References

- WHATWG HTML spec — [`AbstractWorker` error events](https://html.spec.whatwg.org/multipage/workers.html#handler-abstractworker-onerror)
- React Router v7 — [flat-routes file conventions](https://reactrouter.com/how-to/file-route-conventions)
- Related: [`docs/research/staging-cors-coep-safari-rendering-audit.md`](./staging-cors-coep-safari-rendering-audit.md) (R8 — sharedWorker reuse; same diagnostic family at the API layer)
- Related: [`docs/research/safari-replicad-empty-geometry-investigation.md`](./safari-replicad-empty-geometry-investigation.md) (kernel-side analogue: opaque success collapsing distinguishable failure modes)
- Related: [`docs/research/prod-staging-ui-deployment-status.md`](./prod-staging-ui-deployment-status.md) (consolidated deployment audit)
- Source: `apps/ui/app/routes/assets.$/route.tsx`, `apps/ui/app/routes/assets.$/route.test.ts`
- Source: `apps/ui/app/machines/file-manager-worker-error.ts`, `apps/ui/app/machines/file-manager-worker-error.test.ts`
- Source: `apps/ui/app/machines/file-manager.machine.ts` (`connectWorkerActor`), `apps/ui/app/machines/file-manager.worker.ts` (init-error envelopes)
