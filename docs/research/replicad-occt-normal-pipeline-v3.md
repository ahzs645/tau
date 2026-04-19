---
title: 'Replicad vs OCCT Normal Pipeline Trace — Phase 3'
description: 'End-to-end pipeline trace comparing replicad and OCCT GLTF normal computation to identify remaining visual artifacts'
status: draft
created: '2026-04-10'
updated: '2026-04-10'
category: investigation
related:
  - docs/research/replicad-occt-gltf-pipeline-delta.md
  - docs/research/replicad-normal-smoothing-pipeline.md
---

# Replicad vs OCCT Normal Pipeline Trace — Phase 3

End-to-end trace of both rendering pipelines to identify remaining discrepancies causing visible "lumpy surfaces" on helix strands and "seam discontinuities" on cylinder rungs in the replicad kernel, despite Phase 2 implementing all eight identified pipeline deltas.

## Executive Summary

After Phase 2 aligned the replicad C++ mesh extractor with OCCT's `RWGltf_CafWriter` (BRepLProp_SLProps normals, face orientation handling, tessellation defaults, mesh cleanup), visible artifacts persist. A comprehensive end-to-end trace of both pipelines — from shape meshing through GLTF construction to Three.js rendering — reveals that the C++ normal computation is now **semantically identical** between both paths. The remaining artifacts stem from two root causes:

1. **The viewer uses MeshMatcapMaterial** — matcap rendering maps view-space normals directly to a matcap texture, amplifying even sub-degree normal differences that would be invisible with PBR materials.
2. **The replicad C++ extractor uses `face.Located(TopLoc_Location())` instead of OCCT's `face.Oriented(TopAbs_FORWARD)` + `Location(identity)`** — while confirmed NOT to affect `BRepAdaptor_Surface::D1` evaluation, this misalignment is the sole remaining code-level deviation from the OCCT writer's face setup, and should be corrected for parity.
3. **The nuclear fix**: use OCCT's native `RWGltf_CafWriter` directly in the replicad kernel (the shapes are already `TopoDS_Shape`), eliminating all custom extraction code and guaranteeing byte-identical GLB output.

## Problem Statement

After Phase 2 implementation (documented in `replicad-occt-gltf-pipeline-delta.md`), the DNA helix model rendered via the replicad kernel still shows:

- **Lumpy/faceted surfaces** on the blue helix strands (swept helix geometry)
- **Visible seam discontinuities** on the yellow/green cylindrical rungs (simple cylinder primitives)

The OCCT kernel rendering of the same logical geometry is perfectly smooth. Both use the same Three.js viewer.

## Methodology

1. Read and compared the full OCCT source code for `RWMesh_FaceIterator` (normal computation), `RWGltf_CafWriter` (GLB writing), `BRepAdaptor_Surface` (surface evaluation), and `GeomLProp_SLPropsBase` (normal direction from D1×D1)
2. Read and compared the replicad `ReplicadMeshExtractor` C++ code, `shapes.ts` mesh extraction, `replicad-to-gltf.ts` conversion, `common.ts` transforms, and `glb-writer.ts` binary construction
3. Traced data types and precision through each step (Float64→Float32 conversions, coordinate rotations)
4. Verified the Three.js viewer rendering path (`GltfMesh`, `applyMatcap`, `MeshMatcapMaterial`)
5. Compared GLTF material properties between both pipelines

## Findings

### Finding 1: C++ Normal Computation Is Semantically Identical

Both pipelines now use the same algorithm for normal computation. Verified by reading the OCCT source directly:

| Step             | OCCT `RWMesh_FaceIterator`                                  | Replicad `ReplicadMeshExtractor`               | Match? |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------- | ------ |
| Mesher           | `BRepMesh_IncrementalMesh(shape, 0.1, false, 0.524, false)` | Same                                           | Yes    |
| Pre-clean        | `BRepTools::Clean(shape, false)` (in opencascade-mesh.ts)   | `BRepTools::Clean(shape, Standard_False)`      | Yes    |
| SLProps init     | `mySLTool(1, 1e-12)`                                        | `BRepLProp_SLProps slProps(adaptor, 1, 1e-12)` | Yes    |
| UV evaluation    | `mySLTool.SetParameters(anUV.X(), anUV.Y())`                | `slProps.SetParameters(uv.X(), uv.Y())`        | Yes    |
| Normal direction | `CSLib::Normal(D1U, D1V, ...)` = `D1U × D1V`                | Same (via SLProps)                             | Yes    |
| Transform        | `aNorm.Transform(myTrsf)`                                   | `d.Transform(trsf)`                            | Yes    |
| Reverse          | `if (Orientation() == TopAbs_REVERSED) Reverse()`           | `if (isReversed) d.Reverse()`                  | Yes    |
| Winding          | `if (REVERSED ^ mirrored) swap(n2, n3)`                     | `if (isReversed ^ isMirrored) swap(n2, n3)`    | Yes    |

### Finding 2: BRepAdaptor_Surface Does Not Use Face Orientation

Confirmed by reading `BRepAdaptor_Surface::Initialize()` in OCCT v8:

```cpp
void BRepAdaptor_Surface::Initialize(const TopoDS_Face& F, const bool Restriction)
{
  myFace = F;
  TopLoc_Location L;
  const occ::handle<Geom_Surface>& aSurface = BRep_Tool::Surface(F, L);
  if (Restriction) {
    BRepTools::UVBounds(F, umin, umax, vmin, vmax);
    Load(aSurface, umin, umax, vmin, vmax, L.Transformation());
  } else {
    Load(aSurface, L.Transformation());
  }
}
```

The method stores `myFace` but **never reads `myFace.Orientation()`**. The surface and transform loaded into the adaptor are identical regardless of face orientation. `EvalD1` delegates to `GeomAdaptor_TransformedSurface::EvalD1` which only applies `myTrsf` (from location, not orientation).

**Conclusion**: The `Located()` vs `Oriented()` difference does NOT affect D1 derivatives or normal computation.

### Finding 3: Face Setup Method Differs (Code Parity Issue)

Despite Finding 2 proving no functional impact, the code differs:

| Pipeline           | Face forward creation                                     |
| ------------------ | --------------------------------------------------------- |
| OCCT `initFace()`  | `face.Oriented(TopAbs_FORWARD)` then `Location(identity)` |
| Replicad extractor | `face.Located(TopLoc_Location())`                         |

OCCT creates a face with FORWARD orientation and identity location. Our extractor creates a face with identity location but **preserves the original orientation**. This is a code-level deviation that should be aligned for strict parity, even though the D1 path is unaffected.

### Finding 4: Coordinate System Conversion Is Mathematically Identical

| Step                 | OCCT                                                          | Replicad                                               | Match?     |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ---------- |
| Position transform   | `myCSTrsf.TransformPosition()` — mm→m + Z→Y-up                | `transformVertexArray()` — `[x/1000, z/1000, -y/1000]` | Yes        |
| Normal transform     | `myCSTrsf.TransformNormal()` — Z→Y-up via `myNormTrsf * vec4` | `transformNormalArray()` — `[x, z, -y]`                | Yes        |
| Normal normalization | None (rotation preserves unit length)                         | None                                                   | Yes        |
| Precision            | double → Float32 → rotate in Float32                          | double → Float32 → Float64 → rotate → Float32          | Equivalent |

The Z-up → Y-up rotation matrix has only 0 and ±1 entries, making Float32 vs Float64 arithmetic identical.

### Finding 5: GLTF Structure Is Equivalent

| Aspect         | OCCT `RWGltf_CafWriter`                                   | Replicad `writeGlb()`                             |
| -------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Primitives     | Accumulates per-material (multiple faces → one primitive) | Accumulates per-shape (all faces → one primitive) |
| Vertex sharing | Within-face: shared via indices. Between-face: duplicated | Same                                              |
| Index type     | Uint32                                                    | Uint32                                            |
| Normal type    | Float32 (via `NCollection_Vec3<float>`)                   | Float32 (via `Float32Array`)                      |
| Buffer layout  | Non-interleaved (separate position/normal/index views)    | Non-interleaved                                   |

### Finding 6: Both Pipelines Set `doubleSided: true`

OCCT `RWGltf_GltfMaterialMap.cxx` (line 462):

```cpp
if (theStyle.Material().IsNull()
    || theStyle.Material()->FaceCulling() == Graphic3d_TypeOfBackfacingModel_Auto
    || ...) {
  myWriter->Key("doubleSided");
  myWriter->Bool(true);
}
```

When no explicit material face culling is set (our case: we only set `XCAFDoc_ColorSurf`), OCCT defaults to `doubleSided: true`. Our pipeline also uses `doubleSided: true`. No difference.

### Finding 7: OCCT GLTF Writer Uses Default PBR (metallic=1.0, roughness=1.0)

OCCT's writer only writes `metallicFactor`/`roughnessFactor` when they differ from 1.0 or when an explicit PBR material is set. Since we only set `XCAFDoc_ColorSurf` colors (no PBR material), the OCCT GLB omits both fields, defaulting to:

- `metallicFactor`: 1.0 (GLTF spec default)
- `roughnessFactor`: 1.0 (GLTF spec default)

Our replicad pipeline uses `cadMaterialDefaults`: `metallicFactor: 0`, `roughnessFactor: 0.35`.

**This is a significant material property difference** — but it is masked by the viewer's matcap override (Finding 8).

### Finding 8: Viewer Uses MeshMatcapMaterial (Critical for Normal Visibility)

The `GltfMesh` component (`gltf-mesh.tsx`) applies `MeshMatcapMaterial` when matcap mode is enabled (the default rendering mode visible in the screenshot). Matcap replaces all PBR material properties with a direct normal-to-texture lookup:

```typescript
const meshMatcap = new MeshMatcapMaterial({
  matcap: matcapTexture,
  side: DoubleSide,
});
```

**Impact**: Matcap rendering is the **most sensitive** material to normal quality because:

1. View-space normal directly indexes the matcap texture (no diffuse/specular averaging)
2. The matcap texture has a bright specular spot that amplifies sub-degree normal variations
3. Any normal discontinuity between adjacent triangles creates a visible matcap color jump
4. PBR roughness smoothing is absent — every normal error is faithfully visualized

Both pipelines go through the same viewer with the same matcap. Therefore, the **normal data in the replicad GLB is measurably different** from the OCCT GLB.

### Finding 9: Surface Null Check Missing in Extractor

OCCT `initFace()` guards SLProps setup:

```cpp
TopLoc_Location aLoc;
if (!BRep_Tool::Surface(aFaceFwd, aLoc).IsNull()) {
  myFaceAdaptor.Initialize(aFaceFwd, false);
  mySLTool.SetSurface(myFaceAdaptor);
  myHasNormals = true;
}
```

Our extractor unconditionally creates `BRepAdaptor_Surface` and `BRepLProp_SLProps` without checking for a null surface. For faces without surface geometry (e.g., degenerate faces), SLProps evaluation would be undefined.

### Finding 10: Data Precision Path Through JavaScript

The replicad pipeline round-trips mesh data through JavaScript arrays:

```
C++ float → HEAPF32 (Float32) → Array.from() → number[] (Float64) → transform → Float32Array
```

The OCCT pipeline stays entirely in C++/WASM:

```
C++ double → NCollection_Vec3<float> → TransformNormal → write to binary buffer
```

While the Float32→Float64→Float32 round-trip is lossless (Float32 values are exactly representable in Float64), the JavaScript path introduces intermediate `number[]` arrays that are 2× the memory and require an extra copy pass.

## Root Cause Analysis

The C++ normal computation is verified identical between both pipelines. The remaining visual artifacts therefore have **two possible root causes**:

### Cause A: BRep Geometry Differences (Primary Hypothesis)

The replicad API (`sketchHelix`, `sweepSketch`, `makeCylinder`) and the raw OCCT API (`BRepPrimAPI_MakeRevol`, `BRepOffsetAPI_MakePipeShell`, `BRepPrimAPI_MakeCylinder`) may construct **topologically different BRep shapes** even when representing the same logical geometry:

- Different surface types (B-spline from general sweep vs analytic/trimmed surface)
- Different face parameterizations (UV domain)
- Different edge structures and face orientations
- Different behavior under `BRepMesh_IncrementalMesh` (mesh quality varies by surface type)

Since both pipelines use the same `BRepLProp_SLProps` algorithm on different surfaces, the normals can legitimately differ.

**Evidence for this hypothesis**: The cylinder rungs use `BRepPrimAPI_MakeCylinder` in both APIs and should produce identical BRep shapes. If cylinders show artifacts in replicad but not OCCT, it falsifies this hypothesis for cylinders (suggesting a pipeline cause) while potentially confirming it for helices.

### Cause B: Undiscovered Pipeline Difference

Despite thorough tracing, there may be an undiscovered difference in a code path not examined. Potential areas:

- `BRep_Tool::Triangulation` returning different locations for the same face when called from different contexts
- WASM heap memory management affecting data integrity during extraction
- Edge cases in `ReplicadMeshExtractor` copy constructor (move semantics implemented via const_cast)

## Recommendations

| #   | Action                                                                                                                                                                                                                           | Priority | Effort | Impact            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ----------------- |
| R1  | **Use `RWGltf_CafWriter` in the replicad kernel** — the shapes are `TopoDS_Shape`, so pass them through the same XCAF document → CafWriter path as the OCCT kernel. This eliminates ALL extraction code differences in one shot. | P0       | Medium | Critical          |
| R2  | Align face forward creation: use `face.Oriented(TopAbs_FORWARD)` + `Location(identity)` instead of `face.Located(TopLoc_Location())` in `ReplicadMeshExtractor`                                                                  | P1       | Low    | Low               |
| R3  | Add surface null guard before SLProps initialization in `ReplicadMeshExtractor`                                                                                                                                                  | P1       | Low    | Low               |
| R4  | Add diagnostic GLB comparison tool — dump normals from both pipelines for the same shape and compute per-vertex angular delta                                                                                                    | P1       | Medium | High (diagnostic) |
| R5  | Investigate replicad `makeCylinder` BRep structure — verify the resulting `TopoDS_Shape` is byte-identical to `BRepPrimAPI_MakeCylinder` via `BRepTools::Write` comparison                                                       | P1       | Low    | Medium            |

### R1 Detail: Native CafWriter in Replicad Kernel

The replicad-opencascadejs WASM build already includes XCAF tools (`TDocStd_Document`, `XCAFDoc_ShapeTool`, `XCAFDoc_ColorTool`, etc.). Adding `RWGltf_CafWriter` and `RWMesh_CoordinateSystemConverter` would enable the replicad kernel to use the identical GLB writing path as the OCCT kernel:

```typescript
// In replicad kernel createGeometry:
const gltfBlob = meshShapesToGltf(context.openCascade, shapeEntries, {
  linearTolerance,
  angularTolerance: angularTolerance * (Math.PI / 180),
});
```

This approach:

- Eliminates the entire `ReplicadMeshExtractor` C++ class and its JS data extraction
- Eliminates `replicad-to-gltf.ts`, `transformVertexArray`, `transformNormalArray`
- Guarantees byte-identical GLB output between kernels for the same input shapes
- Reduces WASM→JS data transfer (no intermediate array copies)
- Requires adding `RWGltf_CafWriter`, `RWMesh_FaceIterator`, `RWMesh_ShapeIterator`, `RWMesh_CoordinateSystemConverter`, and `RWGltf_GltfMaterialMap` to the replicad-opencascadejs build config
- WASM size increase: estimated 50-100 KB (GLTF writer + dependencies, many of which are already linked via XCAF)

### R2 Detail: Face Forward Alignment

Replace in `custom_build_single.yml`:

```cpp
// Current:
TopoDS_Face faceFwd = TopoDS::Face(face.Located(TopLoc_Location()));

// Aligned with OCCT:
TopoDS_Face faceFwd = TopoDS::Face(face.Oriented(TopAbs_FORWARD));
faceFwd.Location(TopLoc_Location());
```

While Finding 2 proves D1 evaluation is unaffected by orientation, this change achieves exact code parity with the OCCT writer and eliminates `Located()` which serves a subtly different purpose (preserves orientation).

## Code Examples

### OCCT Pipeline (Reference)

```
Shape → BRepTools.Clean → BRepMesh_IncrementalMesh
     → XCAF document + colors → RWGltf_CafWriter.Perform()
     → RWMesh_FaceIterator.NormalTransformed() [per node]
          → BRepLProp_SLProps(adaptor(FORWARD face), 1, 1e-12)
          → Transform(composite_trsf) → Reverse(if REVERSED)
     → myCSTrsf.TransformNormal() [Z-up → Y-up, Float32]
     → Binary GLB
```

### Replicad Pipeline (Current)

```
Shape → ReplicadMeshExtractor.extract():
     → BRepTools::Clean → BRepMesh_IncrementalMesh
     → BRepLProp_SLProps(adaptor(Located face), 1, 1e-12)
     → Transform(trsf) → Reverse(if REVERSED) → Float32 to WASM heap
     → JS: HEAPF32.slice() → Array.from() → number[]
→ transformVertexArray() / transformNormalArray() [Z-up → Y-up, Float64→Float32]
→ writeGlb() [custom JS GLTF writer]
→ Binary GLB
```

### Proposed Unified Pipeline (R1)

```
Shape → meshShapesToGltf() [same as OCCT kernel]:
     → BRepTools.Clean → BRepMesh_IncrementalMesh
     → XCAF document + colors → RWGltf_CafWriter.Perform()
     → Binary GLB [byte-identical to OCCT output for same shapes]
```

## References

- OCCT source: `repos/OCCT/src/DataExchange/TKRWMesh/RWMesh/RWMesh_FaceIterator.cxx`
- OCCT source: `repos/OCCT/src/DataExchange/TKDEGLTF/RWGltf/RWGltf_CafWriter.cxx`
- OCCT source: `repos/OCCT/src/ModelingData/TKBRep/BRepAdaptor/BRepAdaptor_Surface.cxx`
- OCCT source: `repos/OCCT/src/ModelingData/TKGeomBase/GeomLProp/GeomLProp_SurfaceUtils.hxx`
- Replicad extractor: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml`
- Viewer: `apps/ui/app/components/geometry/graphics/three/react/gltf-mesh.tsx`
- Related: `docs/research/replicad-occt-gltf-pipeline-delta.md`
- Related: `docs/research/replicad-normal-smoothing-pipeline.md`
