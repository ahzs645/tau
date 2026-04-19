---
title: 'OpenCASCADE.js Build System Cross-Project Comparison'
description: 'Comparative analysis of opencascade.js build systems across brepjs, zalo fork, and taucad fork — identifying optimization gaps and adoption opportunities.'
status: draft
created: '2026-03-20'
updated: '2026-03-20'
category: comparison
related:
  - docs/research/ocjs-wasm-optimization.md
  - docs/research/build-flag-audit.md
  - docs/research/ocjs-v8-dx-modernization.md
---

# OpenCASCADE.js Build System Cross-Project Comparison

Systematic comparison of three opencascade.js build systems — [brepjs](https://github.com/andymai/brepjs), [zalo fork](https://github.com/zalo/opencascade.js), and our taucad fork — to identify optimization gaps, best practices, and adoption opportunities for maximizing performance, minimizing bundle size, and modernizing the build pipeline.

## Executive Summary

Analysis of three opencascade.js build approaches reveals significant optimization opportunities for the taucad fork. brepjs achieves substantially smaller WASM binaries through aggressive API subsetting (~275 symbols vs ~4,452), SIMD, LTO, `-O3`, `wasm-opt -O4`, and `EVAL_CTORS=2`. Our fork leaves several Emscripten 5.x features unused — notably `WASM_BIGINT`, `SIMD`, `EVAL_CTORS`, `MINIMAL_RUNTIME`, `EMBIND_AOT`, and Closure compiler. The zalo fork, while outdated (Emscripten 1.39.20), demonstrates the value of curated API surfaces for bundle size. We recommend adopting 14 specific optimizations organized by effort and impact.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Build System Architecture Comparison](#finding-1-build-system-architecture)
- [Emscripten Flags Comparison](#finding-2-emscripten-flags)
- [Bundle Size Comparison](#finding-3-bundle-size)
- [Performance Tuning Comparison](#finding-4-performance-tuning)
- [Module Format & Loading](#finding-5-module-format--loading)
- [Exception Handling](#finding-6-exception-handling)
- [API Surface & Binding Strategy](#finding-7-api-surface--binding-strategy)
- [Custom C++ Performance Helpers](#finding-8-custom-c-performance-helpers)
- [Testing & Benchmarks](#finding-9-testing--benchmarks)
- [What We Do Well](#what-we-do-well)
- [Recommendations](#recommendations)
- [Appendix: Flag Comparison Matrix](#appendix-flag-comparison-matrix)

## Problem Statement

Our opencascade.js WASM binary is 46.9 MB (full build) or ~18 MB (replicad subset). Other projects building the same library achieve significantly different size/performance profiles. We need to identify all build-level optimizations available to us and prioritize adoption.

## Methodology

Deep source analysis of three opencascade.js builds:

1. **brepjs** (`repos/brepjs/packages/brepjs-opencascade/`): Custom YAML-templated build using donalffons Docker images, ~275-symbol API subset
2. **zalo fork** (`repos/zalo-opencascade.js/`): WebIDL-based bindings, Docker build, ~120-class API surface, Emscripten 1.39.20
3. **taucad fork** (`repos/opencascade.js/`): Embind + custom Python pipeline, full OCCT API, Emscripten 5.0.1

Cross-referenced against Emscripten 5.0.1 settings catalog (`repos/assimpjs/emsdk/upstream/emscripten/src/settings.js`).

## Findings

### Finding 1: Build System Architecture

| Aspect         | brepjs                        | zalo                          | taucad                       |
| -------------- | ----------------------------- | ----------------------------- | ---------------------------- |
| Build tool     | Docker + ytt YAML templates   | Docker + `make.py` (Python 2) | Shell + Python 3 scripts     |
| Binding system | Embind (donalffons)           | WebIDL (`webidl_binder.py`)   | Embind + custom dispatch     |
| OCCT version   | donalffons Docker (OCCT 7.8+) | `fd47711` snapshot (OCCT 7.x) | OCCT 8.x (`48ebca0`)         |
| Emscripten     | donalffons Docker (5.x)       | 1.39.20                       | 5.0.1                        |
| Build cache    | None (Docker layer cache)     | None (Docker layer cache)     | Custom `build-cache.py`      |
| PCH            | Via donalffons                | No                            | Custom `buildPch()`          |
| Parallelism    | Docker-level                  | `make -j` for OCCT            | Per-file binding compilation |

**Analysis**: Our build system is the most sophisticated with caching, PCH, and flag validation. brepjs benefits from Docker reproducibility. The zalo fork is architecturally outdated.

### Finding 2: Emscripten Flags

| Flag                                | brepjs                            | zalo           | taucad                            | Impact          |
| ----------------------------------- | --------------------------------- | -------------- | --------------------------------- | --------------- |
| **Optimization**                    | `-O3`                             | `-O3`          | `-O2`                             | Size + perf     |
| **LTO**                             | `-flto`                           | `--llvm-lto 3` | `-flto` (default on)              | Size            |
| **SIMD**                            | `-msimd128 -mrelaxed-simd`        | No             | No                                | **Perf**        |
| **WASM_BIGINT**                     | Yes (`-sWASM_BIGINT`)             | No             | No                                | **Size + perf** |
| **EVAL_CTORS**                      | `2`                               | No             | `false` (off)                     | **Startup**     |
| **AGGRESSIVE_VARIABLE_ELIMINATION** | No                                | Yes            | No                                | Size            |
| **ERROR_ON_UNDEFINED_SYMBOLS**      | Not set                           | Not set        | `0`                               | Safety          |
| **MODULARIZE**                      | Yes (via donalffons)              | Yes            | Yes                               | DX              |
| **EXPORT_ES6**                      | Yes                               | Yes            | Yes                               | DX              |
| **USE_FREETYPE**                    | Not set                           | No             | Yes                               | Size            |
| **ALLOW_MEMORY_GROWTH**             | Yes                               | Yes            | Yes                               | Required        |
| **wasm-opt level**                  | `-O4`                             | Not applied    | `-O3`                             | Size            |
| **wasm-opt strip**                  | `--strip-debug --strip-producers` | N/A            | `--strip-debug --strip-producers` | Size            |
| **Closure compiler**                | No                                | Optional       | `false` (off)                     | JS size         |
| **MALLOC**                          | `mimalloc` (threaded)             | Default        | Default                           | Perf            |
| **USE_ES6_IMPORT_META**             | `0`                               | `0`            | Not set                           | Compat          |

**Critical gaps**: Our fork is missing SIMD, WASM_BIGINT, EVAL_CTORS, and uses `-O2` instead of `-O3`.

### Finding 3: Bundle Size

| Metric      | brepjs (single)              | zalo (wasm)  | taucad (full) | taucad (replicad) |
| ----------- | ---------------------------- | ------------ | ------------- | ----------------- |
| WASM        | ~11 MB target (≤5.5 MB goal) | 35 MB        | **46.9 MB**   | 17.9 MB           |
| JS glue     | ~55 KB main                  | 1.3 MB       | 292 KB        | 109 KB            |
| .d.ts       | ~9K lines                    | 80 KB        | **7.5 MB**    | —                 |
| API symbols | ~275                         | ~120 classes | ~4,452        | ~231              |

**Analysis**: brepjs achieves 4× smaller WASM than our replicad build through aggressive API subsetting and optimization. The taucad full build is 46.9 MB because it exposes the entire OCCT API. For production use cases, curated subsets are essential.

### Finding 4: Performance Tuning

| Technique                       | brepjs                                            | zalo | taucad                     |
| ------------------------------- | ------------------------------------------------- | ---- | -------------------------- |
| SIMD (`-msimd128`)              | Yes                                               | No   | **No**                     |
| Relaxed SIMD (`-mrelaxed-simd`) | Yes                                               | No   | **No**                     |
| `mimalloc` allocator            | Threaded only                                     | No   | **No**                     |
| `EVAL_CTORS=2`                  | Yes                                               | No   | **No**                     |
| Prewarm (JIT warmup)            | Yes (`prewarm()`)                                 | No   | No                         |
| Batch C++ helpers               | Yes (MeshExtractor, BooleanBatch, TransformBatch) | No   | No                         |
| wasm-opt `-O4`                  | Yes                                               | No   | `-O3`                      |
| `--converge`                    | Not observed                                      | No   | Optional (`OCJS_CONVERGE`) |

**Critical gaps**: SIMD, EVAL_CTORS, mimalloc, and batch C++ helpers are all absent from our build.

### Finding 5: Module Format & Loading

| Aspect                  | brepjs                                    | zalo                | taucad                 |
| ----------------------- | ----------------------------------------- | ------------------- | ---------------------- |
| Format                  | ESM factory                               | CJS + ESM           | ESM factory            |
| Exports map             | `.`, `./single`, `./threaded`, `./src/`\* | `main: index.js`    | Single file            |
| WASM loading            | `locateFile`                              | Webpack file-loader | `locateFile`           |
| Streaming instantiation | Emscripten default                        | Emscripten default  | Emscripten default     |
| `USE_ES6_IMPORT_META`   | `0` (disabled)                            | `0`                 | Not set                |
| Multiple variants       | single, threaded, with-exceptions         | asm.js + wasm       | Full, replicad, custom |

**Analysis**: brepjs has the best package distribution with explicit exports map and three WASM variants. Our fork ships single monolithic builds.

### Finding 6: Exception Handling

| Aspect                     | brepjs                         | zalo                  | taucad                       |
| -------------------------- | ------------------------------ | --------------------- | ---------------------------- |
| Default                    | `-fwasm-exceptions`            | None (Emscripten 1.x) | No exceptions                |
| JS fallback                | Separate `-fexceptions` build  | N/A                   | Optional `OCJS_EXCEPTIONS=1` |
| Exception helpers          | `OCJS.getStandard_FailureData` | N/A                   | `getExceptionMessage`        |
| DISABLE_EXCEPTION_CATCHING | Not set (wasm-exc handles)     | Not set               | `1`                          |

**Analysis**: brepjs defaults to native WASM exceptions (best performance when exceptions are needed), with a separate `-fexceptions` build for environments lacking support. Our fork defaults to no exceptions, which is optimal for size but loses error information.

### Finding 7: API Surface & Binding Strategy

| Aspect              | brepjs                                  | zalo                                     | taucad                           |
| ------------------- | --------------------------------------- | ---------------------------------------- | -------------------------------- |
| Binding system      | Embind (donalffons YAML)                | WebIDL (`opencascade.idl`)               | Embind + custom Python           |
| API definition      | Explicit symbol list in YAML            | Manual IDL file                          | Auto-generated from OCCT headers |
| Symbol count        | ~275                                    | ~120 classes                             | ~4,452                           |
| Overload handling   | donalffons `_N` suffixes                | WebIDL optional params                   | Custom dispatch tree             |
| Enum representation | Numeric (donalffons default)            | WebIDL enums                             | **String enums** (custom)        |
| Namespace strategy  | Flat (`oc.BRepPrimAPI_MakeBox`)         | Flat (`opencascade.BRepPrimAPI_MakeBox`) | Namespace grouping (custom)      |
| Custom C++ code     | Yes (MeshExtractor, BooleanBatch, etc.) | No                                       | `additionalBindCode`             |

**Analysis**: Our fork has the most advanced binding system with string enums, custom dispatch, and auto-generated bindings from OCCT headers. brepjs adds valuable C++ performance helpers. The zalo fork's WebIDL approach is simpler but more limited.

### Finding 8: Custom C++ Performance Helpers

brepjs introduces several C++ helper classes that reduce JS↔WASM boundary crossings:

| Helper                 | Purpose                                                         | Impact                                 |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------- |
| `MeshExtractor`        | Single-call mesh extraction (vertices, normals, triangles, UVs) | Eliminates per-face iteration overhead |
| `EdgeMeshExtractor`    | Bulk edge tessellation with segment counting                    | Reduces edge iteration overhead        |
| `BooleanBatch`         | N-way fuse/cut with `SetRunParallel(true)`, `SetUseOBB(true)`   | Parallelized booleans                  |
| `TransformBatch`       | Batch translate/rotate/scale/mirror                             | Reduces per-shape overhead             |
| `EvolutionExtractor`   | Modified/generated/deleted face tracking                        | Efficient evolution queries            |
| `MeasurementExtractor` | Bulk volume/area/bbox computation                               | Single-pass measurements               |
| `TopologyExtractor`    | Topology iteration in C++                                       | Avoids `TopExp_Explorer` JS overhead   |

**Analysis**: These helpers represent a significant performance optimization pattern. Each reduces the JS↔WASM call overhead by performing iteration-heavy work in C++. Our fork's `additionalBindCode` could adopt similar patterns.

### Finding 9: Testing & Benchmarks

| Aspect                 | brepjs                                                                    | zalo | taucad           |
| ---------------------- | ------------------------------------------------------------------------- | ---- | ---------------- |
| Test framework         | Vitest                                                                    | None | Vitest           |
| Performance benchmarks | Comprehensive (startup, boolean, meshing, scaling, topology, binary size) | None | Smoke tests only |
| Startup phase tracking | Yes (import, compile, init, first-box, first-mesh)                        | No   | No               |
| Size tracking          | `.size-limit.json` + `binary-size.bench.test.ts`                          | No   | Manual           |
| Prewarm strategy       | Yes (`prewarm()`)                                                         | No   | No               |
| Kernel comparison      | OCCT vs brepkit-wasm                                                      | N/A  | N/A              |

**Analysis**: brepjs has significantly more sophisticated benchmarking. Their startup phase decomposition and size tracking are models we should adopt.

## What We Do Well

Areas where our taucad fork leads:

| Strength                       | Description                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| **Full OCCT API**              | ~4,452 bindings vs brepjs's ~275 — enabling any OCCT workflow                             |
| **String enums**               | Type-safe string enum representation instead of numeric                                   |
| **Custom dispatch**            | Intelligent overload resolution without `_N` suffixes                                     |
| **Build cache**                | `build-cache.py` with content-addressed cache keys — neither brepjs nor zalo cache builds |
| **PCH support**                | Precompiled headers accelerate binding compilation — unique to our fork                   |
| **Build flag validation**      | `build-flags.json` prevents flag mismatches across stages                                 |
| **OCCT v8**                    | Latest OCCT version (8.x) vs brepjs (7.8+) and zalo (7.x)                                 |
| **Emscripten 5.0.1**           | Latest Emscripten vs zalo's ancient 1.39.20                                               |
| **Namespace generation**       | Organized `.d.ts` namespaces vs flat exports                                              |
| **Multiple build configs**     | Flexible YAML-driven build for any API subset                                             |
| **Provenance tracking**        | `provenance.json` records exact build configuration                                       |
| **Exception mode flexibility** | Runtime choice between no-exc, wasm-exc, and js-exc                                       |

## Recommendations

| #   | Action                                                                                      | Priority | Effort | Impact                                                                | Source             |
| --- | ------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------------------- | ------------------ |
| R1  | Enable `-msimd128 -mrelaxed-simd` for all builds                                            | P0       | Low    | High — arithmetic-heavy CAD ops benefit significantly                 | brepjs             |
| R2  | Enable `-sWASM_BIGINT` to avoid i64→i32 legalization overhead                               | P0       | Low    | Medium — eliminates conversion code, smaller glue                     | brepjs, Emscripten |
| R3  | Set `-sEVAL_CTORS=2` for production builds                                                  | P0       | Low    | Medium — reduces startup time by evaluating constructors at link time | brepjs             |
| R4  | Upgrade compile optimization from `-O2` to `-O3` for production                             | P1       | Low    | Medium — better codegen, more aggressive inlining                     | brepjs, zalo       |
| R5  | Upgrade wasm-opt from `-O3` to `-O4` for production                                         | P1       | Low    | Low-Medium — additional optimization passes                           | brepjs             |
| R6  | Enable `--closure 1` for production JS glue                                                 | P1       | Medium | Medium — ~~50% JS glue reduction (~~146 KB → ~73 KB)                  | Emscripten         |
| R7  | Add batch C++ helpers (MeshExtractor, BooleanBatch, TransformBatch) to `additionalBindCode` | P1       | High   | High — eliminates JS↔WASM iteration overhead for hot paths            | brepjs             |
| R8  | Enable `mimalloc` allocator for threaded builds (`-sMALLOC=mimalloc`)                       | P1       | Low    | Medium — faster allocation under contention                           | brepjs             |
| R9  | Explore `EMBIND_AOT` with `DYNAMIC_EXECUTION=0` for CSP-compliant builds                    | P2       | Medium | Medium — avoids eval, potentially smaller Embind code                 | Emscripten 5.x     |
| R10 | Add performance benchmarks (startup phases, boolean ops, meshing, binary size tracking)     | P2       | Medium | High — enables data-driven optimization                               | brepjs             |
| R11 | Add `prewarm()` to WASM init for JIT warmup before user interaction                         | P2       | Low    | Medium — moves first-op latency off critical path                     | brepjs             |
| R12 | Trim `INCOMING_MODULE_JS_API` to only used props                                            | P2       | Low    | Low — small JS size reduction                                         | Emscripten         |
| R13 | Evaluate `MINIMAL_RUNTIME=1` for stripped-down environments                                 | P3       | High   | Medium — significant JS size reduction but requires testing           | Emscripten 5.x     |
| R14 | Set `USE_ES6_IMPORT_META=0` for broader bundler compatibility                               | P3       | Low    | Low — avoids `import.meta.url` in glue                                | brepjs             |

## Appendix: Flag Comparison Matrix

| Emscripten Setting         | brepjs                     | zalo           | taucad  | Recommended           |
| -------------------------- | -------------------------- | -------------- | ------- | --------------------- |
| Optimization               | `-O3`                      | `-O3`          | `-O2`   | `-O3`                 |
| LTO                        | `-flto`                    | `--llvm-lto 3` | `-flto` | `-flto`               |
| SIMD                       | `-msimd128 -mrelaxed-simd` | —              | —       | `-msimd128`           |
| WASM_BIGINT                | `1`                        | —              | —       | `1`                   |
| EVAL_CTORS                 | `2`                        | —              | `false` | `2`                   |
| MODULARIZE                 | `1`                        | `1`            | `1`     | `1`                   |
| EXPORT_ES6                 | `1`                        | `1`            | `1`     | `1`                   |
| ALLOW_MEMORY_GROWTH        | `1`                        | `1`            | `1`     | `1`                   |
| INITIAL_MEMORY             | 128 MB                     | 128 MB         | 100 MB  | 128 MB                |
| MAXIMUM_MEMORY             | 4 GB                       | —              | 4 GB    | 4 GB                  |
| USE_FREETYPE               | —                          | —              | `1`     | `1`                   |
| MALLOC                     | default/mimalloc           | default        | default | `mimalloc` (threaded) |
| FILESYSTEM                 | default                    | default        | default | `0` if unused         |
| ASSERTIONS                 | default (off in -O3)       | default        | default | `0`                   |
| ERROR_ON_UNDEFINED_SYMBOLS | —                          | —              | `0`     | `1`                   |
| DISABLE_EXCEPTION_CATCHING | —                          | —              | `1`     | `1` (no-exc)          |
| wasm-opt level             | `-O4`                      | —              | `-O3`   | `-O4`                 |
| Closure                    | —                          | optional       | `false` | `1`                   |
| USE_ES6_IMPORT_META        | `0`                        | `0`            | —       | `0`                   |
| EMBIND_AOT                 | —                          | —              | —       | Evaluate              |
| MINIMAL_RUNTIME            | —                          | —              | —       | Evaluate              |

## References

- [brepjs](https://github.com/andymai/brepjs) — Web CAD library with pluggable geometry kernel
- [zalo/opencascade.js](https://github.com/zalo/opencascade.js) — WebIDL-based opencascade.js fork
- [donalffons/opencascade.js](https://github.com/donalffons/opencascade.js) — Original opencascade.js
- Related: `docs/research/ocjs-wasm-optimization.md`
- Related: `docs/research/build-flag-audit.md`
- Emscripten settings: `repos/assimpjs/emsdk/upstream/emscripten/src/settings.js`
