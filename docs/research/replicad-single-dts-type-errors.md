---
title: 'replicad-opencascadejs `replicad_single.d.ts` Type Errors'
description: 'Audit of 2,416 TypeScript errors in the generated replicad single-build .d.ts and triage of which are STEP-PBR remnants vs longstanding codegen gaps'
status: active
created: '2026-04-17'
updated: '2026-04-17'
category: audit
related:
  - docs/research/wasm-heap-view-detachment.md
  - docs/research/occt-v8-rc5-migration.md
  - docs/research/ocjs-any-type-analysis.md
---

# replicad-opencascadejs `replicad_single.d.ts` Type Errors

Audit of the type errors in the generated `replicad_single.d.ts`, triage of which (if any) trace back to the deferred STEP-PBR / `XCAFDoc_VisMaterial` work, and recommendations for cleaning up the noise without binding any new heavyweight TKVCAF/Graphic3d symbols.

## Executive Summary

`tsc` reports **2,416 errors across 269 unique unresolved identifiers** in `repos/opencascade.js/dist/replicad_single.d.ts` (and the orphan copy at `repos/opencascade.js/replicad_single.d.ts`). **Zero of them are leftover from the abandoned STEP-PBR effort** — the only `XCAFDoc_VisMaterial*` reference is a single static method (`XCAFDoc_DocumentTool::VisMaterialTool()`) inherited from the bound `XCAFDoc_DocumentTool` class. The 269 missing names are a longstanding codegen quality bug: `buildFromYaml.py` emits method signatures referencing OCCT types it never binds (RTTI base classes, NCollection allocators, `gp_` primitives, STEP `Select` unions, TDF/CDM internals, etc.) and `tsc` cannot resolve them. None of these errors surface in production typechecking because `tsconfig.base.json` sets `skipLibCheck: true`, and no Tau code imports any of the missing names. **Recommended fix: lift the `findUndeclaredTypes` + `export type X = unknown;` stub-prepend pass that already lives in `libs/api-extractor/src/extract-opencascade-types.ts` upstream into `buildFromYaml.py` so all builds (full and replicad-single) emit a clean `.d.ts` at build time.** Fix the small number of legitimate codegen bugs (duplicate identifiers, `value_object` types used as constructors, `gp_XYZ.[3|4]` typo, `WebAssembly.Exception` lib gap) separately.

**Layer attribution**: ten of the eleven recommendations resolve at the **custom Python codegen** layer (`repos/opencascade.js/src/bindings.py`, `buildFromYaml.py`) or the **YAML symbol list** (`custom_build_single.yml`); only TS2694 has any Emscripten-flag dimension. **None** of these errors are addressable by changing the Emscripten build configuration alone. Emscripten ships a native alternative — `emcc --emit-tsd` — that would eliminate TS2304 by construction, but adopting it is a public-API-shape break (see Finding 12, Finding 13, and the "Architectural Alternative" section below).

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [STEP-PBR Status (What Was Deferred)](#step-pbr-status-what-was-deferred)
- [Findings](#findings)
- [Architectural Alternative: `emcc --emit-tsd`](#architectural-alternative-emcc---emit-tsd)
- [Recommendations](#recommendations)
- [Trade-offs](#trade-offs)
- [Code Examples](#code-examples)
- [References](#references)
- [Appendix: Full Bucket Inventory](#appendix-full-bucket-inventory)

## Problem Statement

The user opened `repos/opencascade.js/replicad_single.d.ts` in the IDE and saw `Cannot find name 'Quantity_NameOfColor'` (TS2552) on line 45 along with hundreds of similar squiggles throughout the file. Two questions need answering:

1. Which of these errors are "live debt" left over from the STEP-PBR / XCAF visual-material work that was started but stopped because the visual material classes (`XCAFDoc_VisMaterial`, `Graphic3d_PBRMaterial`, …) drag in `TKService` / `TKOpenGl` which is not in scope for a CAD-oriented WASM build?
2. Which are pre-existing codegen noise that has nothing to do with that effort, and how should we clean them up?

## Methodology

1. Listed both `.d.ts` files in the workspace (root-level orphan + `dist/` build output) and confirmed they are byte-equivalent in error content. The root copy is untracked (an orphan from a pre-`dist/` build run); the `dist/` copy is the live build artifact (gitignored).
2. Ran `npx tsc --noEmit --target es2022 --moduleResolution node --strict false repos/opencascade.js/replicad_single.d.ts` to enumerate every diagnostic.
3. Counted errors by code (`TS2304`, `TS2552`, `TS2300`, `TS2693`, `TS2694`, `TS2339`, `TS2416`) and extracted the full set of unique unresolved identifiers from `Cannot find name '<X>'` messages.
4. Grouped the 269 unresolved identifiers into 22 OCCT-package buckets via a Python categorizer to expose patterns.
5. Reviewed the diff of `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` against `taucad/main` and the diff of `repos/replicad/packages/replicad/src/export/assemblyExporter.ts` to identify which symbols the STEP-PBR effort added vs deliberately removed, and which deferred classes might still be referenced.
6. Cross-checked imports across `apps/`, `packages/`, and `libs/` to see whether any of the 269 missing names are imported by Tau code — they are not.
7. Read `repos/opencascade.js/src/buildFromYaml.py` (the codegen entry point) and `libs/api-extractor/src/extract-opencascade-types.ts` to compare how each handles undeclared references, and to find the existing fix pattern that should be lifted upstream.

## STEP-PBR Status (What Was Deferred)

The STEP-PBR work (visual material + density passthrough on `STEPCAFControl_Writer`) was paused once it became clear that XCAF Level 3 visual materials (`XCAFDoc_VisMaterial*`, `XCAFDoc_VisMaterialTool`) transitively depend on `Graphic3d_PBRMaterial`, which lives in `TKService` and pulls in `TKOpenGl` — heavy graphics-rendering bindings that are not in the spirit of replicad's CAD-only WASM module. The current state of the workstream:

| Item                                                                                                            | Status         | Evidence                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GLTF PBR (per-shape `metallic` / `roughness` / `color` / `alpha`)                                               | ✅ Shipped     | `assemblyExporter.ts` `ShapeConfig` accepts `metallic` / `roughness` / threaded to GLTF only                                                                                                                                                       |
| STEP density (Level 2 XCAF physical/manufacturing material)                                                     | ✅ Shipped     | `XCAFDoc_MaterialTool` + `XCAFDoc_Material` + `TCollection_HAsciiString` were added to `custom_build_single.yml` and `matTool.SetMaterial(...)` is called in `assemblyExporter.ts` when `density !== undefined`                                    |
| STEP visual material (Level 3 PBR / RGB color attribute)                                                        | ❌ Deferred    | Comment block in `assemblyExporter.ts`: _"`XCAFDoc_VisMaterial_` (PBR visual materials) are deliberately omitted from the replicad-opencascadejs WASM build — they depend on Graphic3d/TKService which requires TKOpenGl (unavailable in WASM)."\* |
| `XCAFDoc_VisMaterial`, `XCAFDoc_VisMaterialTool`, `XCAFDoc_VisMaterialPBR`, `XCAFDoc_VisMaterialCommon` symbols | ❌ Not in YAML | `grep -E 'VisMaterial' custom_build_single.yml` returns no symbols — the build never tried to compile them                                                                                                                                         |

So the STEP-PBR effort left **no compiled debt** — no `.o` files, no half-included symbols. The single residual `XCAFDoc_VisMaterialTool` reference in the `.d.ts` is **not** debt from that effort; it is the OCCT-internal `XCAFDoc_DocumentTool::VisMaterialTool()` static accessor that ships as part of the (legitimately bound) `XCAFDoc_DocumentTool` class header, regardless of whether its return type is bound. Same pattern applies to `XCAFDoc_NotesTool`, `XCAFDoc_LayerTool`, `XCAFDoc_DimTolTool`, `XCAFDoc_ViewTool`, `XCAFDoc_ClippingPlaneTool` — all are static accessors on `XCAFDoc_DocumentTool` whose return types we never bound (and don't need to).

## Findings

### Finding 1: Error Distribution

```text
2364  TS2304  Cannot find name '<X>'
  22  TS2693  '<X>' only refers to a type, but is being used as a value
  16  TS2300  Duplicate identifier '<X>'
   8  TS2552  Cannot find name '<X>'. Did you mean '<Y>'?
   3  TS2694  Namespace 'WebAssembly' has no exported member 'Exception'
   2  TS2339  Property '<digit>' does not exist on type 'gp_XYZ'
   1  TS2416  Property 'SetID' in type 'TDataStd_GenericExtString' is not assignable to base
─────────
2416  total
```

`TS2304` accounts for **97.85%** of diagnostics; the rest are small, distinct codegen bugs. 269 unique missing identifiers drive those 2,364 TS2304 occurrences (top offenders are referenced in many class signatures: `Standard_Type` 328×, `NCollection_BaseAllocator` 219×, `TopTools_ShapeMapHasher` 36×, `Standard_GUID` 35×, `NCollection_SeqNode` 33×, `NCollection_BaseSequence` 33×, `TCollection_AsciiString` 32×).

### Finding 2: Root Cause of TS2304 — Codegen Emits References Without Stubs

`buildFromYaml.py:_collect_dts_fragments()` walks `<build_dir>/bindings/**/*.d.ts.json` and concatenates every fragment that matches the YAML symbol list. Each fragment is generated from the OCCT C++ header for that symbol and contains TS method signatures with parameter / return types referenced by _name_ — even when those names point to OCCT base classes, helper types, or RTTI machinery that the YAML does not request. The codegen never emits `export type X = unknown;` stubs for the unresolved tail. Consequently every method that takes a `Standard_Type`, `NCollection_BaseAllocator`, `gp_Mat`, etc. produces a TS2304 in `tsc`.

This is **not** a property of the STEP-PBR work; the same pattern appears in the `opencascade_full.d.ts` build. The full build hides it by post-processing in `libs/api-extractor/src/extract-opencascade-types.ts:findUndeclaredTypes` which prepends `export type X = unknown;` for every undeclared name before publishing types to Monaco. The replicad single build has no such post-processing pass.

```typescript
// libs/api-extractor/src/extract-opencascade-types.ts L40-L74 — already-working fix
function findUndeclaredTypes(content: string): string[] {
  const declared = new Set<string>();
  for (const m of content.matchAll(
    /(?:export\s+declare\s+class|export\s+class|export\s+type|export\s+declare\s+const|export\s+const)\s+(\w+)/g,
  )) {
    /* ... */
  }
  // ... extract `: T` and `extends T` references ...
  return [...referenced].filter((name) => !declared.has(name)).sort();
}
// Used as:
const stubs = findUndeclaredTypes(content);
const stubBlock = stubs.map((t) => `export type ${t} = unknown;`).join('\n');
content = stubBlock + '\n\n' + content;
```

### Finding 3: Categorisation of the 269 Missing Names

Every unresolved identifier falls into one of 22 OCCT-package buckets. **None are STEP-PBR remnants.** The buckets sort cleanly by intent:

| #   | Bucket                                                                                                                                                                                                                                                                                                                                   | Count | Nature                                                                                                                                                                                                                         | Should we bind?                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | OCCT RTTI / collection plumbing (`Standard_Type`, `Standard_GUID`, `NCollection_BaseAllocator`, `NCollection_BaseSequence`, `NCollection_BaseMap`, `NCollection_SeqNode`, `NCollection_*` parameterised lists/maps)                                                                                                                      |    26 | Internal helpers; surfaced in static `get_type()` accessors and container constructors                                                                                                                                         | **No.** Stub as `unknown`.                                                                                                                   |
| B2  | STEP `Select` union / `Item` choice helpers (`StepAP203_*Item`, `StepAP214_*Item`, `StepShape_*Select`, `StepGeom_*Select`, `StepVisual_*Select`, `StepDimTol_*`, `StepFEA_*`, `StepElement_*`)                                                                                                                                          |    57 | OCCT STEP parser internals — never user-facing; surfaced via `Init`/`Value` accessors on the few bound STEP entity classes                                                                                                     | **No.** Stub.                                                                                                                                |
| B3  | XCAF auxiliary tools (`XCAFDoc_VisMaterialTool`, `XCAFDoc_NotesTool`, `XCAFDoc_LayerTool`, `XCAFDoc_DimTolTool`, `XCAFDoc_ViewTool`, `XCAFDoc_ClippingPlaneTool`, `XCAFDoc_PartId`, `XCAFDoc_GraphNode`, `XCAFPrs_Style`, `XCAFDimTolObjects_*`)                                                                                         |    12 | Static accessors on `XCAFDoc_DocumentTool` we don't call. `VisMaterialTool` is the only one tied to deferred STEP-PBR work; the rest are unrelated                                                                             | **No.** Stub.                                                                                                                                |
| B4  | TDF / TDocStd / CDM document model (`TDF_Data`, `TDF_*Delta`, `TDF_RelocationTable`, `TDocStd_FormatVersion`, `CDM_Application`, `CDM_MetaData`, `CDM_Reference`, `CDM_CanCloseStatus`, `PCDM_Reference`, `TDataStd_NamedData`)                                                                                                          |    16 | OCAF document persistence internals; surfaced on `TDocStd_Document` and `TDF_Attribute` heritage                                                                                                                               | **No.** Stub.                                                                                                                                |
| B5  | Transfer / IFSelect / XSControl / Interface / ShapeAnalysis / ShapeFix infrastructure (`Transfer_*`, `IFSelect_*`, `XSControl_*`, `Interface_*`, `ShapeAnalysis_*`, `ShapeFix_*`, `ShapeBuild_*`, `ShapeExtend_*`)                                                                                                                       |    36 | STEP/IGES translator framework internals; surfaced on bound writer/reader classes                                                                                                                                              | **No.** Stub.                                                                                                                                |
| B6  | BRep helper / error enums + a few unbound builders (`BRepBuilderAPI_*Error`, `BRepCheck_Status`, `BRepFeat_StatusError`, `BRepFill_*`, `BRepOffset_*`, `BRepSweep_Prism/Revol`, `BRepPrim_*`, `BRepTools_History`, `BRepTools_ReShape`, `BRepTopAdaptor_Tool`, `BRepExtrema_*`, `BRep_Builder`, `BOPAlgo_*`, `BOPDS_Pave`, `BOPTools_*`) |    29 | Mostly enums on bound API classes (e.g. `MakeEdge::Error()` returns `BRepBuilderAPI_EdgeError`). A handful (`BRep_Builder`, `BRepTools_ReShape`, `BRepBuilderAPI_*`) could be legitimately useful but are not used today.      | **Mostly stub**; bind a few enums (`BRepBuilderAPI_*Error`, `BRepCheck_Status`) if a downstream consumer needs them — none today.            |
| B7  | HLR (Hidden Line Removal) (`HLRAlgo_*`, `HLRBRep_Data`, `HLRBRep_ShapeBounds`, `HLRBRep_TypeOfResultingEdge`, `HLRTopoBRep_OutLiner`)                                                                                                                                                                                                    |     8 | Replicad uses HLR via the bound `HLRAlgo_Projector` + `HLRBRep_Algo` + `HLRBRep_HLRToShape` for face-outline drawing. The unbound types are internal data structures the public API never returns.                             | **No.** Stub.                                                                                                                                |
| B8  | `gp_` geometric primitives (`gp_Lin`, `gp_Lin2d`, `gp_Pln`, `gp_Cone`, `gp_Hypr`, `gp_Hypr2d`, `gp_Mat`, `gp_Mat2d`, `gp_Parab`, `gp_Parab2d`, `gp_Quaternion`, `gp_Torus`, `gp_TrsfForm`)                                                                                                                                               |    13 | Geometric primitives surfaced in `gp_Trsf` / `Geom_*` method signatures (e.g. `gp_Trsf::HVectorialPart()` returns `gp_Mat`). Trivial to bind — they are ~100-line value classes                                                | **Selectively bind** the trivially useful ones (`gp_Lin`, `gp_Pln`, `gp_Mat`, `gp_Quaternion`, `gp_TrsfForm`); stub the rest.                |
| B9  | Intersection helpers (`Extrema_*`, `IntPatch_*`, `IntRes2d_*`, `IntSurf_*`, `IntTools_*`)                                                                                                                                                                                                                                                |    17 | Returned by intersection / extrema algorithms; replicad uses `BRepExtrema_DistShapeShape` (bound) and exposes no lower-level intersection API                                                                                  | **No.** Stub.                                                                                                                                |
| B10 | TCollection / TopTools (`TCollection_AsciiString`, `TCollection_HExtendedString`, `TopTools_ShapeMapHasher`, `TopTools_FormatVersion`)                                                                                                                                                                                                   |     4 | `TCollection_AsciiString` is a string class; could be bound to JS string transparently. `TopTools_ShapeMapHasher` is a hasher template arg that should never appear in JS                                                      | **Bind** `TCollection_AsciiString` (it is the C++ ASCII string analogue to the already-bound `TCollection_HAsciiString`); **stub** the rest. |
| B11 | TDF / Topology helpers (`TopLoc_Datum3D`, `TopoDS_TShape`, `TopOpeBRepBuild_HBuilder`)                                                                                                                                                                                                                                                   |     3 | Topology internals never returned to user code                                                                                                                                                                                 | **No.** Stub.                                                                                                                                |
| B12 | Mesh / Poly internals (`IMeshTools_Context`, `IMeshTools_Parameters`, `Poly_ArrayOfNodes`, `Poly_ArrayOfUVNodes`, `Poly_MeshPurpose`, `Poly_Polygon2D`, `Poly_Polygon3D`, `Poly_TriangulationParameters`)                                                                                                                                |     8 | Used by the bound `BRepMesh_IncrementalMesh`. Replicad reads triangulation via the custom `ReplicadMeshExtractor`; these accessors are never called from JS                                                                    | **No.** Stub.                                                                                                                                |
| B13 | Geom helpers (`Geom_BezierSurface`, `Geom_OffsetCurve`, `Geom_Plane`, `GeomAdaptor_Curve`, `GeomAdaptor_Surface`, `GeomAbs_BSplKnotDistribution`, `GeomAbs_IsoType`, `GeomTools_UndefinedTypeHandler`, `Geom2dInt_GInter`, `GProp_PrincipalProps`)                                                                                       |    10 | Mix of useful surface types (`Geom_Plane`, `GeomAdaptor_Curve`) and obscure helpers                                                                                                                                            | **Selectively bind** `Geom_Plane`, `GeomAdaptor_Curve`, `GeomAdaptor_Surface`; stub the rest.                                                |
| B14 | RW (read/write) frameworks + DE / OSD (`RWGltf_GltfPrimArrayData`, `RWMesh_NodeAttributes`, `DESTEP_Parameters`, `DE_ShapeFixParameters`, `OSD_FileSystem`, `UnitsMethods_LengthUnit`)                                                                                                                                                   |     6 | Internal data carriers for converters; replicad uses its own GLTF writer                                                                                                                                                       | **No.** Stub.                                                                                                                                |
| B15 | Misc plate / law / monitor / message / Bnd / ChFiDS / BSplCLib / Adaptor3d helpers                                                                                                                                                                                                                                                       |    15 | Internal scaffolding; never user-facing                                                                                                                                                                                        | **No.** Stub.                                                                                                                                |
| B16 | Quantity enums (`Quantity_NameOfColor`, `Quantity_TypeOfColor`)                                                                                                                                                                                                                                                                          |     2 | Standard OCCT colour enums; surfaced on the bound `Quantity_Color` (e.g. `Quantity_Color(theName: Quantity_NameOfColor)`). The compiled object files exist in `cache/.../bindings/FoundationClasses/TKernel/Quantity/` already | **Bind.** Tiny win, large cleanup of constructor signatures.                                                                                 |
| B17 | C/C++ primitives (`size_t`, `uint8_t`)                                                                                                                                                                                                                                                                                                   |     2 | Codegen bug — leaking C primitive names into TS instead of mapping to `number`                                                                                                                                                 | **Fix codegen** to map `size_t` and `uint8_t` to `number` directly.                                                                          |
| B18 | `gce_ErrorType`                                                                                                                                                                                                                                                                                                                          |     1 | Status enum returned by `GCE2d_*` / `GC_*` makers                                                                                                                                                                              | **Bind** (one-line YAML add) or stub.                                                                                                        |
| B19 | STEPCAFControl*ExternFile + the `NCollection_DataMap*\*ExternFile` template                                                                                                                                                                                                                                                              |     2 | Used by the bound `STEPCAFControl_Writer` `ExternFile()` accessor                                                                                                                                                              | **No.** Stub (we don't use external-file mode).                                                                                              |

Total: 269. **Zero** are STEP-PBR debt. The closest analogues are `XCAFDoc_VisMaterialTool` and `XCAFPrs_Style` in B3, both reachable from the bound `XCAFDoc_DocumentTool` static accessors, neither contributing any compiled-but-unused symbols and both safely stubbable as `unknown`.

### Finding 4: TS2300 — Duplicate Identifier Codegen Bug

```text
40242  Duplicate identifier 'RepCurveDesc_Base'        ×6
40268  Duplicate identifier 'RepSurfaceDesc_Base'      ×2
41272  Duplicate identifier 'GeomEval_RepSurfaceDesc_Base'  ×4
41284  Duplicate identifier 'GeomEval_RepCurveDesc_Base'    ×4
41298  Duplicate identifier 'Geom2dEval_RepCurveDesc_Base'  ×3
```

These all live in the namespace block emitted at the bottom of the `.d.ts` (`buildFromYaml.py` lines 464–486 — "Generate namespace blocks for OCCT package organization"). The namespace generator splits each `<prefix>_<rest>` symbol into a `<rest>` alias inside `namespace <prefix>`. When the same `<rest>` exists at multiple arities (`Foo_Base`, `Foo_Base` from a `_N` overload subclass that auto-discovery did not strip), both end up as `export type Base = ...;` in the same namespace and collide. Independent of any STEP-PBR work; pre-existing bug to fix in the namespace generator (de-dup by `(prefix, short_name)` pair).

### Finding 5: TS2693 — `value_object` Types Used as Constructors

```text
40855  'Bnd_Box2d_Limits'              only refers to a type, but is being used as a value
40857  'Bnd_Box_Limits'                only refers to a type, but is being used as a value
41272  'GeomEval_RepSurfaceDesc_Base'  only refers to a type, but is being used as a value
41284  'GeomEval_RepCurveDesc_Base'    only refers to a type, but is being used as a value
41289  'Geom_Surface_ResD1'            only refers to a type, but is being used as a value
41290  'Geom_Surface_ResD2'            only refers to a type, but is being used as a value
41291  'Geom_Surface_ResD3'            only refers to a type, but is being used as a value
```

These are the `emscripten::value_object` return-by-value records introduced during the OCCT V8 migration to replace `Handle<T>&` output params with returned JS objects. The codegen emits them as `export type X = { ... };` (correct) but the namespace alias generator (same code as Finding 4) emits `export type Base = typeof RepCurveDesc_Base;` — `typeof` requires a value, but the symbol is a type. Fix: detect `value_object` exports in the namespace generator and emit `export type Base = RepCurveDesc_Base;` (no `typeof`) instead.

### Finding 6: TS2694 — `WebAssembly.Exception` Lib Gap

```text
40781  Namespace 'WebAssembly' has no exported member 'Exception'
40789  Namespace 'WebAssembly' has no exported member 'Exception'
40795  Namespace 'WebAssembly' has no exported member 'Exception'
```

`buildFromYaml.py:489–518` emits `getExceptionMessage(ex: WebAssembly.Exception)` etc. when `-fwasm-exceptions` is enabled. `WebAssembly.Exception` is part of the JS exception-handling proposal and lands in TypeScript's `lib.dom.d.ts` only at TS 5.6+ with `--lib dom,es2024` (the workspace uses `es2022`). Workaround: emit a local declaration block in the same prologue:

```typescript
declare global {
  namespace WebAssembly {
    interface Exception {
      /* ... */
    }
  }
}
```

### Finding 7: TS2339 — `gp_XYZ.3 / .4` Accessor Typo

```text
5104:36  Property '3' does not exist on type 'gp_XYZ'
5109:32  Property '4' does not exist on type 'gp_XYZ'
```

These are stray references that landed when the codegen flattened `Coord(theIndex)` accessor numerics into property accesses. The `.3`/`.4` look like a templated indexer leak. Trivial to fix at the codegen level once observed.

### Finding 8: TS2416 — `TDataStd_GenericExtString.SetID` Override Mismatch

```text
5801:3  Property 'SetID' in type 'TDataStd_GenericExtString' is not assignable to the same property in base type 'TDF_Attribute'.
```

`TDataStd_GenericExtString` exposes `SetID(theGUID)` and `SetID(theGUID, theLockMode)` overloads while the base `TDF_Attribute::SetID(theGUID)` is single-arity. Because the overloads write to `Standard_GUID` (in B1), this resolves automatically once stubs land — but the variance error itself is a codegen issue with overload-merge across heritage. Low priority; fix only if the stub pass does not silence it.

### Finding 9: TS2552 — Quantity Enum Hint

The eight TS2552 hints (`Did you mean 'Quantity_Color'?`, `Did you mean 'NCollection_BaseList'?`) all reduce to "the enum / base class wasn't included in the YAML". Adding `Quantity_NameOfColor` and `Quantity_TypeOfColor` to `mainBuild.bindings` (`.cpp.o` already in cache, so no recompile cost) eliminates these and fixes the `Quantity_Color` constructor signatures — purely a YAML edit.

### Finding 10: Production Impact = Zero

| Surface                                                       | Impact                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm nx typecheck runtime` (and any consumer)                | None — `tsconfig.base.json` sets `skipLibCheck: true`                                                                                                                                       |
| Tau direct imports from `replicad-opencascadejs`              | None — only `OpenCascadeInstance` (and `Quantity_ColorRGBA`, `TCollection_ExtendedString`, `TCollection_HAsciiString`, `TDocStd_Document` in `assemblyExporter.ts`) are imported, all bound |
| `pnpm nx test runtime`                                        | None — runtime tests pass                                                                                                                                                                   |
| Monaco IntelliSense for opencascade.js                        | Already handled — the `findUndeclaredTypes` post-processor stubs unknowns before publishing types                                                                                           |
| Editor squiggles when opening `replicad_single.d.ts` directly | Visible — the only concrete user-facing symptom                                                                                                                                             |

### Finding 11: Two Copies of `replicad_single.d.ts`

| Path                                             | Tracked?   | Mtime                  | Status                                                                            |
| ------------------------------------------------ | ---------- | ---------------------- | --------------------------------------------------------------------------------- |
| `repos/opencascade.js/dist/replicad_single.d.ts` | Gitignored | Apr 17 (today's build) | **Live build artifact**                                                           |
| `repos/opencascade.js/replicad_single.d.ts`      | Untracked  | Apr 15                 | **Orphan** from a pre-`dist/` build run; not produced by the current build script |

Both have identical errors today, but the root copy is a stale leftover that should be removed to avoid confusion.

### Finding 12: Architectural Layer Attribution — These Are Not Emscripten Misconfiguration

The OCJS pipeline has four layers, only one of which is Emscripten itself: (a) **Emscripten compile/link flags** (`-lembind`, `-fwasm-exceptions`, `WASM_BIGINT`, etc., set in `repos/opencascade.js/src/buildFromYaml.py:278-288`); (b) **custom Python codegen** (`bindings.py` `TypescriptBindings`, `generateBindings.py` `typescriptGenerationFunc*`, `buildFromYaml.py` namespace generator); (c) **YAML symbol list** (`custom_build_single.yml`); (d) **inherent OCCT C++ API surface** (templates, RTTI, helper types). Mapping each error class to its owning layer:

| Error class                                             | Owning layer                                                                                                                                                                                                                                                                                    | Resolvable by Emscripten config alone?           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TS2304 (×2364) — unresolved type names                  | (b) Python codegen — `bindings.py:TypescriptBindings.resolve_type` lines 2747-2755 return raw type spelling for any identifier without `(`/`:`/`<`, with no membership check against `_known_export_names`; `_collect_dts_fragments` then drops the would-be-defining fragments per YAML filter | **No**                                           |
| TS2300 (×16) — duplicate `_N` overload aliases          | (b) Python codegen — namespace block emitter at `buildFromYaml.py:464-486` lacks `(prefix, short_name)` dedup                                                                                                                                                                                   | **No**                                           |
| TS2693 (×22) — `value_object` `typeof` misuse           | (b) Python codegen — same namespace emitter does not detect `value_object` exports                                                                                                                                                                                                              | **No**                                           |
| TS2694 (×3) — `WebAssembly.Exception` lib gap           | (a) Emscripten flag (`-fwasm-exceptions`) **OR** (b) Python codegen (emit local ambient stub) — both viable                                                                                                                                                                                     | **Partially** (only by giving up native WASM EH) |
| TS2339 (×2) — `gp_XYZ.[3\|4]` typo                      | (b) Python codegen — libclang `Coord(theIndex)` accessor leak                                                                                                                                                                                                                                   | **No**                                           |
| TS2416 (×1) — `SetID` override variance                 | (b) Python codegen — overload-merge across heritage                                                                                                                                                                                                                                             | **No**                                           |
| TS2552 (×8) — Quantity enum / NCollection hint          | (c) YAML symbol list — `Quantity_NameOfColor`, `Quantity_TypeOfColor`, `TCollection_AsciiString` not declared as bindings                                                                                                                                                                       | **No**                                           |
| `size_t` / `uint8_t` leak (R7)                          | (b) Python codegen — `_NUMERIC_TYPES` in `bindings.py:2284-2322` includes `size_t` but not `uint8_t`; falls through `convertBuiltinTypes` and is then emitted as a literal identifier by the same 2747-2755 branch                                                                              | **No**                                           |
| Orphan `repos/opencascade.js/replicad_single.d.ts` (R9) | git/repo hygiene                                                                                                                                                                                                                                                                                | **No**                                           |
| Missing TS2304 regression test (R10)                    | test hygiene                                                                                                                                                                                                                                                                                    | **No**                                           |
| `XCAFDoc_VisMaterial*` deferral (R11)                   | (d) inherent OCCT API surface — drags in `TKService`/`TKOpenGl`                                                                                                                                                                                                                                 | **No**                                           |

Every TS2304 originates in the **same six lines** of `bindings.py` (`TypescriptBindings.resolve_type:2747-2755`):

```python
spelling = self._strip_type_qualifiers_str(t.spelling)
resolved = self.resolveWithCanonicalFallback(spelling, t, templateDecl, templateArgs)
resolved = self._strip_type_qualifiers_str(resolved)
resolved = self.convertBuiltinTypes(resolved)
if resolved in ("number", "string", "boolean", "void"):
  return resolved
if resolved and resolved != "" and "(" not in resolved and ":" not in resolved and "<" not in resolved:
  return resolved   # <-- raw identifier returned with no `_known_export_names` check
```

Emscripten compiles and links the C++ correctly; the issue is downstream of compilation entirely. No Emscripten flag, no `emcc.py` config, no patch to `libembind.js` would change this — the Python TS emitter never asks Emscripten what it actually registered.

### Finding 13: Header-Walk vs Embind-Introspection Codegen — Why TS2304 Is Possible by Construction

OCJS chose to generate TypeScript by walking OCCT C++ headers via `clang.cindex` (`repos/opencascade.js/src/TuInfo.py:7-17`, `bindings.py:TypescriptBindings.processClass`). Emscripten 4.x ships a different, intrinsically self-consistent path (`--emit-tsd`) that introspects actually-registered Embind types at link time.

```text
Header-walk codegen (OCJS today):           Embind-introspection codegen (--emit-tsd):

  OCCT headers                                  Linked JS+WASM module
        |                                              |
   clang.cindex AST                              EMBIND_GEN_MODE=1, run under Node
        |                                              |
   TypescriptBindings emits per                  libembind_gen.js inspects
   class, by C++ type spelling                   _embind_register_* call sequence
        |                                              |
   .d.ts.json fragments per symbol               One .d.ts; throws on
        |                                        any unresolved reference
   buildFromYaml filters by YAML                       |
        |                                        Only-registered types,
   Concatenated .d.ts                            self-consistent by construction
   (no consistency check between
    referenced names and emitted
    symbols — TS2304 is possible)
```

Header-walk codegen has **no self-consistency check**: the AST visitor for class `A` can emit a method signature referencing class `B` regardless of whether `B` was discovered, bound, or even known to exist. Embind-introspection codegen has a hard fail on unresolved deps: `libembind_gen.js:914-926` throws _"Missing binding for type"_ if any referenced type id is still in `awaitingDependencies` when emission completes. By construction, an `--emit-tsd` output cannot contain a TS2304-causing reference.

The OCJS architectural choice (header-walk) is what makes the existing fix pattern (R1: prepend `export type X = unknown;` stubs) the practical least-invasive remedy — it patches the consistency gap at the same layer that creates it. Recommendation R12 below sketches the alternative path (hybrid `--emit-tsd` adoption) for the long term.

## Architectural Alternative: `emcc --emit-tsd`

Emscripten 4.x can emit TypeScript declarations directly from Embind registrations as part of the link phase. OCJS does not currently use this path; the entire `replicad_single.d.ts` is produced by the custom Python codegen.

### What it is

| Concern             | Location                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI flag            | `--emit-tsd <path>` (deprecated alias `--embind-emit-tsd`) — parsed in `repos/emscripten/tools/cmdline.py:458-459`                                                                      |
| Link wiring         | `repos/emscripten/tools/link.py:phase_emit_tsd` (~lines 2023-2031) calls `run_embind_gen` (~1936-2020), then `emscripten.create_tsd` merges the embind output with `WasmModule` exports |
| TS emitter          | `repos/emscripten/src/lib/libembind_gen.js` — runs the linked module under Node with `EMBIND_GEN_MODE=1` and walks the same `_embind_register_*` hooks the runtime uses                 |
| Hard-fail invariant | `$emitOutput` throws _"Missing binding for type"_ if any type id is still in `awaitingDependencies` (`libembind_gen.js:914-926`)                                                        |
| Documentation       | `repos/emscripten/site/source/docs/porting/connecting_cpp_and_javascript/embind.rst` (~lines 1280-1339)                                                                                 |

### What it covers

| Embind feature                                  | TS emission                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `class_`                                        | `export interface Foo extends ClassHandle { … }` + `EmbindModule` constructor/method entries |
| `enum_`                                         | `EnumDefinition` (number, string, object styles)                                             |
| `function`                                      | `FunctionDefinition`                                                                         |
| `value_object`                                  | `export type Name = { … }`                                                                   |
| `value_array`                                   | tuple-like `export type Name = [ … ]`                                                        |
| `register_vector` / `register_map`              | Class interfaces (`IntVec`, `MapIntInt`)                                                     |
| Smart pointers (`_embind_register_smart_ptr`)   | `pointee \| null` (e.g. `ClassWithSmartPtrConstructor \| null`)                              |
| `EMSCRIPTEN_DECLARE_VAL_TYPE` + `register_type` | `UserTypeDefinition` → `export type Alias = …`                                               |

### What it would cost OCJS

| Capability OCJS exposes today                              | `--emit-tsd` gap                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Per-package namespaces (`gp.Pnt`, `TopoDS.Edge`)           | Python-owned (`buildFromYaml.py:464-486`); would need a post-process layer on top of `--emit-tsd`                      |
| `export declare class` shape                               | `--emit-tsd` emits `export interface … extends ClassHandle` + `EmbindModule` constructors — different public API shape |
| `Handle<T>` smart-pointer wrappers                         | Embind emits `pointee \| null`, not OCCT-style smart pointer types                                                     |
| JSDoc piped from `extract-docs.py`                         | `--emit-tsd` has no documentation source — would need a separate doc-merge step                                        |
| `_N` overload subclasses + `OpenCascadeInstance` aggregate | OCJS-specific conventions; not produced by `--emit-tsd`                                                                |
| `register_memory_view` typed arrays                        | Marked `// TODO` in `libembind_gen.js:622-625`; replicad mesh extraction depends on memory views                       |
| `emscripten::val` parameter typing                         | Defaults to `any` unless explicitly typed via `EMSCRIPTEN_DECLARE_VAL_TYPE`                                            |

### Verdict

`--emit-tsd` is the **only Emscripten-layer feature** that could eliminate TS2304 at the source. It is **not a drop-in replacement** for the custom Python codegen — adopting it would break the public `.d.ts` API shape and lose namespaces, JSDoc, `_N` overload subclasses, `Handle<T>` semantics, and (until upstream `register_memory_view` ships) typed-array views. A hybrid migration is feasible but high effort; see R12.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Priority | Effort                                                  | Impact                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Lift `findUndeclaredTypes` + `export type X = unknown;` stub-prepend pass from `libs/api-extractor/src/extract-opencascade-types.ts` upstream into `buildFromYaml.py:_collect_dts_fragments` (or the post-concat block around line 432) so every build artifact (`opencascade_full.d.ts` + `replicad_single.d.ts`) emits stub block                                                                                                                                                                                                         | **P0**   | Low (~30 lines of Python; pattern already proven in TS) | High — eliminates ~2,364 of 2,416 errors at the source                                                                                                             |
| R2  | Bind `Quantity_NameOfColor` and `Quantity_TypeOfColor` in `custom_build_single.yml` (one-line YAML add each; `.cpp.o` already in cache so no recompile cost)                                                                                                                                                                                                                                                                                                                                                                                | **P1**   | Trivial                                                 | Removes 7 TS2552 hints + improves `Quantity_Color` constructor signatures                                                                                          |
| R3  | Bind `TCollection_AsciiString` (sibling of already-bound `TCollection_HAsciiString`) in `custom_build_single.yml`                                                                                                                                                                                                                                                                                                                                                                                                                           | **P1**   | Trivial                                                 | Removes 32 TS2304 + makes container types usable                                                                                                                   |
| R4  | Fix the namespace-block generator in `buildFromYaml.py:464-486` to (a) de-dup `(prefix, short_name)` pairs (TS2300) and (b) detect `value_object` exports and emit `export type Short = Full;` instead of `export type Short = typeof Full;` for them (TS2693)                                                                                                                                                                                                                                                                              | **P1**   | Low                                                     | Eliminates 16 TS2300 + 22 TS2693                                                                                                                                   |
| R5  | Add a local `declare global { namespace WebAssembly { interface Exception { … } } }` block in the `uses_native_wasm_eh` branch of `buildFromYaml.py` so `WebAssembly.Exception` resolves on `--lib es2022`                                                                                                                                                                                                                                                                                                                                  | **P2**   | Low                                                     | Removes 3 TS2694                                                                                                                                                   |
| R6  | Audit codegen for the `gp_XYZ.[3\|4]` typo (TS2339) and the `TDataStd_GenericExtString.SetID` override (TS2416); fix at source if the stub pass doesn't silence them                                                                                                                                                                                                                                                                                                                                                                        | **P2**   | Low                                                     | Removes 3 small errors                                                                                                                                             |
| R7  | Fix codegen to map C primitives `size_t` and `uint8_t` directly to `number` instead of leaking the C type names                                                                                                                                                                                                                                                                                                                                                                                                                             | **P2**   | Trivial                                                 | Cleaner signatures, removes 22 TS2304                                                                                                                              |
| R8  | Selectively add `gp_Lin`, `gp_Pln`, `gp_Mat`, `gp_Quaternion`, `gp_TrsfForm` to the YAML if any consumer needs them (none today; defer until a use case appears)                                                                                                                                                                                                                                                                                                                                                                            | **P3**   | Trivial                                                 | Optional polish                                                                                                                                                    |
| R9  | Delete the orphan `repos/opencascade.js/replicad_single.d.ts` (untracked; stale; not regenerated by current build) and add a `.gitignore` entry preventing future re-creation                                                                                                                                                                                                                                                                                                                                                               | **P2**   | Trivial                                                 | Removes the file the user actually opened in the IDE; eliminates squiggles for the source of confusion                                                             |
| R10 | Add a regression test in `repos/opencascade.js/tests/dts-validation.test.ts` that runs the TypeScript program-level diagnostic check (not just syntactic) against `replicad_single.d.ts` and asserts zero `TS2304` errors after R1 lands                                                                                                                                                                                                                                                                                                    | **P2**   | Low                                                     | Prevents regression; complements existing `any`-count regression test                                                                                              |
| R11 | Do **not** bind any `XCAFDoc_VisMaterial*` / `Graphic3d_PBRMaterial` / `TKVCAF` symbols. STEP visual-material PBR remains deferred and requires a separate research pass into headless-`TKService` viability before any binding effort is considered                                                                                                                                                                                                                                                                                        | **N/A**  | —                                                       | Confirms the existing decision; codifies that none of the 269 missing names justifies pulling in TKService                                                         |
| R12 | Evaluate hybrid adoption of `emcc --emit-tsd`: add it to the link step in `runBuild` (alongside `-lembind`), diff its output against the Python-generated `.d.ts`, and progressively migrate symbols where the Embind output shape is acceptable. **Long-term insurance against codegen drift; not a near-term replacement for R1.** Blockers: rework `OpenCascadeInstance` aggregate, per-package namespaces, `Handle<T>` story, JSDoc piping; upstream contribution likely needed for `register_memory_view` (`libembind_gen.js:622-625`) | **P3**   | High                                                    | Removes TS2304 by construction for migrated symbols; aligns OCJS with upstream Emscripten direction; eliminates the entire class of header-walk/registration drift |

R1 alone eliminates ~98% of the diagnostics. R2–R7 close out the remaining specific bugs. R8–R11 are housekeeping. R12 is a long-horizon architectural option that addresses the root cause identified in Finding 13 rather than patching its symptoms.

## Trade-offs

| Option                                                                           | Pros                                                                                                                                                               | Cons                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **R1: Stub all undeclared as `unknown`** in `buildFromYaml.py`                   | Single fix removes 97.85% of errors; pattern is already battle-tested in `extract-opencascade-types.ts`; preserves intent — these types are genuinely opaque to JS | Stubbed as `unknown` means consumers cannot meaningfully introspect signatures using them. For OCCT-internal types this is correct (you can't construct a `Standard_Type`); for borderline cases (`gp_Lin`, `Quantity_NameOfColor`) we lose discoverability. R2/R3/R8 selectively bind the borderline cases to mitigate. |
| **Alternative: Bind every missing symbol**                                       | Full type coverage; richer IntelliSense                                                                                                                            | ~269 more bindings → significantly larger WASM (each `.o` adds compiled bytes); some symbols transitively pull in `TKService` (the very thing we deferred); contradicts the "CAD-oriented, not graphics-oriented" replicad philosophy                                                                                    |
| **Alternative: Suppress with `// @ts-nocheck`** in `replicad_single.d.ts` header | Trivial; one line                                                                                                                                                  | Hides legitimate codegen bugs (Findings 4–8); breaks any future user who turns `skipLibCheck` off; not a fix, just a mute                                                                                                                                                                                                |
| **Alternative: Do nothing**                                                      | Zero effort; production unaffected (Finding 10)                                                                                                                    | The user opening the file still sees 2,416 squiggles; codegen bugs (Findings 4–8) accumulate and will eventually bite a downstream consumer that ships its own `OpenCascadeInstance` type augmentations                                                                                                                  |

Recommended: **R1 + R2 + R3 + R4 + R5** as the minimal viable cleanup; R6–R11 as follow-up.

## Code Examples

### Reproducing the diagnostics

```bash
npx tsc --noEmit --target es2022 --moduleResolution node --strict false \
  repos/opencascade.js/dist/replicad_single.d.ts > /tmp/tsc.log 2>&1
# Error code distribution:
grep '^repos/opencascade' /tmp/tsc.log | grep -oE 'TS[0-9]+' | sort | uniq -c | sort -rn
# Top missing names:
grep -oE "Cannot find name '[A-Za-z_0-9]+'" /tmp/tsc.log \
  | sort | uniq -c | sort -rn | head -20
```

### R1 sketch — Python port of `findUndeclaredTypes`

```python
def find_undeclared_types(content: str) -> list[str]:
    """Mirror libs/api-extractor extract-opencascade-types.ts findUndeclaredTypes."""
    import re
    declared = set()
    for m in re.finditer(
        r'(?:export\s+declare\s+(?:class|const)|export\s+(?:class|type|const))\s+(\w+)',
        content,
    ):
        declared.add(m.group(1))
    referenced = set()
    for line in content.split('\n'):
        s = line.lstrip()
        if s.startswith('*') or s.startswith('//'):
            continue
        for m in re.finditer(r':\s*(\w+(?:_\w+)+)\b', line):
            name = m.group(1)
            if name[0].isupper():
                referenced.add(name)
        for m in re.finditer(r'extends\s+(\w+(?:_\w+)+)\b', line):
            name = m.group(1)
            if name[0].isupper():
                referenced.add(name)
    return sorted(referenced - declared)

# In _collect_dts_fragments / main(), after concatenating typescriptDefinitionOutput:
stubs = find_undeclared_types(typescriptDefinitionOutput)
if stubs:
    stub_block = '\n'.join(f'export type {t} = unknown;' for t in stubs)
    typescriptDefinitionOutput = stub_block + '\n\n' + typescriptDefinitionOutput
```

### R4 sketch — namespace dedup + `value_object` handling

```python
# buildFromYaml.py L464-L486 — replace existing namespace generation:
from collections import defaultdict
namespaces: dict[str, dict[str, dict]] = defaultdict(dict)  # prefix -> short_name -> export
value_object_names = {n for n in typescriptExports if _is_value_object(n)}  # detect from fragments

for ex in typescriptExports:
    name = ex["export"]
    idx = name.find("_")
    if idx <= 0:
        continue
    prefix, short_name = name[:idx], name[idx + 1:]
    if not short_name or short_name[0].isdigit():
        continue
    # Dedup by (prefix, short_name); first wins (R4a)
    namespaces[prefix].setdefault(short_name, ex)

for ns_name in sorted(namespaces):
    typescriptDefinitionOutput += f"export namespace {ns_name} {{\n"
    for short_name, ex in sorted(namespaces[ns_name].items()):
        full_name = ex["export"]
        if ex["kind"] == "function":
            typescriptDefinitionOutput += f"  export type {short_name} = typeof {full_name};\n"
        elif full_name in value_object_names:  # R4b — value_object types are types, not values
            typescriptDefinitionOutput += f"  export type {short_name} = {full_name};\n"
        else:
            typescriptDefinitionOutput += f"  export type {short_name} = {full_name};\n"
    typescriptDefinitionOutput += "}\n\n"
```

### R2 + R3 — YAML additions

```yaml
# repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml
mainBuild:
  bindings:
    # ... existing entries ...
    - symbol: Quantity_NameOfColor # R2
    - symbol: Quantity_TypeOfColor # R2
    - symbol: TCollection_AsciiString # R3
```

## References

- Build config: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml`
- Codegen entry point: `repos/opencascade.js/src/buildFromYaml.py`
- libclang AST walker: `repos/opencascade.js/src/TuInfo.py:7-17` (`parse()`)
- TS fragment writer: `repos/opencascade.js/src/generateBindings.py:typescriptGenerationFuncClasses` (lines 197–230) — concrete `.d.ts.json` schema
- TS resolver root cause: `repos/opencascade.js/src/bindings.py:TypescriptBindings.resolve_type` (lines 2747–2755) — raw-identifier early return
- Namespace generator: `repos/opencascade.js/src/buildFromYaml.py:464-486`
- Emscripten `--emit-tsd` link wiring: `repos/emscripten/tools/link.py:phase_emit_tsd` (~lines 2023–2031)
- Emscripten Embind TS emitter: `repos/emscripten/src/lib/libembind_gen.js` (TS printer; `$emitOutput` hard-fail at lines 914–926; `register_memory_view` TODO at lines 622–625)
- Emscripten `--emit-tsd` CLI parsing: `repos/emscripten/tools/cmdline.py:458-459`
- Emscripten Embind TS docs: `repos/emscripten/site/source/docs/porting/connecting_cpp_and_javascript/embind.rst` (~lines 1280–1339)
- Existing fix pattern (full build): `libs/api-extractor/src/extract-opencascade-types.ts`
- Existing regression test: `repos/opencascade.js/tests/dts-validation.test.ts`
- Deferred-PBR rationale (in code): `repos/replicad/packages/replicad/src/export/assemblyExporter.ts:6-9`
- Related: `docs/research/wasm-heap-view-detachment.md`
- Related: `docs/research/occt-v8-rc5-migration.md`
- Related: `docs/research/ocjs-any-type-analysis.md`

## Appendix: Full Bucket Inventory

The complete bucket-to-symbol mapping (269 names total) is reproducible from `tsc` output:

```bash
npx tsc --noEmit --target es2022 --moduleResolution node --strict false \
  repos/opencascade.js/dist/replicad_single.d.ts 2>&1 \
  | grep -oE "Cannot find name '[A-Za-z_0-9]+'" \
  | sort -u
```

| Bucket                                                             |   Count | Representative members                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OCCT RTTI / NCollection plumbing (B1)                              |      26 | `Standard_Type` (328×), `Standard_GUID` (35×), `NCollection_BaseAllocator` (219×), `NCollection_BaseSequence` (33×), `NCollection_BaseMap`, `NCollection_SeqNode` (33×), `NCollection_HSequence_handle_Standard_Transient` (18×), `NCollection_DataMap_TopoDS_Shape_*`, `NCollection_Vector_handle_Standard_Transient`, `NCollection_ForwardRangeSentinel`, `NCollection_Map_TDF_Label`, …                                                                                     |
| STEP `Select` / `Item` helpers (B2)                                |      57 | `StepAP203_*Item` (10), `StepAP214_*Item` (18), `StepShape_*Select` / `Shell` / `ValueQualifier` (4), `StepGeom_*Select` (3), `StepVisual_*Select` / `*Element` (15), `StepDimTol_*Modifier` / `*Target` (4), `StepFEA_DegreeOfFreedom`, `StepElement_MeasureOrUnspecifiedValue`, `StepData_StepModel`                                                                                                                                                                         |
| XCAF auxiliary (B3)                                                |      12 | `XCAFDoc_VisMaterialTool`, `XCAFDoc_NotesTool`, `XCAFDoc_LayerTool`, `XCAFDoc_DimTolTool`, `XCAFDoc_ViewTool`, `XCAFDoc_ClippingPlaneTool`, `XCAFDoc_PartId`, `XCAFDoc_GraphNode`, `XCAFPrs_Style`, `XCAFDimTolObjects_DatumSingleModif`, `XCAFDimTolObjects_DimensionModif`, `XCAFDimTolObjects_GeomToleranceModif`                                                                                                                                                           |
| TDF / TDocStd / CDM (B4)                                           |      16 | `TDF_Data`, `TDF_AttributeDelta`, `TDF_DataSet`, `TDF_RelocationTable`, `TDF_DeltaOnAddition/Forget/Modification/Removal/Resume`, `TDocStd_FormatVersion`, `CDM_Application/MetaData/Reference/CanCloseStatus`, `PCDM_Reference`, `TDataStd_NamedData`                                                                                                                                                                                                                         |
| Transfer / IFSelect / XSControl / Interface / Shape\* (B5)         |      36 | `IFSelect_Selection` (27×), `IFSelect_Dispatch/Modifier/SignCounter/Signature/…`, `Interface_Graph/HGraph/InterfaceModel/Protocol/ParamType`, `Transfer_FinderProcess/TransientProcess`, `XSControl_Controller/TransferReader/TransferWriter/Vars/WorkSessionMap`, `ShapeAnalysis_Surface/Wire/WireOrder`, `ShapeFix_Edge/Shell/WireSegment`, `ShapeBuild_ReShape`, `ShapeExtend_Status/WireData/BasicMsgRegistrator`                                                          |
| BRep helpers + BOP (B6)                                            |      29 | `BRepBuilderAPI_EdgeError/FaceError/PipeError/ShellError`, `BRepCheck_Status` (15×), `BRepFeat_StatusError`, `BRepFill_ThruSectionErrorStatus`, `BRepOffset_*`, `BRepSweep_Prism/Revol`, `BRepPrim_Cylinder/Sphere/Wedge`, `BRepTools_History/ReShape`, `BRepTopAdaptor_Tool`, `BRepExtrema_SolutionElem/SupportType`, `BRep_Builder`, `BOPAlgo_PaveFiller` (15×), `BOPAlgo_PBuilder/PPaveFiller/CheckResult/Operation`, `BOPDS_Pave`, `BOPTools_ConnexityBlock/CoupleOfShape` |
| HLR (B7)                                                           |       8 | `HLRAlgo_BiPoint/Interference/PolyHidingData/TriangleData`, `HLRBRep_Data/ShapeBounds/TypeOfResultingEdge`, `HLRTopoBRep_OutLiner`                                                                                                                                                                                                                                                                                                                                             |
| `gp_` primitives (B8)                                              |      13 | `gp_Lin` (19×), `gp_Lin2d`, `gp_Pln` (12×), `gp_Cone`, `gp_Hypr/Hypr2d`, `gp_Mat/Mat2d`, `gp_Parab/Parab2d`, `gp_Quaternion`, `gp_Torus`, `gp_TrsfForm`                                                                                                                                                                                                                                                                                                                        |
| Intersection (B9)                                                  |      17 | `Extrema_ExtCC2d/ExtFlag/POnCurv/POnCurv2d/POnSurf`, `IntPatch_Point`, `IntRes2d_IntersectionPoint`, `IntSurf_InteriorPoint/PathPoint/PntOn2S`, `IntTools_CommonPrt/Curve/CurveRangeSample/PntOn2Faces/Range/Root/SurfaceRangeSample`                                                                                                                                                                                                                                          |
| TCollection / TopTools (B10)                                       |       4 | `TCollection_AsciiString` (32×), `TCollection_HExtendedString`, `TopTools_ShapeMapHasher` (36×), `TopTools_FormatVersion`                                                                                                                                                                                                                                                                                                                                                      |
| Topology helpers (B11)                                             |       3 | `TopLoc_Datum3D`, `TopoDS_TShape`, `TopOpeBRepBuild_HBuilder`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Mesh / Poly internals (B12)                                        |       8 | `IMeshTools_Context/Parameters`, `Poly_ArrayOfNodes/ArrayOfUVNodes/MeshPurpose/Polygon2D/Polygon3D/TriangulationParameters`                                                                                                                                                                                                                                                                                                                                                    |
| Geom helpers (B13)                                                 |      10 | `Geom_BezierSurface/OffsetCurve/Plane`, `Geom2dInt_GInter`, `GeomAdaptor_Curve/Surface`, `GeomAbs_BSplKnotDistribution/IsoType`, `GeomTools_UndefinedTypeHandler`, `GProp_PrincipalProps`                                                                                                                                                                                                                                                                                      |
| RW / DE / OSD (B14)                                                |       6 | `RWGltf_GltfPrimArrayData` (11×), `RWMesh_NodeAttributes`, `DESTEP_Parameters`, `DE_ShapeFixParameters`, `OSD_FileSystem`, `UnitsMethods_LengthUnit`                                                                                                                                                                                                                                                                                                                           |
| Misc plate/law/monitor/message/Bnd/ChFiDS/BSplCLib/Adaptor3d (B15) |      15 | `Plate_PinpointConstraint` (21×), `Law_BSpline`, `MoniTool_ValueInterpret/Satisfies/Type`, `Message_Alert/Gravity/Msg/Report`, `Bnd_OBB/Range`, `ChFiDS_CircSection (12×)/ErrorStatus`, `BSplCLib_Cache`, `Adaptor3d_CurveOnSurface`                                                                                                                                                                                                                                           |
| Quantity enums (B16)                                               |       2 | `Quantity_NameOfColor`, `Quantity_TypeOfColor`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C primitives (B17)                                                 |       2 | `size_t`, `uint8_t`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gce_ErrorType` (B18)                                              |       1 | `gce_ErrorType`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| STEPCAFControl_ExternFile + map (B19)                              |       2 | `STEPCAFControl_ExternFile`, `NCollection_DataMap_TCollection_AsciiString_handle_STEPCAFControl_ExternFile`                                                                                                                                                                                                                                                                                                                                                                    |
| Misc (`AppParCurves_*`, `Approx_ParametrizationType`)              |       4 | `AppParCurves_ConstraintCouple/MultiCurve/MultiPoint`, `Approx_ParametrizationType` (14×)                                                                                                                                                                                                                                                                                                                                                                                      |
| **Total**                                                          | **269** |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The `(N×)` annotation indicates how many TS2304 occurrences a name accounts for; the bulk of the 2,364 errors come from the top ~10 names (RTTI/NCollection plumbing in B1).
