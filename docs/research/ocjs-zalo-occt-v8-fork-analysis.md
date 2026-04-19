---
title: 'Zalo opencascade.js OCCT 8 Fork Analysis'
description: 'Deep comparison of zalo/opencascade.js cascadestudio-v2 fork (OCCT 8.0.0 RC4, emsdk 4.0.23) against taucad/opencascade.js (OCCT 8.0.0 RC4, emsdk 5.0.1) — identifying build system improvements, binding coverage gaps, and migration patterns'
status: active
created: '2026-03-24'
updated: '2026-03-24'
category: comparison
related:
  - docs/research/occt-v8-migration.md
  - docs/research/ocjs-full-build-audit.md
---

# Zalo opencascade.js OCCT 8 Fork Analysis

Systematic comparison of [zalo/opencascade.js `cascadestudio-v2`](https://github.com/zalo/opencascade.js/tree/cascadestudio-v2) against taucad/opencascade.js to identify build system improvements, OCCT V8 migration patterns, and binding enhancements we may be missing.

## Executive Summary

Both forks target OCCT 8.0.0 RC4 but diverge significantly in toolchain maturity and binding strategy. Taucad's fork is ahead on emsdk version (5.0.1 vs 4.0.23), build caching (CMake static libs), binding coverage (~4400 symbols vs ~120), overload dispatch (val-based dispatch trees), WASM exceptions, SIMD, and provenance tracking. Zalo's fork contributes several novel solutions: a two-pass Watson+DelaBella meshing workaround for an OCCT 8.0 RC4 bug, `std::hash<TopoDS_Shape>` HashCode replacement, non-destructive boolean helpers with fuzzy value, LTO-resistant `additionalBindCode` patterns, and a `flattenOcct8.py` OCCT directory flattener. Most of these are already addressed or superseded in taucad's fork, but the meshing workaround and boolean helpers warrant investigation.

## Table of Contents

- [Methodology](#methodology)
- [Finding 1: Toolchain Versions](#finding-1-toolchain-versions)
- [Finding 2: OCCT Source Build Strategy](#finding-2-occt-source-build-strategy)
- [Finding 3: OCCT 8 Directory Restructuring](#finding-3-occt-8-directory-restructuring)
- [Finding 4: Binding Coverage and Strategy](#finding-4-binding-coverage-and-strategy)
- [Finding 5: OCCT 8 API Migration Patterns](#finding-5-occt-8-api-migration-patterns)
- [Finding 6: Meshing Workaround for OCCT 8 RC4 Bug](#finding-6-meshing-workaround-for-occt-8-rc4-bug)
- [Finding 7: Boolean Operation Helpers](#finding-7-boolean-operation-helpers)
- [Finding 8: NCollection and Handle Binding Patterns](#finding-8-ncollection-and-handle-binding-patterns)
- [Finding 9: Build System and Docker Architecture](#finding-9-build-system-and-docker-architecture)
- [Finding 10: Patches and Filters](#finding-10-patches-and-filters)
- [Comparison Matrix](#comparison-matrix)
- [Recommendations](#recommendations)

## Methodology

1. Cloned `zalo/opencascade.js` at `cascadestudio-v2` branch into `repos/zalo-opencascade.js/`
2. Read all key files in both forks: Dockerfiles, Python build scripts, YAML configs, C++ injections, patches
3. Compared OCCT version, emsdk version, build flags, binding strategies, and workarounds
4. Identified novel patterns in zalo's fork not present in taucad's

## Finding 1: Toolchain Versions

| Dimension       | Zalo (`cascadestudio-v2`)                    | Taucad (`master`)                                    |
| --------------- | -------------------------------------------- | ---------------------------------------------------- |
| **OCCT source** | GitHub tarball `V8_0_0_rc4` tag              | Git clone commit `48ebca0f` (same RC4)               |
| **emsdk**       | `emscripten/emsdk:4.0.23` (unpinned digest)  | `emscripten/emsdk:5.0.1` (pinned `sha256:c897…`)     |
| **rapidjson**   | `v1.1.0` tag                                 | Commit `24b5e7a8` (post-1.1.0 master)                |
| **freetype**    | `VER-2-13-0` tag                             | Commit `de8b92dd` (VER-2-13-0)                       |
| **Python deps** | `libclang`, `pyyaml`, `cerberus`, `argparse` | `requirements.txt`                                   |
| **Dep pinning** | Tags only (no commit hashes for deps)        | `DEPS.json` with exact commit hashes + Docker digest |

**Assessment:** Taucad is ahead. emsdk 5.0.1 vs 4.0.23 is a major gap (~6 months of Emscripten improvements). Pinning by digest ensures reproducible builds. Zalo's tag-based pinning for OCCT/freetype is less robust.

## Finding 2: OCCT Source Build Strategy

### Zalo: Direct `emcc` Compilation

Zalo's `compileSources.py` walks the flattened OCCT source tree and runs `emcc -c` per translation unit:

- Flags: `-std=c++17`, `-flto`, `-fexceptions`, `-sDISABLE_EXCEPTION_CATCHING=0`, `-DIGNORE_NO_ATOMICS=1`, `-DOCCT_NO_PLUGINS`, `-DHAVE_RAPIDJSON`, `-Os`, `-frtti`
- Parallel via `multiprocessing.Pool`
- No CMake step — relies on `flattenOcct8.py` to create a flat directory structure

### Taucad: CMake Static Libraries

Taucad's `build-wasm.sh` uses `emcmake cmake` to configure OCCT properly, then `cmake --build` to produce static libraries:

- Full CMake module control (FoundationClasses, ModelingData, ModelingAlgorithms, DataExchange, ApplicationFramework ON; Visualization OFF)
- Proper dependency resolution via CMake
- `build-cache.py` for caching compiled stages keyed on build flags
- PCH (precompiled header) support for faster binding compilation
- `build-flags.json` manifest for validating compile-time flag consistency

**Assessment:** Taucad is significantly ahead. CMake builds are more correct (proper OCCT module dependencies, configuration macros) and more cacheable. Direct `emcc` compilation risks missing configuration-dependent macros and doesn't benefit from OCCT's internal build logic.

## Finding 3: OCCT 8 Directory Restructuring

### Zalo's `flattenOcct8.py` (Novel)

OCCT 8.0 restructured sources from `src/Package/File.hxx` to `src/Module/Toolkit/Package/File.hxx`. Zalo solved this with a symlink-based flattener that:

1. Parses `MODULES.cmake` → `TOOLKITS.cmake` → `PACKAGES.cmake` to discover the hierarchy
2. Creates symlinks `src/Package → src/Module/Toolkit/Package` for each package
3. Generates `Standard_Version.hxx` from `version.cmake` (normally CMake's job)
4. Generates old-style `PACKAGES` files from `PACKAGES.cmake`

### Taucad's Approach

Taucad uses `Common.py::buildFlatIncludes()` to create a flat include directory, plus CMake handles the source layout natively.

**Assessment:** Taucad's CMake approach is architecturally superior — CMake already understands OCCT 8's layout. Zalo's flattener is a creative workaround for avoiding CMake entirely, but adds fragility. However, the `Standard_Version.hxx` generation logic is a useful reference — taucad handles this differently via the Dockerfile (`printf` header).

## Finding 4: Binding Coverage and Strategy

| Dimension             | Zalo                                                                  | Taucad                                                                                                                             |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Symbol count**      | ~120 (curated for CascadeStudio)                                      | ~4400+ (near-complete OCCT coverage)                                                                                               |
| **Binding approach**  | YAML `bindings` list + heavy `additionalBindCode` for workarounds     | YAML `bindings` list + `BUILTIN_ADDITIONAL_BIND_CODE` + `bindgen-filters.yaml`                                                     |
| **Overload dispatch** | Numbered suffixes (`gp_Pnt_1`, `gp_Pnt_3`) only                       | `val`-based dispatch trees (`_classify_js_type`, `_build_dispatch_tree`, `_codegen_dispatch_tree`) + suffix-free symbol generation |
| **Handle types**      | Manual `additionalBindCode` macros (`HANDLE_BINDINGS`)                | Automated via `generateBindings.py` + `ocjs_smart_ptr.h` / `ocjs_handle_helpers.h`                                                 |
| **NCollection types** | Manual `additionalBindCode` macros (`ARRAY1_METHODS`, `ARRAY1_CTORS`) | Automated via template typedef processing                                                                                          |
| **TypeScript**        | Generated `cascadestudio.d.ts` (174 KB)                               | Generated via `buildFromYaml.py` d.ts merge                                                                                        |
| **Enum handling**     | Standard libclang-based                                               | `enum_value_type::string` (string enums)                                                                                           |

**Assessment:** Taucad is far ahead on coverage and automation. Zalo's manual `additionalBindCode` patterns are instructive for workaround techniques but don't scale. The val-based dispatch trees in taucad are a significant DX win over numbered suffixes.

## Finding 5: OCCT 8 API Migration Patterns

Both forks handle the same OCCT 8.0 breaking changes, but with different strategies:

### 5a. `TopoDS` Namespace (was a Class)

OCCT 8.0 changed `TopoDS` from a class to a namespace. Both forks create a `TopoDS_Cast` wrapper class:

```cpp
// Both forks — identical pattern
class TopoDS_Cast {
public:
  static const TopoDS_Vertex& Vertex_1(const TopoDS_Shape& S) { return ::TopoDS::Vertex(S); }
  // ... Edge, Wire, Face, Shell, Solid, Compound ...
};
```

Taucad has this in `BUILTIN_ADDITIONAL_BIND_CODE` in `buildFromYaml.py`.

### 5b. `HashCode` Removal

OCCT 8.0 removed `TopoDS_Shape::HashCode(int)`. Both provide replacements:

- **Zalo**: `OCJS::HashCode` using `std::hash<TopoDS_Shape>{} % Upper`
- **Taucad**: Same pattern in `BUILTIN_ADDITIONAL_BIND_CODE`

### 5c. `Standard_Integer` → `int` Deprecation

OCCT 8.0 deprecated `Standard_Integer` typedef in favor of plain `int`. This breaks `select_overload<>` template deduction.

- **Zalo**: `normalizeOcctType()` in `bindings.py` maps deprecated types; compile tolerance skips failed files
- **Taucad**: Same normalization approach; `wasmGenerator/Common.py::ignoreDuplicateTypedef` handles `double`/`int` variant duplicates

### 5d. `DEFINE_STANDARD_HANDLE` Removal

OCCT 8.0 removed `DEFINE_STANDARD_HANDLE` from most classes.

- **Zalo**: `generateBindings.py::_generateHandleTypedefs()` scans for `DEFINE_STANDARD_RTTIEXT` and emits `typedef opencascade::handle<Class> Handle_Class`
- **Taucad**: Same pattern, plus `ocjs_smart_ptr.h` / `ocjs_handle_helpers.h` for return-by-value semantics

### 5e. `CONSTRUCTOR` Macro Conflict

emsdk's `val.h` defines `CONSTRUCTOR` which conflicts with OCCT's use.

- **Both**: `#undef CONSTRUCTOR` before `#include <emscripten/bind.h>`

**Assessment:** Both forks solved the same V8 migration problems. Taucad's solutions are more systematic (integrated into the codegen pipeline rather than manual workarounds).

## Finding 6: Meshing Workaround for OCCT 8 RC4 Bug

**This is zalo's most significant novel contribution.**

In `cascadestudio.yml` `additionalBindCode`, zalo implements a two-pass meshing strategy via `BRepMesh_IncrementalMesh_2`:

```cpp
struct BRepMesh_IncrementalMesh_2 : public BRepMesh_IncrementalMesh {
  BRepMesh_IncrementalMesh_2(const TopoDS_Shape& theShape, ...) {
    IMeshTools_Parameters params;
    // Pass 1: Watson (default) — reliable for all face types
    params.MeshAlgo = IMeshTools_MeshAlgoType_DEFAULT;
    BRepMesh_IncrementalMesh(theShape, params);

    // Save Watson triangulations per face
    std::vector<...> watsonTris;
    for (TopExp_Explorer ex(theShape, TopAbs_FACE); ...) { ... }

    // Clean mesh (OCCT skips re-meshing faces that already have triangulation)
    BRepTools::Clean(theShape);

    // Pass 2: DelaBella — fixes curved faces with boolean cuts
    params.MeshAlgo = IMeshTools_MeshAlgoType_Delabella;
    BRepMesh_IncrementalMesh(theShape, params);

    // Restore Watson results where DelaBella produced null
    for (auto& [face, watsonTri] : watsonTris) { ... }
  }
};
```

The comment explains: "Watson drops nodes on curved faces with boolean cuts (OCCT 8.0 RC4 bug). DelaBella fixes these but fails on some face types. Two-pass uses the best of both."

**Assessment:** This is a valuable workaround that may affect us. We should investigate whether our OCCT commit (`48ebca0f`, same RC4) exhibits the same meshing issue and whether this two-pass pattern is needed in our `MeshExtractor` C++ code. The `IMeshTools_MeshAlgoType_Delabella` enum is new in OCCT 8.0 and is not currently used in our build.

## Finding 7: Boolean Operation Helpers

Zalo's `OCJS` class includes fuzzy-value boolean helpers:

```cpp
static TopoDS_Shape BooleanCut(const TopoDS_Shape& S1, const TopoDS_Shape& S2, double fuzz) {
  BRepAlgoAPI_Cut op;
  TopTools_ListOfShape args, tools;
  args.Append(S1); tools.Append(S2);
  op.SetArguments(args); op.SetTools(tools);
  op.SetFuzzyValue(fuzz);
  op.SetNonDestructive(true);
  op.Build(Message_ProgressRange());
  return op.Shape();
}
```

These helpers solve a real ergonomics problem: the convenience constructors (`Cut_3`, `Fuse_3`) build immediately in destructive mode, making it impossible to set `FuzzyValue` beforehand.

**Assessment:** Taucad already has `BooleanBatch` C++ helpers with `SetFuzzyValue` support, plus the kernel adapter layer exposes `BooleanOptions.fuzzyValue`. The `SetNonDestructive(true)` default is worth noting — our `BooleanBatch` doesn't set this. Non-destructive mode preserves input shapes, which aligns with brepjs's immutability semantics.

## Finding 8: NCollection and Handle Binding Patterns

### Zalo's Manual Macro Approach

Zalo defines C preprocessor macros for repetitive bindings:

```cpp
#define ARRAY1_METHODS(ArrayType) \
  .function("Size", &ArrayType::Size) \
  .function("Length", &ArrayType::Length) \
  // ...

#define HANDLE_BINDINGS(HandleType, BaseType) \
  class_<HandleType>(#HandleType) \
  .function("IsNull", &HandleType::IsNull) \
  // ...
```

This works around libclang's inability to resolve dependent types in typedef'd template specializations (e.g., `NCollection_Array1<gp_Pnt>::value_type`).

### Taucad's Automated Approach

Taucad handles these in the Python codegen pipeline:

- `generateBindings.py` processes template typedefs automatically
- `ocjs_smart_ptr.h` handles smart pointer bindings
- `NCollection` types get proper codegen via `ncollectionTypedefs` injection

**Assessment:** Taucad's approach scales to thousands of types. Zalo's macro approach works for ~10 types but requires manual maintenance. No action needed.

## Finding 9: Build System and Docker Architecture

### Zalo: 5-Stage Docker with ENTRYPOINT

```
base-image → test-image (patches) → sources-compiled → bindings-generated → custom-build-image
ENTRYPOINT: buildFromYaml.py
```

Key insight: Zalo's Docker stages are designed for cache efficiency — changing binding scripts doesn't require recompiling OCCT sources (~30 min). The `compileSources.py` layer is the expensive one.

### Taucad: Single-Stage Docker + External `build-wasm.sh`

```
base-image: install deps → clone deps → copy repo → applyPatches → flat includes → PCH → bindgen
ENTRYPOINT: build-wasm.sh (orchestrates cmake, compile, link, wasm-opt)
```

Key advantages: CMake-based, `build-cache.py` with flag-keyed stages, `build-flags.json` validation, `provenance.json` metadata, named configurations (`O0-debug`, `O3-maxperf`, etc.), `--emit-symbol-map`.

**Assessment:** Taucad is significantly ahead on build system maturity. Zalo's multi-stage Docker caching is a good idea but superseded by taucad's cache-key approach which is more flexible.

## Finding 10: Patches and Filters

### Shared Patches

Both forks apply the same core patches:

| Patch                    | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `using-statements.patch` | Replace `using` declarations with forwarding methods for Embind compatibility |
| `standard_time.patch`    | Disambiguate `Standard_Time` `IsEqual` template                               |

### Zalo-Specific Filters

| Filter                                        | Purpose                                                                        | In taucad?                         |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `gp_Dir::D` enum exclusion                    | OCCT 8 adds `D` as short-name enum on `gp_Dir` — conflicts with method binding | Handled via `bindgen-filters.yaml` |
| `MathLin_Jacobi.hxx` exclusion                | RC4-specific header that breaks libclang parse                                 | May be handled differently         |
| Deprecated dir skip in `Common.py`            | Skip `/Deprecated` in OCCT 8 source walks                                      | Handled in `buildFlatIncludes()`   |
| `NCollectionAliases` include path (not files) | Add deprecated NCollection aliases to include search path without binding them | Different approach via CMake       |

**Assessment:** All critical filters are covered in taucad. Some specific header exclusions may differ — worth cross-referencing `bindgen-filters.yaml` against zalo's `filterIncludeFiles.py`.

## Comparison Matrix

| Dimension                  | Zalo                                                    | Taucad                                     | Winner                    |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------ | ------------------------- |
| **OCCT version**           | V8_0_0_rc4 (tag)                                        | V8_0_0_rc4 (commit)                        | Taucad (reproducible)     |
| **emsdk version**          | 4.0.23                                                  | 5.0.1                                      | **Taucad**                |
| **Dep pinning**            | Git tags                                                | Commit hashes + Docker digest              | **Taucad**                |
| **OCCT compile**           | Direct `emcc` per TU                                    | CMake static libs                          | **Taucad**                |
| **Build caching**          | Docker layer cache                                      | `build-cache.py` + flag keys               | **Taucad**                |
| **Binding coverage**       | ~120 symbols (curated)                                  | ~4400+ symbols (near-complete)             | **Taucad**                |
| **Overload dispatch**      | Numbered suffixes only                                  | val-based dispatch trees                   | **Taucad**                |
| **Handle bindings**        | Manual macros                                           | Automated codegen                          | **Taucad**                |
| **NCollection bindings**   | Manual macros                                           | Automated template processing              | **Taucad**                |
| **WASM exceptions**        | `-fexceptions` (C++)                                    | `-fwasm-exceptions` (native WASM)          | **Taucad**                |
| **SIMD**                   | None                                                    | `-msimd128 -mrelaxed-simd`                 | **Taucad**                |
| **BigInt**                 | None                                                    | `-sWASM_BIGINT`                            | **Taucad**                |
| **Provenance**             | None                                                    | `provenance.json`                          | **Taucad**                |
| **TypeScript**             | Basic `.d.ts`                                           | JSDoc-enriched `.d.ts` + namespace support | **Taucad**                |
| **Meshing (RC4 bug)**      | Two-pass Watson+DelaBella                               | Standard single-pass                       | **Zalo** (workaround)     |
| **Boolean fuzzy helpers**  | `OCJS::BooleanCut/Fuse/Common` with `SetNonDestructive` | `BooleanBatch` without `SetNonDestructive` | **Zalo** (DX pattern)     |
| **LTO-resistant bindings** | `additionalBindCode` pattern for stripped symbols       | `BUILTIN_ADDITIONAL_BIND_CODE`             | Draw                      |
| **`flattenOcct8.py`**      | Symlink-based directory flattener                       | CMake-native handling                      | Draw (different approach) |
| **Documentation**          | `CLAUDE.md` + `README.md`                               | `README.md` + `BUILD_SYSTEM.md` + docs/    | **Taucad**                |

## Recommendations

| #   | Action                                                                                                                                                                    | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Investigate OCCT 8 RC4 meshing bug (Watson node-dropping on boolean-cut curved faces) — test with our `MeshExtractor` and evaluate if two-pass Watson+DelaBella is needed | P1       | Medium | High   |
| R2  | Evaluate `IMeshTools_MeshAlgoType_Delabella` as a binding/option — OCCT 8 exposes this new meshing algorithm that may improve mesh quality for specific topologies        | P2       | Low    | Medium |
| R3  | Add `SetNonDestructive(true)` to `BooleanBatch` C++ helpers — preserves input shapes and aligns with brepjs/replicad immutability semantics                               | P2       | Low    | Medium |
| R4  | Cross-reference zalo's `filterIncludeFiles.py` exclusions against our `bindgen-filters.yaml` — specifically `MathLin_Jacobi.hxx` and any other RC4-specific breakages     | P3       | Low    | Low    |
| R5  | Monitor upstream OCCT for RC4 meshing fix — the Watson+DelaBella workaround may become unnecessary in a future OCCT release                                               | P3       | None   | Info   |

## Trade-offs

### Two-Pass Meshing (R1)

| Approach                         | Pros                                | Cons                                                              |
| -------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Single-pass Watson (current)     | Simple, fast, one meshing call      | May drop nodes on curved boolean-cut faces                        |
| Two-pass Watson+DelaBella (zalo) | Fixes node-dropping on curved faces | 2× meshing cost, added complexity, stores per-face triangulations |
| Single-pass DelaBella only       | Potentially better mesh quality     | Fails on some face types (requires Watson fallback)               |

### `SetNonDestructive` (R3)

| Approach                           | Pros                                         | Cons                                                  |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Destructive mode (current default) | Slightly faster                              | Mutates input shapes — violates immutability contract |
| Non-destructive mode               | Preserves inputs, correct for functional API | Minor performance overhead                            |

## References

- [zalo/opencascade.js cascadestudio-v2](https://github.com/zalo/opencascade.js/tree/cascadestudio-v2) — source fork analyzed
- [OCCT 8.0.0 RC4 tag](https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_0_rc4) — upstream OCCT release
- Related: `docs/research/occt-v8-migration.md`
- Related: `docs/research/ocjs-full-build-audit.md`
