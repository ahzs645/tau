---
title: 'OCCT V8 WASM Build — Native Dev Flow Testing'
description: 'Audit of native dev flow testing for OCCT V8 WASM build: build procedure, results, issues found, and verified working components.'
status: active
created: '2026-03-06'
updated: '2026-03-07'
category: audit
---

# OCCT V8 WASM Build — Native Dev Flow Testing

Testing date: 2026-03-06
Branch: `occt-v8-emscripten-5` (opencascade.js fork)
Host: macOS (darwin 25.0.0), Apple M-series, Python 3.14.3, Emscripten 5.0.1

## Test Procedure

Full native dev flow from scratch:

1. `clone-deps.sh` — clone OCCT, rapidjson, freetype at pinned commits
2. Activate emsdk 5.0.1
3. Install Python deps from `requirements.txt`
4. Build with `-O0` compile + `-O0` wasm-opt for maximum compilation speed

## Build Results (after fixes)

| Metric                 | Value                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Build command          | `OCJS_OPT="-O0" OCJS_LTO=0 OCJS_WASM_OPT_LEVEL="-O0" ./build-wasm.sh link build-configs/full.yml` |
| Link duration          | 59s                                                                                               |
| WASM size (raw)        | 17.41 MB                                                                                          |
| WASM size (gzip)       | 6.09 MB                                                                                           |
| JS glue                | 109.5 KB                                                                                          |
| TypeScript defs        | 377.3 KB                                                                                          |
| Binding files compiled | 3,779                                                                                             |
| Source files compiled  | 4,238                                                                                             |
| Bound symbols          | 257                                                                                               |
| PCH size               | 75 MB                                                                                             |
| wasm-opt effect at -O0 | 17.2 MB → 17.4 MB (+1.4%, size increase)                                                          |

## Issues Found

### 1. BLOCKER: `StdPrs_ToolTriangulatedShape` binding does not exist

**Severity:** Build-breaking
**Status:** Fixed

The `full.yml` and `full-exceptions.yml` configs included `StdPrs_ToolTriangulatedShape`, which lives in `TKV3d` (Visualization module). This package is excluded by `filterPackages.py`, so no binding `.cpp.o` was generated, causing `verifyBindings()` to throw.

**Root cause:** Generic configs were derived from the old v7.6.2 replicad YAML configs (`custom_build_single.yml`) rather than the v8-updated configs (`custom_build_single_v8.yml`). The v8 configs correctly removed this symbol.

**Fix:** Removed `StdPrs_ToolTriangulatedShape` from both `build-configs/full.yml` and `build-configs/full-exceptions.yml`.

**Follow-up:** Audit the full diff between `custom_build_single_v8.yml` and `full.yml` to ensure all v8 changes are reflected. There are ~35 symbols in `full.yml` not in the v8 replicad config, and one symbol (`GeomAdaptor_TransformedSurface`) in the v8 config but not in `full.yml`. These differences need review.

### 2. BLOCKER: Missing `.js` extension in YAML config `name` field

**Severity:** Build-breaking (unusable output)
**Status:** Fixed

The generic configs used `name: opencascade_full` instead of `name: opencascade_full.js`. Emscripten uses the `name` field as the output filename, so the JS glue code was written to a file without a `.js` extension (just `opencascade_full`), making it unimportable.

**Fix:** Updated both configs to include `.js` extension:

- `full.yml`: `name: opencascade_full.js`
- `full-exceptions.yml`: `name: opencascade_full_exceptions.js`

### 3. BUG: `clone-deps.sh` variable expansion failure

**Severity:** Build-breaking (script crashes)
**Status:** Fixed

The `local name="$1" repo="$2" commit="$3" target="$PARENT_DIR/$name"` declaration in `clone_at_commit()` fails under `set -u` because `$name` is not yet defined when `target` is evaluated on the same `local` line.

**Fix:** Split into separate `local` declarations:

```bash
local name="$1"
local repo="$2"
local commit="$3"
local target="$PARENT_DIR/$name"
```

### 4. Wrong emsdk repository URL

**Severity:** Medium (blocks new users)
**Status:** Fixed

Both `clone-deps.sh` and `README.md` referenced `nicolo-ribaudo/emsdk` (a personal fork) instead of the official `emscripten-core/emsdk` repository.

**Fix:** Updated URLs to `https://github.com/emscripten-core/emsdk.git`.

### 5. `requirements.txt` pyyaml pin fails on Python 3.12+

**Severity:** Medium (blocks pip install)
**Status:** Fixed

`pyyaml==6.0` fails to build from source on Python 3.12+ due to a Cython compatibility issue (`AttributeError: 'build_ext' object has no attribute 'cython_sources'`). PyYAML 6.0.1+ fixes this.

**Fix:** Changed pin from `pyyaml==6.0` to `pyyaml>=6.0`.

### 6. `OCJS_WASM_OPT_LEVEL` not documented in `--help`

**Severity:** Low (discoverability)
**Status:** Not fixed (documentation-only)

The `OCJS_WASM_OPT_LEVEL` environment variable controls the wasm-opt optimization level but is not listed in the `--help` output under "Environment Variables". Users must read the source to discover it.

### 7. Provenance records wrong LLVM version

**Severity:** Low (inaccurate metadata)
**Status:** Not fixed

`provenance.py` records the LLVM version by running the system `clang --version`, which on macOS picks up Apple Clang (version 17) instead of the Emscripten LLVM toolchain. The provenance shows `"llvm": "17"` when the actual Emscripten LLVM is version 20+.

**Fix needed:** Parse LLVM version from `$EMSDK/upstream/bin/clang --version` or from `emcc --version` metadata.

### 8. wasm-opt at -O0 increases file size

**Severity:** Informational
**Status:** Expected behavior

Running `wasm-opt -O0` increases the WASM from 17.2 MB to 17.4 MB (+1.4%). This is expected because wasm-opt runs canonicalization passes even at `-O0` that can expand certain patterns. For debug/dev builds, consider skipping wasm-opt entirely.

### 9. 1,216 TypeScript type generation warnings

**Severity:** Low (cosmetic, expected)
**Status:** Not fixed (known limitation)

The TypeScript definition generator produces 1,216 unique `could not generate proper types for type name '...', using 'any' instead.` warnings. These are for:

- Template types (e.g., `NCollection_Array1<double>`)
- Nested types (e.g., `Geom2d_Curve::ResD1`)
- Handle types not in the bindings list (e.g., `occ::handle<Geom2d_Vector>`)

These result in `any` types in the `.d.ts` file but don't affect runtime behavior.

### 10. OCCT V8 deprecation warnings during binding generation

**Severity:** Informational
**Status:** Expected behavior

~30 deprecation warnings from OCCT V8's `NCollectionAliases` during binding generation (e.g., `Poly_Array1OfTriangle.hxx is deprecated since OCCT 8.0.0`). These are informational — the deprecated headers still work but redirect to the new `NCollection_*` types.

### 11. Symbol set mismatch between generic and replicad v8 configs

**Severity:** Medium (correctness)
**Status:** Not fixed (needs audit)

The generic `full.yml` has ~35 symbols NOT present in the tested replicad v8 config (`custom_build_single_v8.yml`), and is missing 1 symbol (`GeomAdaptor_TransformedSurface`) that IS in the v8 config. Key extras in `full.yml`:

- `BRepCheck_Analyzer`, `BRepMesh_DiscretRoot`, `BRepOffsetAPI_MakePipe`
- `BRepPrimAPI_MakeRevolution`, `BRepPrimAPI_MakeTorus`, `BinTools`
- `Bnd_OBB`, `GC_MakeArcOfEllipse`, `Geom2dConvert_ApproxCurve`
- `GeomAPI_Interpolate`, `GeomAPI_PointsToBSplineSurface`, `Geom_ConicalSurface`
- Multiple `Handle_*` types for Geom2d and Geom classes
- `IFSelect_ReturnStatus`, `Poly_Connect`, `STEPControl_StepModelType`
- `ShapeFix_EdgeConnect`, `StlAPI_Writer`

These extras may be intentional (superset for generic use) or may include symbols that don't work correctly with V8. Needs review.

## Build Timeline (full build from scratch, -O0)

| Phase               | Notes                                   |
| ------------------- | --------------------------------------- |
| PCH generation      | ~10s, 4,132 headers → 75 MB PCH         |
| Binding generation  | ~30s, parses OCCT headers with libclang |
| Binding compilation | ~8 min, 3,779 files with 8 workers      |
| Source compilation  | ~5 min, 4,238 files with 8 workers      |
| Link step           | ~60s, 257 bindings + 4,238 sources      |
| wasm-opt            | ~5s at -O0                              |
| **Total**           | **~15 min** (first build, no cache)     |

### 12. `wasm-experiment.sh` passes wrong variant name to benchmark

**Severity:** Medium (benchmark fails for exceptions variant)
**Status:** Fixed

The experiment script passed `--wasm-variant with-exceptions` to the benchmark runner, but the benchmark script's Zod schema only accepts `single` or `single-exceptions`. The benchmark would fail with a validation error for any exceptions experiment.

**Fix:** Changed `with-exceptions` to `single-exceptions` in both the single-experiment and benchmark-all code paths.

### 13. Unimplemented optimization env vars in `build-wasm.sh`

**Severity:** Low (silently ignored)
**Status:** Not fixed (known gap)

The experiment config supports `optimizations.closure`, `optimizations.evalCtors`, `optimizations.converge`, and `optimizations.patchDump`, and `wasm-experiment.sh` parses and passes them as `OCJS_CLOSURE`, `OCJS_EVAL_CTORS`, `OCJS_CONVERGE`, and `OCJS_PATCH_DUMP` env vars. However, `build-wasm.sh` does not read or act on any of these. They are silently ignored during the build.

The `OCCT_NO_DUMP` define (passed via `OCJS_DEFINES`) handles the DumpJson stubbing that `patchDump` was intended to accomplish.

---

## Max-Perf Exceptions Build (end-to-end)

### Experiment Config

Experiment: `O3-noLTO-maxperf-wasmExc.yml`

- Compile: `-O3`, no LTO, native WASM exceptions
- Link: wasm-opt `-O3`
- Defines: `OCCT_NO_DUMP`
- Undefines: `OCC_CONVERT_SIGNALS`

### Build Results

| Metric          | Single                                                   | Exceptions        |
| --------------- | -------------------------------------------------------- | ----------------- |
| WASM (raw)      | 18.90 MB                                                 | 22.47 MB          |
| WASM (gzip)     | 6.07 MB                                                  | 6.83 MB           |
| JS glue         | 52.8 KB                                                  | 52.9 KB           |
| TypeScript defs | 353.0 KB                                                 | 354.2 KB          |
| Build duration  | — (from cache)                                           | 1001s (~16.7 min) |
| Cache key       | `O3-noLTO-wasmExc-single-ab418f1a-48ebca-em5.0.1-9ce403` | same              |

### Kernels Tests

**All tests pass (39 test files, 801 tests passed, 4 skipped)**

Example models with `single-exceptions` WASM (all 8 pass):

| Fixture         | Duration |
| --------------- | -------- |
| tray            | 692ms    |
| birdhouse       | 511ms    |
| bottle          | 437ms    |
| gridfinity-box  | 421ms    |
| vase            | 286ms    |
| wavy-vase       | 2468ms   |
| cycloidal-gear  | 645ms    |
| projection-test | 144ms    |

### Benchmarks (single variant, 10 iterations)

| Operation             | Mean     | Median   | P95      |
| --------------------- | -------- | -------- | -------- |
| box                   | 39.66ms  | 35.09ms  | 77.13ms  |
| cylinder              | 19.79ms  | 18.70ms  | 24.00ms  |
| sphere                | 31.56ms  | 31.52ms  | 35.08ms  |
| fuse-two-boxes        | 35.60ms  | 33.12ms  | 46.29ms  |
| cut-cylinder-from-box | 23.07ms  | 23.64ms  | 25.51ms  |
| n-body-fuse           | 67.28ms  | 57.30ms  | 112.62ms |
| box-fillet-all        | 43.78ms  | 43.29ms  | 46.42ms  |
| box-chamfer-all       | 38.46ms  | 38.66ms  | 40.25ms  |
| sketch-extrude        | 17.41ms  | 18.56ms  | 20.10ms  |
| sketch-revolve        | 18.34ms  | 17.82ms  | 21.26ms  |
| multi-hole-plate      | 201.93ms | 201.67ms | 208.27ms |
| tray                  | 44.78ms  | 43.91ms  | 49.64ms  |
| birdhouse             | 221.26ms | 221.37ms | 225.04ms |
| bottle                | 299.28ms | 293.78ms | 327.85ms |
| gridfinity-box        | 230.56ms | 230.72ms | 234.78ms |
| vase                  | 174.11ms | 173.70ms | 178.15ms |
| cycloidal-gear        | 625.29ms | 614.29ms | 677.28ms |
| deep-boolean-chain    | 101.37ms | 101.20ms | 106.87ms |

### Benchmarks (exceptions variant, 5 iterations)

| Operation             | Mean     | Median   | P95      |
| --------------------- | -------- | -------- | -------- |
| box                   | 42.21ms  | 32.38ms  | 71.58ms  |
| cylinder              | 19.86ms  | 20.81ms  | 21.50ms  |
| sphere                | 52.22ms  | 47.72ms  | 85.56ms  |
| fuse-two-boxes        | 33.36ms  | 33.68ms  | 36.56ms  |
| cut-cylinder-from-box | 24.01ms  | 25.08ms  | 25.60ms  |
| n-body-fuse           | 59.16ms  | 58.54ms  | 63.11ms  |
| box-fillet-all        | 43.50ms  | 45.03ms  | 45.48ms  |
| box-chamfer-all       | 38.07ms  | 35.97ms  | 42.74ms  |
| sketch-extrude        | 18.29ms  | 18.15ms  | 19.76ms  |
| sketch-revolve        | 42.98ms  | 22.76ms  | 107.71ms |
| multi-hole-plate      | 214.19ms | 214.40ms | 221.32ms |
| tray                  | 46.66ms  | 45.64ms  | 50.46ms  |
| birdhouse             | 226.70ms | 225.68ms | 229.55ms |
| bottle                | 280.05ms | 279.68ms | 282.38ms |
| gridfinity-box        | 238.23ms | 236.84ms | 241.39ms |
| vase                  | 176.43ms | 176.27ms | 178.74ms |
| cycloidal-gear        | 558.29ms | 546.43ms | 595.86ms |
| deep-boolean-chain    | 103.66ms | 105.15ms | 105.95ms |

---

## Verified Working

- `clone-deps.sh` correctly clones and checks out pinned commits (after fix)
- emsdk 5.0.1 activation from sibling directory
- Python deps (libclang, pyyaml, cerberus) work with installed versions
- PCH generation from flat includes
- Binding generation from OCCT V8 headers
- Parallel compilation (8 workers) for both bindings and sources
- Cache key generation and cache miss detection
- Build summary output with WASM/JS/DTS sizes
- Provenance JSON generation with pinned deps
- `build-wasm.sh --help` output
- `link` command for fast re-link after config changes
- `wasm-experiment.sh` full pipeline: build → pack → install → deploy
- replicad v8 YAML configs (single vs exceptions) are correctly synced
- Kernels tests: 39 test files, 801 tests passed
- Example models: all 8 pass with exceptions variant
- Benchmarks: 18 benchmarks pass for both single and exceptions variants
- No regressions observed vs previous builds
