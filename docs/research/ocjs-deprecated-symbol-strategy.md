---
title: 'OpenCascade.js Deprecated Symbol Strategy'
description: 'Analysis of OCCT V8 deprecated NCollection typedef aliases, their runtime impact on WASM bindings, and strategy for OCJS_INCLUDE_DEPRECATED flag'
status: active
created: '2026-03-26'
updated: '2026-03-26'
category: architecture
related:
  - docs/research/ocjs-type-resolution-failures.md
  - docs/research/occt-v8-migration.md
---

# OpenCascade.js Deprecated Symbol Strategy

Investigation into whether OCCT V8 deprecated NCollection typedef aliases can be safely removed from opencascade.js bindings without losing functionality, and design of a forward-compatible deprecation strategy.

## Executive Summary

OCCT V8 deprecated 972 NCollection typedef headers (e.g., `TColgp_Array1OfPnt` → `NCollection_Array1<gp_Pnt>`). These are **pure type aliases** — no behavioral difference exists between the deprecated name and the underlying NCollection type. However, the deprecated typedefs currently serve as the **only Embind registration** for these NCollection template instantiations. Removing them without a replacement strategy causes **runtime failures** (unregistered type errors), not just TypeScript `any` types.

The correct forward path is a two-phase approach: (1) auto-discover which NCollection template instantiations are needed by scanning bound class method signatures, and (2) register them directly under modern names, eliminating the deprecated typedef dependency entirely. An `OCJS_INCLUDE_DEPRECATED` build flag should control whether the old typedef names are also exported as aliases for backward compatibility.

## Problem Statement

The opencascade.js binding generator for the [upstream PR](https://github.com/donalffons/opencascade.js/pull/301) currently uses 128 deprecated OCCT typedef names in `full.yml` (e.g., `TColgp_Array1OfPnt`, `TopTools_ListOfShape`) as first-class bound symbols. Additionally, `_SAFE_DEPRECATED_PREFIXES` in `Common.py` includes deprecated headers in the PCH for TypeScript type name resolution. This investigation answers:

1. Are deprecated typedefs purely cosmetic aliases, or do they carry distinct behavior?
2. What happens at runtime when a method uses a type that resolves to `any` in the `.d.ts`?
3. Can deprecated symbols be removed without losing functionality?
4. What is the heuristic for safe removal?
5. What strategy handles future OCCT deprecation waves?

## Methodology

1. **OCCT source analysis**: Examined all 972 deprecated headers in `repos/occt/src/Deprecated/NCollectionAliases/`, the `Standard_DEPRECATED` macro system in `Standard_Macro.hxx`, and OCCT V8 migration scripts in `adm/scripts/migration_800/`
2. **Binding generator analysis**: Traced the full pipeline from `full.yml` → `generateBindings.py` → `EmbindBindings.processClass` → `TypescriptBindings.processClass` to understand how deprecated typedefs become Embind registrations and `.d.ts` declarations
3. **Runtime impact analysis**: Examined generated `.cpp` binding files to determine whether `any` in `.d.ts` affects WASM runtime behavior
4. **Cross-reference scan**: Used ripgrep to identify all 137 unique NCollection template instantiations used across non-deprecated class bindings, and compared against the 128 deprecated typedef registrations

## Findings

### Finding 1: Deprecated Typedefs Are Pure Aliases

Every deprecated header in `src/Deprecated/NCollectionAliases/` follows an identical pattern:

```cpp
Standard_HEADER_DEPRECATED("... deprecated since OCCT 8.0.0. Use NCollection_Array1<gp_Pnt> directly.")
Standard_DEPRECATED("... deprecated, use NCollection_Array1<gp_Pnt> directly")
typedef NCollection_Array1<gp_Pnt> TColgp_Array1OfPnt;
```

At the C++ level, `TColgp_Array1OfPnt` and `NCollection_Array1<gp_Pnt>` are **the same type**. A function `void Foo(const TColgp_Array1OfPnt&)` has an identical signature to `void Foo(const NCollection_Array1<gp_Pnt>&)` — they cannot be overloaded against each other. No runtime behavior difference exists.

OCCT V8 has already migrated all core class headers to use `NCollection_*` directly. For example, `Geom_BSplineCurve` constructors use `const NCollection_Array1<gp_Pnt>& Poles` — not the deprecated `TColgp_Array1OfPnt` name. The deprecated headers exist solely for backward compatibility of downstream `#include` directives.

### Finding 2: `.d.ts` `any` Types Do Not Affect Runtime

The Embind C++ binding generator and the TypeScript declaration generator are **independent pipelines**:

| Aspect          | Embind (C++)                                               | TypeScript (.d.ts)                            |
| --------------- | ---------------------------------------------------------- | --------------------------------------------- |
| Type resolution | `resolveWithCanonicalFallback` / `getOriginalArgumentType` | `resolve_type` / `_resolve_template_type`     |
| Output          | `class_<T>` / `select_overload<>` in `.cpp`                | `export class` / method signatures in `.d.ts` |
| Runtime impact  | **Determines WASM behavior**                               | **None** — not consumed at runtime            |

When `resolve_type` returns `"any"`, this only affects the TypeScript declaration. The C++ Embind binding is generated from a completely separate code path that uses Clang's AST types directly. A method returning `const NCollection_Array1<gp_Pnt>&` in C++ is properly bound via `select_overload<const NCollection_Array1<gp_Pnt>&()>` regardless of what the `.d.ts` says.

**The `any` type issue is purely a TypeScript DX concern, not a runtime concern.**

### Finding 3: Deprecated Typedefs Are the Only NCollection Type Registration

This is the critical finding that prevents naive removal:

```cpp
// build/bindings/Deprecated/NCollectionAliases/TColgp_Array1OfPnt.hxx/TColgp_Array1OfPnt.cpp
EMSCRIPTEN_BINDINGS(TColgp_Array1OfPnt) {
  class_<TColgp_Array1OfPnt>("TColgp_Array1OfPnt")
    .constructor(...)
    .function("SetValue", ...)
    .function("Value", ...)
    // ...
}
```

This `class_<TColgp_Array1OfPnt>` registration is what tells Embind how to marshal `NCollection_Array1<gp_Pnt>` objects between WASM and JavaScript. Since `TColgp_Array1OfPnt` IS `NCollection_Array1<gp_Pnt>` (typedef), this single registration covers both names.

**Without this registration**, any method on any class that takes or returns `NCollection_Array1<gp_Pnt>` would produce a runtime Embind error:

```
BindingError: Cannot convert "NCollection_Array1<gp_Pnt>" to unregistered type
```

The 128 deprecated symbols in `full.yml` provide the **only** Embind type registrations for NCollection template instantiations. `NCollection_Array1` itself is not in `full.yml` — only its deprecated typedef aliases.

### Finding 4: 137 Unique NCollection Instantiations Are Used

Scanning all non-deprecated class bindings (4,329 symbols), **137 unique NCollection template instantiations** appear in method signatures:

| Container                     | Unique element types | Examples                                                     |
| ----------------------------- | -------------------- | ------------------------------------------------------------ |
| `NCollection_HArray1<T>`      | 26                   | `AppParCurves_ConstraintCouple`, `Quantity_Color`, `Bnd_Box` |
| `NCollection_Sequence<T>`     | 24                   | `AppParCurves_MultiCurve`, `IntRes2d_IntersectionPoint`      |
| `NCollection_Array1<T>`       | 17                   | `gp_Pnt`, `double`, `int`, `TopoDS_Shape`                    |
| `NCollection_DataMap<K,V>`    | 17                   | Various multi-arg combinations                               |
| `NCollection_HSequence<T>`    | 13                   | `TopoDS_Shape`, `double`, `int`                              |
| `NCollection_HArray2<T>`      | 10                   | `double`, `gp_Pnt`, `gp_Pnt2d`                               |
| `NCollection_List<T>`         | 10                   | `TopoDS_Shape`, `BOPTools_ConnexityBlock`                    |
| `NCollection_Array2<T>`       | 6                    | `double`, `gp_Pnt`, `gp_XYZ`                                 |
| Other (Map, IndexedMap, etc.) | 14                   | Various                                                      |

The 128 deprecated typedef symbols cover **a subset** of these 137 types. Some NCollection instantiations (particularly `NCollection_HArray1` with STEP/IGES element types) have deprecated typedefs that exist in `src/Deprecated/NCollectionAliases/` but are NOT currently in `full.yml`.

### Finding 5: OCCT Has a Built-in Deprecation Control Macro

`Standard_Macro.hxx` defines `OCCT_NO_DEPRECATED`:

```cpp
#ifdef OCCT_NO_DEPRECATED
  #define Standard_DEPRECATED(theMsg)
  #define Standard_DEPRECATED_WARNING(theMsg)
#else
  #define Standard_DEPRECATED(theMsg) __attribute__((deprecated(theMsg)))
  // ...
#endif
```

When `OCCT_NO_DEPRECATED` is defined, all deprecation warnings are silenced — but the **deprecated headers still exist and the typedefs are still valid C++**. This macro controls compiler warnings only, not header availability or symbol presence.

### Finding 6: Two Distinct Concerns Are Conflated

The current implementation conflates two independent concerns:

| Concern                           | Mechanism                                                            | Purpose                                      | Removable?                       |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| **A: Embind type registration**   | `full.yml` symbols → `class_<TColgp_Array1OfPnt>`                    | Runtime WASM marshalling                     | No — causes runtime errors       |
| **B: TypeScript type resolution** | `_SAFE_DEPRECATED_PREFIXES` → PCH includes → `typedefUnderlyingDict` | `.d.ts` name resolution (any → typedef name) | Yes — only affects TypeScript DX |

Concern B (`_SAFE_DEPRECATED_PREFIXES`) is **purely cosmetic** and can be zeroed without any runtime impact. The `.d.ts` would show `any` for affected types, but all WASM bindings continue to work correctly.

Concern A (deprecated symbols in `full.yml`) **cannot be removed** without either (a) providing replacement registrations, or (b) filtering out all methods that use those types.

## Recommendations

| #   | Action                                                               | Priority | Effort | Impact                                    |
| --- | -------------------------------------------------------------------- | -------- | ------ | ----------------------------------------- |
| R1  | Auto-discover NCollection instantiations from bound class signatures | P0       | High   | Eliminates deprecated typedef dependency  |
| R2  | Register NCollection types under modern mangled names                | P0       | High   | Forward-compatible type registration      |
| R3  | Add `OCJS_INCLUDE_DEPRECATED` flag for backward-compatible aliases   | P1       | Medium | Smooth migration for downstream consumers |
| R4  | Zero `_SAFE_DEPRECATED_PREFIXES` immediately                         | P2       | Low    | Trim PCH, accept `any` in interim         |
| R5  | Auto-generate `.d.ts` names from template instantiation spelling     | P1       | Medium | Resolve `any` without deprecated headers  |

### R1: Auto-Discover NCollection Template Instantiations

During the `generate` phase, scan all bound class method signatures (parameters and return types) to collect the set of NCollection template instantiations that are actually used. This is a **generic C++ operation** — no OCCT-specific knowledge required.

```python
# Pseudocode for the discovery pass
needed_instantiations = set()
for class_cursor in all_bound_classes:
    for method in class_cursor.get_children():
        for param in method.get_arguments():
            if is_ncollection_template(param.type):
                needed_instantiations.add(normalize(param.type))
        if is_ncollection_template(method.result_type):
            needed_instantiations.add(normalize(method.result_type))
```

This replaces the manual listing of deprecated typedef symbols in `full.yml` with an automated discovery that adapts to any OCCT version.

### R2: Register Under Modern Names

Instead of `class_<TColgp_Array1OfPnt>("TColgp_Array1OfPnt")`, register as:

```cpp
class_<NCollection_Array1<gp_Pnt>>("NCollection_Array1_gp_Pnt")
    .constructor(...)
    .function("Value", ...)
    // ...
```

The JS-side name uses a mangled form (underscores replacing angle brackets and commas). This creates a **forward-compatible API** that doesn't depend on OCCT's deprecated naming scheme.

### R3: `OCJS_INCLUDE_DEPRECATED` Flag

A build-time flag that, when enabled, adds backward-compatible aliases:

```cpp
// When OCJS_INCLUDE_DEPRECATED is set:
// Register the modern name (always)
class_<NCollection_Array1<gp_Pnt>>("NCollection_Array1_gp_Pnt") ...;

// Also register under the deprecated name (alias only)
// This could be done via a simple JS-side alias in the module init
```

This provides a clean migration path:

- **Default (flag OFF)**: Only modern `NCollection_Array1_gp_Pnt` names exported, minimal WASM size
- **Flag ON**: Both modern and deprecated names available, consumers can migrate at their pace
- **Future versions**: Flag removed entirely once migration period ends

### R4: Zero `_SAFE_DEPRECATED_PREFIXES` Immediately

Since `_SAFE_DEPRECATED_PREFIXES` only affects TypeScript type resolution (Finding 6, Concern B), it can be zeroed to an empty list immediately. This:

- Reduces PCH compilation time (fewer headers parsed)
- Reduces PCH size
- Has **zero runtime impact**
- Temporarily increases `any` count in `.d.ts` until R5 is implemented

### R5: Auto-Generate `.d.ts` Names From Template Spelling

Instead of relying on the deprecated typedef reverse cache for TypeScript names, generate `.d.ts` type names directly from the NCollection template spelling:

```typescript
// Instead of resolving NCollection_Array1<gp_Pnt> → TColgp_Array1OfPnt via typedef cache:
export class NCollection_Array1_gp_Pnt {
  Value(theIndex: number): gp_Pnt;
  SetValue(theIndex: number, theItem: gp_Pnt): void;
  // ...
}
```

This aligns the TypeScript names with the modern Embind registration names from R2.

## Heuristic Analysis: Can We Filter Instead of Register?

An alternative approach: instead of registering NCollection types, filter out all methods that use unregistered types. Analysis:

**Against filtering:**

- `Geom_BSplineCurve` constructors ALL take `NCollection_Array1<gp_Pnt>` — filtering removes the ability to construct B-spline curves entirely
- `Poles()`, `Knots()`, `Weights()` — core accessor methods lost
- 49 non-deprecated `.cpp` files reference `NCollection_Array1<gp_Pnt>` — filtering would gut core geometry APIs
- Container types are fundamental to OCCT's data exchange — STEP/IGES readers return sequences and arrays

**The filtering heuristic does NOT work** for NCollection types. These are not optional convenience methods — they are the primary interface for passing structured data into and out of OCCT algorithms. Filtering them would remove functionality equivalent to removing array/list support from a standard library.

**Where filtering DOES work:** For genuinely optional deprecated methods that have direct modern replacements (e.g., `TopoDS_Shape::HashCode` → `TopTools_ShapeMapHasher`), individual method filtering is appropriate. But this is a different concern from container type registration.

## Trade-offs

| Approach                                       | WASM Size            | TypeScript DX                | Runtime Safety | Migration Effort                |
| ---------------------------------------------- | -------------------- | ---------------------------- | -------------- | ------------------------------- |
| **Keep deprecated symbols** (status quo)       | Baseline             | Good (names match OCCT docs) | Safe           | None                            |
| **Auto-register modern names** (R1+R2)         | Same or smaller      | Good (modern names)          | Safe           | Medium (generator changes)      |
| **Filter methods using unregistered types**    | Smaller              | N/A (methods gone)           | Safe but lossy | Low but **loses functionality** |
| **Zero `_SAFE_DEPRECATED_PREFIXES` only** (R4) | Slightly smaller PCH | Degraded (more `any`)        | Safe           | None                            |

## Implementation Roadmap

### Phase 1: Immediate (no generator changes)

- Zero `_SAFE_DEPRECATED_PREFIXES` to empty list
- Accept temporary `any` increase in `.d.ts`
- No runtime impact, slight PCH size reduction

### Phase 2: Auto-discovery (generator changes)

- Add NCollection instantiation scanning pass in `generateBindings.py`
- Collect all template types used across bound class signatures
- Generate `class_<NCollection_Array1<gp_Pnt>>("NCollection_Array1_gp_Pnt")` registrations automatically
- Remove deprecated typedef symbols from `full.yml`
- Update TypeScript generator to emit modern names

### Phase 3: Backward compatibility flag

- Add `OCJS_INCLUDE_DEPRECATED` YAML/env flag
- When enabled, generate additional alias registrations under old names
- Document migration guide for downstream consumers
- Set a deprecation timeline (e.g., 2 OCCT versions)

### Phase 4: Full cleanup

- Remove `OCJS_INCLUDE_DEPRECATED` flag
- Remove `_SAFE_DEPRECATED_PREFIXES` infrastructure entirely
- Remove all deprecated typedef references from codebase
- 972 fewer headers to process, cleaner PCH, faster builds

## Code Examples

### Current: Deprecated typedef registration

```cpp
// full.yml: - symbol: TColgp_Array1OfPnt
// Generated binding:
EMSCRIPTEN_BINDINGS(TColgp_Array1OfPnt) {
  class_<TColgp_Array1OfPnt>("TColgp_Array1OfPnt")
    .constructor<const int, const int>()
    .function("Value", &TColgp_Array1OfPnt::Value)
    .function("SetValue", &TColgp_Array1OfPnt::SetValue)
    // ...
}
```

### Future: Auto-discovered modern registration

```cpp
// Auto-discovered from Geom_BSplineCurve::Poles() return type
EMSCRIPTEN_BINDINGS(NCollection_Array1_gp_Pnt) {
  class_<NCollection_Array1<gp_Pnt>>("NCollection_Array1_gp_Pnt")
    .constructor<const int, const int>()
    .function("Value", &NCollection_Array1<gp_Pnt>::Value)
    .function("SetValue", &NCollection_Array1<gp_Pnt>::SetValue)
    // ...
}
```

### With OCJS_INCLUDE_DEPRECATED=1

```javascript
// Module initialization adds backward-compatible aliases:
Module['TColgp_Array1OfPnt'] = Module['NCollection_Array1_gp_Pnt'];
Module['TColStd_Array1OfReal'] = Module['NCollection_Array1_number'];
// Zero WASM size cost — JS-only aliases
```

## Appendix A: Deprecated Symbols in `full.yml`

128 deprecated typedef symbols currently in `full.yml`, grouped by package:

| Package      | Count | Examples                                                                  |
| ------------ | ----- | ------------------------------------------------------------------------- |
| `TColgp_*`   | 48    | Array1/2, HArray1/2, HSequence, Sequence of geometric primitives          |
| `TColStd_*`  | 30    | Array1/2, HArray1/2, List, Sequence of standard types                     |
| `TopTools_*` | 22    | Array, DataMap, IndexedDataMap, IndexedMap, List, Map, Sequence of shapes |
| `Poly_*`     | 2     | Array1OfTriangle, HArray1OfTriangle                                       |
| `TDF_*`      | 2     | IDList, LabelSequence                                                     |
| Other        | 24    | AppParCurves, BOPTools, BRepCheck, GeomFill, IntRes2d, etc.               |

## Appendix B: OCCT Deprecation Infrastructure

| Macro                                   | Purpose                                           | Controlled by `OCCT_NO_DEPRECATED` |
| --------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `Standard_DEPRECATED(msg)`              | `[[deprecated(msg)]]` on typedefs/methods/classes | Yes — becomes empty                |
| `Standard_HEADER_DEPRECATED(msg)`       | Compiler warning on `#include`                    | Yes — becomes empty                |
| `Standard_MACRO_DEPRECATED(msg)`        | Warning on preprocessor macro expansion           | Yes — becomes empty                |
| `Standard_DISABLE_DEPRECATION_WARNINGS` | Push-style warning suppression (scoped)           | N/A — used locally                 |
| `Standard_ENABLE_DEPRECATION_WARNINGS`  | Pop-style warning re-enable (scoped)              | N/A — used locally                 |

All deprecated NCollection alias headers live in `repos/occt/src/Deprecated/NCollectionAliases/` (972 files). There is no separate `HandleAliases` directory — `Handle_*` deprecation is handled inline via `Standard_Handle.hxx`.
