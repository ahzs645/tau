---
title: '/api/npm Caching & Reproducible Snapshot Lockfile'
description: 'Blueprint for a same-origin npm proxy with strong HTTP caching plus a /.tau/lockfile.json that pins every npm + plugin + parts dependency by version+sha256, enabling fully reproducible publication snapshots and offline-first reloads.'
status: draft
created: '2026-04-23'
updated: '2026-04-23'
category: architecture
related:
  - docs/research/node-modules-single-source-of-truth.md
  - docs/research/dynamic-runtime-plugins.md
  - docs/research/tau-parts-registry-and-marketplace.md
  - docs/research/sharing-architecture.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/policy/filesystem-policy.md
---

# /api/npm Caching & Reproducible Snapshot Lockfile

Blueprint for the network and reproducibility layer underneath [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md): a same-origin `/api/npm/*` proxy with content-addressed caching that mirrors registry tarballs, plus a `/.tau/lockfile.json` that captures the exact resolved version + sha256 of every dependency (npm packages, runtime plugins per [`dynamic-runtime-plugins.md`](./dynamic-runtime-plugins.md), and Tau Parts per [`tau-parts-registry-and-marketplace.md`](./tau-parts-registry-and-marketplace.md)) so publications opened by another user — or by the same user months later — install the byte-identical dependency tree.

## Executive Summary

Today the runtime fetches CDN modules directly from `esm.sh` and `jsdelivr` (`module-manager.ts:199-219`) and `TypeAcquisitionService` does the same for `.d.ts` files. This bypasses the workspace's same-origin proxy convention, leaks third-party origins into the COEP boundary, prevents audit logging, and offers no way to pin dependencies for reproducibility. The recommendation is a single `/api/npm/*` Express route that mirrors the npm registry (`registry.npmjs.org`), serves bytes-from-disk (R2 in production, MinIO in dev) with `Cache-Control: public, max-age=31536000, immutable` for versioned files, and resolves through a content-addressed key (sha256) so identical files dedupe across packages and projects. The proxy is the network half; the storage half is the **lockfile**: when `PackageInstaller` (from R2 in [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md)) installs a package, it writes the resolved `(name, version, sha256, integrity)` tuple into `/.tau/lockfile.json`. A publication includes the lockfile (per `sharing-architecture.md` SG15: `node_modules` excluded, derived state filtered, but **authored config and lockfile are project content**); the viewer's installer replays from the lockfile against `/api/npm` and reproduces the exact tree the author saw.

This unlocks three properties at once: **reproducibility** (every publication can be re-rendered byte-identically forever), **offline-first** (lockfile + R2 mirror + Service Worker = installs work with no live npm registry), and **audit/abuse safety** (every dependency a user installs is logged through Tau-owned infrastructure, with the option to ban malicious packages or shim deprecated ones at the proxy edge). The cost is one Express route, one Postgres table for the npm-mirror cache, and a 100-LOC lockfile reader/writer.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Scope and Non-Goals](#scope-and-non-goals)
- [Findings](#findings)
- [Target Architecture](#target-architecture)
- [`/api/npm/*` Endpoint Design](#apinpm-endpoint-design)
- [Lockfile Format](#lockfile-format)
- [Publication Integration](#publication-integration)
- [Recommendations Roadmap](#recommendations-roadmap)
- [Trade-offs](#trade-offs)
- [Open Questions](#open-questions)
- [References](#references)

## Problem Statement

Three independent gaps converge:

1. **No same-origin proxy for npm.** Every other third-party asset is proxied (PostHog `/api/ph`, GitHub avatars `/api/github-avatar`) per `safari-cross-origin-isolation.md` to satisfy COEP `require-corp`. esm.sh works only because it sets permissive CORP headers — but it's the only place in the app that bypasses the proxy convention, and it leaves the user dependent on an external CDN's uptime + abuse policy.
2. **No version pinning.** `module-manager.ts:199-205` fetches `https://esm.sh/<pkg>?bundle` with no version constraint — esm.sh resolves to "latest", which means the same `import 'lodash'` produces different bytes across sessions whenever upstream releases. There is no `package-lock.json` equivalent.
3. **No reproducibility for publications.** `sharing-architecture.md` SG15 explicitly excludes `/node_modules/` from publication payloads (correct — it's derived). But without a lockfile, "derived from what?" has no answer — the viewer would re-resolve "latest" and see different dependencies than the author. The publication is **non-reproducible by construction**.

A single integrated solution closes all three: a `/api/npm/*` proxy plus a `/.tau/lockfile.json` plus a publication payload that includes the lockfile and replays installs through the proxy.

## Scope and Non-Goals

**In scope**

- `/api/npm/*` Express route specification (endpoints, response shapes, cache headers).
- Backing storage: R2 for production cache, MinIO for dev (reuses `sharing-architecture.md` `ObjectStorageService`).
- Mirror semantics: which registry, which subset of files, when to fetch upstream, when to evict.
- Lockfile format: structure, writer, reader, integrity verification.
- Publication-payload integration: how lockfile is included; viewer replay path.
- Service Worker bridging: how the browser caches lockfile-resolved files for offline use.
- Plugin and Parts integration: lockfile pins plugins (per [`dynamic-runtime-plugins.md`](./dynamic-runtime-plugins.md)) and parts (per [`tau-parts-registry-and-marketplace.md`](./tau-parts-registry-and-marketplace.md)) the same way it pins npm.

**Out of scope**

- Becoming an npm registry (we mirror, not host).
- Multi-region replication of the cache (R2 already does this implicitly via Cloudflare's edge).
- Private packages / npm authentication (defer; Tau is open-source-package-only for now).
- Migrating away from esm.sh's bundling entirely (the proxy wraps both npm tarballs and esm.sh-style bundles; defer the choice per [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md) Open Question 2).
- Garbage-collecting cached blobs (defer; storage is cheap on R2).

## Findings

### Finding 1: Cloudflare R2 already chosen as the publication store; reuse it for npm

`sharing-architecture.md` SG12 commits to R2 (production) and MinIO (dev) behind a single `ObjectStorageService` abstraction. The npm cache fits the same shape: content-addressed blobs (sha256 keys), append-only writes, public reads, immutable-once-written. The bucket structure becomes:

```
tau-content/
  publications/<sha256>             ← from sharing-architecture
  npm/<sha256>                      ← npm tarball blobs
  parts/<sha256>                    ← from tau-parts-registry-and-marketplace
  blobs/<sha256>                    ← project file blobs
```

One bucket, one API surface, one billing line. R2's `If-None-Match: '*'` conditional PUT primitive (cited in `sharing-architecture.md`) provides atomic dedup: writing the same sha256 twice short-circuits.

### Finding 2: npm registry tarballs are stable + content-addressable

`https://registry.npmjs.org/<pkg>` returns a JSON manifest listing every published version with a `tarball` URL and a `dist.shasum` (npm's own integrity hash). Tarballs at `https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz` are immutable — once published, they never change content. This is exactly the property we need; we just need to mirror them.

```json
// excerpt from registry.npmjs.org/lodash
{
  "versions": {
    "4.17.21": {
      "name": "lodash",
      "version": "4.17.21",
      "dist": {
        "shasum": "679591c564c3bffaae8454cf0b3df370c3d6911c",
        "tarball": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
        "integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg=="
      }
    }
  }
}
```

The proxy mirrors `versions[version].dist.integrity` and `tarball` — both are first-class npm artifacts with strict immutability semantics.

### Finding 3: Two cache tiers are required and natural

| Tier         | Lifetime            | Mutable?                     | Examples                               |
| ------------ | ------------------- | ---------------------------- | -------------------------------------- |
| **Metadata** | Short (5–60 min)    | Yes — new versions get added | `/api/npm/lodash` → version manifest   |
| **Content**  | Forever — immutable | No                           | `/api/npm/lodash/4.17.21/lib/index.js` |

Content tier gets `Cache-Control: public, max-age=31536000, immutable` — the strongest possible HTTP cache hint. Browsers, CDNs, Service Workers all aggressively cache. Metadata tier gets `Cache-Control: public, max-age=300, stale-while-revalidate=86400` — fresh enough for a developer asking "did `lodash@4.17.22` ship yet?" but cheap to serve at scale.

### Finding 4: Service Worker provides the offline-first piece

A Service Worker registered at app-load time can intercept `/api/npm/*` requests and:

1. **First load**: pass through to network, cache the response in the `tau-npm-v1` Cache Storage.
2. **Repeat load**: serve from cache (zero network), revalidate metadata in background.
3. **Offline**: serve from cache; fall back to in-page `/.tau/lockfile.json`-driven OPFS reads if the cache misses.

This makes the SAB-warm OPFS path from [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md) the second-tier cache (after Service Worker) rather than the first. Combined: every package fetch hits memory → SAB → OPFS → Service Worker → R2 → npm registry, in that order, with cache hits at every level.

### Finding 5: Lockfile design — semver pin, sha256 verify, integrity guard

The npm `package-lock.json` v3 format (since npm 7) is the relevant prior art: `(name, version, resolved, integrity, dependencies)` per package. Tau's lockfile is a strict subset because Tau's `node_modules` is flat (per [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md)'s real-package-tree install): each top-level dep's exact version + sha256 + transitive resolution is recorded, no nested `node_modules` paths, no peer-dep conflicts.

```json
{
  "lockfileVersion": 1,
  "name": "user-project-id",
  "packages": {
    "lodash": {
      "version": "4.17.21",
      "integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
      "resolved": "/api/npm/lodash/4.17.21/-/lodash-4.17.21.tgz",
      "files": {
        "package.json": "sha256:9e8c2f...",
        "lodash.js": "sha256:14a67c...",
        "fp/_baseConvert.js": "sha256:91ab3d..."
        // ... per-file sha256 for cherry-pick verification
      }
    },
    "@taucad/runtime": {
      "version": "1.4.2",
      "kind": "runtime"
    },
    "@acme/sketch-kernel": {
      "version": "0.3.1",
      "integrity": "sha512-...",
      "resolved": "/api/npm/@acme/sketch-kernel/0.3.1/-/sketch-kernel-0.3.1.tgz",
      "kind": "plugin"
    },
    "@tau/parts/m3-pivot-hinge": {
      "version": "1.0.0",
      "integrity": "sha256:...",
      "resolved": "/api/parts/m3-pivot-hinge/1.0.0",
      "kind": "part"
    }
  }
}
```

`kind` tags (`'npm'` default, `'plugin'`, `'part'`, `'runtime'`) let the lockfile track dependencies from multiple sources in one structure — npm, the dynamic-plugin loader, and the Parts Registry all flow through the same install protocol.

### Finding 6: SG15 and SG16 in `sharing-architecture.md` already make this safe

The publication-content audit explicitly excluded `/node_modules/` (SG15: derived) and user-level cookies (SG16: not project-scoped). It did NOT exclude `/.tau/`-namespaced files, which are project-scoped authored or pinned state. Including the lockfile in publications is consistent with that audit; the only addition is filtering rule "everything under `/.tau/cache/` excluded; everything else under `/.tau/` included" — natural, principled, mirrors `git`'s `.gitignore` pattern of "this directory is mine but not its `cache/`".

## Target Architecture

```
                                      ┌─────────────────────────┐
                                      │   npm registry (canon)  │
                                      └─────────┬───────────────┘
                                                │ first-time fetch
                                                ▼
              ┌──────────────────────┐    ┌────────────┐
              │  /api/npm/* (Express)│◀───│   R2/MinIO │ (sha256 blobs)
              └──────────┬───────────┘    └────────────┘
                         │  Cache-Control: immutable
                         ▼
              ┌──────────────────────┐
              │  Service Worker      │ (tau-npm-v1 Cache Storage)
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  PackageInstaller    │ (in FM worker)
              │   - reads lockfile   │
              │   - writes /node_mods│
              │   - writes lockfile  │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  OPFS /node_modules/ │ (per node-modules-SSoT)
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  SharedPool (SAB)    │ (warm reads)
              └──────────────────────┘
```

| Layer                        | Module                                                                                                                       | Responsibility                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Express proxy**            | New `apps/ui/server.ts` `npmRouter` (or `apps/api` if we need shared infra)                                                  | `/api/npm/*` endpoints; CORP headers; cache headers; R2 read-through        |
| **Storage**                  | Existing `ObjectStorageService` (per `sharing-architecture.md`)                                                              | sha256-keyed blobs in `tau-content/npm/<sha256>` and metadata cache         |
| **Postgres mirror metadata** | New `npm_package_version` table                                                                                              | Caches version manifests and tarball→sha256 mapping; TTL on metadata        |
| **Service Worker**           | New `apps/ui/app/service-worker.ts`                                                                                          | Intercepts `/api/npm/*`; Cache Storage; offline fallback to OPFS            |
| **PackageInstaller**         | Refactored `module-manager.ts` (per [`node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md) R2) | Resolves through lockfile if present; otherwise calls `/api/npm/*` and pins |
| **Lockfile reader/writer**   | New `@taucad/lockfile` package                                                                                               | Reads `/.tau/lockfile.json`, applies updates, validates integrity           |
| **Publication integrator**   | `sharing-architecture.md` publication writer                                                                                 | Bundles lockfile into publication manifest; viewer applies on hydrate       |

## `/api/npm/*` Endpoint Design

| Method | Path                                                        | Purpose                                                     | Cache headers                                                      |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/npm/:scope?/:pkg`                                     | Version manifest (mirrors `registry.npmjs.org/<pkg>`)       | `Cache-Control: public, max-age=300, stale-while-revalidate=86400` |
| GET    | `/api/npm/:scope?/:pkg/:version`                            | Single-version manifest                                     | `Cache-Control: public, max-age=31536000, immutable`               |
| GET    | `/api/npm/:scope?/:pkg/:version/-/:tarball`                 | Tarball download                                            | `Cache-Control: public, max-age=31536000, immutable`               |
| GET    | `/api/npm/:scope?/:pkg/:version/files/*`                    | Per-file extraction from tarball (avoids client-side untar) | `Cache-Control: public, max-age=31536000, immutable`               |
| GET    | `/api/npm/-/sha256/:sha`                                    | Content-addressed lookup (lockfile replay)                  | `Cache-Control: public, max-age=31536000, immutable`               |
| POST   | `/api/npm/-/resolve` (body: `{ specs: [{ name, range }] }`) | Batch resolver: returns lockfile-shaped resolutions         | `Cache-Control: no-store` (per-request)                            |

All responses set:

- `Cross-Origin-Resource-Policy: same-origin` (COEP-safe).
- `Cross-Origin-Embedder-Policy: require-corp`.
- `X-Content-Type-Options: nosniff`.
- `Content-Type: application/javascript` for `.js`, `application/typescript` for `.ts`, `application/json` for manifests.

### Why per-file extraction (not just tarball)

Tarballs include test fixtures, READMEs, source maps, build configs — often 10× larger than the runtime-relevant subset. Extracting on the server lets us:

- Serve only the file the bundler asked for (one HTTP round-trip).
- Compute and cache per-file sha256s for the lockfile.
- Skip extraction entirely on cache hits.

The server-side untar is a one-time cost per `(pkg, version)`; results are stored in R2 under `tau-content/npm/<sha256>` and indexed in `npm_package_version.files`.

### Why a content-addressed `/api/npm/-/sha256/:sha` endpoint

Lockfile replay is a content-first flow: "give me the bytes for sha256 `91ab3d...`." Going through the package/version path is wasteful and risks drift if someone unpublishes a version. The sha256 endpoint is the canonical lockfile resolver; the package/version paths are the discovery surface.

## Lockfile Format

```typescript
// @taucad/lockfile types
export type LockfileEntry = {
  /** Resolved version (semver). */
  version: string;
  /** npm-style integrity hash (sha512 base64) for tarball-sourced packages. */
  integrity?: string;
  /** Resolved URL — '/api/npm/...', '/api/parts/...', or runtime built-in marker. */
  resolved: string;
  /** Per-file sha256 — only present for non-bundled installs. */
  files?: Record<string, string>;
  /** Source classification. */
  kind: 'npm' | 'plugin' | 'part' | 'runtime' | 'builtin';
  /** Transitive deps — recorded for fully reproducible installs. */
  dependencies?: Record<string, string>; // name → version pin
};

export type Lockfile = {
  lockfileVersion: 1;
  name: string;
  packages: Record<string, LockfileEntry>;
  /** Pin of the runtime version this project was authored against. */
  runtime?: { version: string; integrity?: string };
};
```

### Lifecycle

1. **First install**: User imports `'lodash'` for the first time. `PackageInstaller` calls `/api/npm/lodash`, picks the matching version (default: latest stable), downloads, extracts, writes files to `/node_modules/lodash/`, **and writes a lockfile entry** with version + integrity + per-file sha256.
2. **Subsequent loads in the same project**: `PackageInstaller` reads the lockfile first; if entry exists and OPFS has the files, skip network entirely.
3. **Project opened on a different device / browser**: Lockfile present from publication or sync; `PackageInstaller` replays — fetches each file from `/api/npm/-/sha256/:sha`, writes to OPFS, verifies sha256 on write.
4. **User explicitly bumps a version** (`pnpm tau install lodash@latest` or via UI): Re-fetches metadata, writes new lockfile entry, re-installs files.
5. **Publication rebuild**: Author lockfile is the source of truth; viewer replays exactly.

### Integrity verification

Every file written to OPFS is sha256-verified against the lockfile entry. Mismatch → typed `LockfileIntegrityError`, install aborted, surfaced in UI as "the registry returned different bytes than the lockfile expected — possible compromise or upstream republish."

### `taucad.config.ts` and Parts share the lockfile

Per [`dynamic-runtime-plugins.md`](./dynamic-runtime-plugins.md), `taucad.config.ts` declares plugins as imports. Resolved imports become lockfile entries with `kind: 'plugin'`. Per [`tau-parts-registry-and-marketplace.md`](./tau-parts-registry-and-marketplace.md), Parts have their own resolved URL pattern (`/api/parts/...`) and become lockfile entries with `kind: 'part'`. **Three distribution channels, one lockfile** — the simplest possible reproducibility surface.

## Publication Integration

Per [`sharing-architecture.md`](./sharing-architecture.md), publications are content-addressed; their manifest lists every blob. The lockfile is just one more file in the publication payload — written once by the author at publish time, replayed on every viewer hydrate.

### Publication payload changes

```json
{
  "publicationId": "p_abc123",
  "manifest": {
    "files": {
      "src/cube.ts": "sha256:...",
      ".tau/lockfile.json": "sha256:...", // NEW
      "taucad.config.ts": "sha256:...", // NEW
      ".tau/parameters/cube.ts.json": "sha256:..."
    },
    "runtime": {
      // NEW
      "version": "^1.4.0",
      "exact": "1.4.2",
      "integrity": "sha512-..."
    },
    "derivatives": {
      "preview.glb": "sha256:..."
    }
  }
}
```

### Viewer hydrate sequence

```
1. Receive publication payload from /api/publications/:id
2. Fetch all manifest files into project FS (including .tau/lockfile.json)
3. PackageInstaller.applyLockfile()
   - For each lockfile entry: fetch from /api/npm/-/sha256/:sha into /node_modules/
   - Verify sha256 on write
4. RuntimeClient.connect() with config from taucad.config.ts (per dynamic-runtime-plugins)
5. Initial render uses preview.glb derivative for instant paint
6. Interactive kernel finishes loading → live render replaces preview
```

Step 3 is the critical reproducibility step. Because the lockfile pins exact bytes by sha256 and `/api/npm` mirrors npm immutably, the viewer's `/node_modules/` is byte-identical to the author's at publish time. Forks fork the lockfile; explicit `tau update` is the only way to drift.

### Reproducibility guarantee

A publication is **byte-reproducible** if and only if:

1. The lockfile is present in the manifest.
2. Every entry's `resolved` URL is internal (`/api/npm/*` or `/api/parts/*`) — no upstream-only URLs.
3. The runtime version is pinned (`runtime.exact`).

The publication writer enforces (1) and (3); `/api/npm` and `/api/parts` mirror everything they serve, satisfying (2). A publication that fails any of these is flagged in the UI as "non-reproducible" and the publish action surfaces a warning.

## Recommendations Roadmap

| #   | Action                                                                                                                                                                                   | Priority | Effort | Impact                                           | Phase |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------ | ----- |
| R1  | Add `/api/npm/:pkg`, `/api/npm/:pkg/:version`, `/api/npm/-/sha256/:sha` to `apps/ui/server.ts`. Read-through against `registry.npmjs.org`; cache in R2/MinIO via `ObjectStorageService`. | **P0**   | M      | Same-origin proxy compliance; offline-pinnable   | 1     |
| R2  | Implement Postgres `npm_package_version` table for metadata cache (versions, tarball→sha256). TTL via `expires_at` column.                                                               | **P0**   | S      | Metadata caching; query-time resolution          | 1     |
| R3  | Implement server-side tarball extraction: untar once per (pkg, version), index per-file sha256, store individual files in R2 under `npm/<sha256>`.                                       | **P1**   | M      | Per-file fetches; bandwidth efficiency           | 1     |
| R4  | Add `Cache-Control: public, max-age=31536000, immutable` to all immutable responses; `max-age=300, stale-while-revalidate=86400` to metadata.                                            | **P0**   | XS     | CDN + browser caching                            | 1     |
| R5  | Replace `module-manager.ts:199-205` direct esm.sh fetch with `PackageInstaller` calling `/api/npm/-/resolve` then per-file fetches.                                                      | **P0**   | M      | Closes the only third-party fetch in the runtime | 1     |
| R6  | Implement `@taucad/lockfile` package with reader/writer + integrity verification + typed `LockfileIntegrityError`.                                                                       | **P0**   | S      | Foundation for reproducibility                   | 1     |
| R7  | Wire `PackageInstaller` to write/read `/.tau/lockfile.json`. First install pins; subsequent installs replay; explicit `tau update` re-resolves.                                          | **P0**   | M      | Per-project reproducibility                      | 1     |
| R8  | Service Worker registration in `apps/ui/app/root.tsx`. Intercepts `/api/npm/*`, uses Cache Storage `tau-npm-v1`. Offline fallback.                                                       | **P1**   | M      | Offline-first reload                             | 2     |
| R9  | Publication payload extension: include `.tau/lockfile.json`, `taucad.config.ts`, and `runtime` pin in the manifest. Viewer's hydrate sequence includes `applyLockfile`.                  | **P1**   | M      | End-to-end publication reproducibility           | 2     |
| R10 | Publish-time validator: warns if any lockfile entry has an external `resolved` URL or if `runtime.exact` is missing.                                                                     | **P1**   | S      | Reproducibility guarantee enforcement            | 2     |
| R11 | UI: "Update dependencies" command in command palette (re-resolves and re-pins); per-package "view licence/source" link to `/api/npm/:pkg/:version`.                                      | **P2**   | M      | Author DX                                        | 2     |
| R12 | Banned-package list at the proxy edge: a configurable set of name globs that `/api/npm` refuses to serve (security incidents, legal requests).                                           | **P2**   | S      | Operational safety                               | 3     |
| R13 | Per-version provenance display in the marketplace UI: "this lockfile pin matches npm registry sha256 X verified at time Y by /api/npm"                                                   | **P3**   | M      | Trust signaling                                  | 3     |
| R14 | Replicate R2 reads to a CDN edge (Cloudflare Workers) for sub-50ms global latency on cold cache misses.                                                                                  | **P3**   | M      | Performance polish                               | 3     |
| R15 | Document the contract in `docs/policy/filesystem-policy.md` §Lockfile and pin lockfile inclusion as part of `sharing-architecture.md`'s publication contract.                            | **P2**   | XS     | Policy lock-in                                   | 2     |

## Trade-offs

### Tarball mirror vs. per-file extraction

| Dimension                 | Mirror tarballs only      | Per-file extraction (recommended) |
| ------------------------- | ------------------------- | --------------------------------- |
| Server complexity         | Trivial                   | One-time tar extract on miss      |
| Client complexity         | Must untar in browser     | Trivial fetch                     |
| Bandwidth                 | Always full tarball       | Only files actually imported      |
| First-load latency        | Single round-trip per pkg | One round-trip per file           |
| Cacheability              | Tarball-level             | File-level — finer-grained        |
| Tree-shaking friendliness | Poor (must unpack first)  | Excellent                         |

Per-file extraction wins for dev DX; tarball is a fallback for `pnpm install`-style bulk operations. Recommend per-file as primary, tarball endpoint retained for tooling.

### Esm.sh proxy vs. tarball + esbuild bundle

| Dimension                     | Proxy esm.sh (today's flow)                                            | Mirror tarballs + bundle in worker |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| Bundle correctness            | esm.sh decides                                                         | Tau decides (more control)         |
| Subpath resolution            | esm.sh-specific URLs                                                   | Standard package.json#exports      |
| `.d.ts` co-location           | Must fetch separately                                                  | Native — types in same tarball     |
| External dep on esm.sh uptime | Yes                                                                    | No                                 |
| Storage cost                  | Lower (CDN already cached)                                             | Higher (we mirror everything)      |
| **Verdict**                   | Esm.sh fine for prototype; tarball-mirror is the SSoT-friendly endgame |                                    |

This blueprint commits to tarball-mirror; the migration aligns with `node-modules-single-source-of-truth.md` R2 (real package-tree install).

### Lockfile granularity: top-level vs. transitive

Recording only top-level deps is insufficient — transitive bumps (e.g., `lodash`'s dep `lodash.merge` getting a security patch) silently drift. Full transitive recording matches npm's `package-lock.json` and is the only way to claim byte-reproducibility. Cost: lockfile size grows with project complexity (a 50-dep project produces ~50KB of lockfile JSON; gzip-compresses to ~5KB). Acceptable.

### Where the proxy lives: `apps/ui/server.ts` vs `apps/api`

| Dimension                        | `apps/ui/server.ts` (UI Express)                                         | `apps/api` (NestJS)                    |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| Co-location with COEP middleware | Yes (already there)                                                      | No — would need a second wiring        |
| Proximity to FS / static assets  | Yes                                                                      | No                                     |
| Database access                  | None today                                                               | Yes — easier for `npm_package_version` |
| Auth / rate-limiting             | Minimal today                                                            | Full Better Auth integration           |
| **Verdict**                      | UI proxy for the read path; API owns metadata writes via background jobs |                                        |

Recommended split: `apps/ui/server.ts` serves `/api/npm/*` reads, fronting R2 directly. `apps/api` runs a background ingestion job that monitors `registry.npmjs.org` for new versions of packages we've ever served and pre-warms the cache.

### Lockfile in publications: opt-in vs. always

Always-include is simpler and matches the reproducibility goal. Opt-out only for users who want "always-latest" behaviour — which contradicts publication semantics. Recommend always-include in publications; skip the opt-out for v1.

## Open Questions

1. **Should `/api/npm` serve `.d.ts` separately or always inside tarballs?** Most modern packages bundle `.d.ts` in the same tarball; legacy packages have separate `@types/*`. The proxy resolves both transparently; no special-casing needed.
2. **What about ESM-only vs CJS-only packages?** `package.json#exports` resolution handles this; `TauResolver` (per [`vscode-style-resolution-and-virtual-types.md`](./vscode-style-resolution-and-virtual-types.md)) consumes the result.
3. **Should the lockfile track the runtime version used at install time?** Yes — already in the spec (`runtime: { version, exact }`). Critical for "this lockfile was built with @taucad/runtime 1.4.2; viewer running 2.0 must warn or refuse."
4. **What's the upgrade path for projects without lockfiles today?** First load auto-pins to current resolved versions. No data migration; the lockfile is authoritative going forward.
5. **How does the proxy handle deprecated/unpublished packages?** npm's deprecated flag is informational; we still mirror. Unpublished tarballs (rare; tightly controlled by npm) fall back to our cached copy — exactly the protection the proxy provides.
6. **Rate limits on `/api/npm`**? Per-IP token bucket is sensible; share with existing Better Auth rate-limit middleware. Not blocking for v1.
7. **Garbage collection of the R2 mirror?** R2 storage is cheap ($0.015/GB-mo). Recommend never-evict for v1; revisit at 10TB+.
8. **Compliance / legal**: Mirroring npm tarballs is permitted by npm's TOS (it's the same model `mirrorjs`, `Verdaccio`, JSR mirrors use). Document in legal review at launch.

## References

External:

- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) — manifest format, integrity headers.
- [npm `package-lock.json` format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json) — lockfile prior art.
- [Subresource Integrity (SRI) spec](https://www.w3.org/TR/SRI/) — sha256/sha512 integrity contract.
- [HTTP `Cache-Control: immutable`](https://developer.mozilla.org/docs/Web/HTTP/Headers/Cache-Control#immutable) — strongest cache hint.
- [Cloudflare R2 conditional writes](https://developers.cloudflare.com/r2/api/s3/api/#supported-headers) — `If-None-Match: '*'` atomic dedup.
- [Service Worker Cache Storage](https://developer.mozilla.org/docs/Web/API/Cache) — offline cache surface.
- [Verdaccio](https://verdaccio.org/) — npm proxy registry prior art, similar architecture.

Internal:

- Foundation: [`docs/research/node-modules-single-source-of-truth.md`](./node-modules-single-source-of-truth.md) — what gets installed.
- Sibling blueprint: [`docs/research/dynamic-runtime-plugins.md`](./dynamic-runtime-plugins.md) — plugin lockfile entries.
- Sibling blueprint: [`docs/research/tau-parts-registry-and-marketplace.md`](./tau-parts-registry-and-marketplace.md) — Parts lockfile entries.
- Drives: [`docs/research/sharing-architecture.md`](./sharing-architecture.md) — publication payload extension; ObjectStorageService.
- Related: [`docs/research/safari-cross-origin-isolation.md`](./safari-cross-origin-isolation.md), [`docs/research/staging-cors-coep-safari-rendering-audit.md`](./staging-cors-coep-safari-rendering-audit.md) — COEP context for same-origin proxying.
- Policy: [`docs/policy/filesystem-policy.md`](../policy/filesystem-policy.md).
