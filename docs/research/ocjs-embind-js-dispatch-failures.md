---
title: 'Embind JS Dispatch Failures'
description: 'Root cause analysis of all 30 smoke test failures after migrating opencascade.js overload dispatch from C++/WASM to pure JavaScript'
status: draft
created: '2026-03-25'
updated: '2026-03-25'
category: investigation
related:
  - docs/research/observability-implementation-status.md
---

# Embind JS Dispatch Failures

Root cause analysis of 30 smoke test failures across 12 test files after rebuilding opencascade.js with the pure JavaScript overload dispatch system (`libembind-overloading.patch`).

## Executive Summary

After migrating opencascade.js overload dispatch from C++ `emscripten::val`-based type discrimination to pure JavaScript `typeof`/`instanceof` checks, 30 of 243 smoke tests fail. All failures trace to exactly **3 root causes**: (1) `cppTypeToJsType` doesn't recognize enum types, making all enum arguments unmatchable; (2) `ensureOverloadSignatureTable` loses the first-registered overload's signature array, making it unreachable by `getSignature`; (3) `bindings.py` emits mixed suffixed/unsuffixed method names for NCollection template instantiations, leaving some overloads orphaned under `_N` suffixes.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Findings](#findings)
  - [Finding 1: Enum type dispatch failure](#finding-1-enum-type-dispatch-failure)
  - [Finding 2: First-registered signature array lost](#finding-2-first-registered-signature-array-lost)
  - [Finding 3: Mixed suffixed/unsuffixed bindings from bindings.py](#finding-3-mixed-suffixedunsuffixed-bindings-from-bindingspy)
  - [Finding 4: Test uses removed \_N suffix](#finding-4-test-uses-removed-_n-suffix)
- [Recommendations](#recommendations)
- [Code Examples](#code-examples)
- [Appendix: Full Failure Inventory](#appendix-full-failure-inventory)

## Problem Statement

Build: `O3-noLTO-simd` config with `full.yml`, closure disabled for debuggability. After `pnpm nx run ocjs:link --skip-nx-cache`, the smoke test suite reports:

```
Test Files  12 failed | 47 passed (59)
     Tests  30 failed | 210 passed | 3 skipped (243)
```

All 30 failures are regressions from the JS dispatch migration. The dispatch system consists of three components:

1. **`libembind-overloading.patch`** — patches Emscripten's `libembind.js` with `$getSignature`, `$cppTypeToJsType`, and `$ensureOverloadSignatureTable`
2. **`bindings.py`** — generates C++ Embind bindings, now emitting suffix-free method names for JS-side dispatch
3. **Embind registration functions** — `_embind_register_class_function`, `_embind_register_class_class_function`, `_embind_register_class_constructor`

## Methodology

1. Built opencascade.js with `OCJS_CONFIG=O3-noLTO-simd`, `OCJS_CLOSURE=false` to preserve symbol names
2. Ran full smoke test suite, categorized all 30 failures by error type
3. Probed the runtime dispatch tables via Node.js (`overloadTable`, `signatures`, `signaturesArray`) to inspect registered overloads at each arity
4. Inspected generated C++ bindings in `build/bindings/` to verify what `bindings.py` emits
5. Traced dispatch flow through `getSignature` → `cppTypeToJsType` → `ensureOverloadSignatureTable` with concrete typeIds

## Findings

### Finding 1: Enum type dispatch failure

**Affected tests**: 8 failures across 4 files

| Test file                            | Failures | Method                            | Enum type                            |
| ------------------------------------ | -------- | --------------------------------- | ------------------------------------ |
| `smoke-enum-method-dispatch.test.ts` | 3        | `SetColor`                        | `XCAFDoc_ColorType`                  |
| `smoke-xcaf.test.ts`                 | 1        | `SetColor`                        | `XCAFDoc_ColorType`                  |
| `smoke-stepcaf-writer.test.ts`       | 1        | `SetColor`                        | `XCAFDoc_ColorType`                  |
| `smoke-extrema-distance.test.ts`     | 3        | `BRepExtrema_DistShapeShape` ctor | `Extrema_ExtFlag`, `Extrema_ExtAlgo` |

**Root cause**: `cppTypeToJsType` does not handle enum types. For enum type IDs, it falls through to `return typeId` (a raw numeric pointer), while JS enum values are strings (e.g., `'XCAFDoc_ColorSurf'`). In `getSignature`, the check `typeof args[i] === field` becomes `'string' === 2176672`, which is always false.

**Evidence** — runtime probe of `SetColor` dispatch tables:

```
signatures keys:
  '807552, 807552, 2176672'    ← typeId 2176672 = XCAFDoc_ColorType enum
  '807552, 659508, 2176672'
  '622032, 660132, 2176672'
  ...
signaturesArray entries:
  [tid:807552, tid:807552, tid:2176672]    ← all third elements are raw typeIds
```

When called with `(label, colorRGBA, 'XCAFDoc_ColorSurf')`, `getSignature` cannot match any entry because no key element equals `'string'`.

**Enum type registration structure**: Embind's `_embind_register_enum` stores a `valueType` property on the registered type (`'string'`, `'number'`, or `'object'`). This property is available in `registeredTypes[typeId]` and can be used to detect enums.

**Fix**: In `cppTypeToJsType`, check for `type.valueType` before the fallback:

```javascript
$cppTypeToJsType: (typeId) => {
    var type = registeredTypes[typeId];
    if (type.name === 'emscripten::val') return 'emscripten::val';
    if (type.name === 'std::string' || type.name === 'std::wstring') return 'string';
    else if (type.name === 'bool') return 'boolean';
    else if (['char', ...].includes(type.name)) return 'number';
    // Enum types: string enums → 'string', number enums → 'number'
    else if (type.valueType === 'string') return 'string';
    else if (type.valueType === 'number') return 'number';
    return typeId;
},
```

### Finding 2: First-registered signature array lost

**Affected tests**: 10 failures across 5 files

| Test file                                 | Failures | Method                                                 | Missing overload                  |
| ----------------------------------------- | -------- | ------------------------------------------------------ | --------------------------------- |
| `smoke-properties.test.ts`                | 1        | `Bnd_Box.IsOut`                                        | `IsOut(gp_Pnt)`                   |
| `smoke-feature-modeling.test.ts`          | 1        | `BRepFeat_MakeDPrism.Perform`                          | `Perform(double)`                 |
| `smoke-brep-tool-overloads.test.ts`       | 3        | `BRep_Tool.PolygonOnTriangulation`, `PolygonOnSurface` | 3-arg handle-returning overload   |
| `smoke-static-signature-dispatch.test.ts` | 2        | `BRep_Tool.PolygonOnTriangulation`, `Curve`            | First overload at each arity      |
| `smoke-value-object-independence.test.ts` | 1        | `BRep_Tool.Range`                                      | 1-arg RBV overload (if generated) |

**Note on `BRep_Tool.Range`**: The probe shows `Range` has overloadTable entries at arities 3, 4, and 5 only — no arity-1 entry exists. The test expected a 1-arg RBV form `Range(edge) → {First, Last}` that was never generated. This is a test authoring error, not a dispatch bug. The remaining 9 failures are genuine dispatch bugs.

**Root cause**: In `ensureOverloadSignatureTable` (our patch code), when the first resolved function at a given arity is moved into the signature table, its key array is not added to `signaturesArray`. The function IS stored in the `signatures` map (reachable by key), but `getSignature` iterates only over `signaturesArray` — so the first overload can never be matched.

**Evidence** — runtime probe of `Bnd_Box.IsOut` at arity 1:

```
signatures map has 4 keys:  735600, 741772, 766864, 790208
signaturesArray has 3 entries: [tid:741772], [tid:766864], [tid:790208]
```

TypeId `735600` (= `gp_Pnt`) is in the map but NOT in the array. This is the first overload registered at arity 1.

**Evidence** — runtime probe of `BRepFeat_MakeDPrism.Perform` at arity 1:

```
signatures map has 2 keys:  622032, number
signaturesArray has 1 entry: [tid:622032]
```

The `'number'` key (= `Perform(double)`) is in the map but NOT in the array.

**Mechanism**: The race condition occurs because Embind's `whenDependentTypesAreResolved` callbacks fire immediately when types are already registered (which is the common case during module initialization). The sequence is:

1. First overload registers → types resolve immediately → `proto[methodName] = memberFunction` (with `.signature`, `.argCount`)
2. Second overload registers → enters `ensureOverloadSignatureTable`:
   - Creates `overloadTable`, moves `memberFunction` to `overloadTable[N]`
   - `overloadTable[N].signatures = {}; signatures[memberFunction.signature] = memberFunction`
   - `overloadTable[N].signaturesArray = []` ← **empty, first overload's array never added**
3. Second overload's types resolve → pushes to `signaturesArray` ✓
4. Third+ overloads → push to `signaturesArray` ✓

Result: `signatures` map has N entries, `signaturesArray` has N−1. The first overload's function is stored but unreachable.

**Fix**: When moving `prevFunc` into the signature table, also reconstruct and push its signature array. Two approaches:

**(A) Store signatureArray on the function** — in `whenDependentTypesAreResolved`, save `memberFunction.signatureArray = signatureArray` alongside `.signature`. Then in `ensureOverloadSignatureTable`:

```javascript
proto[methodName].overloadTable[numArguments].signaturesArray = [];
if (prevFunc.signatureArray) {
  proto[methodName].overloadTable[numArguments].signaturesArray.push(prevFunc.signatureArray);
}
```

**(B) Parse signature string** — reconstruct from `prevFunc.signature.split(', ')`, converting numeric strings back to numbers. Less clean, avoids changing the resolution path.

Approach (A) is recommended for clarity and correctness.

### Finding 3: Mixed suffixed/unsuffixed bindings from bindings.py

**Affected tests**: 13 failures across 3 files

| Test file                         | Failures | Methods affected                       | Pattern                        |
| --------------------------------- | -------- | -------------------------------------- | ------------------------------ |
| `smoke-collections.test.ts`       | 7        | `Append`, `Add`, `SetValue`, `Prepend` | Mixed or missing suffix-free   |
| `smoke-bspline-nurbs.test.ts`     | 5        | `SetValue` on `TColgp_Array1OfPnt`     | Only `_N` suffixed versions    |
| `smoke-advanced-modeling.test.ts` | 1        | `Append` on `TopTools_ListOfShape`     | Wrong overload under base name |

**Root cause**: `bindings.py` emits inconsistent naming for NCollection template instantiation methods. For `TopTools_ListOfShape.Append`, the generated C++ bindings are:

```cpp
.function("Append",   select_overload<void(TopTools_ListOfShape &), ...>)   // suffix-free
.function("Append_1", select_overload<TopoDS_Shape &(const TopoDS_Shape &), ...>)  // suffixed
.function("Append_2", select_overload<TopoDS_Shape &(TopoDS_Shape &&), ...>)  // suffixed
```

The suffix-free `Append` registers only ONE overload (taking `TopTools_ListOfShape&`). When user code calls `list.Append(shape)`, it invokes this single-overload function, which tries to cast `TopoDS_Shape` to `TopTools_ListOfShape` and fails with `upcastPointer` error.

For `TColgp_Array1OfPnt.SetValue`, NO suffix-free version exists:

```cpp
.function("SetValue_1", select_overload<void(int, const gp_Pnt &), ...>)
.function("SetValue_2", select_overload<void(int, gp_Pnt &&), ...>)
```

**Evidence** — runtime prototype inspection:

```
TColgp_Array1OfPnt methods: SetValue_1, SetValue_2  (no SetValue)
TopTools_IndexedMapOfShape methods: Add_1, Add_2  (no Add)
TopTools_ListOfShape methods: Append, Append_1, Append_2  (mixed)
```

The pattern: `bindings.py`'s suffix elimination logic assigns the base name to one overload (typically the one taking the collection's own type as a parameter) while keeping numeric suffixes for the element-typed overloads. This is a code generation issue in how `bindings.py` determines which overloads share a name.

**Fix**: `bindings.py` must emit ALL overloads of the same C++ method under the same suffix-free name, relying on JS dispatch for routing. The `_N` suffixed variants should not be emitted when JS dispatch is enabled.

### Finding 4: Test uses removed \_N suffix

**Affected tests**: 1 failure

| Test file                      | Failures | Issue                                                    |
| ------------------------------ | -------- | -------------------------------------------------------- |
| `smoke-stepcaf-writer.test.ts` | 1        | `writer.Transfer_1(...)` — `Transfer_1` no longer exists |

With suffix-free dispatch, `STEPCAFControl_Writer.Transfer` replaces `Transfer_1`/`Transfer_2`. The runtime probe confirms:

```
Transfer exists: function (with overloadTable at arities 4, 5)
Transfer_1 exists: undefined
```

**Fix**: Update the test to use `Transfer` instead of `Transfer_1`.

## Recommendations

| #   | Action                                                                                          | Priority | Effort  | Impact                | Root cause |
| --- | ----------------------------------------------------------------------------------------------- | -------- | ------- | --------------------- | ---------- |
| R1  | Add enum type detection to `cppTypeToJsType` via `type.valueType`                               | P0       | Low     | High — fixes 8 tests  | Finding 1  |
| R2  | Store `.signatureArray` on resolved functions, push in `ensureOverloadSignatureTable`           | P0       | Low     | High — fixes 9 tests  | Finding 2  |
| R3  | Fix `bindings.py` to emit all overloads under suffix-free names for NCollection templates       | P0       | Medium  | High — fixes 13 tests | Finding 3  |
| R4  | Update `smoke-stepcaf-writer.test.ts` to use `Transfer`                                         | P1       | Trivial | Low — fixes 1 test    | Finding 4  |
| R5  | Fix `smoke-value-object-independence.test.ts` `BRep_Tool.Range` to use correct arity (3, not 1) | P1       | Trivial | Low — fixes 1 test    | Test error |

Implementing R1 + R2 alone resolves 17 of 30 failures. Adding R3 resolves all 30 (with R4 and R5 as trivial test fixes).

## Code Examples

### R1: cppTypeToJsType enum fix (in libembind-overloading.patch)

```javascript
$cppTypeToJsType: (typeId) => {
    var type = registeredTypes[typeId];
    if (type.name === 'emscripten::val') return 'emscripten::val';
    if (type.name === 'std::string' || type.name === 'std::wstring') return 'string';
    else if (type.name === 'bool') return 'boolean';
    else if (['char', 'signed char', 'unsigned char', 'short', 'unsigned short',
              'int', 'unsigned int', 'long', 'unsigned long', 'float', 'double',
              'int64_t', 'uint64_t'].includes(type.name)) return 'number';
    else if (type.valueType === 'string') return 'string';
    else if (type.valueType === 'number') return 'number';
    return typeId;
},
```

### R2: signatureArray preservation (in libembind-overloading.patch)

In `_embind_register_class_function` and `_embind_register_class_class_function`, when types resolve and the function is stored directly on the prototype (no overload table yet), save the signature array:

```javascript
memberFunction.argCount = argCount - 2;
memberFunction.signature = signatureString;
memberFunction.signatureArray = signatureArray; // NEW
proto[methodName] = memberFunction;
```

In `ensureOverloadSignatureTable`, after initializing `signaturesArray`, push the existing function's array:

```javascript
proto[methodName].overloadTable[numArguments].signaturesArray = [];
if (prevFunc.signatureArray) {
  proto[methodName].overloadTable[numArguments].signaturesArray.push(prevFunc.signatureArray);
}
```

### R3: bindings.py suffix elimination for NCollection templates

The current logic in `bindings.py` assigns the base name to ONE overload and keeps `_N` suffixes for others. The fix requires changing the overload naming logic to emit all overloads of the same C++ method name under the same Embind name, regardless of whether they come from template instantiations.

This is a change in the `processClass` / `processMethod` code path in `bindings.py` where suffix generation occurs. The exact location depends on the `needsSuffix` / `_classify_overloads` logic.

## Appendix: Full Failure Inventory

| #   | Test file                         | Test name                           | Root cause | Error type                           |
| --- | --------------------------------- | ----------------------------------- | ---------- | ------------------------------------ |
| 1   | `smoke-enum-method-dispatch`      | SetColor(Label, ColorRGBA, enum)    | Finding 1  | Invalid signature (string vs typeId) |
| 2   | `smoke-enum-method-dispatch`      | SetColor(Shape, ColorRGBA, enum)    | Finding 1  | Invalid signature                    |
| 3   | `smoke-enum-method-dispatch`      | SetColor(Label, Color, enum)        | Finding 1  | Invalid signature                    |
| 4   | `smoke-xcaf`                      | SetColor(Shape, Color, enum)        | Finding 1  | Invalid signature                    |
| 5   | `smoke-stepcaf-writer`            | SetColor(Shape, Color, enum)        | Finding 1  | Invalid signature                    |
| 6   | `smoke-extrema-distance`          | DistShapeShape ctor (2 boxes)       | Finding 1  | Invalid ctor signature (enum args)   |
| 7   | `smoke-extrema-distance`          | DistShapeShape ctor (overlap)       | Finding 1  | Invalid ctor signature               |
| 8   | `smoke-extrema-distance`          | DistShapeShape ctor (box+sphere)    | Finding 1  | Invalid ctor signature               |
| 9   | `smoke-properties`                | Bnd_Box.IsOut(gp_Pnt)               | Finding 2  | gp_Pnt overload unreachable          |
| 10  | `smoke-feature-modeling`          | BRepFeat_MakeDPrism.Perform(double) | Finding 2  | number overload unreachable          |
| 11  | `smoke-brep-tool-overloads`       | PolygonOnTriangulation 3-arg        | Finding 2  | First 3-arg overload lost            |
| 12  | `smoke-brep-tool-overloads`       | PolygonOnTriangulation 2-arg RBV    | Finding 2  | First 2-arg overload lost            |
| 13  | `smoke-brep-tool-overloads`       | PolygonOnSurface 2-arg              | Finding 2  | First 2-arg overload lost            |
| 14  | `smoke-static-signature-dispatch` | PolygonOnTriangulation 3-arg        | Finding 2  | First 3-arg overload lost            |
| 15  | `smoke-static-signature-dispatch` | BRep_Tool.Curve 3-arg               | Finding 2  | First overload lost                  |
| 16  | `smoke-value-object-independence` | BRep_Tool.Range 1-arg               | Test error | No arity-1 binding exists            |
| 17  | `smoke-stepcaf-writer`            | Transfer_1                          | Finding 4  | \_1 suffix removed                   |
| 18  | `smoke-collections`               | ListOfShape.Append(Shape)           | Finding 3  | Base name = wrong overload           |
| 19  | `smoke-collections`               | ListOfShape.Prepend(Shape)          | Finding 3  | Base name = wrong overload           |
| 20  | `smoke-collections`               | IndexedMapOfShape.Add(Shape)        | Finding 3  | No suffix-free Add                   |
| 21  | `smoke-collections`               | IndexedMapOfShape.Add(Edge)         | Finding 3  | No suffix-free Add                   |
| 22  | `smoke-collections`               | Array1OfPnt.SetValue                | Finding 3  | No suffix-free SetValue              |
| 23  | `smoke-collections`               | ListOfShape.Size after Append       | Finding 3  | Cascading from #18                   |
| 24  | `smoke-collections`               | ListOfShape.Append count            | Finding 3  | Cascading from #18                   |
| 25  | `smoke-bspline-nurbs`             | PointsToBSpline (SetValue)          | Finding 3  | No suffix-free SetValue              |
| 26  | `smoke-bspline-nurbs`             | Interpolate (SetValue)              | Finding 3  | No suffix-free SetValue              |
| 27  | `smoke-bspline-nurbs`             | BSpline edge+wire (SetValue)        | Finding 3  | No suffix-free SetValue              |
| 28  | `smoke-bspline-nurbs`             | Bezier from poles (SetValue)        | Finding 3  | No suffix-free SetValue              |
| 29  | `smoke-bspline-nurbs`             | Extrude BSpline (SetValue)          | Finding 3  | No suffix-free SetValue              |
| 30  | `smoke-advanced-modeling`         | MakeThickSolid (Append)             | Finding 3  | Base name = wrong overload           |
