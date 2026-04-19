---
title: 'Replicad OCCT v8 Performance & API Opportunities'
description: 'Catalog of OCCT v8 algorithmic improvements, parallelization capabilities, and modern APIs that replicad does not yet use — with concrete adoption steps.'
status: draft
created: '2026-03-20'
updated: '2026-03-20'
category: optimization
related:
  - docs/research/replicad-occt-usage-refinement.md
  - docs/research/occt-v8-migration.md
  - docs/research/ocjs-wasm-build-comparison.md
---

# Replicad OCCT v8 Performance & API Opportunities

Systematic audit of replicad's OCCT usage to identify all OCCT v8 algorithmic improvements, parallelization capabilities, new APIs, and performance features that replicad is not currently leveraging — with concrete adoption steps for each opportunity.

## Executive Summary

Replicad uses ~85 distinct OCCT classes across 22 source files. Analysis reveals 14 concrete improvement opportunities across six categories: parallel meshing, parallel Booleans, modern data exchange, improved mesh parameters, batch operation patterns, and API modernization. The highest-impact changes are enabling parallel meshing (trivial one-flag change), parallel Boolean operations, and adopting `IMeshTools_Parameters` for finer tessellation control. Several brepjs C++ helper patterns (MeshExtractor, BooleanBatch) could also be adopted at the replicad/runtime layer.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Replicad OCCT Usage Map](#replicad-occt-usage-map)
- [Category 1: Tessellation & Meshing](#finding-1-tessellation--meshing)
- [Category 2: Boolean Operations](#finding-2-boolean-operations)
- [Category 3: Data Exchange](#finding-3-data-exchange)
- [Category 4: Shape Healing & Analysis](#finding-4-shape-healing--analysis)
- [Category 5: Geometry & Topology](#finding-5-geometry--topology)
- [Category 6: Batch Operation Patterns](#finding-6-batch-operation-patterns-from-brepjs)
- [Recommendations](#recommendations)
- [Appendix: Full OCCT Class Usage Inventory](#appendix-full-occt-class-usage-inventory)

## Problem Statement

Replicad was developed against OCCT v7.x. Our opencascade.js fork now builds OCCT v8 which introduces significant performance improvements, new parallelization capabilities, modern data exchange formats, and improved algorithms. Replicad has not been updated to take advantage of these improvements. We need a complete catalog of opportunities to inform runtime-level optimizations.

## Methodology

1. Searched all 22 `.ts` files in `repos/replicad/packages/replicad/src/` for `oc.` patterns to catalog every OCCT class usage
2. Cross-referenced against OCCT v8 changelog and API documentation
3. Compared replicad patterns against brepjs's optimized C++ helpers (`repos/brepjs/packages/brepjs-opencascade/build-source/defaults.yml`)
4. Verified OCCT v8 API availability in our opencascade.js build via `build-configs/opencascade_full.d.ts`

## Replicad OCCT Usage Map

| Category             | Classes Used                                                                                 | Key Files                                          |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Boolean operations   | `BRepAlgoAPI_Fuse`, `Cut`, `Common`; `BOPAlgo_GlueEnum`                                      | `shapes.ts`                                        |
| Filleting/Chamfering | `BRepFilletAPI_MakeFillet`, `MakeChamfer`                                                    | `shapes.ts`                                        |
| Primitives           | `BRepPrimAPI_MakeBox`, `MakeCylinder`, `MakeSphere`, `MakePrism`, `MakeRevol`                | `shapeHelpers.ts`, `addThickness.ts`               |
| Wire/Edge building   | `BRepBuilderAPI_MakeEdge`, `MakeWire`, `MakeFace`, `MakeVertex`, `Transform`, `Sewing`       | `shapeHelpers.ts`, `curves.ts`                     |
| Tessellation         | `BRepMesh_IncrementalMesh`, `BRep_Tool.Triangulation`, `GCPnts_TangentialDeflection`         | `shapes.ts`                                        |
| Data exchange        | `STEPControl_Reader/Writer`, `STEPCAFControl_Writer`, `StlAPI`, `Interface_Static`           | `shapes.ts`, `importers.ts`, `assemblyExporter.ts` |
| Shape healing        | `ShapeUpgrade_UnifySameDomain`, `ShapeFix_Wire`, `ShapeFix_Face`, `ShapeFix_Solid`           | `shapes.ts`, `Blueprint.ts`, `importers.ts`        |
| Geometry             | `gp_*`, `Geom_*`, `Geom2d_*`, `GeomAPI_*`, `Geom2dAPI_*`, `GC_*`, `GCE2d_*`                  | Multiple files                                     |
| Topology             | `TopExp_Explorer`, `TopoDS`, `BRepBndLib`, `BRep_Tool`, `BRepAdaptor_*`, `BRepGProp`         | `shapes.ts`                                        |
| Offset/Sweep         | `BRepOffsetAPI_MakeOffset`, `MakeThickSolid`, `MakePipeShell`, `ThruSections`, `MakeFilling` | `shapes.ts`, `addThickness.ts`                     |
| HLR                  | `HLRBRep_Algo`, `HLRAlgo_Projector`, `HLRBRep_HLRToShape`                                    | `makeProjectedEdges.ts`                            |
| Assembly             | `XCAFDoc_*`, `TDocStd_Document`, `TDataStd_Name`                                             | `assemblyExporter.ts`                              |

## Findings

### Finding 1: Tessellation & Meshing

**Current usage** (`shapes.ts:394`):

```typescript
const mesh = new this.oc.BRepMesh_IncrementalMesh_2(shape, tolerance, false, angularTolerance, false);
```

The 5th parameter `isInParallel` is hardcoded to `false`.

| Opportunity                          | Current                                             | v8 Alternative                                                                                                                                             | Impact                                               |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **O1: Enable parallel meshing**      | `isInParallel=false`                                | Set to `true`                                                                                                                                              | High — up to 10× speedup on multi-face assemblies    |
| **O2: Global parallel default**      | Not set                                             | `BRepMesh_IncrementalMesh.SetParallelDefault(true)`                                                                                                        | Medium — enables parallelism for all mesh operations |
| **O3: Use `IMeshTools_Parameters`**  | Fixed constructor params                            | Create `IMeshTools_Parameters` with `DeflectionInterior`, `MinSize`, `Angle`, `InParallel`, `Relative`, `InternalVerticesMode`, `ControlSurfaceDeflection` | High — finer control over mesh quality and speed     |
| **O4: Edge mesh reuse**              | `GCPnts_TangentialDeflection` per edge              | Reuse face triangulation for edges via `BRep_Tool.PolygonOnTriangulation` (already partially done)                                                         | Medium                                               |
| **O5: Post-mesh normal consistency** | `BRepLib.EnsureNormalConsistency` called after mesh | Still recommended but v8 mesh produces better normals                                                                                                      | Low                                                  |

**Adoption steps for O1** (trivial):

```typescript
const mesh = new this.oc.BRepMesh_IncrementalMesh_2(
  shape,
  tolerance,
  false,
  angularTolerance,
  true, // ← change false to true
);
```

**Adoption steps for O3** (moderate):

```typescript
const params = new this.oc.IMeshTools_Parameters();
params.Deflection = tolerance;
params.Angle = angularTolerance;
params.InParallel = true;
params.Relative = false;
params.MinSize = tolerance * 0.1;
const mesh = new this.oc.BRepMesh_IncrementalMesh_3(shape, params);
```

### Finding 2: Boolean Operations

**Current usage** (`shapes.ts:1071-1127`):

```typescript
const fuser = new this.oc.BRepAlgoAPI_Fuse_3(shape1, shape2, progress);
```

| Opportunity                                            | Current                            | v8 Alternative                                                                     | Impact                                         |
| ------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| **O6: Enable parallel Booleans**                       | No `BOPAlgo_Options` configuration | `SetParallelMode(true)` on `BRepAlgoAPI_Fuse/Cut/Common`                           | High — significant speedup on complex Booleans |
| **O7: Enable OBB acceleration**                        | Not configured                     | `SetUseOBB(true)` — uses Oriented Bounding Boxes for faster intersection detection | Medium-High                                    |
| **O8: Use `BRepAlgoAPI_BuilderAlgo`** for N-way fuse   | Sequential fuse/cut                | `BRepAlgoAPI_BuilderAlgo` with argument list for N-way operations                  | High — avoids cascading pair-wise Booleans     |
| **O9: Use `BRepAlgoAPI_Splitter`**                     | Not available                      | `BRepAlgoAPI_Splitter` for splitting without removing material                     | Medium — new capability                        |
| **O10: `ShapeUpgrade_UnifySameDomain` after Booleans** | Already used in `simplify()`       | Can be applied automatically after Booleans                                        | Low (already available)                        |

**Adoption steps for O6+O7**:

```typescript
const fuser = new this.oc.BRepAlgoAPI_Fuse_3(shape1, shape2, progress);
fuser.SetRunParallel(true);
fuser.SetUseOBB(true);
fuser.Build();
```

**Adoption steps for O8** (brepjs pattern):

```typescript
const builder = new this.oc.BRepAlgoAPI_BuilderAlgo();
builder.SetRunParallel(true);
builder.SetUseOBB(true);
const args = new this.oc.TopTools_ListOfShape();
shapes.forEach((s) => args.Append(s));
builder.SetArguments(args);
builder.Build();
const result = builder.Shape();
```

### Finding 3: Data Exchange

**Current usage**: `STEPControl_Reader/Writer` (basic), `STEPCAFControl_Writer` (assemblies), `StlAPI` (STL)

| Opportunity              | Current                      | v8 Alternative                                            | Impact                                   |
| ------------------------ | ---------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| **O11: glTF export**     | Not available                | `RWMesh_CafWriter` for glTF 2.0 export with PBR materials | High — enables direct web 3D integration |
| **O12: glTF import**     | Not available                | `RWMesh_CafReader` for glTF import                        | Medium                                   |
| **O13: OBJ export**      | Not available                | `RWObj_CafWriter`                                         | Low                                      |
| **O14: STEP stream I/O** | File-based via Emscripten FS | `DE_Wrapper` stream-based providers                       | Medium — avoids FS overhead              |

**Note**: glTF export requires the `RWMesh` module to be included in the WASM build. Verify availability in our `full.yml` OCCT module filter.

**Adoption steps for O11**:

```typescript
const doc = new this.oc.TDocStd_Document('XmlOcaf');
const writer = new this.oc.RWMesh_CafWriter('output.glb');
writer.Perform(doc, new this.oc.TColStd_IndexedDataMapOfStringString(), new this.oc.Message_ProgressRange());
```

### Finding 4: Shape Healing & Analysis

**Current usage**: `ShapeFix_Wire`, `ShapeFix_Face`, `ShapeFix_Solid`, `ShapeUpgrade_UnifySameDomain`

| Opportunity                             | Current                     | v8 Alternative                                           | Impact                             |
| --------------------------------------- | --------------------------- | -------------------------------------------------------- | ---------------------------------- |
| **O15: `ShapeAnalysis_CheckSmallFace`** | Not used                    | Detect and remove small/degenerate faces before Booleans | Medium — prevents Boolean failures |
| **O16: Improved `ShapeFix_Shape`**      | Uses individual fix classes | `ShapeFix_Shape` consolidates fix operations             | Low — convenience                  |
| **O17: `BRepCheck_Analyzer`**           | Not used                    | Pre-validate shapes before operations                    | Medium — earlier error detection   |

### Finding 5: Geometry & Topology

| Opportunity                             | Current                      | v8 Alternative                                   | Impact |
| --------------------------------------- | ---------------------------- | ------------------------------------------------ | ------ |
| **O18: `BRepExtrema_SelfIntersection`** | Not used                     | Detect self-intersections before Booleans        | Medium |
| **O19: `GeomHash` / `Geom2dHash`**      | Not used                     | Content-based geometry hashing for deduplication | Low    |
| **O20: `BRepBuilderAPI_FastSewing`**    | Uses `BRepBuilderAPI_Sewing` | Faster sewing for large assemblies               | Medium |

### Finding 6: Batch Operation Patterns (from brepjs)

brepjs introduces C++ batch helpers that eliminate JS↔WASM call overhead. These patterns could be adopted in our `additionalBindCode` or runtime layer.

| Pattern                  | brepjs Implementation                                          | replicad Gap                             | Impact |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------------- | ------ |
| **MeshExtractor**        | Single C++ call extracts all vertices, normals, triangles, UVs | Per-face JS iteration in `shapes.ts:414` | High   |
| **EdgeMeshExtractor**    | Two-pass edge tessellation with segment counting               | Per-edge `GCPnts_TangentialDeflection`   | Medium |
| **BooleanBatch**         | N-way fuse/cut with `SetRunParallel`, `SetUseOBB`              | Sequential pair-wise Booleans            | High   |
| **TransformBatch**       | Batch translate/rotate/scale/mirror                            | Per-shape `BRepBuilderAPI_Transform`     | Medium |
| **MeasurementExtractor** | Bulk volume/area/bbox computation                              | Per-shape `BRepGProp` calls              | Medium |
| **TopologyExtractor**    | C++ topology iteration                                         | `TopExp_Explorer` from JS                | Medium |

**Adoption approach**: These helpers belong in `additionalBindCode.cpp` of our opencascade.js build, then consumed by the `@taucad/runtime` replicad kernel.

## Recommendations

| #   | Action                                                      | Priority | Effort  | Impact      | Category      |
| --- | ----------------------------------------------------------- | -------- | ------- | ----------- | ------------- |
| R1  | Enable parallel meshing (`isInParallel=true`)               | P0       | Trivial | High        | Tessellation  |
| R2  | Enable parallel Booleans (`SetRunParallel(true)`)           | P0       | Low     | High        | Boolean       |
| R3  | Enable OBB acceleration (`SetUseOBB(true)`)                 | P0       | Low     | Medium-High | Boolean       |
| R4  | Adopt `IMeshTools_Parameters` for fine-grained mesh control | P1       | Medium  | High        | Tessellation  |
| R5  | Add `BRepAlgoAPI_BuilderAlgo` for N-way fuse                | P1       | Medium  | High        | Boolean       |
| R6  | Add MeshExtractor C++ helper to `additionalBindCode`        | P1       | High    | High        | Performance   |
| R7  | Add BooleanBatch C++ helper to `additionalBindCode`         | P1       | High    | High        | Performance   |
| R8  | Verify and enable glTF export via `RWMesh_CafWriter`        | P2       | Medium  | High        | Data exchange |
| R9  | Add `BRepAlgoAPI_Splitter` for split operations             | P2       | Low     | Medium      | Boolean       |
| R10 | Add `prewarm()` pattern to runtime WASM init                | P2       | Low     | Medium      | Startup       |
| R11 | Add TransformBatch C++ helper                               | P2       | Medium  | Medium      | Performance   |
| R12 | Add MeasurementExtractor C++ helper                         | P2       | Medium  | Medium      | Performance   |
| R13 | Add `BRepCheck_Analyzer` for pre-validation                 | P3       | Low     | Medium      | Reliability   |
| R14 | Explore `BRepBuilderAPI_FastSewing` for large assemblies    | P3       | Low     | Medium      | Performance   |

## Appendix: Full OCCT Class Usage Inventory

### Boolean Operations

| Class                | File                  | Usage         |
| -------------------- | --------------------- | ------------- |
| `BRepAlgoAPI_Fuse`   | `shapes.ts:1071`      | `fuse()`      |
| `BRepAlgoAPI_Cut`    | `shapes.ts:1102`      | `cut()`       |
| `BRepAlgoAPI_Common` | `shapes.ts:1127`      | `intersect()` |
| `BOPAlgo_GlueEnum`   | `shapes.ts:1074,1077` | Glue options  |

### Filleting / Chamfering

| Class                       | File             | Usage                             |
| --------------------------- | ---------------- | --------------------------------- |
| `BRepFilletAPI_MakeFillet`  | `shapes.ts:1324` | `fillet()` with `ChFi3d_Rational` |
| `BRepFilletAPI_MakeChamfer` | `shapes.ts:1377` | `chamfer()`                       |

### Primitives

| Class                      | File                  | Usage                |
| -------------------------- | --------------------- | -------------------- |
| `BRepPrimAPI_MakeBox`      | `shapeHelpers.ts:377` | `makeBox`            |
| `BRepPrimAPI_MakeCylinder` | `shapeHelpers.ts:381` | `makeCylinder`       |
| `BRepPrimAPI_MakeSphere`   | `shapeHelpers.ts:393` | `makeSphere`         |
| `BRepPrimAPI_MakePrism`    | `addThickness.ts:28`  | `basicFaceExtrusion` |
| `BRepPrimAPI_MakeRevol`    | `addThickness.ts:48`  | `revolution`         |

### Wire / Edge Building

| Class                       | File                                            | Usage                        |
| --------------------------- | ----------------------------------------------- | ---------------------------- |
| `BRepBuilderAPI_MakeEdge`   | `curves.ts`, `shapeHelpers.ts`, `Sketcher2d.ts` | Edge creation                |
| `BRepBuilderAPI_MakeWire`   | `shapeHelpers.ts:271`                           | `assembleWire`               |
| `BRepBuilderAPI_MakeFace`   | `shapeHelpers.ts:308,324,435`                   | `makeFace`, `addHolesInFace` |
| `BRepBuilderAPI_MakeVertex` | `shapeHelpers.ts:386`                           | `makeVertex`                 |
| `BRepBuilderAPI_Transform`  | `geom.ts:318`                                   | Transformations              |
| `BRepBuilderAPI_Sewing`     | `shapeHelpers.ts:428`                           | `weldShellsAndFaces`         |

### Tessellation

| Class                              | File                | Usage                             |
| ---------------------------------- | ------------------- | --------------------------------- |
| `BRepMesh_IncrementalMesh`         | `shapes.ts:394`     | `_mesh()` — **parallel disabled** |
| `BRep_Tool.Triangulation`          | `shapes.ts:493,982` | Face triangulation access         |
| `BRep_Tool.PolygonOnTriangulation` | `shapes.ts:507`     | Edge polygon on triangulation     |
| `GCPnts_TangentialDeflection`      | `shapes.ts:539`     | Edge discretization               |
| `BRepLib.EnsureNormalConsistency`  | `shapes.ts:401`     | Post-mesh normal fix              |

### Data Exchange

| Class                            | File                                   | Usage                |
| -------------------------------- | -------------------------------------- | -------------------- |
| `STEPControl_Writer`             | `shapes.ts:568`                        | `blobSTEP()`         |
| `STEPControl_Reader`             | `importers.ts:21`                      | `importSTEP()`       |
| `STEPCAFControl_Writer`          | `assemblyExporter.ts:100,114`          | Assembly STEP export |
| `StlAPI.Write` / `StlAPI_Reader` | `shapes.ts:614`, `importers.ts:55`     | STL I/O              |
| `Interface_Static`               | `shapes.ts:570`, `assemblyExporter.ts` | STEP options         |

### Shape Healing

| Class                          | File                                       | Usage            |
| ------------------------------ | ------------------------------------------ | ---------------- |
| `ShapeUpgrade_UnifySameDomain` | `shapes.ts:248`, `importers.ts:61`         | `simplify()`     |
| `ShapeFix_Wire`                | `Blueprint.ts:177`, `CompoundSketch.ts:62` | Wire fixing      |
| `ShapeFix_Face`                | `shapeHelpers.ts:441`                      | `addHolesInFace` |
| `ShapeFix_Solid`               | `shapeHelpers.ts:430`                      | `makeSolid`      |

### Offset / Sweep

| Class                           | File                  | Usage           |
| ------------------------------- | --------------------- | --------------- |
| `BRepOffsetAPI_MakeOffset`      | `shapes.ts:793`       | Wire offset     |
| `BRepOffsetAPI_MakeOffsetShape` | `shapeHelpers.ts:399` | Face offset     |
| `BRepOffsetAPI_MakeThickSolid`  | `shapes.ts:1236`      | `shell()`       |
| `BRepOffsetAPI_MakePipeShell`   | `addThickness.ts:102` | Sweep           |
| `BRepOffsetAPI_ThruSections`    | `addThickness.ts:306` | Loft            |
| `BRepOffsetAPI_MakeFilling`     | `shapeHelpers.ts:337` | Non-planar face |

### Measurement / Analysis

| Class                                 | File                           | Usage           |
| ------------------------------------- | ------------------------------ | --------------- |
| `BRepGProp` (Linear, Surface, Volume) | `shapes.ts`, `measureShape.ts` | Mass properties |
| `BRepBndLib.Add`                      | `shapes.ts:389`                | Bounding box    |
| `BRepExtrema_DistShapeShape`          | `measureShape.ts:99`           | Distance        |
| `BRepAdaptor_Curve/Surface/Curve2d`   | `shapes.ts`, `curves.ts`       | Adaptors        |

## References

- [OCCT v8 Release Notes](https://dev.opencascade.org/doc/overview/html/index.html)
- [brepjs C++ helpers](https://github.com/andymai/brepjs/tree/main/packages/brepjs-opencascade/build-source)
- Related: `docs/research/replicad-occt-usage-refinement.md`
- Related: `docs/research/occt-v8-migration.md`
- Related: `docs/research/ocjs-wasm-build-comparison.md`
