---
title: 'Unresolved Dependency Watch Gap'
description: 'Root cause investigation of missing auto-re-render when assembly files are created before their part dependencies'
status: draft
created: '2026-04-02'
updated: '2026-04-02'
category: investigation
related:
  - docs/policy/testing-policy.md
---

# Unresolved Dependency Watch Gap

Investigation into why the runtime fails to auto-re-render when an AI agent creates an assembly file (with imports) before creating the imported part files.

## Executive Summary

When an assembly file is created before its dependencies, every kernel's `getDependencies` silently discards missing import paths. The kernel worker's watch set only contains successfully resolved files, so creating the missing files later produces no watch event and no re-render. The fix requires changing the `getDependencies` return type from `string[]` to `{ resolved: string[]; unresolved: string[] }` across all seven kernels, plus tracking unresolved paths in the esbuild bundler's `BundleResult`.

## Problem Statement

When the AI agent builds a multi-file CAD project, it sometimes creates the assembly file (`main.ts`) first, which imports from part files (`./lib/foundation`, `./lib/posts`, etc.) that do not exist yet. The runtime attempts to render, fails with ENOENT errors, and enters an error state. When the agent subsequently creates the part files, the runtime does not detect the new files and does not re-render. The user must take manual follow-up action to force a re-render.

Symptoms observed:

- 7 ENOENT errors displayed in the editor issues panel
- 3D viewport shows no geometry
- After part files are created, viewport remains empty until the model takes explicit follow-up action

## Methodology

Source analysis of the dependency resolution and watch subscription pipeline across:

- `packages/runtime/src/framework/kernel-worker.ts` (watch set management)
- `packages/runtime/src/framework/kernel-runtime-worker.ts` (kernel delegation)
- `packages/runtime/src/bundler/esbuild-core.ts` (esbuild plugin resolution)
- `packages/runtime/src/kernels/*/` (all seven kernel implementations)
- `packages/runtime/src/types/runtime-bundler.types.ts` (bundler types)
- `packages/runtime/src/types/runtime-kernel.types.ts` (kernel types)
- `packages/filesystem/src/watch-registry.ts` (watch event matching)

## Findings

### Finding 1: Three independent resolution mechanisms all silently discard missing paths

Every kernel's `getDependencies` returns `string[]` — a type that can only express successfully resolved paths.

| Resolution mechanism      | Kernels                                | Missing file behavior                                                  | Code location                    |
| ------------------------- | -------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| esbuild bundler           | Replicad, Manifold, JSCAD, OpenCascade | `onLoad` catch returns error; path not added to `accessedProjectFiles` | `esbuild-core.ts:590-597`        |
| `getReferencedScadFiles`  | OpenSCAD                               | `readFile` catch returns early; path not added to `result`             | `openscad.kernel.ts:145-148`     |
| `discoverKclDependencies` | Zoo (KCL)                              | `readFile` catch returns early; path not added to `result`             | `kcl-import-resolver.ts:156-163` |
| Entry-only                | Tau                                    | Returns `[filePath]`; no transitive resolution                         | `tau.kernel.ts:103-105`          |

### Finding 2: Watch set is derived exclusively from successfully resolved paths

`_updateWatchSetFromCaches` builds the watch set from four sources, all of which only contain resolved paths:

| Source                           | Content                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `activeFileAbsolutePath`         | Entry file (always exists)                                    |
| `bundleResultCache.dependencies` | Only files that `onLoad` successfully read                    |
| `fileHashCache.keys()`           | Only files that `computeBaseDependencies` successfully hashed |
| `middlewareWatchPaths`           | Only paths registered by middleware                           |

Missing import paths never enter any of these sources.

### Finding 3: Watch event matching supports non-existent path watching

`WatchRegistry.isPathMatched` (in `packages/filesystem/src/watch-registry.ts`) matches events against watch paths using path comparison — not inode-level watching. A `fileWritten` event for a newly created file will match if the watch path equals the event path or the event's parent directory. The runtime does not need the watched file to exist at registration time.

### Finding 4: Esbuild extension resolution creates a path mismatch

For esbuild-based kernels, imports like `./lib/foundation` (no extension) are resolved by `resolveFileExtension`, which probes `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`. When none exist, it returns the extensionless path. The user later creates `lib/foundation.ts` — a different path than what was attempted. Tracking must include the extension variants, not just the extensionless base.

### Finding 5: `cachedDetectionDeps` bypasses kernel `getDependencies` on first render

`KernelRuntimeWorker.onGetDependencies` returns `cachedDetectionDeps` (from `detectImports` during kernel selection) on the first call, bypassing the kernel's `getDependencies`. When `detectImports` fails (build throws for missing imports), `cachedDetectionDeps = []`. The kernel's `getDependencies` is never called for that render cycle.

However, `createGeometry` calls `bundle()` directly (through the kernel), which populates `bundleResultCache`. The `_updateWatchSetFromCaches` in the `finally` block can read unresolved paths from `bundleResultCache` even when `getDependencies` reported none. This makes `bundleResultCache` a critical secondary source for esbuild-based kernels.

### Finding 6: OpenSCAD and KCL have exact-path imports (no extension mismatch)

OpenSCAD uses `include <lib/bolt.scad>` and KCL uses `import "lib/bracket.kcl"` — both include the file extension. The import path is exactly the path that will be created. No extension variant tracking is needed for these kernels.

### Finding 7: No existing tests cover the ENOENT-then-create scenario

| Existing test                                                                         | What it covers                   | Gap                                          |
| ------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| `should include dependency paths in watch set even when build fails` (replicad)       | Syntax error in existing file    | File EXISTS but has bad code — not ENOENT    |
| `should use sentinel hash when middleware dependency file is missing` (kernel-worker) | Middleware optional file missing | Middleware path, not kernel import path      |
| `should recover when one of multiple dependencies has a syntax error` (replicad)      | Fix syntax error → re-render     | File exists throughout — not file creation   |
| `should parse file not found warning for include` (openscad)                          | Missing include warning          | Tests `createGeometry` output, not watch set |

## Recommendations

| #   | Action                                                           | Priority | Effort | Impact                                                               |
| --- | ---------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------- |
| R1  | Add `GetDependenciesResult` type with `{ resolved, unresolved }` | P0       | Low    | High — enables uniform tracking across all kernels                   |
| R2  | Add `unresolvedPaths: string[]` to `BundleResult`                | P0       | Low    | High — esbuild bundler tracks failed import paths                    |
| R3  | Change `KernelDefinition.getDependencies` return type            | P0       | Low    | High — all kernels report unresolved paths                           |
| R4  | Change `KernelBundler.resolveDependencies` return type           | P0       | Low    | High — bundler facade maps `BundleResult` to `GetDependenciesResult` |
| R5  | Track extension variants in esbuild `onResolve`                  | P0       | Low    | High — handles extensionless imports                                 |
| R6  | Track failed paths in esbuild `onLoad` catch                     | P0       | Low    | Medium — handles explicit-extension imports                          |
| R7  | Update `getReferencedScadFiles` to report unresolved paths       | P0       | Low    | Medium — fixes OpenSCAD kernel                                       |
| R8  | Update `discoverKclDependencies` to report unresolved paths      | P0       | Low    | Medium — fixes KCL kernel                                            |
| R9  | Add `unresolvedDependencyPaths` to kernel worker                 | P0       | Low    | High — stores paths from `getDependencies`                           |
| R10 | Update `_updateWatchSetFromCaches` to include both sources       | P0       | Low    | High — merges kernel + bundler unresolved paths                      |

## Diagrams

### Current failure flow

```
main.ts imports ./lib/foundation
    ↓
onResolve: resolveFileExtension → no match → returns extensionless path
    ↓
onLoad: readFile fails (ENOENT) → path NOT in accessedProjectFiles
    ↓
bundle() returns { dependencies: [main.ts only], success: false }
    ↓
_updateWatchSetFromCaches: watch set = { main.ts }
    ↓
Agent creates lib/foundation.ts
    ↓
WatchRegistry: no match → NO re-render
```

### Fixed flow

```
main.ts imports ./lib/foundation
    ↓
onResolve: resolveFileExtension → no match → adds .ts/.tsx/.js/.jsx variants to unresolvedPaths
    ↓
onLoad: readFile fails (ENOENT) → adds extensionless path to unresolvedPaths
    ↓
bundle() returns { dependencies: [main.ts], unresolvedPaths: [lib/foundation.ts, ...], success: false }
    ↓
getDependencies returns { resolved: [main.ts], unresolved: [lib/foundation.ts, ...] }
    ↓
_updateWatchSetFromCaches: watch set = { main.ts, lib/foundation.ts, lib/foundation.tsx, ... }
    ↓
Agent creates lib/foundation.ts
    ↓
WatchRegistry: MATCH → scheduleRender → re-render succeeds
```
