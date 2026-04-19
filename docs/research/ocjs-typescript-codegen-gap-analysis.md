---
title: 'OCJS TypeScript Codegen Gap Analysis'
description: 'Gap inventory of every codegen defect in the opencascade.js Python `.d.ts` generator that prevents valid TypeScript output, plus the design for removing the auto-generated `export namespace` package blocks.'
status: draft
created: '2026-04-10'
updated: '2026-04-10'
category: audit
related:
  - docs/research/replicad-single-dts-type-errors.md
  - docs/research/ocjs-any-type-analysis.md
  - docs/research/ocjs-test-failure-resolution.md
  - docs/research/ocjs-deprecated-symbol-strategy.md
  - docs/research/occt-v8-rc5-migration.md
---

# OCJS TypeScript Codegen Gap Analysis

Cross-reference of every defect in the `repos/opencascade.js` Python TypeScript-definition codegen (`bindings.py`, `generateBindings.py`, `buildFromYaml.py`) against the goal of producing a fully valid `.d.ts` for both `opencascade_full.d.ts` and `replicad_single.d.ts`, plus the design for removing the auto-generated `export namespace <prefix> { … }` package blocks that wrap each OCCT module.

## Executive Summary

`replicad_single.d.ts` ships with **2,416 TypeScript diagnostics** today (per `docs/research/replicad-single-dts-type-errors.md`). The previous research recommended adopting Emscripten's native `--emit-tsd` as a long-term escape hatch; we are explicitly **not** taking that path. Instead, every defect must be fixed at the Python codegen layer (`bindings.py` / `generateBindings.py` / `buildFromYaml.py`).

This document inventories **18 codegen gaps** (G1–G18) — six already cited in the prior research and twelve newly identified by an end-to-end audit — and prioritises a fix order that resolves every diagnostic class without changing the public API shape consumers rely on (`oc.BRepPrimAPI_MakeBox`, `oc.gp_Pnt`, `oc.TopoDS.Edge(shape)`, etc.).

A second, independent goal is documented here: the **removal of the auto-generated `export namespace <prefix> { … }` blocks** (`buildFromYaml.py:464–486`). A workspace-wide audit confirms **zero Tau consumers** use the namespace-style aliases (`gp.Pnt`, `Geom.Curve`, …) for type positions; the only `TopoDS.*` usage in the workspace targets the **hand-written runtime downcast API** from `BUILTIN_ADDITIONAL_BIND_CODE`, which is unrelated to the generator. The `libs/api-extractor` Monaco bundler already strips these blocks before publishing IntelliSense types. Removing the blocks is therefore a safe, low-risk simplification that also eliminates two whole gap classes (G7 namespace duplicate identifiers, G8 `typeof` on `value_object` exports).

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Codegen Pipeline Reference](#codegen-pipeline-reference)
- [Findings](#findings)
- [Gap Inventory](#gap-inventory)
- [Namespace Block Removal Plan](#namespace-block-removal-plan)
- [Recommendations](#recommendations)
- [Validation Strategy](#validation-strategy)
- [References](#references)

## Problem Statement

Two questions need definitive answers:

1. **What is the complete set of codegen defects** in the OCJS Python `.d.ts` generator that block valid TypeScript output? The prior research (`replicad-single-dts-type-errors.md`) named six top-level error classes; this audit expands the list to eighteen, with file:line evidence for each.
2. **Can the auto-generated `export namespace <prefix> { … }` blocks be removed safely**, and what is the minimal mechanical change required to remove them?

The answers must withstand Tau's "fix at source, no band-aid" rule. No post-processing scripts, no `as unknown` shims, no per-symbol allowlists.

## Methodology

1. Read the full Python codegen surface: `bindings.py` (3,100+ LOC), `generateBindings.py`, `buildFromYaml.py`, and the schema validator `customBuildSchema.py`.
2. Traced one OCCT symbol end-to-end (`gp_XYZ::AddTriangle(const gp_XYZ (&)[3])`) from C++ header → libclang AST → `processClass` → `.d.ts.json` fragment → final `.d.ts` to confirm where the `gp_XYZ[3]` mis-emission originates.
3. Cross-referenced the existing `dts-validation.test.ts` regression suite against the diagnostic classes reported by `tsc` to identify which checks the suite currently enforces and which are missing.
4. Enumerated every `return "any"` and `_collect_any` site in `bindings.py` to map the codegen's "give-up" surface.
5. Audited workspace consumers (`apps/`, `packages/`, `libs/`, `repos/replicad/`) for any reference to the auto-generated namespace aliases (`gp.Pnt`-style) and tabulated the migration cost.
6. Read `libs/api-extractor/src/extract-opencascade-types.ts` to capture the existing post-processing patterns (`findUndeclaredTypes`, `replaceAll(/^export namespace …/gm, '')`) that should be lifted upstream into the generator.

## Codegen Pipeline Reference

Quick map for navigation. All paths under `repos/opencascade.js/`.

```text
                        OCCT C++ headers
                              |
                       TuInfo.parse()  (clang.cindex AST)
                              |
        ┌─────────────────────┼──────────────────────────┐
        |                     |                          |
generateBindings.py      bindings.py             customBuildSchema.py
   (orchestrator)        (Embind + TS emit)       (YAML validator)
        |                     |
        v                     v
   *.d.ts.json fragment   *.cpp fragment
        |                     |
        |                     +---> compileBindings.py (emcc -c)
        |                                  |
        v                                  v
buildFromYaml.py:_collect_dts_fragments   *.cpp.o
        |                                  |
        v                                  v
buildFromYaml.py:main()              runBuild() (emcc link, wasm-opt)
        |                                  |
        v                                  v
  <build>.d.ts                       <build>.wasm + <build>.js
```

The Python `.d.ts` is emitted by `bindings.py:TypescriptBindings` (per-symbol fragments) and assembled by `buildFromYaml.py` (concatenate fragments → append builtin declarations → append namespace blocks → append `OpenCascadeInstance` aggregate). All gaps in this document live somewhere on this path.

## Findings

### Finding 1: TS2304 Bypass in `resolve_type` Early Return

**Severity**: P0 — Source of ~98 % of all errors

**Location**: `repos/opencascade.js/src/bindings.py:2747-2755`

`TypescriptBindings.resolve_type` short-circuits when the resolved spelling has no `(`, `:`, or `<` characters and returns the raw identifier without consulting `_known_export_names` or `exports`:

```python
spelling = self._strip_type_qualifiers_str(t.spelling)
resolved = self.resolveWithCanonicalFallback(spelling, t, templateDecl, templateArgs)
resolved = self._strip_type_qualifiers_str(resolved)
resolved = self.convertBuiltinTypes(resolved)

if resolved in ("number", "string", "boolean", "void"):
  return resolved
if resolved and resolved != "" and "(" not in resolved and ":" not in resolved and "<" not in resolved:
  return resolved   # ← raw identifier, not validated against exports
```

The downstream guards at lines 2762–2771 (canonical fallback, declaration spelling lookup) only run when this branch fails. Because OCCT method signatures reference unbound RTTI base classes (`Standard_Type`), allocator types (`NCollection_BaseAllocator`), TDF internals (`TDF_AttributeIterator`), STEP `Select` unions, etc., the early return emits hundreds of dangling identifiers.

### Finding 2: Constant-Array Type Spelling Leaks (`gp_XYZ[3]`)

**Severity**: P0 — Invalid TS syntax

**Location**: `repos/opencascade.js/src/bindings.py:2747-2755` (same guard as Finding 1)

The C++ method `void Poly_MeshPurpose::AddTriangle(const gp_XYZ (&theElemNodes)[3])` produces a libclang type whose spelling contains `[3]`. The early-return guard in `resolve_type` rejects spellings containing `(`, `:`, or `<` — but **not** `[` — so the raw spelling `gp_XYZ[3]` is passed straight through to the `.d.ts`:

```typescript
// repos/opencascade.js/replicad_single.d.ts:5104
AddTriangle(theElemNodes: gp_XYZ[3]): void;
AddQuad(theElemNodes: gp_XYZ[4]): void;
```

In TypeScript `gp_XYZ[3]` is property access on the `gp_XYZ` type (TS2339), not a fixed-size tuple. The previous research filed this as the "`gp_XYZ.[3|4]` typo"; the actual root cause is `clang.cindex.TypeKind.CONSTANTARRAY` reaching the codegen unhandled.

### Finding 3: Duplicate Identifiers in Namespace Blocks (TS2300)

**Severity**: P1

**Location**: `repos/opencascade.js/src/buildFromYaml.py:464-486`

The namespace generator splits each export name on the first underscore, drops names whose suffix begins with a digit, and emits one `export type <short> = <full>;` per remaining symbol. It does not deduplicate by `(prefix, short_name)`:

```python
namespaces = defaultdict(list)
for ex in typescriptExports:
  name = ex["export"]
  idx = name.find("_")
  if idx > 0:
    prefix = name[:idx]
    short_name = name[idx+1:]
    if short_name and not short_name[0].isdigit():
      namespaces[prefix].append((short_name, ex))

for ns_name in sorted(namespaces.keys()):
  entries = namespaces[ns_name]
  typescriptDefinitionOutput += f"export namespace {ns_name} {{\n"
  for short_name, ex in sorted(entries, key=lambda e: e[0]):
    # … emits `export type <short> = …;` even when `<short>` repeats
```

When two different bound classes share a prefix and short name (e.g. an overload subclass plus its base), TS2300 fires.

### Finding 4: `typeof` on Non-Constructor Exports (TS2693)

**Severity**: P1

**Location**: `repos/opencascade.js/src/buildFromYaml.py:481-484`

The namespace generator emits `export type <short> = typeof <full>;` whenever the source kind is `"function"`. Embind `value_object` registrations (`emscripten::value_object<T>`) are emitted by `bindings.py` as type-only declarations, not constructable classes — `typeof` on them produces TS2693 ("only refers to a type, but is being used as a value"). The generator has no awareness of the difference between `class_<T>` and `value_object<T>` exports.

### Finding 5: `WebAssembly.Exception` Lib Gap (TS2694)

**Severity**: P2 — Only fires on builds compiled with `-fwasm-exceptions`

**Location**: `repos/opencascade.js/src/buildFromYaml.py:489-518`

When `uses_native_wasm_eh` is true, the generator emits `export declare function getExceptionMessage(ex: WebAssembly.Exception): [string, string];` and two refcount helpers. Stock TypeScript `lib.dom.d.ts` and `lib.es2022.d.ts` declare `WebAssembly` as a namespace but do not include `Exception` — that interface is part of the WebAssembly JS Promise Integration / Exception Handling proposal and ships in `@types/wasm-feature-detect` or via a project-level ambient declaration. The generator never emits an ambient supplement.

### Finding 6: Missing C-Primitive Mappings

**Severity**: P1

**Location**: `repos/opencascade.js/src/bindings.py:2284-2322` (`_NUMERIC_TYPES`, `_STRING_TYPES`, `convertBuiltinTypes`)

The numeric set covers `size_t`, `Standard_Integer`, `Standard_Real`, etc., but omits the fixed-width family that OCCT v8 surfaces increasingly use:

| Missing spelling                                     | TS target | Source of leak                                             |
| ---------------------------------------------------- | --------- | ---------------------------------------------------------- |
| `uint8_t`                                            | `number`  | OCCT v8 `Poly_Triangulation::SetIndex` and similar         |
| `int8_t`                                             | `number`  | `<cstdint>` clones                                         |
| `uint16_t`, `int16_t`                                | `number`  | network/file I/O wrappers                                  |
| `intptr_t`, `uintptr_t`                              | `number`  | RTTI / opaque pointer APIs                                 |
| `wchar_t`, `char8_t`, `char16_t`, `char32_t`         | `string`  | text APIs                                                  |
| `__SIZE_TYPE__` (compiler builtin alias of `size_t`) | `number`  | seen on some Clang configs                                 |
| `Standard_PCharacter`                                | `string`  | mutable C-string output (currently leaked as raw spelling) |

These spellings reach the early-return guard in Finding 1 and surface as TS2304 "Cannot find name 'uint8_t'".

### Finding 7: `unsigned char` Misclassified as String

**Severity**: P1 — Wrong types in `.d.ts`, not just missing

**Location**: `repos/opencascade.js/src/bindings.py:2681-2685` (`_BUILTIN_STRING_KINDS`) and `2738-2741` (`resolve_type`)

`_BUILTIN_STRING_KINDS` includes `clang.cindex.TypeKind.CHAR_U` and `UCHAR`. When `uint8_t` canonicalises to `unsigned char` (its underlying type on most platforms), the type-kind branch fires **before** the typedef-name branch and returns `"string"`. Numeric byte parameters become `: string` in the `.d.ts`. This is worse than a missing identifier: the type is a lie, and TypeScript will accept wrong calls without complaint.

### Finding 8: TS2416 Override Mismatch on `TDataStd_GenericExtString.SetID`

**Severity**: P3 — One occurrence in the bound surface

**Location**: `repos/opencascade.js/src/bindings.py` `_buildOutputParamReturnType` and `processMethodOrProperty`

`TDataStd_GenericExtString.SetID(theGUID, theLockMode)` has output-parameter handling that returns an inline object. The base class signature differs because the codegen lacks an inheritance-aware compatibility check before applying the output-param transform on overrides. Result: TS2416 ("Property 'SetID' in type 'TDataStd_GenericExtString' is not assignable to base").

### Finding 9: Reserved-Word Parameter Name Escaping Is Incomplete

**Severity**: P2

**Location**: `repos/opencascade.js/src/bindings.py:2781-2785` (`_argname`)

```python
def _argname(self, arg, suffix = ""):
  argname = (arg.spelling if not arg.spelling == "" else ("a" + str(suffix)))
  if argname in ["var", "with", "super"]:
    argname += "_"
  return argname
```

OCCT parameter names like `class`, `interface`, `type`, `enum`, `function`, `default`, `delete`, `new`, `let`, `const`, `async`, `await`, `yield`, `static`, `public`, `private`, `protected`, `import`, `export` would all emit invalid TypeScript identifiers. The current OCCT API does not appear to use these names in bound signatures, but the codegen has no defence-in-depth and a future header change could silently break the build.

### Finding 10: JSDoc Text Not Escaped for Comment Terminators

**Severity**: P2

**Location**: `repos/opencascade.js/src/bindings.py:1967-2026` (`_jsdoc`, `_enum_member_jsdoc`)

`brief`, `description`, and `@param` text from Doxygen comments is pasted verbatim. A `*/` substring in OCCT's source comments terminates the JSDoc block early, breaks the surrounding `/**`, and shifts every subsequent declaration into a comment. The risk is small (OCCT's comments are mostly clean) but the codegen has no protection against an accidental Doxygen `*/` infix.

### Finding 11: `_reverse_typedef_cache` is First-Wins, Not OCCT-Aware

**Severity**: P2 — Wrong typedef alias chosen for some templates

**Location**: `repos/opencascade.js/src/bindings.py:2436-2467` (`_find_typedef_for_container`)

When two typedefs share the same canonical underlying spelling (e.g. an OCCT public alias plus a private internal one), the first one walked wins. This is non-deterministic across libclang versions and can pick the internal name over the OCCT-public one. The fix is to prefer typedefs whose name matches `^(NCollection_|TColStd_|TColgp_|TopTools_|...)` patterns, or to explicitly prefer names already present in `exports`.

### Finding 12: `Handle_Foo` Typedefs Excluded From Template Resolution

**Severity**: P2 — Asymmetric handling of OCCT smart pointers

**Location**: `repos/opencascade.js/src/generateBindings.py:98-100` (`filterTemplates` rejects `Handle_*`); `repos/opencascade.js/src/bindings.py:2687-2703` (`_resolve_handle_recursive` accepts only `decl.spelling == "handle"` under `opencascade`/`occ`)

OCCT exposes both `opencascade::handle<T>` (canonical template) and `Handle_T` (typedef alias). The codegen recognises the first form via `_resolve_handle_recursive` but excludes `Handle_T` typedefs from the template walk in `filterTemplates`. Methods that take a `Handle_T` parameter (instead of the canonical template) fall through to Finding 1's raw-spelling early return.

### Finding 13: `OpenCascadeInstance` Aggregate Allows Duplicate Properties

**Severity**: P2

**Location**: `repos/opencascade.js/src/buildFromYaml.py:557`

```python
"export type OpenCascadeInstance = " + runtime_type + " & {\n  "
  + ";\n  ".join(map(lambda x: x["export"] + ": typeof " + x["export"], typescriptExports))
  + ";\n};\n\n"
```

`typescriptExports` is a list of `{ export, kind }` dicts collected by appending across fragments. If two fragments export the same name (overload subclasses, namespace-stub re-emission, builtin re-registration via the appended declarations), the aggregate type literal contains duplicate property declarations, which TypeScript flags as `TS2300` under strict object literal checks. There is no deduplication step before the join.

### Finding 14: `processEnum` Does Not Validate Enumerator Identifiers

**Severity**: P2

**Location**: `repos/opencascade.js/src/bindings.py` `processEnum` (~3063-3073) versus nested-enum branch in `processClass` (~2141 — has `isidentifier()` check)

Top-level enums emit constant property names directly from the C++ enumerator spelling. Nested enums perform a `str.isidentifier()` check first; standalone enums do not. OCCT enumerators are well-formed in practice, but the asymmetry means a future scoped-enum addition with a non-identifier value (e.g. a reserved JS keyword) would emit invalid TS only for the standalone case.

### Finding 15: Empty Forward-Declaration Stubs From `_namespace_scoped_interfaces`

**Severity**: P3 — Hides missing real declarations

**Location**: `repos/opencascade.js/src/bindings.py:2179-2183` (`processFinalizeClass`)

When a nested type spelling like `Parent_Child` is referenced before its real declaration is emitted, `_resolve_nested_type` adds it to `_namespace_scoped_interfaces` and `processFinalizeClass` emits `export interface <name> {}` — an empty shell. The empty interface satisfies references syntactically but supplies no members, so consumer code that calls a method on the type silently typechecks against `{}`. The stub also hides any later real-declaration omission.

### Finding 16: `_collect_any` Reasons Are Narrow

**Severity**: P3 — Tooling / observability

**Location**: `repos/opencascade.js/src/bindings.py:2427-2432`, plus `return "any"` sites at 2534-2535, 2572-2573, 2773-2774

Three reasons are tracked (`handle_inner_unresolvable`, `unrecognized_template`, `final_fallback`); other `any` returns occur silently. This makes it hard to prioritise codegen fixes from the report at the end of `buildFromYaml.py`. Every `return "any"` should call `_collect_any` with a specific reason.

### Finding 17: `dts-validation.test.ts` Misses Semantic Errors

**Severity**: P1 — Regression detection

**Location**: `repos/opencascade.js/tests/dts-validation.test.ts:184-241`

The current suite checks:

- Syntactic-only diagnostics (`getSyntacticDiagnostics`) — does not catch TS2304/TS2300/TS2693/TS2416/TS2339
- A regex for `::` leaks
- A regex for bare `<` in type position
- An `any`-count regression threshold (148)
- YAML-symbol ↔ `.d.ts` coverage

Missing checks (each maps to a finding above): full program diagnostics including TS2304 (G1, G2, G6, G12), TS2300 (G3, G13), TS2693 (G4), TS2416 (G8), TS2339 (G2). After the codegen fixes land, the suite should assert zero of each.

### Finding 18: Hand-Written `TopoDS` Runtime Class Is Conflated With Generator Output

**Severity**: P3 — Documentation / maintainability

**Location**: `repos/opencascade.js/src/buildFromYaml.py:24-69` (`BUILTIN_ADDITIONAL_BIND_CODE`) and the namespace generator at 464-486

The hand-written `class_<TopoDS_Bind_>("TopoDS")` registration provides runtime downcast helpers (`oc.TopoDS.Edge(shape)`, `oc.TopoDS.Wire(shape)`, …) and is consumed by `repos/replicad/packages/replicad/src/shapes.ts:1250-1256`, `importers.ts:68`, and `packages/runtime/src/kernels/opencascade/opencascade.kernel.test.ts`. The auto-generated `export namespace TopoDS { export type Edge = TopoDS_Edge; … }` block coincidentally overlaps the same name. Removing the auto-generated block (per the second goal of this document) **must not** touch the hand-written runtime class; the prefix collision is incidental.

## Gap Inventory

Single-table view of every gap, severity, and the recommendation that resolves it.

| Gap | Title                                                 | Severity | Owning layer                      | File:line                                             | Resolved by         |
| --- | ----------------------------------------------------- | -------- | --------------------------------- | ----------------------------------------------------- | ------------------- |
| G1  | TS2304 raw-spelling early return                      | P0       | bindings.py                       | `bindings.py:2747-2755`                               | R1 + R3             |
| G2  | `gp_XYZ[3]` C-array spelling leak (TS2339)            | P0       | bindings.py                       | `bindings.py:2747-2755`                               | R2                  |
| G3  | Missing C-primitive mappings (`uint8_t`, etc.)        | P1       | bindings.py                       | `bindings.py:2284-2322`                               | R4                  |
| G4  | `unsigned char` misclassified as `string`             | P1       | bindings.py                       | `bindings.py:2681-2741`                               | R5                  |
| G5  | `_BUILTIN_NUMERIC_KINDS` omits `signed char` byte-int | P2       | bindings.py                       | `bindings.py:2672-2685`                               | R5                  |
| G6  | `Handle_Foo` typedefs excluded from template walk     | P2       | generateBindings.py + bindings.py | `generateBindings.py:98-100`, `bindings.py:2687-2703` | R6                  |
| G7  | Duplicate identifiers in namespace blocks (TS2300)    | P1       | buildFromYaml.py                  | `buildFromYaml.py:464-486`                            | R10 (block removal) |
| G8  | `typeof` on `value_object` exports (TS2693)           | P1       | buildFromYaml.py                  | `buildFromYaml.py:481-484`                            | R10 (block removal) |
| G9  | TS2694 `WebAssembly.Exception` lib gap                | P2       | buildFromYaml.py                  | `buildFromYaml.py:489-518`                            | R7                  |
| G10 | TS2416 override variance on `SetID`                   | P3       | bindings.py                       | `_buildOutputParamReturnType`                         | R8                  |
| G11 | Reserved-word parameter escaping incomplete           | P2       | bindings.py                       | `bindings.py:2781-2785`                               | R9                  |
| G12 | JSDoc not escaped for `*/` terminators                | P2       | bindings.py                       | `bindings.py:1967-2026`                               | R12                 |
| G13 | First-wins typedef alias selection                    | P2       | bindings.py                       | `bindings.py:2436-2467`                               | R13                 |
| G14 | `OpenCascadeInstance` aggregate allows duplicates     | P2       | buildFromYaml.py                  | `buildFromYaml.py:557`                                | R14                 |
| G15 | `processEnum` skips identifier validation             | P2       | bindings.py                       | `processEnum`                                         | R15                 |
| G16 | Empty `_namespace_scoped_interfaces` stubs hide bugs  | P3       | bindings.py                       | `bindings.py:2179-2183`                               | R16                 |
| G17 | `_collect_any` reason coverage incomplete             | P3       | bindings.py                       | `_collect_any` + 3 sites                              | R17                 |
| G18 | `dts-validation.test.ts` only covers syntactic errors | P1       | tests                             | `tests/dts-validation.test.ts`                        | R18                 |

Note: G7 and G8 disappear automatically when the auto-generated namespace blocks are removed (R10 below). They are listed for completeness; the rest of the gaps are codegen-correctness defects that exist independent of the namespace blocks.

## Namespace Block Removal Plan

The auto-generated `export namespace <prefix> { … }` blocks are an OCCT-package-organisation convenience that no Tau consumer depends on. Removing them eliminates two whole gap classes (G7, G8) and shrinks the generated `.d.ts` measurably.

### Consumer Audit Result

A workspace-wide audit (`apps/`, `packages/`, `libs/`, `repos/replicad/`) returned:

| Pattern                                                                              | Files | References | Action                                                          |
| ------------------------------------------------------------------------------------ | ----- | ---------- | --------------------------------------------------------------- |
| `gp.<Member>` (auto-generated namespace, type position)                              | 0     | 0          | Safe to remove                                                  |
| `Geom.<Member>`, `Quantity.<Member>`, `BRep.<Member>`, … (any auto-generated prefix) | 0     | 0          | Safe to remove                                                  |
| `oc.TopoDS.<Member>` (hand-written runtime downcast API)                             | 3     | 9          | **Preserve** (unrelated to generator)                           |
| `oc.<FlatName>.<Member>` (e.g. `oc.TopAbs_ShapeEnum.TopAbs_VERTEX`)                  | many  | many       | **Preserve** (enum/static access on flat exports, not affected) |
| Flat imports `gp_Pnt`, `TopoDS_Shape`, `BRepPrimAPI_MakeBox`                         | many  | many       | **Preserve** (the dominant style)                               |

The hand-written `TopoDS` runtime class (`buildFromYaml.py:51-67`) provides downcast helpers used by replicad's `shapes.ts` and `importers.ts`. It is registered via `class_<TopoDS_Bind_>("TopoDS")` in `BUILTIN_ADDITIONAL_BIND_CODE` and surfaces in the `.d.ts` via the explicit declaration in `repos/opencascade.js/src/declarations/builtin-bindings.d.ts` (the file appended at `buildFromYaml.py:445-446`). Its prefix happens to match an auto-generated namespace, but the two are completely separate code paths — removing the auto-generator does not touch the runtime class.

### Existing Stripping Precedent

`libs/api-extractor/src/extract-opencascade-types.ts:91` already strips these blocks before the Monaco bundle is produced:

```typescript
// Strip namespace convenience alias blocks (e.g. `export namespace BRep { ... }`)
content = content.replaceAll(/^export namespace \w+ {[\S\s]*?^}\n\n/gm, '');
```

So Monaco IntelliSense already does not expose namespace-style aliases. Only the live `.d.ts` files (the ones developers open directly in the IDE) contain them today. Removing them at the source is congruent with how downstream tooling already treats the output.

### Mechanical Change

Delete `buildFromYaml.py:464-486`:

```python
# --- Generate namespace blocks for OCCT package organization (Finding 6, Path A) ---
from collections import defaultdict
namespaces = defaultdict(list)
for ex in typescriptExports:
  name = ex["export"]
  idx = name.find("_")
  if idx > 0:
    prefix = name[:idx]
    short_name = name[idx+1:]
    if short_name and not short_name[0].isdigit():
      namespaces[prefix].append((short_name, ex))

for ns_name in sorted(namespaces.keys()):
  entries = namespaces[ns_name]
  typescriptDefinitionOutput += f"export namespace {ns_name} {{\n"
  for short_name, ex in sorted(entries, key=lambda e: e[0]):
    full_name = ex["export"]
    if ex["kind"] == "function":
      typescriptDefinitionOutput += f"  export type {short_name} = typeof {full_name};\n"
    else:
      typescriptDefinitionOutput += f"  export type {short_name} = {full_name};\n"
  typescriptDefinitionOutput += "}\n\n"
# --- End namespace blocks ---
```

After deletion, `from collections import defaultdict` becomes unused at this site — remove the local import too. `typescriptExports` continues to be used for the `OpenCascadeInstance` aggregate at line 557, so do not remove its construction.

### Cleanup of Downstream Consumers

`libs/api-extractor/src/extract-opencascade-types.ts:91` no longer needs to strip blocks that the generator no longer emits. Remove the stripping line and its comment in the same change. Update the test at `libs/api-extractor/src/generated/opencascade/opencascade.bundled.test-d.ts` if it asserts the absence of namespace blocks (the assertion will still hold but the regex check is now redundant).

### Net Diff Estimate

- `buildFromYaml.py`: −24 lines (the namespace block + import)
- `extract-opencascade-types.ts`: −2 lines (strip statement + comment)
- `replicad_single.d.ts`: estimated −500 to −1,000 lines (50 prefixes × ~10–20 entries each)
- `opencascade_full.d.ts`: estimated several thousand lines smaller

### Risks

| Risk                                                               | Mitigation                                                                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External (non-Tau) consumer depends on `gp.Pnt`-style aliases      | Document the breaking change in `repos/opencascade.js/CHANGELOG.md`; per Tau's "no backwards-compat for unreleased/internal APIs" rule, no shim is added |
| Hand-written `TopoDS` runtime class accidentally caught in cleanup | Visually verify the `class_<TopoDS_Bind_>` registration in `BUILTIN_ADDITIONAL_BIND_CODE` and the `builtin-bindings.d.ts` declaration are untouched      |
| Monaco IntelliSense regression                                     | Already stripped in `extract-opencascade-types.ts`; no behavioural change                                                                                |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Priority | Effort  | Impact                                                                                                             | Gaps      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| R1  | In `bindings.py:resolve_type` early-return guard, validate the resolved spelling against `self.exports ∪ TypescriptBindings._known_export_names ∪ TypescriptBindings._known_typedef_names ∪ {primitive aliases}`. If unknown, fall through to the canonical/fallback path instead of returning the raw spelling.                                                                                                                                                                       | **P0**   | Low     | Eliminates ~2,300 TS2304                                                                                           | G1        |
| R2  | In `bindings.py:resolve_type`, detect `clang.cindex.TypeKind.CONSTANTARRAY` (and `INCOMPLETEARRAY`, `VARIABLEARRAY`) on `t` or its `_strip_qualifiers` result and emit `[T, T, …]` (tuple, when the size is fixed and ≤ 16) or `T[]` (otherwise). Add the `[` character to the rejection guard so any future array spelling falls through.                                                                                                                                             | **P0**   | Low     | Fixes TS2339 for `gp_XYZ[3]`/`[4]`; future-proofs against `Vec3f[N]` etc.                                          | G2        |
| R3  | When R1's lookup fails, instead of returning `"any"` silently, emit `unknown` (stricter) and call `_collect_any('unbound_reference', spelling)` so the build report surfaces every unresolved name. Cross-check with the symbol manifest to decide whether the type is missing from the YAML or genuinely outside the bound surface.                                                                                                                                                   | **P0**   | Low     | Replaces the `findUndeclaredTypes` external stub-prepend pass; gives the codegen a single self-consistent fallback | G1        |
| R4  | Extend `_NUMERIC_TYPES` with `uint8_t`, `int8_t`, `uint16_t`, `int16_t`, `intptr_t`, `uintptr_t`, `__SIZE_TYPE__`. Extend `_STRING_TYPES` with `Standard_PCharacter`, `wchar_t`, `char8_t`, `char16_t`, `char32_t`.                                                                                                                                                                                                                                                                    | **P1**   | Trivial | Removes the C-primitive leak family                                                                                | G3        |
| R5  | Reorder `resolve_type` to consult typedef name **before** `_BUILTIN_STRING_KINDS`. Specifically: if the original (pre-canonical) spelling is in `_NUMERIC_TYPES`, return `"number"` even when the canonical TypeKind is `UCHAR`/`CHAR_U`. This fixes the `uint8_t → unsigned char → "string"` mis-mapping.                                                                                                                                                                             | **P1**   | Low     | Stops emitting wrong types for byte-numeric APIs                                                                   | G4, G5    |
| R6  | Teach `_resolve_handle_recursive` to also accept declarations whose spelling matches `^Handle_[A-Z]` and whose underlying type is `opencascade::handle<T>`. Stop excluding `Handle_*` from `filterTemplates` in `generateBindings.py:98-100`; the filter is asymmetric with the C++ side.                                                                                                                                                                                              | **P2**   | Low     | Closes the `Handle_T` typedef gap                                                                                  | G6        |
| R7  | When `uses_native_wasm_eh`, prepend an ambient declaration block before the `getExceptionMessage` declaration:<br>`declare global { namespace WebAssembly { interface Exception { is(tag: WebAssembly.Tag): boolean; getArg(tag: WebAssembly.Tag, index: number): unknown; } class Tag { constructor(type: { parameters: WebAssembly.ValueType[] }); } } }`<br>This satisfies the `WebAssembly.Exception` reference without forcing consumers to pull in `@types/wasm-feature-detect`. | **P2**   | Low     | Removes 3 TS2694                                                                                                   | G9        |
| R8  | In `_buildOutputParamReturnType`, before applying the inline-object return shape, walk the class's method-resolution order (`tuInfo.classDict[base.spelling]`) and check whether the same method on a base class would receive a different return type. If so, skip the output-param transform on the override and emit the base-compatible signature.                                                                                                                                 | **P3**   | Medium  | Removes TS2416 on `SetID` and any future inheritance-aware override mismatch                                       | G10       |
| R9  | Replace `_argname`'s three-element list with the full TypeScript reserved-word + strict-mode reserved-word set. Suffix `_` on collision. Add a regression test in `dts-validation.test.ts` that asserts no parameter name in the generated `.d.ts` is a reserved word.                                                                                                                                                                                                                 | **P2**   | Low     | Defence in depth; no current symbols affected                                                                      | G11       |
| R10 | **Delete the namespace-block generator at `buildFromYaml.py:464-486`** (and the local `from collections import defaultdict`). Simultaneously delete the strip pattern in `libs/api-extractor/src/extract-opencascade-types.ts:91` and its comment. Document the change in `repos/opencascade.js/CHANGELOG.md`.                                                                                                                                                                         | **P1**   | Trivial | Eliminates G7 (TS2300) and G8 (TS2693) entirely; shrinks `.d.ts` measurably                                        | G7, G8    |
| R11 | After R10, audit the `OpenCascadeInstance` aggregate at `buildFromYaml.py:557` and add a `seen = set()` deduplication pass before joining the property declarations.                                                                                                                                                                                                                                                                                                                   | **P2**   | Trivial | Defence in depth                                                                                                   | G14       |
| R12 | Sanitize JSDoc text in `_jsdoc` and `_enum_member_jsdoc`: replace `*/` with `*\/` and any backtick-fenced code that contains `*/` with the same substitution. Add a unit test for both helpers.                                                                                                                                                                                                                                                                                        | **P2**   | Low     | Future-proofs against OCCT comment changes                                                                         | G12       |
| R13 | In `_find_typedef_for_container`, when multiple typedefs share a canonical spelling, prefer the typedef whose name is in `exports`, then the one matching `^(NCollection_\|TColStd_\|TColgp_\|TopTools_\|MeshVS_\|XCAFDoc_)`, then alphabetical first. Replace the first-wins behaviour with a deterministic ordering.                                                                                                                                                                 | **P2**   | Low     | Eliminates non-deterministic alias choice                                                                          | G13       |
| R14 | Add identifier validation (`str.isidentifier()`) to `processEnum`, matching the existing nested-enum path. Skip or rename non-identifier enumerators.                                                                                                                                                                                                                                                                                                                                  | **P2**   | Trivial | Closes asymmetric handling                                                                                         | G15       |
| R15 | Replace the empty `export interface <name> {}` stub in `processFinalizeClass:2179-2183` with either (a) the real declaration emitted at the end of pass 2, or (b) `export type <name> = unknown;` so consumers cannot silently typecheck against `{}`. Decide based on whether `_resolve_nested_type` ever runs on a name that has no real declaration anywhere.                                                                                                                       | **P3**   | Medium  | Stops empty-shell types from masking missing declarations                                                          | G16       |
| R16 | Add `_collect_any('reason_label', spelling)` calls at every remaining `return "any"` site (lines 2534-2535, 2572-2573, 2773-2774). Surface the full report at the end of `buildFromYaml.py` and in the build manifest.                                                                                                                                                                                                                                                                 | **P3**   | Trivial | Observability for future cleanup                                                                                   | G17       |
| R17 | Extend `dts-validation.test.ts` to run `getSemanticDiagnostics` (not just `getSyntacticDiagnostics`) against `replicad_single.d.ts` and `opencascade_full.d.ts` and assert zero diagnostics for codes `TS2304`, `TS2300`, `TS2693`, `TS2694`, `TS2339`, `TS2416`, `TS2552` after R1–R10 land. Add specific regex checks for `gp_XYZ[`, `: uint8_t`, and `: unsigned char` returning string positions.                                                                                  | **P1**   | Low     | Permanent regression gate for every gap in this audit                                                              | G18       |
| R18 | Remove the stale orphan `repos/opencascade.js/replicad_single.d.ts` (untracked copy from a pre-`dist/` build) and add a `.gitignore` entry preventing recurrence. Already mentioned in the prior research; restated here for completeness.                                                                                                                                                                                                                                             | P2       | Trivial | Eliminates the IDE-visible source of confusion                                                                     | (cleanup) |

## Validation Strategy

After R1–R10 land, success is measured by these gates, in order:

1. **Symbol parity**: `dts-validation.test.ts` `should have all symbols from full.yml declared in the .d.ts` continues to pass (no regression in coverage).
2. **Syntactic clean**: `getSyntacticDiagnostics().length === 0` on both `.d.ts` files (already enforced).
3. **Semantic clean**: new R17 assertion — `getSemanticDiagnostics()` reports zero of `TS2304`, `TS2300`, `TS2693`, `TS2694`, `TS2339`, `TS2416`, `TS2552`.
4. **Type accuracy**: new R17 assertion — no `: uint8_t`, `: size_t`, or `gp_XYZ[` substrings in the generated output; `unsigned char` does not map to `string` for byte-int APIs.
5. **Namespace removal**: new assertion that `replaceAll(/^export namespace \w+ {/gm, '')` is a no-op on the generated `.d.ts` (i.e. the generator emits zero namespace blocks).
6. **`any` count**: existing regression threshold (148) holds or decreases.
7. **No consumer regression**: `pnpm nx typecheck runtime`, `pnpm nx test runtime`, and a clean `pnpm nx build ocjs` complete without TypeScript errors and produce identical WASM/JS bytes (the `.d.ts` change is type-only, not runtime).

A staged rollout (R1, R2, R10 first) clears the bulk of diagnostics; R3–R17 land incrementally without re-introducing regressions because R17's gate runs in CI.

## References

- Prior research: `docs/research/replicad-single-dts-type-errors.md` (the 2,416-error inventory)
- Related research: `docs/research/ocjs-any-type-analysis.md` (existing `any`-type categorisation)
- Related research: `docs/research/ocjs-test-failure-resolution.md`
- Related research: `docs/research/ocjs-deprecated-symbol-strategy.md`
- Codegen: `repos/opencascade.js/src/bindings.py` (`TypescriptBindings` class)
- Codegen: `repos/opencascade.js/src/generateBindings.py` (`typescriptGenerationFuncClasses`, `filterTemplates`)
- Codegen: `repos/opencascade.js/src/buildFromYaml.py` (`_collect_dts_fragments`, namespace generator at 464-486, `OpenCascadeInstance` aggregate at 557)
- Codegen: `repos/opencascade.js/src/TuInfo.py` (libclang AST parse)
- Builtin declarations: `repos/opencascade.js/src/declarations/builtin-bindings.d.ts`
- Existing post-processing: `libs/api-extractor/src/extract-opencascade-types.ts:40-91`
- Regression tests: `repos/opencascade.js/tests/dts-validation.test.ts`
- Generated artifact (live): `repos/opencascade.js/dist/replicad_single.d.ts`
- Generated artifact (orphan): `repos/opencascade.js/replicad_single.d.ts` (to be deleted)
- Hand-written runtime classes: `repos/opencascade.js/src/buildFromYaml.py:24-69` (`BUILTIN_ADDITIONAL_BIND_CODE`)
- Consumer of hand-written `TopoDS`: `repos/replicad/packages/replicad/src/shapes.ts:1250-1256`, `importers.ts:68`, `packages/runtime/src/kernels/opencascade/opencascade.kernel.test.ts:112,118`
