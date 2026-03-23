---
title: 'Nx Build System for opencascade.js'
description: 'Research on replacing the custom build-cache.py / build-wasm.sh pipeline with Nx-managed tasks for reliable caching, invalidation, and parallelism'
status: draft
created: '2026-03-22'
updated: '2026-03-22'
category: architecture
related:
  - docs/research/occt-wasm-optimization.md
  - docs/research/occt-wasm-build-comparison.md
  - docs/research/rbv-build-manifest-regressions.md
---

# Nx Build System for opencascade.js

Evaluate replacing the custom `build-wasm.sh` / `build-cache.py` build orchestration with Nx-managed task pipelines to eliminate the class of caching, invalidation, and partial-state bugs that have consumed significant debugging time.

## Executive Summary

Over the course of a single extended development session (3130+ messages), **28 distinct caching and build system failures** were encountered — corrupted PCH files, stale symlinks, environment variable leaks, parallel build collisions, mismatched artifact timestamps, and tarball version confusion. These stem from a custom cache system (`build-cache.py`) that lacks atomic writes, content-based invalidation, environment isolation, and failure recovery. Nx provides all of these out of the box: content-hash-based task caching, declared inputs/outputs, atomic cache commits with rollback on failure, and Nx Cloud for cross-machine reuse. This document proposes splitting the monolithic `build-wasm.sh full` into discrete Nx projects and targets that maximize cache hits and prevent cache poisoning.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Current Build Pipeline](#current-build-pipeline)
- [Caching Failures Inventory](#caching-failures-inventory)
- [Root Cause Analysis](#root-cause-analysis)
- [Prior Art: libclangjs + Turborepo](#prior-art-libclangjs--turborepo)
- [Proposed Nx Architecture](#proposed-nx-architecture)
- [Nx Project Decomposition](#nx-project-decomposition)
- [Cache Key Strategy](#cache-key-strategy)
- [Build Variants](#build-variants)
- [Nx Cloud Integration](#nx-cloud-integration)
- [Migration Path](#migration-path)
- [Trade-offs](#trade-offs)
- [Recommendations](#recommendations)

## Problem Statement

The opencascade.js build pipeline compiles 4400+ OCCT C++ binding files, 49 static libraries, and links them into WASM modules. A full build takes **15–30 minutes**. The custom caching layer (`build-cache.py`) was designed to avoid redundant rebuilds, but it has critical gaps:

1. **No atomic writes** — interrupted builds leave corrupted caches that poison subsequent runs
2. **Symlink-based sharing** — `build/` dirs are symlinked into `cache/<key>/`; symlink targets can diverge from cache key identity
3. **Environment leaks** — `OCJS_EXCEPTIONS`, `THREADING`, and other flags persist in shell sessions, contaminating builds meant for different variants
4. **Single mutable `build/` directory** — parallel builds collide, corrupting PCH, `.o` files, and `.d.ts.json` fragments
5. **No failure rollback** — a failed compile step writes partial artifacts into the cache; the `.complete` marker is only written on full success, but intermediate files persist
6. **Manual provenance tracking** — `provenance.json` and `build-manifest.json` are separate systems with no cross-validation

These issues caused **hours** of debugging time per incident, with cascading failures that are difficult to diagnose.

## Methodology

1. **Transcript mining**: Searched the full 3130-message development session transcript for all cache-related keywords (`cache`, `stale`, `PCH`, `symlink`, `build-flags`, `crash`, `mismatch`, `corrupted`, `provenance`, etc.)
2. **Build system analysis**: Traced `build-wasm.sh`, `build-cache.py`, `buildFromYaml.py`, `compileBindings.py`, `Common.py`, and `bindings.py` to map all steps, inputs, outputs, and cache key computation
3. **Prior art review**: Cloned and analyzed `donalffons/libclangjs` which uses Turborepo for a similar LLVM/Clang → WASM pipeline
4. **Nx capability assessment**: Reviewed Nx task hashing, `run-commands` executor, `namedInputs`, `env`/`runtime` inputs, atomic cache writes, and Nx Cloud; verified Tau workspace already has `nxCloudId` configured

## Current Build Pipeline

### Step Dependency Graph

```
full:
  provenance init
  └─ build-cache setup <key>
     └─ [miss] patch_dump? → pch → generate → bindings → sources_cmake → finalize cache
        └─ link (buildFromYaml) → validate-build → provenance finalize
```

### Steps, Inputs, and Outputs

| Step                 | Inputs                                                                             | Outputs                                                                        | Duration | Current Caching                     |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- | ----------------------------------- |
| **PCH**              | OCCT headers, env flags (OPT, LTO, EXC, SIMD, THREADING), emsdk                    | `build/occt-includes/` (symlinks), `build/pch.h.pch`, `build/build-flags.json` | ~30s     | Part of composite cache key         |
| **Docs**             | OCCT headers, Doxygen binary                                                       | `build/occt-docs.json`                                                         | ~10s     | Hash-based skip                     |
| **Generate**         | OCCT headers, `bindings.py` + all `src/**/*.py`, `bindgen-filters.yaml`, docs JSON | `build/bindings/**/*.{cpp,d.ts.json}`, `.generator-hash`                       | 5–15 min | Generator hash check, per-file skip |
| **Bindings compile** | Generated `.cpp`, PCH, flat includes, env flags                                    | `build/bindings/**/*.cpp.o`, `binding-report.json`                             | 5–10 min | Per-file timestamp check            |
| **OCCT CMake**       | OCCT source tree, RapidJSON, Freetype, env flags                                   | `build/occt-cmake/lin32/clang/lib/*.a`                                         | 3–8 min  | CMake incremental                   |
| **Link**             | YAML config, `.o` files, `.a` files, `emccFlags`, env (BIGINT, EVAL_CTORS)         | `<name>.js`, `<name>.wasm`                                                     | 30–60s   | None (always runs)                  |
| **wasm-opt**         | `.wasm` file, opt flags                                                            | `.wasm` (in-place)                                                             | 30–90s   | None                                |
| **d.ts merge**       | `*.d.ts.json` fragments, builtins                                                  | `<name>.d.ts`                                                                  | ~5s      | None                                |
| **Pack**             | All outputs                                                                        | `.tgz` tarball                                                                 | ~5s      | None                                |

### Cache Key Computation (`build-cache.py`)

The current composite key is a string concatenation:

```
{OPT}-{LTO}-{EXC}-{THREADING}-{filterHash}-{OCCTcommit}-{bindgenCodeHash}-{emscriptenVer}-{depsHash}[-patched][-simd][-defines]
```

**Critical gaps in the key**:

- OCCT header content is proxied by git commit (6 chars), not a content hash
- `build-flags.json` is validated separately, not part of the key check
- YAML config content is not included (only affects link step, by design — but link has no caching)
- `OCJS_BIGINT`, `OCJS_EVAL_CTORS`, `OCJS_CLOSURE` are deliberately excluded (link-only) but also have no separate cache layer

## Caching Failures Inventory

28 distinct incidents extracted from the development session, categorized by root cause class.

### Class 1: Corrupted/Partial State (7 incidents)

| #   | Symptom                                              | Root Cause                                           | Step            | Fix Applied                    |
| --- | ---------------------------------------------------- | ---------------------------------------------------- | --------------- | ------------------------------ |
| 1   | PCH references missing `AppStd_Application.hxx`      | `occt-includes/` symlinks empty after crash          | PCH             | Delete PCH + rebuild           |
| 2   | PCH still bad after partial clean                    | Parallel build collision left stale PCH              | PCH             | Full `build/` clean            |
| 3   | PCH pointed at nonexistent `occt-cmake/include/`     | Partial rebuild; PCH reused with incomplete tree     | PCH             | Full clean + correct sequence  |
| 4   | Empty `occt-includes/` in cache                      | Parallel build collision corrupted cache entry       | Cache populate  | Delete build + cache dirs      |
| 5   | 343 corrupt `.d.ts.json` files                       | 8 parallel workers racing on same outputs            | Binding compile | Regenerate; reduce parallelism |
| 6   | Build log stops at "Building OCCT..."                | Process killed (crash/IDE cleanup); nohup child lost | CMake           | Re-run build                   |
| 7   | `additionalBindCode` compile fail with corrupted PCH | Multiple sequential issues compounding               | Link            | Full clean rebuild             |

### Class 2: Environment Variable Contamination (5 incidents)

| #   | Symptom                                          | Root Cause                                            | Step             |
| --- | ------------------------------------------------ | ----------------------------------------------------- | ---------------- |
| 8   | "Single" build compiled with `-fwasm-exceptions` | `OCJS_EXCEPTIONS` from prior session                  | PCH + compile    |
| 9   | `THREADING=single` (invalid) → 12/218 bindings   | Wrong env value from emsdk shell                      | Compile bindings |
| 10  | "Single" WASM 28MB with 517 `invoke_` wrappers   | `WASM_EXCEPTION_FLAGS` set at Python import time      | Compile + link   |
| 11  | PCH leaked `-fwasm-exceptions` to single variant | Stale env not cleared between variant builds          | PCH              |
| 12  | `emccFlags` missing BIGINT/SIMD/EVAL_CTORS       | YAML hardcoded flags; env vars not propagated to link | Link             |

### Class 3: Cache Key / Invalidation Gaps (5 incidents)

| #   | Symptom                                                         | Root Cause                                              | Step          |
| --- | --------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| 13  | Same cache key, wrong PCH (symlinks repointed)                  | Key doesn't capture symlink target identity             | PCH           |
| 14  | `occt-cmake` not cache-keyed → exception lib contamination      | Shared mutable dir not partitioned by variant           | CMake         |
| 15  | Stale `build-manifest.json` after successful rebuild            | Manifest not regenerated; stale from prior failed build | Validation    |
| 16  | Generator change → full rebuild (15 min) expected but confusing | Cache miss is correct but no granular caching           | Generate      |
| 17  | Jump to `additionalBindCode` with cached bindings (ambiguous)   | Unclear which steps are cached vs fresh                 | Full pipeline |

### Class 4: Artifact Mismatch / Stale Deployment (6 incidents)

| #   | Symptom                                                             | Root Cause                                      | Step              |
| --- | ------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| 18  | `.wasm` Mar 19, `.d.ts` Mar 18, missing symbol                      | Build died before d.ts regen; mixed outputs     | Link / d.ts       |
| 19  | `build-config/` 32MB vs `src/` 24MB                                 | Built artifacts not copied to runtime path      | Post-link         |
| 20  | Provenance `buildId` said `single` but YAML pointed at `exceptions` | Mixed artifacts from different runs             | Provenance        |
| 21  | Stale `replicad_single.d.ts` with wrong symbols                     | Exceptions variant built but single not rebuilt | d.ts gen          |
| 22  | `tsc` emitted stale `.js` files colliding with Vite                 | Wrong tsconfig; output landed next to source    | Unrelated compile |
| 23  | Builds swapped: error-handling vs geometry tests inverted           | Contaminated WASM/JS pairing                    | Full pipeline     |

### Class 5: Package/Tarball Resolution (5 incidents)

| #   | Symptom                                                      | Root Cause                                          | Step                    |
| --- | ------------------------------------------------------------ | --------------------------------------------------- | ----------------------- |
| 24  | Patched dependency no longer applied                         | New tarball hash; pnpm keys patches to tarball hash | Pack + install          |
| 25  | `packages/runtime` on old replicad tarball                   | Per-package resolution; stale lockfile              | Install                 |
| 26  | Repacked tarball but version unchanged → pnpm didn't refresh | Same version string; pnpm didn't refetch `file:`    | Pack + install          |
| 27  | Stale `v8.29` reference in lockfile after `v8.30` tarball    | Lockfile not updated everywhere                     | Install                 |
| 28  | `wasm-experiment.sh` didn't update `pnpm-workspace.yaml`     | Regex mismatch for `replicad-opencascadejs:`        | Experiment orchestrator |

## Root Cause Analysis

The 28 incidents reduce to **6 systemic root causes**:

### RC-1: No Atomic Cache Writes

`build-cache.py` writes artifacts incrementally into `cache/<key>/` during the build. If the process dies, artifacts are partially written but the `.complete` marker is absent. However, the _contents_ of the cache directory (`.o` files, symlinks) are already mutated. Subsequent runs may find a non-empty cache dir without `.complete` and try to "resume" from an inconsistent state.

**Nx solution**: Nx writes task outputs to a temp directory, then atomically commits with a marker file (`<hash>.commit`). Failed tasks produce no cache entry.

### RC-2: Shared Mutable Build Directory

All steps write to a single `build/` directory. Symlinks point `build/{bindings,sources,occt-includes,occt-cmake}` into `cache/<key>/`. Running two builds concurrently (e.g., exceptions + single) corrupts both because they share the same physical paths.

**Nx solution**: Each Nx task operates on its own project's output directory. Variants are separate targets with separate output paths. Nx's task graph prevents conflicting parallel execution of targets that share resources.

### RC-3: Environment Variable Leaks

`Common.py` reads `OCJS_EXCEPTIONS`, `THREADING`, `OCJS_SIMD`, etc. at **module import time** and stores them in module-level constants (`WASM_EXCEPTION_FLAGS`, `SIMD_FLAGS`). These persist across multiple Python invocations in the same shell. Switching from an exceptions build to a single build without restarting the shell contaminates the flags.

**Nx solution**: Nx's `run-commands` executor accepts explicit `env` options. Combined with `{ "env": "OCJS_EXCEPTIONS" }` in `inputs`, each task gets a hermetic environment and a distinct cache key per flag combination.

### RC-4: Incomplete Cache Key Inputs

The current cache key misses several inputs: symlink target identity (only hashes the key string, not the resolved paths), `occt-cmake` directory contents (not partitioned by variant), and YAML config content for link-only steps. Generator changes correctly invalidate, but at the wrong granularity — a change to `bindings.py` invalides _everything_, even OCCT source compilation that doesn't depend on it.

**Nx solution**: Nx hashes all declared `inputs` (files, globs, env vars, runtime commands). Each target declares only _its_ inputs. Changing `bindings.py` invalidates only the `generate` and `compile-bindings` targets, not `compile-occt-sources`.

### RC-5: No Granular Task Decomposition

`build-wasm.sh full` runs PCH → generate → compile-bindings → compile-sources → link as one monolithic cached unit. If the generator changes but sources don't, the entire 15-30 minute pipeline reruns. There's no way to cache individual steps independently.

**Nx solution**: Each step becomes a separate Nx target with its own cache entry. Change `bindings.py` → only `generate` and `compile-bindings` rerun; `compile-occt-sources` hits cache. This could save 3-8 minutes per iteration on binding changes.

### RC-6: No Failure Isolation

When a step fails (e.g., `BRep_Tool` compile error), there's no rollback. The next `full` run finds partially-compiled artifacts and must decide whether to trust them. The build script attempts this via timestamp-based incremental compilation, but timestamps are unreliable when files are symlinked from cache.

**Nx solution**: Failed tasks don't produce cache entries. Re-running after a fix starts from the last _successful_ task's cached output. No partial states leak.

## Prior Art: libclangjs + Turborepo

[`donalffons/libclangjs`](https://github.com/donalffons/libclangjs) compiles LLVM/Clang to WASM using Emscripten — a similar class of problem. Its Turborepo setup provides useful patterns.

### Architecture

```
packages/
  llvm-project-emscripten/   → git clone + emcmake cmake + cmake --build → dist/
  libclangjs/                → CMake against dist/ → node.js, web.js, libclang.wasm
  libclangjs-cmake/          → Static lib + vendored LLVM for CMake consumers
```

### Patterns to Adopt

| Pattern                                  | How it works                                                                          | Applicable to OCCT                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Upstream compile as separate package** | `llvm-project-emscripten` is its own workspace package with `build` producing `dist/` | OCCT source compilation → separate project                     |
| **`globalEnv` for toolchain version**    | `EMSCRIPTEN_VERSION` in Turbo's `globalEnv` invalidates all caches on emsdk change    | Add `EMSCRIPTEN_VERSION` as env input to all targets           |
| **`^build` dependency ordering**         | Turborepo's topological build ensures LLVM built before libclang                      | Nx `dependsOn: ["^build"]` for the same pattern                |
| **TypeScript build driver**              | `ts-node build.ts` wraps CMake calls with programmatic control                        | Consider Nx executors or `run-commands` with scripts           |
| **Remote cache via GCS**                 | Manual `gsutil rsync` of Turbo cache directory                                        | Nx Cloud (already configured in Tau) is the managed equivalent |

### Limitations Observed

1. **No explicit `inputs`** — relies on Turbo default hashing; misses unusual dependencies
2. **Huge `build/**` in outputs\*\* — caching entire LLVM build tree is heavy
3. **Incremental `build/` directory** — "skip clone if exists" can fight cache restore semantics

## Proposed Nx Architecture

### Design Principles

1. **One Nx project per independently-cacheable unit** — maximize cache hits by isolating steps with different input sets
2. **Explicit inputs for everything** — no implicit hashing; every file, env var, and runtime dependency declared
3. **Immutable outputs** — each target writes to a unique output path; no in-place mutation
4. **Variant isolation** — exceptions/single/SIMD variants are separate targets or configurations
5. **Failure = no cache entry** — rely on Nx's atomic commit model

### Project Graph

```
┌─────────────────────────────────────────────────────────────────────┐
│                      opencascade.js Nx Projects                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ocjs-pch          ──→  ocjs-generate  ──→  ocjs-compile-bindings  │
│  (PCH + includes)       (C++ binding        (emcc -c *.cpp)        │
│                          generation)                                │
│                              │                     │                │
│  ocjs-docs         ─────────┘                      │                │
│  (Doxygen JSON)                                    │                │
│                                                    │                │
│  ocjs-compile-sources                              │                │
│  (CMake OCCT static libs)                          │                │
│          │                                         │                │
│          └──────────────────┬──────────────────────┘                │
│                             ▼                                       │
│                    ocjs-link-{variant}                               │
│                    (emcc link → .js + .wasm)                        │
│                             │                                       │
│                             ▼                                       │
│                    ocjs-optimize-{variant}                           │
│                    (wasm-opt post-process)                           │
│                             │                                       │
│                             ▼                                       │
│                    ocjs-dts-{variant}                                │
│                    (merge .d.ts.json → .d.ts)                       │
│                             │                                       │
│                             ▼                                       │
│                    ocjs-pack-{variant}                               │
│                    (npm pack → .tgz)                                │
│                             │                                       │
│                             ▼                                       │
│                    replicad-opencascadejs                            │
│                    (install tarball into workspace)                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Nx Project Decomposition

### Project: `ocjs-pch`

Precompiled header and flat include symlinks.

```json
{
  "name": "ocjs-pch",
  "root": "repos/opencascade.js",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "inputs": [
        "{workspaceRoot}/repos/OCCT/src/**/*.hxx",
        "{workspaceRoot}/repos/OCCT/src/**/*.h",
        { "env": "OCJS_OPT" },
        { "env": "OCJS_LTO" },
        { "env": "OCJS_EXCEPTIONS" },
        { "env": "OCJS_SIMD" },
        { "env": "THREADING" },
        { "env": "OCJS_DEFINES" },
        { "env": "OCJS_UNDEFINES" },
        { "runtime": "emcc --version" }
      ],
      "outputs": [
        "{workspaceRoot}/repos/opencascade.js/build/pch.h.pch",
        "{workspaceRoot}/repos/opencascade.js/build/pch.h",
        "{workspaceRoot}/repos/opencascade.js/build/occt-includes",
        "{workspaceRoot}/repos/opencascade.js/build/build-flags.json"
      ],
      "options": {
        "command": "./build-wasm.sh pch",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

**Key insight**: The OCCT headers glob (`repos/OCCT/src/**/*.hxx`) is the dominant input. Any header change invalidates the PCH. The env vars ensure different flag combinations get different cache entries.

**Caveat**: `repos/OCCT/` is gitignored. Nx does not hash gitignored files by default. Options:

1. Add a manifest file (e.g., OCCT git commit hash) to a tracked path and include it in `inputs`
2. Use `{ "runtime": "git -C repos/OCCT rev-parse HEAD" }` to capture OCCT version
3. Un-ignore specific paths (not recommended for large trees)

**Recommended**: Use `runtime` input for OCCT commit hash, plus explicit file inputs for any patched files.

### Project: `ocjs-docs`

Doxygen documentation extraction.

```json
{
  "name": "ocjs-docs",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "inputs": [
        { "runtime": "git -C repos/OCCT rev-parse HEAD" },
        "{workspaceRoot}/repos/opencascade.js/src/extract-docs.py"
      ],
      "outputs": ["{workspaceRoot}/repos/opencascade.js/build/occt-docs.json"],
      "options": {
        "command": "./build-wasm.sh docs",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

### Project: `ocjs-generate`

C++ binding code generation from OCCT headers via libclang.

```json
{
  "name": "ocjs-generate",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "dependsOn": [
        { "projects": ["ocjs-pch"], "target": "build" },
        { "projects": ["ocjs-docs"], "target": "build" }
      ],
      "inputs": [
        "{workspaceRoot}/repos/opencascade.js/src/**/*.py",
        "{workspaceRoot}/repos/opencascade.js/bindgen-filters.yaml",
        { "runtime": "git -C repos/OCCT rev-parse HEAD" },
        { "dependentTasksOutputFiles": "ocjs-docs:build", "transitive": false }
      ],
      "outputs": [
        "{workspaceRoot}/repos/opencascade.js/build/bindings/**/*.cpp",
        "{workspaceRoot}/repos/opencascade.js/build/bindings/**/*.d.ts.json",
        "{workspaceRoot}/repos/opencascade.js/build/bindings/.generator-hash"
      ],
      "options": {
        "command": "./build-wasm.sh generate",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

**Key insight**: The `src/**/*.py` glob captures `bindings.py` changes. Previously, any Python change invalidated the entire build; now it only invalidates generation + downstream binding compilation — saving the 3-8 minute OCCT CMake step.

### Project: `ocjs-compile-bindings`

Parallel emcc compilation of generated binding `.cpp` files.

```json
{
  "name": "ocjs-compile-bindings",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "dependsOn": [
        { "projects": ["ocjs-pch"], "target": "build" },
        { "projects": ["ocjs-generate"], "target": "build" }
      ],
      "inputs": [
        { "dependentTasksOutputFiles": "ocjs-generate:build", "transitive": false },
        { "dependentTasksOutputFiles": "ocjs-pch:build", "transitive": false },
        { "env": "OCJS_OPT" },
        { "env": "OCJS_EXCEPTIONS" },
        { "runtime": "emcc --version" }
      ],
      "outputs": [
        "{workspaceRoot}/repos/opencascade.js/build/bindings/**/*.cpp.o",
        "{workspaceRoot}/repos/opencascade.js/build/binding-report.json"
      ],
      "options": {
        "command": "./build-wasm.sh bindings",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

### Project: `ocjs-compile-sources`

CMake-based OCCT static library compilation. **Independent of binding generation** — this is the key parallelism win.

```json
{
  "name": "ocjs-compile-sources",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "cache": true,
      "dependsOn": [{ "projects": ["ocjs-pch"], "target": "build" }],
      "inputs": [
        { "runtime": "git -C repos/OCCT rev-parse HEAD" },
        { "env": "OCJS_OPT" },
        { "env": "OCJS_LTO" },
        { "env": "OCJS_EXCEPTIONS" },
        { "env": "OCJS_SIMD" },
        { "env": "OCJS_DEFINES" },
        { "env": "OCJS_UNDEFINES" },
        { "runtime": "emcc --version" }
      ],
      "outputs": [
        "{workspaceRoot}/repos/opencascade.js/build/occt-cmake/lin32/clang/lib/*.a",
        "{workspaceRoot}/repos/opencascade.js/build/.cmake-lib-dir"
      ],
      "options": {
        "command": "./build-wasm.sh sources",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

**Key insight**: OCCT source compilation depends only on the PCH and OCCT source tree — NOT on `bindings.py` or the generated bindings. In the current monolithic cache, changing `bindings.py` invalidates this step unnecessarily. With Nx, `ocjs-compile-sources` stays cached when only Python generators change, saving 3-8 minutes.

### Project: `ocjs-link-{variant}`

Per-variant WASM linking. One target per YAML config.

```json
{
  "name": "ocjs-link",
  "targets": {
    "link-exceptions": {
      "executor": "nx:run-commands",
      "cache": true,
      "dependsOn": [
        { "projects": ["ocjs-compile-bindings"], "target": "build" },
        { "projects": ["ocjs-compile-sources"], "target": "build" }
      ],
      "inputs": [
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_with_exceptions_v8.yml",
        { "dependentTasksOutputFiles": "ocjs-compile-bindings:build", "transitive": false },
        { "dependentTasksOutputFiles": "ocjs-compile-sources:build", "transitive": false },
        { "env": "OCJS_BIGINT" },
        { "env": "OCJS_EVAL_CTORS" },
        { "env": "OCJS_CLOSURE" },
        { "env": "OCJS_CONVERGE" },
        { "env": "OCJS_WASM_OPT_LEVEL" }
      ],
      "outputs": [
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/replicad_with_exceptions.js",
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/replicad_with_exceptions.wasm"
      ],
      "options": {
        "command": "./build-wasm.sh link ../../repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_with_exceptions_v8.yml",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    },
    "link-single": {
      "executor": "nx:run-commands",
      "cache": true,
      "dependsOn": [
        { "projects": ["ocjs-compile-bindings"], "target": "build" },
        { "projects": ["ocjs-compile-sources"], "target": "build" }
      ],
      "inputs": [
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single_v8.yml",
        "..."
      ],
      "outputs": [
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/replicad_single.js",
        "{workspaceRoot}/repos/replicad/packages/replicad-opencascadejs/build-config/replicad_single.wasm"
      ],
      "options": {
        "command": "./build-wasm.sh link ../../repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single_v8.yml",
        "cwd": "{workspaceRoot}/repos/opencascade.js"
      }
    }
  }
}
```

**Key insight**: The YAML config file is now an explicit input. The emccFlags inside the YAML (WASM_BIGINT, EVAL_CTORS, SIMD) are captured because the YAML file content is hashed. This eliminates the flag propagation bugs from incident #12.

## Cache Key Strategy

### Current vs Proposed Input Hashing

| Input Category                 | Current (`build-cache.py`)    | Proposed (Nx)                            |
| ------------------------------ | ----------------------------- | ---------------------------------------- |
| OCCT source version            | Git commit (6 chars)          | `runtime: git rev-parse HEAD` (full SHA) |
| OCCT header content            | Not hashed (proxy via commit) | File glob hash via `runtime`             |
| Python generator code          | SHA256 of `src/**/*.py`       | File glob: `src/**/*.py`                 |
| Bindgen filters                | Part of composite key         | File input: `bindgen-filters.yaml`       |
| Emscripten version             | `emcc --version` string       | `runtime: emcc --version`                |
| Build flags (OPT, LTO, EXC)    | String in key                 | `env` inputs per target                  |
| YAML config                    | Not in key                    | File input per link target               |
| Link-only flags (BIGINT, etc.) | Not in any key                | `env` inputs on link targets             |
| DEPS.json                      | Hash in key                   | File input                               |
| PCH state                      | Not validated (trusts key)    | Content hash via `outputs`               |

### Named Inputs for Reuse

```json
{
  "namedInputs": {
    "ocjsToolchain": [{ "runtime": "emcc --version" }],
    "ocjsCompileFlags": [
      { "env": "OCJS_OPT" },
      { "env": "OCJS_LTO" },
      { "env": "OCJS_EXCEPTIONS" },
      { "env": "OCJS_SIMD" },
      { "env": "THREADING" },
      { "env": "OCJS_DEFINES" },
      { "env": "OCJS_UNDEFINES" }
    ],
    "occtVersion": [{ "runtime": "git -C repos/OCCT rev-parse HEAD" }],
    "ocjsGeneratorCode": [
      "{workspaceRoot}/repos/opencascade.js/src/**/*.py",
      "{workspaceRoot}/repos/opencascade.js/bindgen-filters.yaml"
    ]
  }
}
```

### Gitignored Paths

`repos/OCCT/`, `repos/opencascade.js/build/`, and other paths under `repos/` are gitignored. Nx does not hash gitignored files by default. Solutions:

1. **`runtime` inputs** for content identity (git commit hash, file checksums)
2. **Tracked manifest files** that record dependency state (e.g., `repos.yaml` already captures commit pins)
3. **`repos.yaml`** itself as an input — when OCCT pin changes, all OCCT-dependent targets invalidate

## Build Variants

### Current Problem

The current system builds variants (exceptions, single, SIMD) by changing environment variables and re-running the same `build-wasm.sh full`. This leads to:

- Environment leaks between variants (RC-3)
- Shared `build/` directory conflicts (RC-2)
- No parallel variant builds

### Proposed Solution

Each variant combination becomes a distinct Nx target or configuration:

```
ocjs-link-single-nosimd     (OCJS_EXCEPTIONS=0, OCJS_SIMD=0)
ocjs-link-single-simd       (OCJS_EXCEPTIONS=0, OCJS_SIMD=1)
ocjs-link-exceptions-simd   (OCJS_EXCEPTIONS=1, OCJS_SIMD=1)
```

Shared upstream targets (`ocjs-compile-sources`, `ocjs-compile-bindings`) are parameterized by the flags that affect them. Since OCCT source compilation depends on exception mode and SIMD flags, variant-specific source compilation targets may be needed:

```
ocjs-compile-sources-exc-simd
ocjs-compile-sources-noexc-nosimd
```

Alternatively, use Nx **configurations** on a single target:

```json
{
  "build": {
    "configurations": {
      "exceptions-simd": {
        "env": { "OCJS_EXCEPTIONS": "1", "OCJS_SIMD": "1" }
      },
      "single-nosimd": {
        "env": { "OCJS_EXCEPTIONS": "0", "OCJS_SIMD": "0" }
      }
    }
  }
}
```

The `env` values participate in the Nx hash, giving each configuration a unique cache key.

### Isolated Build Directories

To prevent parallel variant collisions, each variant needs its own build directory. Options:

1. **Symlink `build/` per variant** before running the step (current approach, fragile)
2. **Pass build dir as env/arg** — modify scripts to accept `BUILD_DIR` and write outputs there
3. **Nx worktrees** — use `best-of-n-runner` subagent pattern with isolated git worktrees

Option 2 is the cleanest long-term solution but requires script modifications. Option 1 can work initially with Nx's sequential task execution preventing concurrent access.

## Nx Cloud Integration

The Tau workspace already has Nx Cloud configured (`nxCloudId` in `nx.json`). Benefits for OCCT builds:

1. **Cross-machine cache sharing** — a CI build populates the cache; developers get instant cache hits for unchanged upstream steps
2. **Build artifact distribution** — 20MB+ WASM files distributed via Nx Cloud rather than committed or packed
3. **Build analytics** — track which steps are slow, which cache frequently, and which are often invalidated
4. **Distributed task execution** — potentially run `ocjs-compile-sources` and `ocjs-compile-bindings` on different CI agents in parallel

### Size Considerations

WASM build outputs are large (20-30 MB per variant). Nx Cloud stores task outputs; ensure the plan/quota accommodates:

- ~50 MB per variant (WASM + JS + d.ts)
- ~2.8 GB per compile cache entry (binding `.o` files + OCCT `.a` files)
- Retention policy to manage storage

## Migration Path

### Phase 1: Wrap Existing Scripts (Low Risk)

Add `project.json` files that wrap existing `build-wasm.sh` subcommands with `nx:run-commands`. No script modifications needed. Enable caching on stable steps first (docs, PCH).

```bash
pnpm nx build ocjs-docs        # wraps ./build-wasm.sh docs
pnpm nx build ocjs-pch          # wraps ./build-wasm.sh pch
```

### Phase 2: Enable Full Pipeline Caching

Add `inputs`/`outputs` declarations to all targets. Verify cache behavior by running builds twice and confirming hits. Test cache invalidation by modifying inputs and confirming misses.

### Phase 3: Granular Decomposition

Split the monolithic `full` command into individual Nx targets with proper `dependsOn`. This enables:

- Parallel execution of `ocjs-compile-sources` and `ocjs-compile-bindings`
- Selective re-execution when only generators change
- Nx Cloud cache sharing

### Phase 4: Variant Isolation

Implement per-variant build directories or configurations. Enable parallel variant builds.

### Phase 5: Remove `build-cache.py`

Once Nx manages all caching, the custom `build-cache.py` / `cache/` directory system can be removed.

## Trade-offs

| Aspect                    | Current System                                         | Nx-Managed                                                             |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Cache correctness**     | Manual key computation; 6+ incidents of poisoning      | Content-hash with atomic commits; no poisoning                         |
| **Granularity**           | All-or-nothing (one key for PCH+gen+compile+sources)   | Per-step caching; change bindings.py → only regen + recompile bindings |
| **Setup complexity**      | Single script; no external tooling                     | Nx project graph; `project.json` files; named inputs                   |
| **Debugging**             | Read build logs; inspect timestamps                    | `nx graph` visualization; `nx show project` details                    |
| **Remote caching**        | Manual GCS (not implemented)                           | Nx Cloud (already configured)                                          |
| **Parallel builds**       | Dangerous (shared `build/`)                            | Safe with separate targets and task graph ordering                     |
| **Learning curve**        | Custom system; tribal knowledge                        | Nx docs + existing Tau patterns                                        |
| **Environment isolation** | Relies on shell discipline                             | Declared `env` inputs; hermetic per-target                             |
| **Failure recovery**      | Manual clean + rebuild                                 | Automatic; failed tasks leave no cache                                 |
| **Build time savings**    | Cache hit = skip everything; miss = rebuild everything | Granular: ~3-8 min savings when only generators change                 |

### Risks

1. **Gitignored paths** — `repos/OCCT/` and `repos/opencascade.js/build/` are gitignored; Nx won't hash them by default. Must use `runtime` inputs or tracked manifests.
2. **Large cache entries** — 2.8 GB compile caches may be slow to store/restore locally. Nx Cloud handles this but local disk usage increases.
3. **Script modifications** — Some steps may need changes to accept parameters (e.g., `BUILD_DIR`) for variant isolation. Phase 1 avoids this.
4. **WASM toolchain state** — Emscripten's own caching (`~/.emscripten_cache`) is outside Nx's purview. Stale Emscripten caches could cause issues. Mitigate with `runtime: emcc --version` input.

## Recommendations

| #   | Action                                                                                 | Priority | Effort | Impact                                         |
| --- | -------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------- |
| R1  | Create `project.json` files for each proposed Nx project                               | P0       | Medium | Enables all subsequent improvements            |
| R2  | Add `namedInputs` for toolchain, flags, and OCCT version                               | P0       | Low    | Correct cache keys from day one                |
| R3  | Enable Nx caching on `ocjs-docs` and `ocjs-pch` first                                  | P0       | Low    | Quick win; validates approach                  |
| R4  | Split `full` into `pch` → `generate` → `compile-bindings` + `compile-sources` → `link` | P1       | Medium | Granular caching; parallel sources+bindings    |
| R5  | Add `env` inputs for all `OCJS_*` flags on relevant targets                            | P1       | Low    | Eliminates env leak class of bugs              |
| R6  | Use `runtime` inputs for OCCT commit, emsdk version, DEPS.json                         | P1       | Low    | Correct invalidation for external deps         |
| R7  | Enable Nx Cloud for cross-machine cache sharing                                        | P2       | Low    | Developers get CI-populated caches             |
| R8  | Implement per-variant build directories (`BUILD_DIR` parameter)                        | P2       | Medium | Enables parallel variant builds                |
| R9  | Remove `build-cache.py` and `cache/` directory system                                  | P3       | Medium | Eliminates dual-cache confusion                |
| R10 | Add provenance generation as an Nx target with dependent output hashing                | P3       | Low    | Provenance always consistent with actual build |

## References

- Nx docs: [Task inputs](https://nx.dev/docs/reference/inputs)
- Nx docs: [How caching works](https://nx.dev/docs/concepts/how-caching-works)
- Nx docs: [Task pipeline configuration](https://nx.dev/docs/concepts/task-pipeline-configuration)
- Prior art: [donalffons/libclangjs](https://github.com/donalffons/libclangjs) — Turborepo + LLVM/Clang WASM
- Related: `docs/research/occt-wasm-optimization.md`
- Related: `docs/research/rbv-build-manifest-regressions.md`

## Appendix: Full Incident Cross-Reference

Each incident number maps to the [Caching Failures Inventory](#caching-failures-inventory) table. Root cause classes are labeled RC-1 through RC-6 per the [Root Cause Analysis](#root-cause-analysis) section.

| Incident | RC Class        | Would Nx Prevent? | Mechanism                                                   |
| -------- | --------------- | ----------------- | ----------------------------------------------------------- |
| 1–7      | RC-1, RC-2      | Yes               | Atomic cache writes; separate project outputs               |
| 8–12     | RC-3            | Yes               | Declared `env` inputs; hermetic per-target                  |
| 13–17    | RC-4, RC-5      | Yes               | Content-hash inputs; granular targets                       |
| 18–23    | RC-4, RC-6      | Yes               | Atomic outputs; failure = no cache                          |
| 24–28    | RC-6 (workflow) | Partial           | Pack/install are workflow steps; version bumps still manual |
