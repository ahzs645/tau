---
title: 'OCJS Any Type Analysis'
description: 'Root cause analysis of all 431 remaining any type resolutions in opencascade.js TypeScript declarations'
status: active
created: '2026-03-26'
updated: '2026-03-26'
category: audit
related:
  - docs/research/ocjs-test-failure-resolution.md
  - docs/research/ocjs-embind-js-dispatch-failures.md
---

# OCJS Any Type Analysis

Systematic audit of all 431 `any` type resolutions in the generated `opencascade_full.d.ts`, categorized by root cause with resolution strategies for each.

## Executive Summary

The 431 `any` types fall into 6 root cause groups. The dominant contributor (62.4%) is HArray/HSequence member typedefs — dependent types like `Array1Type` that the resolver cannot follow through template instantiation. Adding `NCollection_Vector` and `NCollection_DoubleMap` to auto-discovery, extending HArray/HSequence type resolution to their inner `Array1Type`/`SequenceType` typedefs, and resolving class-scoped `using` aliases would address ~80% of all remaining `any` types. The remaining ~20% involve namespace-scoped forward declarations, unresolved C++ template parameters, and STL containers that have no Embind binding and are intentionally opaque.

## Table of Contents

- [Methodology](#methodology)
- [Findings](#findings)
- [Recommendations](#recommendations)
- [Appendix: Full Type Inventory](#appendix-full-type-inventory)

## Problem Statement

The `dts-validation.test.ts` suite asserts that the `any` count stays at or below a regression threshold (currently 430). Understanding why each `any` exists is necessary to determine which are reducible vs. inherent limitations of the Embind/TypeScript type bridge.

## Methodology

- Parsed `build/any-type-report.json` which records every `any` resolution with its reason (`unrecognized_template` or `final_fallback`) and the original C++ type spelling
- Cross-referenced against the OCCT 8 header files to identify type origin
- Traced `resolve_type` → `_resolve_template_type` → `_find_typedef_for_container` code paths in `bindings.py`
- Analyzed `NCOLLECTION_CONTAINERS` in `discover.py` to identify gaps
- Categorized all 431 occurrences into root cause groups

## Findings

### Finding 1: HArray/HSequence Member Typedefs — 269 occurrences (62.4%)

**Root cause**: `NCollection_HArray1<T>` defines `typedef NCollection_Array1<TheItemType> Array1Type;` as a member typedef. Methods like `Array1()` and `ChangeArray1()` return `const Array1Type&` and `Array1Type&`. When the binding generator processes an instantiation like `NCollection_HArray1_gp_Pnt2d`, the return type resolves to the dependent type `Array1Type` which is a member typedef, not a globally accessible type.

The resolver's `_resolve_template_type` cannot follow member typedefs of template instantiations. It checks `_find_typedef_for_container` which only looks up global typedefs/using-aliases, not class-scoped ones.

**Affected patterns**:

| Type Parameter | C++ Definition                      | Count |
| -------------- | ----------------------------------- | ----- |
| `Array1Type`   | `NCollection_Array1<TheItemType>`   | 231   |
| `Array2Type`   | `NCollection_Array2<TheItemType>`   | 18    |
| `SequenceType` | `NCollection_Sequence<TheItemType>` | 20    |

**Resolution strategy**: For each auto-discovered `NCollection_HArray1_X` symbol, compute the corresponding `NCollection_Array1_X` name and register a type mapping so that `Array1Type` resolves to the concrete `NCollection_Array1_X` type. This requires passing template argument context through the type resolver.

### Finding 2: Class-Scoped Using-Aliases — 40 occurrences (9.3%)

**Root cause**: OCCT classes define `using` aliases as members (e.g., `using ParameterMap = NCollection_DataMap<...>`). These are not namespace-level declarations and are invisible to the typedef discovery pipeline.

**Affected types**:

| Alias             | Defined In              | Underlying Type                                                         | Count |
| ----------------- | ----------------------- | ----------------------------------------------------------------------- | ----- |
| `ParameterMap`    | `XSAlgo_ShapeProcessor` | `NCollection_DataMap<TCollection_AsciiString, TCollection_AsciiString>` | 24    |
| `OperationsFlags` | `ShapeProcess`          | `std::bitset<Operation::Last + 1>`                                      | 11    |
| `ProcessingFlags` | `XSAlgo_ShapeProcessor` | `std::pair<ShapeProcess::OperationsFlags, bool>`                        | 6     |

**Resolution strategy**: Extend the typedef/using-alias scanner to recurse into class member declarations (not just namespace-level). For types that resolve to non-bindable C++ types (like `std::bitset` or `std::pair`), the correct TypeScript mapping is either `any` (intentionally opaque) or a custom interface.

### Finding 3: Namespace-Scoped Forward Declarations — 33 occurrences (7.7%)

**Root cause**: OCCT V8 introduced namespace-scoped descriptor classes:

```cpp
namespace Geom_EvalRepSurfaceDesc {
  class Base;  // forward declaration only
}
```

Fields and methods typed as `occ::handle<Geom_EvalRepSurfaceDesc::Base>` resolve to `any` because `Base` is a forward-declared class inside a namespace. The resolver's `_resolve_nested_type` cannot traverse namespace-scoped declarations.

**Affected types**:

| Type                            | Count |
| ------------------------------- | ----- |
| `Geom_EvalRepSurfaceDesc::Base` | 15    |
| `Geom_EvalRepCurveDesc::Base`   | 9     |
| `Geom2d_EvalRepCurveDesc::Base` | 9     |

**Resolution strategy**: Register namespace-scoped classes as exports during the generate phase. If the class has no Embind binding (forward-declaration only), emit an opaque `interface` declaration in the `.d.ts` rather than `any`.

### Finding 4: NCollection_Vector Not in Auto-Discovery — 28 occurrences (6.5%)

**Root cause**: `discover.py` defines `NCOLLECTION_CONTAINERS` which controls which NCollection template types are auto-discovered. `NCollection_Vector` is absent from this set. Similarly, `NCollection_DoubleMap` (3 occurrences) is missing.

`NCollection_Vector` instantiations appear across BOPDS (Boolean Operations Data Structure) classes, which use `NCollection_Vector<BOPDS_Curve>`, `NCollection_Vector<BOPDS_InterfVV>`, etc.

**Resolution strategy**: Add `NCollection_Vector` and `NCollection_DoubleMap` to `NCOLLECTION_CONTAINERS` in `discover.py`. This would auto-generate `using` declarations and resolve all 31 occurrences (28 Vector + 3 DoubleMap). However, `NCollection_Vector` requires careful evaluation — it is similar to `std::vector` (dynamic resize) and some instantiations may reference types not accessible at the binding level.

### Finding 5: Unresolved C++ Template Parameters — 26 occurrences (6.0%)

**Root cause**: Types like `typename type-parameter-0-0::Point` and `typename type-parameter-0-0::Target` are dependent type names from C++ templates that the Clang AST represents as unresolved template parameters. These appear in BVH (Bounding Volume Hierarchy) tree classes that are templated on geometric primitives.

These represent a fundamental limitation: the C++ template parameter `T::Point` cannot be resolved without knowing the concrete `T`. If the BVH class is instantiated with `BRepExtrema_TriangleSet` (where `Point = gp_XYZ`), the resolver would need the instantiation context.

**Resolution strategy**: Similar to Finding 1, these require propagating template argument context through type resolution. For BVH classes specifically, the `Point` and `Target` typedefs could be mapped manually since there are only a few BVH instantiations used at the Embind level.

### Finding 6: STL and Non-NCollection Templates — 17 occurrences (3.9%)

**Root cause**: Various STL types (`std::vector<NCollection_Vec3<float>>`, `std::array<double, 3>`, `std::shared_ptr<std::streambuf>`) and non-NCollection templates (`BVH_Box<double, 3>`) lack Embind bindings and have no typedef mapping.

**Breakdown**:

| Type                              | Count |
| --------------------------------- | ----- |
| `std::vector<T>`                  | 4     |
| `std::array<double, 3>`           | 4     |
| `std::shared_ptr<std::streambuf>` | 4     |
| `BVH_Box<double, N>`              | 3     |
| `NCollection_Handle<T>` (nested)  | 3     |

**Resolution strategy**: `std::vector<T>` and `std::array<T,N>` could be mapped to `T[]` and `[T, T, T]` tuple types respectively in `_resolve_stl_type`. `std::shared_ptr<std::streambuf>` is genuinely opaque (no JS equivalent). `BVH_Box<double, N>` could be mapped to a tuple or custom interface.

### Finding 7: Irreducible Types — 7 occurrences (1.6%)

**Root cause**: Types that are inherently non-bindable:

| Type                                                                        | Reason                                    | Count |
| --------------------------------------------------------------------------- | ----------------------------------------- | ----- |
| Class-private nested types (`Loop`, `ListOfLink`, `UBTree`, `AdjacencyMap`) | Internal implementation detail, no export | 5     |
| `std::type_info`                                                            | Runtime type system, no JS equivalent     | 1     |
| `clocale_t`                                                                 | Platform-specific C locale handle         | 1     |

**Resolution strategy**: These 7 `any` types are inherently irreducible. They represent C++ implementation details or platform types with no JavaScript equivalent. The correct resolution is to accept them as `any`.

## Recommendations

| #   | Action                                                                                        | Category | Count Reduced | Effort | Priority |
| --- | --------------------------------------------------------------------------------------------- | -------- | ------------- | ------ | -------- |
| R1  | Add `NCollection_Vector`, `NCollection_DoubleMap` to `NCOLLECTION_CONTAINERS`                 | F4       | ~31           | Low    | P1       |
| R2  | Map `std::vector<T>` → `T[]` and `std::array<T,N>` → tuple in `_resolve_stl_type`             | F6       | ~8            | Low    | P1       |
| R3  | Resolve HArray/HSequence member typedefs by computing inner container type from template args | F1       | ~269          | Medium | P0       |
| R4  | Emit opaque `interface` declarations for namespace-scoped forward-declared classes            | F3       | ~33           | Medium | P1       |
| R5  | Extend typedef scanner to class-member `using` aliases                                        | F2       | ~24           | Medium | P2       |
| R6  | Propagate template argument context for BVH `Point`/`Target` dependent types                  | F5       | ~26           | High   | P2       |
| R7  | Accept 7 irreducible `any` types, lower regression threshold after fixes                      | F7       | 0             | None   | P3       |

**Impact summary**: R1+R2 (low effort) would reduce `any` count by ~39. R3 alone (medium effort) would reduce by ~269. All recommendations combined would bring the `any` count from 431 to approximately 7 (the irreducible minimum).

## Code Examples

### R1: Adding NCollection_Vector to auto-discovery

```python
NCOLLECTION_CONTAINERS = frozenset({
    "NCollection_Array1", "NCollection_Array2",
    "NCollection_HArray1", "NCollection_HArray2",
    "NCollection_Sequence", "NCollection_HSequence",
    "NCollection_List", "NCollection_Map",
    "NCollection_DataMap", "NCollection_IndexedMap",
    "NCollection_IndexedDataMap",
    "NCollection_Vector",      # +31 resolved
    "NCollection_DoubleMap",   # +3 resolved
})
```

### R3: HArray member typedef resolution

When processing `NCollection_HArray1_gp_Pnt2d`, the resolver encounters `Array1Type` as a return type. The resolution could intercept this pattern:

```python
if container in ("NCollection_HArray1", "NCollection_HArray2", "NCollection_HSequence"):
    inner_container = {
        "NCollection_HArray1": "NCollection_Array1",
        "NCollection_HArray2": "NCollection_Array2",
        "NCollection_HSequence": "NCollection_Sequence",
    }[container]
    # TheItemType is the first template argument
    item_type = t.get_template_argument_type(0)
    mangled = mangle_template_name(inner_container, [item_type.spelling])
    if mangled in self.exports or mangled in TypescriptBindings._known_export_names:
        return mangled
```

### R4: Opaque interface for namespace-scoped forward declarations

```typescript
export interface Geom_EvalRepSurfaceDesc_Base {}
export interface Geom_EvalRepCurveDesc_Base {}
export interface Geom2d_EvalRepCurveDesc_Base {}
```

## Appendix: Full Type Inventory

### Unrecognized Template Types (370 total)

| Type                                              | Count | Root Cause                   |
| ------------------------------------------------- | ----- | ---------------------------- |
| `const Array1Type`                                | 154   | F1: HArray member typedef    |
| `Array1Type`                                      | 77    | F1: HArray member typedef    |
| `const XSAlgo_ShapeProcessor::ParameterMap`       | 24    | F2: Class using-alias        |
| `const Array2Type`                                | 12    | F1: HArray2 member typedef   |
| `const ShapeProcess::OperationsFlags`             | 10    | F2: Class using-alias        |
| `const SequenceType`                              | 10    | F1: HSequence member typedef |
| `SequenceType`                                    | 10    | F1: HSequence member typedef |
| `const XSAlgo_ShapeProcessor::ProcessingFlags`    | 6     | F2: Class using-alias        |
| `Array2Type`                                      | 6     | F1: HArray2 member typedef   |
| `const std::array<double, 3>`                     | 4     | F6: STL unmapped             |
| `std::shared_ptr<std::streambuf>`                 | 4     | F6: STL opaque               |
| `NCollection_Vector<...>` (19 distinct types)     | 28    | F4: Missing from discovery   |
| `NCollection_DoubleMap<int, TDF_Label>`           | 3     | F4: Missing from discovery   |
| `NCollection_Handle<...>` (nested templates)      | 3     | F6: Nested template          |
| `BVH_Box<double, N>`                              | 3     | F6: Non-NCollection template |
| `DE_Provider::ReadStreamList` / `WriteStreamList` | 2     | F2: Class member typedef     |
| `std::vector<T>` (3 distinct types)               | 4     | F6: STL unmapped             |
| Private/nested types (5 distinct)                 | 5     | F7: Irreducible              |

### Final Fallback Types (61 total)

| Type                            | Canonical                    | Count | Root Cause                    |
| ------------------------------- | ---------------------------- | ----- | ----------------------------- |
| `const Point`                   | `type-parameter-0-0::Point`  | 18    | F5: Unresolved template param |
| `Geom_EvalRepSurfaceDesc::Base` | same                         | 15    | F3: Namespace forward decl    |
| `Geom_EvalRepCurveDesc::Base`   | same                         | 9     | F3: Namespace forward decl    |
| `Geom2d_EvalRepCurveDesc::Base` | same                         | 9     | F3: Namespace forward decl    |
| `const Target`                  | `type-parameter-0-0::Target` | 8     | F5: Unresolved template param |
| `const std::type_info`          | same                         | 1     | F7: Irreducible               |
| `clocale_t`                     | `_xlocale *`                 | 1     | F7: Irreducible               |
