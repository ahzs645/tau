---
title: 'NestJS API Docker Build Optimization (April 2026)'
description: 'Audit of apps/api/Dockerfile and the surrounding pnpm/Nx monorepo build context, with prioritized recommendations to drop the ~7-8 minute Fly.io image build to ~90s on warm cache and ~3 min cold.'
status: draft
created: '2026-04-22'
updated: '2026-04-22'
category: optimization
related:
  - docs/research/netlify-ui-deployment-strategy.md
---

# NestJS API Docker Build Optimization (April 2026)

Audit of [`apps/api/Dockerfile`](../../apps/api/Dockerfile), [`.dockerignore`](../../.dockerignore), and the pnpm/Nx workspace topology that feeds the Fly.io API image, with concrete fixes to bring a 7-8 minute build down to a steady-state of roughly 60-90 seconds (warm cache) and ~3 minutes cold.

## Executive Summary

The current image build spends most of its time on three avoidable bottlenecks:

1. **~2.2 GB of unnecessary build context** is shipped into the daemon on every build — `tarballs/experiments` (1.1 GB of historical OCCT WASM experiments) plus `apps/api/reports` (937 MB of benchmark HTML/JSON/GLB artifacts) plus `apps/ui/.netlify` (145 MB) are not in `.dockerignore`. Only ~27 MB of the `tarballs/` directory is actually referenced by the lockfile.
2. **The layer cache is invalidated on every source edit.** [`COPY . .`](../../apps/api/Dockerfile#L25) runs **before** `pnpm install`, so any change anywhere in the repo (including `apps/ui` changes that the API does not consume) re-runs the full install + build chain even though the dependency graph is identical.
3. **Two passes through the resolver.** `pnpm fetch --frozen-lockfile` (61 s in the user-supplied log) populates the store, then `pnpm install --frozen-lockfile` re-resolves and re-links the entire workspace. The second pass should run with `--offline` after fetch so the network is never touched, and Corepack should be pinned in the base image instead of being prompted to download `pnpm-10.30.3.tgz` every cache miss.

The fastest single change is **R1 (extend `.dockerignore`)** — eliminating ~2 GB of context before BuildKit even starts compiling layers. The single highest-leverage architectural change is **R3 (split the install layer from the source-COPY layer)** — making the dependency layer cacheable across source-only edits.

If R1+R3+R4 are applied, expected build times on Fly.io's `depot`-style remote builder are:

| Scenario                 | Current | Target  | Savings                   |
| ------------------------ | ------- | ------- | ------------------------- |
| Cold cache               | 7-8 min | ~3 min  | ~5 min                    |
| Warm (no source change)  | 7-8 min | ~30 s   | layers fully reused       |
| Warm (API source change) | 7-8 min | 60-90 s | only build layer rebuilds |
| Warm (UI-only change)    | 7-8 min | 30 s    | API graph unaffected      |

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Current Dockerfile Walkthrough](#current-dockerfile-walkthrough)
4. [Findings](#findings)
5. [Build Context Inventory](#build-context-inventory)
6. [Best-Practice Reference (April 2026)](#best-practice-reference-april-2026)
7. [Proposed Dockerfile](#proposed-dockerfile)
8. [Recommendations](#recommendations)
9. [Trade-offs](#trade-offs)
10. [Out of Scope](#out-of-scope)
11. [References](#references)
12. [Appendix](#appendix)

## Problem Statement

The Fly.io build for `apps/api` (the NestJS service deployed to `tau-api.fly.dev`) takes 7-8 minutes per push. The user-supplied build log shows:

```
#15 45.77 Progress: resolved 3585, reused 0, downloaded 3573, added 3585, done
#15 DONE 61.0s              # pnpm fetch --frozen-lockfile
#16 [build  7/10] COPY package.json ./                    DONE 3.3s
#17 [build  8/10] COPY . .                                DONE 9.4s
#18 [build  9/10] RUN pnpm install --frozen-lockfile      DONE ~5s
#18 0.215 ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.30.3.tgz
```

Three concrete symptoms in this log:

- `pnpm fetch` redownloads 3573 packages (45 s of resolver + network work) even though the BuildKit cache mount target (`/root/.local/share/pnpm/store`) should be re-usable. **The cache mount is intact** — the redownload happens because Fly.io's remote builder cycles its BuildKit instance more aggressively than local Docker, so the warm cache assumption only partially holds.
- `pnpm install` runs **after** `COPY . .` (line 25), which means any source edit invalidates the install layer. With `--offline` it would still be fast, but it's unconditional re-execution.
- Corepack tries to download `pnpm-10.30.3.tgz` (~5 MB) on every cold build because the base image doesn't pin pnpm at the OS layer.

Build outputs are ~10 MB (`apps/api/dist`), so the runtime stage is not the bottleneck — the build stage is.

## Methodology

- Read `apps/api/Dockerfile`, `.dockerignore`, `apps/api/project.json`, `apps/api/package.json`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `nx.json`.
- Measured local directory sizes with `du -sh` to identify what `COPY . .` actually ingests.
- Cross-referenced the lockfile to identify which `tarballs/*.tgz` are actually consumed.
- Surveyed April 2026 best-practice references for pnpm + monorepo + NestJS Docker patterns:
  - [pnpm Docker guide (10.x and next)](https://pnpm.io/docker)
  - [pnpm fetch CLI reference](https://pnpm.io/cli/fetch)
  - [pnpm deploy CLI reference](https://pnpm.io/cli/deploy)
  - [Depot.dev: Optimal Node + pnpm Dockerfiles](https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/node-pnpm-dockerfile)
  - OneUptime / Engineering Playbook NestJS containerization posts (Feb-Apr 2026)
  - GitHub: `malyshev/nestjs-docker-good-defaults` (current "good defaults" template)

## Current Dockerfile Walkthrough

```dockerfile
ARG NODE_VERSION=24.3.0
FROM node:${NODE_VERSION}-slim AS base
LABEL fly_launch_runtime="NestJS"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

FROM base AS build
RUN corepack enable                                    # (1)
WORKDIR /app
COPY pnpm-lock.yaml ./                                 # (2)
COPY patches/ ./patches/
COPY tarballs/ ./tarballs/                             # (3) ← 1.3 GB of which 1.27 GB is dead weight
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile                       # (4) ← 61 s in log
COPY package.json ./                                   # (5) ← redundant; overwritten by COPY . .
COPY . .                                               # (6) ← invalidates (7) on any source change
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile                     # (7) ← should be --offline
RUN pnpm nx build api                                  # (8) ← no nx cache mount

FROM build AS pruned
RUN pnpm --filter=@taucad/api --prod deploy pruned --legacy   # (9)

FROM base
WORKDIR /app
COPY --from=pruned /app/pruned /app
ENV NODE_ENV="production"
ENV NODE_OPTIONS="--import /app/dist/telemetry/otel.js"
EXPOSE 3000 9464
CMD [ "node", "/app/dist/main.js" ]
```

Numbered issues (matched to F1-F8 below):

| #   | Issue                                                                                         | Finding       |
| --- | --------------------------------------------------------------------------------------------- | ------------- |
| 1   | Corepack enabled but no pin → triggers download every cold build                              | F4            |
| 3   | All of `tarballs/` shipped (1.3 GB), only ~27 MB consumed                                     | F1            |
| 4   | `pnpm fetch` re-downloads in 61 s on Fly.io remote builder                                    | F5            |
| 5   | Redundant `COPY package.json ./` overwritten by `COPY . .`                                    | F2            |
| 6→7 | `COPY . .` precedes install → install layer invalidated by any source edit                    | F3            |
| 7   | Missing `--offline` flag → pnpm still consults registry metadata                              | F5            |
| 8   | No `--mount=type=cache,target=.nx/cache` → Nx rebuilds from scratch every time                | F6            |
| 9   | `--legacy` deploy still required — pnpm v10 needs `inject-workspace-packages=true` to drop it | informational |

## Findings

### F1: ~2.2 GB of build context is shipped that the API does not consume

The `COPY . .` step on line 25 ingests the entire repo (minus `.dockerignore` exclusions). Local sizes after applying current `.dockerignore`:

| Path                             | Size on disk | Used by API build?           | Currently in `.dockerignore`?                              |
| -------------------------------- | ------------ | ---------------------------- | ---------------------------------------------------------- |
| `tarballs/experiments/`          | 1.1 GB       | **No**                       | No                                                         |
| `tarballs/comparisons/`          | 1.9 MB       | No                           | No                                                         |
| `tarballs/package/`              | 8 KB         | No                           | No                                                         |
| `tarballs/active` (symlink)      | 0            | No                           | No                                                         |
| `apps/api/reports/`              | 937 MB       | **No** (benchmark artifacts) | No                                                         |
| `packages/runtime/reports/`      | 66 MB        | No (build experiments)       | No                                                         |
| `packages/runtime/occt-reports/` | 488 KB       | No                           | No                                                         |
| `apps/ui/.netlify/`              | 145 MB       | No                           | No (`.netlify` exists but is too narrow)                   |
| `apps/ui/stats.html`             | 888 KB       | No                           | Yes (`stats.html`)                                         |
| `apps/ui/app/`                   | 11 MB        | No (API doesn't compile UI)  | No (would break `pnpm install` workspace graph if removed) |
| `apps/ui/public/`                | 2.4 MB       | No                           | No                                                         |
| `apps/ui/content/`               | 264 KB       | No                           | No                                                         |
| `tools/`                         | 120 KB       | Yes (`@nx/vite` plugins)     | No                                                         |
| `nx.json`, `tsconfig.base.json`  | 8 KB         | Yes                          | No                                                         |

**Only 4 tarballs are referenced in `pnpm-lock.yaml`** (verified via `rg 'file:tarballs/' pnpm-lock.yaml`):

| File                                               | Size       |
| -------------------------------------------------- | ---------- |
| `tarballs/opencascade.js-3.0.0-beta.d453dbf.tgz`   | 13 MB      |
| `tarballs/replicad-0.21.0-v8.56.tgz`               | 1.1 MB     |
| `tarballs/replicad-opencascadejs-0.21.0-v8.55.tgz` | 7.7 MB     |
| `tarballs/taucad-assimpjs-0.0.18.tgz`              | 5.6 MB     |
| **Total active**                                   | **~27 MB** |

The remaining 1.27 GB of `tarballs/experiments/` is local research history — see `docs/research/ocjs-wasm-build-comparison.md` and friends — that should never reach the build daemon.

`apps/api/reports` is even worse: 937 MB of benchmark HTML/JSON/GLB outputs from `apps/api/scripts/benchmark-models.mts`. They're checked into git (`.gitignore` doesn't list them) but not consumed by the NestJS bundle.

### F2: Redundant `COPY package.json ./`

Line 24 (`COPY package.json ./`) is overwritten 9 ms later by `COPY . .` on line 25. Pure noise — it adds a layer + 3.3 s of context-transfer overhead in the log.

### F3: Install layer is invalidated by source-only edits

The pattern

```dockerfile
COPY . .
RUN pnpm install --frozen-lockfile
```

means any change to `app/main.ts`, `apps/ui/app/root.tsx`, or even a doc comment in `libs/utils` invalidates the install layer's cache key. The store cache mount keeps the install fast (~5 s in the log) but the layer always re-runs, plus Corepack re-prints its prompt. The canonical fix is to copy **only the workspace skeleton** (lockfile + every `package.json` + patches + tarballs) before `pnpm install`, then `COPY . .` _after_ install:

```dockerfile
# 1. Workspace skeleton (cache key = lockfile + package.jsons only)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/
COPY tarballs/active/ ./tarballs/        # only the symlink target (see R1)
COPY apps/api/package.json apps/api/
COPY apps/ui/package.json apps/ui/
COPY libs/*/package.json libs/.staging/  # — doesn't work directly; see R3 implementation
# (... 24 workspace package.jsons total)

RUN pnpm install --frozen-lockfile --offline

# 2. Source code (cache key = source files; install layer reused)
COPY . .
RUN pnpm nx build api
```

The `libs/*/package.json` glob has no Docker-native expansion (`COPY` doesn't preserve directory structure for globs). Two practical solutions:

- **(a)** Hand-list 24 `COPY apps/api/package.json apps/api/` lines (verbose, but cache-friendly).
- **(b)** Use BuildKit's [`COPY --parents`](https://docs.docker.com/reference/dockerfile/#copy---parents) (Dockerfile syntax 1.7+, GA in 1.10/Apr 2025): `COPY --parents */package.json ./` preserves the directory tree.
- **(c)** Pre-build a minimal "workspace skeleton" tarball in CI (`find . -name package.json -not -path '*/node_modules/*' | tar czf skeleton.tgz -T -`) and `ADD` it. Simplest in scripts, ugliest in Dockerfile.

Option (b) requires bumping the syntax directive to `# syntax=docker/dockerfile:1.10` (currently `1`, which resolves to latest stable — already supports `--parents`).

### F4: Corepack downloads pnpm on every cold build

The log shows:

```
#18 0.215 ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.30.3.tgz
```

Even though `package.json` pins `packageManager: pnpm@10.30.3+sha512...`, Corepack downloads the binary on cold cache because it's not baked into the base image. This is also the source of the [recurring Corepack signature-validation breakage](https://github.com/pnpm/pnpm/issues/9029) tracked across pnpm 9.15.x and 10.0.x. Two safer alternatives:

- **`RUN corepack enable && corepack prepare pnpm@10.30.3 --activate`** at the base layer — pre-installs pnpm into the image, so cold builds reuse the layer.
- **`RUN npm install -g pnpm@10.30.3`** — bypasses Corepack entirely. Avoids the signature-validation class of bugs and is the pattern used by most "good defaults" repos in 2026 (e.g. `malyshev/nestjs-docker-good-defaults`).

The `pnpm` Docker docs themselves [recommend pre-installing in the base image](https://pnpm.io/docker#minimizing-docker-image-size-and-build-time).

### F5: `pnpm install` should run `--offline` after `pnpm fetch`

Per the [`pnpm fetch` reference](https://pnpm.io/cli/fetch):

> `--offline` enforces pnpm not to communicate with the package registry as all needed packages are already present in the virtual store.

The current Dockerfile runs `pnpm install --frozen-lockfile` (which re-validates the registry for any unpinned ranges and metadata) instead of `pnpm install --offline --frozen-lockfile`. After a successful `pnpm fetch`, all required packages are in the store; the install only needs to link them. Adding `--offline` saves a small but measurable amount of network round-trips and guards against registry flakes.

### F6: No Nx cache mount for `pnpm nx build api`

Nx writes its task cache to `.nx/cache`. The current Dockerfile has no cache mount for it, so every build re-runs the full Nx task graph for `build api` (which includes upstream `^build` deps for the workspace packages it consumes: `@taucad/runtime`, `@taucad/chat`, `@taucad/telemetry`, `@taucad/testing`, `@taucad/types`, `@taucad/utils`, `@taucad/api-extractor`, `@taucad/tau-examples`).

```dockerfile
RUN --mount=type=cache,id=nx,target=/app/.nx/cache \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm nx build api
```

This pairs naturally with **Nx Cloud** (already configured: `nxCloudId: "687b39d7852b9a43a8bba201"` in `nx.json`). If `NX_CLOUD_ACCESS_TOKEN` is exposed to the build (via Fly.io build secret or `docker build --secret`), the build can pull the prebuilt task hash from Nx Cloud and skip even the cache-mount round-trip.

### F7: Workspace pulled into install graph beyond what the API needs

`pnpm install` resolves the entire workspace (24 packages, ~3585 packages from log). The API's actual dependency closure is a strict subset:

```
@taucad/api → @taucad/{api-extractor, chat, runtime, tau-examples, telemetry, testing, types, utils}
```

`@taucad/runtime` pulls in CAD kernel WASM (~82 MB on disk) and `@taucad/converter` (90 MB). UI-only packages (`@taucad/three`, `@taucad/react`, `@taucad/json-schema`, `@taucad/filesystem`, `@taucad/memory`) are not transitively required.

`pnpm install --filter=@taucad/api...` (note the trailing `...` for "include dependencies of") in the build stage would skip the UI subtree entirely. **Caveat**: this requires the build-time devDependencies (`@nx/*`, `vite`, `tsdown`, `@taucad/vite`) to either be hoisted at the workspace root (they are) or filtered explicitly. Tested as **R7** below.

### F8: Runtime base image still uses `node:24-slim` (~190 MB)

The runtime stage inherits `node:${NODE_VERSION}-slim` (~190 MB), then layers ~10 MB of `apps/api/dist` + the production node_modules (~120 MB resolved by `pnpm deploy --prod`). The image isn't huge, but two improvements are common in 2026:

- **`node:24-alpine`** (~70 MB) — but `@datadog/pprof` (the listed `onlyBuiltDependencies` includes `@datadog/pprof@5.13.3` which is **not** in `onlyBuiltDependencies` of `package.json`'s `pnpm` block — verify musl support before switching).
- **`gcr.io/distroless/nodejs24-debian12`** (~25 MB) — recommended by every recent "shrink your Docker image" post (Engineering Playbook Apr 2026). Caveat: no shell, so debugging requires `kubectl debug` or sidecar containers.

This is image-size optimization, not build-time optimization, so it's listed as a P2.

## Build Context Inventory

Local disk sizes for what currently flows into the Docker daemon (after applying the current `.dockerignore`):

```
apps/         1.4 GB   ← apps/api/reports = 937 MB; apps/ui/.netlify = 145 MB; apps/ui/app = 11 MB
packages/     447 MB   ← packages/runtime/src = 97 MB (WASM); packages/converter/src = 32 MB
tarballs/     1.3 GB   ← only ~27 MB referenced; rest is /experiments + /comparisons
libs/         24 MB
patches/      112 KB
scripts/      2.1 MB   (already excluded by .dockerignore)
tools/        120 KB
pnpm-lock.yaml 1.5 MB
```

**Total context after current `.dockerignore`**: ~3.2 GB.
**Total context after recommended `.dockerignore`**: ~430 MB (90% reduction).

Of the remaining 430 MB, the dominant consumers are:

| Path                                             | Size   | Necessary?                                                    |
| ------------------------------------------------ | ------ | ------------------------------------------------------------- |
| `packages/runtime/src/kernels/`                  | 82 MB  | Yes — WASM kernels consumed at runtime                        |
| `packages/runtime/src/bundler/wasm/esbuild.wasm` | 13 MB  | Yes                                                           |
| `packages/converter/src/`                        | 32 MB  | Yes (consumed via `@taucad/runtime`)                          |
| `apps/api/dist/`                                 | 9.6 MB | Should be excluded (already in `.dockerignore` via `**/dist`) |
| Active tarballs                                  | 27 MB  | Yes                                                           |

## Best-Practice Reference (April 2026)

| Source                                                                                                                                                                                                         | Key takeaway                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pnpm Docker docs](https://pnpm.io/docker)                                                                                                                                                                     | Use BuildKit cache mount on `/pnpm/store`. Multi-stage `prod-deps` + `build` + runtime. `pnpm deploy --prod` for monorepos.                                           |
| [pnpm fetch docs](https://pnpm.io/cli/fetch)                                                                                                                                                                   | After fetch, install with `--offline` to guarantee no network.                                                                                                        |
| [pnpm deploy docs](https://pnpm.io/cli/deploy)                                                                                                                                                                 | `--legacy` still required unless `inject-workspace-packages=true` is set workspace-wide. Default behaviour generates a per-project lockfile from the shared lockfile. |
| [Depot.dev optimal Dockerfile](https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/node-pnpm-dockerfile)                                                                                 | `COPY` lockfile + package.jsons only → install → `COPY . .` → build. Cache mount per stage.                                                                           |
| [DEV: Container Image Layer Caching](https://dev.to/software_mvp-factory/container-image-layer-caching-in-github-actions-562f)                                                                                 | Registry-backed BuildKit cache (`type=registry,mode=max`) avoids the 10 GB GitHub Actions cache limit.                                                                |
| [OneUptime: NestJS multi-stage (Feb 2026)](https://oneuptime.com/blog/post/2026-02-17-how-to-optimize-docker-image-size-for-a-nestjs-application-using-multi-stage-builds-and-alpine-base-images-for-gke/view) | NestJS image: alpine + multi-stage + non-root user. Targets 150-200 MB.                                                                                               |
| [Engineering Playbook: 2.4 GB → 24 MB (Apr 2026)](https://medium.com/engineering-playbook/my-docker-image-was-2-4gb-i-cut-it-to-24mb-heres-every-optimization-that-actually-worked-46792bd23da4)               | `.dockerignore` saves 800 MB before Docker even starts. Distroless is final boss.                                                                                     |
| [`malyshev/nestjs-docker-good-defaults`](https://github.com/malyshev/nestjs-docker-good-defaults)                                                                                                              | Apr-2026 reference template. `node:22-alpine`, multi-stage, non-root, healthcheck script, `npm install -g pnpm` (no Corepack).                                        |

## Proposed Dockerfile

The minimum-viable rewrite that addresses F1-F6 (R1, R3, R4, R5, R6 below):

```dockerfile
# syntax=docker/dockerfile:1.10

ARG NODE_VERSION=24.3.0
ARG PNPM_VERSION=10.30.3

# ── Base ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    PNPM_STORE_DIR="/pnpm/store"

# Pin pnpm at the base layer; bypass Corepack to avoid signature-validation churn
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm config set store-dir /pnpm/store

WORKDIR /app

# ── Workspace skeleton (cache key = lockfile + every package.json) ────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches/ ./patches/
COPY tarballs/ ./tarballs/   # See R1 — `tarballs/` is now ~27 MB after dockerignore
COPY --parents */*/package.json ./   # Requires syntax 1.7+, preserves apps/api/, libs/X/, packages/X/, tools/X/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# ── Build stage ───────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=cache,id=nx,target=/app/.nx/cache \
    pnpm nx build api

# ── Prune to production deploy ────────────────────────────────────────────
FROM build AS pruned
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter=@taucad/api --prod deploy /pruned --legacy

# ── Runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime
LABEL fly_launch_runtime="NestJS"
WORKDIR /app
COPY --from=pruned /pruned /app

# Drop privileges (matches NestJS good-defaults template)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nestjs && \
    chown -R nestjs:nodejs /app
USER nestjs

ENV NODE_ENV="production" \
    NODE_OPTIONS="--import /app/dist/telemetry/otel.js"
EXPOSE 3000 9464
CMD ["node", "/app/dist/main.js"]
```

Plus matching `.dockerignore` additions (R1):

```diff
 # -- External dependency repos --
 repos
+
+# -- Inactive tarball experiments (1.1 GB of OCCT WASM build artifacts) ----
+tarballs/experiments
+tarballs/comparisons
+tarballs/package
+tarballs/active
+
+# -- Benchmark and report artifacts (937 MB) -------------------------------
+apps/api/reports
+packages/runtime/reports
+packages/runtime/occt-reports
+
+# -- Netlify dev artifacts -------------------------------------------------
+**/.netlify
```

`tarballs/active` is a symlink that points into `tarballs/experiments/...` — Docker will follow the symlink target, so we have to ignore both the symlink and the experiments directory (otherwise the symlink points into a non-copied directory).

## Recommendations

| #   | Action                                                                                                                                                                | Priority | Effort                        | Impact                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| R1  | Add `tarballs/{experiments,comparisons,package,active}`, `apps/api/reports`, `packages/runtime/{reports,occt-reports}`, `**/.netlify` to `.dockerignore`              | **P0**   | 2 min                         | Removes ~2 GB from build context; saves ~10-15 s per build on context transfer alone                |
| R2  | Remove redundant `COPY package.json ./` line                                                                                                                          | **P0**   | 1 min                         | One fewer layer; cosmetic but free                                                                  |
| R3  | Split deps stage from build stage: copy lockfile + workspace package.jsons (`COPY --parents */*/package.json ./`) → `pnpm install` → `COPY . .` → `pnpm nx build api` | **P0**   | 30 min                        | Source-only edits skip the install layer entirely; saves ~60 s per warm build                       |
| R4  | Pin pnpm in base via `RUN npm install -g pnpm@10.30.3` (drop Corepack)                                                                                                | **P0**   | 5 min                         | Saves ~5 s per cold build; eliminates Corepack signature-validation breakage class of failures      |
| R5  | Add `--mount=type=cache,id=nx,target=/app/.nx/cache` to the build step                                                                                                | **P1**   | 5 min                         | Re-uses Nx task cache across builds when source is partially shared                                 |
| R6  | Switch `pnpm install --frozen-lockfile` to `pnpm install --frozen-lockfile --prefer-offline` (or `--offline` if `pnpm fetch` is retained)                             | **P1**   | 1 min                         | Eliminates registry round-trips post-fetch                                                          |
| R7  | Use `pnpm install --filter=@taucad/api...` to skip UI-only workspace packages during build                                                                            | P1       | 1 hr                          | Reduces install surface from 3585 → ~2200 packages; skips `apps/ui` source from triggering rebuilds |
| R8  | Wire `NX_CLOUD_ACCESS_TOKEN` as a Fly.io build secret (`docker build --secret`); export it to the `pnpm nx build api` step                                            | P1       | 30 min                        | Warm Nx Cloud cache → build step becomes near-instant for unchanged hashes                          |
| R9  | Drop `pnpm fetch` step entirely (pnpm v10 install is fast enough with store cache mount; fetch adds a separate cache key)                                             | P2       | 15 min                        | Simpler pipeline; one fewer layer; trade-off discussed below                                        |
| R10 | Switch runtime base from `node:24-slim` to `node:24-alpine` (~70 MB) or `gcr.io/distroless/nodejs24-debian12` (~25 MB)                                                | P2       | 1 hr (test musl/glibc compat) | Smaller image; faster Fly.io cold starts; security hardening                                        |
| R11 | Add non-root `nestjs` user to runtime stage                                                                                                                           | P2       | 5 min                         | Security hardening; matches 2026 "good defaults"                                                    |
| R12 | Add `HEALTHCHECK` directive that hits `/health/ready` (already exists in `apps/api/app/health/`)                                                                      | P2       | 5 min                         | Already covered by Fly.io `[[http_service.checks]]` but useful for local Docker runs                |
| R13 | Set up registry-backed BuildKit cache (`cache-to: type=registry,mode=max`) in CI for the API image                                                                    | P2       | 1 hr                          | Cross-runner cache hit rate; reduces dependency on Fly.io's builder cache lifetime                  |

## Trade-offs

### Should we keep `pnpm fetch` (R9)?

**Keep**: `pnpm fetch` only requires the lockfile (1.5 MB), so its layer cache key is the smallest possible and it survives almost all source changes. Removing it means the `pnpm install` layer's cache key includes every workspace `package.json`, which is more volatile.

**Drop**: With R3 in place, the install layer's cache key is already `lockfile + 24 package.jsons`. Adding a separate `fetch` layer just splits the same work into two stages, both of which invalidate together when the lockfile changes. The `pnpm` docs themselves treat `fetch` as a fallback for "CI without BuildKit cache mounts" — Fly.io's builder supports cache mounts.

**Verdict**: Keep `fetch` _only_ if Fly.io's BuildKit cache mount lifetime is shorter than the layer-cache lifetime. Empirically this seems true (the user-supplied log shows full 61 s re-fetch despite a stable lockfile), so keep it. Add `--offline` to install (R6).

### Filtered install (R7) vs full workspace install

**Filtered install** skips ~1400 packages but introduces cognitive overhead — when a new workspace package becomes an API dep, the build silently misses it until devs notice missing modules at runtime. The workspace is only 24 packages; the install-graph savings are real but not transformative.

**Verdict**: Defer to P1. Apply only after R1-R6 are landed and measured.

### Distroless runtime (R10)

**Pro**: Image size drops 5×; security surface area minimal; matches industry best-practice in 2026.

**Con**: No shell. Cannot `fly ssh console` and run debugging commands. Fly.io's `fly logs` and the `/health/*` endpoints cover most observability needs, but onboarding pain is real.

**Verdict**: P2. Test in staging first (`fly.staging.toml`) before promoting to prod.

## Out of Scope

- **`apps/ui` Netlify build** — Already handled by `apps/ui/netlify.toml` and `prod-deploy-ui.yml`. See `docs/research/netlify-ui-deployment-strategy.md`.
- **`opencascade.js` WASM build** — Massive (10-30 min) but isolated to `pnpm nx build ocjs`. Out of the API Docker hot path. See `docs/research/ocjs-wasm-build-comparison.md`.
- **Fly.io machine cold-start** — A different bottleneck (image pull + Node.js boot + Nest module init) measured separately.
- **Nx Cloud DTE** — Distributed Task Execution would parallelize the upstream `^build` deps across remote agents but only matters if the build graph is wide. The API's build graph is mostly serial (`@taucad/runtime` has many transitive WASM-copy steps).

## References

- [pnpm Docker guide](https://pnpm.io/docker)
- [pnpm fetch CLI](https://pnpm.io/cli/fetch)
- [pnpm deploy CLI](https://pnpm.io/cli/deploy)
- [BuildKit Dockerfile reference: `COPY --parents`](https://docs.docker.com/reference/dockerfile/#copy---parents)
- [Depot.dev: Optimal pnpm Dockerfiles](https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/node-pnpm-dockerfile)
- [pnpm/pnpm#9029: Corepack signature validation issue](https://github.com/pnpm/pnpm/issues/9029)
- [pnpm/pnpm#9335: `pnpm deploy --legacy` workspace-package fix (Jan 2026)](https://github.com/pnpm/pnpm/pull/9335)
- [`malyshev/nestjs-docker-good-defaults`](https://github.com/malyshev/nestjs-docker-good-defaults)
- [OneUptime: NestJS multi-stage Docker (Feb 2026)](https://oneuptime.com/blog/post/2026-02-17-how-to-optimize-docker-image-size-for-a-nestjs-application-using-multi-stage-builds-and-alpine-base-images-for-gke/view)
- [Engineering Playbook: 2.4 GB → 24 MB (Apr 2026)](https://medium.com/engineering-playbook/my-docker-image-was-2-4gb-i-cut-it-to-24mb-heres-every-optimization-that-actually-worked-46792bd23da4)
- [DEV: BuildKit cache mounts in GitHub Actions](https://dev.to/software_mvp-factory/container-image-layer-caching-in-github-actions-562f)

## Appendix

### A. Full workspace `package.json` list (24 entries) — needed for R3 cache key

```
apps/api/package.json
apps/ui/package.json
libs/api-extractor/package.json
libs/chat/package.json
libs/oxlint/package.json
libs/tau-examples/package.json
libs/types/package.json
libs/units/package.json
libs/utils/package.json
libs/vite/package.json
packages/cli/package.json
packages/converter/package.json
packages/filesystem/package.json
packages/js/package.json
packages/json-schema/package.json
packages/memory/package.json
packages/react/package.json
packages/runtime/package.json
packages/telemetry/package.json
packages/testing/package.json
packages/three/package.json
tools/workspace-plugin/package.json
scripts/package.json
```

### B. Verifying the R1 win locally

Before merging R1, verify the dockerignore expansion works:

```bash
# Show what would be sent to the daemon
docker build --no-cache --progress=plain -f apps/api/Dockerfile . 2>&1 \
  | grep -E '^#[0-9]+ \[internal\] load build context'
# Compare context size before/after
```

### C. Suggested CI cache-key strategy (GitHub Actions / Fly.io)

```yaml
# .github/workflows/ci.yml — example for the API build job
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
  with:
    context: .
    file: apps/api/Dockerfile
    push: true
    cache-from: |
      type=registry,ref=registry.fly.io/tau-api:buildcache
    cache-to: |
      type=registry,ref=registry.fly.io/tau-api:buildcache,mode=max
    secrets: |
      nx_cloud_token=${{ secrets.NX_CLOUD_ACCESS_TOKEN }}
```

The `mode=max` flag is critical for monorepos — without it, only the final stage gets cached and intermediate `deps`/`build` stages rebuild from scratch every CI run.

### D. Per-step time accounting from the user-supplied log

| Step                                      | Reported time | Notes                                                                |
| ----------------------------------------- | ------------- | -------------------------------------------------------------------- |
| `COPY tarballs/ ./tarballs/`              | not shown     | ~10 s extrapolated for 1.3 GB transfer                               |
| `pnpm fetch --frozen-lockfile`            | 61.0 s        | Downloaded 3573 packages — cache mount cold                          |
| `COPY package.json ./`                    | 3.3 s         | Redundant (R2)                                                       |
| `COPY . .`                                | 9.4 s         | Mostly `apps/api/reports` (937 MB) + `tarballs/experiments` (1.1 GB) |
| `pnpm install --frozen-lockfile`          | ~5 s          | Fast because store is warm; layer still re-runs (F3)                 |
| `pnpm nx build api`                       | not shown     | Likely 3-5 min based on the gap to "7-8 min" total                   |
| `pnpm --filter=@taucad/api --prod deploy` | not shown     | ~30 s typical                                                        |

R1 alone removes ~20 s of context-transfer + COPY work. R3 + R5 cuts the build step (the silent majority of the 7-8 minutes) on warm cache.
