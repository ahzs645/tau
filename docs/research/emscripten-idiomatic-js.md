---
title: 'Idiomatic JavaScript SDK from C++ via Emscripten Embind'
description: 'Analysis of opencascade.js TypeScript API against idiomatic JavaScript/TypeScript conventions and DX improvement opportunities.'
status: active
created: '2026-03-10'
updated: '2026-03-10'
category: reference
---

# Idiomatic JavaScript SDK from C++ via Emscripten Embind

Comprehensive analysis of the opencascade.js TypeScript API surface (`opencascade_full.d.ts`, 191,188 lines) against idiomatic JavaScript/TypeScript conventions. Identifies all non-idiomatic patterns produced by the current binding generation pipeline and catalogs opportunities to transform the API into a world-class JavaScript SDK for the OCCT CAD kernel.

## Executive Summary

The current opencascade.js API exposes 6,178 classes, 329 enums, and ~12,000 methods in a flat namespace with C++ naming conventions throughout. While functionally complete, the API requires JavaScript developers to learn C++ idioms (PascalCase methods, `Nb*` abbreviations, `_N` overload suffixes, manual `delete()`, constructor subclasses). This research identifies 15 categories of DX improvements — from zero-effort naming transforms to architectural changes like ES module named exports — that would make OpenCASCADE accessible to the JavaScript mainstream.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Current API Inventory](#current-api-inventory)
- [Findings: Non-Idiomatic Patterns](#findings-non-idiomatic-patterns)
- [Findings: Things That Work Well](#findings-things-that-work-well)
- [Embind Feature Catalog (2024-2026)](#embind-feature-catalog-2024-2026)
- [Recommendations](#recommendations)
- [Risk Assessment](#risk-assessment)
- [References](#references)
- [Appendix A: Embind Code Generation Pattern Catalog](#appendix-a-embind-code-generation-pattern-catalog)
- [Appendix B: Type Resolution Pipeline](#appendix-b-type-resolution-pipeline)

## Problem Statement

opencascade.js is a full WASM binding of OpenCASCADE Technology (OCCT), the world's most powerful open-source CAD kernel. The current TypeScript API is a 1:1 transliteration of the C++ API — every class, method, and enum preserves its original C++ name and calling convention. This creates a high barrier for JavaScript developers who must:

1. Learn C++ naming conventions (PascalCase methods, `Nb*` abbreviations, `the*` parameter prefixes)
2. Navigate 6,500+ flat entries on the `oc` instance object with no module organization
3. Understand C++ overload disambiguation (`_1`, `_2`, `_3` suffixes) and constructor subclass patterns (`new oc.BRepBuilderAPI_MakeEdge_15(...)`)
4. Manually call `delete()` on every object to prevent memory leaks
5. Work with output parameters via the undocumented `{ current: value }` pattern
6. Accept `any` types where the generator fails to resolve C++ types

The goal is to identify every opportunity — from simple naming transforms to architectural changes — that would produce a JavaScript-native SDK while maintaining full access to OCCT's capabilities.

## Methodology

1. **d.ts audit**: Structural analysis of `opencascade_full.d.ts` (191,188 lines) using grep, semantic search, and targeted reading
2. **Binding generator analysis**: Full code review of `bindings.py`, `buildFromYaml.py`, `generateBindings.py`, `TuInfo.py`, `Common.py`
3. **Policy mapping**: Evaluated every pattern against `docs/policy/library-api-policy.md`
4. **Web research**: Surveyed Emscripten embind features added 2024-2026, including `--emit-tsd`, `MODULARIZE=instance`, `Symbol.dispose`, `register_type`, `enum_value_type::string`
5. **Conversation mining**: Extracted all DX insights from prior development (Handle\_ collapse, enum reform, overload disambiguation, namespace binding)
6. **Peer comparison**: Reviewed API design of CanvasKit (Skia), OpenCV.js, and Emscripten's own generated TypeScript

## Current API Inventory

| Metric                                     | Count          |
| ------------------------------------------ | -------------- |
| Total lines in `.d.ts`                     | 191,188        |
| Top-level classes (no extends)             | 1,447          |
| Total classes (including `_N` subclasses)  | 6,178          |
| Constructor overload subclasses (`_N`)     | 2,018          |
| Enums (const object pattern)               | 329            |
| `Set*()` methods                           | 4,243          |
| `Get*()` methods                           | 1,164          |
| `Is*()` methods                            | 1,959          |
| `Nb*()` methods                            | 1,112          |
| `static` methods                           | 6,864          |
| `delete(): void` methods                   | 4,160          |
| Method overload suffixes (`_1`, `_2`, ...) | 2,528          |
| `OpenCascadeInstance` entries              | ~6,508         |
| `Handle_*` classes                         | 0 (eliminated) |
| `namespace` blocks                         | 1 (`FS` only)  |
| Constructor overload max suffix            | `_35`          |

## Findings: Non-Idiomatic Patterns

### Finding 1: PascalCase Methods (C++ Convention)

All ~12,000 methods use PascalCase, the OCCT C++ convention. JavaScript convention is camelCase.

```typescript
// Current: C++ convention
shape.IsNull();
point.SetCoord(1.0, 2.0, 3.0);
explorer.NbShapes();
curve.FirstParameter();

// Idiomatic JS
shape.isNull();
point.setCoord(1.0, 2.0, 3.0);
explorer.nbShapes(); // or .shapeCount
curve.firstParameter();
```

**Scale**: ~12,000 methods across 1,447 base classes.

**Implementation**: String transform in `bindings.py` TypeScript generation — first character lowercased. The embind C++ name stays PascalCase (embind names don't need to match the TS declaration if we control both). However, embind registers the JS name from the string passed to `.function("Name", ...)`, so the C++ generator must emit the camelCase name.

**Complexity**: Low for the transform itself. Risk of collision with `delete` (already lowercase) and `constructor` (reserved). Need a reserved-word exclusion list.

### Finding 2: Constructor Subclass Pattern (`ClassName_N`)

When a C++ class has multiple constructors with the same arity, each overload becomes a **separate TypeScript class** inheriting from the base:

```typescript
// Current: construct via numbered subclass
const edge = new oc.BRepBuilderAPI_MakeEdge_15(curve, surface, first, last);
const box = new oc.BRepPrimAPI_MakeBox_3(corner1, corner2);

// Idiomatic JS: TypeScript union overloads or factory functions
const edge = new oc.BRepBuilderAPI_MakeEdge(curve, surface, first, last);
const box = oc.BRepPrimAPI.makeBox(corner1, corner2);
```

**Scale**: 2,018 constructor subclasses, up to `_35` per class. Each appears as a separate entry in `OpenCascadeInstance`.

**Root cause**: Embind can overload constructors by **arity** but not by **type**. When two constructors have the same parameter count, the generator creates separate `_N` subclass wrappers.

**Implementation paths**:

- **Path A (partial)**: Already implemented — when all constructors have unique arities, native Embind overloading is used (multiple `.constructor<>()` calls, single class).
- **Path B (union types)**: Use `register_type` to declare a TypeScript union of accepted argument patterns, combined with a single factory lambda that dispatches by runtime type checking.
- **Path C (factory functions)**: Generate `makeBox(...)` factory functions instead of constructor overloads.

### Finding 3: Method Overload Suffixes (`Method_1`, `Method_2`)

Same-arity method overloads get `_N` suffixes:

```typescript
// Current: disambiguated by suffix
edge.Init_1(curveHandle);
edge.Init_2(curveHandle, p1, p2);
edge.Init_12(curveHandle, surface, v1, v2, p1, p2);

// Idiomatic JS: descriptive names or union params
edge.init(curveHandle);
edge.initWithParams(curveHandle, p1, p2);
edge.initWithSurfaceAndVertices(curveHandle, surface, v1, v2, p1, p2);
```

**Scale**: 2,528 suffixed methods across the API.

**Root cause**: Same as constructors — embind can't dispatch by type.

**Note**: Some overloads are already resolved at unique arities (no suffix needed). The `_N` pattern only applies when arity collides. Renaming to descriptive names requires semantic understanding of parameter types — feasible via libclang AST but requires heuristics.

### Finding 4: Get/Set Accessor Pairs → Properties

C++ uses `GetX()`/`SetX()` methods. JavaScript uses properties or getter/setter pairs.

```typescript
// Current: C++ getter/setter methods
const x = point.X();
point.SetX(5.0);
const tol = BRep_Tool.Tolerance(edge);

// Idiomatic JS: property access
const x = point.x;
point.x = 5.0;
const tol = BRep_Tool.tolerance(edge);
```

**Scale**: 4,243 `Set*` + 1,164 `Get*` methods. Many form natural pairs.

**Implementation**: Embind's `.property("name", &getter, &setter)` already supports this. The binding generator could detect matching `Get*`/`Set*` or `X()`/`SetX()` pairs and emit property bindings instead. Embind also supports `return_value_policy::reference()` on properties to avoid copying.

**Caveat**: Many OCCT "getters" return by value or const reference to internal state. Properties that return OCCT objects would create copies requiring `delete()` unless `return_value_policy::reference()` is used. This needs careful case-by-case analysis.

### Finding 5: `Nb*` Abbreviation (French Origin)

OCCT uses `Nb` prefix for count methods — abbreviated from the French "Nombre de" (number of). This is unintuitive for JS developers.

```typescript
// Current: French abbreviation
mesh.NbNodes();
explorer.NbShapes();
array.NbThreads();

// Idiomatic JS
mesh.nodeCount; // or mesh.nodes.length
explorer.shapeCount;
array.threadCount;
```

**Scale**: 1,112 `Nb*` methods.

**Implementation**: Rename in the embind registration string. Replace `Nb` prefix with a suffix like `Count`, or emit as a property.

### Finding 6: Flat Namespace — 6,500+ Entries on `oc`

Every class, constructor subclass, and enum is a direct property of the `oc` instance. There is no module organization.

```typescript
// Current: flat, overwhelming
oc.BRepPrimAPI_MakeBox_3
oc.BRepAlgoAPI_Fuse_3
oc.BRepBuilderAPI_MakeEdge_15
oc.TopAbs_ShapeEnum
oc.gp_Pnt_2

// Organized by OCCT package
oc.BRepPrimAPI.MakeBox(...)
oc.gp.Pnt(x, y, z)
oc.TopAbs.ShapeEnum
```

**Scale**: ~6,508 entries in `OpenCascadeInstance`.

**Implementation paths**:

- **Path A (TypeScript namespaces in d.ts)**: Group types into TS `namespace` blocks by OCCT package prefix (`gp`, `BRep`, `Geom`, `TopoDS`, etc.). The runtime object stays flat but the TS declarations provide IDE-level organization.
- **Path B (`MODULARIZE=instance` + named exports)**: Emscripten's `MODULARIZE=instance` (November 2024) produces named ES module exports: `import { gp_Pnt, BRepPrimAPI_MakeBox } from './opencascade.mjs'`. Combined with `EMBIND_AOT`, this enables tree-shaking.
- **Path C (namespace objects via dummy structs)**: Use the `TopoDS_Cast → TopoDS` pattern — register dummy structs as package names, with static factory methods as class constructors.

### Finding 7: Enum Member Prefix Duplication

Enum members repeat the enum name as a prefix:

```typescript
// Current: doubled prefix
oc.TopAbs_ShapeEnum.TopAbs_COMPOUND; // "TopAbs" appears twice
oc.TopAbs_ShapeEnum.TopAbs_SOLID;
oc.GeomAbs_CurveType.GeomAbs_Line;

// Idiomatic JS: short member names
oc.TopAbs_ShapeEnum.COMPOUND;
oc.TopAbs_ShapeEnum.SOLID;
oc.GeomAbs_CurveType.Line;
```

**Scale**: 329 enums, all with duplicated prefixes.

**Root cause**: OCCT C++ enums are unscoped — `TopAbs_COMPOUND` is a global constant. The enum name is added by the binding generator, but the member name retains the original global name.

**Implementation**: Strip the enum name prefix from member names in `processEnum()`. The embind C++ registration can keep the original name; the TS declaration uses the short form. The runtime behavior is identical since enum values are numeric.

### Finding 8: Manual `delete()` Without Modern Cleanup Patterns

Every OCCT object requires manual `delete()`. There is no `Symbol.dispose`, no `Disposable` interface, no `using` support.

```typescript
// Current: manual delete, easy to forget
const box = new oc.BRepPrimAPI_MakeBox_3(corner1, corner2);
const shape = box.Shape();
// ... use shape ...
shape.delete();
box.delete();

// Idiomatic JS: explicit resource management
{
  using box = new oc.BRepPrimAPI_MakeBox(corner1, corner2);
  using shape = box.Shape();
  // ... use shape ...
  // automatically deleted when scope exits
}
```

**Emscripten support**: `Symbol.dispose` was merged in PR #23818 (March 2025). The `ClassHandle` base interface now includes `[Symbol.dispose](): void`. This is zero-cost — it just calls `delete()`.

**Implementation**: Enable by ensuring the Emscripten version supports it. The `--emit-tsd` output already includes `Symbol.dispose` in the `ClassHandle` interface. For Safari compatibility (no `using` support), the `try/finally` pattern with `.delete()` remains the fallback.

### Finding 9: `{ current: value }` Output Parameters — Undocumented, Untyped

When C++ methods have output-by-reference parameters (`Standard_Real&`, enum refs), the binding generator wraps them to accept `{ current: value }` JavaScript objects. This pattern is invisible in the `.d.ts` — the parameter is typed as the underlying type (e.g., `number`), not as `{ current: number }`.

```typescript
// d.ts says: GetValues(X: number, Y: number): void
// But actual usage requires:
const xRef = { current: 0 };
const yRef = { current: 0 };
point.GetValues(xRef, yRef);
console.log(xRef.current, yRef.current);
```

**Implementation**: Use `register_type<T>(name, definition)` (PR #25272, October 2025) to declare a named TypeScript type:

```cpp
EMSCRIPTEN_DECLARE_VAL_TYPE(RefNumber);
register_type<RefNumber>("Ref<number>", "{ current: number }");
```

Then use `RefNumber` as the parameter type in wrapping lambdas. The `.d.ts` would show `{ current: number }` instead of `number`.

### Finding 10: Unresolved `any` Types

Some methods have parameters or return types resolved as `any` due to unresolved C++ types (nested types with `::`, unbound template instantiations, `NCollection_DataMap`, `NCollection_IndexedDataMap`).

**Scale**: The code generator's fallback chain ends at `any` when no match is found. `NCollection_DataMap<K,V>` and `NCollection_IndexedDataMap<K,V>` explicitly return `"any"` (line 1012 of `bindings.py`).

**Implementation**: Use `register_type` to provide specific TypeScript types for known `val`-typed parameters, and extend the type resolution chain for more container types.

### Finding 11: No Tree-Shaking — Full Module Always Loaded

The current build produces a single monolithic WASM + JS module. Even if a developer only uses `gp_Pnt` and `BRepPrimAPI_MakeBox`, the entire 14MB WASM is loaded.

**Emscripten support**: `MODULARIZE=instance` + `EMBIND_AOT` (2024) enables named ES module exports, which unlocks bundler-level tree-shaking. Combined with per-symbol `.o` files (already produced by the build system), dead code elimination at the WASM level is possible via `wasm-opt --dce`.

**Implementation**: This is a build system change, not a binding generator change. The YAML custom build system already supports selecting subsets of symbols.

### Finding 12: `Standard_*` Type Aliases — C++ Leakage

The `.d.ts` defines C++ type aliases that leak implementation details:

```typescript
type Standard_Boolean = boolean;
type Standard_Real = number;
type Standard_Integer = number;
type Standard_CString = string;
```

While these resolve to primitives, their presence in the `.d.ts` adds noise. Methods using these types show `Standard_Real` in IDE tooltips instead of `number`.

**Implementation**: The type aliases are defined at lines 184520-184527 of `buildFromYaml.py`. They're needed for the `resolve_type()` chain but could be inlined at point of use rather than exported.

### Finding 13: C++ Parameter Naming Conventions

OCCT parameters use the `the` prefix convention:

```typescript
// Current: C++ parameter naming
constructor(theXp: number, theYp: number, theZp: number);
SetTolerance(theTolerance: number): void;
Distance(theOther: gp_Pnt): number;

// Idiomatic JS
constructor(x: number, y: number, z: number);
setTolerance(tolerance: number): void;
distance(other: gp_Pnt): number;
```

**Scale**: Majority of parameters across all methods.

**Implementation**: Strip `the` prefix and lowercase first character in the TypeScript parameter names emitted by the binding generator. Parameter names in embind C++ don't affect runtime behavior — they're TS-only cosmetic changes.

### Finding 14: Factory Methods Disguised as Constructors

OCCT's algorithm classes serve dual purposes — they're both constructors and algorithm runners:

```typescript
// Current: constructor that runs an algorithm
const fuse = new oc.BRepAlgoAPI_Fuse_3(shape1, shape2);
const result = fuse.Shape();
fuse.delete();

// Idiomatic JS: factory function
const result = oc.BRepAlgoAPI.fuse(shape1, shape2);
```

**Scale**: Major algorithm classes (`BRepAlgoAPI_Fuse`, `BRepPrimAPI_MakeBox`, `BRepFilletAPI_MakeFillet`, etc.).

**Implementation**: Could generate high-level factory functions alongside the raw class bindings. This is an API-design layer above the binding generator.

### Finding 15: Value Types vs Reference Types Not Distinguished

Simple geometry types like `gp_Pnt` (3D point), `gp_Vec` (3D vector), `gp_Dir` (direction) are heap-allocated WASM objects requiring `delete()`. In JS, these should be plain `{ x, y, z }` objects.

```typescript
// Current: heap-allocated, requires delete
const pt = new oc.gp_Pnt_2(1, 2, 3);
const x = pt.X();
pt.delete();

// Idiomatic JS: plain object (value_object pattern)
const pt = { x: 1, y: 2, z: 3 };
// or: [1, 2, 3] via value_array
```

**Emscripten support**: `value_object<T>()` and `value_array<T>()` marshal C++ structs as plain JS objects/tuples across the boundary. No `delete()` needed — data is copied, not heap-referenced.

**Trade-off**: Value objects are copied on every boundary crossing. For `gp_Pnt` (24 bytes), this is negligible. For large objects, the copy overhead matters. Only applicable to small, immutable-in-practice types.

**Candidate types**: `gp_Pnt` (3 doubles), `gp_Vec` (3 doubles), `gp_Dir` (3 doubles), `gp_Pnt2d` (2 doubles), `gp_Vec2d` (2 doubles), `gp_XYZ` (3 doubles), `gp_XY` (2 doubles).

## Findings: Things That Work Well

### Working Well 1: Handle Transparency

The smart pointer (`opencascade::handle<T>`) system is fully transparent. No `Handle_*` prefix classes appear in the API. The `smart_ptr_trait` specialization teaches embind to manage OCCT's intrusive reference-counted handles natively. `isNull()` and `nullify()` are inherited by all 742 `Standard_Transient`-derived classes via embind's prototype chain.

### Working Well 2: Enum Const Object Pattern

Enums use the branded numeric literal pattern (`export declare const TopAbs_ShapeEnum: { readonly TopAbs_COMPOUND: 0; ... }` with derived union type). This provides type safety, serialization, `===` comparison, and IDE autocomplete. Implemented via `enum_value_type::number`.

### Working Well 3: JSDoc from Doxygen

~65% class coverage, ~52% method coverage. Constructor and method overloads are disambiguated by arity and `overload_index`. Enum members have per-member docs where Doxygen data exists. The `@deprecated` tag is propagated.

### Working Well 4: Type Resolution

The AST-driven `resolve_type()` chain handles `handle<T>` unwrapping, const/ref stripping, template substitution, nested types, and builtin mapping. Handle types in return values and parameters are automatically unwrapped to the inner type.

### Working Well 5: Unique-Arity Overload Collapsing

When all overloads of a method or constructor have unique arities, native embind overloading is used — no `_N` suffix, no subclass pattern. This was a key DX improvement implemented in this conversation.

### Working Well 6: CString Handling

`const char*` parameters are automatically wrapped to accept `std::string` (which embind maps to JS `string`). Return values go through null-checking with `emscripten::val::null()` fallback.

## Embind Feature Catalog (2024-2026)

Features available in modern Emscripten that the binding generator could leverage:

| Feature                                          | Emscripten Version   | Impact                                            |
| ------------------------------------------------ | -------------------- | ------------------------------------------------- |
| `--emit-tsd` (native d.ts generation)            | 3.1.57+              | Could replace custom Python TS generator          |
| `Symbol.dispose` on ClassHandle                  | PR #23818 (Mar 2025) | Enables `using` for automatic cleanup             |
| `MODULARIZE=instance` + named exports            | PR #22867 (Nov 2024) | Tree-shaking, `import { gp_Pnt }` syntax          |
| `EMBIND_AOT` (compile-time invokers)             | PR #20796 (2024)     | 5-10x faster startup, CSP-compliant               |
| `register_type<T>(name, definition)`             | PR #25272 (Oct 2025) | Precise TS types for `val` parameters             |
| `enum_value_type::string`                        | 2024-2025            | String enum values for serialization              |
| `return_value_policy::reference()` on properties | PR #21935 (Jun 2024) | Avoid copy-and-leak on property access            |
| `nonnull()` policy                               | 2024+                | Removes `\| null` from pointer return types       |
| `std::optional<T>` → `T \| undefined`            | 2024+                | Idiomatic nullable handling                       |
| Getter/setter split typing                       | PR #22415 (Aug 2024) | `get foo(): string; set foo(value: EmbindString)` |
| `Iterable<T>` on vector/containers               | 2024+                | `for...of` on C++ containers                      |

## Recommendations

| #   | Action                                                                     | Priority | Effort | Impact                                                                           | Breaking?     |
| --- | -------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------- | ------------- |
| R1  | camelCase all method names                                                 | P0       | Medium | High — eliminates the most visible C++ artifact                                  | Yes           |
| R2  | Strip enum member prefix duplication                                       | P0       | Low    | High — `TopAbs_ShapeEnum.COMPOUND` instead of `TopAbs_ShapeEnum.TopAbs_COMPOUND` | Yes           |
| R3  | Enable `Symbol.dispose` on all classes                                     | P0       | Low    | High — enables `using` keyword for RAII cleanup                                  | No            |
| R4  | Rename `TopoDS_Cast` to `TopoDS`                                           | P1       | Low    | Medium — mirrors original C++ `TopoDS::Edge()`                                   | Yes           |
| R5  | Type output params as `{ current: T }` in d.ts                             | P1       | Medium | Medium — documents the ref pattern, enables IDE support                          | No            |
| R6  | Strip `the` prefix from parameter names                                    | P1       | Low    | Medium — cleaner IDE tooltips                                                    | No            |
| R7  | Expand `Nb*` to `*Count` or property                                       | P1       | Low    | Medium — removes French abbreviation                                             | Yes           |
| R8  | Generate Get/Set pairs as properties                                       | P2       | High   | High — most natural JS API, but complex edge cases                               | Yes           |
| R9  | Group types into TS `namespace` blocks by OCCT package                     | P2       | Medium | High — organizes 6,500+ entries in IDE autocomplete                              | No (additive) |
| R10 | Use `value_object` for small geometry types (`gp_Pnt`, `gp_Vec`, `gp_Dir`) | P2       | High   | High — eliminates `delete()` for common types                                    | Yes           |
| R11 | Consolidate constructor subclasses via factory functions                   | P2       | High   | High — eliminates `_N` suffix pattern                                            | Yes           |
| R12 | Adopt `--emit-tsd` for base TypeScript generation                          | P2       | High   | Medium — leverages native Emscripten TS, reduces Python code                     | No            |
| R13 | Explore `MODULARIZE=instance` for named exports                            | P3       | High   | High — enables tree-shaking and `import { Class }`                               | Yes           |
| R14 | Replace `Standard_*` type aliases with inline primitives                   | P3       | Low    | Low — cleaner IDE tooltips                                                       | No            |
| R15 | Use `register_type` for precise `val` parameter types                      | P3       | Medium | Medium — eliminates `any` in d.ts                                                | No            |

### Priority definitions

- **P0**: Do first. High impact, relatively low risk. Forms the foundation for further improvements.
- **P1**: Do next. Medium effort with clear DX benefits.
- **P2**: Significant architectural changes. High impact but require careful design.
- **P3**: Nice-to-have. Lower priority or depends on P0-P2 being complete.

## Risk Assessment

### camelCase migration (R1)

The single largest API change. Every consumer must update every method call. Mitigations:

- Dual registration: emit both PascalCase and camelCase bindings during a transition period, with the PascalCase variant marked `@deprecated`
- Codemod: AST-based transform using TypeScript compiler API
- The embind name change is mechanical — first character lowercased, applied in `processMethodOrProperty`

### Value object migration (R10)

Converting `gp_Pnt` from a heap class to a `value_object` changes the API fundamentally:

- `new gp_Pnt_2(1, 2, 3)` → `{ x: 1, y: 2, z: 3 }`
- `point.X()` → `point.x`
- No `delete()` needed
- Methods on `gp_Pnt` (like `Distance()`, `Mirrored()`) would need to become free functions

This is a high-reward, high-risk change. Consider introducing it as a parallel API (`gp.point(1, 2, 3)`) rather than replacing the existing class binding.

### Named exports (R13)

`MODULARIZE=instance` is still marked experimental in Emscripten. It requires `EMBIND_AOT` and changes the module initialization pattern. The current `init()` → `OpenCascadeInstance` pattern would be replaced by `import { init, gp_Pnt } from 'opencascade.js'`. This is the most architecturally significant change and should be validated in a spike before committing.

## References

- Related: `docs/research/build-flag-audit.md`
- Related: `docs/research/ocjs-wasm-optimization.md`
- Related: `docs/research/v76-vs-v8-binding-diff.md`
- Related: `docs/research/occt-v8-migration.md`
- Policy: `docs/policy/library-api-policy.md`
- Emscripten embind docs: https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html
- Emscripten `Symbol.dispose` PR: https://github.com/nicobrinkkemper/opencascade.js/pull/23818
- Emscripten `MODULARIZE=instance`: https://github.com/nicobrinkkemper/opencascade.js/pull/22867
- Emscripten `register_type` named aliases: https://github.com/nicobrinkkemper/opencascade.js/pull/25272

## Appendix A: Embind Code Generation Pattern Catalog

Complete catalog of every distinct pattern the binding generator produces.

### A1. Class Binding Variants

| Variant               | Trigger                       | Embind C++                               | TypeScript                      |
| --------------------- | ----------------------------- | ---------------------------------------- | ------------------------------- |
| Simple class          | No base, no Handle            | `class_<T>("T")`                         | `export declare class T`        |
| Class with base       | Has public base class         | `class_<T, base<B>>("T")`                | `T extends B`                   |
| Transient class       | Inherits `Standard_Transient` | Adds `.smart_ptr<handle<T>>("Handle_T")` | Transparent (no Handle\_ in TS) |
| Abstract class        | Has pure virtual methods      | No constructor emitted                   | No `constructor()` in TS        |
| Non-public destructor | Private/protected dtor        | `raw_destructor<T>` no-op specialization | `delete(): void` still emitted  |

### A2. Constructor Variants

| Variant               | Trigger                             | Embind C++                                                                 | TypeScript                                 |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Default               | No public constructors              | `.constructor<>()`                                                         | `constructor()`                            |
| Single                | One public constructor              | `.constructor<Args...>()`                                                  | `constructor(args)`                        |
| Multi unique-arity    | All ctors have different arg counts | Multiple `.constructor<>()`                                                | Multiple `constructor()` overloads         |
| Same-arity overloaded | Any arity collision                 | Subclass `T_N : public T` with `class_<T_N, base<T>>`                      | `class T_N extends T { constructor(...) }` |
| Transient constructor | Transient + constructor             | `.constructor(optional_override([...] { return handle<T>(new T(...)); }))` | `constructor(args)`                        |
| CString arg           | `const char*` param                 | `std::string` wrapper + `.c_str()` delegation                              | `string` param type                        |

### A3. Method Variants

| Variant                 | Trigger                          | Embind C++                                                                         | TypeScript                                     |
| ----------------------- | -------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Simple                  | No overloads, no wrapping needed | `.function("Name", &T::Name)`                                                      | `Name(args): ret`                              |
| Static                  | `static` keyword                 | `.class_function("Name", &T::Name)`                                                | `static Name(args): ret`                       |
| Unique-arity overloaded | Different arg counts             | `select_overload<Sig, T>(&T::Name)`                                                | Same name, different signatures                |
| Same-arity overloaded   | Arity collision                  | `"Name_N"` + `select_overload`                                                     | `Name_1(...)` / `Name_2(...)`                  |
| Ref-to-builtin wrapper  | `Standard_Real&` etc.            | `optional_override` + `emscripten::val` + `getReferenceValue/updateReferenceValue` | Normal typed args (should be `{ current: T }`) |
| CString return wrapper  | Returns `const char*`            | `emscripten::val` + null check + `std::string` cast                                | `string` return                                |

### A4. Enum Pattern

| Step               | Output                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Embind C++         | `enum_<E>("E", enum_value_type::number).value("E_VALUE", E_VALUE)`      |
| TypeScript (type)  | `export type E = typeof E[keyof typeof E]`                              |
| TypeScript (const) | `export declare const E: { readonly E_VALUE: 0; readonly E_OTHER: 1; }` |

### A5. Template Typedef Pattern

A `typedef NCollection_Array1<gp_Pnt> TColgp_Array1OfPnt` is processed as the template class with substituted type parameters. The typedef name is used as the class name. Methods receive the substituted types (e.g., `Value(index: number): gp_Pnt`).

### A6. isNull / nullify / delete

| Method              | Scope                              | Mechanism                                           |
| ------------------- | ---------------------------------- | --------------------------------------------------- |
| `delete(): void`    | All classes                        | Implicit embind destructor binding                  |
| `isNull(): boolean` | `Standard_Transient` + descendants | Template `handle_isNull<T>`, bound once, inherited  |
| `nullify(): void`   | `Standard_Transient` + descendants | Template `handle_nullify<T>`, bound once, inherited |
| `Delete(): void`    | Some OCCT classes                  | C++ virtual destructor (PascalCase)                 |

## Appendix B: Type Resolution Pipeline

The `resolve_type()` method in `TypescriptBindings` follows this priority chain:

| Priority | Check                                           | Result                                   |
| -------- | ----------------------------------------------- | ---------------------------------------- |
| 1        | `opencascade::handle<T>`                        | Recursively resolve inner `T`            |
| 2        | Strip `const` / `&` / `*` qualifiers            | Continue on inner type                   |
| 3        | Template container (`NCollection_*`)            | Typedef name if bound, else inner type   |
| 4        | Nested enum/class (`Parent::Child`)             | `Parent_Child` if in exports, else `any` |
| 5        | Builtin numeric (`TypeKind.INT`, `FLOAT`, etc.) | `number`                                 |
| 6        | Builtin char (`TypeKind.CHAR_S`, etc.)          | `string`                                 |
| 7        | Bool (`TypeKind.BOOL`)                          | `boolean`                                |
| 8        | Void                                            | `void`                                   |
| 9        | Spelling-based + `convertBuiltinTypes()`        | Maps `Standard_Real` → `number`, etc.    |
| 10       | Canonical spelling in exports                   | Class name                               |
| 11       | Declaration spelling in exports                 | Class name                               |
| 12       | Fallback                                        | `any`                                    |

**Container resolution special cases**:

| Container                         | Resolution                               |
| --------------------------------- | ---------------------------------------- |
| `NCollection_Vec2<T>`             | `[number, number]`                       |
| `NCollection_Vec3<T>`             | `[number, number, number]`               |
| `NCollection_Vec4<T>`             | `[number, number, number, number]`       |
| `NCollection_DataMap<K,V>`        | `any` (unresolvable)                     |
| `NCollection_IndexedDataMap<K,V>` | `any` (unresolvable)                     |
| All other `NCollection_*<T>`      | Typedef name if bound, else resolved `T` |
