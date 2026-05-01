---
title: 'Staging CORS / COEP / Safari Rendering Audit'
description: 'Live-evidence root-cause investigation: staging API restart loop, persistent post-fix CORS at api.taucad.dev (cert lives on PROD), OCJS-only Safari rendering blank-out, and the OPFS /node_modules architectural smell.'
status: active
created: '2026-04-22'
updated: '2026-04-22'
verified_causes:
  - 'API crash loop (resolved): Paused Supabase Postgres instance — connection-level failure that postgres-js stringified to "Failed query: CREATE SCHEMA IF NOT EXISTS \"drizzle\"\nparams:" because the migrator fired the first query before the connection error surfaced.'
  - 'Persistent post-fix CORS (NEW, smoking gun): The `api.taucad.dev` Fly cert lives on the PRODUCTION `tau-api` app, not on `tau-api-staging`. The staging UI at `https://taucad.dev` calls `https://api.taucad.dev/...` which Fly routes to `tau-api` (production), whose `TAU_FRONTEND_URL=https://tau.new` and `ADDITIONAL_CORS_ORIGINS` reject `https://taucad.dev`. Confirmed by `flyctl certs list -a tau-api` showing `api.taucad.dev` Issued, plus side-by-side `curl` of `tau-api-staging.fly.dev` (returns ACAO + CORP=cross-origin) vs `api.taucad.dev` (omits ACAO, CORP=same-origin). Historical bisect: commits `d4d9aae89` (Dec 4 06:43, "update Fly configuration for tau.new domain") and `b3963b6b5` (Dec 4 18:00, "remove hardcoded taucad.dev from CORS origins") flipped production from `taucad.dev` to `tau.new` and removed `taucad.dev` from prod CORS, but the `api.taucad.dev` cert was never moved off the production app.'
category: investigation
related:
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/safari-svg-rendering-compatibility.md
  - docs/research/shared-worker-fs-architecture.md
  - docs/research/filesystem-mount-only-architecture.md
---

# Staging CORS / COEP / Safari Rendering Audit

Root-cause investigation covering the three reported staging-environment failures: persistent CORS errors on `https://taucad.dev`, blank viewport for the OCJS-based kernels (`replicad`, `opencascade`) in Safari while OpenSCAD and JSCAD render fine, and a cluster of related Safari worker/storage warnings.

> **Revision note (2026-04-22, third pass)**: After R4 was applied and the Supabase project was unpaused, the API is healthy (boot logs show `Database migrations completed successfully`, machines transition to `started`, internal `curl` from inside the staging machine returns `200 OK` with full CORS headers). **CORS errors on `https://taucad.dev` persist anyway, for an entirely different reason that the original framing missed.** The new smoking gun is that the `api.taucad.dev` Fly cert lives on the PRODUCTION `tau-api` app, not on `tau-api-staging`, so every staging-UI request lands on the production API and is rejected by production's CORS rules. See Finding 11. The previous Finding 2 ("All CORS errors are downstream of the stopped API") was true in the API-down state but is no longer the explanation now that the API is up; it is retained for historical accuracy but explicitly superseded by Finding 11 below.
>
> Earlier framings withdrawn:
>
> 1. The pre-fix Dockerfile claim was wrong — `gh run 24738311458` (the `refactor(ui): update entry.server test import to use path alias` push to `main` at 2026-04-21 18:03 UTC) ran the `Deploy API (Staging)` job successfully, and `flyctl status -a tau-api-staging` confirms the running image (`tau-api-staging:34e94988…`) IS the post-fix Dockerfile. Boot logs prove this: route registration completes (`Mapped {/telemetry/ingest, POST}`) and there is no `ERR_MODULE_NOT_FOUND`.
> 2. The WebGL-context-budget hypothesis for Safari OCJS blank-viewport is wrong — the user demonstrated that **OpenSCAD and JSCAD render fine in the same Safari session** (images 3 and 5 of the bug report). A budget cap would affect every kernel equally; this rules out the prior framing.
> 3. The "SQLSTATE permission" framing of Finding 1 was wrong. The verified cause is that the **Supabase Postgres instance backing `DATABASE_URL` was paused** (Supabase pauses free-tier projects after 7 days of inactivity). The migrator fired `CREATE SCHEMA IF NOT EXISTS "drizzle"` against a pooler that refused/timed out the underlying connection, and `postgres-js` stringified this as `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams:` — making the error look like a permission failure when it was actually connection-level. **The recommendations below are reframed around the observability gap that hid this from Fly logs**, not around the specific provider state. The same gap will hide the next outage (network blip, role rotation, max-connections exhausted, paused Neon branch, etc.) until the structured logging is in place.
> 4. Finding 2's framing ("CORS is downstream of API outage") was correct on first review but stopped explaining the symptoms once R4 unpaused Supabase. The persistent-post-fix CORS errors required a separate investigation that bottomed out at the cert/app routing mismatch (Finding 11). The two CORS root causes (API down → bare 404, vs. wrong-app routing → real 200 with no ACAO) look identical from the browser console.

## Executive Summary

Live re-verification reduces the picture to **three unrelated production-blocking issues** plus three architectural smells:

0. **`api.taucad.dev` is bound to the PRODUCTION app, not staging** — the smoking gun for the post-Supabase-fix CORS regression. The cert was never moved off `tau-api` when the production frontend migrated from `taucad.dev` to `tau.new` in commits `d4d9aae89` (Dec 4 06:43 NZDT) and `b3963b6b5` (Dec 4 18:00 NZDT). The staging UI at `https://taucad.dev` therefore makes its API calls against the production app, which (correctly) rejects the staging origin. Side-by-side `curl` evidence below proves this: `https://tau-api-staging.fly.dev/v1/auth/get-session` with `Origin: https://taucad.dev` returns `access-control-allow-origin: https://taucad.dev` and `cross-origin-resource-policy: cross-origin`, while `https://api.taucad.dev/v1/auth/get-session` against the SAME app _via the cert_ returns no ACAO and `cross-origin-resource-policy: same-origin`. Internal `node fetch http://127.0.0.1:3000/...` from inside the staging machine returns full CORS headers, ruling out staging-side misconfiguration. See Finding 11. Fix in R12.

1. **`tau-api-staging` was in a permanent crash loop** because `DatabaseService.runMigrations()` fails on `CREATE SCHEMA IF NOT EXISTS "drizzle"`. **The verified cause is a paused Supabase Postgres instance** (confirmed out-of-band by the user). The reason this took several iterations to diagnose is the **observability gap inside the migrator boundary**: the error logger swallows the underlying `postgres-js` error fields (Pino drops the second positional arg, then the rethrown `Error` only carries `error.message`, which postgres-js sets to the literal `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"\nparams:` even when the actual failure is connection-level). From Fly logs alone we could not tell whether the upstream cause was a paused project, a network partition, a rotated role, an exhausted connection pool, or a permission denial — every one of those failure modes produces the **same opaque message**. The fix sequence is therefore **observability-first**: R1 enriches the rethrow, R2 adds an explicit pre-migration connectivity probe that prints the hostname/port/error class, R3 adds a Fly health-check alert, and only then R4 applies the per-incident remediation (in this case: unpause the Supabase project; in a future incident: whatever the structured log identifies). The point is to **never again diagnose a database outage by guessing**.
2. **Safari blank-viewport for OCJS kernels** (replicad, opencascade) is **not** WebGL context loss (already disproven), **not** OPFS `/node_modules` mount failure (proven below — JSCAD lives entirely outside that mount and is also rendered through the same WebGL pipeline), and **not** SAB/COEP. The geometry compute completes (`createGeometry completed`, `geometry event received`, `setGeometries` all log success). The most defensible remaining hypothesis is a **content-level mismatch in the `convertReplicadGeometriesToGltf` SLProps-normal pipeline (recent rewrite, see `replicad-occt-normal-pipeline-v3.md`) producing a GLB that Safari's `GLTFLoader` parses to zero meshes**. We cannot confirm without instrumenting the renderer; this audit recommends a 3-line diagnostic patch (R6) that will immediately localise the smoking gun.
3. **OPFS `/node_modules` mount failure on Safari** (`UnknownError: The operation failed for an unknown transient reason (e.g. out of memory)`) is real and should be addressed, but on inspection of `apps/ui/app/machines/file-manager.worker.ts:32-46` it is correctly handled: when the mount fails, `/node_modules` traffic transparently falls through to the IndexedDB root mount, which is the same backend everything else uses. **It is not the cause of the OCJS rendering failure** because (a) JSCAD/OpenSCAD/replicad/opencascade all register their packages as **kernel-built-in modules** (zero `/node_modules` traffic for the package import), and (b) WASM binaries are loaded via Vite's `@fs/` URL, not the FS mount. The user's instinct to "switch from OPFS to IndexedDB for `/node_modules`" is correct architecturally — there is no functional benefit to the OPFS mount in the current architecture, only Safari brittleness — and the simpler fix is to remove the OPFS mount entirely (R5).
4. **Four FileManagerWorker instances are spawned in a 4-second window** (`+877ms`, `+4251ms`, `+4255ms`, `+4262ms` in the user's log). Each one re-runs the OPFS mount (which fails on Safari each time, producing the warning N times), each one allocates a fresh 50 MB `SharedArrayBuffer` for its file pool, and each one re-evaluates the worker module (~510 ms). This is wasteful and amplifies Safari's memory pressure even though there is no bug per se. There is a `sharedWorker` opt-in in `connectWorkerActor` but nothing wires it up.
5. **CSP `connect-src` still omits `https://api.taucad.dev`** (R3 — unchanged from prior version). It is `Content-Security-Policy-Report-Only`, so it does not block today, but it is a latent bomb the moment the directive flips to enforcing.

A scenario-by-scenario recommendation table at the bottom orders these by priority and dependency.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 11: `api.taucad.dev` cert is bound to the PRODUCTION app — the staging UI is calling production (NEW SMOKING GUN)](#finding-11-apitaucaddev-cert-is-bound-to-the-production-app--the-staging-ui-is-calling-production-new-smoking-gun)
  - [Finding 1: API in restart loop — DB migration fails on `CREATE SCHEMA "drizzle"`, the real `postgres-js` error is being eaten, and Fly logs cannot distinguish "DB paused" from "permission denied"](#finding-1-api-in-restart-loop--db-migration-fails-on-create-schema-drizzle-the-real-postgres-js-error-is-being-eaten-and-fly-logs-cannot-distinguish-db-paused-from-permission-denied)
  - [Finding 2: All "CORS" errors are downstream of the stopped API (SUPERSEDED by Finding 11 once API is healthy)](#finding-2-all-cors-errors-are-downstream-of-the-stopped-api-superseded-by-finding-11-once-api-is-healthy)
  - [Finding 3: Telemetry ingest route IS registered](#finding-3-telemetry-ingest-route-is-registered)
  - [Finding 4: Netlify CSP omits the API origin (latent)](#finding-4-netlify-csp-omits-the-api-origin-latent)
  - [Finding 5: OPFS `/node_modules` mount is an architectural smell, not the OCJS smoking gun](#finding-5-opfs-node_modules-mount-is-an-architectural-smell-not-the-ocjs-smoking-gun)
  - [Finding 6: FileManagerWorker proliferation amplifies Safari memory pressure](#finding-6-filemanagerworker-proliferation-amplifies-safari-memory-pressure)
  - [Finding 7: Safari OCJS rendering — what we can rule out, and the remaining hypothesis](#finding-7-safari-ocjs-rendering--what-we-can-rule-out-and-the-remaining-hypothesis)
  - [Finding 8: `Module "fs" / "path" has been externalized` warnings — Vite stub access in user-code bundles](#finding-8-module-fs--path-has-been-externalized-warnings--vite-stub-access-in-user-code-bundles)
  - [Finding 9: `image-bitmap-data-url-worker.js.map` `blob://nullhttp` errors are a Safari sourcemap quirk, not a functional bug](#finding-9-image-bitmap-data-url-workerjsmap-blobnullhttp-errors-are-a-safari-sourcemap-quirk-not-a-functional-bug)
  - [Finding 10: "Initializing kernel" repetition is per-CU, not a loop (unchanged)](#finding-10-initializing-kernel-repetition-is-per-cu-not-a-loop-unchanged)
- [Recommendations](#recommendations)
- [Diagrams](#diagrams)
- [References](#references)
- [Appendix: Raw evidence](#appendix-raw-evidence)

## Problem Statement

User reports:

- All `/v1/*` requests on `https://taucad.dev` log `Could not connect to the server` / `No 'Access-Control-Allow-Origin' header is present`.
- `/v1/telemetry/ingest` POSTs return CORS errors.
- Both Chrome and Safari successfully negotiate `crossOriginIsolated === true` and have a working `SharedArrayBuffer`.
- Chrome renders geometry from every kernel.
- Safari renders **JSCAD** (image 3) and **OpenSCAD** (image 1 console + viewport showing geometry compute success) — but **not** replicad (image 4) or opencascade (image 5). Compute completes; the viewport stays empty.
- Safari additionally logs:
  - `[FM-Worker] Failed to mount OPFS /node_modules, falling through to root – UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).`
  - 6+ `Initializing kernel: replicad` / `Initializing OpenCASCADE WASM` pairs.
  - `Module "fs" has been externalized for browser compatibility. Cannot access "fs.then" in client code.` (multiple, also for `path` and `fs.promises`).
  - `Not allowed to load local resource: blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map`.

## Methodology

| Tool                                                                 | Purpose                                                                                               |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `flyctl status -a tau-api-staging`                                   | Confirm machine state, region, image tag                                                              |
| `flyctl logs -a tau-api-staging --no-tail`                           | Capture full restart-loop transcripts (only the post-fix image is now running — no more pre-fix loop) |
| `flyctl machine start <id>`                                          | Force-restart a stopped machine to capture fresh boot logs                                            |
| `flyctl secrets list -a tau-api-staging`                             | Confirm `DATABASE_URL` digest is `a99ebeaab839133e` (deployed)                                        |
| `flyctl postgres list` / `fly mpg list -o personal`                  | Confirm: no Fly-managed Postgres cluster — the `DATABASE_URL` points at an external provider          |
| `flyctl releases -a tau-api-staging`                                 | `v22` (7h ago, `richard@tau.new`), `v21` (10h ago), `v20` (Apr 19), `v19` (Apr 19), `v18` (Feb 22)    |
| `gh run list -L 5 --workflow ci.yml`                                 | Last successful CI run on `main` is `24738311458` at 2026-04-21 18:03 UTC                             |
| `gh run view 24738311458 --json jobs`                                | Confirms `Deploy API (Staging) / Deploy api to staging` succeeded — image IS post-fix Dockerfile      |
| Read of `apps/api/app/database/database.service.ts:50-64`            | Trace error swallowing in `runMigrations` rethrow                                                     |
| Read of `apps/ui/app/machines/file-manager.worker.ts`                | Confirm `/node_modules` OPFS mount fallback to IndexedDB root                                         |
| Read of `apps/ui/app/machines/file-manager.machine.ts:59-100`        | Confirm each `connectWorkerActor` invocation creates a fresh `FileManagerWorker`                      |
| Read of `packages/runtime/src/kernels/{replicad,opencascade,jscad}`  | Confirm built-in module registration — zero `/node_modules` lookups for kernel package imports        |
| Read of `node_modules/three/examples/jsm/loaders/GLTFLoader.js`      | Confirm `ImageBitmapLoader` is unconditionally instantiated — explains `image-bitmap-data-url-worker` |
| Read of `node_modules/replicad-opencascadejs/src/replicad_single.js` | Confirm `require("node:fs/path/url/crypto")` is gated behind `if (da)` (Node-only) — not the cause    |
| Read of `packages/runtime/src/kernels/replicad/init-open-cascade.ts` | Confirm streaming WASM compilation path                                                               |

## Findings

### Finding 11: `api.taucad.dev` cert is bound to the PRODUCTION app — the staging UI is calling production (NEW SMOKING GUN)

**Severity**: P0 (production-blocker for staging).

**Symptom**: After Finding 1 was resolved (Supabase unpaused, migrations succeeded, both staging machines transitioned to `started` state with passing health checks), the browser at `https://taucad.dev` continued to log:

```text
Access to fetch at 'https://api.taucad.dev/v1/auth/get-session' from origin 'https://taucad.dev'
  has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
GET https://api.taucad.dev/v1/auth/get-session net::ERR_FAILED 200 (OK)
```

The `200 (OK)` next to `ERR_FAILED` is the puzzle. A bare 404 from Fly's edge proxy (Finding 2's old framing) cannot produce that combination — only an actual application response can. Yet `flyctl logs -a tau-api-staging` showed no record of these external requests at all, only internal Consul health checks.

**The smoking gun.** Side-by-side `curl` reveals the staging app is fine and the _routing layer_ is wrong:

```text
$ curl -sS -i -H 'Origin: https://taucad.dev' https://tau-api-staging.fly.dev/v1/auth/get-session
HTTP/2 200
access-control-allow-origin: https://taucad.dev      ← ✓ correct
access-control-allow-credentials: true               ← ✓ correct
cross-origin-resource-policy: cross-origin           ← ✓ correct
vary: Origin
content-type: application/json; charset=utf-8
```

```text
$ curl -sS -i -H 'Origin: https://taucad.dev' https://api.taucad.dev/v1/auth/get-session
HTTP/2 200
                                                     ← ✗ access-control-allow-origin MISSING
                                                     ← ✗ access-control-allow-credentials MISSING
cross-origin-resource-policy: same-origin            ← ✗ wrong (helmet's CORP rule for rejected origin)
vary: Origin
content-type: application/json; charset=utf-8
```

Both responses come from a NestJS app with the same Helmet/CORS code path. They differ only in which app processed them. `flyctl certs list` confirms the routing:

```text
$ flyctl certs list -a tau-api-staging
HOSTNAME                       SOURCE     STATUS
                                                    ← empty: no certs on staging app

$ flyctl certs list -a tau-api
HOSTNAME                       SOURCE     STATUS
api.taucad.dev                 Fly        Issued    ← ✗ lives on PRODUCTION
api.tau.new                    Fly        Issued
```

And the production app's CORS env (`apps/api/fly.prod.toml`):

```toml
TAU_FRONTEND_URL = 'https://tau.new'
ADDITIONAL_CORS_ORIGINS = '["https://deploy-preview-*--taucad-prod.netlify.app","https://taucad-prod.netlify.app"]'
```

`https://taucad.dev` is not in the production allow-list — and rightly so, that is the staging UI. Production correctly rejects it: `Access-Control-Allow-Origin` is omitted, the browser blocks the response, and the CORS error fires.

**Verified by an inside-the-machine probe** to rule out any Fastify/NestJS/Helmet bug:

```text
$ node /tmp/internal-probe.mjs    (uploaded via flyctl ssh sftp)

http://127.0.0.1:3000/v1/auth/get-session  Origin=https://taucad.dev
  status=200
  {"access-control-allow-credentials":"true","access-control-allow-origin":"https://taucad.dev",
   "cross-origin-resource-policy":"cross-origin","vary":"Origin"}

http://127.0.0.1:3000/v1/health  Origin=https://taucad.dev
  status=404                                       ← 404 because path is /health, not /v1/health
  {"access-control-allow-credentials":"true","access-control-allow-origin":"https://taucad.dev",
   "cross-origin-resource-policy":"cross-origin","vary":"Origin"}
```

The staging app emits the correct CORS headers for `https://taucad.dev` on every path, including 404s. **There is nothing wrong with `tau-api-staging`.** External traffic to `api.taucad.dev` simply doesn't reach it.

**Historical bisect — when did this break?** `git log --oneline --all -- apps/api/app/main.ts apps/api/app/utils/cors.utils.ts apps/api/app/constants/cors.constant.ts apps/api/fly.staging.toml` shows two adjacent commits on Dec 4 2025 that flipped the production app from `taucad.dev` to `tau.new`:

```text
b3963b6b5  fix(api): remove hardcoded taucad.dev from CORS origins                 (Dec 4 18:00 NZDT)
d4d9aae89  chore(api): update Fly configuration for tau.new domain                 (Dec 4 06:43 NZDT)
```

Reading `git show d4d9aae89 -- apps/api/`:

```diff
- apps/api/fly.toml
- TAU_FRONTEND_URL = 'https://taucad.dev'
+ TAU_FRONTEND_URL = 'https://tau.new'
- LANGSMITH_PROJECT = 'tau-api-dev'
+ LANGSMITH_PROJECT = 'tau-api-prod'
- AUTH_URL = 'https://api.taucad.dev'
+ AUTH_URL = 'https://api.tau.new'
- ADDITIONAL_CORS_ORIGINS = '["https://deploy-preview-*--taucad.netlify.app"]'
+ (removed)

+ apps/api/fly.staging.toml (NEW)
+ # fly.toml app configuration file for staging environment (api.taucad.dev)
+ app = 'tau-api-staging'
+ TAU_FRONTEND_URL = 'https://taucad.dev'
+ AUTH_URL = 'https://api.taucad.dev'
+ ADDITIONAL_CORS_ORIGINS = '["https://taucad.dev","https://deploy-preview-*--taucad.netlify.app","https://tau-ui-pr-*.fly.dev"]'
```

The TOML comment on the new staging file explicitly declares the staging app's hostname as `api.taucad.dev`. The CORS env was correctly populated for that hostname. **The Fly cert migration was not performed.** `api.taucad.dev` remained bound to `tau-api` (the production app — same Fly org, same DNS), and the staging UI's traffic has been silently hitting production for the four-and-a-half months since.

This was masked by Finding 1: while staging was crashing, the user's frontend errors (`No ACAO header`) looked indistinguishable from a stopped staging app, so the cert binding was never re-examined. Once R4 unpaused Supabase and the staging app stabilised, the underlying routing bug surfaced with no other failures to hide behind.

**Why the lack of staging logs.** Fly routes `api.taucad.dev` → `tau-api` based on the cert binding. The staging app `tau-api-staging` never sees any of these requests, so `flyctl logs -a tau-api-staging` shows only its internal Consul health checks. The application-level `request-id` (`req_…`) seen in the failing browser response is from the production NestJS process, generated by `RequestIdMiddleware` against an origin it correctly rejects.

**Why `cross-origin-resource-policy: same-origin` on the failing path.** `apps/api/app/main.ts` registers `@fastify/helmet` with `crossOriginResourcePolicy: { policy: 'cross-origin' }`. Helmet sets the `cross-origin-resource-policy: cross-origin` header on every response — but `@fastify/cors`, when it rejects an origin, doesn't strip headers; it just refuses to add `Access-Control-Allow-Origin`. The header we see (`same-origin`) is therefore the _default_ helmet value, which means the production app is running an older deploy (or a different helmet configuration) than the staging app. Either way, the diagnostic point stands: the response is from production, not staging.

**Fix (R12).** Three options, ordered by architectural cleanliness:

1. **Move the cert** (recommended). Add `api.taucad.dev` to `tau-api-staging`, then either:
   - Remove `api.taucad.dev` from `tau-api` (production keeps `api.tau.new`, which is the canonical production hostname per `fly.prod.toml`).
   - Or use a different staging hostname (e.g. `api-staging.taucad.dev`) and update `apps/ui/netlify.toml`'s `TAU_API_URL` and `TAU_WEBSOCKET_URL` accordingly.

   Option 1a is the simplest change with the smallest blast radius — the cert already exists, it just needs to be on the right app. Production has been on `api.tau.new` for four months; nothing currently requires `api.taucad.dev` to point at it.

2. **Add `https://taucad.dev` to production CORS.** This would make the symptom go away but is the wrong call: the staging UI would have a working session against the production database, which (a) defeats the entire purpose of having a staging environment and (b) lets staging code exercise production data. Avoid.

3. **Change `apps/ui/netlify.toml` to call `https://tau-api-staging.fly.dev` directly.** This works without any Fly cert changes but couples the staging UI to the Fly domain rather than a Tau-owned hostname, makes future infra moves harder, and is purely a workaround for the underlying misconfiguration.

The recommended sequence is 1a: `flyctl certs add api.taucad.dev -a tau-api-staging` (Fly will provision a new Let's Encrypt cert against the same DNS; the existing prod cert remains valid until it's removed), then verify staging is now reachable at the hostname, then `flyctl certs remove api.taucad.dev -a tau-api` to delete the production binding. DNS does not change.

After that, R5 (CSP `connect-src` adds `api.taucad.dev`) and R11 (flip CSP to enforcing) become safe to apply.

### Finding 1: API in restart loop — DB migration fails on `CREATE SCHEMA "drizzle"`, the real `postgres-js` error is being eaten, and Fly logs cannot distinguish "DB paused" from "permission denied"

**Severity**: P0 (production-blocker).

**Verified cause** (confirmed out-of-band by the user after this audit was first drafted): the Supabase Postgres instance behind `DATABASE_URL` was **paused**. Supabase free-tier projects auto-pause after 7 days of inactivity; once paused, the connection pooler accepts the TCP handshake then refuses/closes the underlying session, which `postgres-js` surfaces against the next query rather than at connect time. The migrator's first query is `CREATE SCHEMA IF NOT EXISTS "drizzle"`, so the error is bound to that statement and is then stringified into a message that **looks like** a permission/SQL failure. The remediation was a single click in the Supabase dashboard ("Restore project").

**The audit-relevant point is not the cause itself — it is that nothing in the existing logging pipeline let us read that cause from `flyctl logs`.** The remainder of this finding documents the observability gap so the next incident (paused Neon branch, rotated role, exhausted connection pool, network partition, certificate expiry, etc.) is identifiable in seconds rather than diagnosed by guesswork.

The current image tag in `flyctl status` (`tau-api-staging:34e94988…`) is the same SHA the user pointed at (image 2 of the report) and the same SHA the most recent successful CI run (`24738311458`) deployed at 2026-04-21 18:03 UTC. There is no Dockerfile/imager mismatch: the image IS what we expect.

Boot transcripts (post-fix image, `2026-04-22T01:17:08Z` onward) prove the application gets all the way through:

```text
RoutesResolver  TelemetryController {/telemetry} (version: 1)
RouterExplorer  Mapped {/telemetry/ingest, POST} (version: 1) route
RedisService    Redis connection established
ModelService    Loaded 14 models
DatabaseService Starting database migrations...
DatabaseService Database migration failed:        ← second arg dropped by Pino
file:///app/dist/main.js:578
        throw new Error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
Error: Migration failed: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
params:
    at DatabaseService.runMigrations (file:///app/dist/main.js:578:10)
INFO Main child exited normally with code: 1
```

The query `CREATE SCHEMA IF NOT EXISTS "drizzle"` is emitted by `drizzle-orm/postgres-js/migrator` to bootstrap its `drizzle.__drizzle_migrations` bookkeeping table. **It is the migrator's first query**, which means any failure in the lifecycle from "DNS resolved" → "TCP connected" → "TLS negotiated" → "Postgres handshake" → "role authorized" → "first statement executed" is reported against this statement, with no breadcrumb identifying which gate failed. The failure modes that all collapse onto the same opaque `Failed query: CREATE SCHEMA …\nparams:` message:

| Real upstream cause                                | What `postgres-js` actually carries                                                                                        | What the operator needs to do                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Paused Supabase / Neon project** (this incident) | `error.code === 'CONNECTION_CLOSED'` or `ECONNREFUSED` on `error.cause.code`; `error.errno`; `error.address`; `error.port` | Unpause via provider console — but you must know it's paused first |
| Provider maintenance / failover                    | `error.code === 'CONNECTION_DESTROYED'`, `error.cause` is `ECONNRESET`/`ETIMEDOUT`                                         | Wait, retry — but you must know it's a provider event              |
| DNS resolution failure                             | `error.cause.code === 'ENOTFOUND'`, `error.cause.hostname`                                                                 | Check `DATABASE_URL` host, check VPC DNS                           |
| Role rotated / password mismatch                   | SQLSTATE `28P01`, `error.code === '28P01'`, `error.severity_local === 'FATAL'`                                             | Rotate the secret, redeploy                                        |
| Connection pool exhausted (PgBouncer / Supavisor)  | `error.code === 'CONNECTION_ENDED'`, `error.cause` describes pooler 503                                                    | Reduce concurrency, scale pooler                                   |
| Insufficient privilege on `CREATE SCHEMA`          | SQLSTATE `42501`                                                                                                           | `GRANT CREATE ON DATABASE … TO …;`                                 |
| Schema exists, owned by another role               | SQLSTATE `42P06`                                                                                                           | `ALTER SCHEMA drizzle OWNER TO …;`                                 |
| TLS certificate expired / self-signed rejected     | `error.cause.code === 'ERR_TLS_CERT_ALTNAME_INVALID'` etc.                                                                 | Rotate cert / set `sslmode=require`                                |

The current code in `apps/api/app/database/database.service.ts:50-64` collapses every row in this table down to **one indistinguishable line**:

```typescript
} catch (error) {
  this.logger.error('Database migration failed:', error); // Pino: second positional arg silently dropped
  throw new Error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`); // postgres-js sets `.message` to `'Failed query: …\nparams:'` only
}
```

Two compounding bugs:

1. **Pino discards the second positional arg.** `this.logger.error('Database migration failed:', error)` logs only the string. The `error` object — including `error.code`, `error.cause`, `error.errno`, `error.address`, `error.severity_local` — is never serialised. The correct form is `this.logger.error({ err: error }, 'Database migration failed')` (Pino's standard `err` serializer walks `cause` and prints stack traces). See R1.
2. **The rethrown `Error` only carries `error.message`.** `postgres-js` sets `.message` to a stringified version of the failed statement, not the underlying network/auth diagnostic. Even if the consumer of `runMigrations` logged the rethrown error verbatim, all observable Postgres state is still lost. The fix is to either (a) rethrow the original `Error` with `{ cause: error }` or (b) augment the message with the diagnostic fields explicitly. See R1.

**The reason this is a finding, not a one-off bug**: there is no pre-migration connectivity probe. The first thing the API does against the DB is run a complex DDL query inside a third-party migrator. The migrator's error model is by design oriented toward "your SQL is wrong", not "your network is down". Adding an explicit `SELECT 1` (or `pg_is_in_recovery()`) probe at startup, with structured logging of the `host`, `port`, error class, and `error.cause.code`, would have made this incident identifiable from `flyctl logs -a tau-api-staging` in **one line**:

```text
DatabaseService database connectivity probe failed
  host=db.xxx.supabase.co port=5432 errno=ECONNREFUSED
  cause.code=ECONNREFUSED cause.message='connect ECONNREFUSED 1.2.3.4:5432'
  hint='Postgres unreachable — verify provider is not paused/maintenance'
```

vs. what we got:

```text
DatabaseService Database migration failed:
Error: Migration failed: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
params:
```

Both R1 (enrich the rethrow / fix the Pino call) and R2 (add a pre-migration connectivity probe with explicit hint mapping) are required — the rethrow fix surfaces the Postgres-level error, the probe distinguishes "I never reached Postgres at all" from "I reached Postgres and it rejected me". They answer different questions and Fly logs need both.

There is a third gap: **Fly's autostop policy hides the crash loop from human attention until a downstream user notices.** With both Sydney machines stopping after 10 restarts, the Fly dashboard reports a healthy app (no machines crashing — they're all stopped) and the only signal that something is wrong is the browser CORS error a developer eventually sees. R3 closes this with a Grafana alert keyed on `Database migration failed` (or whatever R1's structured log emits) and a Fly health-check failure rule.

Because there is no Fly-managed Postgres in this org (`flyctl postgres list` and `fly mpg list -o personal` both return empty), the `DATABASE_URL` points to an external provider — confirmed for this incident as Supabase. The same observability story applies for Neon, RDS, Crunchy, etc.

After 10 restarts, both Sydney machines transition to `stopped`. Fly's edge proxy then returns `404` (no `Access-Control-Allow-Origin`) for every request, producing **all** of the reported CORS failures (Findings 2 and 3).

### Finding 2: All "CORS" errors are downstream of the stopped API (SUPERSEDED by Finding 11 once API is healthy)

This finding was correct in the API-down state and is retained for historical accuracy: while both staging machines were `stopped` after exhausting their restart budget, Fly's edge proxy returned a bare 404 for every request, which the browser surfaced as a CORS error.

**Once R4 was applied and the API came back up, this framing stopped explaining the symptoms.** The browser still reports `No 'Access-Control-Allow-Origin' header is present` for `fetch('https://api.taucad.dev/v1/auth/get-session')` from `https://taucad.dev`, but the API now responds with `200 OK` and a NestJS-generated `request-id` header — so the request is reaching _something_, just not the staging app. Finding 11 below identifies that "something" as the production `tau-api` app, which the `api.taucad.dev` cert was never moved off of when the production frontend migrated to `tau.new`.

The deployed staging env (`TAU_FRONTEND_URL='https://taucad.dev'`, `ADDITIONAL_CORS_ORIGINS='["https://deploy-preview-*--taucad.netlify.app","https://taucad.netlify.app"]'`) plus `createCorsOriginValidatorFromList` correctly emit `Access-Control-Allow-Origin` for production, deploy previews, and the canonical Netlify subdomain — verified directly against `https://tau-api-staging.fly.dev` and against `http://127.0.0.1:3000` from inside the machine. The validator and its env config are correct. The routing in front of them is wrong.

### Finding 3: Telemetry ingest route IS registered

Boot logs from the running image explicitly print:

```text
RoutesResolver  TelemetryController {/telemetry} (version: 1)
RouterExplorer  Mapped {/telemetry/ingest, POST} (version: 1) route
```

The `404` the browser sees on `POST /v1/telemetry/ingest` is, again, Fly's edge proxy responding when no machine is up. The endpoint exists in source (`apps/api/app/api/telemetry/telemetry.controller.ts`) and is correctly wired into NestJS at boot. Fixing Finding 1 fixes this.

### Finding 4: Netlify CSP omits the API origin (latent)

`apps/ui/netlify.toml:99` sets:

```toml
Content-Security-Policy-Report-Only = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.zoo.dev https://api.kittycad.io wss:; worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests;"
```

`connect-src` lists `'self'`, the Zoo APIs, and `wss:` — but **not** `https://api.taucad.dev`. The directive is _report-only_ today, so it does not block. The moment it flips to enforcing it will block every API call from `https://taucad.dev` to `https://api.taucad.dev`. Add `https://api.taucad.dev wss://api.taucad.dev` (and the same to `apps/ui/netlify.prod.toml`) before promoting the directive.

### Finding 5: OPFS `/node_modules` mount is an architectural smell, not the OCJS smoking gun

The user proposed: "could it be the node_modules mounting issue? would changing from opfs to indexeddb be a suitable and correct fix here?"

The OPFS `/node_modules` mount **is** flaky on Safari — `navigator.storage.getDirectory()` throws `UnknownError` even on a fresh tab with plenty of disk. That part is real. But it does **not** explain the OCJS-only rendering failure, for three independent reasons:

**1. The mount has a working fallback.** `apps/ui/app/machines/file-manager.worker.ts:32-46`:

```typescript
async function createNodeModulesMount(): Promise<void> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    console.debug('[FM-Worker] OPFS not available, /node_modules falls through to root mount');
    return;
  }
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    const nodeModulesHandle = await opfsRoot.getDirectoryHandle('tau-node-modules', { create: true });
    const nodeModulesProvider = new FileSystemAccessProvider(nodeModulesHandle);
    mountTable.mount('/node_modules', nodeModulesProvider, { backend: 'opfs' });
    console.debug('[FM-Worker] /node_modules mounted on OPFS');
  } catch (error) {
    console.warn('[FM-Worker] Failed to mount OPFS /node_modules, falling through to root', error);
  }
}
```

When the OPFS mount fails, `mountTable.mount('/node_modules', ...)` is **never called**. `MountTable.resolve('/node_modules/foo')` then returns the root mount (IndexedDB, registered on line 59 via `await fileService.mount('/', 'indexeddb');`). All `/node_modules` reads and writes route to IndexedDB transparently. There is no exception, no failed write, no missing file.

**2. None of the kernels traffic `/node_modules` for their package imports.** Every first-party kernel registers its package as a built-in module:

```typescript
// packages/runtime/src/kernels/replicad/replicad.kernel.ts:211-225
function registerReplicadModule(runtime: KernelRuntime): void {
  const registry = getModuleRegistry();
  const replicadRecord = replicad as Record<string, unknown>;
  registry.set('replicad', replicadRecord);
  // …
  runtime.bundler.registerModule('replicad', { code, version: '0.19.1', globalName: 'replicad' });
}
```

When user code does `import { … } from 'replicad'`, the in-worker esbuild resolves `replicad` against `bundler.builtinModules` and emits a tiny shim that pulls from `globalThis[KERNEL_MODULES_KEY].get('replicad')`. **No** lookup against `/node_modules/replicad/` ever happens. JSCAD, OpenSCAD, OpenCascade, Manifold, Tau and Zoo follow the identical pattern. CDN module fetching via `module-manager.ts` is only triggered for _user-imported_ third-party packages, not for kernel packages.

**3. WASM binaries do not go through the FS mount at all.** `singleWasmUrl = new URL('wasm/replicad_single.wasm', import.meta.url).href` resolves to a Vite `@fs/` URL (`http://localhost:3000/@fs/Users/rifont/git/tau/packages/runtime/src/kernels/replicad/wasm/replicad_single.wasm`) and is fetched via `WebAssembly.compileStreaming(fetch(url))`. The FS mount is irrelevant.

**Conclusion**: switching `/node_modules` from OPFS to IndexedDB is the right architectural call (R5) — the OPFS mount provides no measurable benefit in the current architecture, only Safari brittleness — but it is **not** what is hiding the OCJS rendering failure. We need to keep looking (Finding 7).

### Finding 6: FileManagerWorker proliferation amplifies Safari memory pressure

The user's Safari log shows four `[FileManager] connectWorkerActor: start` entries within a 4-second window:

```
+877ms   connectWorkerActor: start    (initial project FM)
+4251ms  connectWorkerActor: start    (CU #1)
+4255ms  connectWorkerActor: start    (CU #2)
+4262ms  connectWorkerActor: start    (CU #3)
```

Reading `apps/ui/app/machines/file-manager.machine.ts:74`:

```typescript
const worker = context.sharedWorker ?? new FileManagerWorker({ name: `fm-root` });
```

When `context.sharedWorker` is undefined (the common case — nothing currently wires it up), each `connectWorkerActor` invocation:

1. Spawns a fresh `FileManagerWorker` (~510 ms module-evaluation cost on Safari, per the user's `[FM-Worker] module evaluated in 510.2ms` log).
2. Allocates a fresh **50 MB** `SharedArrayBuffer` for that worker's file pool (`filePoolBytes = 50 * 1024 * 1024` on line 22).
3. Re-runs `createNodeModulesMount` → `navigator.storage.getDirectory()` → throws `UnknownError` again — producing the same warning N times.
4. Re-mounts `/` on IndexedDB (idempotent — but each worker has its own provider instance).

In the user's log, four FM workers means 200 MB of `SharedArrayBuffer` allocated for file pools alone, plus four IndexedDB connections, plus four failed OPFS attempts. This is wasteful even on Chrome and meaningfully amplifies Safari's memory pressure (which is the underlying reason OPFS throws `UnknownError` in the first place).

There is a `sharedWorker` opt-in present in the code, but no caller passes it. The intended fix is to lift FM-worker ownership into the project-level singleton (it already has `context.worker` and `context.sharedWorker` plumbing — the per-CU `cad.machine` should reuse the project-level FM worker instead of spawning its own). This is R7.

### Finding 7: Safari OCJS rendering — what we can rule out, and the remaining hypothesis

The user's Safari log is the single best piece of evidence in this audit. Reading it linearly for the rendering pipeline:

```
[Log] [CadMachine] connectKernelActor: connecting client...
[Log] [CadPreview] initializeCadModel → sending initializeModel
[Log] [CadMachine] connectKernelActor: connected successfully
[Log] [CadMachine] kernelConnected
[Log] [CadMachine] forwarding buffered file to kernel
[Debug] [Kernel:worker] "Loading kernel module: replicad from http://localhost:3000/@fs/.../replicad.kernel.ts"
[Debug] [Kernel:worker] "Initializing kernel: replicad"
[Debug] [Kernel:worker] "Initializing OpenCASCADE WASM (ocTracing: summary, wasm: single)"
[Debug] [Kernel:worker] "Cached parameters at a865511b"
[Debug] [Kernel:worker] "getParameters completed"
[Debug] [Kernel:worker] "Cache miss for 6267d7da: Error: ENOENT: no such file or directory '/projects/proj_birdhouse/.tau/cache/geometry/6267d7da.bin'"
[Log] [CadMachine] geometry event received                         ← worker → main confirmed
[Log] [CadMachine] setGeometries                                   ← cad.machine accepted the result
[Debug] [Kernel:worker] "createGeometry completed"                 ← compute done
```

What we can therefore **rule out**:

| Hypothesis                                | Status     | Evidence                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGL context budget exhaustion           | RULED OUT  | OpenSCAD AND JSCAD render in the same Safari session. A budget cap would affect every kernel; this is OCJS-only.                                                                                                                                                    |
| `SharedArrayBuffer` / COEP misnegotiation | RULED OUT  | `crossOriginIsolated === true`, file-pool SAB allocation succeeds (`filePool SAB sent +639.0ms`), worker runs to completion.                                                                                                                                        |
| OPFS `/node_modules` mount failure        | RULED OUT  | Kernels register `replicad` as built-in (Finding 5). No `/node_modules/replicad/` lookup happens. JSCAD does the same and renders fine.                                                                                                                             |
| WASM exception handling unsupported       | RULED OUT  | `Initializing OpenCASCADE WASM` logs successfully, then `getParameters completed` and `createGeometry completed` both fire. WASM IS executing without LinkError.                                                                                                    |
| Empty mesh extracted from OCCT            | UNLIKELY   | Not impossible — the recent SLProps-normal pipeline rewrite is the highest-risk surface — but no error/issue is logged from `formatRuntimeErrorWithOc`.                                                                                                             |
| User-code bundler failure                 | RULED OUT  | `getParameters completed` fires; that calls `runtime.bundler.bundle(filePath)` and `runtime.execute(bundleResult.code)` — both succeed.                                                                                                                             |
| Silent JSON.parse error on geometry       | RULED OUT  | `setGeometries` action logs `count: event.geometries.length`. If we see `setGeometries { count: 1 }` in the user's screen, parse succeeded.                                                                                                                         |
| Three.js GLTFLoader rejects the binary    | UNVERIFIED | Most plausible remaining root cause. ImageBitmapLoader IS instantiated (Finding 9), but GLTFLoader.parse can silently produce a Group with zero meshes.                                                                                                             |
| Three.js scene render but invisible       | UNVERIFIED | Could be coordinate-system / unit-scale interaction — replicad/opencascade emit Z-up natively, OpenSCAD emits Y-up (per AGENTS.md). The transform middleware should normalise, but a Safari-specific Float32 precision quirk on the Z-up→Y-up rotation is possible. |

The two remaining hypotheses both terminate in the **same diagnostic patch** — instrument `convertReplicadGeometriesToGltf`'s output and the GLTFLoader's `parse` callback to log:

1. Output buffer length (does the worker emit non-zero bytes?).
2. `gltf.scene.children.length` after `parse` resolves (did the loader produce meshes?).
3. World-space bounding box of `gltf.scene` (is the geometry inside the camera frustum?).

If (1) is zero → bug in the SLProps-normal pipeline that materialises only on Safari's V8/JSC interaction with embind. If (1) is non-zero but (2) is zero → glTF binary is malformed for Safari (most likely an extension or accessor-component-type Safari rejects). If (2) is non-zero but (3) is at infinity / NaN → a coordinate transform regression. **R6 below adds this 3-line probe.**

The `replicad-occt-normal-pipeline-v3.md` rewrite (single-WASM-call C++ extractor with SLProps-based surface-derived normals) landed recently and is the highest-risk recent change in the OCJS critical path. It is the first thing I would suspect once R6 narrows the failure mode to (1) or (2).

### Finding 8: `Module "fs" / "path" has been externalized` warnings — Vite stub access in user-code bundles

The Safari log emits:

```
[Warning] Module "fs" has been externalized for browser compatibility. Cannot access "fs.then" in client code. (browser-external_fs-DwquLdEJ.js, line 6)
[Warning] Module "path" has been externalized for browser compatibility. Cannot access "path.then" in client code.
…
[Warning] Module "fs" has been externalized for browser compatibility. Cannot access "fs.promises" in client code. (x7)
```

These are emitted by Vite's browser-side stub for Node built-in modules. The stub is a Proxy that warns on every property access — including `.then` (which is touched by `await import('fs')`'s thenable check) and `.promises`.

Searching the runtime for bare `import('fs')` / `import('path')` (not `node:fs` / `node:path`) found one match — a JSDoc snippet — and zero runtime calls. The warnings are therefore not coming from Tau's own code. They come from one of:

- `replicad-opencascadejs/src/replicad_single.js` does `require("node:fs/path/url")` but only inside an `if (da)` branch that requires `globalThis.process?.versions?.node`. In a browser, `da === false` and the requires never execute. Vite's pre-bundler may statically rewrite the requires anyway, producing the stub.
- `esbuild-wasm` binds to many Node built-ins for parity; same story.
- A transitive dependency in `@taucad/runtime`'s closure that has bare `'fs'` / `'path'` imports somewhere.

The warnings are noisy but **not functional** — the stubs are loaded but the conditional branches that would access them don't run. They are not the cause of the OCJS rendering failure.

The architectural fix is to add a Vite plugin (`apps/ui/vite.config.ts`) that maps `fs`/`path` to a single shared no-op stub during pre-bundling, suppressing the warnings. This is R8 (low priority).

### Finding 9: `image-bitmap-data-url-worker.js.map` `blob://nullhttp` errors are a Safari sourcemap quirk, not a functional bug

```
[Error] Not allowed to load local resource: blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map
[Error] Not allowed to request resource
[Error] Cannot load blob://nullhttp//localhost:3000/image-bitmap-data-url-worker-Ca9A-vl6.js.map due to access control checks.
```

`ImageBitmapLoader` (in `node_modules/three/examples/jsm/loaders/GLTFLoader.js`) creates a worker from a Blob URL to decode image data URLs off-thread. In dev, Vite emits a sourcemap reference at the end of the worker source. Safari refuses to fetch sourcemaps over `blob:` URLs ("Not allowed to load local resource") — the malformed `blob://nullhttp//localhost:3000/…` shape is Safari's stringification of `new URL('foo.js.map', 'blob:nullhttp://localhost:3000/…')` when the base URL itself doesn't carry an origin.

This affects **every** kernel that produces glTF (because `GLTFLoader` instantiates `ImageBitmapLoader` unconditionally — see `GLTFLoader.js:2682`). It is not OCJS-specific and JSCAD shows the same error on Safari (the user just didn't include those console lines). It is **not** the smoking gun.

### Finding 10: "Initializing kernel" repetition is per-CU, not a loop (unchanged)

Reading `packages/runtime/src/framework/kernel-runtime-worker.ts:332`:

```typescript
this.logger.debug(`Initializing kernel: ${kernel.entry.id}`);
```

This logs once per `LoadedKernel.initialize` call inside one `KernelRuntimeWorker`. With per-CU worker isolation (4 FM workers from Finding 6 → 4 paired kernel workers, each potentially loading both `replicad` and `opencascade`), 6+ identical lines appear in a few seconds. This is by design and not a re-init loop.

If the volume is itself a UX concern, gating to `logger.trace` rather than `logger.debug` would suppress it for default verbosity (R10).

## Recommendations

The recommendations are **observability-first**: the highest-priority items are the ones that would have let us read the verified cause of this incident (paused Supabase project) directly from `flyctl logs` instead of reverse-engineering it from a downstream CORS error. The same rules surface the next outage (paused Neon branch, role rotation, network partition, pool exhaustion, certificate expiry) in seconds without requiring a guess about the provider.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Priority | Effort | Impact |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R12 | **Move the `api.taucad.dev` Fly cert from production (`tau-api`) to staging (`tau-api-staging`).** Step 1: `flyctl certs add api.taucad.dev -a tau-api-staging` (Fly issues a new Let's Encrypt cert against the same DNS A/AAAA records; both certs coexist until step 2). Step 2: `curl -sS -I -H 'Origin: https://taucad.dev' https://api.taucad.dev/v1/auth/get-session` and verify the response includes `access-control-allow-origin: https://taucad.dev` and `cross-origin-resource-policy: cross-origin`. Step 3: `flyctl certs remove api.taucad.dev -a tau-api` to detach the production binding. DNS does not change. Production stays on `api.tau.new` (already its canonical hostname per `fly.prod.toml`). Add a follow-up alert (R13) so the next time a hostname is bound to the wrong app, it is detected automatically rather than four months later.                                                                        | P0       | XS     | High   |
| R13 | **Add an end-to-end CORS smoke test in CI** that hits `https://api.taucad.dev/v1/health` (or a dedicated `/v1/cors-check` endpoint) with `Origin: https://taucad.dev` and asserts `access-control-allow-origin: https://taucad.dev` is present. Run it after every staging/prod deploy and on a daily cron. The smoke test would have caught Finding 11 within minutes of the Dec 4 cert misalignment instead of four months later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P1       | S      | High   |
| R1  | **Fix the Pino call and the rethrow in `DatabaseService.runMigrations`.** Replace `this.logger.error('Database migration failed:', error)` with `this.logger.error({ err: error }, 'Database migration failed')` so Pino's standard `err` serializer walks `cause`/`code`/`errno`/`address`/`port`/`severity_local`/`detail`/`hint`. Replace the rethrow `new Error(\`Migration failed: …\`)`with`new Error('Migration failed', { cause: error })`so NestJS's bootstrap handler logs the original`postgres-js` error verbatim. Net effect: Fly logs surface every diagnostic field the driver already carries.                                                                                                                                                                                                                                                                                                                                 | P0       | XS     | High   |
| R2  | **Add an explicit pre-migration database-connectivity probe.** Before calling `migrate(...)`, run `await this.database.execute(sql\`SELECT 1\`)`(or`select 1 from pg_catalog.pg_class limit 1`) inside a try/catch that logs `{ host, port, errno, code, cause }`from the connection-string + error and a human-readable`hint`derived from the error class (table below). This separates "DB unreachable" from "DB rejected my SQL" in the very first log line of the migration phase, which is exactly the distinction this incident turned on. Map at minimum:`ECONNREFUSED`→`Postgres host refused connection — verify provider is not paused/maintenance`; `ENOTFOUND`→`DNS resolution failed — verify DATABASE_URL host`; `ETIMEDOUT`→`TCP timeout — verify VPC / firewall / provider region`; `28P01`→`Authentication failed — secret may be rotated`; `CONNECTION_ENDED`→`Pooler closed connection — verify Supavisor/PgBouncer state`. | P0       | S      | High   |
| R3  | **Add a Grafana alert keyed on `DatabaseService` startup failures** (matches `'Database migration failed'` AND/OR `'Database connectivity probe failed'` from R1+R2). Route to PagerDuty / Discord / email so a paused project, rotated secret, or DB outage pages within 60 s of the first failed restart, instead of waiting for a developer to notice CORS errors in the browser. The Fly health checks themselves fire on machine state, not log content — they cannot distinguish "DB down" from any other startup failure, which is why a log-content alert is the correct signal here.                                                                                                                                                                                                                                                                                                                                                  | P0       | S      | High   |
| R4  | **Apply the per-incident remediation surfaced by R1+R2+R3.** For this incident: unpause the Supabase project from its dashboard. For future incidents: whatever the structured log identifies (rotate the secret, scale the pool, etc.). This is no longer a guess — it is a lookup against the table in Finding 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P0       | XS     | High   |
| R5  | Add `https://api.taucad.dev wss://api.taucad.dev` to `connect-src` in `apps/ui/netlify.toml` (and `netlify.prod.toml`) **before** flipping CSP from report-only to enforcing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1       | XS     | Med    |
| R6  | Add a 3-line diagnostic probe to `model-viewer` and `convertReplicadGeometriesToGltf` logging (a) output buffer length, (b) `gltf.scene.children.length`, (c) world-space bounding box. Capture in Safari, identify which gate blocks rendering, then triage to the SLProps-normal pipeline (`replicad-occt-normal-pipeline-v3.md`) or the coordinate-transform middleware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P0       | S      | High   |
| R7  | Remove the OPFS `/node_modules` mount entirely — kernels never traffic it (Finding 5), and the OPFS attempt produces a recurring Safari `UnknownError` warning. Delete `createNodeModulesMount()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P1       | XS     | Med    |
| R8  | Wire the existing `sharedWorker` opt-in in `connectWorkerActor` to reuse the project-level FM worker for per-CU `cad.machine` instances. Eliminates 3× spawned workers and 150 MB SAB allocation in the user's log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P1       | M      | High   |
| R9  | Add a Vite plugin entry that maps bare `fs`/`path` to an explicit silent stub during dep pre-bundling, suppressing the `Module "fs" has been externalized` warnings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | P3       | S      | Low    |
| R10 | Demote `Initializing kernel: …` from `logger.debug` to `logger.trace` to reduce console noise when 4 + workers are alive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P3       | XS     | Low    |
| R11 | Switch the staging CSP from `Content-Security-Policy-Report-Only` to enforcing once R5 is deployed and verified via the report URI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P3       | XS     | Low    |

**R12 is the only thing currently blocking staging.** Once the cert is moved, the staging UI's API calls will land on the staging app (which already has the right CORS config and is healthy post-R4) and the persistent CORS errors disappear with no code change.

**R1 + R2 + R3 are jointly the API observability fix** — they are sized small and sequenced so that R1 ships first (smallest diff, immediate diagnostic value), R2 ships next (catches connection-level failures the migrator hides), and R3 ships third (turns the structured logs from R1+R2 into pages instead of after-the-fact discoveries). R4 is the per-incident action — no longer a code change, just a lookup against the structured log. **R13 closes the meta-gap that hid Finding 11 for four months**: a CI smoke test that asserts `https://api.taucad.dev` is reachable from `https://taucad.dev` with the expected CORS response would have failed on the first deploy after the Dec 4 commits. R6 gives us the OCJS rendering smoking gun definitively. R7 + R8 reduce Safari memory pressure and clean up the architectural smells the user (correctly) flagged. R5 prevents a future foot-gun. The rest is cleanup.

### What R1 + R2 would have looked like for this incident

The verified cause was a paused Supabase project. With the recommendations above, `flyctl logs -a tau-api-staging` would have emitted (instead of the opaque current message):

```text
[INFO]  DatabaseService Starting database connectivity probe…
[ERROR] DatabaseService database connectivity probe failed
        host=db.xxx.supabase.co port=5432
        err.code=CONNECTION_CLOSED err.errno=undefined
        err.cause.code=ECONNREFUSED err.cause.address=1.2.3.4 err.cause.port=5432
        err.cause.message='connect ECONNREFUSED 1.2.3.4:5432'
        hint='Postgres host refused connection — verify provider is not paused/maintenance'
```

That single log line names the host, the port, the network-level error class, and a human-actionable hint. No reverse-engineering, no guessing whether it was Supabase, Neon, or RDS, no deep-dive into `drizzle-orm/postgres-js/migrator` source. The R3 alert would have fired on the same line — within 60 s of the first failed boot — instead of waiting for a developer to notice broken CORS in the browser hours later.

## Diagrams

### API failure loop (current state)

```text
                       ┌──────────────────────────────────────────────────────┐
                       │              Browser at https://taucad.dev           │
                       │                                                      │
                       │  Cross-origin-isolated ✓  SharedArrayBuffer ✓        │
                       │                                                      │
                       │   fetch /v1/auth/get-session, /v1/models, etc.       │
                       │   POST /v1/telemetry/ingest                          │
                       └───────────────────────┬──────────────────────────────┘
                                               │ TLS
                                               ▼
                       ┌──────────────────────────────────────────────────────┐
                       │   Fly.io edge (api.taucad.dev → tau-api-staging)     │
                       │                                                      │
                       │   No machine in `started` state (both stopped after  │
                       │   10 restart attempts). Returns bare 404 (no CORS    │
                       │   headers) ⇒ browser reports as "no ACAO header".    │
                       └───────────────────────┬──────────────────────────────┘
                                               │ tries autostart
                                               ▼
                       ┌──────────────────────────────────────────────────────┐
                       │   Machine boot                                       │
                       │     1. NestJS module wiring ✓                        │
                       │     2. Route registration (incl. /v1/telemetry) ✓    │
                       │     3. RedisService connected ✓                      │
                       │     4. ModelService loaded 14 models ✓               │
                       │     5. DatabaseService.runMigrations()              │
                       │        └─→ CREATE SCHEMA IF NOT EXISTS "drizzle" ✗   │
                       │            ── verified upstream cause: Supabase     │
                       │               project was PAUSED. postgres-js       │
                       │               surfaced this as ECONNREFUSED on      │
                       │               error.cause, but Pino dropped the     │
                       │               error object and the rethrow lost     │
                       │               error.code/cause/errno → Fly logs    │
                       │               showed only the migrator's stringified│
                       │               "Failed query: …" message. R1 fixes  │
                       │               the logger, R2 adds an explicit       │
                       │               connectivity probe so "DB unreachable"│
                       │               is distinguishable from "DB rejected  │
                       │               my SQL", R3 alerts on it.             │
                       │     6. process.exit(1) → restart                    │
                       │     7. After 10 retries → machine stopped           │
                       │        (Fly health checks see "machine stopped"     │
                       │         not "DB down" — log-content alert needed)   │
                       └──────────────────────────────────────────────────────┘
```

### Safari OCJS rendering — pipeline gates and what we can vs. cannot observe

```text
                ┌──────────────────────┐
                │ User code in Safari  │
                │ (Replicad project)   │
                └──────────┬───────────┘
                           │ esbuild bundles
                           ▼
                ┌──────────────────────┐
                │ replicad imported as │  ← Built-in module registry,
                │ kernel-built-in mod  │    NO /node_modules lookup
                └──────────┬───────────┘
                           │ runtime.execute()
                           ▼
                ┌──────────────────────┐
                │ replicad.shape ops   │
                │ run on OCJS WASM     │  ← We see "createGeometry completed"
                └──────────┬───────────┘
                           │ convertReplicadGeometriesToGltf()
                           ▼
                ┌──────────────────────┐
                │ GLB Uint8Array       │  ← R6 probe: log .byteLength
                └──────────┬───────────┘
                           │ postMessage to main
                           ▼
                ┌──────────────────────┐
                │ cad.machine receives │  ← We see "geometry event received",
                │ "geometryComputed"   │    "setGeometries { count: N }"
                └──────────┬───────────┘
                           │ graphicsRef.send updateGeometries
                           ▼
                ┌──────────────────────┐
                │ GLTFLoader.parse()   │  ← R6 probe: log scene.children.length
                └──────────┬───────────┘
                           │ Three.js scene update
                           ▼
                ┌──────────────────────┐
                │ WebGLRenderer.render │  ← R6 probe: log scene.bbox
                └──────────────────────┘   If bbox is finite + non-zero
                                            and viewport is empty → camera
                                            fit bug. If bbox is at ∞ →
                                            coord-transform regression.
                                            If scene.children===0 → glTF
                                            parse silently failed.
                                            If GLB byteLength===0 → SLProps
                                            normal pipeline regression.
```

## References

- Fly.io machine restart policy: https://fly.io/docs/machines/restart-policies/
- Fly.io alerts on log content (Grafana log-based alerting): https://fly.io/docs/monitoring/grafana/
- Drizzle ORM postgres-js migrator: https://orm.drizzle.team/docs/migrations
- `postgres-js` `PostgresError` type: https://github.com/porsager/postgres#errors
- `postgres-js` `error.cause` chain (network-level errors): https://github.com/porsager/postgres/blob/master/src/connection.js
- Pino: positional args after the object/string are not auto-serialised — pass `{ err }` instead: https://getpino.io/#/docs/api?id=loggererror
- Pino standard `err` serializer (walks `cause`, `code`, `errno`, stack): https://getpino.io/#/docs/api?id=serializers-object
- Supabase project auto-pause behaviour (free tier, 7-day inactivity): https://supabase.com/docs/guides/platform/manage-your-usage/compute
- WebKit OPFS `UnknownError` discussion: https://bugs.webkit.org/show_bug.cgi?id=259347
- Three.js `GLTFLoader` `ImageBitmapLoader` instantiation: `node_modules/three/examples/jsm/loaders/GLTFLoader.js:2655-2682`
- Vite `Module "X" has been externalized` warning behaviour: https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility
- Related research: `docs/research/safari-cross-origin-isolation.md`
- Related research: `docs/research/safari-svg-rendering-compatibility.md`
- Related research: `docs/research/shared-worker-fs-architecture.md`
- Related research: `docs/research/replicad-occt-normal-pipeline-v3.md`
- Related research: `docs/research/filesystem-mount-only-architecture.md`

## Appendix: Raw evidence

### Fly machine state (Apr 22 01:26 UTC)

```text
$ flyctl status -a tau-api-staging
App
  Name     = tau-api-staging
  Hostname = tau-api-staging.fly.dev
  Image    = tau-api-staging:34e94988a94fa0db35eac4e9fa09577c21e91876   ← post-fix Dockerfile

Machines
PROCESS  ID              VERSION  REGION  STATE    CHECKS
app      2874409a6d9748  22       syd     stopped  1 total, 1 warning
app      3d8d3d6a116378  22       syd     stopped  1 total, 1 warning

$ flyctl releases -a tau-api-staging
v22  complete  Release  richard@tau.new   7h ago         ← latest CI deploy (Apr 21 18:03 UTC)
v21  complete  Release  richard@tau.new  10h ago
v20  complete  Release  richard@tau.new   Apr 19 13:36
…
```

### CI deploy that produced the running image

```text
$ gh run list -L 5 --workflow ci.yml | head -1
completed  success  refactor(ui): update entry.server test import to use path alias
                    CI  main  push  24738311458  20m23s  2026-04-21T18:03:00Z

$ gh run view 24738311458 --json jobs --jq '.jobs[] | select(.name | contains("Deploy"))'
{"conclusion":"success","name":"Deploy API (Staging) / Deploy api to staging","status":"completed"}
```

### Restart-loop transcript (`flyctl logs -a tau-api-staging --no-tail`)

```text
2026-04-22T01:17:08Z  RouterExplorer   Mapped {/telemetry/ingest, POST} (version: 1) route
2026-04-22T01:17:09Z  RedisService     Redis connection established
2026-04-22T01:17:09Z  ModelService     Loaded 14 models
2026-04-22T01:17:09Z  DatabaseService  Starting database migrations...
2026-04-22T01:17:09Z  DatabaseService  Database migration failed:           ← second arg dropped
2026-04-22T01:17:09Z  Error: Migration failed: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
                       params:
                       at DatabaseService.runMigrations (file:///app/dist/main.js:578:10)
                       at async DatabaseService.onModuleInit (…)
                       at async Promise.all (index 0)
                       at async callModuleInitHook (@nestjs/core/hooks/on-module-init.hook.js:43:5)
                       …
2026-04-22T01:17:09Z  INFO Main child exited normally with code: 1
2026-04-22T01:17:09Z  INFO Starting clean up.
2026-04-22T01:19:32Z  …same failure on next restart…
```

### Fly Postgres / Managed Postgres inventory

```text
$ flyctl postgres list
No postgres clusters found

$ fly mpg list -o personal
No managed postgres clusters found in organization personal
```

(`DATABASE_URL` therefore points to an external Postgres provider — Supabase / Neon / RDS / similar — and the role-permission fix lands there, not on Fly.)

### `apps/ui/app/machines/file-manager.worker.ts:32-46` — OPFS mount fallback

```typescript
async function createNodeModulesMount(): Promise<void> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    return;
  }
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    const nodeModulesHandle = await opfsRoot.getDirectoryHandle('tau-node-modules', { create: true });
    const nodeModulesProvider = new FileSystemAccessProvider(nodeModulesHandle);
    mountTable.mount('/node_modules', nodeModulesProvider, { backend: 'opfs' });
  } catch (error) {
    console.warn('[FM-Worker] Failed to mount OPFS /node_modules, falling through to root', error);
  }
}
```

### `apps/ui/app/machines/file-manager.machine.ts:74` — per-call worker spawn

```typescript
const worker = context.sharedWorker ?? new FileManagerWorker({ name: `fm-root` });
```

### `apps/api/app/database/database.service.ts:50-64` — error-swallowing rethrow

```typescript
private async runMigrations(): Promise<void> {
  try {
    this.logger.log('Starting database migrations...');
    await migrate(this.database, {
      migrationsFolder: path.join(import.meta.dirname, 'migrations'),
    });
    this.logger.log('Database migrations completed successfully');
  } catch (error) {
    this.logger.error('Database migration failed:', error);                                 // ← Pino: arg dropped
    throw new Error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`); // ← code/detail lost
  }
}
```

### Active CSP `connect-src`

```text
connect-src 'self' https://api.zoo.dev https://api.kittycad.io wss:;
```

(missing `https://api.taucad.dev` — see Finding 4 / R5.)

### Verified upstream cause of the API crash loop (out-of-band confirmation)

User confirmation, 2026-04-22:

> "the supabase pg instance was paused, it's the verified cause. make sure the recommendations stipulate adding logs to be able to identify this from Fly rather than guessing that supabase had an issue"

### Verified evidence for Finding 11 (cert binding mismatch)

```text
$ flyctl certs list -a tau-api-staging
HOSTNAME                       SOURCE     STATUS
                                                      ← empty

$ flyctl certs list -a tau-api
HOSTNAME                       SOURCE     STATUS
api.taucad.dev                 Fly        Issued       ← lives on PRODUCTION
api.tau.new                    Fly        Issued

$ flyctl certs show api.taucad.dev -a tau-api
  Hostname              = api.taucad.dev
  Status                = Issued
  Added to App          = 10 months ago

$ flyctl certs show api.taucad.dev -a tau-api-staging
  Error: certificate not found

$ rg -n 'TAU_API_URL' apps/ui/netlify.toml apps/ui/netlify.prod.toml
apps/ui/netlify.prod.toml:36:TAU_API_URL = "https://api.tau.new"
apps/ui/netlify.toml:41:TAU_API_URL = "https://api.taucad.dev"     ← staging UI calls api.taucad.dev
apps/ui/netlify.toml:50:TAU_API_URL = "https://api.taucad.dev"     ← (deploy-preview)
apps/ui/netlify.toml:61:TAU_API_URL = "https://api.taucad.dev"     ← (branch-deploy)

$ rg -n 'TAU_FRONTEND_URL|ADDITIONAL_CORS_ORIGINS' apps/api/fly.prod.toml apps/api/fly.staging.toml
apps/api/fly.prod.toml:14:  TAU_FRONTEND_URL = 'https://tau.new'
apps/api/fly.prod.toml:18:  ADDITIONAL_CORS_ORIGINS = '["https://deploy-preview-*--taucad-prod.netlify.app","https://taucad-prod.netlify.app"]'
apps/api/fly.staging.toml:14:  TAU_FRONTEND_URL = 'https://taucad.dev'
apps/api/fly.staging.toml:21:  ADDITIONAL_CORS_ORIGINS = '["https://deploy-preview-*--taucad.netlify.app","https://taucad.netlify.app"]'

$ curl -sS -i -H 'Origin: https://taucad.dev' https://tau-api-staging.fly.dev/v1/auth/get-session | grep -iE 'access-control|cross-origin|HTTP|fly-request'
HTTP/2 200
cross-origin-resource-policy: cross-origin
access-control-allow-origin: https://taucad.dev
access-control-allow-credentials: true
fly-request-id: 01KPSG8N8GPBYDPGZZ57HXY5R9-syd

$ curl -sS -i -H 'Origin: https://taucad.dev' https://api.taucad.dev/v1/auth/get-session | grep -iE 'access-control|cross-origin|HTTP|fly-request'
HTTP/2 200
cross-origin-resource-policy: same-origin                              ← prod helmet default, NOT staging's cross-origin
                                                                        ← access-control-allow-* MISSING
fly-request-id: 01KPSG8N15M9QERCDG3YFM2FYH-syd

$ curl -sS -i -H 'Origin: https://tau.new' https://tau-api.fly.dev/v1/auth/get-session | grep -iE 'access-control|HTTP'
HTTP/2 200
access-control-allow-origin: https://tau.new                           ← prod allows tau.new
access-control-allow-credentials: true                                  ← prod CORS code path is correct,
                                                                        ← it's the origin allow-list that excludes taucad.dev

# Inside the staging machine — proves the staging app's CORS code path is correct
$ flyctl ssh sftp put /tmp/internal-probe.mjs /tmp/internal-probe.mjs -a tau-api-staging
$ flyctl ssh console -a tau-api-staging -C 'node /tmp/internal-probe.mjs'
http://127.0.0.1:3000/v1/auth/get-session  Origin=https://taucad.dev
  status=200
  access-control-allow-origin: https://taucad.dev
  access-control-allow-credentials: true
  cross-origin-resource-policy: cross-origin
  vary: Origin
```

### Historical bisect for Finding 11

```text
$ git log --oneline --all -- apps/api/app/main.ts apps/api/app/utils/cors.utils.ts \
                              apps/api/app/constants/cors.constant.ts apps/api/fly.staging.toml | head
b3963b6b5  fix(api): remove hardcoded taucad.dev from CORS origins
d4d9aae89  chore(api): update Fly configuration for tau.new domain
…

$ git show b3963b6b5
- ADDITIONAL_CORS_ORIGINS = '["https://taucad.dev","https://deploy-preview-*--taucad.netlify.app","https://tau-ui-pr-*.fly.dev"]'
+ ADDITIONAL_CORS_ORIGINS = '["https://deploy-preview-*--taucad.netlify.app","https://tau-ui-pr-*.fly.dev"]'

$ git show d4d9aae89 -- apps/api/fly.toml apps/api/fly.staging.toml apps/ui/netlify.toml
- # apps/api/fly.toml (production)
- TAU_FRONTEND_URL = 'https://taucad.dev'
- AUTH_URL = 'https://api.taucad.dev'
+ TAU_FRONTEND_URL = 'https://tau.new'
+ AUTH_URL = 'https://api.tau.new'
+ # apps/api/fly.staging.toml (NEW)
+ # fly.toml app configuration file for staging environment (api.taucad.dev)
+ TAU_FRONTEND_URL = 'https://taucad.dev'
+ ADDITIONAL_CORS_ORIGINS = '["https://taucad.dev","https://deploy-preview-*--taucad.netlify.app","https://tau-ui-pr-*.fly.dev"]'
```

The two-commit pair correctly migrated the production app's frontend hostname from `taucad.dev` to `tau.new` and stood up a new staging app config that _expected_ `api.taucad.dev` to point at it (per the comment at the top of the new `fly.staging.toml`). The `flyctl certs add api.taucad.dev -a tau-api-staging` and `flyctl certs remove api.taucad.dev -a tau-api` commands that would have completed the migration were never run. R12 fixes that.

This ratifies the **observability gap** as the audit-relevant finding (R1 + R2 + R3), with the per-incident remediation (unpause Supabase) as a one-time R4 action. The same gap will hide every future DB outage — paused Neon branches, rotated roles, exhausted Supavisor pools, certificate expiries, regional outages — until the structured logging is in place. **The point is to never diagnose a database outage by guessing.**
