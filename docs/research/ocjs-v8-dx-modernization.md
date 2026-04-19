---
title: 'OpenCASCADE.js V8 DX Modernization Strategy'
description: 'Prioritized strategy for modernizing the opencascade.js API surface for OCCT v8, informed by peer comparison, Emscripten feature catalog, and community feedback.'
status: active
created: '2026-03-18'
updated: '2026-03-19'
category: architecture
related:
  - docs/research/emscripten-idiomatic-js.md
  - docs/research/occt-v8-migration.md
  - docs/research/ocjs-wasm-optimization.md
  - docs/policy/library-api-policy.md
---

# OpenCASCADE.js V8 DX Modernization Strategy

Prioritized strategy for modernizing the opencascade.js API surface for OCCT v8 widespread consumption. Informed by peer comparison with CanvasKit, OpenCV.js, wasm-bindgen, and Light OCCT; the Emscripten embind feature catalog (2024-2026); community feedback from replicad maintainer Steve Genoud; and the OCCT team's own "Light OCCT" initiative.

## Executive Summary

The opencascade.js V8 bindings have already implemented several key DX improvements: `Symbol.dispose` on all classes, `Handle_` transparency (zero `Handle_` types in the d.ts), TS namespace blocks (268 per OCCT package), unique-arity overload collapsing, `TopoDS` static cast API, `EXPORT_ES6`, hand-typed `{ current: T }` output params for `FairCurve_*`, and `Standard_*` type aliases. Remaining high-value items are: enum member deduplication, `the*` parameter prefix stripping, `EMBIND_AOT` for startup performance, `MODULARIZE=instance` for tree-shaking, `register_type` for systematic output param typing, and an `oc` backwards-compatible flat namespace. The namespacing approach preserves OCCT naming (no camelCase) with ~268 per-package namespaces plus an `oc` flat fallback.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Peer Comparison](#peer-comparison)
- [Community Consensus](#community-consensus)
- [Finding 1: Namespacing Strategy](#finding-1-namespacing-strategy)
- [Finding 2: Overload Suffix Elimination](#finding-2-overload-suffix-elimination)
- [Finding 3: Enum Member Deduplication](#finding-3-enum-member-deduplication)
- [Finding 4: Symbol.dispose and Explicit Resource Management](#finding-4-symboldispose-and-explicit-resource-management)
- [Finding 5: ESM Named Exports](#finding-5-esm-named-exports)
- [Finding 6: Output Parameter Typing](#finding-6-output-parameter-typing)
- [Finding 7: EMBIND_AOT Startup Performance](#finding-7-embind_aot-startup-performance)
- [Finding 8: OCCT V8 API Alignment](#finding-8-occt-v8-api-alignment)
- [Recommendations](#recommendations)
- [Risk Assessment](#risk-assessment)
- [References](#references)

## Problem Statement

opencascade.js V8 represents a generational API break (the first in 10 years). OCCT v8 itself introduces 400+ API changes including deprecated math functions, redesigned geometry evaluation, and new collection types. The OCCT lead developer Dmitrii Pasukhi has publicly stated that the opencascade.js API "is bad" and is building a competing "Light OCCT" wrapper with simplified APIs across C++/Python/JS. This is an opportunity to modernize the binding surface while the ecosystem is already absorbing breaking changes.

Key questions this research answers:

1. What namespacing strategy preserves OCCT naming while eliminating the flat namespace?
2. Which DX improvements are purely additive (non-breaking) vs breaking?
3. What is the minimum-effort, maximum-impact modernization for V8 launch?
4. How do peer C++ WASM projects handle the same problems?

## Methodology

1. **Discord analysis**: Extracted consensus from maintainer discussion (March 2026) between Richard Fontein and Steve Genoud (replicad)
2. **Peer comparison**: Analyzed API design of CanvasKit (Skia), OpenCV.js, wasm-bindgen (Rust), and Light OCCT
3. **d.ts structural analysis**: Parsed 191,188-line `opencascade_full.d.ts` for naming patterns, underscore segmentation, and namespace feasibility
4. **Emscripten feature audit**: Surveyed PRs merged 2024-2026 for embind capabilities
5. **OCCT V8 changelog review**: Cataloged API changes in V8_0_0_rc4 (400+ changes from 7.9.0)
6. **Binding generator analysis**: Full review of `bindings.py`, `buildFromYaml.py` Python pipeline
7. **Consumer impact assessment**: Audited replicad source (~1,800 OC API calls) for migration cost

## Peer Comparison

How major C++ WASM projects handle API design:

| Project                      | Namespace                             | Typing                      | Resource Mgmt                 | Overloads                                   | Module Format           |
| ---------------------------- | ------------------------------------- | --------------------------- | ----------------------------- | ------------------------------------------- | ----------------------- |
| **CanvasKit (Skia)**         | Flat `CanvasKit.Paint()`              | Hand-written d.ts           | Manual `delete()`             | Factory functions                           | MODULARIZE factory      |
| **OpenCV.js**                | Flat `cv.Mat`                         | `@opencvjs/types` package   | Manual                        | N/A (no embind)                             | Promise factory         |
| **Light OCCT**               | Facade classes (`LCurve`, `LSurface`) | SWIG-generated              | Enum+Handle pattern           | Hidden by facade                            | ESM (planned)           |
| **wasm-bindgen (Rust)**      | `js_namespace` attribute              | Auto-generated              | `Symbol.dispose` (Sep 2024)   | Rust type system                            | ES modules native       |
| **opencascade.js (current)** | 268 TS namespaces + flat              | Generated d.ts (191K lines) | `delete()` + `Symbol.dispose` | Unique-arity collapsed; `_N` for same-arity | MODULARIZE + EXPORT_ES6 |

Key takeaways:

- **CanvasKit** keeps flat namespace because Skia's API is smaller (~200 classes vs OCCT's 6,178). Not applicable at OCCT scale.
- **Light OCCT** takes the opposite extreme -- hides OCCT entirely behind a simplified facade. This sacrifices full API access.
- **wasm-bindgen** is the most mature ecosystem. Its `js_namespace` and ES module support are the gold standard. Embind is catching up.
- No peer project has solved same-arity overload disambiguation elegantly. All use workarounds.

## Community Consensus

From the Discord discussion (March 2026), the community converged on:

**Committed (agreed by all participants):**

| Change                                     | Breaking? | Rationale                                                       | Status                                                              |
| ------------------------------------------ | --------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Symbol.dispose on all classes              | No        | Additive; lib authors choose to adopt based on browser support  | **Done**                                                            |
| ESM modularized exports                    | Yes       | Standard ES module consumption pattern                          | **Partial** -- ES6 factory mode done; `MODULARIZE=instance` not yet |
| Overload suffix elimination                | Yes       | Biggest pain point per replicad maintainer; halfway implemented | **Done** for unique-arity; 45 same-arity remain in full build       |
| Output parameter typing (`{ current: T }`) | No        | Zero API cost, pure d.ts improvement                            | **Partial** -- FairCurve hand-typed; generator not updated          |
| TopoDS_Cast to TopoDS                      | Yes       | Mirrors C++ `TopoDS::Edge(shape)`, zero overhead                | **Done**                                                            |

**Left out (agreed to exclude):**

| Change                    | Rationale                                                                                                               | Status       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| camelCase method names    | Breaks OCCT documentation cross-referencing; doxygen JSDoc would need band-aiding                                       | Excluded     |
| Nb* to *Count             | Same documentation cross-referencing concern                                                                            | Excluded     |
| Strip `the*` param prefix | Low value relative to other changes (Discord); reconsidered as M5 below since it is a TS-only, zero-runtime-cost change | Reconsidered |

**Undecided (needs this research):**

| Change                      | Key Question                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| Namespacing                 | What granularity? Per-package (268) or logical groups (12-15)?        |
| Get/Set to properties       | Which subset is safe? Return-by-value creates copies needing delete() |
| Enum member deduplication   | Same class of rename as camelCase -- is it worth it?                  |
| Value types for gp_Pnt etc. | Replicad maintainer values distinct types for Vec/Dir/Pnt             |

## Current Implementation Status

Audit of `opencascade_full.d.ts` (191,188 lines), `replicad_single.d.ts` (20,939 lines), and `bindings.py` against the recommendation list:

| Item                                       | Status               | Evidence                                                                                                      |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Symbol.dispose` on all classes            | **Done**             | All classes emit `[Symbol.dispose](): void` (e.g., `opencascade_full.d.ts` line 61)                           |
| `Handle_` transparency                     | **Done**             | Zero `Handle_*` classes in either `opencascade_full.d.ts` or `replicad_single.d.ts`                           |
| TS namespace blocks (268 per OCCT package) | **Done**             | 268 `export namespace` blocks in `opencascade_full.d.ts`; 67 in `replicad_single.d.ts`                        |
| Unique-arity overload collapsing           | **Done**             | `_constructorsHaveUniqueArities()` in `bindings.py` line 155; `replicad_single.d.ts` has zero `_N` subclasses |
| `TopoDS` static cast API                   | **Done**             | `builtin-bindings.d.ts` declares `TopoDS` class with static `Edge`, `Wire`, `Face`, etc.                      |
| `EXPORT_ES6`                               | **Done**             | All build configs use `-sEXPORT_ES6=1`                                                                        |
| `Standard_*` type aliases                  | **Done**             | `builtin-bindings.d.ts` lines 138-153 map to JS primitives                                                    |
| `{ current: T }` output params (FairCurve) | **Done**             | `FairCurve_Batten_Compute` and `FairCurve_MinimalVariation_Compute` use `codeRef: { current: number }`        |
| JSDoc from Doxygen                         | **Done**             | ~65% class coverage, ~52% method coverage                                                                     |
| `gp_Dir::D` direction enum (V8)            | **Done**             | `gp_Dir_D` present in d.ts                                                                                    |
| WASM exception helpers                     | **Done**             | `getExceptionMessage`, `incrementExceptionRefcount`, `decrementExceptionRefcount` in exceptions build         |
| Emscripten 5.0.1                           | **Done**             | `DEPS.json`: `"emsdk_version": "5.0.1"`                                                                       |
| Enum member deduplication                  | **Not done**         | `TopAbs_ShapeEnum.TopAbs_COMPOUND` still uses full prefix                                                     |
| `the*` param prefix stripping              | **Not done**         | `_argname()` in `bindings.py` uses raw `arg.spelling`; params show `theXp`, `theTolerance`                    |
| `EMBIND_AOT`                               | **Not done**         | Not in any build config                                                                                       |
| `MODULARIZE=instance`                      | **Not done**         | All configs use `-sMODULARIZE` (factory mode, not instance)                                                   |
| `register_type` for output params          | **Not done**         | Not used in `bindings.py`; only FairCurve hand-typed                                                          |
| `value_object` for `gp_Pnt` etc.           | **Not done**         | Not used in `bindings.py`                                                                                     |
| `nonnull()` policy                         | **Not done**         | Not used in `bindings.py`                                                                                     |
| camelCase methods                          | **Excluded**         | Community consensus to preserve OCCT naming                                                                   |
| `Nb*` to `*Count`                          | **Excluded**         | Community consensus to preserve OCCT naming                                                                   |
| `oc` backwards-compatible flat namespace   | **Not done**         | Namespaces exist as type aliases but no unified `oc` namespace aggregating all entries                        |
| Same-arity overload elimination            | **Blocked**          | Depends on embind PR #17445 (open since Jul 2022)                                                             |
| Remaining `_N` subclasses                  | **45 in full build** | e.g., `TCollection_AsciiString_3`, `IntPatch_GLine_14` in `opencascade_full.d.ts`                             |

## Finding 1: Namespacing Strategy

### "All underscores become namespace separators" -- NOT feasible

Analysis of 4,535 symbols in `opencascade_full.d.ts` reveals:

| Pattern                         | Count | Problem                                                                                 |
| ------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| No underscore                   | 122   | Root classes (`gp`, `math`, `Precision`)                                                |
| One underscore                  | 4,301 | Clean split: `gp_Pnt` to `gp.Pnt`                                                       |
| Two underscores, numeric suffix | 45    | `TCollection_AsciiString_3` to `TCollection.AsciiString.3` -- **invalid JS identifier** |
| Two underscores, non-numeric    | 32    | `OSD_Exception_IN_PAGE_ERROR` to `OSD.Exception.IN_PAGE_ERROR` -- deep nesting          |
| Three+ underscores              | 35    | `DEIGES_Parameters_ReadMode_BSplineContinuity` -- 4 levels                              |

Numeric suffixes (`_3`, `_14`) are not valid JavaScript property names without bracket notation. Multi-segment names like `DESTEP_Parameters_WriteMode_VertexMode` would require 4 levels of nesting with awkward intermediate namespace objects.

### "Split on first underscore" -- feasible and natural

Splitting on the first underscore maps directly to OCCT's package structure:

```typescript
// Current flat API
oc.BRepPrimAPI_MakeBox_2(corner1, corner2);
oc.gp_Pnt(1, 2, 3);
oc.TopAbs_ShapeEnum.TopAbs_COMPOUND;
oc.BRepBuilderAPI_MakeEdge_15(curve, surface, first, last);

// Namespaced (split on first underscore)
BRepPrimAPI.MakeBox_2(corner1, corner2); // overload suffix stays in member name
gp.Pnt(1, 2, 3);
TopAbs.ShapeEnum.TopAbs_COMPOUND;
BRepBuilderAPI.MakeEdge_15(curve, surface, first, last);
```

This produces 268 namespaces -- one per OCCT package prefix. The namespaces follow OCCT's own organizational structure.

### Backwards-compatible `oc` fallback

The recommended approach from the Discord discussion:

```typescript
import { oc, BRepPrimAPI, gp, TopAbs } from 'opencascade.js';

// Modernized namespaced access
const box = new BRepPrimAPI.MakeBox(10, 20, 30);
const pt = new gp.Pnt(1, 2, 3);
const face = TopoDS.Face(shape);

// Backwards compatible flat access (deprecated)
const box = new oc.BRepPrimAPI_MakeBox(10, 20, 30);
```

**Implementation**: The TS-only approach is already implemented in `buildFromYaml.py` lines 371-393 -- 268 `export namespace` blocks with type aliases are generated in `opencascade_full.d.ts` and 67 in `replicad_single.d.ts`. The remaining work is adding an `oc` namespace that aggregates all entries for backwards-compatible flat access (`import { oc } from 'opencascade.js'`). For runtime namespacing, embind can register dummy structs as namespace objects with static factory methods per Finding 6 of the original research doc (Path C). The Tau runtime's `oc-tracing.ts` proxy already handles namespace-like objects via `createNamespaceWrapper()` (line 110).

### 268 vs fewer namespaces

The 268 namespaces match OCCT's package structure exactly. This is preferable to merging into 12-15 logical groups because:

1. OCCT developers already think in packages (`gp`, `BRepPrimAPI`, `Geom`, etc.)
2. No subjective grouping decisions required
3. The mapping is mechanical (prefix before first `_`)
4. IDE autocomplete handles 268 namespaces fine -- each namespace has a manageable number of entries
5. If fewer are desired, consumers can re-export: `const { MakeBox } = BRepPrimAPI`

## Finding 2: Overload Suffix Elimination

### Current state

**Status**: PARTIALLY IMPLEMENTED

The binding generator eliminates `_N` suffixes when all overloads have unique arities via `_constructorsHaveUniqueArities()` (`bindings.py` line 155) and native embind constructor overloading. Additionally, `_build_dispatch_tree()` (line 357) and `_emitValDispatchConstructor()` (line 821) handle same-arity overloads that are distinguishable by JS type via `val`-based runtime dispatch.

Evidence: `replicad_single.d.ts` has **zero** `_N` constructor subclasses (all resolved). `opencascade_full.d.ts` has **45** remaining `_N` subclasses (e.g., `TCollection_AsciiString_3`, `IntPatch_GLine_14`) representing truly ambiguous same-arity collisions.

The remaining 45 subclasses in the full build represent same-arity collisions that cannot be distinguished by JS types.

### Embind type-based overloading (PR #17445)

An open embind PR (since July 2022, rebased March 18, 2026) adds runtime type-based overloading. If merged, this would allow:

```cpp
class_<BRepBuilderAPI_MakeEdge>("BRepBuilderAPI_MakeEdge")
    .constructor<gp_Lin>()        // overload by type, not arity
    .constructor<gp_Circ>()
    .constructor<gp_Elips>()
    .constructor<Handle_Geom_Curve>()
    ;
```

**Status**: Open for 4 years, most recent force-push March 18, 2026. Performance concerns raised by reviewer. Not mergeable yet.

### Without type-based overloading

Three options for same-arity collisions:

1. **Keep `_N` suffixes** in namespace member names: `BRepBuilderAPI.MakeEdge_15(...)` -- ugly but honest
2. **Factory lambdas** with runtime `instanceof` dispatch: generate a single entry that checks argument types and dispatches. Slower per-call but eliminates suffixes.
3. **Descriptive names** via libclang AST: `MakeEdgeFromCurve(...)`, `MakeEdgeFromLine(...)`. Requires semantic heuristics to generate meaningful names.

Recommendation: Keep `_N` suffixes for now (option 1). When embind PR #17445 merges, adopt type-based overloading (eliminates all suffixes). The suffix will be less visible inside a namespace (`BRepBuilderAPI.MakeEdge_15` reads better than `oc.BRepBuilderAPI_MakeEdge_15`).

## Finding 3: Enum Member Deduplication

The enum member prefix duplication is distinct from the camelCase debate. It is pure redundancy with zero information value:

```typescript
// Current: prefix appears THREE times when namespaced
TopAbs.ShapeEnum.TopAbs_COMPOUND;

// Deduplicated: no information lost
TopAbs.ShapeEnum.COMPOUND;
```

This is a string transform in `processEnum()` -- strip the enum type's prefix from each member name. The embind C++ name stays unchanged; only the JS-visible name changes.

**Scale**: 329 enums, all with duplicated prefixes.

**Implementation**: In `bindings.py` `processEnum()`, detect the common prefix of enum member names and strip it. For `TopAbs_ShapeEnum` with members `TopAbs_COMPOUND`, `TopAbs_SOLID`, etc., the common prefix is `TopAbs_`. Strip to get `COMPOUND`, `SOLID`.

**Backwards compat**: Can dual-register both forms during transition, with the prefixed form marked `@deprecated`.

**Community take**: The Discord left this undecided, but it is lower risk than camelCase because enum member names are less likely to be confused with OCCT docs (which already use the short form `COMPOUND` in prose).

## Finding 4: Symbol.dispose and Explicit Resource Management

**Status**: IMPLEMENTED

All opencascade.js classes emit `[Symbol.dispose](): void` via `processFinalizeClass` in `bindings.py` (line 1577). Both `opencascade_full.d.ts` and `replicad_single.d.ts` include it on every class. The hand-written `builtin-bindings.d.ts` declarations (`TopoDS`, `OCJS`, `TColStd_IndexedDataMapOfStringString`) also include it.

Emscripten 5.0.1 (the version used by this project per `DEPS.json`) supports `Symbol.dispose` natively. The Emscripten 5.x runtime warns on forgotten `delete()` calls and auto-releases via FinalizationRegistry as a safety net.

### Browser support

| Browser          | `using` keyword | `Symbol.dispose` |
| ---------------- | --------------- | ---------------- |
| Chrome 134+      | Yes (unflagged) | Yes              |
| Firefox (latest) | Behind flag     | Yes              |
| Safari 18.4+     | No              | No               |
| Node.js 22+      | Yes (flagged)   | Yes              |

No further action needed. Library authors choose to adopt `using` based on their browser support targets.

## Finding 5: ESM Named Exports

**Status**: PARTIALLY IMPLEMENTED

All build configs already use `-sEXPORT_ES6=1` and `-sMODULARIZE` (factory mode), producing ES6 module output with a default export factory function. The remaining step is `MODULARIZE=instance` for static named exports enabling tree-shaking.

### MODULARIZE=instance

Emscripten's `MODULARIZE=instance` (PR #22867, Nov 2024) produces static ES module exports:

```javascript
// Generated output shape
async function init(moduleArgs) {
  /* ... */
}
var x_gp_Pnt;
export { x_gp_Pnt as gp_Pnt };
```

Combined with `EMBIND_AOT` (required), this enables:

```typescript
import init, { gp_Pnt, BRepPrimAPI_MakeBox } from 'opencascade.js';
await init();
```

### Status (March 2026)

- Embind ESM export integration merged May 2025 (PR #23404)
- Acorn optimizer support merged January 2025 (PR #23522)
- Closure compiler support merged (PR #23540)
- Still marked "experimental" in docs but actively developed

### Trade-offs

| Pro                             | Con                             |
| ------------------------------- | ------------------------------- |
| Standard ES module pattern      | Experimental status             |
| Enables bundler tree-shaking    | Requires EMBIND_AOT             |
| `import { gp_Pnt }` syntax      | Changes init pattern            |
| Static export shape for tooling | Larger JS glue for many exports |

### Recommendation

Adopt for V8 as the primary module format. The YAML build system already supports selective symbol linking. Combined with `EMBIND_AOT`, this delivers both tree-shaking and 5-10x startup performance. Keep the factory-function `init()` pattern as a fallback entry point.

## Finding 6: Output Parameter Typing

**Status**: PARTIALLY IMPLEMENTED

The hand-written `FairCurve_Batten_Compute` and `FairCurve_MinimalVariation_Compute` declarations in `builtin-bindings.d.ts` correctly type `codeRef: { current: number }`. However, the binding generator (`bindings.py`) does not use `register_type` and does not systematically type output-by-reference parameters. Auto-generated methods with `Standard_Real&` etc. still show `number` instead of `{ current: number }` in the d.ts.

### register_type solution

Emscripten's `register_type<T>(name, definition)` (PR #25272, Oct 2025) allows:

```cpp
EMSCRIPTEN_DECLARE_VAL_TYPE(RefNumber);
register_type<RefNumber>("Ref<number>", "{ current: number }");
```

The d.ts would show `Ref<number>` with definition `{ current: number }`, making the pattern visible to IDE autocomplete.

### Known issue

As of January 2026, the created type alias may not be exported in the generated TypeScript definitions (discussion on PR #25272). Workaround: manually append the type to the d.ts in the Python pipeline.

## Finding 7: EMBIND_AOT Startup Performance

**Status**: NOT IMPLEMENTED

The project uses Emscripten 5.0.1 (`DEPS.json`) which fully supports EMBIND_AOT. No build configs currently enable it. `-sEMBIND_AOT` generates all embind invoker functions at compile time instead of runtime:

| Metric                     | Without AOT            | With AOT                        |
| -------------------------- | ---------------------- | ------------------------------- |
| Startup performance        | Baseline               | 5-10x faster                    |
| CSP compliant              | No (uses `Function()`) | Yes                             |
| Code size (100 bindings)   | Baseline               | +23KB uncompressed, +1.3KB gzip |
| Code size (1000+ bindings) | Baseline               | +150KB uncompressed, +6KB gzip  |

For opencascade.js with ~6,500 bindings, expect ~100KB gzip overhead. This is negligible compared to the 14MB WASM binary.

EMBIND_AOT is required for MODULARIZE=instance. Recommendation: enable for all builds.

## Finding 8: OCCT V8 API Alignment

OCCT V8 introduces several changes that the binding generator should account for:

| V8 Change                                             | Binding Impact                  |
| ----------------------------------------------------- | ------------------------------- |
| `gp_Dir::D` direction enum (X, Y, Z, NX, NY, NZ)      | Already in d.ts as `gp_Dir_D`   |
| Deprecated `ACos()`, `Sin()` etc. in favor of `std::` | No JS impact (internal to C++)  |
| `Standard_Mutex` to `std::mutex`                      | No JS impact                    |
| `NCollection_FlatDataMap` (Robin Hood hash)           | New class to bind               |
| `constexpr`/`noexcept` annotations                    | Could inform `nonnull()` policy |
| Stream-based I/O for STEP/STL                         | New methods to bind             |
| `TopoDS_TShape` internal optimization                 | Transparent to bindings         |
| 12-phase migration toolkit                            | Could inform consumer migration |

The binding generator's AST-driven approach handles most V8 changes automatically. The main manual effort is updating the YAML symbol lists and handling removed/renamed classes.

## Recommendations

### Tier 0: Zero-cost additive (ship with V8 launch)

| #   | Action                                                                           | Effort | Impact                          | Breaking?     | Status                                                                     |
| --- | -------------------------------------------------------------------------------- | ------ | ------------------------------- | ------------- | -------------------------------------------------------------------------- |
| M1  | Enable `Symbol.dispose` on all classes                                           | None   | High -- enables `using`         | No            | **Done** -- `bindings.py` line 1577                                        |
| M2  | Package namespacing (split on first `_`, 268 namespaces) with `oc` flat fallback | Medium | High -- IDE discoverability     | No (additive) | **Partial** -- 268 namespaces exist; `oc` flat fallback not yet added      |
| M3  | Output parameter typing via `register_type`                                      | Medium | Medium -- documents ref pattern | No            | **Partial** -- FairCurve hand-typed; `register_type` not used in generator |
| M4  | Inline `Standard_*` type aliases as primitives in d.ts                           | Low    | Low -- cleaner tooltips         | No            | **Done** -- aliases defined in `builtin-bindings.d.ts`                     |
| M5  | Strip `the*` parameter prefixes in d.ts                                          | Low    | Low -- cleaner tooltips         | No            | Not done                                                                   |

### Tier 1: Breaking but high-value (ship with V8 launch)

| #   | Action                                    | Effort | Impact                                    | Breaking?                      | Status                                                                          |
| --- | ----------------------------------------- | ------ | ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| M6  | Enum member deduplication (strip prefix)  | Low    | High -- `.COMPOUND` vs `.TopAbs_COMPOUND` | Yes (dual-register for compat) | Not done                                                                        |
| M7  | TopoDS_Cast to TopoDS                     | Low    | Medium -- mirrors C++ API                 | Yes                            | **Done** -- `builtin-bindings.d.ts` lines 21-71                                 |
| M8  | Complete unique-arity overload collapsing | Medium | High -- eliminates most `_N` suffixes     | Yes                            | **Done** -- 0 subclasses in replicad; 45 remain in full build (truly ambiguous) |
| M9  | Enable EMBIND_AOT                         | Low    | High -- 5-10x startup, CSP compliant      | No                             | Not done                                                                        |

### Tier 2: Strategic (V8.1 or post-launch)

| #   | Action                                                         | Effort | Impact                                 | Breaking? | Status                                              |
| --- | -------------------------------------------------------------- | ------ | -------------------------------------- | --------- | --------------------------------------------------- |
| M10 | MODULARIZE=instance ESM named exports                          | High   | High -- tree-shaking, standard imports | Yes       | Not done -- uses `-sMODULARIZE` factory mode        |
| M11 | Same-arity overload elimination (when embind PR #17445 merges) | Medium | High -- eliminates remaining `_N`      | Yes       | Blocked -- PR open since Jul 2022, rebased Mar 2026 |
| M12 | Get/Set to properties (safe subset: simple value returns only) | High   | Medium -- `point.X` vs `point.X()`     | Yes       | Not done                                            |

### Tier 3: Future (post-V8 stabilization)

| #   | Action                                          | Effort | Impact                                 | Breaking?   | Status   |
| --- | ----------------------------------------------- | ------ | -------------------------------------- | ----------- | -------- | -------- |
| M13 | `value_object` for `gp_Pnt`, `gp_Vec`, `gp_Dir` | High   | High -- no `delete()` for common types | Yes         | Not done |
| M14 | Factory functions for algorithm classes         | High   | Medium -- `BRepPrimAPI.makeBox(...)`   | Yes         | Not done |
| M15 | `--emit-tsd` for base TypeScript generation     | High   | Medium -- reduce Python code           | No          | Not done |
| M16 | `nonnull()` policy for non-nullable returns     | Medium | Low -- removes `                       | null` noise | No       | Not done |

### Changes explicitly excluded

| Action                                    | Rationale                                                            |
| ----------------------------------------- | -------------------------------------------------------------------- |
| camelCase method names                    | Breaks OCCT doc cross-referencing; community feedback against it     |
| `Nb*` to `*Count` renaming                | Same documentation concern; French abbreviation is learnable         |
| Logical namespace grouping (12-15 groups) | Subjective grouping; per-package (268) matches OCCT structure better |

## Risk Assessment

### Namespacing (M2)

The per-OCCT-package namespacing is TypeScript-only and additive -- no runtime changes to the Emscripten module. Risk is limited to:

- **IDE confusion**: 268 namespaces in autocomplete could be overwhelming. Mitigated by clear package naming (`gp`, `BRepPrimAPI` etc. are already familiar).
- **Proxy overhead for runtime namespaces**: If runtime namespace objects are created (vs TS-only type aliases), each namespace property access adds one additional lookup. Mitigated by caching in the proxy (already implemented in `oc-tracing.ts`).

### Enum deduplication (M6)

Lower risk than camelCase because:

- Enum members are typically used via autocomplete, not typed from memory
- OCCT docs use the short form (`COMPOUND`) in prose, only the C++ code uses the prefixed form
- Dual-registration (both `TopAbs_COMPOUND` and `COMPOUND`) during transition eliminates breakage

### MODULARIZE=instance (M10)

Highest risk item. Still experimental in Emscripten. Requires:

- `EMBIND_AOT` (already recommended as M9)
- Changes the module initialization pattern
- All 6,500+ symbols become static ESM exports (large JS glue)
- Spike/prototype required before committing

### Overload elimination (M8, M11)

The unique-arity collapsing (M8) is already partially implemented and well-understood. The type-based overloading (M11) depends on embind PR #17445 which has been open since 2022. Plan to ship without it and adopt when/if it merges.

## References

- Related: `docs/research/emscripten-idiomatic-js.md` -- full API audit with 15 findings
- Related: `docs/research/occt-v8-migration.md` -- V8 migration specifics
- Related: `docs/research/ocjs-wasm-optimization.md` -- WASM build optimization
- Related: `docs/policy/library-api-policy.md` -- TypeScript API conventions
- Light OCCT: https://dpasukhi.github.io/OCCT-Light/
- Light OCCT OCCT issue: https://github.com/Open-Cascade-SAS/OCCT/issues/791
- Emscripten `Symbol.dispose` PR: https://github.com/emscripten-core/emscripten/pull/23818
- Emscripten `MODULARIZE=instance` PR: https://github.com/emscripten-core/emscripten/pull/22867
- Emscripten embind ESM exports PR: https://github.com/emscripten-core/emscripten/pull/23404
- Emscripten `register_type` PR: https://github.com/emscripten-core/emscripten/pull/25272
- Emscripten `EMBIND_AOT` PR: https://github.com/emscripten-core/emscripten/pull/20796
- Emscripten type-based overloading PR (open): https://github.com/emscripten-core/emscripten/pull/17445
- OCCT V8 RC4 release notes: https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_0_rc4
- CanvasKit API: https://skia.org/docs/user/modules/canvaskit
- OpenCV.js types: https://www.npmjs.com/package/@opencvjs/types
- wasm-bindgen `js_namespace`: https://rustwasm.github.io/docs/wasm-bindgen/reference/attributes/on-js-imports/js_namespace.html
