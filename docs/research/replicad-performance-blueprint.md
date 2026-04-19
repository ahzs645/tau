---
title: 'Replicad Performance Blueprint'
description: 'Comprehensive blueprint for accelerating replicad internals via OCCT v8 features, native C++ batch helpers, parallelism, and JS↔WASM boundary elimination — cross-referenced with brepjs and zalo patterns'
status: draft
created: '2026-03-24'
updated: '2026-03-24'
category: architecture
related:
  - docs/research/replicad-occt-v8-opportunities.md
  - docs/research/replicad-occt-usage-refinement.md
  - docs/research/ocjs-zalo-occt-v8-fork-analysis.md
  - docs/research/occt-v8-migration.md
---

# Replicad Performance Blueprint

Comprehensive blueprint for making replicad a world-class TypeScript CAD API by eliminating JS↔WASM boundary overhead, leveraging OCCT v8 parallelism/algorithms, and introducing native C++ batch operations — all without changing replicad's public API.

## Executive Summary

Replicad's current implementation crosses the JS↔WASM boundary thousands of times per mesh export (per-vertex, per-normal, per-triangle calls), uses sequential Booleans without parallelism or OBB acceleration, and iterates topology with O(n²) duplicate detection in JavaScript. Analysis of brepjs's `additionalCppCode` reveals 11 native C++ helper classes that eliminate these bottlenecks. This blueprint catalogs 32 concrete optimization opportunities organized into 8 tiers, with expected speedups ranging from 2× (Boolean OBB) to 50×+ (mesh extraction). All changes are internal to the opencascade.js build config and the `@taucad/runtime` replicad kernel — no changes to the public replicad API.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Methodology](#methodology)
- [Tier 1: Mesh Extraction — Native C++ Pipeline](#tier-1-mesh-extraction--native-c-pipeline)
- [Tier 2: Edge Mesh Extraction — Native C++ Pipeline](#tier-2-edge-mesh-extraction--native-c-pipeline)
- [Tier 3: Boolean Operations — Parallelism and Batching](#tier-3-boolean-operations--parallelism-and-batching)
- [Tier 4: Topology Iteration — Native Deduplication](#tier-4-topology-iteration--native-deduplication)
- [Tier 5: Measurement — Bulk Native Extraction](#tier-5-measurement--bulk-native-extraction)
- [Tier 6: Transform — Batch Native Execution](#tier-6-transform--batch-native-execution)
- [Tier 7: Sweep/Loft/Shell/Fillet — Batch Builders](#tier-7-sweeploftshellfillet--batch-builders)
- [Tier 8: OCCT v8 Algorithm Upgrades](#tier-8-occt-v8-algorithm-upgrades)
- [Tier 9: Meshing Algorithm Selection (OCCT v8)](#tier-9-meshing-algorithm-selection-occt-v8)
- [Tier 10: Threading Architecture](#tier-10-threading-architecture)
- [additionalCppCode Specification](#additionalcppcode-specification)
- [Integration Architecture](#integration-architecture)
- [Comparison Matrix: Replicad vs brepjs](#comparison-matrix-replicad-vs-brepjs)
- [Recommendations](#recommendations)
- [Appendix A: Complete Hot-Path Inventory](#appendix-a-complete-hot-path-inventory)
- [Appendix B: WASM Boundary Call Counts](#appendix-b-wasm-boundary-call-counts)

## Problem Statement

Replicad was built against OCCT v7.x with a direct-call model where every OCCT operation is an individual JS→WASM function call via Embind. This architecture has three critical performance problems:

1. **Mesh export crosses the boundary O(V+N+T) times** — for a shape with 10,000 vertices and 20,000 triangles, `Face.triangulation()` makes ~90,000 individual WASM calls (3 coords × nodes × 2 passes for verts+normals, plus 3 indices × triangles), repeated for every face
2. **Boolean operations lack parallelism** — `SetRunParallel(true)` and `SetUseOBB(true)` are never called, despite being available since OCCT 7.4
3. **Topology iteration uses O(n²) JavaScript dedup** — `iterTopo` calls `IsSame()` pairwise in a JavaScript array, vs OCCT's O(1) `NCollection_Map`

brepjs solved all three problems with 11 C++ helper classes in `additionalCppCode` (~1,140 lines) that batch operations inside WASM. This blueprint specifies equivalent helpers tailored for replicad's API and our opencascade.js build.

## Methodology

1. Read all 22 replicad source files containing `oc.` calls; cataloged every OCCT API call site with line numbers
2. Read brepjs `additionalCppCode` (1,140 lines C++) and all 21 `*Ops.ts` consumer files
3. Read zalo/opencascade.js `cascadestudio.yml` for OCCT v8 RC4 patterns (Watson+DelaBella meshing, `IMeshTools_MeshAlgoType`, `SetNonDestructive`)
4. Cross-referenced replicad-occt-v8-opportunities.md (14 opportunities) and replicad-occt-usage-refinement.md (216 symbols)
5. Analyzed OCCT v8 parallel APIs (`SetRunParallel`, `SetUseOBB`, `InParallel` meshing, `IMeshTools_Parameters`, `BRepAlgoAPI_BuilderAlgo`)

## Tier 1: Mesh Extraction — Native C++ Pipeline

**Current replicad hot path** (`shapes.ts:358-934`):

```
mesh() → _mesh() → for each face:
  face.triangulation(offset) →
    BRep_Tool.Triangulation()
    for i in 1..nbNodes:        ← 3 WASM calls per vertex (Node, Transformed, X/Y/Z)
      tri.Node(i).Transformed()
    for i in 1..nbNodes:        ← 3 WASM calls per normal
      tri.Normal(i).Transformed()
    for t in 1..nbTriangles:    ← 4 WASM calls per triangle (Triangle, Value×3)
      tri.Triangle(t).Value(1/2/3)
```

**WASM boundary calls per face**: `~10 × nbNodes + 4 × nbTriangles + overhead`

**For a shape with 10 faces × 1,000 nodes × 2,000 triangles each**: ~180,000 WASM calls

### Proposed: `ReplicadMeshExtractor` (C++)

Single native call returns packed buffers. Adapted from brepjs's `MeshExtractor` with these replicad-specific enhancements:

- Use `std::hash<TopoDS_Shape>` for face IDs (OCCT v8 — replaces `HashCode(int)`)
- Use `StdPrs_ToolTriangulatedShape::Normal` for robust normals (brepjs pattern)
- Include UV data optionally (replicad's `triangulation` doesn't expose UVs, but our runtime needs them for matcap rendering)
- Add `ComputeNormals()` fallback when `HasNormals()` is false (replicad pattern at `shapes.ts:900-902`)

**Expected speedup**: 30-50× for mesh export (eliminates ~180,000 WASM calls → 1 call)

**C++ specification**:

```cpp
class ReplicadMeshData {
  float* vertices;      // [x,y,z, x,y,z, ...] per node
  float* normals;       // [nx,ny,nz, ...] per node
  uint32_t* triangles;  // [i0,i1,i2, ...] per triangle (global indices)
  int32_t* faceGroups;  // [triStart, triCount, faceHash] per face
  float* uvs;           // [u,v, ...] per node (optional)
  // sizes for each buffer
};

class ReplicadMeshExtractor {
  static ReplicadMeshData extract(
    const TopoDS_Shape& shape,
    double tolerance,
    double angularTolerance,
    bool includeUVs
  );
  // Single WASM call. JS reads via HEAPF32/HEAPU32 slicing.
};
```

## Tier 2: Edge Mesh Extraction — Native C++ Pipeline

**Current replicad hot path** (`shapes.ts:395-478`):

```
meshEdges() → for each face:
  BRep_Tool.Triangulation(face)
  for each edge of face:
    BRep_Tool.PolygonOnTriangulation(edge, tri)
    for i in polygon.Nodes():          ← 3 WASM calls per node
      tri.Node(node).Transformed()
  for remaining edges:
    GCPnts_TangentialDeflection(adaptor) ← expensive tessellation per edge
    for i in 1..nbPts:
      tangDef.Value(i)                   ← 3 WASM calls per point
```

**WASM calls for 100 edges × 20 nodes average**: ~6,000 calls minimum

### Proposed: `ReplicadEdgeMeshExtractor` (C++)

Directly adapted from brepjs's `EdgeMeshExtractor` with two-pass design:

- **Pass 1**: Count segments (polygon-on-triangulation + curve tessellation), via `NCollection_Map`
- **Pass 2**: Fill exact-size buffers
- Cache `GCPnts_TangentialDeflection` counts from Pass 1 to avoid re-tessellation

**Expected speedup**: 10-20× for edge mesh export

## Tier 3: Boolean Operations — Parallelism and Batching

### O1: Enable Parallel Booleans (Trivial)

**Current** (`shapes.ts:946-1002`): No `SetRunParallel`, no `SetUseOBB`

```typescript
const fuser = new this.oc.BRepAlgoAPI_Fuse(this.wrapped, other.wrapped, progress);
// Missing: fuser.SetRunParallel(true)
// Missing: fuser.SetUseOBB(true)
```

**Fix**: Add two calls before `Build()`. In single-threaded WASM, `SetRunParallel(true)` has no overhead and prepares for future multi-threaded builds. `SetUseOBB(true)` provides 20-40% speedup on complex intersections by using Oriented Bounding Boxes.

### O2: Enable Non-Destructive Mode

From zalo's analysis: `SetNonDestructive(true)` preserves input shapes. Replicad's functional API expects immutability — destructive mode mutates inputs silently, potentially causing subtle bugs.

### O3: Auto Fuzzy Value (brepjs Pattern)

brepjs's `booleanOps.ts:71-94` implements an automatic fuzzy value heuristic based on bounding box diagonal for ≥3 shapes. This prevents Boolean failures on near-coincident faces.

### O4: N-way Fuse via `BRepAlgoAPI_BuilderAlgo`

**Current**: Sequential `fuse(a, fuse(b, fuse(c, d)))` — O(n) cascading pair-wise Booleans

**brepjs pattern**: `BooleanBatch.fuseAll()` uses `BRepAlgoAPI_BuilderAlgo` with all shapes at once:

```cpp
BRepAlgoAPI_BuilderAlgo builder;
builder.SetArguments(shapes_);        // All shapes at once
builder.SetRunParallel(Standard_True);
builder.SetUseOBB(Standard_True);
builder.Build(progress);
```

**Expected speedup**: 2-5× for N-way fuse operations (avoids cascading intermediate shapes)

### O5: N-way Cut via Multi-Tool `BRepAlgoAPI_Cut`

brepjs's `BooleanBatch.cutAll()` cuts a base shape with all tools simultaneously:

```cpp
BRepAlgoAPI_Cut cutter;
cutter.SetArguments(argList);  // base
cutter.SetTools(toolList);     // all tools at once
cutter.SetRunParallel(Standard_True);
cutter.SetUseOBB(Standard_True);
cutter.Build(progress);
```

### O6: Auto-Simplify After Booleans

brepjs's `BooleanBatch` has an optional `simplify` flag that runs `ShapeUpgrade_UnifySameDomain` after every Boolean. Replicad already has `simplify()` but doesn't auto-apply it. The `additionalCppCode` version avoids an extra JS→WASM round-trip.

### Proposed: `ReplicadBooleanHelper` (C++)

```cpp
class ReplicadBooleanHelper {
public:
  static TopoDS_Shape fuseAll(
    const TopTools_ListOfShape& shapes,
    int glueMode,
    bool simplify,
    double fuzzyValue,
    bool nonDestructive
  );

  static TopoDS_Shape cutAll(
    const TopoDS_Shape& base,
    const TopTools_ListOfShape& tools,
    int glueMode,
    bool simplify,
    double fuzzyValue,
    bool nonDestructive
  );

  static TopoDS_Shape intersect(
    const TopoDS_Shape& s1,
    const TopoDS_Shape& s2,
    double fuzzyValue,
    bool nonDestructive
  );

  static TopoDS_Shape split(
    const TopoDS_Shape& shape,
    const TopTools_ListOfShape& tools
  );
};
```

**Expected speedup**: 2-5× for N-way operations; 20-40% for pair-wise (OBB alone)

## Tier 4: Topology Iteration — Native Deduplication

**Current** (`shapes.ts:145-158`):

```typescript
iterTopo(shapeType) {
  const items = [];
  const seen: T[] = [];
  // ...
  while (explorer.More()) {
    const item = explorer.Current();
    if (!seen.some((s) => s.IsSame(item))) {  // ← O(n²) pairwise IsSame
      seen.push(item);
      items.push(item);
    }
    explorer.Next();
  }
}
```

For a shape with 500 faces, this performs up to 125,000 `IsSame` calls across the WASM boundary.

### Proposed: `ReplicadTopologyExtractor` (C++)

Directly from brepjs's `TopologyExtractor` — uses `NCollection_Map` for O(1) dedup:

```cpp
class ReplicadTopologyExtractor {
public:
  static TopologyResult extract(const TopoDS_Shape& shape, int shapeType) {
    NCollection_Map<TopoDS_Shape, TopTools_ShapeMapHasher> seen;
    std::vector<TopoDS_Shape> shapes;
    for (TopExp_Explorer ex(shape, topoType); ex.More(); ex.Next()) {
      if (seen.Add(ex.Current())) {
        shapes.push_back(ex.Current());
      }
    }
    // pack into result
  }
};
```

**Expected speedup**: 5-20× for topology enumeration on complex shapes

## Tier 5: Measurement — Bulk Native Extraction

**Current** (`measureShape.ts`): Three separate JS→WASM calls for volume, area, and linear properties, plus separate bounding box computation.

### Proposed: `ReplicadMeasurementExtractor` (C++)

From brepjs's `MeasurementExtractor` — computes volume, area, length, center of mass, and bounding box in a single native call, returning a packed `double[12]` array:

```
Layout: [volume, area, length, centerX, centerY, centerZ,
         bboxMinX, bboxMinY, bboxMinZ, bboxMaxX, bboxMaxY, bboxMaxZ]
```

**Expected speedup**: 3-5× (eliminates multiple BRepGProp + BRepBndLib round-trips)

## Tier 6: Transform — Batch Native Execution

**Current** (`geom.ts:228-335`): Each transform creates a `gp_Trsf`, then `BRepBuilderAPI_Transform` — one round-trip per shape.

### Proposed: `ReplicadTransformBatch` (C++)

From brepjs's `TransformBatch` — queues translate/rotate/scale/mirror operations and executes them all in a single native call:

```cpp
class ReplicadTransformBatch {
public:
  void addTranslate(const TopoDS_Shape& shape, double x, double y, double z);
  void addRotate(const TopoDS_Shape& shape, double angle, ...);
  void addScale(const TopoDS_Shape& shape, double factor, ...);
  void addMirror(const TopoDS_Shape& shape, ...);
  TransformBatchResult execute();  // One WASM call for N transforms
};
```

**Expected speedup**: N× for batch transforms (1 call instead of N)

## Tier 7: Sweep/Loft/Shell/Fillet — Batch Builders

brepjs implements four batch builder classes, each following the same pattern: queue operations, execute all at once, return packed results.

### O1: `ReplicadLoftBatch`

Batches `BRepOffsetAPI_ThruSections` operations. Eliminates per-loft JS→WASM round-trips.

### O2: `ReplicadExtrudeBatch`

Batches `BRepPrimAPI_MakePrism` operations.

### O3: `ReplicadShellBatch`

Batches `BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin` operations.

### O4: `ReplicadFilletBatch`

Batches `BRepFilletAPI_MakeFillet` operations with support for variable-radius fillets.

**Expected speedup**: Proportional to batch size (useful when the runtime or AI agent generates multiple operations)

## Tier 8: OCCT v8 Algorithm Upgrades

### O1: `IMeshTools_Parameters` for Fine-Grained Meshing

**Current** (`shapes.ts:348`): Uses `BRepMesh_IncrementalMesh_2` constructor with fixed parameters.

**OCCT v8**: `IMeshTools_Parameters` provides:

- `DeflectionInterior` — separate interior deflection control
- `MinSize` — minimum element size
- `InParallel` — parallel meshing
- `ControlSurfaceDeflection` — curvature-adaptive control
- `MeshAlgo` — algorithm selection (DEFAULT, Watson, DelaBella)

```cpp
IMeshTools_Parameters params;
params.Deflection = tolerance;
params.Angle = angularTolerance;
params.InParallel = true;  // Ready for multi-threaded WASM
params.Relative = false;
params.MinSize = tolerance * 0.1;
params.MeshAlgo = IMeshTools_MeshAlgoType_Delabella;  // New in OCCT v8
```

### O2: `BRepAlgoAPI_Splitter` for Shape Splitting

New in OCCT v7.4+. Splits shapes without removing material — useful for boolean "split" operations that replicad doesn't currently support.

### O3: `BRepBuilderAPI_FastSewing`

Alternative to `BRepBuilderAPI_Sewing` for large assemblies — trades some quality for significant speed improvement. Replicad uses `Sewing` at `shapeHelpers.ts:568`.

### O4: Shape Validation with `BRepCheck_Analyzer`

Pre-validate shapes before Boolean operations to fail fast instead of producing invalid results.

## Tier 9: Meshing Algorithm Selection (OCCT v8)

From zalo's fork analysis: OCCT 8.0 RC4 has a known bug where the Watson meshing algorithm drops nodes on curved faces after Boolean cuts. Zalo's workaround is a two-pass mesh:

```cpp
// Pass 1: Watson (default) — reliable for all face types
params.MeshAlgo = IMeshTools_MeshAlgoType_DEFAULT;
BRepMesh_IncrementalMesh(theShape, params);

// Save Watson triangulations per face
// Clean existing mesh
BRepTools::Clean(theShape);

// Pass 2: DelaBella — fixes curved faces
params.MeshAlgo = IMeshTools_MeshAlgoType_Delabella;
BRepMesh_IncrementalMesh(theShape, params);

// Restore Watson results where DelaBella produced null
```

### Proposed: Integrate into `ReplicadMeshExtractor`

Add a `meshAlgo` parameter with options:

- `0` = Watson only (current behavior)
- `1` = DelaBella only
- `2` = Two-pass Watson+DelaBella (zalo pattern)

The two-pass mode should be the default for complex shapes with Boolean history, configurable via the runtime.

## Tier 10: Threading Architecture

### Current State: Single-Threaded WASM

OCCT's threading APIs (`SetRunParallel`, `InParallel`) are no-ops in single-threaded WASM. However, setting them has zero overhead and prepares the codebase for multi-threaded WASM.

### Multi-Threaded WASM (SharedArrayBuffer + pthreads)

When `SharedArrayBuffer` is available (requires `Cross-Origin-Isolcation` headers), Emscripten can compile with `-pthread`:

1. **OCCT internal parallelism**: Boolean algorithms, meshing, and shape analysis use TBB/OpenMP internally. With `-pthread`, these automatically parallelize on Web Workers.
2. **Compile flag**: `-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency`
3. **Runtime detection**: Check `typeof SharedArrayBuffer !== 'undefined'`

### Proposed: Threading-Aware `additionalCppCode`

All proposed C++ helpers should use OCCT's parallel APIs unconditionally:

```cpp
// In ReplicadBooleanHelper::fuseAll:
builder.SetRunParallel(Standard_True);  // No-op in single-threaded, parallel in multi-threaded

// In ReplicadMeshExtractor::extract:
IMeshTools_Parameters params;
params.InParallel = true;  // Same: no-op → automatic parallelism
```

### Worker-Level Parallelism

For single-threaded WASM, parallelism is achieved at the worker level:

- Independent shapes can be processed in separate Web Workers with separate OCCT instances
- The `@taucad/runtime` kernel worker architecture already supports this
- Each worker has its own WASM memory — no SharedArrayBuffer needed

### Multi-Threaded WASM Build Configuration

For future multi-threaded builds:

```yaml
emccFlags:
  - '-pthread'
  - '-sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency'
  - '-sALLOW_MEMORY_GROWTH=1'
  - '-sPROXY_TO_PTHREAD' # Avoids blocking main thread
```

## additionalCppCode Specification

### Complete C++ Helper Suite

The following classes should be added to our `build-configs/full.yml` `additionalCppCode` section. Each class follows the brepjs pattern of heap-owned buffers with ownership-transfer copy constructors for Embind compatibility.

| Class                          | Lines (est.) | Purpose                                                    | Adapts from                            |
| ------------------------------ | ------------ | ---------------------------------------------------------- | -------------------------------------- |
| `ReplicadMeshData`             | ~50          | Heap buffer container for mesh data                        | brepjs `MeshData`                      |
| `ReplicadMeshExtractor`        | ~120         | Single-call mesh extraction with normals, UVs, face groups | brepjs `MeshExtractor` + zalo two-pass |
| `ReplicadEdgeMeshData`         | ~30          | Heap buffer container for edge line data                   | brepjs `EdgeMeshData`                  |
| `ReplicadEdgeMeshExtractor`    | ~100         | Two-pass edge discretization with dedup                    | brepjs `EdgeMeshExtractor`             |
| `ReplicadBooleanHelper`        | ~80          | fuseAll, cutAll, intersect, split with parallelism         | brepjs `BooleanBatch` + zalo helpers   |
| `ReplicadTopologyResult`       | ~30          | Shape array result container                               | brepjs `TopologyResult`                |
| `ReplicadTopologyExtractor`    | ~20          | Native topology iteration with NCollection_Map dedup       | brepjs `TopologyExtractor`             |
| `ReplicadMeasurementData`      | ~25          | Packed double[12] for measurement results                  | brepjs `MeasurementData`               |
| `ReplicadMeasurementExtractor` | ~50          | Bulk volume/area/length/CoM/bbox                           | brepjs `MeasurementExtractor`          |
| `ReplicadTransformBatch`       | ~100         | Queued translate/rotate/scale/mirror                       | brepjs `TransformBatch`                |
| `ReplicadBatchResult`          | ~25          | Generic shape array result                                 | brepjs `ShapeBatchResult`              |
| `ReplicadLoftBatch`            | ~60          | Batched ThruSections                                       | brepjs `LoftBatch`                     |
| `ReplicadExtrudeBatch`         | ~35          | Batched MakePrism                                          | brepjs `ExtrudeBatch`                  |
| `ReplicadShellBatch`           | ~50          | Batched MakeThickSolid                                     | brepjs `ShellBatch`                    |
| `ReplicadFilletBatch`          | ~50          | Batched MakeFillet with variable radius                    | brepjs `FilletBatch`                   |
| `ReplicadEvolutionData`        | ~40          | Packed evolution (Modified/Generated/Deleted)              | brepjs `EvolutionData`                 |
| `ReplicadEvolutionExtractor`   | ~60          | Bulk face evolution tracking                               | brepjs `EvolutionExtractor`            |

**Total estimated C++ code**: ~925 lines

### Key Adaptations from brepjs

1. **HashCode**: Replace `face.HashCode(2147483647)` (OCCT 7.x) with `std::hash<TopoDS_Shape>{}(shape)` (OCCT 8.0)
2. **Normals**: Use `StdPrs_ToolTriangulatedShape::Normal` (brepjs) instead of replicad's per-vertex `tri.Normal(i)` + `ComputeNormals()` fallback
3. **Face winding**: Both brepjs and replicad flip winding for reversed faces; the C++ version handles it internally
4. **Memory**: Ownership-transfer copy constructors for Embind; JS side calls `.delete()` after HEAP slicing
5. **Meshing**: Add `IMeshTools_Parameters` with `MeshAlgo` selection and `InParallel = true`
6. **Boolean non-destructive**: Add `SetNonDestructive(true)` from zalo pattern

## Integration Architecture

### Layer 1: `additionalCppCode` in opencascade.js Build Config

```
build-configs/full.yml
  additionalCppCode: |
    // ~925 lines of C++ helpers
    class ReplicadMeshData { ... };
    class ReplicadMeshExtractor { ... };
    // ... all 17 classes
```

These get compiled into the WASM binary as part of the Embind binding step.

### Layer 2: `@taucad/runtime` Replicad Kernel

The replicad kernel in `packages/runtime/src/kernels/replicad/` detects helper availability (brepjs pattern) and dispatches accordingly:

```typescript
const hasNativeMesh = typeof oc.ReplicadMeshExtractor?.extract === 'function';

function meshShape(shape: TopoDS_Shape, opts: MeshOptions): MeshData {
  if (hasNativeMesh) {
    return nativeMeshExtract(oc, shape, opts);
  }
  return jsMeshExtract(oc, shape, opts); // fallback
}
```

### Layer 3: Feature Detection Caching

Follow brepjs's pattern of caching feature detection results and resetting on kernel init:

```typescript
let _hasMeshExtractor: boolean | null = null;
function detectMeshExtractor(oc: OC): boolean {
  if (_hasMeshExtractor === null) {
    _hasMeshExtractor = typeof oc.ReplicadMeshExtractor?.extract === 'function';
  }
  return _hasMeshExtractor;
}
export function resetDetectionCaches() {
  _hasMeshExtractor = null;
  // ... reset all caches
}
```

### Layer 4: HEAP Buffer Reading

For native extractors that return pointer+size pairs, follow brepjs's `meshOps.ts` pattern:

```typescript
function nativeMeshExtract(oc: OC, shape: TopoDS_Shape, opts: MeshOptions): MeshResult {
  const raw = oc.ReplicadMeshExtractor.extract(shape, opts.tolerance, opts.angularTolerance, true);

  // CRITICAL: slice before any WASM call that could grow memory
  const vertices = new Float32Array(oc.HEAPF32.buffer, raw.getVerticesPtr(), raw.getVerticesSize()).slice();
  const normals = new Float32Array(oc.HEAPF32.buffer, raw.getNormalsPtr(), raw.getNormalsSize()).slice();
  const triangles = new Uint32Array(oc.HEAPU32.buffer, raw.getTrianglesPtr(), raw.getTrianglesSize()).slice();
  const faceGroups = new Int32Array(oc.HEAP32.buffer, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize()).slice();

  raw.delete(); // Free C++ heap memory

  return { vertices, normals, triangles, faceGroups };
}
```

## Comparison Matrix: Replicad vs brepjs

| Operation                | Replicad (current)                              | brepjs (native C++)                                | Gap             | Proposed Fix                   |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------- | --------------- | ------------------------------ |
| **Mesh export**          | Per-face JS loop: ~10N+4T WASM calls            | `MeshExtractor.extract`: 1 call                    | **30-50×**      | `ReplicadMeshExtractor`        |
| **Edge mesh**            | Per-edge JS loop with redundant tessellation    | `EdgeMeshExtractor.extract`: 1 call, 2-pass        | **10-20×**      | `ReplicadEdgeMeshExtractor`    |
| **Boolean fuse**         | Sequential pair-wise, no OBB, no parallel       | `BooleanBatch.fuseAll`: BuilderAlgo, OBB, parallel | **2-5×**        | `ReplicadBooleanHelper`        |
| **Boolean cut**          | Sequential single-tool, no OBB                  | `BooleanBatch.cutAll`: multi-tool, OBB, parallel   | **2-5×**        | `ReplicadBooleanHelper`        |
| **Topology iter**        | O(n²) JS `IsSame` dedup                         | `TopologyExtractor`: O(n) NCollection_Map          | **5-20×**       | `ReplicadTopologyExtractor`    |
| **Measurement**          | 3+ separate WASM calls                          | `MeasurementExtractor`: 1 call → double[12]        | **3-5×**        | `ReplicadMeasurementExtractor` |
| **Transform**            | Per-shape WASM call                             | `TransformBatch.execute`: batched                  | **N×**          | `ReplicadTransformBatch`       |
| **Loft**                 | Per-loft WASM call                              | `LoftBatch.execute`: batched                       | **N×**          | `ReplicadLoftBatch`            |
| **Extrude**              | Per-shape WASM call                             | `ExtrudeBatch.execute`: batched                    | **N×**          | `ReplicadExtrudeBatch`         |
| **Shell**                | Per-shape WASM call                             | `ShellBatch.execute`: batched                      | **N×**          | `ReplicadShellBatch`           |
| **Fillet**               | Per-shape WASM call                             | `FilletBatch.execute`: batched                     | **N×**          | `ReplicadFilletBatch`          |
| **Face evolution**       | Per-face JS loop + Modified/Generated/IsDeleted | `EvolutionExtractor`: 1 call → packed int32[]      | **3-10×**       | `ReplicadEvolutionExtractor`   |
| **Meshing algo**         | Watson only                                     | Watson+DelaBella two-pass                          | Quality fix     | `MeshAlgo` param               |
| **Boolean immutability** | Destructive mode                                | `SetNonDestructive(true)`                          | Correctness     | Auto-enable                    |
| **Parallel mesh**        | `InParallel = false`                            | N/A (single-threaded)                              | Future-ready    | Set `true`                     |
| **OBB acceleration**     | Not used                                        | `SetUseOBB(true)`                                  | **20-40%**      | Auto-enable                    |
| **Fuzzy value**          | Not used                                        | Auto-calculated from bbox diagonal                 | Reliability     | Auto-calculate                 |
| **Shape validation**     | Not used                                        | N/A                                                | Error detection | `BRepCheck_Analyzer`           |
| **Fast sewing**          | `BRepBuilderAPI_Sewing`                         | N/A                                                | Speed option    | `BRepBuilderAPI_FastSewing`    |

## Recommendations

| #   | Action                                                                | Priority | Effort  | Impact               | Tier |
| --- | --------------------------------------------------------------------- | -------- | ------- | -------------------- | ---- |
| R1  | Add `ReplicadMeshExtractor` to `additionalCppCode` + runtime consumer | P0       | High    | **30-50× mesh**      | 1    |
| R2  | Enable `SetRunParallel(true)` + `SetUseOBB(true)` on all Booleans     | P0       | Trivial | **20-40% boolean**   | 3    |
| R3  | Add `ReplicadEdgeMeshExtractor` to `additionalCppCode` + consumer     | P0       | High    | **10-20× edge mesh** | 2    |
| R4  | Add `ReplicadTopologyExtractor` for O(1) dedup                        | P0       | Medium  | **5-20× iteration**  | 4    |
| R5  | Add `ReplicadBooleanHelper` with fuseAll/cutAll/split                 | P1       | High    | **2-5× N-way bool**  | 3    |
| R6  | Enable `SetNonDestructive(true)` on all Booleans                      | P1       | Trivial | Correctness          | 3    |
| R7  | Add `ReplicadMeasurementExtractor` for bulk measurement               | P1       | Medium  | **3-5× measure**     | 5    |
| R8  | Add auto fuzzy value heuristic (brepjs pattern)                       | P1       | Low     | Reliability          | 3    |
| R9  | Adopt `IMeshTools_Parameters` with `MeshAlgo` selection               | P1       | Medium  | Quality + options    | 8, 9 |
| R10 | Add `ReplicadTransformBatch` for batch transforms                     | P2       | Medium  | **N× transform**     | 6    |
| R11 | Add `ReplicadFilletBatch` for batch fillets                           | P2       | Medium  | **N× fillet**        | 7    |
| R12 | Add `ReplicadShellBatch` for batch shells                             | P2       | Medium  | **N× shell**         | 7    |
| R13 | Add `ReplicadExtrudeBatch` for batch extrusions                       | P2       | Medium  | **N× extrude**       | 7    |
| R14 | Add `ReplicadLoftBatch` for batch lofts                               | P2       | Medium  | **N× loft**          | 7    |
| R15 | Add `ReplicadEvolutionExtractor` for face tracking                    | P2       | Medium  | **3-10× evolution**  | 5    |
| R16 | Integrate Watson+DelaBella two-pass meshing                           | P2       | Medium  | Quality fix          | 9    |
| R17 | Add `BRepAlgoAPI_Splitter` support                                    | P2       | Low     | New capability       | 8    |
| R18 | Add `BRepCheck_Analyzer` pre-validation                               | P3       | Low     | Error detection      | 8    |
| R19 | Evaluate `BRepBuilderAPI_FastSewing` for large assemblies             | P3       | Low     | Speed option         | 8    |
| R20 | Multi-threaded WASM build config (`-pthread`)                         | P3       | High    | Future parallelism   | 10   |

## Appendix A: Complete Hot-Path Inventory

### Mesh Pipeline (Highest Priority)

| Location            | Operation                                     | WASM Calls                | Fix                         |
| ------------------- | --------------------------------------------- | ------------------------- | --------------------------- |
| `shapes.ts:348`     | `_mesh()` — `BRepMesh_IncrementalMesh`        | 1                         | Keep (meshing is one call)  |
| `shapes.ts:365-378` | `mesh()` — face loop + `face.triangulation()` | O(faces × (nodes + tris)) | `ReplicadMeshExtractor`     |
| `shapes.ts:893-898` | `triangulation()` — vertex extraction loop    | 3 × nbNodes               | `ReplicadMeshExtractor`     |
| `shapes.ts:904-908` | `triangulation()` — normal extraction loop    | 3 × nbNodes               | `ReplicadMeshExtractor`     |
| `shapes.ts:916-931` | `triangulation()` — triangle extraction loop  | 4 × nbTriangles           | `ReplicadMeshExtractor`     |
| `shapes.ts:435-478` | `meshEdges()` — face×edge polygon loop        | O(faces × edges × nodes)  | `ReplicadEdgeMeshExtractor` |

### Boolean Operations

| Location             | Operation                               | WASM Calls | Fix                            |
| -------------------- | --------------------------------------- | ---------- | ------------------------------ |
| `shapes.ts:946-963`  | `fuse()` — single pair, no parallel/OBB | 5-7        | Add SetRunParallel + SetUseOBB |
| `shapes.ts:970-986`  | `cut()` — single pair, no parallel/OBB  | 5-7        | Add SetRunParallel + SetUseOBB |
| `shapes.ts:993-1003` | `intersect()` — no parallel/OBB         | 5-7        | Add SetRunParallel + SetUseOBB |

### Topology Iteration

| Location            | Operation                              | WASM Calls | Fix                         |
| ------------------- | -------------------------------------- | ---------- | --------------------------- |
| `shapes.ts:145-158` | `iterTopo()` — O(n²) IsSame dedup      | O(n²)      | `ReplicadTopologyExtractor` |
| `shapes.ts:329-338` | `get faces`/`get edges` — via iterTopo | O(n²)      | Cached via extractor        |

### Measurement

| Location                | Operation    | WASM Calls | Fix                            |
| ----------------------- | ------------ | ---------- | ------------------------------ |
| `measureShape.ts:41-42` | Surface area | 2-3        | `ReplicadMeasurementExtractor` |
| `measureShape.ts:59-65` | Volume       | 2-3        | Bundled in extractor           |
| `shapes.ts:604-608`     | Edge length  | 2-3        | Bundled in extractor           |
| `shapes.ts:343-344`     | Bounding box | 1-2        | Bundled in extractor           |

### Other Hot Paths

| Location                                 | Operation                              | WASM Calls | Fix               |
| ---------------------------------------- | -------------------------------------- | ---------- | ----------------- |
| `shapeHelpers.ts:482-487`                | `makeEllipsoid` — SetPole loop         | O(poles²)  | Native C++ loop   |
| `projection/makeProjectedEdges.ts:41-51` | `BuildCurves3d` per edge               | O(edges)   | Batch in compound |
| `curves.ts:16-19`                        | `curvesBoundingBox` — BndLib per curve | O(curves)  | Native batch      |
| `lib2d/Curve2D.ts:55-59`                 | `value()` — alloc+delete per call      | 3 per call | Inline or cache   |
| `lib2d/Curve2D.ts:83-87`                 | `geomType()` — new adaptor per call    | 3 per call | Cache adaptor     |

## Appendix B: WASM Boundary Call Counts

Estimated call counts for a moderately complex shape (20 faces, 5,000 total nodes, 10,000 total triangles, 80 edges):

| Operation                          | Current Calls | With Native C++    | Reduction     |
| ---------------------------------- | ------------- | ------------------ | ------------- |
| `mesh()`                           | ~130,000      | 1                  | **130,000×**  |
| `meshEdges()`                      | ~5,000        | 1                  | **5,000×**    |
| `iterTopo(FACE)` × 3 ops           | ~1,200        | 3                  | **400×**      |
| `fuse()` + `cut()` + `intersect()` | ~21           | ~3 (+ OBB speedup) | **7× + algo** |
| `volume()` + `area()` + `bbox()`   | ~9            | 1                  | **9×**        |
| **Total per-render cycle**         | **~136,230**  | **~9**             | **~15,000×**  |

These numbers represent the _overhead_ reduction. The actual wall-clock speedup depends on per-call overhead (~1-5μs for Embind dispatch) and the OCCT algorithm time itself. For mesh extraction, where OCCT algorithm time is dominated by the extraction loop, the speedup approaches the call count reduction.

## References

- [brepjs additionalCppCode](repos/brepjs/packages/brepjs-opencascade/build-source/defaults.yml) — lines 306-1448
- [brepjs TypeScript consumers](repos/brepjs/src/kernel/occt/) — 21 `*Ops.ts` files
- [zalo/opencascade.js cascadestudio-v2](https://github.com/zalo/opencascade.js/tree/cascadestudio-v2) — OCCT 8 RC4 patterns
- Related: `docs/research/replicad-occt-v8-opportunities.md`
- Related: `docs/research/replicad-occt-usage-refinement.md`
- Related: `docs/research/ocjs-zalo-occt-v8-fork-analysis.md`
