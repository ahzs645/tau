---
title: 'node_modules as Single Source of Truth: Filesystem-Backed Module Resolution & IntelliSense'
description: 'Blueprint for a persistent, offline-first /node_modules cache shared by esbuild, Monaco IntelliSense, and the TS worker — fixes peek-to-open "File not found" navigation and establishes one filesystem as the resolution authority.'
status: draft
created: '2026-04-23'
updated: '2026-04-23'
category: architecture
related:
  - docs/research/filesystem-mount-overlay-architecture.md
  - docs/research/vscode-typescript-features.md
  - docs/research/monaco-lsp-lazy-activation-blueprint.md
  - docs/research/unresolved-dependency-watch-gap.md
  - docs/research/typescript-esm-extension-resolution.md
  - docs/research/cache-strategy-analysis.md
  - docs/research/safari-cross-origin-isolation.md
  - docs/research/staging-cors-coep-safari-rendering-audit.md
  - docs/research/sharing-architecture.md
  - docs/research/shared-worker-fs-architecture.md
  - docs/research/chatgpt-deep-research-brief.md
  - docs/policy/filesystem-policy.md
  - docs/policy/library-api-policy.md
---

# node_modules as Single Source of Truth: Filesystem-Backed Module Resolution & IntelliSense

Blueprint for collapsing today's three parallel "where do package types/sources live?" stories — Monaco's `addExtraLib`, the runtime worker's `/node_modules` CDN cache, and the main-thread `TypeAcquisitionService.fetchCache` — into one OPFS-backed filesystem that the bundler reads from, Monaco navigates into, and the TS worker resolves through. Treat this as the planning blueprint for the implementation work.

## Executive Summary

Monaco hover ("peek") works because `TypeAcquisitionService` injects `.d.ts` blobs into the TS worker via `addExtraLib`, but the editor's "Open Definition" / Cmd+Click flow opens the URI `file:///node_modules/<pkg>/index.d.ts` and finds **no Monaco model** — the editor pane shows a "File not found" placeholder (the smoking gun visible in the user's repro screenshot for `node_modules/opencascade.js/index.d.ts`). Concurrently, the runtime worker has its own real on-disk cache at `/node_modules/<pkg>/index.js` (OPFS-mounted), but stores **only the bundled JS** — no `.d.ts`, no subpath files, no real package tree to navigate. The two "node_modules" are conceptually the same and physically disjoint.

The recommended architecture (R1–R8) makes a single OPFS-backed `/node_modules` mount the **only** authoritative store: the runtime bundler (already today) reads from it; `TypeAcquisitionService` is collapsed into a populator that writes `.d.ts` files into the same tree; Monaco lazily creates editor models from FileService when a definition URI is opened; and the SharedPool/SAB layer accelerates repeat reads. Offline-first follows for free because the OPFS tree persists across sessions and is shared across projects. The migration is incremental — every step preserves working IntelliSense.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Current Architecture](#current-architecture)
4. [Findings](#findings)
5. [Target Architecture](#target-architecture)
6. [Recommendations Roadmap](#recommendations-roadmap)
7. [Trade-offs](#trade-offs)
8. [Open Questions](#open-questions)
9. [References](#references)
10. [Appendix: File Index](#appendix-file-index)

## Problem Statement

In `apps/ui/app/components/code/code-editor.client.tsx` Monaco hovers and inline completions correctly resolve types for both built-in packages (replicad, opencascade.js) and user-imported npm packages (lodash, three, etc.). However, user actions that _open_ a definition fail:

- **Peek Definition** (Cmd+Hover, Cmd+Option+Click) shows the inline overlay correctly because the TS worker has the type information.
- **Go to Definition** (Cmd+Click, F12) opens a Monaco editor pane on the URI returned by the TS worker — typically `file:///node_modules/<pkg>/index.d.ts` — and the pane renders a "File not found" placeholder with a "Select file to edit..." dropdown (smoking gun in the repro screenshot for `node_modules/opencascade.js/index.d.ts`).

The same `file:///node_modules/<pkg>/...` namespace also exists physically on the runtime worker's filesystem (OPFS `tau-node-modules` mount), but populated with a different shape (bundled `index.js` only, no `.d.ts`, no subpath files, no cross-package navigation possible). This means even "lower-quality" navigation (jump to a single bundled file) doesn't work — the two `/node_modules` worlds never see each other.

**Goals for the new architecture**:

1. Definition navigation lands on a real, navigable Monaco model with full content and cross-file links.
2. The bundler resolves from the same tree it reads from at runtime — no second HTTP fetch, no duplicate cache state.
3. The cache is **offline-first** — once a package is fetched it persists across sessions, projects, and reloads with zero network access.
4. Repeat reads at runtime hit memory (SAB) — instant for hot paths.
5. No reinvented module-resolution wheel — use Node-style `node_modules/<pkg>/<entry>` layout that all tooling already understands.

## Methodology

The investigation combined three parallel deep explorations:

1. **Bundler resolution**: Read `packages/runtime/src/bundler/{esbuild-core,esbuild.bundler,module-manager,esbuild.constants}.ts`, the kernel-worker bundler facade, and the related dispatcher hand-off. Traced the full plugin chain for `import 'lodash'` from `onResolve` to `onLoad`.
2. **Filesystem stack**: Read `packages/filesystem/src/*`, the FM worker bootstrap, `FileContentService`, the runtime `filesystem-bridge.ts`, and `packages/memory` (`SharedPool`, `SharedMemoryArena`). Identified the SAB/UTF-8 path-population gap.
3. **Prior research survey**: Cross-read 30+ research docs in `docs/research/` and the relevant `docs/policy/*` files. Identified hard constraints (COEP, single-writer FS, sharing/publish boundaries) and prior partial designs that this blueprint completes.

Code references throughout this document use `file:line` form against the workspace at the time of writing. Two corroborating user-visible signals validated the bug hypothesis: the repro screenshot showing "File not found" on `index.d.ts`, and the explicit Monaco-side bypass at [`monaco-model-service.ts:377-384`](#appendix-file-index) that refuses to create models for any path containing `node_modules` (added defensively because today's tree-sync would otherwise pull bundled CDN blobs into the editor as project files).

## Current Architecture

### Three Parallel Worlds

| World                                     | Where it lives                                                                                                        | What it stores                                                                                                    | Who reads it                                                                                                            | Persistence                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A. Runtime bundler cache**              | OPFS `tau-node-modules` directory, mounted at `/node_modules/` in the FM worker FileService                           | One JS file per package (`index.js`) and a `package.json` commit marker — bundled output of `esm.sh/<pkg>?bundle` | esbuild `onLoad` (vfs namespace) inside the kernel worker, via `RuntimeFileSystem.readFile` over the postMessage bridge | OPFS — persistent, cross-project                       |
| **B. Monaco TS worker virtual FS**        | Lives only inside the TS Worker via `addExtraLib(content, filePath)` keyed by `file:///node_modules/<pkg>/index.d.ts` | One `.d.ts` blob per package, wrapped in `declare module '<pkg>' { ... }`                                         | The TS language service for diagnostics, completions, hover; **not** Monaco's editor model registry                     | In-memory only — lost on reload, never written to disk |
| **C. TypeAcquisitionService fetch cache** | Main-thread `Map<packageName, dtsContent>`                                                                            | Same `.d.ts` payloads as world B before they're injected                                                          | Avoids re-fetching from `esm.sh/<pkg>` on session change                                                                | In-memory — lost on reload                             |

These three worlds share a `/node_modules/<pkg>/` URL convention but **never share storage**. Worlds A and B/C are populated by different actors over different network calls (worker `ModuleManager` vs main-thread `TypeAcquisitionService`), with no coordination — the same package can be in one and not the other.

### Bundler Flow Today

For `import 'lodash'` from a user file (paraphrased from `esbuild-core.ts:401-651` and `module-manager.ts:109-150`):

```
user code (vfs namespace)
   |
   v
onResolve [filter: /.*/]
   - isBareSpecifier('lodash') -> true
   - builtinModules.has('lodash') -> false
   - moduleManager.ensureCdnModule('lodash')
        - check filesystem.exists('/node_modules/lodash/index.js')
            HIT  -> return
            MISS -> fetch 'https://esm.sh/lodash?bundle'
                    -> writeFile '/node_modules/lodash/index.js'
                    -> writeFile '/node_modules/lodash/package.json'  (commit marker)
   - return { path: '/node_modules/lodash/index.js', namespace: 'vfs' }
   |
   v
onLoad [namespace: vfs]
   - filesystem.readFile('/node_modules/lodash/index.js', 'utf8')
   - return { contents, resolveDir: '/node_modules/lodash' }
   |
   v
esbuild emits one bundled output string
extractDependencies(metafile)
   - INPUTS starting with '/' (i.e. /node_modules/...) are EXCLUDED from BundleResult.dependencies
   - so node_modules entries are NOT in the kernel watch set (good)
```

Critical secondary behaviors (from `esbuild-core.ts:632-637`, `kernel-worker.ts:1197-1221`):

- `unresolvedPaths` collects failed-load **project** paths (not `/node_modules/`) so that creating a missing `./helper.ts` later triggers a re-bundle.
- `KernelWorker.updateWatchSet` strips any path containing `.tau/cache/` and excludes that prefix from watches; nothing analogous exists for `/node_modules/`, but it's harmless today because `extractDependencies` already drops those entries.

### IntelliSense Flow Today

For the same `import 'lodash'` (paraphrased from `type-acquisition-service.ts:334-527`):

```
Monaco model content change (debounced 500ms)
   |
   v
es-module-lexer parses imports
   |
   v
for each bare specifier:
   acquireTypes('lodash')
      - fetchCache.has('lodash')      HIT  -> injectDynamicTypes(content)
                                      MISS -> fetch 'https://esm.sh/lodash'
                                              read X-TypeScript-Types header
                                              fetch the .d.ts URL (or chain)
                                              fetchCache.set('lodash', content)
                                              injectDynamicTypes(content)
                                                 - typescriptDefaults.addExtraLib(
                                                     `declare module 'lodash' { ${content} }`,
                                                     'file:///node_modules/lodash/index.d.ts'
                                                   )
                                                 - same for javascriptDefaults
```

The TS worker can now answer "what type does `_.debounce` have?" — but the URI `file:///node_modules/lodash/index.d.ts` has **no Monaco editor model** behind it. When the user invokes "Go to Definition" Monaco's code-editor service tries `monaco.editor.getModel(uri)`, gets null, and falls through to its empty-pane placeholder (the smoking gun screenshot).

### Filesystem Plumbing Available

Already in place and ready to be the SSoT (citations in [Appendix](#appendix-file-index)):

- **`/node_modules` mount**: FM worker mounts OPFS `tau-node-modules` at `/node_modules/` (`file-manager.worker.ts:106-119`). Falls through to root IndexedDB if OPFS unavailable. Already cross-project and persistent.
- **FileService**: Single-writer worker-side authority with `readFile`, `writeFile`, `exists`, `ensureDir`, `readdir`, watchers, mounts, throttled write coalescing (`file-service.ts:105-282`).
- **FilePool / SAB**: 50 MiB SharedArrayBuffer allocated by the FM machine, exposed to the worker as a `SharedPool` for `FileService` and to the runtime worker via the bridge for direct `resolveCopy()` (`file-manager.machine.ts:24-167`, `runtime-filesystem-bridge.ts:396-408`). Today the pool is populated only by **binary** `readFile` calls — UTF-8 reads bypass it (the "SAB gap" in §Findings).
- **Path helpers**: `getNodeModulesPath`, `getCdnCachePath` (`libs/utils/src/import.utils.ts:280-311`).
- **Bundler facade with cache**: `KernelWorker.createBundlerFacade` already memoizes `BundleResult` by entry path and reuses it for `resolveDependencies` (`kernel-worker.ts:2490-2523`).

## Findings

### F1 — Three populators, no shared store

The runtime worker (`ModuleManager`) and the main-thread (`TypeAcquisitionService`) both fetch from `esm.sh` for the same packages, write to disjoint caches, and never reconcile. Loading a project with `import 'lodash'` triggers two independent CDN round-trips — one for JS, one for types — that could be a single OPFS lookup if the cache were unified.

### F2 — Smoking gun: addExtraLib is invisible to the editor model registry

`monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri)` only feeds the TS Web Worker. Monaco's editor-model registry is a **separate** map (`monaco.editor.getModel(uri)` / `createModel`). The TS worker can return `uri` from a "Go to Definition" request, but Monaco's `IEditorService` then tries to resolve the URI to a model and finds nothing, producing the empty pane in the screenshot. This is a categorical gap, not a styling/rendering bug.

### F3 — Bundler cache shape ≠ navigable package layout

`ModuleManager` writes `esm.sh/<pkg>?bundle` output as a **single** `index.js`. `?bundle` inlines all transitive deps. Even if the editor could open `/node_modules/lodash/index.js`, navigation into `lodash/debounce` or out to a transitive dep would be impossible because they don't exist as files. This is sufficient for **execution** (esbuild only needs the bundled blob) but insufficient for **navigation**.

### F4 — Defensive Monaco bypass for `/node_modules`

`MonacoModelService` deliberately refuses to materialize models for any path containing `node_modules` (`monaco-model-service.ts:377-384`, `419-421`). This was correct under today's architecture (avoid pulling huge CDN blobs into the editor as if they were project files) but becomes the wrong default once `/node_modules` is the SSoT. The bypass needs to flip from "always skip" to "lazy on demand" once the cache is populated with real, navigable content.

### F5 — UTF-8 reads bypass the SAB pool

`FileService.readFile(path, 'utf8')` returns a string from the provider directly and does **not** call `filePool.store()` — only the binary path stores (`file-service.ts:105-124`). The runtime worker bridge has the same asymmetry (`runtime-filesystem-bridge.ts:173-179`). Esbuild's `onLoad` uses UTF-8 (`esbuild-core.ts:606-611`), so the SAB pool that's _supposedly_ the "instant repeat" hot cache for the bundler is **never populated** for the bundler's actual access pattern. Today this is masked by `BundleResult` memoization in `KernelWorker`, but it means the SAB acceleration the user expects is mostly inert for module reads.

### F6 — Pool capacity vs many small `.d.ts` files

`SharedPool` defaults are 4096 entries / 10 MiB per entry / 50 MiB total buffer with no LRU on the FM mount. A real `.d.ts` tree for OpenCascade.js has hundreds of files; a typical npm package has dozens. With LRU disabled, pool insertion silently returns `false` once the arena fills (the same observability anti-pattern that bit `BoundedFileCache` per `binary-file-open-perpetual-loading.md`). Any SSoT design that warms the pool with `.d.ts` content must enable LRU eviction and surface admission failures.

### F7 — COEP constrains direct esm.sh fetches

Tau ships `COEP: require-corp` (Safari-compatible, per `safari-cross-origin-isolation.md`) and same-origin proxies all third-party assets (PostHog `/api/ph`, GitHub avatars `/api/github-avatar`). Today both `ModuleManager` and `TypeAcquisitionService` fetch directly from `esm.sh` from a worker (which does not enforce COEP for top-level navigation but does enforce CORP on subresources). This works in practice because esm.sh sets `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, but it's the only place in the app that bypasses the proxy convention. The SSoT design is the right moment to align on `/api/npm/*` proxying for offline reproducibility, audit logging, and consistency.

### F8 — TypeScript ESM extension resolution gap (already documented)

Per `typescript-esm-extension-resolution.md` and `unresolved-dependency-watch-gap.md`, the bundler must remap `.js` → `.ts` and probe extensionless paths consistently with TS rules. Any FS-backed resolver added by this blueprint must inherit those existing semantics — not re-implement them — and must continue to populate `unresolvedPaths` for project-relative misses.

### F9 — Sharing boundary: `/node_modules` is derived

`sharing-architecture.md` (SG15) classifies `/node_modules/` as a derived, cross-project cache that **must not** be included in publication payloads. The SSoT must respect this boundary — any future "publish project" / "share project" flow excludes `/node_modules/**` (and any new `.tau/lockfile.json`-style metadata stays per-project, not per-cache).

### F10 — ATA-side eager activation already flagged

`monaco-lsp-lazy-activation-blueprint.md` (R-series) calls out that ATA + `addExtraLib` runs even when no JS/TS model exists. The SSoT design should not regress this — populating `/node_modules` should be lazy on first import seen in a JS/TS model, never eager on app boot.

## Target Architecture

### One Filesystem, Two Capabilities

```
                    +-----------------------------+
                    |   /node_modules/<pkg>/...   |
                    | OPFS-backed FileService     |
                    | (single source of truth)    |
                    +--------------+--------------+
                                   |
        +---------------+----------+----------+----------------+
        |               |                     |                |
        v               v                     v                v
   esbuild         Monaco editor         TS worker         Sharing/
   onLoad (vfs)    model registry        addExtraLib       publish
   (worker)        (lazy-on-open)        (file-backed)     (excluded)
```

The OPFS mount stays exactly where it is today (`tau-node-modules`, mounted at `/node_modules/`, root-level so it's shared across all projects). Population becomes lazy and demand-driven; reads are universal.

### Population Pipeline

A new `PackageInstaller` (worker-side, owned by `ModuleManager` or its successor) replaces the current "fetch one bundled JS" path with a **node_modules-shaped** install:

```
ensurePackage(name, subpath?, opts?: { types?: boolean })
  1. fast path: if /node_modules/<pkg>/package.json exists -> return
  2. dedup: in-flight Map<cacheKey, Promise>
  3. fetch metadata: GET /api/npm/<pkg>           (proxied; same-origin)
        body: { version, files: [...], typesEntry, mainEntry }
  4. fetch assets (parallel, bounded):
        for each file in files:
            GET /api/npm/<pkg>/<version>/<file>
            FileService.writeFile('/node_modules/<pkg>/<file>', bytes)
  5. write package.json LAST (commit marker) - same atomic-commit pattern as today
  6. (optional) populate SharedPool with hot subset (entry .js + entry .d.ts)
```

Two important shape decisions:

- **Drop `?bundle`**. Replace with esm.sh's standard mode (which serves real subpath files referencing each other via stable paths) or a server-side `/api/npm/*` proxy that mirrors npm registry tarballs. The latter is preferred (R3) because it gives Tau a single auditable cache provenance, deterministic offline behavior, and policy-friendly COEP compliance.
- **Co-locate `.d.ts` and `.js`** under the same package directory, exactly as a real `pnpm install` would. This is what makes Monaco navigation "just work" — `Standard_Real` inside `Standard.d.ts` resolves to a file the editor can open.

### Read Path: Bundler

No structural change. Esbuild `onLoad` still reads from `RuntimeFileSystem`. Two enhancements:

1. The vfs `onLoad` switches from `readFile(path, 'utf8')` to `readFile(path)` (binary), then decodes after a `filePool.store()` opportunity. Closes F5 — bundler reads now warm the SAB pool.
2. Resolution probes mirror Node's algorithm in `/node_modules/<pkg>/`: try `package.json#exports`, fall back to `package.json#main`, then conventional `index.{js,ts,d.ts}`. Reuses the existing `parsePackageSpecifier` + `resolveFileExtension` helpers.

### Read Path: Monaco Editor

`MonacoModelService` gains a **lazy materialization** path for `/node_modules/**`:

```typescript
override async getOrEnsureModel(path: string): Promise<Monaco.editor.ITextModel | undefined> {
  if (path.startsWith('/node_modules/')) {
    return this.getOrEnsurePackageModel(path);
  }
  return super.getOrEnsureModel(path);
}

private async getOrEnsurePackageModel(path: string): Promise<Monaco.editor.ITextModel | undefined> {
  const uri = this.monaco.Uri.parse(`file://${path}`);
  const existing = this.monaco.editor.getModel(uri);
  if (existing) return existing;

  const result = await this.contentService.resolve(path);
  if (result.kind !== 'text') return undefined;

  const model = this.monaco.editor.createModel(
    decodeTextFile(result.content),
    this.detectLanguage(path),
    uri,
  );
  // Mark as ephemeral package model: read-only, evict aggressively, no background sync
  this.packageModelPaths.add(path);
  return model;
}
```

Three guardrails: package models are **read-only** (`model.updateOptions` cannot enforce this directly — the editor is set `readOnly: true` when the active path matches), they are **excluded from background sync** (the existing `node_modules` exclusion in `syncAllInBackground` stays), and they evict more aggressively than project models (separate TTL, lower hard-cap).

### Read Path: TS Worker

`TypeAcquisitionService` is collapsed into a thin **registrar**:

```typescript
async ensureTypesForPackage(pkg: string): Promise<void> {
  await this.installer.ensurePackage(pkg, undefined, { types: true });
  const dtsPaths = await this.fileService.readdir(`/node_modules/${pkg}`, { recursive: true })
    .filter(p => p.endsWith('.d.ts'));

  for (const path of dtsPaths) {
    if (this.registeredDts.has(path)) continue;
    const content = await this.fileService.readFile(path, 'utf8');
    const uri = `file://${path}`;
    this.disposables.push(this.monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri));
    this.disposables.push(this.monaco.languages.typescript.javascriptDefaults.addExtraLib(content, uri));
    this.registeredDts.add(path);
  }
}
```

Key shifts vs today:

- **No per-package `declare module` wrapping**. Real `.d.ts` files declare their own modules; wrapping breaks multi-file packages. The fallback "stub from JS exports" path stays for packages that genuinely have no types.
- **Source of truth = filesystem**. The in-memory `fetchCache` map disappears. Re-injection on session change becomes a `readdir` walk over `/node_modules/`, which is bounded and fast.
- **URIs match the editor**. Both `addExtraLib` and `monaco.editor.createModel` use `file:///node_modules/<pkg>/<file>.d.ts`. This is what makes "Go to Definition" navigate to a real, openable model — closing F2.

### Hot Cache: SAB

After F5/F6 are addressed:

- `FileService.readFile` UTF-8 path TextEncoder-encodes and stores into the pool too (one source of truth for cached bytes; consumers decode at the boundary as needed).
- `FilePool` size for the FM mount stays at 50 MiB but `SharedPool` is constructed with `eviction: 'lru'` so high-churn `.d.ts` traffic doesn't silently fail to admit.
- An admission-failure metric is surfaced via the existing telemetry middleware so we observe pool pressure rather than guessing.

### Network Layer: `/api/npm/*` Proxy

A new minimal proxy endpoint in `apps/api` (or — preferred — at the edge in `apps/ui`'s custom Express server `apps/ui/server.ts`, alongside `coiMiddleware`):

- `GET /api/npm/:pkg/meta` → cached response of `https://registry.npmjs.org/<pkg>` (or `https://esm.sh/<pkg>` headers) to discover `version`, `main`, `module`, `types`.
- `GET /api/npm/:pkg/:version/*` → byte-for-byte mirror of the corresponding tarball file, with strong long-cache headers.

Benefits:

- COEP-compliant by construction (same-origin, can set CORP).
- Deterministic offline: pinning a version pins all bytes.
- Audit trail of which packages projects depend on.
- Removes the only place in the codebase that bypasses the third-party-proxy convention.

The proxy is non-blocking for the SSoT design — F7 calls out that direct esm.sh works today — but it should land in the same milestone for consistency and Safari headroom.

### Watch & Invalidation

- `kernel-worker.ts` `updateWatchSet` adds `/node_modules/**` to the **excludes** list (mirrors the existing `.tau/cache/**` exclusion). Today this is implicit because `extractDependencies` drops `/node_modules/`, but making the exclude explicit guards against future regressions.
- Cross-tab invalidation already exists via `CrossTabCoordinator`; package writes use it natively.
- Version pinning lives in a new `/.tau/lockfile.json` (project-scoped, **not** under `/node_modules/`) recording exact versions for offline-first reproducibility. Excluded from sharing per F9 boundary.

## Recommendations Roadmap

| #   | Recommendation                                                                                                                                                                                                                                                                        | Priority                      | Effort | Impact                               | Phase |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ | ------------------------------------ | ----- |
| R1  | Make Monaco lazily materialize editor models for `/node_modules/**` paths via `FileService` (closes F2 — fixes the smoking-gun "File not found"). Models are read-only, excluded from background sync, and have a separate eviction policy.                                           | **P0**                        | M      | High (UX)                            | 1     |
| R2  | Replace `esm.sh/<pkg>?bundle` with a real package-tree install in `ModuleManager` (`PackageInstaller`). Fetch `package.json`, walk `exports`/`main`/`types`, install all referenced files into `/node_modules/<pkg>/...` preserving the npm tree shape. Co-locate `.d.ts` with `.js`. | **P0**                        | L      | High (correctness, navigability)     | 1     |
| R3  | Stand up `/api/npm/*` proxy in `apps/ui/server.ts` (preferred) or `apps/api`. Replace direct `esm.sh` fetches in both `ModuleManager` and `TypeAcquisitionService`. Same-origin, CORP-compliant, offline-pinnable.                                                                    | **P1**                        | M      | Medium-High (Safari, offline, audit) | 2     |
| R4  | Collapse `TypeAcquisitionService` into a thin file-backed registrar. Remove `fetchCache`, remove per-package `declare module` wrapping for real packages, drive `addExtraLib` URIs from FileService `readdir`. Keep stub-from-JS-exports fallback for typeless packages.              | **P0**                        | M      | High (single source of truth)        | 1     |
| R5  | Close the SAB UTF-8 gap: `FileService.readFile` with UTF-8 encoding stores bytes into the pool too; `runtime-filesystem-bridge.ts` server stores on UTF-8 results; client `resolveCopy` decodes at the boundary. Switch esbuild `onLoad` to binary read + decode.                     | **P1**                        | S      | Medium (perf)                        | 2     |
| R6  | Construct the FM `SharedPool` with `eviction: 'lru'`. Surface admission-failure rate via observability middleware (avoid the silent `BoundedFileCache` antipattern called out in `binary-file-open-perpetual-loading.md`).                                                            | **P1**                        | XS     | Medium (reliability)                 | 2     |
| R7  | Add explicit `/node_modules/**` to `KernelWorker.updateWatchSet` excludes; add `/node_modules/**` to FM tree-explorer filter; ensure `MonacoModelService` background-sync exclusion persists post-R1.                                                                                 | **P2**                        | XS     | Low (defense-in-depth)               | 2     |
| R8  | Add `/.tau/lockfile.json` per project recording exact installed versions. `PackageInstaller.ensurePackage` honors lockfile if present. Excluded from sharing/publish payloads (F9).                                                                                                   | **P2**                        | M      | Medium (offline reproducibility)     | 3     |
| R9  | Honor existing TS extension resolution semantics in the new resolver — reuse `resolveFileExtension`, `parsePackageSpecifier`, `unresolvedPaths` machinery (no re-implementation per F8).                                                                                              | **P0** (constraint, not work) | —      | —                                    | 1     |
| R10 | Defer ATA work until first JS/TS model exists, per `monaco-lsp-lazy-activation-blueprint.md`. The new file-backed registrar must be `onLanguage`-gated, not eager on boot (F10).                                                                                                      | **P1**                        | S      | Medium (startup perf)                | 2     |

### Phasing

- **Phase 1 (foundation)** — R1 + R2 + R4 + R9. Ships the user-visible fix (peek-to-open works, navigable package trees) and the SSoT contract. Network still goes direct to esm.sh.
- **Phase 2 (hardening)** — R3 + R5 + R6 + R7 + R10. Closes COEP/Safari gap, fixes the SAB inertness, adds observability, defense-in-depth excludes, lazy activation.
- **Phase 3 (offline-first reproducibility)** — R8 lockfile and any sharing-flow integration that needs it.

## Trade-offs

| Dimension                     | "Keep three worlds" (today)    | "OPFS as SSoT" (proposed)                                                                              |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Time-to-fix peek/open bug     | n/a — bug stays                | ~1 sprint to ship R1+R2+R4                                                                             |
| Lines of code                 | Less                           | Adds `PackageInstaller`; removes `TypeAcquisitionService.fetchCache` and dual injection (~net neutral) |
| OPFS storage usage            | ~5–20 MB (bundled JS only)     | ~50–200 MB depending on installed packages (real .d.ts trees, especially OCJS)                         |
| Offline-first                 | No (loses ATA cache on reload) | Yes (OPFS persists; lockfile pins)                                                                     |
| Network requests / cold start | 2 per package (JS + d.ts)      | 1 metadata + N parallel asset fetches per package; subsequent loads = 0                                |
| Memory pressure               | Low                            | Higher in-memory once SAB is warm; bounded by LRU                                                      |
| Editor "Go to Definition"     | Broken                         | Native, navigable, cross-file                                                                          |
| Bundler ↔ types coherence     | Best-effort                    | Guaranteed (one tree, one version)                                                                     |
| Sharing/publish complexity    | Trivial (no caches in publish) | Same — F9 boundary preserved by convention + explicit exclude                                          |
| Risk on first project load    | Low (cached state minimal)     | Medium — must populate larger trees; mitigated by R3 same-origin proxy and R6 LRU                      |

The OPFS-storage growth is the largest visible cost and the easiest to manage: per-package install size mirrors what a `pnpm install` would put on disk (often 10–500 KB for a typical npm package, single-digit MB for type-heavy ones like OCJS). With LRU at the SAB layer and TTL-based OPFS pruning at the FileService layer (a future addition tracked separately), this is bounded.

## Open Questions

1. **OCJS special case** — The opencascade.js typings ship as a single 30 MB `index.d.ts` already bundled by `api-extractor` (see `replicad-single-dts-type-errors.md` and `apps/ui/app/lib/type-acquisition-service.ts` static-types path). Does that file land at `/node_modules/opencascade.js/index.d.ts` directly (current approach) or is it split? Recommendation: leave it as a single file — it's already bundled — but make sure R1 lazy materialization handles a 30 MB Monaco model gracefully (eviction priority, lazy tokenization gating).
2. **Tarball vs CDN** — R3 has two viable shapes: (a) proxy esm.sh's existing per-file URLs, (b) untar npm tarballs server-side and serve files individually. Tarballs give us bit-for-bit reproducibility and one round-trip per package; esm.sh proxying is simpler. Defer the choice to R3 design but flag tarballs as the offline-first endgame.
3. **Sourcemaps** — esm.sh-served files reference `.map` files we don't currently install. For a navigable tree, sourcemaps would let the editor jump from minified bundles to source. Not a blocker for the bug fix but a future polish item.
4. **`node_modules` in the file tree UI** — The FM tree currently filters `node_modules` paths from the editor's project tree (`monaco-model-service.ts:419-421`). The intention should be: `/node_modules/` exists physically but is **never** shown in the file-tree UI; only opened when the user navigates a definition. Confirm this matches policy intent in `filesystem-context-policy.md` (SG-style "not part of project surface").
5. **Cache eviction governance** — Who decides when an OPFS package is stale? Lockfile (R8) gives explicit pinning, but ungated `pkg@latest` semantics need a TTL-with-stale-while-revalidate strategy compatible with offline. Defer to R3 design but adopt the pattern from `cache-strategy-analysis.md`.

## References

- `docs/research/filesystem-mount-overlay-architecture.md` — `MountTable`, OPFS `tau-node-modules`, the existing `/node_modules/` mount mechanics this blueprint extends.
- `docs/research/vscode-typescript-features.md` — Monaco TS worker has no real FS; `addExtraLib` semantics; virtual filesystem patterns; the conceptual basis for unifying types and bundler reads.
- `docs/research/monaco-lsp-lazy-activation-blueprint.md` — Avoid eager ATA / `addExtraLib`; `onLanguage` gating that R10 inherits.
- `docs/research/unresolved-dependency-watch-gap.md` — `BundleResult.unresolvedPaths` semantics that R9 must preserve.
- `docs/research/typescript-esm-extension-resolution.md` — `.js` ↔ `.ts` remapping rules; `resolveFileExtension` reuse contract.
- `docs/research/cache-strategy-analysis.md` — Layering taxonomy (L1 SAB, L2 OPFS, L3 CDN); content-addressing vs path-addressing.
- `docs/research/safari-cross-origin-isolation.md` — Why `require-corp` + same-origin proxying is the only Safari-safe pattern (motivates R3).
- `docs/research/staging-cors-coep-safari-rendering-audit.md` — Bundler + `/node_modules` interaction with worker COEP behavior.
- `docs/research/sharing-architecture.md` (SG15) — `/node_modules/` is derived; never include in publish payloads (F9 constraint).
- `docs/research/shared-worker-fs-architecture.md` — Why a dedicated FM worker stays canonical (no SharedWorker for SAB-backed pools).
- `docs/research/chatgpt-deep-research-brief.md` — Hub document linking type acquisition, kernel type maps, COI.
- `docs/research/binary-file-open-perpetual-loading.md` — Cache-admission observability principle adopted by R6.
- `docs/policy/filesystem-policy.md` — Single-writer, bounded caches, kernel vs UI watch planes (constrains R5/R7).
- `docs/policy/library-api-policy.md` — `defineX` factory style for any new public surface (e.g., a future `definePackageInstaller`).

## Appendix: File Index

Key code citations grouped by subsystem.

### Bundler

| What                                                                   | Path                                             | Lines   |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ------- |
| Single esbuild plugin / vfs `onResolve`+`onLoad`                       | `packages/runtime/src/bundler/esbuild-core.ts`   | 401–651 |
| Plugin registration (single plugin)                                    | `packages/runtime/src/bundler/esbuild-core.ts`   | 748–760 |
| `unresolvedPaths` collection (extension probes)                        | `packages/runtime/src/bundler/esbuild-core.ts`   | 479–490 |
| `unresolvedPaths` collection (load failure, excludes `/node_modules/`) | `packages/runtime/src/bundler/esbuild-core.ts`   | 632–637 |
| `extractDependencies` (drops `/node_modules/` from deps)               | `packages/runtime/src/bundler/esbuild-core.ts`   | 861–875 |
| esbuild WASM init singleton                                            | `packages/runtime/src/bundler/esbuild-core.ts`   | 78–127  |
| `ModuleManager.ensureCdnModule`                                        | `packages/runtime/src/bundler/module-manager.ts` | 109–150 |
| esm.sh `?bundle` fetch                                                 | `packages/runtime/src/bundler/module-manager.ts` | 199–205 |
| jsdelivr fallback                                                      | `packages/runtime/src/bundler/module-manager.ts` | 213–219 |
| Atomic write (code first, package.json last)                           | `packages/runtime/src/bundler/module-manager.ts` | 283–318 |
| Path helpers `getNodeModulesPath` / `getCdnCachePath`                  | `libs/utils/src/import.utils.ts`                 | 280–311 |

### Kernel Worker

| What                                                                    | Path                                              | Lines     |
| ----------------------------------------------------------------------- | ------------------------------------------------- | --------- |
| Bundler facade with `BundleResult` cache                                | `packages/runtime/src/framework/kernel-worker.ts` | 2490–2523 |
| `updateWatchSet` (`.tau/cache/` exclusion — model for `/node_modules/`) | `packages/runtime/src/framework/kernel-worker.ts` | 1197–1221 |
| `computeBaseDependencies` (middleware deps unioned)                     | `packages/runtime/src/framework/kernel-worker.ts` | 2305–2411 |

### Filesystem & Pool

| What                                               | Path                                                          | Lines   |
| -------------------------------------------------- | ------------------------------------------------------------- | ------- |
| `FileService.readFile` (UTF-8 bypasses pool — F5)  | `packages/filesystem/src/file-service.ts`                     | 105–124 |
| `FileService.writeFile` + queue + invalidate       | `packages/filesystem/src/file-service.ts`                     | 255–282 |
| `FileService.mount`                                | `packages/filesystem/src/file-service.ts`                     | 780–811 |
| `MountTable` longest-prefix resolution             | `packages/filesystem/src/mount-table.ts`                      | 123–146 |
| OPFS `/node_modules` mount in FM worker            | `apps/ui/app/machines/file-manager.worker.ts`                 | 106–119 |
| FM `SharedPool` allocation (50 MiB)                | `apps/ui/app/machines/file-manager.machine.ts`                | 24–167  |
| Bridge client `resolveCopy` before RPC             | `packages/runtime/src/framework/runtime-filesystem-bridge.ts` | 396–408 |
| Bridge server `filePool.store` (binary only — F5)  | `packages/runtime/src/framework/runtime-filesystem-bridge.ts` | 173–179 |
| `SharedPool` defaults (4096 entries, 10 MiB/entry) | `packages/memory/src/shared-pool.ts`                          | 21–22   |

### Monaco / IntelliSense

| What                                                                                     | Path                                                 | Lines   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------- |
| Editor mount + Cmd+Click resolution surface                                              | `apps/ui/app/components/code/code-editor.client.tsx` | 110–290 |
| `MonacoModelService.applyWritten` (`!path.includes('node_modules')` bypass — F4)         | `apps/ui/app/lib/monaco-model-service.ts`            | 377–384 |
| `MonacoModelService.syncAllInBackground` (same bypass)                                   | `apps/ui/app/lib/monaco-model-service.ts`            | 419–421 |
| `TypeAcquisitionService.injectDynamicTypes` (`addExtraLib` URIs that have no model — F2) | `apps/ui/app/lib/type-acquisition-service.ts`        | 552–588 |
| `TypeAcquisitionService.fetchAndInjectTypes` (esm.sh path — F1, F7)                      | `apps/ui/app/lib/type-acquisition-service.ts`        | 414–473 |

### Constraints (policy/sharing)

| What                                                 | Path                                                    |
| ---------------------------------------------------- | ------------------------------------------------------- |
| Sharing/publish — `/node_modules/` is derived (SG15) | `docs/research/sharing-architecture.md`                 |
| Filesystem policy (single writer, watch planes)      | `docs/policy/filesystem-policy.md`                      |
| Lazy activation pattern                              | `docs/research/monaco-lsp-lazy-activation-blueprint.md` |
