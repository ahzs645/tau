---
title: 'OpenCascade.js Type Resolution Failures'
description: 'Audit of all any-typed parameters and returns in the generated opencascade_full.d.ts, root causes, and remediation approaches'
status: active
created: '2026-03-26'
updated: '2026-03-26'
category: audit
related:
  - docs/research/ocjs-embind-js-dispatch-failures.md
  - docs/research/occt-v8-migration.md
---

# OpenCascade.js Type Resolution Failures

Systematic audit of all type resolution failures in the opencascade.js binding generator that produce `any` types in the generated TypeScript declarations.

## Executive Summary

The generated `opencascade_full.d.ts` originally contained 2,950 `any`-typed occurrences. After implementing recommendations R1–R7 using a **generic C++ type resolution** approach (no OCCT-specific hardcoding), the count dropped to **1,449** — a 51% reduction.

### Architectural Change

The original binding generator used hardcoded container sets (`SINGLE_ARG_CONTAINERS`) and OCCT-specific multi-arg container checks. The revised approach replaces these with a generic resolution pipeline:

1. **`TYPE_ALIAS_DECL` collection** — `TuInfo.py` now collects C++11 `using` aliases alongside traditional `typedef` declarations
2. **`_known_typedef_names` global set** — all typedef/using-alias names are available for resolution regardless of per-class export context
3. **Generic typedef lookup** — `_find_typedef_for_container` resolves ALL template types via the typedef dictionary, not just recognized containers
4. **STL type mappings** — `std::pair`, `std::optional`, `std::array`, `std::shared_ptr`, `std::string_view`, `std::initializer_list` map to TypeScript equivalents
5. **Nested struct auto-binding** — POD structs inside classes are bound as `value_object` with auto-generated `export interface` declarations
6. **Word-boundary const stripping** — prevents false matches like `Standard_ConstructionError` → `Standard_StructionError`

### Remaining `any` Types (1,449)

| Category                    | Count     | Status                                                                      |
| --------------------------- | --------- | --------------------------------------------------------------------------- |
| Unrecognized template types | 1,400     | Remaining — mostly `NCollection_H*` types and unsubstituted template params |
| Final fallback failures     | 49        | Remaining — nested typedefs, system types                                   |
| **Total**                   | **1,449** | Regression threshold set to 1,449                                           |

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Unrecognized Template Types (1,531 → 1,400)](#finding-1-unrecognized-template-types-1531-occurrences)
  - [Finding 2: Nested Types Not Exported (218 → 0)](#finding-2-nested-types-not-exported-218-occurrences)
  - [Finding 3: Multi-Arg Containers (184 → absorbed)](#finding-3-multi-arg-containers-184-occurrences)
  - [Finding 4: Final Fallback Failures (37 → 49)](#finding-4-final-fallback-failures-37-occurrences)
  - [Finding 5: Wrapper Method Suffix Mismatch (RESOLVED)](#finding-5-wrapper-method-suffix-mismatch)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Appendix A: Unrecognized Template Types Inventory](#appendix-a-unrecognized-template-types-inventory)
- [Appendix B: Nested Types Inventory](#appendix-b-nested-types-inventory)
- [Appendix C: Multi-Arg Container Types Inventory](#appendix-c-multi-arg-container-types-inventory)

## Problem Statement

The `dts-validation.test.ts` regression test tracks `any`-type count in the generated `.d.ts` file. The count regressed from ~1,900 to 2,950 after initial container type fixes. After implementing R1–R7, the count is now **1,449** with the regression threshold set accordingly.

The `any` types degrade TypeScript DX: parameters become untyped, return values lose their shape, and consumers cannot rely on type checking for OCCT API calls. The `Transfer` method suffix mismatch (Finding 5) has been **resolved** — all 6 Transfer overloads on `STEPCAFControl_Writer` are now unsuffixed in both embind and the `.d.ts`.

## Methodology

1. **Generator instrumentation**: Added `_collect_any(reason, type_spelling)` to all six `return "any"` paths in `bindings.py`'s `resolve_type`, `_resolve_template_type`, and related methods. Each call records the failure reason and the C++ type spelling.

2. **Build-time reporting**: Modified `ocjs_bindgen/__main__.py` to dump a structured `build/any-type-report.json` after generation, containing per-reason type inventories with occurrence counts.

3. **d.ts analysis**: Parsed the final `opencascade_full.d.ts` using regex to count all `:\s*any\b` matches (matching the `countAnyTypes` function in `dts-validation.test.ts`).

4. **OCCT source cross-reference**: Traced C++ type spellings to their OCCT 8.0 header declarations to identify the underlying types and determine resolution strategies.

5. **Embind cross-reference**: Compared generated C++ embind registrations against TypeScript declarations to identify naming mismatches.

## Findings

### Finding 1: Unrecognized Template Types (1,531 → 1,400)

The largest category. `_resolve_template_type` encounters a C++ template specialization that can't be resolved via any known path.

**Status: PARTIALLY RESOLVED** — R1 (using-alias resolution), R2 (container set extension), and the architectural restructuring eliminated `math_Vector` (842 → 0), `NCollection_Array2/HArray2` (294 → 0), and many other types. The remaining 1,400 are:

| Sub-category                                                                              | Occurrences | Status                                                                |
| ----------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `NCollection_HSequence<T>` / `NCollection_HArray1<T>` (handle-wrapped)                    | ~600        | Remaining — typedef lookup can't match all H-container instantiations |
| Template type parameters (`Array1Type`, `SequenceType`, `const Array1Type`)               | ~211        | Remaining — unsubstituted params, inherently unresolvable (R8)        |
| `NCollection_Map<T>` / `NCollection_DataMap<K,V,H>` / `NCollection_IndexedDataMap<K,V,H>` | ~300        | Remaining — multi-arg containers with no matching typedef             |
| `XSAlgo_ShapeProcessor::ParameterMap` / `ShapeProcess::OperationsFlags`                   | ~34         | Remaining — nested type aliases                                       |
| `IMeshData::IFaceHandle` / `IMeshData::IEdgeHandle`                                       | ~29         | Remaining — namespace-qualified typedef aliases                       |
| Other NCollection types                                                                   | ~226        | Various                                                               |

**Resolved sub-categories:**

- `math_Vector` / `math_VectorBase<double>` (842 → 0): `_known_typedef_names` + `TYPE_ALIAS_DECL` collection in `TuInfo.py`
- `math_IntegerVector` / `math_VectorBase<int>` (11 → 0): Same fix
- `NCollection_Array2<T>` / `NCollection_HArray2<T>` (294 → 0): Generic typedef lookup replaces hardcoded container sets
- `NCollection_Vector<T>` (15 → 0): Same fix
- `std::initializer_list<T>` (22 → 0): R7 STL mapping
- `std::pair<T,U>` / `std::optional<T>` / `std::array<T,N>` (22 → 0): R7 STL mapping
- `IntPolyh_Array*` (11 → 0): Configuration fix

**Root cause — Remaining `NCollection_H*` types:**

Types like `NCollection_HSequence<occ::handle<Standard_Transient>>` don't have simple deprecated typedefs. While some H-container types DO have typedefs (e.g., `TColStd_HSequenceOfTransient`), the typedef dictionary matching fails when the Clang spelling uses inconsistent qualification (e.g., `occ::handle<Standard_Transient>` vs `opencascade::handle<Standard_Transient>`).

**Root cause — Template type parameters:**

Types like `Array1Type`, `SequenceType`, `TheItemType` are unsubstituted template parameters from template class definitions. They appear when the binding generator processes template member functions before template instantiation. These are inherently unresolvable without instantiation context (R8).

### Finding 2: Nested Types Not Exported (218 → 0) ✓ RESOLVED

**Status: RESOLVED** — R3 implementation auto-discovers and binds nested POD structs via Clang AST iteration during `processClass`. Public `STRUCT_DECL` children are emitted as `emscripten::value_object` on the embind side and `export interface` on the TypeScript side. The `self.exports` check was removed — nested type names are trusted to exist in the final concatenated `.d.ts`.

The `resolve_type` method no longer checks `if nested in self.exports` because each `TypescriptBindings` instance only sees its own class's exports. Since the nested struct IS declared (just in a different fragment), the name is used directly.

### Finding 3: Multi-Arg Containers (184 → absorbed into Finding 1)

**Status: PARTIALLY RESOLVED** — The hardcoded multi-arg container check was removed. Multi-arg containers now flow through the same generic typedef lookup. Those with matching typedefs resolve correctly; the rest are counted as `unrecognized_template` in Finding 1.

### Finding 4: Final Fallback Failures (37 → 49)

Types that exhaust all resolution strategies and hit the terminal `return "any"`.

**Status: PARTIALLY RESOLVED** — R6 (word-boundary const stripping) fixed the `Point` → `gp_XY`/`gp_XYZ` resolution failures. The count increased to 49 due to newly discovered nested typedef patterns from the broader template type resolution.

| Type                                                            | Occurrences | Status                                                     |
| --------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `Geom_EvalRepSurfaceDesc::Base`                                 | 15          | Remaining — template member typedef in EvalRep descriptors |
| `Geom_EvalRepCurveDesc::Base` / `Geom2d_EvalRepCurveDesc::Base` | 18          | Remaining — same pattern                                   |
| `Point` (canonical: `gp_XY`/`gp_XYZ`)                           | 12          | RESOLVED by R6 const stripping                             |
| `std::type_info`                                                | 1           | Remaining — system type                                    |
| `clocale_t`                                                     | 1           | Remaining — system type                                    |
| `IMeshData::IFacePtr` / `IMeshData::IEdgePtr`                   | 2           | Remaining — pointer typedef                                |

### Finding 5: Wrapper Method Suffix Mismatch ✓ RESOLVED

**Status: RESOLVED** — R5 removed `isCString` from `_ts_method_has_wrapper_args` in the TypeScript method processing path. The dispatch tree now correctly classifies `const char*` methods as dispatchable. For `STEPCAFControl_Writer.Transfer`, the dispatch tree identifies all 6 overloads as distinguishable (different first-arg types: `TDocStd_Document` vs `TDF_Label` vs `TDF_LabelSequence`), emitting them as unsuffixed `Transfer(...)` overloads.

**Verification**: The generated `.d.ts` now declares 6 unsuffixed `Transfer(...)` overloads. The `container-types.test-d.ts` type-level test and `smoke-stepcaf-writer.test.ts` runtime test both pass without `@ts-expect-error`.

**Note on constructors**: The R5 fix only applies to the METHOD processing path (`processMethodGroup`). Constructor processing has a separate code path that was not modified. Constructors with `const char*` parameters that are ambiguous with `char` (single character) constructors at the dispatch level still require `_N` subclasses (e.g., `TCollection_AsciiString_3`). This is a correct architectural behavior — `const char*` and `char` are both `string` in TypeScript and genuinely JS-indistinguishable.

## Recommendations

| #   | Action                                                     | Status                                         | Impact                |
| --- | ---------------------------------------------------------- | ---------------------------------------------- | --------------------- |
| R1  | Resolve `using` aliases via generic typedef lookup         | ✓ RESOLVED                                     | -842 `any` → 0        |
| R2  | Extend container resolution (replaced with generic lookup) | ✓ RESOLVED                                     | -309 `any` → 0        |
| R3  | Auto-bind nested POD structs via Clang AST                 | ✓ RESOLVED                                     | -218 `any` → 0        |
| R4  | Multi-arg container typedef resolution                     | ✓ RESOLVED (absorbed into R1/R2 restructuring) | Partial               |
| R5  | Fix `const char*` wrapper method suffix in `.d.ts`         | ✓ RESOLVED                                     | Correctness fix       |
| R6  | Word-boundary const stripping in canonical fallback        | ✓ RESOLVED                                     | -12 `any`             |
| R7  | Map STL types to TypeScript equivalents                    | ✓ RESOLVED                                     | -29 `any`             |
| R8  | Skip unsubstituted template parameters                     | Remaining                                      | ~211 `any` (cosmetic) |

### R1/R2: Generic Template Type Resolution ✓ RESOLVED

**What was done**: Replaced the hardcoded `SINGLE_ARG_CONTAINERS` set and OCCT-specific multi-arg container checks with a generic resolution pipeline:

1. Extended `TuInfo.py` to collect `CursorKind.TYPE_ALIAS_DECL` (C++11 `using` aliases) in both `typedefGenerator` and `templateTypedefGenerator`
2. Introduced `_known_typedef_names` — a global set of all typedef/using-alias names, populated once from `tuInfo.typedefs` and `tuInfo.templateTypedefs`
3. Restructured `_resolve_template_type` to check `orig_decl.spelling` against `_known_typedef_names` before canonicalization
4. Made `_find_typedef_for_container` the universal fallback for ALL template types (not just recognized containers)
5. Enhanced `_find_typedef_for_container` to reconstruct template spellings from stripped versions (e.g., `math_VectorBase<>` → `math_VectorBase<double>`)

**Key architectural decision**: The `self.exports` check was removed from typedef resolution because each `TypescriptBindings` instance only contains exports for its own class fragment. Typedef names are trusted globally since they'll all exist in the final concatenated `.d.ts`.

### R3: Nested Struct Auto-Binding ✓ RESOLVED

**What was done**: In `processClass` for both `EmbindBindings` and `TypescriptBindings`, added Clang AST iteration to discover public `STRUCT_DECL` children:

- **Embind**: Emits `emscripten::value_object<Parent::Child>("Parent_Child")` with `.field()` for each public member
- **TypeScript**: Emits `export interface Parent_Child { ... }` and adds the name to `self.exports`
- **resolve_type**: The `if nested in self.exports` guard was removed (same cross-fragment context issue as R1)

### R4: Multi-Arg Container Resolution ✓ RESOLVED (partial)

Absorbed into the R1/R2 restructuring. The hardcoded `NCollection_DataMap`/`NCollection_IndexedDataMap` paths were removed. Multi-arg containers now flow through the generic `_find_typedef_for_container` lookup. Those with matching deprecated typedefs resolve; others fall through to `unrecognized_template`.

### R5: Wrapper Method Suffix Fix ✓ RESOLVED

**What was done**: Removed `isCString(m_arg.type)` from `_ts_method_has_wrapper_args`. The TypeScript classifier now matches the embind classifier — only `unbindablePointerTypes` (`char16_t*` variants) force suffix classification. Methods with `const char*` parameters enter the dispatch tree and receive unsuffixed names when distinguishable.

**Result**: `STEPCAFControl_Writer.Transfer` now has 6 unsuffixed overloads in both embind and the `.d.ts`.

### R6: Word-Boundary Const Stripping ✓ RESOLVED

**What was done**: Added `_strip_type_qualifiers_str` using `re.compile(r'\bconst\b')` for word-boundary-aware stripping. Replaced naive `replace("const", "")` calls in `resolve_type`'s canonical fallback path, preventing false matches like `Standard_ConstructionError` → `Standard_StructionError`.

### R7: STL Type Mappings ✓ RESOLVED

**What was done**: Implemented `_resolve_stl_type` mapping:

| C++ type                   | TypeScript type     |
| -------------------------- | ------------------- |
| `std::shared_ptr<T>`       | Resolved inner type |
| `std::initializer_list<T>` | `T[]`               |
| `std::pair<T, U>`          | `[T, U]`            |
| `std::optional<T>`         | `T \| undefined`    |
| `std::array<T, N>`         | `T[]`               |
| `std::string_view`         | `string`            |
| `NCollection_UtfString<T>` | `string`            |

### R8: Unsubstituted Template Parameters (Remaining)

Types like `Array1Type`, `SequenceType`, `const Array2Type` are template parameter names that appear in template class method signatures before instantiation. These are inherently unresolvable without instantiation context and account for ~211 of the remaining 1,449 `any` types.

**Possible approach**: Detect names that match template parameter declarations in the parent class and emit `unknown` instead of `any` to signal they're intentionally unresolvable.

## Code Examples

### Implemented type resolution flow

```python
# In _resolve_template_type() — revised generic flow:
# 1. Check original declaration spelling against known typedef names
orig_decl = clang_type.get_declaration()
if orig_decl.spelling in self.exports or orig_decl.spelling in _known_typedef_names:
    return orig_decl.spelling

# 2. Canonicalize, then resolve via handle unwrap, vec tuples, etc.
t = clang_type.get_canonical()
container = t.get_declaration().spelling

# 3. STL type mappings
stl_result = self._resolve_stl_type(container, t, ...)
if stl_result is not None:
    return stl_result

# 4. Universal typedef lookup (resolves ALL container types)
typedef_name = self._find_typedef_for_container(container, t)
if typedef_name:
    return typedef_name

# 5. Generic guardrail
self._collect_any("unrecognized_template", t.spelling)
return "any"
```

### Transfer method — before and after R5

```typescript
// BEFORE (suffixed, mismatched with runtime):
Transfer_1(theDoc: TDocStd_Document, ...): boolean;
Transfer_3(theLabel: TDF_Label, ...): boolean;
// @ts-expect-error needed to call writer.Transfer(...)

// AFTER (unsuffixed, matches runtime):
Transfer(theDoc: TDocStd_Document, ...): boolean;
Transfer(theLabel: TDF_Label, ...): boolean;
Transfer(theLabelSeq: TDF_LabelSequence, ...): boolean;
// writer.Transfer(doc, mode, "", progress) — works directly
```

## Appendix A: Remaining Unrecognized Template Types

Top types in the `unrecognized_template` category after R1–R7 fixes (1,400 total).

| C++ type                                                        | Occurrences | Root cause                        |
| --------------------------------------------------------------- | ----------- | --------------------------------- |
| `const Array1Type` / `Array1Type`                               | 105         | Unsubstituted template param (R8) |
| `NCollection_HSequence<occ::handle<Standard_Transient>>`        | 61          | H-container spelling mismatch     |
| `const Array2Type` / `Array2Type`                               | 54          | Unsubstituted template param (R8) |
| `const SequenceType` / `SequenceType`                           | 52          | Unsubstituted template param (R8) |
| `NCollection_HArray1<occ::handle<IGESData_IGESEntity>>`         | 35          | H-container spelling mismatch     |
| `NCollection_HArray1<occ::handle<TCollection_HAsciiString>>`    | 30          | H-container spelling mismatch     |
| `NCollection_HArray1<AppParCurves_ConstraintCouple>`            | 30          | No matching typedef               |
| `const XSAlgo_ShapeProcessor::ParameterMap`                     | 24          | Nested type alias                 |
| `NCollection_HArray1<occ::handle<StepRepr_RepresentationItem>>` | 23          | H-container spelling mismatch     |
| `NCollection_Map<occ::handle<TDF_Attribute>>`                   | 10          | No matching typedef               |
| `const ShapeProcess::OperationsFlags`                           | 10          | Nested type alias                 |
| `NCollection_DataMap<TopoDS_Shape, NCollection_List<...>, ...>` | 10          | Multi-arg spelling mismatch       |

## Appendix B: Nested Types Inventory ✓ RESOLVED

All nested types from the original audit are now auto-bound. The `processClass` method iterates public `STRUCT_DECL` children and emits `value_object` (embind) / `export interface` (TypeScript) declarations automatically.

## Appendix C: Multi-Arg Container Types Inventory

Multi-arg container types that still produce `any` after the generic typedef lookup. These fail because the Clang-provided template spelling doesn't match the typedef dictionary entry (qualification differences, hasher parameter presence/absence, etc.).

| Container instantiation                                                         | Expected typedef                            | Status            |
| ------------------------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| `NCollection_DataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, ...>`        | `TopTools_DataMapOfShapeListOfShape`        | Spelling mismatch |
| `NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, ...>` | `TopTools_IndexedDataMapOfShapeListOfShape` | Spelling mismatch |
| `NCollection_IndexedDataMap<handle<Transient>, handle<Transient>>`              | —                                           | No typedef exists |
| `NCollection_DataMap<TCollection_ExtendedString, *>`                            | Various `TDataStd_DataMap*`                 | Spelling mismatch |
