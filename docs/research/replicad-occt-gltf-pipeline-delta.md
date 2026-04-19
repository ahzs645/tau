---
title: 'Replicad vs OCCT GLTF Pipeline Delta Analysis'
description: 'Systematic comparison of every difference between the replicad and OpenCASCADE native GLTF rendering pipelines that causes remaining visual artifacts on swept surfaces'
status: active
created: '2026-04-10'
updated: '2026-04-11'
category: investigation
related:
  - docs/research/replicad-normal-smoothing-pipeline.md
  - docs/research/occt-v8-rc5-migration.md
---

# Replicad vs OCCT GLTF Pipeline Delta Analysis

Systematic investigation of all remaining differences between the replicad kernel and OpenCASCADE kernel GLTF rendering pipelines that produce visible shading artifacts on swept BRep surfaces (DNA helix model), despite the R6 surface-analytic normal fix from the prior investigation.

## Executive Summary

After implementing the single-WASM-call C++ mesh extractor (R6) using `BRepLib_ToolTriangulatedShape::ComputeNormals`, the replicad kernel shows improved but still visible face-boundary seams on the DNA helix model, while the OpenCASCADE kernel produces perfectly smooth output. Eight distinct pipeline differences were identified. The root cause is that the replicad extractor uses `GeomLib::NormEstim` (via `ComputeNormals`) which stores normals in `Poly_Triangulation` as Float32 intermediates, while the OCCT GLTF writer computes normals on-the-fly via `BRepLProp_SLProps` in full double precision — a fundamentally different algorithm with different tolerance semantics and no intermediate quantization. Additionally, tessellation parameter defaults differ by 100x (linear) and 30x (angular), and the extractor omits `BRepTools::Clean` before meshing.

## Problem Statement

The DNA helix model rendered with the replicad kernel (v8.44, post-R6 fix) shows visible face-boundary seams on the swept helix strands. The same model rendered with the OpenCASCADE kernel produces perfectly smooth surfaces. Both kernels process the same underlying OCCT geometry (`BRepMesh_IncrementalMesh` → GLTF), but through different normal computation and GLTF construction pipelines.

## Methodology

1. Read the full C++ mesh extractor in `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` (lines 346–469)
2. Read `RWGltf_CafWriter.cxx` (`saveNormals`, `writeBinData`) and `RWMesh_FaceIterator.cxx`/`.hxx` (`initFace`, `normal`, `NormalTransformed`) from OCCT rc5
3. Compared the normal computation algorithms: `GeomLib::NormEstim` (used by `ComputeNormals`) vs `BRepLProp_SLProps::Normal()` (used by OCCT writer), tracing through `CSLib::Normal` overloads
4. Traced tessellation parameters from UI (cad machine) through kernel worker to each kernel's `createGeometry`
5. Compared GLTF construction: `glb-writer.ts` (replicad) vs `RWGltf_CafWriter` (OCCT)
6. Verified `BRepMesh_IncrementalMesh` does NOT compute normals (confirmed in `TKMesh/BRepMesh/` sources)

## Findings

### Finding 1: Normal computation uses fundamentally different algorithms

The OCCT GLTF writer and our C++ extractor compute surface normals through entirely different code paths, despite both targeting "analytic surface normals from UV coordinates."

**Our extractor** (`ReplicadMeshExtractor::extract`):

```
BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)
  → Geom_Surface from BRep_Tool::Surface(locationStrippedFace)
  → For each node: GeomLib::NormEstim(surface, UVNode, Precision::Confusion(), normal)
    → D1(u,v) → if |DU|² ≥ tol² AND |DV|² ≥ tol² → DU×DV
    → Else: D2 + CSLib::Normal Taylor expansion + cone apex heuristic
    → If return > 1: Poly_Connect triangle averaging fallback
  → Stores in Poly_Triangulation as NCollection_Vec3<float>
```

**OCCT GLTF writer** (`RWMesh_FaceIterator::normal`):

```
BRepLProp_SLProps (initialized with BRepAdaptor_Surface on locationStrippedFace)
  → For each node: SetParameters(U, V) → IsNormalDefined()
  → CSLib::Normal(D1U, D1V, linTol, status, dir)
    → sin²(angle) = |DU×DV|² / (|DU|²·|DV|²) test
    → If sin² < tol² → undefined (falls back to gp::DZ)
  → Normal computed on-the-fly in double precision, never stored
```

| Aspect                | Our extractor (`NormEstim`)                                 | OCCT writer (`SLProps`)                    |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Surface API           | Raw `Geom_Surface`                                          | `BRepAdaptor_Surface`                      |
| Degeneracy test       | `\|DU\|² < tol²` or `\|DV\|² < tol²` (derivative magnitude) | `sin²(angle) < tol²` (tangent parallelism) |
| Degenerate recovery   | D2 + Taylor + cone heuristic → return 1                     | None — `IsNormalDefined() = false`         |
| Hard failure fallback | Triangle averaging via `Poly_Connect`                       | `gp::DZ()` (fixed Z direction)             |
| Storage               | `Poly_Triangulation::SetNormal` (Float32)                   | On-the-fly (double precision)              |

The different degeneracy tests can trigger on different surface points. A point with one short tangent vector but clear normal triggers `NormEstim` D2 path (but not `SLProps` failure). A point with adequate tangents but near-parallel directions triggers `SLProps` (but not `NormEstim`'s primary branch).

### Finding 2: Intermediate Float32 quantization in extractor pipeline

The normal data flow through each pipeline differs in precision:

**Our extractor** (4 precision conversions):

```
Surface D1 (double) → GeomLib::NormEstim (double) → gp_Dir (double)
  → Poly_Triangulation::SetNormal (Float32 storage)     ← QUANTIZATION
  → tri->Normal() reads NCollection_Vec3<float> (Float32)
  → gp_Dir constructor (Float32 → double)
  → d.Transformed(trsf) (double)
  → static_cast<float>(d.X()) (double → Float32 output)  ← FINAL CAST
```

**OCCT writer** (1 precision conversion):

```
Surface D1 (double) → CSLib::Normal (double) → gp_Dir (double)
  → NormalTransformed applies trsf (double)
  → NCollection_Vec3<float> output (double → Float32)     ← SINGLE CAST
```

The extra Float32 intermediate step introduces up to ~6e-8 quantization error per component. While individually small, this error accumulates differently for each face's normal computation — two adjacent faces evaluating mathematically identical normals at a shared edge vertex can produce Float32 representations that differ by 1–2 ULPs after the intermediate quantization, creating visible seams under grazing-angle lighting.

### Finding 3: Tessellation parameter defaults differ by 100x

Both kernels receive `tessellation = undefined` from the UI (the cad machine does not pass tessellation parameters). Each kernel uses its own defaults:

| Parameter          | OpenCASCADE kernel | Replicad kernel | Ratio      |
| ------------------ | ------------------ | --------------- | ---------- |
| `linearTolerance`  | 0.1                | 0.001           | 100× finer |
| `angularTolerance` | 30° (0.524 rad)    | 1° (0.017 rad)  | 30× finer  |

Source — OpenCASCADE kernel (`opencascade.kernel.ts:348–349`):

```typescript
const linearTolerance = tessellation?.linearTolerance ?? 0.1;
const angularTolerance = tessellation?.angularTolerance ?? 30;
```

Source — Replicad kernel (`render-output.ts:116–119`):

```typescript
const defaultPreviewTessellation: Tessellation = {
  linearTolerance: 0.001,
  angularTolerance: 1,
};
```

The replicad kernel produces dramatically more triangles (~100–1000× for curved surfaces). While finer tessellation does not degrade normal quality (normals come from surface evaluation, not mesh density), it creates more face-boundary vertices where quantization-induced seams can appear.

### Finding 4: Missing `BRepTools::Clean` before meshing

| Step  | OpenCASCADE kernel                       | Our C++ extractor                      |
| ----- | ---------------------------------------- | -------------------------------------- |
| Clean | `oc.BRepTools.Clean(entry.shape, false)` | _(not called)_                         |
| Mesh  | `new oc.BRepMesh_IncrementalMesh(...)`   | `BRepMesh_IncrementalMesh mesher(...)` |

`BRepTools::Clean` removes any existing triangulation from the shape. Without it, `BRepMesh_IncrementalMesh` may reuse a stale triangulation if it meets the requested tolerance. A stale triangulation might have normals from a previous `ComputeNormals` call — and since `ComputeNormals` exits early when `HasNormals() == true`, our extractor would read potentially incorrect normals from an earlier computation with different parameters.

For freshly-created shapes (first render), this is benign. For re-renders with different tessellation parameters (e.g., user adjusting quality), this can produce incorrect normals.

### Finding 5: Face orientation check differs from OCCT

Our extractor:

```cpp
bool isReversed = (face.Orientation() != TopAbs_FORWARD);
```

OCCT writer (`RWMesh_FaceIterator.hxx:122`):

```cpp
if (myFace.Orientation() == TopAbs_REVERSED) { aNorm.Reverse(); }
```

Our check catches `TopAbs_INTERNAL` and `TopAbs_EXTERNAL` in addition to `TopAbs_REVERSED`. For standard B-Rep shapes from sweep/boolean operations, faces only have `FORWARD` or `REVERSED` orientation, so this difference is typically benign. But it is semantically incorrect — `INTERNAL`/`EXTERNAL` faces should not have their normals reversed.

### Finding 6: No mirrored transform handling

OCCT writer handles mirrored transforms (negative determinant location transformations) for triangle winding:

```cpp
myIsMirrored = (myTrsf.VectorialPart().Determinant() < 0.0);
// ...
if ((myFace.Orientation() == TopAbs_REVERSED) ^ myIsMirrored) {
    swap vertices 2 and 3   // XOR: reverse + mirror cancel out
}
```

Our extractor only checks face orientation:

```cpp
if (isReversed) {
    int tmp = n1; n1 = n2; n2 = tmp;
}
```

For shapes with mirrored location transforms (e.g., from symmetry operations), the triangle winding would be incorrect, causing backface culling artifacts or inverted shading. The DNA helix model uses a 180° rotation (determinant +1, not mirrored), so this does not affect the current model but is a correctness gap.

### Finding 7: GLTF structure differs (one primitive per shape vs per face)

| Aspect         | OCCT writer                      | Our pipeline                                          |
| -------------- | -------------------------------- | ----------------------------------------------------- |
| Structure      | One GLTF primitive per BRep face | One GLTF primitive per shape (all faces concatenated) |
| Vertex sharing | None (per-face vertex blocks)    | None (per-face vertex blocks via `vertexOffset`)      |
| Normal sharing | None (per-face normals)          | None (per-face normals)                               |
| Material       | Per-face styling                 | Per-shape color                                       |

Both approaches produce duplicated vertices at face boundaries with no cross-face vertex welding. The structural difference does not cause visual artifacts — GLTF renderers treat duplicated vertices identically regardless of primitive grouping. Verified: neither writer performs vertex merging, `Poly_MergeNodesTool` is not used by the GLTF writer, and `BRepLib::EnsureNormalConsistency` is not called.

### Finding 8: Coordinate system conversion approaches differ

**Our pipeline** (JavaScript post-processing in `common.ts`):

```typescript
// Vertex: Z-up mm → Y-up meters
[x / 1000, z / 1000, -y / 1000][
  // Normal: rotation only (no scaling)
  (x, z, -y)
];
```

**OCCT writer** (C++ via `RWMesh_CoordinateSystemConverter`):

```typescript
converter.SetInputLengthUnit(0.001);
converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup);
converter.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_glTF);
```

Both apply the same mathematical transformation (Z-up → Y-up rotation + mm→m scaling). The OCCT converter handles this in C++ during the write pass; our pipeline applies it in JavaScript after extracting the mesh data. The transformations are equivalent and should not cause visual differences.

## Recommendations

| #   | Action                                                     | Priority | Effort | Impact                                                                              | Status      |
| --- | ---------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------- | ----------- |
| R1  | Switch to `BRepLProp_SLProps` on-the-fly normal evaluation | P0       | Medium | High — eliminates intermediate Float32 quantization and matches OCCT writer exactly | IMPLEMENTED |
| R2  | Add `BRepTools::Clean` before `BRepMesh_IncrementalMesh`   | P0       | Low    | Medium — prevents stale triangulation reuse                                         | IMPLEMENTED |
| R3  | Align tessellation defaults with OpenCASCADE kernel        | P1       | Low    | Medium — reduces unnecessary mesh density and face-boundary vertices                | IMPLEMENTED |
| R4  | Fix face orientation check to `== TopAbs_REVERSED`         | P1       | Low    | Low — correctness fix, unlikely to affect current models                            | IMPLEMENTED |
| R5  | Add mirrored transform handling for triangle winding       | P2       | Low    | Low — correctness for mirrored shapes, not triggered by current model               | IMPLEMENTED |

All 5 recommendations implemented in replicad-opencascadejs v0.21.0-v8.45. Findings F7 (GLTF structure) and F8 (coordinate conversion) confirmed as requiring no action — both verified mathematically equivalent. All 1440 runtime tests pass including the 4 Normal consistency tests.

### R1: Switch to `BRepLProp_SLProps` on-the-fly evaluation

Replace `BRepLib_ToolTriangulatedShape::ComputeNormals` with direct `BRepLProp_SLProps` evaluation in the C++ extractor. This matches the OCCT GLTF writer exactly:

```cpp
// In ReplicadMeshExtractor::extract, replace the normal block:
if (!skipNormals) {
    // Match OCCT RWMesh_FaceIterator::initFace() + normal() exactly
    TopoDS_Face faceFwd = TopoDS::Face(face.Located(TopLoc_Location()));
    BRepAdaptor_Surface adaptor(faceFwd, Standard_False);
    BRepLProp_SLProps slProps(0, Precision::Confusion());
    slProps.SetSurface(adaptor);

    for (int i = 1; i <= nbNodes; i++) {
        gp_Dir d(0, 0, 1);
        if (tri->HasUVNodes()) {
            gp_Pnt2d uv = tri->UVNode(i);
            slProps.SetParameters(uv.X(), uv.Y());
            if (slProps.IsNormalDefined()) {
                d = slProps.Normal();
            }
        }
        d.Transform(trsf);
        if (face.Orientation() == TopAbs_REVERSED) {
            d.Reverse();
        }
        int base = (vertexOffset + i - 1) * 3;
        result.normalsPtr_[base + 0] = static_cast<float>(d.X());
        result.normalsPtr_[base + 1] = static_cast<float>(d.Y());
        result.normalsPtr_[base + 2] = static_cast<float>(d.Z());
    }
}
```

Required WASM build additions:

```yaml
additionalCppCode: |
  #include <BRepLProp_SLProps.hxx>
  #include <BRepAdaptor_Surface.hxx>
```

Both `BRepLProp_SLProps` and `BRepAdaptor_Surface` are already in the replicad bindings list (`custom_build_single.yml`), so they are compiled into the WASM module. The `#include` directives make them available in the `additionalCppCode` block.

Benefits over the current approach:

- Eliminates intermediate Float32 storage (no `Poly_Triangulation` normal round-trip)
- Uses `BRepAdaptor_Surface` (proper face-based evaluation, same as OCCT writer)
- Uses `CSLib::Normal` tolerance semantics (sin² test, same as OCCT writer)
- Applies transform and orientation in the same order as `NormalTransformed`
- Single Float32 cast at the final output (matches OCCT writer precision)

### R2: Add `BRepTools::Clean`

```cpp
// In ReplicadMeshExtractor::extract, before BRepMesh_IncrementalMesh:
BRepTools::Clean(shape, Standard_False);
BRepMesh_IncrementalMesh mesher(shape, tolerance, Standard_False, angularTolerance, Standard_False);
```

Already `#include`d via the bindings list (`BRepTools` is a bound symbol).

### R3: Align tessellation defaults

Update `render-output.ts` to match the OpenCASCADE kernel defaults:

```typescript
const defaultPreviewTessellation: Tessellation = {
  linearTolerance: 0.1, // was 0.001 (100× coarser, matches OCCT)
  angularTolerance: 30, // was 1 (30× coarser, matches OCCT)
};
```

This reduces mesh density to match the OpenCASCADE kernel, improving render performance and reducing the number of face-boundary vertices where seams can appear. The visual quality remains high because the normals are surface-analytic (independent of mesh density).

### R4: Fix orientation check

```cpp
// Replace:
bool isReversed = (face.Orientation() != TopAbs_FORWARD);
// With:
bool isReversed = (face.Orientation() == TopAbs_REVERSED);
```

### R5: Add mirrored transform handling

```cpp
bool isMirrored = (trsf.VectorialPart().IsNegative());
// For triangle winding:
if (isReversed ^ isMirrored) {
    int tmp = n1; n1 = n2; n2 = tmp;
}
```

## Code Examples

### Current pipeline (remaining artifacts)

```
ReplicadMeshExtractor::extract()
  BRepMesh_IncrementalMesh(shape, 0.001, false, 0.017, false)  ← very fine mesh
  Per face:
    BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri)
      → GeomLib::NormEstim(Geom_Surface, UV, 1e-7, normal)     ← raw surface API
      → Stores in Poly_Triangulation as Float32                 ← QUANTIZATION
    Read tri->Normal(i) → gp_Dir (Float32→double)              ← PRECISION LOSS
    d.Transformed(trsf) → static_cast<float>                   ← double→Float32
```

### Proposed pipeline (matches OCCT writer)

```
ReplicadMeshExtractor::extract()
  BRepTools::Clean(shape, false)                                ← ensures fresh mesh
  BRepMesh_IncrementalMesh(shape, 0.1, false, 0.524, false)    ← aligned defaults
  Per face:
    BRepAdaptor_Surface adaptor(faceFwd)
    BRepLProp_SLProps slProps(0, Precision::Confusion())
    slProps.SetSurface(adaptor)                                 ← face-based adaptor
    Per node:
      slProps.SetParameters(UV) → slProps.Normal()              ← double precision
      d.Transform(trsf)                                         ← double precision
      if (REVERSED) d.Reverse()                                 ← exact OCCT logic
      static_cast<float>(d.X())                                 ← SINGLE Float32 cast
```

### OCCT GLTF writer (reference, produces smooth output)

```
RWGltf_CafWriter::Perform()
  BRepMesh_IncrementalMesh(shape, 0.1, false, 0.524, false)
  RWMesh_FaceIterator per face:
    initFace() → HasNormals()=false, HasUVNodes()=true
    BRepAdaptor_Surface adaptor(faceFwd)
    BRepLProp_SLProps slProps(0, Precision::Confusion())
    Per node:
      slProps.SetParameters(UV) → slProps.Normal()              ← double precision
      NormalTransformed: d.Transform(trsf)                      ← double precision
      if (REVERSED) d.Reverse()
      NCollection_Vec3<float> output                            ← SINGLE Float32 cast
```

## Diagrams

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Normal Computation Pipeline Comparison               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  CURRENT (ReplicadMeshExtractor)                                        │
│  ┌──────────┐   ┌──────────────┐   ┌─────────┐   ┌──────┐   ┌───────┐ │
│  │Geom_     │──▶│GeomLib::     │──▶│Poly_Tri │──▶│Read  │──▶│Output │ │
│  │Surface   │   │NormEstim     │   │SetNormal│   │Normal│   │Float32│ │
│  │D1(u,v)   │   │(double)      │   │(Float32)│   │(f→d) │   │       │ │
│  └──────────┘   └──────────────┘   └─────────┘   └──────┘   └───────┘ │
│       ▲              ▲                  ▲             ▲          ▲      │
│       │              │                  │             │          │      │
│    raw surf    D1×D1 + D2       QUANTIZATION    precision    final     │
│    (no face    fallback +        step loses     loss from    cast      │
│    adaptor)    Poly_Connect      precision      float→dbl             │
│                averaging                                               │
│                                                                         │
│  PROPOSED / OCCT WRITER                                                 │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────┐   ┌───────┐        │
│  │BRepAdapt │──▶│BRepLProp_    │──▶│Transform +  │──▶│Output │        │
│  │Surface   │   │SLProps       │   │Reverse      │   │Float32│        │
│  │D1(u,v)   │   │Normal()      │   │(double)     │   │       │        │
│  └──────────┘   └──────────────┘   └─────────────┘   └───────┘        │
│       ▲              ▲                   ▲                ▲             │
│    face-based   CSLib::Normal      all double         SINGLE           │
│    adaptor      sin² test          precision           cast            │
│                 (no fallback)                                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## References

- Prior investigation: `docs/research/replicad-normal-smoothing-pipeline.md`
- OCCT `RWGltf_CafWriter.cxx`: `repos/OCCT/src/DataExchange/TKDEGLTF/RWGltf/RWGltf_CafWriter.cxx`
- OCCT `RWMesh_FaceIterator`: `repos/OCCT/src/DataExchange/TKRWMesh/RWMesh/RWMesh_FaceIterator.cxx` and `.hxx`
- OCCT `GeomLib::NormEstim`: `repos/OCCT/src/ModelingData/TKGeomBase/GeomLib/GeomLib.cxx` (line 2451+)
- OCCT `BRepLProp_SLProps`: `repos/OCCT/src/ModelingData/TKBRep/BRepLProp/BRepLProp_SLProps.hxx`
- OCCT `CSLib::Normal`: `repos/OCCT/src/FoundationClasses/TKMath/CSLib/CSLib.cxx` (two-tangent overload, line 45–79)
- OCCT `BRepLib_ToolTriangulatedShape::ComputeNormals`: `repos/OCCT/src/ModelingAlgorithms/TKTopAlgo/BRepLib/BRepLib_ToolTriangulatedShape.cxx`
- OCCT `Poly_Triangulation::HasNormals`: `repos/OCCT/src/FoundationClasses/TKMath/Poly/Poly_Triangulation.hxx` (line 140)
- C++ extractor: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` (lines 346–469)
- Replicad mesh: `repos/replicad/packages/replicad/src/shapes.ts` (`mesh()`, `meshEdges()`)
- GLB writer: `packages/runtime/src/utils/glb-writer.ts`
- Coordinate transforms: `packages/runtime/src/framework/common.ts` (`transformVertexArray`, `transformNormalArray`)
- Tessellation defaults: `packages/runtime/src/kernels/replicad/utils/render-output.ts` (line 116–119)
- OCCT kernel defaults: `packages/runtime/src/kernels/opencascade/opencascade.kernel.ts` (line 348–349)
