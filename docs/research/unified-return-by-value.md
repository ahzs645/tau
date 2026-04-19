---
title: 'Unified Return-by-Value for Output Parameters'
description: 'Implementation reference for transforming C++ output parameters (Handle<T>& and primitive T&) into idiomatic return-by-value JS APIs via AST-driven codegen in opencascade.js bindings.py'
status: active
created: '2026-03-18'
updated: '2026-03-18'
category: architecture
related:
  - docs/research/embind-smart-pointer-stale-ptr.md
  - docs/research/embind-return-strategy-benchmarks.md
  - docs/research/wasm-smart-pointer-landscape.md
---

# Unified Return-by-Value for Output Parameters

Implementation reference for replacing Embind output-parameter patterns with AST-driven `value_object` return-by-value codegen in `repos/opencascade.js/src/bindings.py`.

## Executive Summary

C++ output parameters (`T&`) don't map to JavaScript — JS has no reference types for function arguments. The current opencascade.js binding generator handles primitive output params (`double&`, `int&`) via a `{ current: value }` mutation pattern that has broken TypeScript types and poor DX. Handle output params (`Handle<T>&`) are not handled at all, producing stale pointer crashes. This document specifies a unified approach: detect all output parameters from the clang AST, generate `optional_override` wrappers returning `value_object` structs, and emit correct TypeScript signatures. The approach handles both output-only and bidirectional parameters safely, with zero Emscripten changes required.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Why Embind Cannot Support Output Parameters](#why-embind-cannot-support-output-parameters)
- [Detection Heuristics](#detection-heuristics)
- [Bidirectional Parameter Analysis](#bidirectional-parameter-analysis)
- [Generated Code Specification](#generated-code-specification)
- [TypeScript Bindings Changes](#typescript-bindings-changes)
- [Consumer DX Comparison](#consumer-dx-comparison)
- [What Gets Removed](#what-gets-removed)
- [Edge Cases](#edge-cases)
- [Recommendations](#recommendations)
- [References](#references)

## Problem Statement

Two separate problems converge on the same solution.

### Problem 1: Handle output parameters crash (stale `$$.ptr`)

When `Handle<T>&` is passed as an output parameter, Embind's `$$.ptr` cache goes stale after C++ mutates the handle. Subsequent method calls on the JS wrapper use the cached (freed) pointer, producing `table index is out of bounds` crashes. Root cause analysis in `docs/research/embind-smart-pointer-stale-ptr.md`.

```typescript
// Current — crashes on h1.FirstParameter() due to stale $$.ptr
const h1 = new oc.Geom2d_Line(ax1);
intersector.Segment(i, h1, h2); // C++ replaces h1's pointee
h1.FirstParameter(); // uses stale $$.ptr → crash
```

### Problem 2: Primitive output parameters have broken types and poor DX

The existing `{ current: value }` pattern for primitive `T&` params works at runtime but TypeScript types are wrong — they say `number` instead of `{ current: number }`, requiring `@ts-expect-error` in every consumer.

```typescript
const uMin = { current: 0 };
// @ts-expect-error — types say number, runtime needs { current: number }
this.oc.BRepTools.UVBounds(this.wrapped, uMin, uMax, vMin, vMax);
return { uMin: uMin.current, ... };
```

## Why Embind Cannot Support Output Parameters

Embind's `$$.ptr` caching is an intentional performance optimization, not a bug. The design assumes `$$.ptr` is invariant for the lifetime of a JS wrapper. This is documented in upstream issues:

- [Issue #4583](https://github.com/emscripten-core/emscripten/issues/4583) (2016): Exact same stale-pointer bug reported. Closed `wontfix` by stale bot.
- [Issue #17765](https://github.com/emscripten-core/emscripten/issues/17765) (2022): Asks why `RegisteredPointer` doesn't re-dereference via `$$.smartPtr`. Embind maintainer response: _"dereferencing each time would add another call into wasm which could be slower."_
- [Issue #13338](https://github.com/emscripten-core/emscripten/issues/13338) (2021): Filed by @donalffons (opencascade.js author) about `BRepTools::UVBounds`. He solved it with `emscripten::val` + `{ current: value }` — the pattern now in `bindings.py`.

The correct Embind pattern for output parameters is `optional_override`: wrap the C++ method, call it internally, return results as values. This is the established approach across all major binding libraries (pybind11, SWIG `%argout`, nanobind, wasm-bindgen).

No Emscripten fork is needed. The `repos.yaml` entry for emscripten is reference-only (shallow clone, no fork).

## Detection Heuristics

All detection is purely AST-driven via libclang, with no OCCT-specific logic.

### Finding 1: Non-const lvalue reference distinguishes output from input

The sole distinguishing feature between input and output parameters is **const-qualification on the pointee**:

| C++ Type           | Const? | Role                 | Example                                           |
| ------------------ | ------ | -------------------- | ------------------------------------------------- |
| `const Handle<T>&` | yes    | Input                | `Init(const Handle<Geom2d_Curve>& C1, ...)`       |
| `Handle<T>&`       | no     | Output               | `Segment(..., Handle<Geom2d_Curve>& Curve1, ...)` |
| `const double&`    | yes    | Input                | `Init(..., const double Tol)`                     |
| `double&`          | no     | Output/bidirectional | `UVBounds(..., double& UMin, ...)`                |

AST check: `type.kind == LVALUEREFERENCE && !type.get_pointee().is_const_qualified()`.

### Finding 2: Handle type detection via AST template inspection

The existing `_resolve_handle_recursive` in `TypescriptBindings` already identifies `Handle<T>`:

```python
# Pseudocode — actual implementation at bindings.py:1852
t = type.get_pointee()  # strip the & reference
if t.get_num_template_arguments() == 1:
    decl = t.get_declaration()
    if decl.spelling == "handle" and decl.semantic_parent.spelling in ("opencascade", "occ"):
        inner_type = t.get_template_argument_type(0)  # e.g., Geom2d_Curve
```

### Finding 3: Method constness determines primitive param stripping

For primitive `T&` output params, method constness determines whether the parameter can be safely stripped from the JS signature:

| Parameter type | Method qualifier          | Action                       | Rationale                                      |
| -------------- | ------------------------- | ---------------------------- | ---------------------------------------------- |
| `Handle<T>&`   | any                       | Strip from signature         | Never bidirectional; current binding is broken |
| `T&` primitive | `const` method            | Strip from signature         | Const method guarantees output-only            |
| `T&` primitive | non-const / static / free | Keep in signature AND return | May be bidirectional (see Finding 4)           |

### Combined detection function

```python
def isOutputParam(arg_type):
    """Non-const lvalue reference to primitive or handle = output parameter."""
    if arg_type.kind != clang.cindex.TypeKind.LVALUEREFERENCE:
        return False
    pointee = arg_type.get_pointee()
    if pointee.is_const_qualified():
        return False
    return True

def isHandleOutputParam(arg_type):
    """Non-const lvalue reference to handle<T> specifically."""
    if not isOutputParam(arg_type):
        return False
    pointee = arg_type.get_pointee()
    if pointee.get_num_template_arguments() != 1:
        return False
    decl = pointee.get_declaration()
    return decl.spelling == "handle" and decl.semantic_parent.spelling in ("opencascade", "occ")

def isPrimitiveOutputParam(arg_type):
    """Non-const lvalue reference to builtin type or enum."""
    if not isOutputParam(arg_type):
        return False
    pointee = arg_type.get_pointee()
    canonical = pointee.get_canonical().spelling
    return canonical in builtInTypes or pointee.kind == clang.cindex.TypeKind.ENUM

def shouldStripParam(arg_type, method):
    """Whether to remove the param from the JS-visible signature."""
    if isHandleOutputParam(arg_type):
        return True  # handles always stripped
    if isPrimitiveOutputParam(arg_type) and method.is_const_method():
        return True  # const method guarantees output-only
    return False  # keep for safety (may be bidirectional)
```

## Bidirectional Parameter Analysis

### Finding 4: Bidirectional primitive parameters exist in the bound API

Adversarial review of the OCCT codebase found genuinely bidirectional `T&` parameters in the replicad symbol list:

**`ElCLib::AdjustPeriodic`** — reads U1/U2, adjusts to periodic range, writes back:

```cpp
// src/FoundationClasses/TKMath/ElCLib/ElCLib.cxx:139
U1 -= std::floor((U1 - UFirst) / aPeriod) * aPeriod;
U2 -= std::floor((U2 - U1) / aPeriod) * aPeriod;
```

**`Coord_Ancien_Repere`** — in-place coordinate system transformation:

```cpp
// src/ModelingData/TKGeomBase/IntAna2d/IntAna2d_Outils.cxx:310
x0 = t11 * x1 + t12 * y1 + t13;  // reads x1, y1
y0 = t21 * x1 + t22 * y1 + t23;
x1 = x0;  // writes back
y1 = y0;
```

Both are static/free functions (not const methods), so the method-constness heuristic correctly keeps their params in the JS signature.

### Finding 5: Handle<T>& is never bidirectional

OCCT consistently uses `const Handle<T>&` for input (read the pointed-to object) and `Handle<T>&` for output (assign a new object to the handle). The bidirectional pattern — "use the existing pointee, then replace the handle" — does not occur in the OCCT codebase. Verified across all `Handle<T>&` occurrences in `repos/OCCT/src/`.

### Finding 6: Const methods guarantee output-only semantics

A `const` method cannot modify `this`, so its only mechanism for "returning" computed values is through non-const reference parameters. All `const` methods with `T&` params in the OCCT codebase are output-only:

- `Geom_Surface::Bounds(double& U1, double& U2, double& V1, double& V2) const`
- `Geom2dAPI_InterCurveCurve::Segment(const int, Handle<Geom2d_Curve>&, Handle<Geom2d_Curve>&) const`
- `GeomAPI_ProjectPointOnSurf::LowerDistanceParameters(double& U, double& V) const`
- `Bnd_Box::Get(double&, double&, double&, double&, double&, double&) const`

### Finding 7: BSplCLib uses double& as array pointers

`BSplCLib::Bohm(double U, int Degree, int N, double& Knots, int Dimension, double& Poles)` uses `double&` as a flat C-style array pointer — a low-level numerical trick. The `Dimension` and `Degree` parameters indicate array sizes. This pattern doesn't translate to any JS representation and requires manual bindings regardless of approach.

## Generated Code Specification

### C++ struct and value_object registration

For each method with output params, generate a result struct and register it with `value_object`. Struct naming: `{ClassName}_{MethodName}_Result`.

```cpp
// For Geom2dAPI_InterCurveCurve::Segment (handles stripped, const method)
struct Geom2dAPI_InterCurveCurve_Segment_Result {
  opencascade::handle<Geom2d_Curve> Curve1;
  opencascade::handle<Geom2d_Curve> Curve2;
};

value_object<Geom2dAPI_InterCurveCurve_Segment_Result>(
    "Geom2dAPI_InterCurveCurve_Segment_Result")
  .field("Curve1", &Geom2dAPI_InterCurveCurve_Segment_Result::Curve1)
  .field("Curve2", &Geom2dAPI_InterCurveCurve_Segment_Result::Curve2);
```

```cpp
// For BRepTools::UVBounds (primitives stripped, static but all-output-by-convention)
// Method is static, so primitives are kept in signature
struct BRepTools_UVBounds_Result {
  double UMin;
  double UMax;
  double VMin;
  double VMax;
};

value_object<BRepTools_UVBounds_Result>("BRepTools_UVBounds_Result")
  .field("UMin", &BRepTools_UVBounds_Result::UMin)
  .field("UMax", &BRepTools_UVBounds_Result::UMax)
  .field("VMin", &BRepTools_UVBounds_Result::VMin)
  .field("VMax", &BRepTools_UVBounds_Result::VMax);
```

### optional_override wrapper generation

**Case A: Const method — all output params stripped**

```cpp
// Geom2dAPI_InterCurveCurve::Segment (const, handles)
.function("Segment", optional_override([](
    const Geom2dAPI_InterCurveCurve& self,
    int Index) -> Geom2dAPI_InterCurveCurve_Segment_Result {
  opencascade::handle<Geom2d_Curve> Curve1, Curve2;
  self.Segment(Index, Curve1, Curve2);
  return {Curve1, Curve2};
}), allow_raw_pointers())
```

**Case B: Const method — primitive outputs stripped**

```cpp
// Geom_Surface::Bounds (const, primitives)
.function("Bounds", optional_override([](
    const Geom_Surface& self) -> Geom_Surface_Bounds_Result {
  double U1 = 0, U2 = 0, V1 = 0, V2 = 0;
  self.Bounds(U1, U2, V1, V2);
  return {U1, U2, V1, V2};
}), allow_raw_pointers())
```

**Case C: Static/free function — primitive outputs kept in signature**

```cpp
// ElCLib::AdjustPeriodic (static, primitives may be bidirectional)
.class_function("AdjustPeriodic", optional_override([](
    double UFirst, double ULast, double Precision,
    double U1, double U2) -> ElCLib_AdjustPeriodic_Result {
  ElCLib::AdjustPeriodic(UFirst, ULast, Precision, U1, U2);
  return {U1, U2};
}), allow_raw_pointers())
```

**Case D: Mixed handle + primitive outputs**

```cpp
// ChFi3d_ComputeArete (free function, handles stripped, primitives kept)
.function("ChFi3d_ComputeArete", optional_override([](
    const ChFiDS_CommonPoint& P1, const gp_Pnt2d& UV1,
    const ChFiDS_CommonPoint& P2, const gp_Pnt2d& UV2,
    const opencascade::handle<Geom_Surface>& Surf,
    double Pardeb, double Parfin,
    double tol3d, double tol2d, double tolreached,
    int IFlag) -> ChFi3d_ComputeArete_Result {
  opencascade::handle<Geom_Curve> C3d;
  opencascade::handle<Geom2d_Curve> Pcurv;
  ChFi3d_ComputeArete(P1, UV1, P2, UV2, Surf, C3d, Pcurv,
                       Pardeb, Parfin, tol3d, tol2d, tolreached, IFlag);
  return {C3d, Pcurv, Pardeb, Parfin, tolreached};
}), allow_raw_pointers())
```

### Struct deduplication

Methods with identical output param type signatures can share structs. The codegen should track `(field_name, field_type)` tuples and reuse structs when they match. In practice, most methods have unique signatures, so deduplication is an optimization rather than a requirement.

## TypeScript Bindings Changes

### processMethodOrProperty modifications

The `TypescriptBindings.processMethodOrProperty` method (line 1951 of `bindings.py`) needs three changes:

**1. Partition args into input and output:**

```python
allArgs = list(method.get_arguments())
outputArgs = [a for a in allArgs if isOutputParam(a.type)]
strippedArgs = [a for a in outputArgs if shouldStripParam(a.type, method)]
keptArgs = [a for a in allArgs if a not in strippedArgs]
```

**2. Build return type from output params:**

```python
if outputArgs:
    fields = []
    for arg in outputArgs:
        name = arg.spelling or f"arg{allArgs.index(arg)}"
        ts_type = self.resolve_type(arg.type, templateDecl, templateArgs)
        fields.append(f"{name}: {ts_type}")

    if method.result_type.spelling != "void":
        orig = self.getTypescriptDefFromResultType(method.result_type, ...)
        fields.insert(0, f"result: {orig}")

    returnType = "{ " + "; ".join(fields) + " }"
else:
    returnType = self.getTypescriptDefFromResultType(method.result_type, ...)
```

**3. Emit args from keptArgs only:**

```python
args = ", ".join([self.getTypescriptDefFromArg(a, i, templateDecl, templateArgs)
                  for i, a in enumerate(keptArgs)])
```

### Resulting TypeScript signatures

| C++ Method                                                                | Current TS                                                                 | New TS                                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Segment(int, Handle<Geom2d_Curve>&, Handle<Geom2d_Curve>&) const`        | `Segment(Index: number, Curve1: Geom2d_Curve, Curve2: Geom2d_Curve): void` | `Segment(Index: number): { Curve1: Geom2d_Curve; Curve2: Geom2d_Curve }`                                                                              |
| `Bounds(double&, double&, double&, double&) const`                        | `Bounds(U1: number, U2: number, V1: number, V2: number): void`             | `Bounds(): { U1: number; U2: number; V1: number; V2: number }`                                                                                        |
| `static UVBounds(const TopoDS_Face&, double&, double&, double&, double&)` | `static UVBounds(F: TopoDS_Face, UMin: number, ...): void`                 | `static UVBounds(F: TopoDS_Face, UMin: number, UMax: number, VMin: number, VMax: number): { UMin: number; UMax: number; VMin: number; VMax: number }` |
| `static AdjustPeriodic(double, double, double, double&, double&)`         | `static AdjustPeriodic(UFirst: number, ..., U1: number, U2: number): void` | `static AdjustPeriodic(UFirst: number, ULast: number, Precision: number, U1: number, U2: number): { U1: number; U2: number }`                         |

## Consumer DX Comparison

### Handle output params (Segment)

```typescript
// BEFORE — 4 dummy allocations, stale pointer crash
const ax1 = new oc.gp_Ax2d();
const ax2 = new oc.gp_Ax2d();
const h1 = new oc.Geom2d_Line(ax1);
const h2 = new oc.Geom2d_Line(ax2);
try {
  intersector.Segment(i, h1, h2);
} catch (e) {
  h1.delete();
  h2.delete();
  ax1.delete();
  ax2.delete();
  continue;
}
yield new Curve2D(h1); // crashes — stale $$.ptr
h2.delete();
ax1.delete();
ax2.delete();

// AFTER — clean destructuring, no stale pointers
try {
  const { Curve1, Curve2 } = intersector.Segment(i);
  Curve2.delete();
  yield new Curve2D(Curve1);
} catch (e) {
  continue;
}
```

### Primitive output params — const method (Bounds)

```typescript
// BEFORE — wrapper objects, @ts-expect-error
const u1 = { current: 0 };
const u2 = { current: 0 };
const v1 = { current: 0 };
const v2 = { current: 0 };
// @ts-expect-error missing type in oc
surface.Bounds(u1, u2, v1, v2);
return { u1: u1.current, u2: u2.current, v1: v1.current, v2: v2.current };

// AFTER — correct types, destructured
const { U1, U2, V1, V2 } = surface.Bounds();
```

### Primitive output params — bidirectional (AdjustPeriodic)

```typescript
// BEFORE — wrapper objects, @ts-expect-error
const u1Ref = { current: u1 };
const u2Ref = { current: u2 };
// @ts-expect-error
oc.ElCLib.AdjustPeriodic(0, 2 * Math.PI, 1e-6, u1Ref, u2Ref);
u1 = u1Ref.current;
u2 = u2Ref.current;

// AFTER — natural function call, destructured return
const { U1, U2 } = oc.ElCLib.AdjustPeriodic(0, 2 * Math.PI, 1e-6, u1, u2);
```

## What Gets Removed

### C++ template helpers

`getReferenceValue<T>` and `updateReferenceValue<T>` in `generateBindings.py` (lines 239-254) are no longer needed. The `emscripten::val`-based parameter substitution in the wrapper branch is replaced by `value_object` returns.

### bindings.py wrapper branch

The entire `if any(argsNeedingWrapper) or returnNeedsWrapper:` branch (lines 932-1064) in `Bindings.processMethodOrProperty` is replaced by the new output-param detection and `value_object` return codegen.

### emscripten::val parameter types

Output params no longer use `emscripten::val` as their wire type. Handles are stripped entirely; primitives are passed as their native types.

## Edge Cases

### E1: Methods with non-void return AND output params

When the C++ method returns a value AND has output params, include the original return as a `result` field:

```cpp
// Hypothetical: bool SomeMethod(int index, Handle<Geom_Curve>& outCurve) const
// Return type: { result: boolean; outCurve: Geom_Curve }
```

### E2: Single output param

For consistency, single output params still return an object rather than unwrapping to a bare value. This avoids special-casing and makes the API predictable.

### E3: Array-as-reference (`BSplCLib::Bohm`, `BSplCLib::Eval`)

These use `double&` as flat C-style array pointers — a low-level numerical trick where `int Dimension` indicates array size. This pattern doesn't translate to the `value_object` approach and requires manual bindings. The codegen should detect these (multiple `double&` params with adjacent `int` dimension/degree params) and skip them, or fall back to the existing `emscripten::val` pattern.

### E4: Overloaded methods with mixed output patterns

When a method has overloads where some have output params and some don't, the codegen must handle them independently. The `processMethodGroup` in `TypescriptBindings` already partitions overloads — the output-param detection integrates into this existing flow.

### E5: Template class methods

Template methods (e.g., `NCollection_Array1<T>::Value(int, T&)`) require the same detection logic applied after template argument substitution. The existing `templateArgs` plumbing in `processMethodOrProperty` handles this.

### E6: Naming collisions in return object

If a method has both a named output param and a non-void return, and the output param happens to be named `result`, the codegen should use a disambiguated name (e.g., `returnValue` for the method's return, or suffix the param name).

## Recommendations

| #   | Action                                                                                                                                       | Priority | Effort | Impact |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Add `isOutputParam` / `isHandleOutputParam` / `isPrimitiveOutputParam` detection functions to `bindings.py`                                  | P0       | Low    | High   |
| R2  | Generate `value_object` result structs and registrations in `generateBindings.py` preamble                                                   | P0       | Medium | High   |
| R3  | Replace the `needsWrapper` / `emscripten::val` branch with `optional_override` + `value_object` return in `Bindings.processMethodOrProperty` | P0       | Medium | High   |
| R4  | Update `TypescriptBindings.processMethodOrProperty` to strip/keep params and emit object return types                                        | P0       | Medium | High   |
| R5  | Update `TypescriptBindings.processMethodGroup` with same logic for overloaded methods                                                        | P0       | Medium | Medium |
| R6  | Remove `getReferenceValue` / `updateReferenceValue` template helpers from `generateBindings.py`                                              | P1       | Low    | Low    |
| R7  | Update replicad `intersections.ts` to use return-value API                                                                                   | P1       | Low    | Medium |
| R8  | Rebuild opencascade.js + replicad and verify gridfinity-box benchmark passes                                                                 | P0       | High   | High   |

## References

### Emscripten upstream issues

- [#4583: Embind smart pointer is incorrect after resetting](https://github.com/emscripten-core/emscripten/issues/4583) — exact stale-pointer bug, closed `wontfix` (2016)
- [#17765: Why doesn't RegisteredPointer dereference via $$.smartPtr?](https://github.com/emscripten-core/emscripten/issues/17765) — Embind maintainer acknowledged perf trade-off (2022)
- [#13338: References to C++ built-in datatypes with Embind?](https://github.com/emscripten-core/emscripten/issues/13338) — @donalffons designed the `{ current: value }` pattern (2021)
- [#21692: Add return value policy option for function bindings](https://github.com/emscripten-core/emscripten/pull/21692) — recent Embind improvements, not applicable to output params

### opencascade.js discussions

- [Discussion #27: Way forward](https://github.com/donalffons/opencascade.js/discussions/27) — @donalffons and @bitbybit-dev discuss `{ current: value }` pattern and immutable return alternatives
- [Issue #55: Pass by reference APIs](https://github.com/donalffons/opencascade.js/issues/55) — community discussion on `Standard_Real&` and `emscripten::val` solutions

### Related research

- `docs/research/embind-smart-pointer-stale-ptr.md` — root cause of the `$$.ptr` caching bug
- `docs/research/embind-return-strategy-benchmarks.md` — `value_object` vs `value_array` vs `emscripten::val` performance comparison (value_object recommended: ~0.9µs/call, equivalent to value_array with superior DX)
- `docs/research/wasm-smart-pointer-landscape.md` — survey of smart pointer handling across WASM projects
