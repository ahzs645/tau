---
title: 'opencascade.js Fork Holistic Diff (v3 Reference)'
description: 'End-state diff of the @taucad/opencascade.js fork against the last upstream maintainer commit, intended as the canonical reference for changelog, README, and other consumer-facing documentation.'
status: active
created: '2026-04-24'
updated: '2026-04-24'
category: reference
related:
  - docs/research/occt-v8-migration.md
  - docs/research/occt-v8-rc5-migration.md
  - docs/research/ocjs-wasm-build-comparison.md
  - docs/research/ocjs-v8-dx-modernization.md
  - docs/research/ocjs-ncollection-auto-discovery-build-validation.md
  - docs/research/ocjs-typescript-codegen-gap-analysis.md
  - docs/research/ocjs-nx-build-system.md
  - docs/research/ocjs-full-build-audit.md
  - docs/research/replicad-occt-v8-opportunities.md
---

# opencascade.js Fork Holistic Diff (v3 Reference)

End-state diff of `@taucad/opencascade.js` against upstream `donalffons/opencascade.js@5ff2b75` (the last maintainer commit, 2023-03-27), captured as a single reference for future changelog, README, and consumer-doc edits so we never again describe a change incorrectly relative to upstream.

## Executive Summary

The fork is effectively a v3 rewrite of opencascade.js that keeps the upstream Python-codegen backbone (`src/bindings.py`, `src/generateBindings.py`) but replaces almost everything around it: a new entry point (`build-wasm.sh`), a new orchestrator (Nx), reproducible dependency pinning (`DEPS.json`), a generated TypeScript surface with full JSDoc, val-based overload dispatch, output-parameter return-by-value structs, suffix-free overloads, NCollection auto-discovery, baseline SIMD, native WASM exceptions, and a 76-file test suite (61 runtime smoke + 11 type-level + `dts-validation` + `dts-docs` + helpers). The shipped npm artifact is the generated `opencascade_full.{js,wasm,d.ts}` directly; the upstream `dist/index.js` + `dist/node.js` facades have been removed.

**Scale**: 156 files changed, +32,526 / -2,028 across 74 fork commits between `5ff2b75` and `ee56b65`. Only ~21 of those files are upstream files we modified; the rest are net additions (78 tests, 21 src additions, 5 scripts, 4 docs, 2 build configs, plus root-level infrastructure).

## Table of Contents

1. [Methodology](#methodology)
2. [Findings](#findings)
   - [Change inventory](#change-inventory-by-area)
   - F1–F5: Codegen rewrite
   - F6–F8: TypeScript surface
   - F9–F10: Embind / runtime
   - F11–F13: OCCT V8 migration & wasm size
   - F14–F17: Build system, configs, deps, validation
   - F18–F20: Packaging, Docker, tests, docs, starter
3. [Removed concepts](#removed-concepts-from-upstream)
4. [Drift / inconsistencies to fix](#drift-and-inconsistencies-to-fix)
5. [Reference for changelog and README](#reference-for-changelog-and-readme)
6. [Appendix: file inventory](#appendix-full-file-inventory)

## Scope and Non-Goals

**In scope**: end-state diff between `5ff2b75` (upstream) and `ee56b65` (HEAD) on `repos/opencascade.js`, the artifact published as `@taucad/opencascade.js`.

**Out of scope**: replicad-opencascadejs (separate fork), OCCT itself (we pin upstream OCCT V8 RC5), Tau runtime integration of the produced WASM.

## Methodology

1. Enumerated commits with `git log upstream/master..HEAD` → 74 fork commits, baseline `5ff2b75` "fix pip command" by Sebastian Alff (2023-03-27).
2. Computed the holistic diff (`git diff --name-status 5ff2b75..HEAD`) — 129 added, 21 modified, 6 deleted = 156 files; `git diff --shortstat` = +32,526 / -2,028 lines.
3. Read every modified Python file at both commits (`git show 5ff2b75:<path>` vs working tree) to capture functional deltas, not commit-message claims.
4. Read every new C++ header, OCCT patch, build script, and TS declaration in full.
5. Cross-referenced the TopoDS/OCJS embind glue against `BUILTIN_ADDITIONAL_BIND_CODE` in `src/buildFromYaml.py` (lines 171–215) to confirm whether documented wrapper classes (`TopoDS_Cast`, `OCJS_ShapeHasher`, etc.) actually ship vs are documentation-only patterns.
6. Counted tests and listed every smoke and type-level file (61 + 11 + harness).

This methodology means findings reflect what is **actually in HEAD**, not what intermediate commits attempted. Experimental work that was reverted before HEAD (e.g. a brief `OCJS_RELAXED_SIMD` opt-in pathway) does not appear except where called out as drift.

## Findings

### Change inventory by area

| Area                                        |   Added | Modified | Deleted | Notes                                                                                         |
| ------------------------------------------- | ------: | -------: | ------: | --------------------------------------------------------------------------------------------- |
| `src/` (Python codegen + headers + patches) |      21 |       15 |       0 | Core fork work                                                                                |
| `tests/`                                    |      78 |        0 |       0 | Net-new test suite                                                                            |
| `build-configs/`                            |       2 |        0 |       0 | `configurations.json`, `full.yml`                                                             |
| `scripts/`                                  |       5 |        0 |       0 | Deps, validation, symbol enumeration, e2e                                                     |
| `docs/`                                     |       4 |        0 |       0 | + `BUILD_SYSTEM.md` at root                                                                   |
| `starter-templates/`                        |       7 |        0 |       0 | Net-new `ocjs-vite-model-viewer/`                                                             |
| Root infrastructure                         |      11 |        7 |       0 | `build-wasm.sh`, `Dockerfile.wasm-build`, `nx.json`, `project.json`, `requirements.txt`, etc. |
| `dist/` (upstream prebuilt facades)         |       0 |        0 |       6 | `index.{js,d.ts}`, `node.{js,d.ts}` removed                                                   |
| **Total**                                   | **129** |   **21** |   **6** |                                                                                               |

### F1: Val-based overload dispatch (codegen rewrite)

Upstream resolved C++ overloads in JS by argument count alone. When two overloads collapsed to the same arity in JS, embind silently registered the second on top of the first. The fork replaces this with a type-aware dispatcher generated into the binding `.cpp` files.

**Mechanism** (`src/bindings.py` ~1100–1800):

- `_classify_js_dispatch_type` partitions same-arity overloads by JS-distinguishable types (`number` / `bigint` / `string` / `instanceof` / enum string).
- `_build_dispatch_tree` and `_build_js_dispatch_tree` produce a `DispatchLeaf` / `DispatchBranch` IR.
- `_codegen_dispatch_tree` emits an `optional_override` lambda taking `emscripten::val` arguments and an if/else cascade calling the right C++ overload.

**Old code path removed**: the upstream "subclass ladder" (`struct Class_N : public Class { Class_N(...) : Class(...) {} }`) is gone for same-arity groups; only legitimately disambiguated subclasses remain.

This required a parallel patch on Emscripten itself — see F9.

### F2: Output parameters as return-by-value `value_object`

Upstream JS callers had to construct ceremonial `{current: 0}` objects and pass them to functions whose C++ signature took `T&` output references. The fork strips primitive and `Handle<T>` output parameters from the JS signature entirely and packages them (plus the original return value) into a generated `value_object` struct returned by value.

**Mechanism** (`src/bindings.py` `shouldStripParam` ~109–173, `_ensureResultStruct` / `_emitOutputParamBinding` ~1319–1469):

- Non-`const` lvalue refs to primitives, enums, and `opencascade::handle<T>` are detected.
- A struct `<Class>_<method>Result` is emitted with `.field(...)` registrations.
- Inheritance-aware naming (`_find_base_override_target`, `_effectiveOutputNames`) matches base-class result-struct field names so overrides stay assignable.

**JS surface effect**: callers no longer pass placeholder args; functions return the result object directly.

### F3: Suffix-free overloads when arity disambiguates

Upstream always appended `_1`, `_2`, `_3` to overloaded methods. The fork emits no suffix when arities are all distinct (`src/wasmGenerator/Common.py` `getMethodOverloadPostfix` ~79–93). For example, `gp_Pnt.X()` is now `X()` (was `X_1`), `Distance(other)` is `Distance(other)`, and the `_N` ladder only appears when arity collisions remain.

The `dts-validation.test.ts` suite enforces this on the public API (no `_*` subclasses for unique-arity constructors of `gp_Pnt` / `BRepPrimAPI_MakeBox`; methods like `X`, `Distance`, `SetCoord` exist without `_N` suffix) — see lines 373–430.

### F4: NCollection auto-discovery via libclang `using` declarations

OCCT exposes thousands of `NCollection_Array1<T>`, `NCollection_Sequence<T>`, `NCollection_Map<T>` template instantiations. Upstream forced maintainers to hand-curate `additionalCppCode` typedefs for every container shape; missing typedefs caused libclang to fail to resolve template parameters, which surfaced as `any` types in the `.d.ts`.

**Mechanism** (`src/ocjs_bindgen/discover.py`, integrated via `src/generateBindings.py:__main__`):

1. **First pass**: a `TuInfo("")` parses headers and walks public methods of every bound class to collect every `NCollection_*<...>` instantiation actually used.
2. **Mangle**: each is mangled to a stable identifier (`NCollection_Array1<gp_Pnt>` → `NCollection_Array1_gp_Pnt`).
3. **Generate**: emit `using <Mangled> = NCollection_*<...>;` declarations into a synthesised header.
4. **Second pass**: a fresh `TuInfo(using_decls)` reparses with the synthesised aliases prepended, so libclang now resolves every container as a concrete type.
5. **Manifest**: results written to `build/ncollection-manifest.json` and merged into `_known_export_names` for the cross-reference resolver in F5.

Result: the generated `.d.ts` now declares public `NCollection_Sequence_*`, `NCollection_HArray1_*`, `NCollection_Array1_gp_Pnt`, etc. instead of producing `any` for container interfaces.

### F5: TypeScript export graph and `unknown` repair

Upstream emitted minimal TypeScript with no cross-reference resolution: any `.d.ts` reference to a non-bound type was emitted verbatim, producing TS2304 errors on consumer install.

**Mechanism**:

- `src/bindings.py:TypescriptBindings.prepare_known_exports` (~2071+) seeds `_known_export_names` from the parsed AST, NCollection manifest, and `additionalCppCode` symbols.
- `src/buildFromYaml.py:_replace_undeclared_with_unknown` (~72–200) post-processes the merged `.d.ts` to rewrite undeclared type references to `unknown` and repair `extends` chains using ancestor metadata.
- `src/bindings.py:_collect_any` aggregates reasons each type became `any`/`unknown` into `build/any-type-report.json` so regressions are diagnosable.

The `dts-validation.test.ts` suite enforces zero TS2304/TS2552/TS2694/TS2416/TS2300 diagnostics across the entire `opencascade_full.d.ts` and ratchets the total `any` count at ≤ 148 (lines 241–246, 543–926).

### F6: Doxygen → JSDoc pipeline

Upstream emitted no JSDoc. The fork generates JSDoc from OCCT's native Doxygen.

**Mechanism**:

- `src/extract-docs.py` (~735 lines) parses Doxygen XML produced from a build of OCCT's headers, normalises Doxygen markup to Markdown (lists, code blocks, sentence splitting), and writes `build/occt-docs.json`.
- `src/bindings.py:TypescriptBindings` consumes that JSON, escapes `*/`, normalises `{@link}` tokens, emits `@param` / `@returns` / `@remarks` / `@see`, and applies Monaco-oriented line wrapping.
- `src/occt-docs.doxyfile` configures the OCCT Doxygen run.
- `build-wasm.sh docs` is the entry point.

The `tests/dts-docs.test.ts` suite (~1658 lines) enforces ≥60% class coverage, ≥40% method coverage, ≥250 documented enum members, no empty `/** */` blocks, distinct overload docs, `@param` matching, and ten "T1–T10" link normalisation rules.

### F7: Filter pipeline migrated from Python to YAML

Upstream's `src/filter/*.py` modules were ~400 lines of hardcoded class/method/package exclusions. The fork moves name-based exclusions into `bindgen-filters.yaml` (with an `extends:` chain for variants) and reduces each filter to ~10–100 lines of semantic-only rules (using-declaration handling, OCCT V8 deleted-copy patterns, iterator typedef filtering, etc.).

| Filter file                   |               Baseline |                      HEAD |
| ----------------------------- | ---------------------: | ------------------------: |
| `filterClasses.py`            |   ~400 lines hardcoded |            4 lines + YAML |
| `filterMethodOrProperties.py` |   ~310 lines hardcoded |        ~97 lines semantic |
| `filterPackages.py`           |       huge inline list |           34 lines + YAML |
| `filterIncludeFiles.py`       | many specific excludes |           11 lines + YAML |
| `filterTypedefs.py`           |          long denylist |         16 lines semantic |
| `filterSourceFiles.py`        |             `.mm` only | + `GTests` / `*_Test.cxx` |

Variants: `bindgen-filters.yaml` (default, includes select deprecated symbols Replicad needs) and `bindgen-filters-no-deprecated.yaml` (`extends: bindgen-filters.yaml`, drops the deprecated allowlist).

The Python filter installation point (`src/ocjs_bindgen/filters.py`) monkey-patches `sys.modules['bindings']` / `TuInfo` / `Common` predicates so the same AST rules execute, with name-based exclusions sourced from YAML.

### F8: Embind same-arity overload patch on Emscripten itself

`src/patches/libembind-overloading.patch` (~424 lines) is a structural fix to Emscripten's `libembind.js` overload dispatcher. Stock embind throws `BindingError("overload resolution is currently only performed using the parameter count, not actual type info")` when overloads share an arity; the patch:

- Adds `$getSignature` / `$cppTypeToJsType` helpers that build a runtime signature string from `typeOf` + `bigint`/`number` discrimination + `instanceof registeredClass`.
- Adds `$ensureOverloadSignatureTable` so dispatch first picks by `numArguments`, then by signature.
- Mirrors the change for free functions, class constructors, methods, and statics.

Without this, the val-dispatch lambdas in F1 would still hit embind's count-only collision check. The patch is applied to the local emsdk via `build-wasm.sh patch-embind`.

### F9: Native WASM exception support

Upstream used Emscripten's old JavaScript-based exception scheme (`-fexceptions`). The fork switches to native `WebAssembly.Exception` via `-fwasm-exceptions` plus `-sEXPORT_EXCEPTION_HANDLING_HELPERS`, and ships a typed JS surface for them.

**Build flags** (`build-configs/full.yml` ~4322–4341):

```yaml
emccFlags:
  - -fwasm-exceptions
  - -sEXPORT_EXCEPTION_HANDLING_HELPERS
  - ...
```

**TypeScript surface** (`src/buildFromYaml.py` ~629–690): when both flags are present, the post-build pass injects ambient `WebAssembly.Exception` / `WebAssembly.Tag` declarations and `getExceptionMessage` / `incrementExceptionRefcount` / `decrementExceptionRefcount` exports into the published `.d.ts`. This is gated on flag detection so non-EH builds still emit a clean `.d.ts`.

**OCJS exception decoder** (`BUILTIN_ADDITIONAL_BIND_CODE` in `src/buildFromYaml.py` ~171–215):

```cpp
class OCJS {
public:
  static Standard_Failure* getStandard_FailureData(intptr_t exceptionPtr) {
    return reinterpret_cast<Standard_Failure*>(exceptionPtr);
  }
  static bool exceptionsEnabled() {
#ifdef OCJS_EXCEPTIONS_ENABLED
    return true;
#else
    return false;
#endif
  }
};
```

The `tests/smoke/smoke-exceptions.test.ts` suite asserts the full pipeline: throw a `StdFail_NotDone` from a deliberately bad `BRepPrimAPI_MakeWedge`, catch it as a `WebAssembly.Exception`, decode via `getExceptionMessage`, decode the `Standard_Failure*` payload via `OCJS.getStandard_FailureData`. `tests/dts-validation.test.ts` (~248–259) asserts the helper symbols are present in the linked JS glue.

### F10: OCCT V8 migration — embind builtin block

Upstream targeted OCCT V7.6.2; the fork targets V8.0.0 RC5. V8 introduced 10 systemic API breaks documented in `docs/occt-v8-migration.md` (lines 48–191):

| #   | Break                                                    | Resolution in fork                                                                                                                                                                                                        |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `TopoDS_Shape::HashCode` removed                         | `OCJS_ShapeHasher` documented (consumer-side `std::hash<TopoDS_Shape>` pattern)                                                                                                                                           |
| 2   | `TopoDS` is now a namespace, not bindable as a class     | Builtin embind `class_<TopoDS_Bind_>("TopoDS")` with `class_function("Edge", optional_override([](const TopoDS_Shape& s) -> TopoDS_Edge { return TopoDS::Edge(s); }))` etc. — emitted from `BUILTIN_ADDITIONAL_BIND_CODE` |
| 3   | `BRepMesh_IncrementalMesh` constructor signature changed | `BRepMesh_IncrementalMeshWrapper` documented as consumer pattern                                                                                                                                                          |
| 4   | `Handle_*` typedefs no longer auto-generated by OCCT     | Auto-discovered by `ocjs_bindgen.discover` (F4) and emitted as `using` declarations                                                                                                                                       |
| 5   | `Bnd_Box::Get()` removed                                 | Use `CornerMin`/`CornerMax`                                                                                                                                                                                               |
| 6   | `Poly_Triangulation` normals API changed                 | Documented; bindings reflect new API                                                                                                                                                                                      |
| 7   | `Poly_PolygonOnTriangulation::Nodes()` removed           | Use `NbNodes`/`Node(i)`                                                                                                                                                                                                   |
| 8   | Constructor renumbering / `_N` suffix drift              | Mitigated by F3 (suffix-free)                                                                                                                                                                                             |
| 9   | Method overload renumbering                              | Mitigated by F3                                                                                                                                                                                                           |
| 10  | `Bnd_Box2d::Get()` removed                               | Same as #5                                                                                                                                                                                                                |

**What actually ships as a wrapper class**: only the **`TopoDS`** namespace bridge ships in the builtin embind block (`buildFromYaml.py` 206–213). `TopoDS_Cast`, `OCJS_ShapeHasher`, `BRepMesh_IncrementalMeshWrapper`, `BRepToolsWrapper`, and `GeomToolsWrapper` are documentation-only patterns in `docs/occt-v8-migration.md` and `docs/build-config-reference.md` — they are not classes in the fork's source tree. Consumers that need them either provide their own `additionalCppCode` block or rely on the documented patterns. **Do not claim these wrapper classes ship in the fork** in changelogs/READMEs unless they actually do.

### F11: WASM size optimization patches

Targeted OCCT source patches written as Python scripts in `src/patches/`, applied via `src/applyPatches.py`. All keep idempotency sentinels.

| Patch                             | What it fixes                                                                                                                                         | Approx. saving cited                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `patch_brepgraph_versionstamp.py` | OCCT V8 `BRepGraph_VersionStamp.cxx` `static_assert(sizeof(size_t) >= 8)` fails on wasm32                                                             | Compile fix, not size                                                                       |
| `patch_noexcept_destructors.py`   | Forces explicit out-of-line `noexcept` destructors on classes with many `Handle<>` members so `-O3` doesn't inline EH landing pads at every call site | ~627 KB across top functions (per script docstring); supersedes `patch_stepcaf_noexcept.py` |
| `patch_standard_dump.py`          | `-DOCCT_NO_DUMP` makes `OCCT_DUMP_*` macros no-op                                                                                                     | "Hundreds of KB" of JSON dump machinery                                                     |
| `patch_stepcaf_dyntype.py`        | Replaces `IMPLEMENT_STANDARD_RTTIEXT(STEPCAFControl_Controller)` with file-local single descriptor                                                    | Eliminates duplicated lazy static registration                                              |
| `patch_stepcaf_noexcept.py`       | Narrow predecessor of `patch_noexcept_destructors.py` for `STEPCAFControl_ActorWrite`                                                                 | ~555 KB (still applied; sentinel prevents double-patch)                                     |

### F12: WASM size & performance flags

Default build (`build-configs/full.yml` `emccFlags`):

| Flag                                                                          | Purpose                                   | Upstream had it?    |
| ----------------------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| `-fwasm-exceptions`                                                           | Native WASM EH                            | No (`-fexceptions`) |
| `-sEXPORT_EXCEPTION_HANDLING_HELPERS`                                         | Expose `getExceptionMessage` etc.         | No                  |
| `-msimd128`                                                                   | Baseline 128-bit SIMD (Safari-compatible) | No                  |
| `-sWASM_BIGINT`                                                               | Avoid i64 ↔ JS marshalling glue           | No                  |
| `-sEVAL_CTORS=2`                                                              | Evaluate static constructors at link time | No                  |
| `--emit-symbol-map`                                                           | Ship `.symbols` for stack-trace decoding  | No                  |
| `-sALLOW_MEMORY_GROWTH=1` / `-sINITIAL_MEMORY=100MB` / `-sMAXIMUM_MEMORY=4GB` | Memory sizing                             | Partial             |
| `-sEXPORTED_RUNTIME_METHODS=["FS"]`                                           | Expose Emscripten FS to JS                | Subset              |
| `-sUSE_FREETYPE=1`                                                            | Freetype                                  | Yes                 |
| `--no-entry`                                                                  | Library mode                              | Yes                 |
| `-O3`                                                                         | Optimisation level                        | Default             |

**Important framing for the changelog**: SIMD, BigInt, EVAL_CTORS, and native WASM exceptions are **net additions**. There was a brief experimental `OCJS_RELAXED_SIMD=1` opt-in that did not ship at HEAD; relaxed-SIMD never existed in upstream and was never the default in the fork. Do **not** describe v3 as "dropping relaxed-SIMD" — describe it as "added baseline `-msimd128`".

### F13: Reproducible build system (`build-wasm.sh` + `DEPS.json` + Nx)

Upstream had a single `Dockerfile` that fetched OCCT via `curl` snapshot tarball, ran Python directly, and cached nothing. The fork replaces this with a structured pipeline.

**Entry point** (`build-wasm.sh`, ~830 lines): single CLI with subcommands `apply-patches`, `pch`, `docs`, `generate`, `bindings`, `sources`, `dts`, `link`, `validate`, `provenance`, `full`, `clean-generated`, `clean-objects`, `patch-embind`, `sources-legacy`. Accepts `--config <name>` to load a named compile-time configuration.

**Dependency lockfile** (`DEPS.json`):

| Dep                | Pin                                                               |
| ------------------ | ----------------------------------------------------------------- |
| OCCT               | commit `0ebbbedb239d6fffb7e1c8c2d36970a3ab1d9300` (V8.0.0 RC5)    |
| rapidjson          | commit `24b5e7a8b27f42fa16b96fc70aade9106cf7102f`                 |
| freetype           | commit `de8b92dd7ec634e9e2b25ef534c54a3537555c11`                 |
| Emscripten / emsdk | docker image `emscripten/emsdk:5.0.1` + digest `sha256:c89732ef…` |
| Doxygen            | `1.16.1` (commit `669aeeefca743c148e2d935b3d3c69535c7491e6`)      |

Setup scripts: `scripts/clone-deps.sh` (sibling clones), `scripts/setup-deps.sh` (in-tree `deps/` clones, optional `OCJS_STRICT_DEPS=1` to hard-validate SHAs).

**Nx integration** (`nx.json` + `project.json`): cached task graph

```
setup → apply-patches → pch
                     ↓     ↘
                    generate → compile-bindings ↘
                              ↘ dts              link → validate
                     apply-patches → compile-sources ↗   → provenance
                                                          → build
```

`namedInputs`: `compileConfig`, `linkConfig`, `toolchain`, `depsVersion`, `generatorCode`, `buildScript`, `patchScripts`, `compileBindingsScript`, `linkScript`. Each Nx target declares input/output sets so an unrelated change (e.g. editing a YAML link config) does not invalidate the PCH or compiled bindings.

**Validation** (`scripts/validate-build.py`): post-link, validates every YAML symbol has a matching `.cpp.o`, every named build produced its `.wasm` (≥100 KB), and (when `-sEXPORT_EXCEPTION_HANDLING_HELPERS` is set) that the linked JS glue contains `getExceptionMessage` and refcount helpers. Emits `<variant>.build-manifest.json` with symbol diff stats and pass/fail.

**Provenance** (`src/provenance.py`): records toolchain (emsdk, libclang, doxygen) versions, every dep commit, link flags, wasm-opt passes, output hashes. Emits `<variant>.provenance.json` alongside the build manifest.

### F14: Compile-time configuration system

Two channels:

1. **Compile-time** (`build-configs/configurations.json`) — env vars consumed by `build-wasm.sh`/`compileBindings.py`/`compileSources.py`.
2. **Link-time** (`build-configs/<variant>.yml`) — `mainBuild.bindings` (4316 symbols in `full.yml`) + `emccFlags`.

`configurations.json` ships five named configs:

| Name               | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `default`          | Published `@taucad/opencascade.js` build: `-O3` + SIMD + BigInt + EVAL_CTORS=2 + Closure + wasm-opt -O4 + converge |
| `O0-debug`         | No opt, no SIMD, no closure, no ctors eval — for debugging                                                         |
| `O3-wasm-exc-simd` | Same as default but with native WASM exceptions on (used for replicad and Tau runtime)                             |
| `O3-noLTO-simd`    | -O3 without LTO, useful for incremental dev                                                                        |
| `Os-noLTO-simd`    | Size-optimized (-Os)                                                                                               |

Build-flag validation (`src/Common.py` `write_build_flags` / `validate_build_flags`) writes `build/build-flags.json` and invalidates `.o` files when relevant flags change between runs.

### F15: TypeScript declaration injections

The published `.d.ts` is the merged generator output plus three hand-authored sidecars:

| File                                       | Lines | Purpose                                                                                                                                                   |
| ------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/declarations/builtin-bindings.d.ts`   |   113 | Types for `TopoDS` namespace bridge, `OCJS.getStandard_FailureData` / `exceptionsEnabled`, `TColStd_IndexedDataMapOfStringString`, OCCT primitive aliases |
| `src/declarations/emscripten-fs.d.ts`      |   530 | Types for Emscripten `FS` namespace (matches `EXPORTED_RUNTIME_METHODS=["FS"]` in `full.yml`)                                                             |
| `src/declarations/emscripten-runtime.d.ts` |    30 | Types for `HEAP8` / `HEAPU8` / `HEAPF32` / etc. when the runtime exports them                                                                             |

**Conditional injection** (`src/buildFromYaml.py` ~602–690): the `WebAssembly.Exception` / `Tag` ambient block and `getExceptionMessage` / `incrementExceptionRefcount` / `decrementExceptionRefcount` declarations are appended only when `mainBuild.emccFlags` contain both `-fwasm-exceptions` and `-sEXPORT_EXCEPTION_HANDLING_HELPERS`. Non-EH builds emit a clean `.d.ts`.

### F16: Embind smart-pointer specialisation for `opencascade::handle<T>`

`src/ocjs_smart_ptr.h` (34 lines) provides `emscripten::smart_ptr_trait<opencascade::handle<T>>` with intrusive ref-count semantics: how to extract `element_type*`, how to share a raw pointer into a new handle, and how to construct a null handle. Without this specialisation, `Handle<T>` parameters and return values would not marshal correctly through embind's smart-pointer layer.

`src/ocjs_handle_helpers.h` (16 lines) adds `handle_isNull` / `handle_nullify` helpers used by generated bindings.

Both headers replace inline `getReferenceValue` / `updateReferenceValue` C++ template definitions that upstream emitted from Python (`src/generateBindings.py:referenceTypeTemplateDefs`). Centralising them in C++ headers reduces generated `.cpp` weight and consolidates handle semantics.

### F17: Codegen plumbing changes (`Common.py`, `compileBindings.py`, `compileSources.py`, `buildFromYaml.py`)

| File                          |  Baseline |       HEAD | Key delta                                                                                                                                                                                                    |
| ----------------------------- | --------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/Common.py`               |  34 lines |  351 lines | Env-relative roots, PCH builder, flat-include symlink dir, libclang resource-dir resolution (Darwin SDK fallback), `build-flags.json` validator                                                              |
| `src/compileBindings.py`      |  73 lines |  198 lines | Structured failure result, mtime barrier from build-flags, `_is_filtered_binding` skip, output to `build/compiled-bindings/` mirror                                                                          |
| `src/compileSources.py`       | 103 lines |  133 lines | OCCT module-aware via `PACKAGES.cmake`, C vs C++ flag separation (`-std=c17` for `.c`), respects `filterPackages` at module level                                                                            |
| `src/buildFromYaml.py`        | 302 lines |  789 lines | NCollection manifest integration, `BUILTIN_ADDITIONAL_BIND_CODE`, `_replace_undeclared_with_unknown`, `_warn_consistency` for env↔YAML drift, conditional WASM EH `.d.ts` injection, integrates `provenance` |
| `src/applyPatches.py`         |  18 lines |  248 lines | Replaces shell `patch -p0` loop with structured Python patches that index OCCT headers and apply forwarding-method rewrites for embind-incompatible `using Base::Method;` patterns                           |
| `src/wasmGenerator/Common.py` |   (small) | refactored | Suffix-free overload logic, `classDict`-based abstract-class detection, expanded duplicate-typedef ignore list                                                                                               |

A new `src/TuInfo.py` (125 lines) centralises libclang `parse()` and exposes typedef / class / enum walkers used by both the legacy `generateBindings.py` and the new `ocjs_bindgen` package. The `ocjs_bindgen` package is **not** a parallel codegen engine — it is a thin CLI / filter installer / NCollection discovery driver that delegates the actual `.cpp` / `.d.ts` emission to `bindings.py` and `generateBindings.py`.

### F18: npm packaging and `dist/` shape

| Field              | Baseline                             | HEAD                                                                                                                                                      |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `opencascade.js`                     | `@taucad/opencascade.js`                                                                                                                                  |
| `version`          | `2.0.0-beta.b5ff984`                 | `3.0.0-beta.1`                                                                                                                                            |
| `type`             | `module`                             | `module` (already ESM at baseline)                                                                                                                        |
| `main`             | `dist/index.js`                      | `dist/opencascade_full.js`                                                                                                                                |
| `types`            | `dist/index.d.ts`                    | `dist/opencascade_full.d.ts`                                                                                                                              |
| `files`            | (npm default)                        | explicit allowlist: `opencascade_full.{js,wasm,d.ts,symbols}`, `opencascade_full.build-manifest.json`, `opencascade_full.provenance.json`, `CHANGELOG.md` |
| `repository`       | `github:donalffons/...` short string | `git+https://github.com/taucad/...` object                                                                                                                |
| `scripts`          | (none)                               | `test:smoke`, `typecheck`                                                                                                                                 |
| `dependencies`     | (none)                               | `@gltf-transform/core`, `@gltf-transform/functions` (test-time only — for smoke/geometry helpers)                                                         |
| `devDependencies`  | (none)                               | `nx`                                                                                                                                                      |
| `peerDependencies` | `ws`                                 | `ws` (unchanged)                                                                                                                                          |

**`dist/` deletions**: `dist/index.js`, `dist/index.d.ts`, `dist/node.js`, `dist/node.d.ts`, plus their `.gitignore`/`.npmignore`. Upstream's `index.js` was a 35-line ESM facade that imported `./opencascade.full.js`+`.wasm` and exported a default `initOpenCascade({mainJS, mainWasm, worker, libs, module})`. `node.js` patched `__dirname`/`require` for Node-specific WASM path resolution. The fork removes both — consumers `import init from '@taucad/opencascade.js'` and pass their own `locateFile` (see `tests/smoke/helpers.ts:19–23`).

**Important framing**: do **not** describe v3 as "switched to ESM". Upstream was already ESM. Describe it as "removed `dist/index.js` and `dist/node.js` facades; consumers import the generated `opencascade_full.js` directly with their own `locateFile`".

**`.npmignore` philosophy flip**: baseline used a long exclude list (Dockerfile, src/, test/, build/, CHANGELOG); HEAD uses negated whitelist `*` + `!dist/**` + `!CHANGELOG.md` + `!LICENSE` + `!README.md` + `!package.json`. The `files` field in `package.json` is the primary gate; `.npmignore` is a safety net.

### F19: Docker rewrite

| File                    | Baseline                                                                                                                                                                                                                               | HEAD                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`            | `emscripten/emsdk:3.1.14`, apt with npm + many dev libs, pip inline (libclang, pyyaml, cerberus, argparse), `curl` OCCT snapshot, two stages (`test-image`, `custom-build-image`), `ENTRYPOINT` `/opencascade.js/src/buildFromYaml.py` | `emscripten/emsdk:5.0.1` + pinned digest, lean apt, `requirements.txt`, `git clone` rapidjson/freetype/OCCT at fixed SHAs, copies `src` + `build-configs` + `build-wasm.sh` + `scripts` + `DEPS.json` + `bindgen-filters.yaml`, `RUN` applies patches + PCH + `ocjs_bindgen` in image, `ENTRYPOINT` `/opencascade.js/build-wasm.sh`, `CMD ["full", "build-configs/full.yml"]` |
| `Dockerfile.wasm-build` | (NEW)                                                                                                                                                                                                                                  | Lighter alternate image: same emsdk + same dep SHAs, only `applyPatches.py` in build stage, no PCH/bindgen baked in, same entrypoint                                                                                                                                                                                                                                          |

`scripts/docker-e2e-validate.sh` exercises the published Docker image: builds, runs `full build-configs/full.yml` with `OCJS_EXCEPTIONS=1`, verifies `.wasm` / `.js` / `.d.ts` outputs and provenance, then runs a second build for cache timing and a third with `OCJS_OPT=-Os` for size comparison.

### F20: Test suite (76 net-new test files)

Upstream had no in-tree tests. The fork adds:

- **1 harness**: `vitest.config.ts` (Node env, includes `*.test.ts` and `*.test-d.ts`, Vitest `typecheck` enabled, 30 s timeout)
- **1 tsconfig**: `tests/tsconfig.json` (ESM, strict, includes generated `build-configs/*.d.ts`)
- **1 globals**: `tests/globals.d.ts` (`WebAssembly.Exception` / `WebAssembly.Tag` for type tests)
- **1 dts validation**: `tests/dts-validation.test.ts` — 13 assertion categories covering parse diagnostics, no `::` leaks, no bare `<` in types, `any` ratchet ≤148, exception helper presence, ≥95% YAML↔.d.ts symbol coverage, key OCCT class presence, suffix-free overload shape, NCollection alias preference, full TS Program semantic check (TS2304/2552/2416/2300/2693/2694 all = 0), no C primitive spellings (`uint8_t`, `size_t`, `unsigned char`), no orphan files at repo root
- **1 dts docs**: `tests/dts-docs.test.ts` (~1658 lines) — JSDoc coverage thresholds, ≥250 documented enum members, distinct overload docs, `@param` matching, R1–R5 sections, T1–T10 link normalisation, template typedef JSDoc, `delete()` doc coverage ≥90%
- **11 type-level tests** (`tests/*.test-d.ts`):

| File                                 | Asserts                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `types.test-d.ts`                    | `gp_Pnt`/`gp_Vec` returns, `init` returns `Promise<OpenCascadeInstance>`, `Symbol.dispose` |
| `enums.test-d.ts`                    | string-union enums, brand isolation                                                        |
| `class-alias-types.test-d.ts`        | `unknown`/`any` for unbound class-scoped using-aliases                                     |
| `harray-member-types.test-d.ts`      | `NCollection_HArray1_*.Array1` returns matched `NCollection_Array1_*`                      |
| `ncollection-modern.test-d.ts`       | NCollection_Sequence/list types resolve concretely                                         |
| `container-types.test-d.ts`          | STEPCAF/XCAF method containers distinct from element types                                 |
| `ncollection-vector-types.test-d.ts` | `BOPDS_DS` interf methods not `any`                                                        |
| `template-param-types.test-d.ts`     | dependent types / unbound `BVH_Box` resolve to `any`                                       |
| `stl-type-resolution.test-d.ts`      | `RWGltf_CafWriter_Mesh` Vec fields not `any`                                               |
| `output-params.test-d.ts`            | return-by-object structs for stripped output params                                        |
| `enum-dispatch.test-d.ts`            | no old `IntPatch_*` enum-split classes on `OpenCascadeInstance`                            |

- **2 smoke helpers**: `tests/smoke/helpers.ts` (`initOC()` / `getOC()` / `isExceptionsEnabled()`), `tests/smoke/geometry-helpers.ts` (XCAF + `RWGltf_CafWriter` shape→GLB + `@gltf-transform/core` inspection for bbox/vertex/face counts)
- **61 runtime smoke tests** grouped by capability:

| Area                                                 | Files                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives, gp, 2D, general modeling                 | `smoke-2d-geometry`, `smoke-primitives`, `smoke-geometry`, `smoke-helix`, `smoke-expressions`, `smoke-curve-analysis`, `smoke-extrema-distance`, `smoke-precision-standard`, `smoke-adaptors`, `smoke-geom-convert`, `smoke-gc-constructors`, `smoke-transforms`                                                                              |
| Topology, BRep, B-spline/NURBS, advanced/feature     | `smoke-topology`, `smoke-wire-face-building`, `smoke-handles`, `smoke-collections`, `smoke-properties`, `smoke-container-types`, `smoke-bspline-nurbs`, `smoke-fair-curves`, `smoke-advanced-modeling`, `smoke-feature-modeling`, `smoke-intersection`                                                                                        |
| Booleans / fillets / sweeps / healing / HLR          | `smoke-booleans`, `smoke-boolean-options`, `smoke-fillets-chamfers`, `smoke-sweep-loft`, `smoke-law-sweep`, `smoke-shape-healing`, `smoke-shape-upgrade`, `smoke-hlr`                                                                                                                                                                         |
| Data exchange & documents                            | `smoke-gltf`, `smoke-stepcaf-writer`, `smoke-iges`, `smoke-obj`, `smoke-ply`, `smoke-data-exchange`, `smoke-xcaf`, `smoke-document-framework`, `smoke-brep-persistence`, `smoke-interface-xscontrol`                                                                                                                                          |
| Analysis                                             | `smoke-brep-gprop-face`                                                                                                                                                                                                                                                                                                                       |
| Dispatcher / overloads / defaults / output stripping | `smoke-overloads`, `smoke-suffix-free`, `smoke-ambiguous-overloads`, `smoke-brep-tool-overloads`, `smoke-bool-dispatch`, `smoke-enum-dispatch`, `smoke-enum-method-dispatch`, `smoke-static-signature-dispatch`, `smoke-multiarg-dispatch`, `smoke-cstring-dispatch`, `smoke-defaults`, `smoke-output-params`, `smoke-output-param-stripping` |
| Exceptions / smart pointers / value objects / RBV    | `smoke-exceptions`, `smoke-smart-ptr`, `smoke-value-object-independence`, `smoke-rbv-cross-class`, `smoke-safe-cases`                                                                                                                                                                                                                         |
| Enums                                                | `smoke-enums`                                                                                                                                                                                                                                                                                                                                 |

### F21: Documentation expansion

Net-new docs (none existed at baseline beyond a 33-line README):

| File                             | Role                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `BUILD_SYSTEM.md` (root)         | Nx orchestration, two-channel config model (compile-time vs link-time), task graph, `configurations.json` key table     |
| `docs/build-config-reference.md` | Consumer YAML schema (`mainBuild`, `bindings`, `emccFlags`, `additionalCppCode`, `additionalBindCode`)                  |
| `docs/optimization-guide.md`     | Practical tuning reference; named-config table                                                                          |
| `docs/OPTIMIZATION_ANALYSIS.md`  | Pipeline audit of opt flags across compile → link → wasm-opt                                                            |
| `docs/occt-v8-migration.md`      | OCCT V7.6.2 → V8 migration: 10 systemic API changes, exception model, perf/size tables                                  |
| `CHANGELOG.md`                   | v3.0.0 release notes (in scope of this doc to feed)                                                                     |
| `README.md`                      | Expanded from 33 lines (upstream) to 189 lines: install, prebuilt usage, build-from-source, Docker, configuration table |

### F22: Starter template addition

All 6 upstream starter templates kept verbatim (`ocjs-create-next-app-12`, `ocjs-create-nuxt-app`, `ocjs-create-react-app-5`, `ocjs-create-react-app-typescript`, `ocjs-create-react-app-web-worker`, `ocjs-node`). Net-new addition:

- **`starter-templates/ocjs-vite-model-viewer/`** — Vite 6 + TypeScript 5.7 + `@google/model-viewer` 4: builds a filleted box, exports to GLB via `RWGltf_CafWriter`, displays in a `<model-viewer>` element. Demonstrates the modern browser-3D-preview path for OCCT-meshed GLB.

## Removed concepts from upstream

| Concept                                                                               | Removed because                                                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `dist/index.js` + `dist/node.js` ESM facades                                          | Replaced by direct import of generated `dist/opencascade_full.js` with consumer-supplied `locateFile` |
| Multiprocess binding generation (`processChildren` per-CPU batches re-parsing the TU) | Single-pass with shared `TuInfo` is simpler and faster than re-parsing per batch                      |
| Subclass-ladder overload approach (`struct Class_N : public Class`)                   | Replaced by val-based dispatch (F1) — only legitimately disambiguated subclasses remain               |
| Always-on `_N` overload suffixes                                                      | Suffix-free when arity disambiguates (F3)                                                             |
| Inline `getReferenceValue` / `updateReferenceValue` C++ templates emitted from Python | Moved to `ocjs_handle_helpers.h` / `ocjs_smart_ptr.h` (F16)                                           |
| Hardcoded ~400-line filter denylists in `src/filter/*.py`                             | Moved to `bindgen-filters.yaml`, semantic-only Python residue (F7)                                    |
| Shell `patch -p0` loop over `src/patches/*`                                           | Replaced by structured Python patches in `applyPatches.py` (F11)                                      |
| `-fexceptions` JS-based exception scheme                                              | Replaced by `-fwasm-exceptions` + `-sEXPORT_EXCEPTION_HANDLING_HELPERS` (F9)                          |
| `curl` OCCT snapshot tarball in Dockerfile                                            | Replaced by pinned `git clone` from `DEPS.json` SHAs (F13)                                            |
| `argparse` pip dep (vendored in Python 3 stdlib)                                      | Removed from `requirements.txt`                                                                       |
| Minimal TypeScript output (no JSDoc, no `unknown` repair, no cross-ref resolution)    | Full Doxygen→JSDoc + cross-ref + repair pipeline (F5, F6)                                             |

## Drift and inconsistencies to fix

These were uncovered while writing this doc and should be addressed in follow-up commits.

| #   | Drift                                                                                                                                                                                                                                                                                                         | Where                                                                         | Fix                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | `build-wasm.sh --help` references `--config O3-maxperf` (lines 85–86) but `build-configs/configurations.json` has no `O3-maxperf` key                                                                                                                                                                         | `build-wasm.sh:85-86`                                                         | Replace example with `default` or `O3-wasm-exc-simd`                                                                                                   |
| D2  | `Dockerfile` clones OCCT at SHA `48ebca0f70a5e4b936548b695bc3583363898da4` but `DEPS.json` pins `0ebbbedb239d6fffb7e1c8c2d36970a3ab1d9300`                                                                                                                                                                    | `Dockerfile:49-52` vs `DEPS.json`                                             | Source SHA from `DEPS.json` in `Dockerfile` (jq parse during build) or update one to match                                                             |
| D3  | `patch_stepcaf_noexcept.py` is now superseded by `patch_noexcept_destructors.py` (which includes `STEPCAFControl_ActorWrite`); both still applied (idempotent via sentinel, but the standalone is dead)                                                                                                       | `src/patches/`                                                                | Delete `patch_stepcaf_noexcept.py`                                                                                                                     |
| D4  | `src/ocjs_bindgen/test_discover.py` uses `from discover import …` which only works with `PYTHONPATH` set to `src/ocjs_bindgen/`; fragile if anyone runs `pytest` from the repo root                                                                                                                           | `src/ocjs_bindgen/test_discover.py`                                           | Switch to `from .discover import` (relative import)                                                                                                    |
| D5  | `scripts/enumerate-symbols.py` emits an `additionalBindCode` template into `full.yml` but the committed `full.yml` does not contain that block; the builtin embind code lives in `BUILTIN_ADDITIONAL_BIND_CODE` (Python) instead                                                                              | `scripts/enumerate-symbols.py:240-305` vs `build-configs/full.yml`            | Either remove the template emission from the generator or commit the rendered block — currently the generator output diverges from the checked-in file |
| D6  | Documentation in `docs/occt-v8-migration.md` and `docs/build-config-reference.md` describes `TopoDS_Cast`, `OCJS_ShapeHasher`, `BRepMesh_IncrementalMeshWrapper`, `BRepToolsWrapper`, `GeomToolsWrapper` as if they ship; only the `TopoDS` namespace bridge actually ships in `BUILTIN_ADDITIONAL_BIND_CODE` | `docs/occt-v8-migration.md`, `docs/build-config-reference.md`, `CHANGELOG.md` | Reframe the other four as "consumer pattern" examples, or implement them in the builtin block                                                          |
| D7  | `build-native.sh` is named misleadingly — it still requires emsdk and produces a WASM build via the legacy linear pipeline; it does not produce a host-native non-Emscripten build                                                                                                                            | `build-native.sh`                                                             | Rename to `build-wasm-legacy.sh` or document its actual purpose at the top                                                                             |
| D8  | `run-build.sh` hardcodes a developer-machine path to `assimpjs/emsdk`                                                                                                                                                                                                                                         | `run-build.sh:1-17`                                                           | Either delete or move to `scripts/dev/` with a comment that it is per-developer                                                                        |
| D9  | `tests/smoke/helpers.ts` loads `build-configs/opencascade_full.{js,wasm}` from the repo's `build-configs/` directory rather than `dist/`; smoke tests will fail if a consumer runs them against a published install                                                                                           | `tests/smoke/helpers.ts:19-23`                                                | Document that smoke tests are repo-internal and not part of the published surface                                                                      |
| D10 | `starter-templates/ocjs-vite-model-viewer/src/main.ts` uses `_3` / `TopExp_Explorer_2` style names that pre-date the suffix-free overload work (F3)                                                                                                                                                           | `starter-templates/ocjs-vite-model-viewer/src/main.ts`                        | Rewrite to use suffix-free names                                                                                                                       |

## Reference for changelog and README

This section is the authoritative source for the consumer-facing v3 narrative. When we update `CHANGELOG.md` or `README.md`, items here should be the menu of headlines and the tone of framing.

### Headlines (correct framing)

| Headline                                       | Correct framing                                                                                                                                                                                                                                      | Common mistakes to avoid                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native WASM exceptions**                     | "Switched from `-fexceptions` (JS) to `-fwasm-exceptions` (native), with typed `WebAssembly.Exception` / `getExceptionMessage` / refcount helpers in the published `.d.ts`"                                                                          | Don't omit the `.d.ts` injection — it's the consumer-visible part                                                                                                   |
| **Baseline SIMD enabled**                      | "Added baseline `-msimd128` (Safari-compatible)"                                                                                                                                                                                                     | Don't say "dropped relaxed-SIMD" — upstream had no SIMD; relaxed-SIMD was an experimental opt-in that didn't ship at HEAD                                           |
| **OCCT V8.0.0 RC5**                            | "Upgraded OCCT V7.6.2 → V8.0.0 RC5; built-in `TopoDS` namespace bridge handles the V8 binding break; `Bnd_Box::Get`, `Poly_PolygonOnTriangulation::Nodes`, `BRepMesh_IncrementalMesh` constructor changes documented in `docs/occt-v8-migration.md`" | Don't claim `TopoDS_Cast`, `OCJS_ShapeHasher`, `BRepMesh_IncrementalMeshWrapper`, `BRepToolsWrapper`, `GeomToolsWrapper` ship — they are consumer patterns          |
| **Suffix-free overloads**                      | "Removed `_N` suffixes when arity disambiguates; `gp_Pnt.X()` is `X()` not `X_1()`, `BRepPrimAPI_MakeBox(...)` is one constructor not five subclasses"                                                                                               | Always paired with F1 (val-dispatch) and F8 (embind patch)                                                                                                          |
| **Output-parameter stripping**                 | "Methods that took `T&` output references now return a `value_object` struct combining the return value and stripped outputs; callers no longer pass placeholder `{current: 0}` args"                                                                |                                                                                                                                                                     |
| **NCollection auto-discovery**                 | "libclang two-pass discovery emits `using` declarations for every `NCollection_*<...>` actually used in bound APIs; `Handle<T>` typedefs are auto-discovered too"                                                                                    | Don't say "removed need for `additionalCppCode`" — `additionalCppCode` is still the escape hatch for custom code; it's only typedef boilerplate that's auto-handled |
| **Full JSDoc on `.d.ts`**                      | "Doxygen → JSDoc pipeline produces inline docs on classes, methods, constructors, enums, and overloads with R1–R5 markdown formatting and T1–T10 link normalisation"                                                                                 |                                                                                                                                                                     |
| **Reproducible builds**                        | "Pinned via `DEPS.json` (OCCT, rapidjson, freetype, emsdk, doxygen) with strict-mode SHA validation; Nx task graph caches every stage; provenance + build-manifest sidecars ship alongside the WASM"                                                 |                                                                                                                                                                     |
| **Embind same-arity overload patch**           | "Patches stock Emscripten `libembind.js` to dispatch overloads by argument signature, not just count"                                                                                                                                                | This is the prerequisite for F1                                                                                                                                     |
| **Test suite**                                 | "76 net-new test files: `dts-validation` (13 assertion categories), `dts-docs` (coverage thresholds + R1–R5 + T1–T10 rules), 11 type-level tests, 61 runtime smoke tests across all OCCT capability areas"                                           |                                                                                                                                                                     |
| **Removed `dist/index.js` and `dist/node.js`** | "Consumers import the generated `opencascade_full.js` directly with their own `locateFile`; the upstream `initOpenCascade({mainJS, mainWasm, worker, libs, module})` shim is gone"                                                                   | Don't say "switched to ESM" — upstream was already ESM                                                                                                              |
| **Renamed to `@taucad/opencascade.js`**        | Scoped npm name; v2.0.0-beta → v3.0.0-beta.1                                                                                                                                                                                                         |                                                                                                                                                                     |
| **WASM size reductions**                       | "OCCT source patches (`patch_noexcept_destructors`, `patch_standard_dump`, `patch_stepcaf_dyntype`) plus `EVAL_CTORS=2`, `WASM_BIGINT`, wasm-opt -O4, and Closure"                                                                                   | Cite the per-patch savings from the script docstrings, don't invent numbers                                                                                         |

### Items to drop from current changelog

The current `CHANGELOG.md` `v3.0.0` entry should drop or reframe:

- "relaxed-SIMD dropped from default" → reframe as "added baseline `-msimd128`"
- "switched to ESM" → reframe as "removed `dist/index.js` and `dist/node.js` shims"
- Any claim that `TopoDS_Cast`, `OCJS_ShapeHasher`, `BRepMesh_IncrementalMeshWrapper`, `BRepToolsWrapper`, `GeomToolsWrapper` ship as classes → reframe as "documented consumer patterns" or implement them
- Any reference to `--preset` in active instructions (already done in the recent doc pass, kept here as reminder)
- Any reference to non-existent config names like `O3-maxperf`, `O2-balanced`, `Os-minsize` (already done, kept as reminder)

### Items missing from current changelog (to add)

- Embind overload patch (F8) — the structural prerequisite for val-dispatch
- NCollection auto-discovery (F4) — the mechanism, not just the result
- TypeScript `unknown` repair pass (F5) — the cross-reference resolution that kills TS2304s
- `dts-docs.test.ts` R1–R5 / T1–T10 rules (F6) — the JSDoc quality contract
- `BUILTIN_ADDITIONAL_BIND_CODE` block (F9 / F10) — `OCJS.getStandard_FailureData` is the entry point consumers use to decode `Standard_Failure`
- Smart-pointer specialisation `ocjs_smart_ptr.h` (F16) — without it, `Handle<T>` parameters don't marshal
- Provenance sidecar (`<variant>.provenance.json`) shipped in npm package (F13)
- Nx task graph (F13) — the caching story is a developer-experience headline
- `bindgen-filters.yaml` config-driven exclusions with `extends:` chain (F7)
- 61 runtime smoke + 11 type-level + `dts-validation` + `dts-docs` test count (F20)

## Diagrams

### Codegen pipeline (current state)

```
                   bindgen-filters.yaml (+ .extends chain)
                              ↓
                   ocjs_bindgen.filters.install()
                              ↓
                   TuInfo("") ─── 1st pass: parse OCCT headers ───→ NCollection discovery
                                                                          ↓
                                                              build/ncollection-manifest.json
                                                                          ↓
                                                              generate `using <Mangled> = ...;`
                                                                          ↓
                   TuInfo(using_decls) ─── 2nd pass with aliases prepended ───→ classDict / typedefs / multimaps
                              ↓
                   bindings.py (per class)
                     ├── _classify_js_dispatch_type → _build_dispatch_tree → _emitValDispatchConstructor / _emitValDispatchMethod
                     ├── shouldStripParam → _ensureResultStruct → _emitOutputParamBinding
                     ├── processEnum → enum_value_type::string
                     ├── nested fields → value_object
                     └── TypescriptBindings → _docs (JSDoc) + _known_export_names
                              ↓
                   buildFromYaml.py
                     ├── BUILTIN_ADDITIONAL_BIND_CODE (TopoDS / OCJS / TColStd map)
                     ├── _replace_undeclared_with_unknown (TS post-process)
                     ├── conditional WASM EH .d.ts injection
                     └── provenance.py (link stats, hashes)
                              ↓
                   compile-bindings → compile-sources (OCCT CMake) → link → validate → provenance
                              ↓
                   dist/opencascade_full.{js,wasm,d.ts,symbols,build-manifest.json,provenance.json}
```

### Nx task graph (current state)

```
setup ──→ apply-patches ──→ pch ──→ generate ──→ compile-bindings ──→ link ──→ validate ──→ build
                                ↓                                       ↑          ↘
                                ↓                                       ↑           provenance
                        compile-sources ─────────────────────────────────
                                ↑
                        apply-patches
```

## Appendix: full file inventory

### Added (129)

```
BUILD_SYSTEM.md
DEPS.json
Dockerfile.wasm-build
bindgen-filters-no-deprecated.yaml
bindgen-filters.yaml
build-configs/configurations.json
build-configs/full.yml
build-native.sh
build-wasm.sh
docs/OPTIMIZATION_ANALYSIS.md
docs/build-config-reference.md
docs/occt-v8-migration.md
docs/optimization-guide.md
nx.json
project.json
requirements.txt
run-build.sh
scripts/clone-deps.sh
scripts/docker-e2e-validate.sh
scripts/enumerate-symbols.py
scripts/setup-deps.sh
scripts/validate-build.py
src/TuInfo.py
src/declarations/builtin-bindings.d.ts
src/declarations/emscripten-fs.d.ts
src/declarations/emscripten-runtime.d.ts
src/extract-docs.py
src/occt-docs.doxyfile
src/ocjs_bindgen/__init__.py
src/ocjs_bindgen/__main__.py
src/ocjs_bindgen/config.py
src/ocjs_bindgen/discover.py
src/ocjs_bindgen/filters.py
src/ocjs_bindgen/test_discover.py
src/ocjs_handle_helpers.h
src/ocjs_smart_ptr.h
src/patches/libembind-overloading.patch
src/patches/patch_brepgraph_versionstamp.py
src/patches/patch_noexcept_destructors.py
src/patches/patch_standard_dump.py
src/patches/patch_stepcaf_dyntype.py
src/patches/patch_stepcaf_noexcept.py
src/provenance.py
starter-templates/ocjs-vite-model-viewer/{index.html, package.json, package-lock.json, src/main.ts, src/shape-to-url.ts, tsconfig.json, vite.config.ts}
tests/{vitest.config.ts (root), tsconfig.json, globals.d.ts, types.test-d.ts, dts-validation.test.ts, dts-docs.test.ts}
tests/{class-alias-types, container-types, enum-dispatch, enums, harray-member-types, ncollection-modern, ncollection-vector-types, output-params, stl-type-resolution, template-param-types}.test-d.ts
tests/smoke/{helpers.ts, geometry-helpers.ts}
tests/smoke/smoke-{2d-geometry, adaptors, advanced-modeling, ambiguous-overloads, bool-dispatch, boolean-options, booleans, brep-gprop-face, brep-persistence, brep-tool-overloads, bspline-nurbs, collections, container-types, cstring-dispatch, curve-analysis, data-exchange, defaults, document-framework, enum-dispatch, enum-method-dispatch, enums, exceptions, expressions, extrema-distance, fair-curves, feature-modeling, fillets-chamfers, gc-constructors, geom-convert, geometry, gltf, handles, helix, hlr, iges, interface-xscontrol, intersection, law-sweep, multiarg-dispatch, obj, output-param-stripping, output-params, overloads, ply, precision-standard, primitives, properties, rbv-cross-class, safe-cases, shape-healing, shape-upgrade, smart-ptr, static-signature-dispatch, stepcaf-writer, suffix-free, sweep-loft, topology, transforms, value-object-independence, wire-face-building, xcaf}.test.ts
vitest.config.ts
```

### Modified (21)

```
.gitignore
.npmignore
Dockerfile
README.md
package.json
package-lock.json
src/Common.py
src/applyPatches.py
src/bindings.py
src/buildFromYaml.py
src/compileBindings.py
src/compileSources.py
src/customBuildSchema.py
src/filter/filterClasses.py
src/filter/filterIncludeFiles.py
src/filter/filterMethodOrProperties.py
src/filter/filterPackages.py
src/filter/filterSourceFiles.py
src/filter/filterTypedefs.py
src/generateBindings.py
src/wasmGenerator/Common.py
```

### Deleted (6)

```
dist/.gitignore
dist/.npmignore
dist/index.d.ts
dist/index.js
dist/node.d.ts
dist/node.js
```
