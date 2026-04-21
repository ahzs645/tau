# UI Deployment Topology

How `apps/ui` is built, hosted, and promoted across staging and production, plus how it pairs with `apps/api` per environment.

## Status

Both staging and production UIs live on Netlify, paired with the Fly.io staging and production APIs. Staging is auto-built on every push to `main` and PR by the Netlify GitHub integration; production is gated behind a manual `workflow_dispatch` ([`prod-deploy-ui.yml`](../../.github/workflows/prod-deploy-ui.yml)) so releases are stability-judged off staging.

For the original investigation that drove this topology, see [docs/research/netlify-ui-deployment-strategy.md](../research/netlify-ui-deployment-strategy.md). Residual manual operations (DNS, OAuth, registrar) are tracked in that doc's "Gap Analysis" section.

## At a Glance

| Surface            | Host                         | Domain                                         | Trigger                                                                                                                    | Config                                                                                |
| ------------------ | ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Staging UI         | Netlify (`taucad` site)      | `https://taucad.dev`                           | Auto on every push to `main` (Netlify GitHub integration, `production` context)                                            | [`apps/ui/netlify.toml`](../../apps/ui/netlify.toml)                                  |
| Per-PR UI preview  | Netlify (`taucad` site)      | `https://deploy-preview-N--taucad.netlify.app` | Auto on every PR (Netlify GitHub integration, `deploy-preview` context)                                                    | [`apps/ui/netlify.toml`](../../apps/ui/netlify.toml) `[context.deploy-preview]` block |
| Staging API        | Fly.io (`tau-api-staging`)   | `https://api.taucad.dev`                       | Auto on every push to `main` via [`ci.yml`](../../.github/workflows/ci.yml) `deploy-api-staging`                           | [`apps/api/fly.staging.toml`](../../apps/api/fly.staging.toml)                        |
| Per-PR API preview | Fly.io (`tau-api-pr-N`)      | `https://tau-api-pr-N.fly.dev`                 | Auto on every PR via [`review.yml`](../../.github/workflows/review.yml)                                                    | [`apps/api/fly.staging.toml`](../../apps/api/fly.staging.toml) (re-used as base)      |
| Production UI      | Netlify (`taucad-prod` site) | `https://tau.new`                              | **Manual** via `workflow_dispatch` → [`prod-deploy-ui.yml`](../../.github/workflows/prod-deploy-ui.yml)                    | [`apps/ui/netlify.prod.toml`](../../apps/ui/netlify.prod.toml)                        |
| Production API     | Fly.io (`tau-api`)           | `https://api.tau.new`                          | **Manual** via `workflow_dispatch` → [`deploy.yml`](../../.github/workflows/deploy.yml) (`app=api environment=production`) | [`apps/api/fly.prod.toml`](../../apps/api/fly.prod.toml)                              |

## Topology Diagram

```
                              ┌────────────────────────┐
                              │  Pull Request opened   │
                              └───────────┬────────────┘
                                          │
                  ┌───────────────────────┴────────────────────────┐
                  │                                                │
                  ▼                                                ▼
   ┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
   │ Netlify GitHub integration   │          │ review.yml (review_app_api job)         │
   │ (deploy-preview context)     │          │ Deploys per-PR Fly app `tau-api-pr-N`   │
   │ Builds taucad netlify site   │          │ at https://tau-api-pr-N.fly.dev         │
   │ at deploy-preview-N-...      │          │ TAU_FRONTEND_URL is set to the         │
   │ TAU_API_URL = api.taucad.dev │          │ paired Netlify deploy-preview URL,     │
   │ (per netlify.toml)           │          │ so its CORS allowlist accepts it.      │
   └──────────────────────────────┘          └─────────────────────────────────────────┘

                              ┌────────────────────────┐
                              │  push to main          │
                              └───────────┬────────────┘
                                          │
                  ┌───────────────────────┴────────────────────────┐
                  │                                                │
                  ▼                                                ▼
   ┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
   │ Netlify GitHub integration   │          │ ci.yml (deploy-api-staging job)         │
   │ (production context)         │          │ Calls deploy.yml with                   │
   │ Rebuilds taucad netlify site │          │   app=api, environment=staging          │
   │ → https://taucad.dev          │          │ → flyctl deploy tau-api-staging         │
   │ Default domain               │          │ → https://api.taucad.dev                │
   │ https://taucad.netlify.app   │          │                                         │
   │ also resolves.               │          │                                         │
   └──────────────────────────────┘          └─────────────────────────────────────────┘


                              ┌────────────────────────┐
                              │  Manual workflow_dispatch │
                              └───────────┬────────────┘
                                          │
                  ┌───────────────────────┴────────────────────────┐
                  │                                                │
                  ▼                                                ▼
   ┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
   │ prod-deploy-ui.yml           │          │ deploy.yml app=api prod                 │
   │ Builds + uploads sourcemaps; │          │ flyctl deploy tau-api fly app           │
   │ netlify deploy --prod        │          │ → https://api.tau.new                   │
   │   --site $NETLIFY_PROD_SITE_ID│         │                                         │
   │   --config netlify.prod.toml │          │                                         │
   │ → https://tau.new            │          │                                         │
   └──────────────────────────────┘          └─────────────────────────────────────────┘
```

## Environment Variables (UI)

Both Netlify sites are configured by sibling toml files: [`apps/ui/netlify.toml`](../../apps/ui/netlify.toml) (staging, `taucad`) and [`apps/ui/netlify.prod.toml`](../../apps/ui/netlify.prod.toml) (production, `taucad-prod`). Both are **authoritative**: dashboard env-var overrides for `TAU_API_URL`, `TAU_WEBSOCKET_URL`, `TAU_FRONTEND_URL`, and `NODE_ENV` are forbidden by convention so a PR review captures the entire env diff. Only **secrets** that cannot be committed (e.g. `POSTHOG_API_KEY`, `SENTRY_AUTH_TOKEN`, third-party keys) live in the Netlify dashboard.

### Staging site (`taucad`, `apps/ui/netlify.toml`)

| Variable            | `production` context     | `deploy-preview` context | `branch-deploy` context  | Notes                                                                                                           |
| ------------------- | ------------------------ | ------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | `production`             | `production`             | `production`             |                                                                                                                 |
| `TAU_API_URL`       | `https://api.taucad.dev` | `https://api.taucad.dev` | `https://api.taucad.dev` | Staging API on Fly                                                                                              |
| `TAU_WEBSOCKET_URL` | `wss://api.taucad.dev`   | `wss://api.taucad.dev`   | `wss://api.taucad.dev`   | Same Fly host, WSS protocol; bypasses Netlify entirely (browser → Fly).                                         |
| `TAU_FRONTEND_URL`  | `https://taucad.dev`     | _intentionally unset_    | _intentionally unset_    | Preview/branch builds derive this at runtime from `NETLIFY_AI_GATEWAY_URL` so each preview reports its own URL. |

### Production site (`taucad-prod`, `apps/ui/netlify.prod.toml`)

The site is provisioned with `skip_automatic_builds: true` and `allowed_branches: []`, so the only deploy path is the manual `prod-deploy-ui.yml` `workflow_dispatch`. There are no `deploy-preview` / `branch-deploy` contexts on this site (those live on the staging site).

| Variable            | `production` context  | Notes                                                          |
| ------------------- | --------------------- | -------------------------------------------------------------- |
| `NODE_ENV`          | `production`          |                                                                |
| `TAU_API_URL`       | `https://api.tau.new` | Production API on Fly                                          |
| `TAU_WEBSOCKET_URL` | `wss://api.tau.new`   | Same Fly host, WSS protocol; bypasses Netlify entirely.        |
| `TAU_FRONTEND_URL`  | `https://tau.new`     | Public production hostname (custom domain attached to Netlify) |

## Environment Variables (API)

| Variable                  | `tau-api-staging` (Fly)                                                         | `tau-api` (Fly, prod)                                             |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `TAU_FRONTEND_URL`        | `https://taucad.dev`                                                            | `https://tau.new`                                                 |
| `AUTH_URL`                | `https://api.taucad.dev`                                                        | `https://api.tau.new`                                             |
| `ADDITIONAL_CORS_ORIGINS` | `["https://deploy-preview-*--taucad.netlify.app","https://taucad.netlify.app"]` | _(unset — `https://tau.new` matches `TAU_FRONTEND_URL` directly)_ |

The `deploy-preview-*--taucad.netlify.app` glob is intentionally narrow. **Do not** broaden it to `*--taucad.netlify.app` — that would silently allow non-PR branch deploys, which are currently disabled (`build_settings.allowed_branches = ["main"]` on the `taucad` site).

For the production API, `tau.new` shares the registrable domain with `api.tau.new` and matches `TAU_FRONTEND_URL` directly, so no `ADDITIONAL_CORS_ORIGINS` entry is needed.

## Cookie & Auth Strategy

Better Auth uses `sameSite: 'lax'` cookies. To preserve cookie behaviour across UI ↔ API per environment, both must share the apex registrable domain and the API enables `crossSubDomainCookies`:

- Staging: `taucad.dev` (UI) ↔ `api.taucad.dev` (API), shared apex `taucad.dev`.
- Production: `tau.new` (UI) ↔ `api.tau.new` (API), shared apex `tau.new`.

This is why both Netlify sites are attached to custom domains instead of staying on `*.netlify.app` — `lax` cookies cannot be set for one origin and read by another that lives on a different registrable domain (`netlify.app` vs `taucad.dev` / `tau.new`).

OAuth callback URLs (`https://{taucad.dev,tau.new}/api/auth/callback/{github,google}`) are registered against the GitHub and Google OAuth clients used by Better Auth.

## Cross-Origin Headers

Both Netlify sites send `Cross-Origin-Embedder-Policy: require-corp` (set in `[[headers]]` in [`apps/ui/netlify.toml`](../../apps/ui/netlify.toml) and [`apps/ui/netlify.prod.toml`](../../apps/ui/netlify.prod.toml)) to enable cross-origin isolation for SharedArrayBuffer / WASM threading. The Fly API in turn sets `Cross-Origin-Resource-Policy: cross-origin` via `@fastify/helmet` (see [`apps/api/app/main.ts`](../../apps/api/app/main.ts)) so the browser will accept API responses across origins under COEP `require-corp`.

If either header drifts back to its restrictive default, the UI will silently fail to load API responses. Both are tracked in [docs/research/netlify-ui-deployment-strategy.md](../research/netlify-ui-deployment-strategy.md) (R9 / Risk 8).

## How to Redeploy

| Need                        | Action                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-trigger staging UI build | Push an empty commit to `main` (or hit "Trigger deploy" → "Clear cache and deploy site" in the Netlify dashboard).                                                                                                                      |
| Re-trigger a PR preview     | Push any commit to the PR branch.                                                                                                                                                                                                       |
| Re-deploy staging API       | Push any change to `apps/api` (or its dependencies) to `main`; `ci.yml` `deploy-api-staging` runs automatically.                                                                                                                        |
| Manually deploy staging API | Trigger [`deploy.yml`](../../.github/workflows/deploy.yml) via `workflow_dispatch`, set `app=api`, `environment=staging`.                                                                                                               |
| Promote production UI       | Trigger [`prod-deploy-ui.yml`](../../.github/workflows/prod-deploy-ui.yml) via `workflow_dispatch` (optionally set `ref` to a non-`main` SHA). Builds, uploads PostHog source maps, then `netlify deploy --prod` against `taucad-prod`. |
| Promote production API      | Trigger [`deploy.yml`](../../.github/workflows/deploy.yml) via `workflow_dispatch`, set `app=api`, `environment=production`.                                                                                                            |

## See Also

- [docs/research/netlify-ui-deployment-strategy.md](../research/netlify-ui-deployment-strategy.md) — driving research, full findings & recommendations, gap analysis of remaining manual operations
- [`apps/ui/netlify.toml`](../../apps/ui/netlify.toml) — authoritative Netlify staging config
- [`apps/ui/netlify.prod.toml`](../../apps/ui/netlify.prod.toml) — authoritative Netlify production config
- [`apps/api/fly.staging.toml`](../../apps/api/fly.staging.toml) — staging API config (CORS allowlist for Netlify origins)
- [`apps/api/fly.prod.toml`](../../apps/api/fly.prod.toml) — production API config
- [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) — reusable Fly API deploy workflow
- [`.github/workflows/prod-deploy-ui.yml`](../../.github/workflows/prod-deploy-ui.yml) — manual Netlify production UI deploy workflow
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — auto-deploys staging API on `main`
- [`.github/workflows/review.yml`](../../.github/workflows/review.yml) — per-PR Fly API review apps
- [`scripts/netlify-provision-prod.sh`](../../scripts/netlify-provision-prod.sh) — one-shot bootstrap for the `taucad-prod` Netlify site + GitHub `production` env values
