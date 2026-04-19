---
title: 'OCJS Test Failure Resolution'
description: 'Root cause analysis and resolution of 51 test failures and 11 type errors in opencascade.js after NCollection auto-discovery migration'
status: active
created: '2026-03-26'
updated: '2026-03-26'
category: investigation
related:
  - docs/research/ocjs-embind-js-dispatch-failures.md
---

# OCJS Test Failure Resolution

Investigation and resolution of 51 test failures and 11 unhandled type errors in the opencascade.js WASM build system following the NCollection auto-discovery and `_SAFE_DEPRECATED_PREFIXES` removal migration.

## Executive Summary

After migrating NCollection template instantiations to auto-generated `using` declarations and removing `_SAFE_DEPRECATED_PREFIXES`, the test suite exhibited 49 runtime failures, 2 type-level test failures, and 11 unhandled TypeScript errors. Three independent root causes were identified and resolved: (1) Nx cache directory conflicts between generate and compile tasks, (2) stale deprecated typedef names in JSDoc tests, and (3) TypeScript overload ambiguity between `char` and `const char*` in Embind's type classification system.

## Problem Statement

Following the NCollection auto-discovery migration, running `npx vitest run` in `repos/opencascade.js` produced:

- **49 runtime test failures**: `TypeError: X is not a constructor` for classes like `TDocStd_Document`, `STEPControl_Writer`, `STEPControl_Reader`, `IGESControl_Writer`
- **2 type-level test failures**: `dts-docs.test.ts` referencing deprecated NCollection typedef names (`TopTools_Array1OfShape`, `TColStd_Array1OfReal`, etc.)
- **11 unhandled type errors**: `TypeCheckError: No overload matches this call` for `TCollection_AsciiString` string constructors

## Methodology

- Timestamp analysis (`stat`) to correlate Nx cache restoration with file disappearance
- File inventory (`find`, `wc`) to count `.cpp.o` vs `.cpp` files and identify gaps
- Direct Python script invocation to isolate Nx caching from build logic
- Clang AST type classification tracing through `bindings.py` dispatch tree code
- Incremental test runs to validate each fix independently

## Findings

### Finding 1: Nx Cache Directory Conflict (49 Runtime Failures)

The `generate` Nx task declared `{projectRoot}/build/bindings/` as its output. The `compile-bindings` task produced `.cpp.o` object files in the same `build/bindings/` directory. When Nx restored the `generate` task from cache, it replaced the entire `build/bindings/` directory, wiping all `.cpp.o` files produced by `compile-bindings`.

Evidence: 4329 of 4334 bindings compiled successfully, but only 3728 `.cpp.o` files existed on disk after a cached `generate` restore. The 601 missing `.cpp.o` files included critical symbols like `TDocStd_Document`, `STEPControl_Writer`, and `BRepPrimAPI_MakeBox`.

**Root cause**: Co-location of generated source files (`.cpp`, `.d.ts.json`) and compiled object files (`.cpp.o`) in the same Nx-managed output directory.

### Finding 2: Deprecated Typedef Names in JSDoc Tests (2 Type Failures)

The `dts-docs.test.ts` suite contained hardcoded references to deprecated NCollection typedef names that were removed during the `_SAFE_DEPRECATED_PREFIXES` elimination:

| Deprecated Name           | Modern Replacement                |
| ------------------------- | --------------------------------- |
| `TopTools_Array1OfShape`  | `NCollection_Array1_TopoDS_Shape` |
| `TopTools_ListOfShape`    | `NCollection_List_TopoDS_Shape`   |
| `TColStd_Array1OfReal`    | `NCollection_Array1_double`       |
| `TColStd_Array1OfInteger` | `NCollection_Array1_int`          |
| `TColgp_Array1OfPnt`      | `NCollection_Array1_gp_Pnt`       |

### Finding 3: TypeScript Overload Ambiguity for char vs const char\* (11 Type Errors)

In `bindings.py`, `_classify_js_type` mapped both `char` (Standard_Character) and `const char*` (Standard_CString) to `JsType('string', 'string')`. Since they shared the same JS type category, the dispatch tree considered them ambiguous at every arity. Both were deferred to `_N` subclasses, leaving no `constructor(theMessage: string)` on the base class.

At runtime, Embind's val-dispatch handled both correctly (tests passed). But TypeScript rejected `new oc.TCollection_AsciiString('hello')` because the base class lacked a single-`string` constructor overload.

Critical constraint: the C++ Embind codegen and TypeScript type codegen share the same `_build_dispatch_tree` method in the `Bindings` base class. Modifying `_classify_js_type` in the base class affected both sides. Since `char` and `const char*` are indistinguishable at JavaScript runtime (`typeof` returns `"string"` for both), the C++ dispatch codegen cannot produce correct branches for a `string_char` category — it would generate duplicate `typeof === "string"` checks with dead code.

## Resolutions

### Resolution 1: Separate Output Directories

Moved compiled object files to a dedicated `build/compiled-bindings/` directory, mirroring the subdirectory structure of `build/bindings/`.

```
build/bindings/          ← generate task output (source files)
  ├── pkg/Class.cpp
  └── pkg/Class.d.ts.json

build/compiled-bindings/ ← compile-bindings task output (object files)
  ├── pkg/Class.cpp.o
  └── binding-report.json
```

Files changed:

| File                     | Change                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `src/compileBindings.py` | Added `COMPILED_BINDINGS_DIR`, `_cpp_to_object_path()` helper         |
| `src/buildFromYaml.py`   | `_collect_compiled_symbols` and `runBuild` walk `compiled-bindings/`  |
| `project.json`           | `compile-bindings.outputs` → `{projectRoot}/build/compiled-bindings/` |
| `build-wasm.sh`          | `clean-objects` targets `compiled-bindings/` with legacy fallback     |

### Resolution 2: Modernized Test Assertions

Updated `tests/dts-docs.test.ts` to reference modern NCollection names. The JSDoc fallback mechanism correctly inherits documentation from `NCollection_Array1` base template to the auto-generated instantiation classes.

### Resolution 3: TypeScript-Only Type Override

Instead of modifying `_classify_js_type` in the shared `Bindings` base class (which broke C++ codegen), overrode `_classify_js_type` in `TypescriptBindings` only:

```python
class TypescriptBindings(Bindings):
    def _classify_js_type(self, clang_type, templateDecl=None, templateArgs=None):
        result = super()._classify_js_type(clang_type, templateDecl, templateArgs)
        if result.category == 'string' and not isCString(clang_type):
            t = self._strip_type_qualifiers(clang_type)
            kind = t.get_canonical().kind
            if kind in self._JS_CHAR_KINDS:
                return JsType('string_char', 'string')
        return result
```

This distinguishes bare `char` (`string_char`) from `const char*` (`string`) only for TypeScript overload resolution. The C++ dispatch tree continues to treat both as `string`, preserving correct runtime behavior.

Result: `const char*` constructors appear on the base class as `constructor(theMessage: string)`, while bare `char` constructors remain as `_N` subclasses.

## Verification

After applying all three resolutions:

- **77 test files passed** (was: 51 failing)
- **448 tests passed** (was: 397 passing)
- **0 type errors** (was: 11 unhandled)
- **4329/4334 bindings compiled** (5 expected failures, unchanged)

## Recommendations

| #   | Action                                                         | Priority | Effort | Impact |
| --- | -------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Keep `compiled-bindings/` separation permanent                 | P0       | Done   | High   |
| R2  | Add CI assertion that `compiled-bindings/` count ≥ `bindings/` | P1       | Low    | Medium |
| R3  | Consider extracting `_classify_ts_type` as a formal API        | P2       | Medium | Low    |
