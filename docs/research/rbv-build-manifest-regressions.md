---
title: 'Return-by-Value Build Manifest Regressions'
description: 'Root cause analysis of build regressions introduced by the unified return-by-value implementation in opencascade.js'
status: active
created: '2026-03-22'
updated: '2026-03-22'
category: investigation
related:
  - docs/research/unified-return-by-value.md
  - docs/research/embind-return-strategy-benchmarks.md
  - docs/research/embind-smart-pointer-stale-ptr.md
---

# Return-by-Value Build Manifest Regressions

Root cause analysis of regressions introduced by commit `508e00a` (`feat(bindings): return pointers by value instead of by reference`) in `repos/opencascade.js`.

## Executive Summary

The return-by-value implementation introduced three classes of regression: (1) 8 new compile failures from reference-type struct fields, (2) ~62% WASM size increase and ~77% JS size increase from Embind template bloat, and (3) a stale `build-manifest.json` that may overstate the failures. The compile failures have a code fix committed alongside but the manifest was never regenerated. The size regression is inherent to the approach — 1,422 `value_object` structs and 5,655 `optional_override` lambdas — and is amplified by the full build's JS exception model.

## Problem Statement

Comparing `build-manifest.json` between `ffee9e7` (string-enums, `full.yml`) and `508e00a` (return-by-value, `full-exceptions.yml`):

| Metric          | `ffee9e7` (full.yml) | `250f5ac` (full-exceptions.yml) | `508e00a` (full-exceptions.yml) | Delta (same config) |
| --------------- | -------------------- | ------------------------------- | ------------------------------- | ------------------- |
| compiled        | 4,445                | 4,445                           | 4,441                           | -4                  |
| missing symbols | 11                   | 11                              | 17                              | +6 new              |
| extra_compiled  | 4                    | 4                               | 8                               | +4                  |
| WASM size       | 49.2 MB              | 64.2 MB                         | 104.6 MB                        | +62.9%              |
| JS size         | 300 KB               | 289 KB                          | 511 KB                          | +76.8%              |

The `full-exceptions.yml` config is **identical** across all three commits — no flag changes. All regressions stem from `bindings.py` changes.

## Methodology

1. Extracted `build-manifest.json` at each commit via `git show`
2. Diffed the manifest to identify new failures and their error messages
3. Inspected generated `.cpp` files in `build/bindings/` for the failing symbols
4. Traced the code path in `bindings.py::_emitOutputParamBinding` for return-type handling
5. Verified OCCT header signatures for failing methods
6. Counted generated artifacts (`value_object`, `optional_override`) via ripgrep
7. Cross-referenced chat transcript for prior size investigation context

## Findings

### Finding 1: Reference-type struct fields cause 8 compile failures

All 8 new missing symbols fail with the same error pattern:

```
error: cannot form a pointer-to-member to member 'result' of reference type '...'
```

| Symbol                          | Error type                          | Reference type in error          |
| ------------------------------- | ----------------------------------- | -------------------------------- |
| BRep_Tool                       | `const occ::handle<Geom_Curve> &`   | Handle const-ref return          |
| TopOpeBRepTool_C2DF             | `const occ::handle<Geom2d_Curve> &` | Handle const-ref return          |
| IntPatch_WLine                  | `const IntPatch_Point &`            | Class const-ref return           |
| IntPatch_TheIWLineOfTheIWalking | `const gp_Vec &`                    | Geometry const-ref return        |
| Contap_TheIWLineOfTheIWalking   | `const gp_Vec &`                    | Geometry const-ref return        |
| HLRAlgo_PolyAlgo                | `HLRAlgo_BiPoint::PointsT &`        | Nested type non-const ref return |
| HLRBRep_PolyAlgo                | `HLRAlgo_BiPoint::PointsT &`        | Nested type non-const ref return |
| TopOpeBRepDS_DataStructure      | `NCollection_IndexedDataMap<...> &` | Collection non-const ref return  |

**Root cause**: When a method has both output parameters AND a non-void reference return type, `_emitOutputParamBinding` creates a result struct with a `result` field. C++ struct members cannot be reference types — `value_object<T>.field()` requires forming a pointer-to-member, which is impossible for references.

Example — `IntPatch_WLine::FirstPoint` signature:

```cpp
const IntPatch_Point& FirstPoint(int& Indfirst) const;
```

Generated struct (buggy):

```cpp
struct IntPatch_WLine_FirstPoint_Result {
  const IntPatch_Point& result;  // ERROR: reference field
  int Indfirst;
};
```

Required struct (correct):

```cpp
struct IntPatch_WLine_FirstPoint_Result {
  IntPatch_Point result;  // value copy
  int Indfirst;
};
```

**Current status**: The committed code at `508e00a` includes a reference-stripping fix:

```python
if ret.kind == clang.cindex.TypeKind.LVALUEREFERENCE:
    ret = ret.get_pointee()
```

However, the `build-manifest.json` was **not regenerated** after the fix. The current `build/bindings/` artifacts show correct value-type struct fields (e.g., `IntPatch_Point result;`, `gp_Vec result;`), confirming the fix works for direct LVALUE_REFERENCE return types. **The manifest is stale.**

### Finding 2: Potential edge case — typedef return types

The reference-stripping fix checks `ret.kind == clang.cindex.TypeKind.LVALUEREFERENCE`. This handles direct reference returns like `const gp_Vec&`. However, if a method returns a **typedef** that canonically resolves to a reference (e.g., `NCollection_Array1<T>::const_reference` → `const T&`), clang reports the kind as `TYPEDEF` or `ELABORATED`, not `LVALUEREFERENCE`.

In that case, the check would not fire, and `resolveWithCanonicalFallback` would return the canonical spelling **including the `&`**, producing an invalid struct field.

Additionally, two of the failing symbols involve **non-const reference** returns:

- `HLRAlgo_PolyAlgo` → `HLRAlgo_BiPoint::PointsT &`
- `TopOpeBRepDS_DataStructure` → `NCollection_IndexedDataMap<...> &`

Non-const reference returns typically indicate mutating accessors. Wrapping these in return-by-value changes the semantics — the caller gets a copy, not a mutable reference to the internal state. This may require an exclusion rule rather than a fix.

### Finding 3: WASM and JS size regression from Embind template bloat

The return-by-value approach generates significant new code:

| Artifact                            | Count |
| ----------------------------------- | ----- |
| `value_object` struct registrations | 1,422 |
| `optional_override` lambdas         | 5,655 |
| Result struct definitions           | 1,422 |

Each `value_object<T>` registration instantiates Embind template machinery:

- `StructBindingType<T>`, `GenericBindingType<T>`
- Per-field `getterReturnType.fromWireType` / `setterArgumentType.toWireType` closures
- JS glue code for field accessors

Each `optional_override` lambda creates a unique function type, requiring:

- A unique Embind invoker template instantiation
- JS marshalling code for the new signature
- Under `-fexceptions`: an `invoke_*` JS wrapper for every unique signature

The `full-exceptions.yml` config uses `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0` (JS exception model), which wraps every function call in a JS `try/catch` via `invoke_*` stubs. This **amplifies** the size impact because each new unique function signature introduced by `optional_override` needs its own `invoke_*` wrapper.

Prior investigation from this chat confirmed this amplification effect:

- A single-build without `-fno-exceptions` had 580 `invoke_*` imports vs 53 with `-fwasm-exceptions`
- The JS exception model added ~4,568 extra functions and ~8 MB of code size

**The size regression is inherent to the approach for the full build** (4,400+ symbols). The replicad build (~220 symbols) would see a proportionally smaller impact.

### Finding 4: compiled count decrease and extra_compiled increase

- **compiled: 4,445 → 4,441 (-4)**: Directly caused by 8 new compile failures. Some failures affect symbols that contribute multiple compiled bindings.
- **extra_compiled: 4 → 8 (+4)**: The `value_object` struct registrations pull in type dependencies that weren't in the original requested symbol list but get compiled as side effects.

**Note**: Both metrics may be different after a fresh build with the current fixed code.

## Recommendations

| #   | Action                                                                                                                                                                      | Priority | Effort | Impact                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------- |
| R1  | Re-run full-exceptions build to regenerate `build-manifest.json` and validate all 8 failures are resolved                                                                   | P0       | Low    | High — confirms fix works           |
| R2  | Add canonical-type reference stripping: after `resolveWithCanonicalFallback`, strip trailing ` &` from `retType` and remove leading `const ` to handle typedef return types | P0       | Low    | High — prevents future edge cases   |
| R3  | Exclude non-const reference returns from RBV wrapping — these are mutating accessors where value-copy semantics change behavior                                             | P1       | Low    | Medium — correctness                |
| R4  | Investigate WASM size impact on `-fwasm-exceptions` builds (expected to be much lower than `-fexceptions` due to no invoke wrappers)                                        | P1       | Medium | High — quantifies real-world impact |
| R5  | Consider lazy/on-demand `value_object` registration or a flag to disable RBV for full builds where binary size matters                                                      | P2       | High   | Medium — opt-in size reduction      |

## Code Examples

### R2: Canonical reference stripping fix

```python
# In _emitOutputParamBinding, after resolveWithCanonicalFallback:
retType = self.resolveWithCanonicalFallback(retSpelling, ret, templateDecl, templateArgs)

# Strip reference from canonical fallback (handles typedef → const T& resolution)
if retType.endswith(' &'):
    retType = retType[:-2].strip()
if retType.startswith('const '):
    retType = retType[6:].strip()
```

### R3: Non-const reference return exclusion

```python
# In _emitOutputParamBinding, before struct generation:
if ret_type.kind == clang.cindex.TypeKind.LVALUEREFERENCE:
    pointee = ret_type.get_pointee()
    if not pointee.is_const_qualified():
        return None  # Skip RBV for mutating accessors
```

## References

- Commit `508e00a`: `feat(bindings): return pointers by value instead of by reference`
- Prior build: `ffee9e7` (string-enums), `250f5ac` (suffix-overload-removal)
- Related: `docs/research/unified-return-by-value.md`
- Emscripten issue [#17765](https://github.com/emscripten-core/emscripten/issues/17765): RegisteredPointer stale `$$.ptr` (motivating issue for RBV)
