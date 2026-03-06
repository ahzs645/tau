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
