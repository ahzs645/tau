---
title: 'AssimpJS Emscripten/Embind Optimization Audit'
description: 'Comprehensive comparison of assimpjs vs opencascade.js Emscripten build configurations, identifying performance and size gaps'
status: draft
created: '2026-04-16'
updated: '2026-04-16'
category: audit
related:
  - docs/research/3mf-assimp-audit.md
  - docs/research/export-options-pipeline-architecture.md
---

# AssimpJS Emscripten/Embind Optimization Audit

Systematic comparison of the Emscripten/Embind build configurations between `assimpjs` (taucad fork) and `opencascade.js` (taucad fork) to identify performance, size, and correctness gaps where assimpjs is leaving optimization opportunities on the table.

## Executive Summary

The opencascade.js build pipeline has been heavily modernized with advanced Emscripten features (native WASM exceptions, SIMD, EVAL_CTORS, wasm-opt post-processing, LTO, Closure compiler, `-O3`), while assimpjs uses a comparatively vanilla configuration. Key findings: assimpjs compiles at `-O2` instead of `-O3`, uses legacy JS exception handling instead of native WASM exceptions, lacks SIMD, has no LTO, no wasm-opt post-processing, no Closure compiler, and ships with `-sASSERTIONS=1` enabled in production — each of which independently degrades either WASM binary size or runtime performance. Combined, these represent an estimated 20–40% reduction opportunity in WASM file size and measurable throughput gains for format conversion.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Current Artifact Sizes](#current-artifact-sizes)
- [Finding 1: Optimization Level — O2 vs O3](#finding-1-optimization-level--o2-vs-o3)
- [Finding 2: Exception Handling Strategy](#finding-2-exception-handling-strategy)
- [Finding 3: No SIMD Instructions](#finding-3-no-simd-instructions)
- [Finding 4: No Link-Time Optimization](#finding-4-no-link-time-optimization)
- [Finding 5: No wasm-opt Post-Processing](#finding-5-no-wasm-opt-post-processing)
- [Finding 6: Assertions Enabled in Production](#finding-6-assertions-enabled-in-production)
- [Finding 7: Closure Compiler Disabled](#finding-7-closure-compiler-disabled)
- [Finding 8: EVAL_CTORS Not Used](#finding-8-eval_ctors-not-used)
- [Finding 9: Memory Configuration Differences](#finding-9-memory-configuration-differences)
- [Finding 10: No TypeScript Definition Generation](#finding-10-no-typescript-definition-generation)
- [Finding 11: No Build Cache or Incremental Build](#finding-11-no-build-cache-or-incremental-build)
- [Finding 12: Filesystem Overhead](#finding-12-filesystem-overhead)
- [Complete Flag Comparison Matrix](#complete-flag-comparison-matrix)
- [Recommendations](#recommendations)

## Problem Statement

The `assimpjs` WASM build uses a simple Emscripten configuration that has not been updated to leverage modern WASM features. Meanwhile, `opencascade.js` (the other major WASM dependency in Tau) has undergone extensive optimization. We need to identify exactly which flags and techniques are missing from `assimpjs` and quantify their expected impact.

## Methodology

1. Read the complete CMakeLists.txt for both projects to extract all compile and link flags
2. Read all build scripts (`build-wasm.sh`, `build_wasm_deb.sh`, `buildFromYaml.py`, `Common.py`)
3. Read build configuration YAML files (`full.yml`, `full-exceptions.yml`)
4. Compare flag-by-flag with documented Emscripten optimization guidance
5. Measure current artifact sizes from `dist/` directories

Source files analyzed:

- `repos/assimpjs/CMakeLists.txt` — sole build configuration (176 lines)
- `repos/assimpjs/tools/build_wasm_deb.sh` — build orchestration
- `repos/opencascade.js/build-wasm.sh` — multi-stage build pipeline
- `repos/opencascade.js/src/buildFromYaml.py` — link + wasm-opt
- `repos/opencascade.js/src/Common.py` — shared compile flags
- `repos/opencascade.js/build-configs/full.yml` — production link flags

## Current Artifact Sizes

| Artifact            | WASM Size | JS Glue Size |
| ------------------- | --------- | ------------ |
| `assimpjs-mini`     | 3.9 MB    | 52 KB        |
| `assimpjs-all`      | 15 MB     | 60 KB        |
| `assimpjs-exporter` | 11 MB     | 166 KB       |
| `opencascade_full`  | 35 MB     | 70 KB        |

The exporter variant (11 MB WASM, 166 KB JS) is the one consumed by `@taucad/converter` and is the primary optimization target.

## Finding 1: Optimization Level — O2 vs O3

**assimpjs:** `-O2` (CMakeLists.txt line 87)
**opencascade.js:** `-O3` (full.yml emccFlags, Common.py compile, build-wasm.sh cmake)

```cmake
# assimpjs/CMakeLists.txt:87-88
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O2 -DNDEBUG")
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O2 -DNDEBUG")
```

**Impact:** `-O3` enables additional optimizations including more aggressive inlining, loop vectorization, and dead code elimination. For compute-heavy geometry processing (mesh triangulation, normal computation, coordinate transforms), `-O3` typically yields 5–15% throughput improvement over `-O2`. The Emscripten docs recommend `-O3` for production builds.

**Risk:** Low. `-O3` can increase code size slightly, but this is offset by the other size-reducing flags below. Assimp's codebase is well-tested and `-O3` is its default native build level.

## Finding 2: Exception Handling Strategy

**assimpjs:** Legacy JS exception handling

```cmake
# CMakeLists.txt:97 (assimp target) + :113 (AssimpJS target)
target_compile_options (assimp PUBLIC -fexceptions ...)
target_compile_options (AssimpJS PUBLIC -fexceptions)

# CMakeLists.txt:122
target_link_options (AssimpJS PUBLIC -sDISABLE_EXCEPTION_CATCHING=0)
```

**opencascade.js (no-exceptions variant):**

```yaml
# full.yml
- -sDISABLE_EXCEPTION_CATCHING=1
- -sSUPPORT_LONGJMP=0
```

**opencascade.js (exceptions variant):**

```yaml
# full-exceptions.yml
- -fwasm-exceptions
- -sEXPORT_EXCEPTION_HANDLING_HELPERS
```

**Impact:** assimpjs uses the _worst_ exception handling strategy: legacy JS exception catching (`-fexceptions` + `-sDISABLE_EXCEPTION_CATCHING=0`). This is the slowest and largest option because Emscripten wraps every function call with JS try/catch trampolines, inflating both WASM and JS glue code. Two better alternatives:

1. **Disable exceptions entirely** (`-sDISABLE_EXCEPTION_CATCHING=1` + `-sSUPPORT_LONGJMP=0`) — eliminates all overhead; C++ `throw` becomes `abort()`. Saves ~5–10% WASM size. Viable if Assimp's import/export errors can be handled via return codes (which they largely already are — `aiReturn` enum).
2. **Native WASM exceptions** (`-fwasm-exceptions`) — zero-cost when no exception is thrown; exceptions are handled natively in WASM without JS trampolines. Requires emsdk 3.1.x+ (assimpjs already uses 5.0.1). Adds ~2–5% size for exception tables but eliminates runtime overhead.

Assimp does use C++ exceptions internally (e.g., `DeadlyImportError`, `DeadlyExportError`), so option 2 (native WASM exceptions) is the recommended path. The opencascade.js project provides both variants for comparison.

## Finding 3: No SIMD Instructions

**assimpjs:** No SIMD flags present in CMakeLists.txt
**opencascade.js:** `-msimd128 -mrelaxed-simd` in both compile and link flags

**Impact:** SIMD enables vectorized operations on 128-bit registers. For Assimp's mesh processing (vertex transforms, normal computation, matrix operations), SIMD can yield 2–4× throughput on vectorizable loops. `relaxed-simd` adds further gains via fused multiply-add and relaxed lane operations.

SIMD is supported in all modern browsers (Chrome 91+, Firefox 89+, Safari 16.4+) and Node.js 15+. The assimpjs `ENVIRONMENT=web,node` constraint is compatible.

**Risk:** Low. SIMD support is near-universal. A non-SIMD fallback build variant could be maintained if needed, but opencascade.js ships SIMD-only for production.

## Finding 4: No Link-Time Optimization

**assimpjs:** `-flto` absent from all flags
**opencascade.js:** `-flto` conditionally added via `OCJS_LTO=1` env var; `Common.py` and `buildFromYaml.py` both support it

**Impact:** LTO enables cross-module dead code elimination and inlining across translation units. For a project like Assimp that statically links a large library (assimp.a) into a small binding executable, LTO can eliminate substantial unreachable code. Expected impact: 5–15% WASM size reduction, modest throughput improvement from cross-module inlining.

**Risk:** Increases link time significantly (2–5×). Worth it for release builds.

## Finding 5: No wasm-opt Post-Processing

**assimpjs:** No wasm-opt step in `build_wasm_deb.sh`
**opencascade.js:** Full wasm-opt pipeline in `buildFromYaml.py`:

```python
wasm_opt_flag_list = [
    wasm_opt_level,        # default -O3
    "--strip-debug",
    "--strip-producers",
    "--enable-mutable-globals",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-nontrapping-float-to-int",
    "--traps-never-happen",
]
```

Plus conditional `--enable-exception-handling`, `--enable-simd`, `--enable-relaxed-simd`, `--converge`, and `BINARYEN_EXTRA_PASSES`.

**Impact:** Binaryen's wasm-opt performs optimizations that LLVM does not, including:

- `--strip-debug` / `--strip-producers` — removes debug metadata and producer sections
- `--traps-never-happen` — enables additional optimizations by assuming no traps
- `--enable-nontrapping-float-to-int` — uses WASM nontrapping conversions
- `--converge` — runs optimization passes until no further improvement

opencascade.js reports typical reductions of 5–12% from wasm-opt alone. For assimpjs-exporter (11 MB), this could save 500 KB–1.3 MB.

## Finding 6: Assertions Enabled in Production

**assimpjs:** `-sASSERTIONS=1` (CMakeLists.txt line 125)
**opencascade.js:** No `-sASSERTIONS` in production YAML (defaults to 0 at `-O2`/`-O3`)

**Impact:** Assertions add runtime checks for null pointers, invalid memory access, and stack overflow. These are valuable during development but add size (~20–50 KB JS glue) and runtime overhead in production. The `-sABORTING_MALLOC=1` flag (also present in assimpjs) provides malloc failure detection without the broader assertion overhead.

## Finding 7: Closure Compiler Disabled

**assimpjs:** Closure explicitly commented out

```cmake
# CMakeLists.txt:128-129
# JS size optimizations (Closure disabled for faster builds; re-enable for release)
# target_link_options (AssimpJS PUBLIC --closure=1)
```

**opencascade.js:** Conditional Closure via `OCJS_CLOSURE=true` env var

**Impact:** Closure Compiler (Google) minifies and dead-code-eliminates the JS glue code. The assimpjs-exporter has 166 KB of JS glue — Closure typically reduces JS glue by 30–50%, which would bring this to ~80–110 KB. For the mini variant (52 KB), savings would be ~15–25 KB.

**Risk:** Closure requires careful annotation of JS code that interacts with Emscripten internals. With `-sMODULARIZE=1`, Closure works well. It does increase build time.

## Finding 8: EVAL_CTORS Not Used

**assimpjs:** No `-sEVAL_CTORS` flag
**opencascade.js:** `-sEVAL_CTORS=2` in production YAMLs

**Impact:** `EVAL_CTORS` evaluates C++ global constructors at build time rather than runtime, moving initialization cost from page load to compile time. Level 2 is the most aggressive, evaluating constructors that call imported functions. For Assimp, which has numerous global registries (importer/exporter factories), this could eliminate measurable startup latency.

**Risk:** Can cause issues if constructors have side effects that depend on runtime state. Assimp's registries are pure initialization, so risk is low.

## Finding 9: Memory Configuration Differences

| Setting        | assimpjs                | opencascade.js              |
| -------------- | ----------------------- | --------------------------- |
| Initial memory | `INITIAL_HEAP=64MB`     | `INITIAL_MEMORY=100MB`      |
| Maximum memory | `MAXIMUM_MEMORY=2GB`    | `MAXIMUM_MEMORY=4GB`        |
| Stack size     | `STACK_SIZE=8MB`        | `STACK_SIZE=8388608` (8 MB) |
| Memory growth  | `ALLOW_MEMORY_GROWTH=1` | `ALLOW_MEMORY_GROWTH=1`     |

**Impact:** assimpjs's `MAXIMUM_MEMORY=2GB` limits processing of large models. The 4 GB limit in opencascade.js allows processing of larger CAD assemblies. For assimpjs, increasing to 4 GB has no size cost (the limit is only checked at runtime).

The `INITIAL_HEAP=64MB` in assimpjs is reasonable since format conversion doesn't require as much upfront memory as CAD kernel operations.

## Finding 10: No TypeScript Definition Generation

**assimpjs:** No `.d.ts` files generated; manual type definitions maintained in `@taucad/converter`
**opencascade.js:** Custom `.d.ts.json` pipeline generates complete type definitions per symbol, merged at link time

**Impact:** Not a performance issue, but a DX gap. The `--emit-tsd` Emscripten flag (available since emsdk 3.1.x) could auto-generate `.d.ts` from Embind registrations, replacing the manual `packages/converter/src/types/assimpjs.d.ts` that must be manually kept in sync.

## Finding 11: No Build Cache or Incremental Build

**assimpjs:** CMake's built-in object caching only; no build-flags validation, no artifact management
**opencascade.js:** Multi-layer caching system:

- `build-flags.json` validates compile-time flag consistency
- `build/.cmake-lib-dir` for CMake artifact reuse
- Object file timestamp comparison in `compileBindings.py`
- MD5 hash-based patch freshness detection
- Nx-integrated caching with declared outputs

**Impact:** Build reproducibility and developer velocity. Not a runtime concern, but important for iteration speed on the assimpjs fork.

## Finding 12: Filesystem Overhead

**assimpjs:** `-sFILESYSTEM=1` (CMakeLists.txt line 141)
**opencascade.js:** FS enabled via `EXPORTED_RUNTIME_METHODS=["FS"]`

Both projects need the Emscripten virtual filesystem for file I/O. However, assimpjs could potentially use `-sFILESYSTEM=0` combined with in-memory buffers (the `FileList` API already works with `Uint8Array` buffers, not FS paths). This would eliminate ~50–80 KB of FS code from the JS glue.

**Risk:** Medium. Would require verifying that Assimp's internal I/O doesn't rely on the Emscripten FS for temporary files during conversion. The current `ConvertFileList` API uses `MemoryIOHandler`, which bypasses FS, but some exporters (e.g., STEP, USD) may use temporary files internally.

## Complete Flag Comparison Matrix

| Flag / Feature         | assimpjs                                                  | opencascade.js                                          | Gap Impact                    |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| **Optimization level** | `-O2`                                                     | `-O3`                                                   | 5–15% throughput              |
| **Exception handling** | `-fexceptions` + `-sDISABLE_EXCEPTION_CATCHING=0` (JS EH) | `-fwasm-exceptions` or `-sDISABLE_EXCEPTION_CATCHING=1` | 5–10% size + runtime overhead |
| **SIMD**               | ✗ absent                                                  | `-msimd128 -mrelaxed-simd`                              | 2–4× vectorizable loops       |
| **LTO**                | ✗ absent                                                  | `-flto` (conditional)                                   | 5–15% size reduction          |
| **wasm-opt**           | ✗ absent                                                  | `-O3` + 8 optimization passes                           | 5–12% size reduction          |
| **Assertions**         | `-sASSERTIONS=1`                                          | ✗ disabled                                              | ~30–50 KB JS overhead         |
| **Closure compiler**   | ✗ commented out                                           | `--closure 1` (conditional)                             | 30–50% JS glue reduction      |
| **EVAL_CTORS**         | ✗ absent                                                  | `-sEVAL_CTORS=2`                                        | Startup latency improvement   |
| **WASM_BIGINT**        | ✓ present                                                 | ✓ present                                               | — (parity)                    |
| **MODULARIZE**         | ✓ `-sMODULARIZE=1`                                        | ✓ `-sMODULARIZE`                                        | — (parity)                    |
| **EXPORT_ES6**         | ✓ `-sEXPORT_ES6=1`                                        | ✓ `-sEXPORT_ES6=1`                                      | — (parity)                    |
| **EXPORT_NAME**        | ✓ `assimpjs`                                              | ✗ not set (default)                                     | —                             |
| **ENVIRONMENT**        | `web,node`                                                | varies per config                                       | —                             |
| **STACK_SIZE**         | `8MB`                                                     | `8MB`                                                   | — (parity)                    |
| **MAXIMUM_MEMORY**     | `2GB`                                                     | `4GB`                                                   | Large model capacity          |
| **SUPPORT_LONGJMP**    | `0`                                                       | `0`                                                     | — (parity)                    |
| **--emit-tsd**         | ✗ absent                                                  | ✗ (custom pipeline)                                     | DX improvement                |
| **Build cache**        | CMake only                                                | Multi-layer + flags validation                          | Developer velocity            |

## Recommendations

| #   | Action                                                                                    | Priority | Effort  | Impact                                         | Size Savings Est.                     |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------- | ---------------------------------------------- | ------------------------------------- |
| R1  | Upgrade `-O2` → `-O3`                                                                     | P0       | Trivial | High throughput                                | Minimal                               |
| R2  | Switch to `-fwasm-exceptions` (replace `-fexceptions` + `-sDISABLE_EXCEPTION_CATCHING=0`) | P0       | Low     | High: eliminates JS trampoline overhead        | 5–10% WASM                            |
| R3  | Add wasm-opt post-processing (`-O3 --strip-debug --strip-producers --traps-never-happen`) | P0       | Low     | High: Binaryen-only optimizations              | 5–12% WASM (~600 KB–1.3 MB)           |
| R4  | Remove `-sASSERTIONS=1` for production builds                                             | P0       | Trivial | Medium: runtime checks + JS size               | ~30–50 KB JS                          |
| R5  | Enable `-flto` for release builds                                                         | P1       | Low     | Medium: cross-TU dead code elimination         | 5–15% WASM                            |
| R6  | Enable Closure compiler (`--closure=1`)                                                   | P1       | Low     | Medium: JS glue minification                   | 30–50% JS glue (~50–80 KB)            |
| R7  | Add `-msimd128 -mrelaxed-simd` compile+link flags                                         | P1       | Low     | Medium: vectorized geometry ops                | Slight increase, offset by throughput |
| R8  | Add `-sEVAL_CTORS=2`                                                                      | P1       | Trivial | Low–Medium: startup latency                    | Minimal                               |
| R9  | Increase `MAXIMUM_MEMORY` from `2GB` → `4GB`                                              | P2       | Trivial | Low: enables larger model processing           | None                                  |
| R10 | Evaluate `-sFILESYSTEM=0` feasibility                                                     | P2       | Medium  | Low: eliminates FS JS overhead                 | ~50–80 KB JS                          |
| R11 | Add `--emit-tsd` for TypeScript definition generation                                     | P2       | Low     | Low: DX improvement, eliminates manual `.d.ts` | None                                  |
| R12 | Implement build-flags validation (inspired by opencascade.js `build-flags.json`)          | P3       | Medium  | Low: build reproducibility                     | None                                  |

### Estimated Combined Impact

Applying R1–R8 (all P0 and P1 recommendations) to the exporter variant:

- **WASM size:** 11 MB → ~7.5–8.5 MB (25–30% reduction)
- **JS glue:** 166 KB → ~80–100 KB (40–50% reduction)
- **Throughput:** 10–20% improvement from `-O3` + SIMD + native EH
- **Startup:** Faster initialization from EVAL_CTORS + no assertion checks

### Implementation Order

1. **Phase 1 (quick wins):** R1 (`-O3`), R4 (assertions), R8 (EVAL_CTORS), R9 (memory limit) — all are single-line CMake changes
2. **Phase 2 (build pipeline):** R3 (wasm-opt script), R6 (Closure), R5 (LTO) — require build script updates
3. **Phase 3 (exception handling):** R2 (wasm exceptions) — requires testing all import/export paths; consider dual-variant builds as opencascade.js does
4. **Phase 4 (SIMD):** R7 — add compile+link flags, verify no regressions
5. **Phase 5 (DX/infra):** R10, R11, R12 — optional improvements

## Implementation Results

All 8 findings (F1–F8) were applied iteratively, least-to-most risky, and tested against the full mocha test suite (72 passing; 1 pre-existing USD timeout). **All 8 passed with zero breakages.**

### Cumulative Size Progression (Exporter Variant)

| Step     | Finding                               | WASM (bytes) | WASM Delta | JS (bytes) | JS Delta |
| -------- | ------------------------------------- | ------------ | ---------- | ---------- | -------- |
| Baseline | —                                     | 11,931,547   | —          | 170,504    | —        |
| 1        | F6: Remove `-sASSERTIONS=1`           | 11,862,756   | -69 KB     | 134,906    | -36 KB   |
| 2        | F1: `-O2` → `-O3`                     | 11,668,406   | -194 KB    | 132,677    | -2 KB    |
| 3        | F8: `-sEVAL_CTORS=2`                  | 11,668,301   | -105 B     | 132,160    | -517 B   |
| 4        | F4: `-flto`                           | 12,206,832   | +538 KB    | 129,295    | -2.9 KB  |
| 5        | F5: wasm-opt post-processing          | 12,204,425   | -2.4 KB    | 129,295    | —        |
| 6        | F7: `--closure=1`                     | 12,204,425   | —          | 53,604     | -75.7 KB |
| 7        | F3: SIMD (`-msimd128 -mrelaxed-simd`) | 12,208,135   | +3.7 KB    | 53,604     | —        |
| 8        | F2: `-fwasm-exceptions`               | 8,973,679    | -3.2 MB    | 42,988     | -10.6 KB |

### Final vs Baseline

| Metric           | Baseline             | Final              | Reduction             |
| ---------------- | -------------------- | ------------------ | --------------------- |
| **WASM size**    | 11,931,547 (11.4 MB) | 8,973,679 (8.6 MB) | **-2.96 MB (24.8%)**  |
| **JS glue size** | 170,504 (166 KB)     | 42,988 (42 KB)     | **-127.5 KB (74.8%)** |
| **Total**        | 12,102,051 (11.5 MB) | 9,016,667 (8.6 MB) | **-3.09 MB (25.5%)**  |

### Key Observations

- **F2 (WASM exceptions) was the single biggest win** — eliminating JS exception trampolines removed ~3.2 MB of WASM and ~10.6 KB of JS glue. The `invoke_*` imports that polluted the JS glue are gone entirely.
- **F7 (Closure) was the biggest JS win** — reducing JS glue by 58.5% (75.7 KB) through dead code elimination and minification.
- **F4 (LTO) increased WASM size** by 538 KB due to aggressive cross-module inlining at `-O3`. This is a throughput-for-size trade-off; the inlined code runs faster but takes more space. F2's exception handling change later recouped this and more.
- **F8 (EVAL_CTORS) had minimal impact** because JS exception trampolines (`invoke_*`) blocked constructor evaluation. After F2 switched to native WASM exceptions, EVAL_CTORS could evaluate further (stopped at `_embind_register_class` instead of `invoke_v`).
- **F5 (wasm-opt) had minimal additional impact** because `-O3` + LTO already performed most Binaryen-style optimizations at link time. The `--strip-debug --strip-producers` passes still provide value for production builds.
- **Build time increased** from ~90s to ~160s primarily due to LTO (F4) and Closure (F7). This is acceptable for release builds.
- **All downstream tests pass** — 1077 `@taucad/converter` tests confirmed full compatibility with the optimized WASM binary.
- **wasm-opt -O4 was used** instead of -O3. `-O4` adds `--flatten --rereloop` for better throughput at a marginal size increase (+6 KB on the exporter). The exporter WASM final size with -O4 is 8,979,778 bytes.

### All Variant Results

All three build variants (mini, all, exporter) were rebuilt with the full F1-F8 optimizations and wasm-opt -O4. All 73 tests pass (including USD which previously timed out — the optimized WASM executes faster).

| Variant      | Before WASM          | After WASM           | WASM Delta            | Before JS | After JS | JS Delta               |
| ------------ | -------------------- | -------------------- | --------------------- | --------- | -------- | ---------------------- |
| **Mini**     | 4,078,596 (3.9 MB)   | 3,446,963 (3.3 MB)   | **-632 KB (-15.5%)**  | 52,818    | 41,445   | **-11.4 KB (-21.5%)**  |
| **Exporter** | 11,931,547 (11.4 MB) | 8,979,778 (8.6 MB)   | **-2.95 MB (-24.7%)** | 170,504   | 42,988   | **-127.5 KB (-74.8%)** |
| **All**      | 15,603,922 (14.9 MB) | 11,717,227 (11.2 MB) | **-3.89 MB (-24.9%)** | 61,846    | 43,558   | **-18.3 KB (-29.5%)**  |

Total combined reduction across all variants: **-7.5 MB WASM**, **-157 KB JS**.
