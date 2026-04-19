---
title: 'Replicad Normal Smoothing Pipeline'
description: 'Root cause analysis of lumpy/faceted surfaces in replicad kernel and how OCCT native GLTF export and brepjs achieve smooth shading — full OCCT GLTF writer parity achieved via BRepLProp_SLProps on-the-fly normal evaluation'
status: active
created: '2026-04-10'
updated: '2026-04-11'
category: investigation
related:
  - docs/research/occt-v8-rc5-migration.md
---

# Replicad Normal Smoothing Pipeline

Root cause investigation into why the replicad kernel produces visibly faceted ("lumpy") surfaces on curved BRep geometry while both the OpenCASCADE kernel and brepjs produce smooth surfaces for identical geometry.

## Executive Summary

The lumpy surface appearance was caused by replicad's use of `Poly_Triangulation::ComputeNormals()` as a fallback when normals are missing after meshing. This function computes normals from **triangle cross products** (mesh geometry), which are faceted approximations. The OCCT native GLTF writer (`RWGltf_CafWriter`) uses **analytic surface normals** via `BRepLProp_SLProps`, and brepjs uses `BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)` which evaluates `GeomLib::NormEstim` at UV coordinates — both produce exact, smooth normals regardless of mesh density. The fix was implemented in two phases: (R6) single-WASM-call C++ mesh extraction with `GeomLib::NormEstim`-based normals, then (R7) full OCCT GLTF writer parity via `BRepLProp_SLProps` on-the-fly normal evaluation, eliminating all 8 pipeline differences identified in the delta analysis. See `docs/research/replicad-occt-gltf-pipeline-delta.md` for the complete delta analysis.

## Problem Statement

A DNA double helix model rendered with the replicad kernel shows visible banding/faceting on curved toroidal surfaces (helix strands), while the same geometry constructed with the OpenCASCADE kernel using identical OCCT primitives appears smooth. Both kernels use `BRepMesh_IncrementalMesh` for tessellation with equivalent tolerances.

Visual comparison: replicad (left) shows clear face-boundary seams; OpenCASCADE (right) is smooth.

## Methodology

1. Traced the full mesh pipeline in both kernels: replicad (`shape.mesh()`) and OpenCASCADE (`meshShapesToGltf` → `RWGltf_CafWriter`)
2. Read the replicad source code (`repos/replicad/packages/replicad/src/shapes.ts`) for `_mesh()`, `mesh()`, and `Face.triangulation()`
3. Read the OCCT rc5 source (commit `0ebbbed`) for `RWGltf_CafWriter`, `RWMesh_FaceIterator`, `BRepLib::EnsureNormalConsistency`, and `Poly_Triangulation::ComputeNormals`
4. Confirmed `BRepMesh_IncrementalMesh` does NOT store normals in `Poly_Triangulation`
5. Built equivalent OpenCASCADE kernel code mapping each replicad primitive to its underlying OCCT API call and validated smooth output
6. Cloned and analyzed brepjs (`repos/brepjs/`) — read the custom C++ meshing code in `packages/brepjs-opencascade/build-config/brepjs.yml` (`MeshExtractor`, `MeshBatchExtractor`, `BRepMesh_IncrementalMeshWrapper`), the TS mesh pipeline (`src/kernel/occt/meshOps.ts`, `src/topology/meshFns.ts`), and the OCCT source for `BRepLib_ToolTriangulatedShape::ComputeNormals` and `GeomLib::NormEstim`

## Findings

### Finding 1: `BRepMesh_IncrementalMesh` does NOT store normals

The `BRepMesh_IncrementalMesh` source (`src/ModelingAlgorithms/TKMesh/BRepMesh/BRepMesh_IncrementalMesh.cxx`) contains zero references to `Normal`, `ComputeNormals`, `AddNormals`, or `SetNormal`. After meshing, `Poly_Triangulation::HasNormals()` returns **false**.

This means both the replicad kernel and the OCCT GLTF writer face the same situation: normals must be computed after meshing.

### Finding 2: Replicad uses mesh-geometric normals (faceted)

Replicad's `Face.triangulation()` in `shapes.ts` (lines 900–912):

```cpp
// replicad source (TypeScript calling OCCT WASM)
if (!tri.HasNormals()) {     // Always true after BRepMesh_IncrementalMesh
  tri.ComputeNormals();       // ← Mesh cross-product normals
}
// Then reads normals from tri.Normal(i)
```

`Poly_Triangulation::ComputeNormals()` (OCCT `src/FoundationClasses/TKMath/Poly/Poly_Triangulation.cxx`, lines 436–470) computes normals by:

1. For each triangle: `normal = (P1-P0) × (P2-P0)` (unnormalized cross product)
2. Accumulate to each of the 3 corner vertices (area-weighted)
3. Normalize all vertex normals

These are **mesh-geometric normals** — they approximate the surface normal from the triangle geometry. On coarse meshes or at face boundaries (where vertices are duplicated), they produce faceted shading because:

- Normals follow triangle orientations, not the true surface
- Adjacent faces compute normals independently (no cross-face averaging)
- Shared edge vertices are duplicated with potentially divergent normals

### Finding 3: OCCT GLTF writer uses analytic surface normals (smooth)

`RWMesh_FaceIterator::normal()` (OCCT `src/DataExchange/TKRWMesh/RWMesh/RWMesh_FaceIterator.cxx`, lines 56–74):

```cpp
gp_Dir RWMesh_FaceIterator::normal(int theNode) const
{
  gp_Dir aNormal(gp::DZ());
  if (myPolyTriang->HasNormals())
  {
    // Path A: use stored normals (rarely true after BRepMesh_IncrementalMesh)
    myPolyTriang->Normal(theNode, aNormVec3);
    aNormal.SetCoord(aNormVec3.x(), aNormVec3.y(), aNormVec3.z());
  }
  else if (myHasNormals && myPolyTriang->HasUVNodes())
  {
    // Path B (the common path): analytic surface normal via UV evaluation
    const gp_XY anUV = myPolyTriang->UVNode(theNode).XY();
    mySLTool.SetParameters(anUV.X(), anUV.Y());     // BRepLProp_SLProps
    if (mySLTool.IsNormalDefined())
    {
      aNormal = mySLTool.Normal();                   // ← Exact surface normal
    }
  }
  return aNormal;
}
```

Key insight: `BRepLProp_SLProps` evaluates the **surface partial derivatives** at the vertex's UV parameters, then takes their cross product to get the **true mathematical surface normal**. This produces:

- Exact normals independent of mesh density
- Naturally consistent normals at smooth face boundaries (both faces' surfaces agree)
- No faceting artifacts

The `initFace()` method (lines 103–127) sets up this fallback:

```cpp
void RWMesh_FaceIterator::initFace()
{
  myHasNormals = false;
  if (myPolyTriang->HasNormals()) {
    myHasNormals = true;
  }
  if (myPolyTriang->HasUVNodes() && !myHasNormals) {
    // Set up BRepLProp_SLProps for analytic surface normal evaluation
    myFaceAdaptor.Initialize(aFaceFwd, false);
    mySLTool.SetSurface(myFaceAdaptor);
    myHasNormals = true;                             // normals available via surface
  }
}
```

### Finding 4: `RWGltf_CafWriter` does NOT call `EnsureNormalConsistency`

A search of the entire `TKDEGLTF` package confirms `EnsureNormalConsistency` is never referenced by the GLTF writer. The smooth appearance comes entirely from `BRepLProp_SLProps` in `RWMesh_FaceIterator`, not from any post-processing.

### Finding 5: `BRepLib::EnsureNormalConsistency` — two-phase surface normal pipeline

`BRepLib::EnsureNormalConsistency()` (OCCT `src/ModelingAlgorithms/TKTopAlgo/BRepLib/BRepLib.cxx`, lines 2404–2525) implements a two-phase approach:

**Phase A — Compute analytic surface normals** (lines 2418–2463):

For each face with triangulation, uses `GeomLProp_SLProps` (same underlying math as `BRepLProp_SLProps`) to evaluate the true surface normal at each vertex's UV coordinates. Reverses for `TopAbs_REVERSED` faces. This replaces any `ComputeNormals()`-style mesh normals with exact surface normals.

**Phase B — Average normals at smooth shared edges** (lines 2469–2522):

1. Builds edge→face adjacency map via `TopExp::MapShapesAndAncestors`
2. Only processes edges with exactly 2 adjacent faces (manifold edges)
3. For each shared edge vertex pair, compares normals via dot product
4. If `dot(n1, n2) > cos(theAngTol)` (angle below threshold), replaces both with `normalize(n1 + n2)`
5. Default `theAngTol = 0.001` radians (~0.057°)

Phase B makes normals **identical** at shared edge vertices, eliminating even sub-pixel seams.

### Finding 6: The normal computation strategies compared

| Aspect                 | `ComputeNormals()` (replicad) | `BRepLProp_SLProps` (OCCT GLTF) | `EnsureNormalConsistency`                       |
| ---------------------- | ----------------------------- | ------------------------------- | ----------------------------------------------- |
| Normal source          | Triangle cross products       | Surface partial derivatives     | Surface partial derivatives + edge averaging    |
| Accuracy               | Mesh-dependent approximation  | Mathematically exact            | Mathematically exact + topologically consistent |
| Requires               | Only mesh geometry            | UV nodes + surface geometry     | UV nodes + surface + edge topology              |
| Cross-face consistency | None                          | Natural (same surface)          | Enforced (averaged at edges)                    |
| Available in WASM      | Yes (`Poly_Triangulation`)    | Requires `BRepLProp_SLProps`    | Requires `BRepLib` + topology tools             |
| Visual result          | Faceted at face boundaries    | Smooth                          | Smooth with identical edge normals              |

### Finding 7: brepjs uses `BRepLib_ToolTriangulatedShape::ComputeNormals` — a per-face surface normal API

brepjs embeds custom C++ mesh extraction code in its WASM build (`packages/brepjs-opencascade/build-config/brepjs.yml`, `additionalCppCode`). The `MeshExtractor::extract` function performs both meshing and data extraction in a single C++ call. Its normal pipeline:

```cpp
// brepjs MeshExtractor (C++ in brepjs.yml, lines 610–628)
if (!skipNormals) {
  if (!tri->HasNormals()) {
    BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);  // ← surface normals
  }
  for (int i = 1; i <= nbNodes; i++) {
    gp_Dir d(0, 0, 1);
    if (tri->HasNormals()) {
      NCollection_Vec3<float> nv;
      tri->Normal(i, nv);
      // ... transform by face location
    }
  }
}
```

`BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)` (OCCT `src/ModelingAlgorithms/TKTopAlgo/BRepLib/BRepLib_ToolTriangulatedShape.cxx`, lines 27–80) is fundamentally different from `Poly_Triangulation::ComputeNormals()`:

```cpp
void BRepLib_ToolTriangulatedShape::ComputeNormals(
  const TopoDS_Face& theFace,
  const Handle(Poly_Triangulation)& theTris,
  Poly_Connect& thePolyConnect)
{
  if (theTris.IsNull() || theTris->HasNormals()) return;

  const TopoDS_Face aZeroFace = TopoDS::Face(theFace.Located(TopLoc_Location()));
  Handle(Geom_Surface) aSurf = BRep_Tool::Surface(aZeroFace);
  if (!theTris->HasUVNodes() || aSurf.IsNull()) {
    Poly::ComputeNormals(theTris);  // ← fallback: mesh-geometric normals
    return;
  }

  for (int aNodeIter = 1; aNodeIter <= theTris->NbNodes(); ++aNodeIter) {
    // Primary path: analytic surface normal via UV coordinates
    if (GeomLib::NormEstim(aSurf, theTris->UVNode(aNodeIter), aTol, aNorm) > 1) {
      // Fallback: averaged triangle normals for this specific vertex
      // (only when surface evaluation fails, e.g. singularities)
    }
    theTris->SetNormal(aNodeIter, aNorm);
  }
}
```

The algorithm:

1. Retrieves the underlying `Geom_Surface` from the BRep face
2. For each mesh node, calls `GeomLib::NormEstim(surface, uvNode, tol, normal)` — evaluates surface partial derivatives D1 (and D2 if needed) at the node's UV coordinates to compute the **true mathematical surface normal**
3. Falls back to mesh-geometric normals only for individual vertices where surface evaluation fails (singularities, degenerate UV)
4. Stores computed normals back into the `Poly_Triangulation`

This is the same mathematical approach as `RWMesh_FaceIterator::normal()` (Finding 3) and `BRepLib::EnsureNormalConsistency` Phase A (Finding 5), but packaged as a per-face static method that takes both the face and triangulation as parameters.

brepjs does **not** call `EnsureNormalConsistency` — it relies solely on per-face surface normals without cross-face edge averaging. For smooth edges, this works because both faces' underlying surfaces mathematically agree on the normal at shared boundary points.

### Finding 8: `StdPrs_ToolTriangulatedShape` is a subclass of `BRepLib_ToolTriangulatedShape`

OCCT's `StdPrs_ToolTriangulatedShape` (visualization module) directly inherits from `BRepLib_ToolTriangulatedShape`:

```cpp
// StdPrs_ToolTriangulatedShape.hxx
class StdPrs_ToolTriangulatedShape : public BRepLib_ToolTriangulatedShape { ... };
```

Replicad includes `StdPrs_ToolTriangulatedShape` in its WASM build config (`build-source/defaults.yml`), but the `ComputeNormals(face, tri)` static method is **not exposed** in the generated TypeScript bindings (`replicad_single.d.ts`). This means the per-face surface normal API exists in replicad's compiled WASM module but is inaccessible from JavaScript.

### Finding 9: brepjs single-WASM-call mesh architecture vs. replicad N-call-per-face

| Aspect                  | brepjs                                                           | replicad                                                                                           |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Mesh extraction         | Single C++ call `MeshExtractor.extract(shape, ...)`              | JS loop: N × `face.triangulation()` per face                                                       |
| WASM boundary crossings | 1 (mesh + extract all data)                                      | 1 (mesh) + N × ~5 (per face: `Triangulation`, `NbNodes`, `Node` × M, `Normal` × M, `Triangle` × K) |
| Data format             | Pre-allocated `Float32Array` / `Uint32Array` in C++              | JavaScript `Array<number>` concatenation                                                           |
| Normal computation      | C++ per-face `BRepLib_ToolTriangulatedShape::ComputeNormals`     | JS-side `tri.ComputeNormals()`                                                                     |
| Batch support           | `MeshBatchExtractor` for multi-shape (compiled but unused in TS) | Not available                                                                                      |
| Face groups             | Hash-based `[start, count, faceHash]` in C++                     | JS-side accumulation                                                                               |

The brepjs architecture minimizes JS↔WASM boundary crossings. For a shape with F faces and N total nodes, replicad makes O(F × N/F) = O(N) WASM calls, while brepjs makes O(1). Each WASM call incurs overhead from Embind argument marshalling, heap access, and JIT deoptimization at the boundary.

### Finding 10: Normal computation strategies — three-way comparison

| Aspect                     | `ComputeNormals()` (replicad)    | `BRepLib_ToolTriangulatedShape` (brepjs) | `EnsureNormalConsistency` (OCCT)                     | `RWMesh_FaceIterator` (OCCT GLTF)   |
| -------------------------- | -------------------------------- | ---------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| Normal source              | Triangle cross products          | `GeomLib::NormEstim` (surface D1/D2)     | `GeomLProp_SLProps` (surface D1/D2) + edge averaging | `BRepLProp_SLProps` (surface D1/D2) |
| Scope                      | Per triangulation (no face info) | Per face (takes `TopoDS_Face`)           | Whole shape (all faces + edges)                      | Per face (during iteration)         |
| Stores normals             | In `Poly_Triangulation`          | In `Poly_Triangulation`                  | In `Poly_Triangulation`                              | On-the-fly (not stored)             |
| Cross-face consistency     | None                             | Natural (same surface)                   | Enforced (averaged at edges)                         | Natural (same surface)              |
| Available in replicad WASM | Yes (`Poly_Triangulation`)       | No (symbol not bound to JS)              | Yes (`BRepLib`)                                      | No (requires `RWMesh` module)       |
| Visual result              | Faceted at face boundaries       | Smooth                                   | Smooth + identical edge normals                      | Smooth                              |
| Performance                | Fast (mesh math only)            | Fast (per-face surface eval)             | Moderate (shape traversal + topology)                | Fast (per-face, streaming)          |

## Recommendations & Implementation Status

R6 was implemented directly (skipping R1–R5 as intermediate steps), delivering both the normal quality fix and the performance optimization in one shot.

| #   | Action                                                 | Status           | Notes                                                                         |
| --- | ------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| R1  | Call `EnsureNormalConsistency` in `_mesh()`            | Superseded by R6 | R6 achieves the same result with better architecture                          |
| R2  | Verify `EnsureNormalConsistency` exposed in WASM       | N/A              | Not needed — R6 uses custom C++ classes                                       |
| R3  | Expose `BRepLib_ToolTriangulatedShape::ComputeNormals` | Done (via R6)    | Called internally from `ReplicadMeshExtractor`                                |
| R4  | Replace `tri.ComputeNormals()` per face                | Done (via R6)    | C++ extractor uses `BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)` |
| R5  | Un-skip Normal consistency tests                       | Done             | All 4 tests pass                                                              |
| R6  | Single-WASM-call C++ mesh extraction (brepjs pattern)  | **Implemented**  | See implementation notes below                                                |

### R6 Implementation Notes

**C++ classes added to `replicad-opencascadejs`** (`repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml`):

- `ReplicadMeshData` — holds `malloc`-allocated float/uint buffers for vertices, normals, triangles, face groups with pointer/size getters
- `ReplicadMeshExtractor::extract(shape, tolerance, angularTolerance, skipNormals)` — single C++ call that:
  1. Runs `BRepMesh_IncrementalMesh` for tessellation
  2. Two-pass: counts total nodes/triangles, then allocates and fills
  3. Per face: calls `BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)` for analytic surface normals
  4. Negates normals for `TopAbs_REVERSED` faces (critical — `ComputeNormals` does NOT account for face orientation)
  5. Swaps triangle winding for reversed faces
  6. Transforms vertices and normals by face location
  7. Records face groups with `TopTools_ShapeMapHasher`-based face hash
- `ReplicadEdgeMeshData` — edge line coordinates and edge groups
- `ReplicadEdgeMeshExtractor::extract(shape, tolerance, angularTolerance)` — single C++ call for edge mesh extraction via both face polygon-on-triangulation and curve tessellation fallback

**WASM build changes**:

- Added `EXPORTED_RUNTIME_METHODS=["FS","HEAP32","HEAPU32","HEAPF32"]` for efficient JS→WASM heap data transfer
- Added `#include <BRepLib_ToolTriangulatedShape.hxx>`, `<Poly_Connect.hxx>`, `<BRepAdaptor_Curve.hxx>`, `<GCPnts_TangentialDeflection.hxx>`, `<NCollection_Map.hxx>`, `<NCollection_Array1.hxx>` to `additionalCppCode`
- Used `NCollection_Array1<Standard_Integer>` instead of deprecated `TColStd_Array1OfInteger` (OCCT v8)
- Added `HEAP32`, `HEAPU32`, `HEAPF32` type declarations to `OpenCascadeInstance` in auto-generated `.d.ts`

**Build system**: Used the local `repos/opencascade.js` NX build system (`build-wasm.sh link`), NOT Docker. The `O3-wasm-exc-simd` cached build stages (PCH, generate, compile-bindings, compile-sources) were reused — only the `link` step ran (~175s).

**Replicad source changes** (`repos/replicad/packages/replicad/src/shapes.ts`):

- `mesh()`: replaced N-call-per-face JS loop with single `ReplicadMeshExtractor.extract()` call + `HEAPF32`/`HEAPU32`/`HEAP32` slicing
- `meshEdges()`: replaced JS edge iteration loop with single `ReplicadEdgeMeshExtractor.extract()` call
- Both methods use `Array.from()` to copy from typed arrays and call `raw.delete()` for cleanup

**Key fix discovered during validation**: `BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)` does NOT negate normals for reversed faces — it computes surface normals in their natural parametric direction. The old JS code had `normalSign = orient === 'backward' ? -1 : 1` to handle this. The C++ extractor now applies `normalSign` for reversed faces, making it correct.

**Test results**: All 103 replicad tests pass (4 Normal consistency + 99 existing), 0 failures. The Normal consistency suite validates:

- Outward-facing normals on convex solids (rounded rectangle extruded)
- Outward-facing normals after boolean operations (cylinder cut)
- Smooth normals across face boundaries on filleted shapes (dot product > 0.7 for >90% of co-located vertices)
- Sharp edges preserved on non-filleted geometry (tray with 90° wall-to-base transitions)

**Versions**: `replicad@0.21.0-v8.44`, `replicad-opencascadejs@0.21.0-v8.44`

## Code Examples

### Current replicad pipeline (produces faceted normals)

```
BRepMesh_IncrementalMesh(shape)     →  Poly_Triangulation created, HasNormals() = false
Face.triangulation():               →  N JS→WASM calls per face
  tri.HasNormals() → false
  tri.ComputeNormals()              →  Cross-product normals from mesh triangles
  tri.Normal(i)                     →  Mesh-geometric normal (faceted)
```

### brepjs pipeline (produces smooth normals, single C++ call)

```
MeshExtractor::extract(shape)       →  Single WASM call does everything:
  BRepMesh_IncrementalMesh(shape)   →  Poly_Triangulation, HasNormals() = false
  Per face:
    BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)
      → GeomLib::NormEstim(surface, UV) → Analytic surface normal
      → Fallback: mesh normals only for degenerate vertices
    tri.Normal(i)                   →  Surface-analytic normal (smooth)
  Pack into pre-allocated Float32Array/Uint32Array
```

### OCCT GLTF writer pipeline (produces smooth normals)

```
BRepMesh_IncrementalMesh(shape)     →  Poly_Triangulation created, HasNormals() = false
RWMesh_FaceIterator::initFace():
  HasNormals() → false
  HasUVNodes() → true
  Setup BRepLProp_SLProps(surface)   →  Analytic surface evaluator ready
RWMesh_FaceIterator::normal(node):
  SLProps.SetParameters(UV)          →  Evaluate surface at vertex UV
  SLProps.Normal()                   →  True surface normal (smooth)
```

### Proposed fix A — replicad + EnsureNormalConsistency (R1)

```
BRepMesh_IncrementalMesh(shape)     →  Poly_Triangulation, HasNormals() = false
BRepLib::EnsureNormalConsistency():
  Phase A: GeomLProp_SLProps(UV)    →  Analytic surface normals stored in triangulation
  Phase B: Edge averaging           →  Shared edge normals made identical
  → HasNormals() = true
Face.triangulation():
  tri.HasNormals() → true           →  Uses stored surface normals (skip ComputeNormals)
  tri.Normal(i)                     →  Smooth, edge-consistent normal
```

### Proposed fix B — replicad + per-face surface normals (R3–R4, brepjs approach)

```
BRepMesh_IncrementalMesh(shape)     →  Poly_Triangulation, HasNormals() = false
Face.triangulation():               →  N JS→WASM calls per face (unchanged architecture)
  tri.HasNormals() → false
  BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)  ← replaces tri.ComputeNormals()
    → GeomLib::NormEstim(surface, UV)
  tri.Normal(i)                     →  Surface-analytic normal (smooth)
```

### Implemented fix — replicad + single C++ extraction (R6, brepjs architecture)

```
ReplicadMeshExtractor::extract()    →  Single WASM call:
  BRepMesh_IncrementalMesh(shape)
  Per face:
    BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)
    Negate normals for TopAbs_REVERSED faces  ← critical fix
    Swap triangle winding for reversed faces
    Transform vertices/normals by face location
    Pack into pre-allocated Float32Array/Uint32Array
  Return via HEAPF32/HEAPU32/HEAP32 slicing  →  Smooth normals + minimal WASM overhead
```

## Trade-offs (Historical)

R1–R5 were originally proposed as incremental steps. In practice, R6 was implemented directly since it delivers both the normal quality fix and the performance optimization in one shot, with the brepjs codebase providing a complete reference implementation. The incremental approaches remain documented above for context.

## References

- OCCT source (rc5, commit `0ebbbed`): `src/DataExchange/TKRWMesh/RWMesh/RWMesh_FaceIterator.cxx`
- OCCT source: `src/ModelingAlgorithms/TKTopAlgo/BRepLib/BRepLib.cxx` (lines 2404–2525)
- OCCT source: `src/ModelingAlgorithms/TKTopAlgo/BRepLib/BRepLib_ToolTriangulatedShape.cxx` (lines 27–80)
- OCCT source: `src/ModelingData/TKGeomBase/GeomLib/GeomLib.cxx` (`NormEstim`, lines 2451–2530)
- OCCT source: `src/FoundationClasses/TKMath/Poly/Poly_Triangulation.cxx` (lines 436–470)
- OCCT source: `src/DataExchange/TKDEGLTF/RWGltf/RWGltf_CafWriter.cxx`
- Replicad source: `repos/replicad/packages/replicad/src/shapes.ts`
- brepjs source: `repos/brepjs/packages/brepjs-opencascade/build-config/brepjs.yml` (MeshExtractor, MeshBatchExtractor)
- brepjs source: `repos/brepjs/src/kernel/occt/meshOps.ts` (TS mesh extraction)
- brepjs source: `repos/brepjs/src/topology/meshFns.ts` (public mesh API)
- Normal consistency test suite: `packages/runtime/src/kernels/replicad/replicad.kernel.test.ts` (un-skipped, all 4 tests pass)
- WASM build config: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` (ReplicadMeshExtractor, ReplicadEdgeMeshExtractor)
- Build system: `repos/opencascade.js/build-wasm.sh link` with `OCJS_CONFIG=O3-wasm-exc-simd`
