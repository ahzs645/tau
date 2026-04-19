---
title: 'BRep Edge Mesh Regression'
description: 'Root cause analysis of missing BRep edges after rewriting meshEdges from JS to WASM C++'
status: draft
created: '2026-04-14'
updated: '2026-04-14'
category: investigation
related:
  - docs/research/per-shape-pbr-appearance-v2.md
---

# BRep Edge Mesh Regression

Root cause analysis of why BRep edges are no longer rendering consistently after the `meshEdges` implementation was rewritten from JavaScript to WASM C++ (`ReplicadEdgeMeshExtractor`).

## Executive Summary

The rewrite of `meshEdges()` from JS to C++ introduced a **premature edge deduplication bug** that silently drops edges. In the original JS, an edge is marked as "recorded" only **after** successful geometry extraction. In the C++ rewrite, edges are added to `seenEdges` **before** checking whether their polygon-on-triangulation is available, permanently blocking both the face-polygon and curve-tessellation fallback paths. Additionally, the C++ code calls `BRepTools::Clean` inside the face mesh extractor (`ReplicadMeshExtractor`), which destroys any pre-existing triangulations before `meshEdges` runs, creating a dependency ordering issue that can leave some faces without valid `PolygonOnTriangulation` for their edges.

## Problem Statement

After moving the edge mesh extraction from inline JS (`shape.meshEdges()`) to a C++ WASM class (`ReplicadEdgeMeshExtractor` in `additionalCppCode`), interior edges on shapes like a hollow box tray no longer appear. The exterior edges render correctly, but edges on concave interior faces (fillets, inner walls) are missing.

**Before** (production — JS `meshEdges`): All edges visible including interior fillet edges.

**After** (localhost — C++ `ReplicadEdgeMeshExtractor`): Interior edges missing.

## Methodology

Line-by-line comparison of the original JS implementation (`git show 959b405^:packages/replicad/src/shapes.ts`) against the current C++ implementation in `custom_build_single.yml`, tracing the edge lifecycle through both code paths.

## Findings

### Finding 1: Premature `seenEdges.Add()` Drops Edges (Primary Bug)

The **original JS** implementation marks edges as recorded only **after** successful extraction:

```javascript
// JS: edge added to recordedEdges AFTER successful polygon extraction
for (const edge of face.edges) {
  if (recordedEdges.has(edge.hashCode)) continue;
  // ↓ NOT added to recordedEdges yet

  const polygon = oc.BRep_Tool.PolygonOnTriangulation(edge.wrapped, triangulation, edgeLoc);
  if (!polygon || polygon.NbNodes() === 0) continue;
  // ↓ polygon is valid, extract geometry...

  done(edge.hashCode); // ← NOW added to recordedEdges
}
```

The **new C++** adds edges to `seenEdges` **immediately**, before polygon validation:

```cpp
// C++: edge added to seenEdges BEFORE polygon check
for (TopExp_Explorer edgeEx(face, TopAbs_EDGE); edgeEx.More(); edgeEx.Next()) {
    const TopoDS_Edge& edge = TopoDS::Edge(edgeEx.Current());
    if (seenEdges.Contains(edge)) continue;
    seenEdges.Add(edge);  // ← PREMATURE: marked as seen

    Handle(Poly_PolygonOnTriangulation) polygon =
        BRep_Tool::PolygonOnTriangulation(edge, tri, edgeLoc);
    if (polygon.IsNull()) continue;  // ← Edge is LOST: already in seenEdges
    // ...
}
```

**Consequence**: When an edge's polygon is null on the first face it's encountered (e.g. face A has no polygon for a shared edge), the edge is permanently marked as "seen". It will be skipped when face B is processed (even if face B has a valid polygon for it), AND it will be skipped in Pass B (curve tessellation fallback). The edge is silently dropped.

This bug exists in BOTH passes of the two-pass structure (counting pass lines 540–565 and extraction pass lines 604–648).

### Finding 2: `BRepTools::Clean` in Face Mesher Creates Ordering Dependency

The face mesh extractor (`ReplicadMeshExtractor`) calls `BRepTools::Clean` before meshing:

```cpp
// ReplicadMeshExtractor::extract (line 358)
BRepTools::Clean(shape, Standard_False);  // Destroys ALL existing triangulations
BRepMesh_IncrementalMesh mesher(shape, tolerance, ...);  // Creates fresh ones
```

Then the edge extractor runs and calls `BRepMesh_IncrementalMesh` again:

```cpp
// ReplicadEdgeMeshExtractor::extract (line 538)
BRepMesh_IncrementalMesh mesher(shape, tolerance, ...);  // May be no-op if tolerances match
```

If `BRepMesh_IncrementalMesh` was already run with the same tolerances, the second call is a no-op — it reuses the existing triangulations. But those triangulations were created by the face mesher's run, and **not all faces may have valid `PolygonOnTriangulation` for every edge** depending on OCCT's internal meshing behavior after a `Clean`.

In the original JS, `_mesh()` was called separately (and prior to `meshEdges`), but the JS `meshEdges` re-traversed the shape's already-meshed state. No `Clean` was called between the two operations. The WASM rewrite introduced `Clean` into the face extraction, which may affect subsequent edge polygon availability.

### Finding 3: Deduplication Key Difference (Minor)

| Aspect          | JS (original)                                                            | C++ (new)                                                 |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| **Key**         | `edge.hashCode` (numeric hash)                                           | `TopTools_ShapeMapHasher` (shape identity via `IsSame()`) |
| **Collisions**  | Possible hash collisions (two different edges → same hash → one dropped) | No collisions (exact shape comparison)                    |
| **Orientation** | Hash may differ by orientation                                           | `IsSame()` ignores orientation                            |

This difference is **unlikely** to cause the regression but could produce subtly different deduplication in edge cases.

### Finding 4: Pass B Transform Discrepancy (Minor)

In Pass B (curve tessellation fallback), there is a transform handling difference:

| Aspect        | JS (original)                                                | C++ (new)                         |
| ------------- | ------------------------------------------------------------ | --------------------------------- |
| **Transform** | `tangDef.Value(j+1).Transformed(aLocation.Transformation())` | `tangDef.Value(j)` (no transform) |

The JS applies the location transform from `BRep_Tool.Triangulation`. However, `aLocation` is reused from the last face iteration, making the JS behavior coincidentally correct only for shapes with identity locations. The C++ behavior is actually more correct here: `BRepAdaptor_Curve` already accounts for the edge's own location. This is **not** the cause of the regression but is worth noting.

## Recommendations

| #   | Action                                                                                                                                                                                                | Priority | Effort | Impact |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | **Fix premature `seenEdges.Add()`** — move the `seenEdges.Add(edge)` call AFTER the polygon null check in both the counting and extraction passes                                                     | P0       | Low    | High   |
| R2  | **Restructure to match JS pattern** — only add edge to `seenEdges` after successful geometry extraction (polygon or curve)                                                                            | P0       | Low    | High   |
| R3  | **Consider removing `BRepTools::Clean` from `ReplicadMeshExtractor`** or ensuring the edge extractor does not depend on pre-existing triangulations from a separate `Clean` + `IncrementalMesh` cycle | P1       | Medium | Medium |
| R4  | **Add regression test** — hollow box with fillets, verify inner edge count matches outer edge count                                                                                                   | P1       | Medium | Medium |

## Code Examples

### R1/R2: Fix for `ReplicadEdgeMeshExtractor` (both passes)

The fix requires moving `seenEdges.Add(edge)` to AFTER the polygon null check. Apply to both the counting pass (lines ~551–564) and extraction pass (lines ~610–648):

```cpp
// COUNTING PASS — fix
for (TopExp_Explorer edgeEx(face, TopAbs_EDGE); edgeEx.More(); edgeEx.Next()) {
    const TopoDS_Edge& edge = TopoDS::Edge(edgeEx.Current());
    if (seenEdges.Contains(edge)) continue;
    // DO NOT add to seenEdges here

    TopLoc_Location edgeLoc;
    Handle(Poly_PolygonOnTriangulation) polygon =
        BRep_Tool::PolygonOnTriangulation(edge, tri, edgeLoc);
    if (polygon.IsNull()) continue;  // Edge NOT marked — can still be found on another face or in Pass B

    seenEdges.Add(edge);  // ← Only mark as seen AFTER valid polygon confirmed

    int nNodes = polygon->Nodes().Length();
    if (nNodes < 2) continue;
    totalSegments += (nNodes - 1);
    totalEdges++;
}
```

Same fix for the extraction pass (lines ~610–648).

## Diagrams

### Edge Lifecycle: JS vs C++

```
                    JS (correct)                    C++ (buggy)
                    ============                    ===========

Face A has edge E   ─→ check polygon               ─→ check polygon
with null polygon      polygon = null                  seenEdges.Add(E)  ← PREMATURE
                       skip (E NOT recorded)           polygon = null
                       │                               skip
                       │                               │
Face B has edge E   ─→ E not in recordedEdges       ─→ E IS in seenEdges
with valid polygon     check polygon                   SKIP (edge LOST!)
                       polygon = valid                 │
                       extract geometry                │
                       recordedEdges.add(E)            │
                       ✓ Edge rendered                 │
                                                       │
Pass B (curves)     ─→ (not needed, already done)   ─→ E IS in seenEdges
                                                       SKIP (edge LOST!)
                                                       ✗ Edge MISSING
```

## References

- Original JS implementation: `git show 959b405^:packages/replicad/src/shapes.ts` (lines 394–489)
- Current C++ implementation: `repos/replicad/packages/replicad-opencascadejs/build-config/custom_build_single.yml` (lines 531–684)
- Face mesh extractor: same YAML file, lines 350–496
- Tau runtime edge pipeline: `packages/runtime/src/kernels/replicad/utils/render-output.ts` (lines 155–191)
