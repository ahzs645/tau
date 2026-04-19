---
title: '3MF Export Scale, Orientation, and Manifold Regressions'
description: 'Root-cause investigation of unit, coordinate-system, and non-manifold-edge defects in the GLB → 3MF export route, with a generalised audit of every converter-routed format.'
status: active
created: '2026-04-16'
updated: '2026-04-17'
category: investigation
related:
  - docs/research/3mf-activation-status.md
  - docs/research/3mf-assimp-audit.md
  - docs/research/export-pipeline-v6-implementation-audit.md
  - docs/research/export-options-kernel-mismatch.md
  - docs/research/export-option-schema-architecture.md
  - docs/research/unified-export-pipeline-architecture.md
  - docs/research/converter-runtime-consolidation.md
---

# 3MF Export Scale, Orientation, and Manifold Regressions

Root-cause investigation of three concurrent defects observed when exporting a Replicad-produced 100 × 150 × 50 mm hollow box to 3MF and re-importing into Bambu Studio: (1) the model arrives 1000× too small ("scale to mm?" prompt), (2) the model arrives Y-up when Z-up was selected, and (3) the model has 572 non-manifold edges. The native Replicad STL path does not exhibit any of these defects, which lets us isolate the regression to the converter (GLB → assimp → lib3mf) bridge.

## Executive Summary

All three defects originate at the **kernel → transcoder → assimp/lib3mf** boundary, not in lib3mf itself:

1. **Unit (1000×)**: Replicad-to-GLB conversion divides every vertex by 1000 (mm → m, per glTF spec). The Lib3MFBridge writes those vertices verbatim and `lib3mf_model_setunit("millimeter")` only writes an OPC `<model unit="millimeter">` attribute — it does **not** rescale geometry. The 3MF therefore declares millimetre units while carrying metre-magnitude coordinates.
2. **Coordinate system**: `convertReplicadGeometriesToGltf` always emits Y-up (correct per glTF spec). The converter transcoder's 3MF schema only accepts `unit` and `application` — `coordinateSystem` is silently dropped at the edge, so the user's "Z-up" selection in the UI never reaches lib3mf, which writes vertices verbatim. 3MF's spec mandates +Z = build direction.
3. **Non-manifold (572 edges)**: Replicad's `shape.mesh()` produces per-face vertex tables with face-local normals (sharp edge between two faces ⇒ same XYZ, two distinct normals). `aiProcess_JoinIdenticalVertices` only welds vertices when **all** attributes match, so face-boundary vertices are not merged and become explicit duplicates in the 3MF output. STL via Replicad escapes this because slicer STL importers weld by position — 3MF preserves explicit indices.

The same mechanism contaminates every other transcoder-routed format (OBJ, PLY, FBX, DAE, X3D, X, 3DS, USDA, USDZ, STEP-via-assimp). The native Replicad STL/STEP/GLB paths are unaffected because they are kernel-native.

The fix has both a tactical layer (rescale + axis-swap inside the converter transcoder, strip normals before assimp's import in the export direction) and a strategic layer (give the transcoder edge schema first-class `coordinateSystem` + `unit` semantics, plus a kernel hook that skips the scene-graph axis/scale baking when the output will be re-baked downstream).

---

## Table of Contents

1. [Reproduction and Evidence](#1-reproduction-and-evidence)
2. [End-to-End Pipeline Trace](#2-end-to-end-pipeline-trace)
3. [Smoking Gun 1 — Unit Mismatch](#3-smoking-gun-1--unit-mismatch)
4. [Smoking Gun 2 — Coordinate System Drop](#4-smoking-gun-2--coordinate-system-drop)
5. [Smoking Gun 3 — Per-Face Normals Defeat JoinIdenticalVertices](#5-smoking-gun-3--per-face-normals-defeat-joinidenticalvertices)
6. [Why the Native STL Path Works](#6-why-the-native-stl-path-works)
7. [Cross-Format Impact Matrix](#7-cross-format-impact-matrix)
8. [Recommendations](#8-recommendations)
9. [Appendix — Code References](#9-appendix--code-references)

---

## 1. Reproduction and Evidence

### 1.1 Test artefact

Hollow box, parameters: Width 100 mm, Length 150 mm, Height 50 mm, Thickness 2 mm, Corner Radius 5 mm. Authored in TypeScript via the Replicad kernel.

### 1.2 Observed behaviour

| Path                           | Settings (UI)    | Bambu Studio observation                                                                      | Import dialog             | Manifold report            |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------- | ------------------------- | -------------------------- |
| Replicad → STL (native)        | Z-up, mm         | 100 × 150 × 50 footprint, flat on plate                                                       | none                      | clean                      |
| Replicad → 3MF (via converter) | Z-up, millimeter | "object too small, scale to mm?" → after Yes: 100 × 50 × 150, standing tall (height became Y) | "Object too small" prompt | **572 non-manifold edges** |

The two screenshots (img3 vs img5) show the same source geometry rendered identically in Tau but yielding wildly different artefacts when re-imported into Bambu Studio. The STL artefact is dimensionally correct, oriented correctly, and manifold. The 3MF artefact is wrong on all three axes simultaneously.

### 1.3 Working hypothesis

The native STL path is kernel-internal: replicad generates STL bytes directly via `shape.blobSTL()` from BRep (mm, no axis swap, no GLB intermediate). The 3MF path goes through `Replicad GLB intermediate → AssimpExporter → ConvertFileList(..., '3mf', { 3MF_EXPORT_UNIT: 'millimeter' }) → Lib3MFBridge::ExportScene`. Every defect must be introduced somewhere along that second chain.

---

## 2. End-to-End Pipeline Trace

### 2.1 Sequence (3MF case)

```
UI                       kernel-worker                            replicad.kernel              converter.transcoder            converter pkg            assimpjs/exporter            Lib3MFBridge
│                        │                                        │                            │                               │                       │                            │
│ export('3mf', opts) ──▶│                                        │                            │                               │                       │                            │
│                        │ executeExportWithRoute                 │                            │                               │                       │                            │
│                        │ ├─ kernel does NOT support 3mf         │                            │                               │                       │                            │
│                        │ ├─ candidate route: glb → 3mf          │                            │                               │                       │                            │
│                        │ ├─ parse opts via replicad GLB schema  │                            │                               │                       │                            │
│                        │ │  → { tessellation, coordinateSystem }│                            │                               │                       │                            │
│                        │ ├─ exportGeometry(format='glb', opts) ─▶ case 'glb' →                                                │                       │                            │
│                        │ │                                      │ shape.mesh() (mm, Z-up)    │                               │                       │                            │
│                        │ │                                      │ convertReplicadGeometries… │                               │                       │                            │
│                        │ │                                      │ → transformVertexArray     │                               │                       │                            │
│                        │ │                                      │ ── /1000  + Z→Y axis swap ─┼──▶ GLB bytes (m, Y-up)        │                       │                            │
│                        │ ├─ parse opts via 3mf edge schema      │                            │                               │                       │                            │
│                        │ │  → { '3MF_EXPORT_UNIT':'millimeter'} │                            │                               │                       │                            │
│                        │ ├─ transcode(GLB, '3mf', edgeOpts) ───▶│ exportFromGlb ────────────▶│ AssimpExporter.parseAsync ────▶│ ConvertFileList ─────▶│ glTF2Importer (no axis swap)│
│                        │                                        │                            │                               │                       │ ImportFileListByMainFile     │
│                        │                                        │                            │                               │                       │   Triangulate                │
│                        │                                        │                            │                               │                       │   GenUVCoords                │
│                        │                                        │                            │                               │                       │   JoinIdenticalVertices ◄────┤ position+normal+uv match
│                        │                                        │                            │                               │                       │   SortByPType                │
│                        │                                        │                            │                               │                       │ ExportSceneWithOptions ──────▶ Lib3MFBridge::ExportScene
│                        │                                        │                            │                               │                       │                            │   exportToLib3MF
│                        │                                        │                            │                               │                       │                            │     setunit("millimeter")  ← attribute only
│                        │                                        │                            │                               │                       │                            │     vertices verbatim       ← 0.1, 0.15, 0.05 (m)
│                        │                                        │                            │                               │                       │                            │     transforms verbatim     ← Y-up
```

### 2.2 What each step does (concrete files/lines)

| Step                         | File                                                                                      | Behaviour                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.export('3mf', opts)` | `packages/runtime/src/client/runtime-client.ts` (~L722–748)                               | Forwards to worker `exportGeometry`                                                                                                                   |
| Route planning               | `packages/runtime/src/framework/kernel-worker.ts` (`executeExportWithRoute`, ~L2056–2158) | Splits `opts` between source-format Zod (kernel GLB) and edge Zod (transcoder 3MF) and sequentially renders + transcodes                              |
| Replicad GLB export          | `packages/runtime/src/kernels/replicad/replicad.kernel.ts` (case `'glb'`, ~L562–595)      | `coordinateSystem === 'y-up'` rotates BRep before mesh; `'z-up'` skips rotation. Then meshes and calls `convertReplicadGeometriesToGltf`              |
| GLB writer                   | `packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts`                         | Calls `transformVertexArray` for **every** vertex                                                                                                     |
| Vertex transform             | `packages/runtime/src/framework/common.ts` `transformVerticesGltf`                        | `(x, y, z) → (x/1000, z/1000, -y/1000)` — Z-up→Y-up + mm→m                                                                                            |
| Converter edge               | `packages/runtime/src/transcoders/converter/converter-export-options.ts`                  | `threeMfSchema = z.object({ unit, application })` — no `coordinateSystem`                                                                             |
| Converter call               | `packages/runtime/src/transcoders/converter/converter.transcoder.ts` (`transcode`)        | Maps to `{ '3MF_EXPORT_UNIT', '3MF_EXPORT_APPLICATION' }` and calls `exportFromGlb`                                                                   |
| Assimp wrapper               | `packages/converter/src/exporters/assimp.exporter.ts`                                     | `ConvertFileList(fileList, '3mf', exportProperties)` — no flags, no normalisation                                                                     |
| Assimp import flags          | `repos/assimpjs/assimpjs/src/assimpjs.cpp` (`ImportFileListByMainFile`, L11–31)           | `Triangulate \| GenUVCoords \| JoinIdenticalVertices \| SortByPType`                                                                                  |
| Lib3MF bridge export         | `repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp` (`exportToLib3MF`, L196–371)   | Reads `3MF_EXPORT_UNIT`, calls `lib3mf_model_setunit`. Writes `mesh->mVertices[v].x/y/z` verbatim. Applies `aiMatrixToLib3MFTransform` to build items |

---

## 3. Smoking Gun 1 — Unit Mismatch

### 3.1 Where the scale is lost

`packages/runtime/src/framework/common.ts`:

```161:165:packages/runtime/src/framework/common.ts
  const x = vertex[0] / 1000;
  const y = vertex[2] / 1000;
  const z = -vertex[1] / 1000;
```

Replicad's BRep is authored in millimetres (the user types `Width 100`, the runtime treats it as 100 OCCT units = 100 mm). Replicad meshes the BRep into JavaScript arrays with the same magnitudes. `transformVertexArray` then divides every coordinate by 1000 to convert to **metres**, because glTF 2.0 stipulates `1 unit = 1 metre`. This is correct for the live-preview GLB and for any consumer that respects the glTF spec.

### 3.2 What lib3mf does with `unit="millimeter"`

`Lib3MFBridge.cpp`:

```196:225:repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp
void exportToLib3MF(const aiScene *pScene, std::vector<Lib3MF_uint8> &outputBuffer,
                    const ExportProperties *pProperties) {
    Lib3MFHandle model;
    checkResult(lib3mf_createmodel(model.ptr()), nullptr, "Failed to create lib3mf model");

    if (pProperties) {
        std::string unitStr = pProperties->GetPropertyString("3MF_EXPORT_UNIT", "millimeter");
        checkResult(
            lib3mf_model_setunit(model.as<Lib3MF_Model>(), stringToModelUnit(unitStr)),
            model.get(), "Failed to set 3MF model unit"
        );
        ...
```

`lib3mf_model_setunit` writes the `<model unit="millimeter" …>` attribute on the OPC root element. Per the 3MF Core Spec §3.2.1, this attribute is metadata: **vertex coordinates inside `<vertex>` elements are interpreted in that unit**, but lib3mf does not rescale anything you hand it.

```285:310:repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp
        std::vector<Lib3MF::sPosition> vertices(mesh->mNumVertices);
        for (unsigned int v = 0; v < mesh->mNumVertices; ++v) {
            vertices[v].m_Coordinates[0] = mesh->mVertices[v].x;
            vertices[v].m_Coordinates[1] = mesh->mVertices[v].y;
            vertices[v].m_Coordinates[2] = mesh->mVertices[v].z;
        }
```

Vertices are copied verbatim. With our 100 mm input becoming 0.1 (metres in the GLB) and being written into a `unit="millimeter"` 3MF, the resulting file declares the box to be 0.1 × 0.15 × 0.05 mm. Bambu Studio's threshold ("smaller than build plate / typical model size") triggers and prompts "scale to millimeters?" — multiplying by 1000 lands exactly on the user's original 100 × 150 × 50 mm.

### 3.3 Why the user-facing fix isn't "set unit=meter"

Selecting `meter` in the UI would correctly describe the GLB-magnitude vertices, but the 3MF would still be the wrong size in any slicer because slicer build-volumes are millimetre-scale; 0.1 × 0.15 × 0.05 m is "100 × 150 × 50 m of plate space" which slicers reject. The semantics the user expects ("export in millimetres because my source is in millimetres") require the pipeline itself to rescale, not just relabel.

### 3.4 Fix surface area

The conversion divider lives in _one_ function (`transformVerticesGltf`) but is consumed by both the live preview GLB and the converter-intermediate GLB. We cannot simply remove the `/1000` because that would break the live viewer (Three.js scene scaled 1000× would clip and require camera rework). The fix must live in the **converter transcoder boundary**, not in the GLB writer. See R1 in Recommendations.

---

## 4. Smoking Gun 2 — Coordinate System Drop

### 4.1 The schema discontinuity

The replicad GLB export schema:

```43:47:packages/runtime/src/kernels/replicad/replicad.schemas.ts
const occtGlbExportSchema = occtExportTessellationSchema.extend(coordinateSystemSchema.shape);
```

…carries `coordinateSystem: 'y-up' | 'z-up'` (default `z-up`). Inside the kernel, that field controls a pre-mesh BRep rotation:

```566:572:packages/runtime/src/kernels/replicad/replicad.kernel.ts
        const { coordinateSystem } = options;

        const shapes =
          coordinateSystem === 'y-up'
            ? nativeHandle.map((s) => ({ ...s, shape: s.shape.clone().rotate(-90, [0, 0, 0], [1, 0, 0]) }))
            : nativeHandle;
```

For `z-up` (default and the user's selection in img1) **no rotation is applied** — the BRep stays Z-up. Then `convertReplicadGeometriesToGltf` runs `transformVertexArray`, which **always** swaps Z-up → Y-up regardless of the `coordinateSystem` flag. So the GLB is always Y-up; the kernel-level `coordinateSystem` flag effectively chooses between "Y-up GLB" (for `z-up`) and "what was already Y-up gets rotated again then swapped" (for `y-up`). The latter combination is broken; the former is the only path that produces a spec-compliant GLB.

### 4.2 The converter edge schema

```43:54:packages/runtime/src/transcoders/converter/converter-export-options.ts
const threeMfSchema = z.object({
  unit: z
    .enum(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'])
    .default('millimeter')
    .describe('Unit of measurement for the 3MF model coordinates'),
  application: z.string().optional().describe('Creating application metadata (e.g. slicer name and version)'),
});
```

There is no `coordinateSystem` key. When the route planner hands `input.options` to `transcode()`, the user's `coordinateSystem: 'z-up'` is dropped (`safeParse` silently ignores unknown keys, see `kernel-worker.ts` L2114–2126). The converter therefore has no way to know the user wanted Z-up output.

### 4.3 What the assimp + lib3mf chain does to orientation

`assimpjs.cpp` imports the GLB with no `aiProcess_FlipUVs`/`aiProcess_MakeLeftHanded` — the glTF2 importer (`repos/assimpjs/assimp/code/AssetLib/glTF2/glTF2Importer.cpp`) preserves Y-up semantics and does not bake any axis-conversion node into the scene graph. `Lib3MFBridge::exportToLib3MF` writes `mesh->mVertices[v]` and `aiMatrixToLib3MFTransform(transform)` verbatim. The 3MF therefore stores Y-up vertices in a format whose convention is +Z up.

When Bambu loads the file (img3), it interprets +Z as the build direction, so what the user wrote as "height (Z) = 50 mm" lands on the plate as "depth (Z in Bambu) = whatever was Y in the GLB", and the original 50 mm height ends up along Bambu's Y axis. Visually: the box stands on its 100 × 50 mm side instead of lying flat on its 100 × 150 mm footprint.

### 4.4 Why STEP and STL via Replicad already work

Replicad's `case 'step'` and `case 'stl'` apply the BRep rotation **before** `replicad.exportSTEP` / `shape.blobSTL`, and neither writer goes through `convertReplicadGeometriesToGltf`. Default `z-up` keeps the BRep Z-up, the writers emit Z-up, slicers (which assume Z-up for STL/3MF) read it correctly. So the `coordinateSystem` field is honoured for kernel-native formats but lost for converter-routed formats.

---

## 5. Smoking Gun 3 — Per-Face Normals Defeat JoinIdenticalVertices

### 5.1 How replicad meshes a BRep

Replicad's `shape.mesh()` walks every BRep face and asks OCCT for `Poly_Triangulation` per face. If the face has no precomputed normals, replicad calls `Poly_Triangulation::ComputeNormals()`:

```880:886:repos/replicad/packages/replicad/src/shapes.ts
    const normalSign = orient === 'backward' ? -1 : 1;

    if (!tri.HasNormals()) {
      tri.ComputeNormals();
    }
    triangulatedFace.verticesNormals = new Array(nbNodes * 3);
```

`ComputeNormals` is **face-local** — the docstring says "Compute smooth normals by averaging triangle normals" within that triangulation. Replicad does not subsequently call `BRepLib::EnsureNormalConsistency` (which would average normals across smooth edges between adjacent faces). The output mesh therefore has, at every vertex on a sharp edge, **two coincident vertices with different normal vectors** — one belonging to face A, one belonging to face B.

This is the standard CAD-tessellation pattern: it makes the live viewer correctly render a faceted box (sharp edges between faces) without flat-shading every triangle. But it produces topologically open meshes.

### 5.2 What `JoinIdenticalVertices` actually merges

`assimpjs.cpp` enables exactly four post-processing passes:

```14:18:repos/assimpjs/assimpjs/src/assimpjs.cpp
		const aiScene* scene = importer.ReadFile (file.path,
			aiProcess_Triangulate |
			aiProcess_GenUVCoords |
			aiProcess_JoinIdenticalVertices |
			aiProcess_SortByPType);
```

`JoinIdenticalVertices` welds two vertices only when **all** of `position`, `normal`, `tangent`, `bitangent`, `uv0..n`, `color0..n` are bitwise-identical. Since the per-face normals differ at every sharp edge, no face-boundary vertex is ever welded. The 3MF output then carries duplicate vertices on every shared edge, and lib3mf's reader (which Bambu uses) reports each pair of triangles as sharing **non-identical** vertex indices → "non-manifold edge".

For the test box (open hollow box with corner radius), the rough count is:

| Edge family          | Count         | Notes                                                                                                                |
| -------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Outer top rim        | 4 sides       | Sharp 90° between top face and outer wall                                                                            |
| Outer vertical edges | 4 corners     | Where two outer walls meet (filleted into rounded corner faces, so each fillet face has 2 sharp seams to flat walls) |
| Outer bottom rim     | 4 sides       | Sharp 90° between bottom face and outer wall                                                                         |
| Inner cavity edges   | symmetric set | Same families on the cavity side                                                                                     |
| Wall-thickness rim   | 4 sides       | Where outer wall top meets inner wall top                                                                            |

With a tessellation that places ~10–20 segments along each linear edge and several segments per fillet, 572 non-manifold edges is consistent with the per-face-split hypothesis.

### 5.3 Why STL via slicer is immune

STL is a position-only triangle list with no shared vertex indexing. Slicer importers universally weld by spatial position with a tolerance (Bambu/Cura/Prusa/OrcaSlicer all do). After welding, every shared edge is between exactly two triangles → manifold. 3MF mandates explicit indexed vertices; the reader must trust the indices the writer produced. Lib3MFBridge currently does not weld by position before writing.

### 5.4 Two complementary fixes

- **In the export direction**, strip normals from the aiScene before lib3mf write so `JoinIdenticalVertices` (or, better, an explicit `RemoveDuplicateVertices` pass) can merge by position alone. Lib3mf does not need normals — the slicer recomputes them anyway.
- **At the source**, give the kernel an "export-quality mesh" mode that calls OCCT's `BRepLib::EnsureNormalConsistency` so adjacent faces share normals on smooth edges. This narrows the gap but does not close it for genuine sharp edges (which would still split). The export path therefore still needs position-only welding for printable formats.

---

## 6. Why the Native STL Path Works

| Property          | Native Replicad STL                                                  | Converter-routed 3MF                                                              |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source units      | `shape.blobSTL` writes BRep mm directly                              | `shape.mesh()` then `/1000` to metres                                             |
| Coordinate system | `coordinateSystem` rotates BRep before writing                       | `coordinateSystem` rotates BRep, then `transformVertexArray` always swaps to Y-up |
| Vertex sharing    | STL is index-free; slicer welds by position on import                | 3MF is indexed; written as-is, slicer cannot weld without modifying topology      |
| Normals           | STL stores per-face normal (one per triangle), no per-vertex normals | aiScene retains per-vertex normals; assimp's join pass compares them              |

STL is essentially a serialised dump of the OCCT triangulation in mm + Z-up + position-only — three accidental virtues that mask the regression. The converter-routed path inherits the GLB intermediate's choices (m + Y-up + indexed-with-normals), three accidental vices.

---

## 7. Cross-Format Impact Matrix

Every format that flows through the converter transcoder inherits the GLB intermediate. The unit/orientation/normal defects therefore propagate proportionally to how much each consumer relies on those signals.

| Format                                         | Routed via                    | Unit defect                                                     | Orientation defect                                         | Manifold defect                                     | Slicer/CAD impact                                                              |
| ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `glb` (kernel-native)                          | replicad `case 'glb'`         | spec-correct (m, Y-up)                                          | honoured for `z-up`; `y-up` is double-rotated and broken   | per-face split, but viewers don't validate manifold | Live viewer fine; CAD interchange impacted                                     |
| `gltf` (kernel-native)                         | replicad `case 'gltf'`        | same as `glb`                                                   | same as `glb`                                              | same as `glb`                                       | same                                                                           |
| `stl` (kernel-native)                          | replicad `case 'stl'`         | none (mm)                                                       | honoured                                                   | slicer welds                                        | **No regression**                                                              |
| `step` (kernel-native)                         | replicad `case 'step'`        | none (mm BRep)                                                  | honoured                                                   | manifold (BRep)                                     | **No regression**                                                              |
| `3mf` (transcoder)                             | converter (lib3mf)            | **1000× too small**                                             | **forced Y-up; selection dropped**                         | **non-manifold (572)**                              | Slicer rejects/prompts                                                         |
| `obj` (transcoder)                             | converter (assimp)            | **1000× too small**                                             | depends on consumer's OBJ axis assumption (no spec)        | **non-manifold per-face splits**                    | Slicers and CAD prompt for unit; viewers misinterpret axes                     |
| `ply` (transcoder)                             | converter (assimp)            | **1000× too small**                                             | none in spec; raw vertex dump → consumer assumes           | **non-manifold**                                    | MeshLab/CloudCompare see micro model; printable-mesh tools fail manifold check |
| `fbx` (transcoder)                             | converter (assimp)            | FBX has unit metadata; assimp may emit Cm by default            | FBX has up-axis metadata; assimp's writer chooses          | per-face splits preserved                           | Maya/Blender/UE see 100× or 1000× too small depending on FBX unit they assume  |
| `dae` (transcoder)                             | converter (assimp)            | DAE `<unit>` element supported; assimp may emit `meter`-unit    | DAE `<up_axis>` supported; assimp writes `Y_UP` by default | per-face splits                                     | Some tools auto-convert, some don't                                            |
| `x3d`, `x` (transcoder)                        | converter (assimp)            | no unit metadata                                                | Y-up baked from GLB                                        | per-face splits                                     | Visualisation only                                                             |
| `3ds` (transcoder)                             | converter (assimp)            | no unit metadata; legacy assumes generic units                  | Z-up legacy → assimp may swap                              | per-face splits                                     | Legacy CAD/visualisation                                                       |
| `usda`, `usdz` (transcoder)                    | converter (assimp + tinyusdz) | USD has `metersPerUnit`; not currently set by tinyusdz exporter | USD has `upAxis`; not set                                  | per-face splits                                     | AR Quick Look needs metres; `usdchecker` may flag missing metadata             |
| `step` (when routed via assimp, not currently) | converter                     | would be wrong                                                  | would be wrong                                             | n/a (BRep)                                          | currently routed natively, so safe — but represents a latent risk              |

The table makes the structural problem clear: **the regression is not 3MF-specific**. 3MF is the loudest victim because slicers are strict and validate manifold, but every transcoded mesh format is shipping 1000× too small with a Y-up orientation that the file's spec may forbid (3MF, USD with `upAxis="Z"`) or that the consumer interprets differently.

The reverse direction (assimp import) already has format-specific axis normalisation in `packages/converter/src/loaders/assimp.loader.ts` via `zUpFormats` + `normalizeGlbToYup`. The export direction has no symmetric mechanism.

---

## 8. Recommendations

| #   | Action                                                                                                                                                                                            | Priority | Effort | Impact |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------ |
| R1  | Apply unit + axis bake **inside the converter transcoder** (or a dedicated normalisation transcoder) so the GLB intermediate is rescaled and re-oriented to match each target format's convention | P0       | Low    | High   |
| R2  | Promote `coordinateSystem` (and `unit` where formats support it) to a **shared schema fragment on every transcoder edge** so the route planner stops dropping the user's selection                | P0       | Low    | High   |
| R3  | Strip normals from the aiScene before lib3mf export (or after assimp import in the export direction) so `JoinIdenticalVertices` welds by position alone — eliminates non-manifold seams           | P0       | Low    | High   |
| R4  | Add a position-only weld pass inside `Lib3MFBridge::exportToLib3MF` (e.g., spatial-hash dedup keyed on quantised XYZ) as defence-in-depth for any future caller that retains normals              | P1       | Medium | Medium |
| R5  | Fix the broken `coordinateSystem === 'y-up'` branch in replicad GLB export — it pre-rotates a BRep that is then re-swapped by `transformVertexArray`, producing nonsense                          | P1       | Low    | Medium |
| R6  | Symmetric to `assimp.loader.ts`'s `zUpFormats`, add an `axisAndUnitProfiles: Record<FileExtension, { upAxis, unit, expectsManifold }>` so every transcoded format is normalised to spec on export | P1       | Medium | High   |
| R7  | Apply R1+R2+R3 to OBJ, PLY, FBX, DAE, USDA, USDZ, X3D, X, 3DS — not only 3MF                                                                                                                      | P1       | Medium | High   |
| R8  | Wire `metersPerUnit` and `upAxis` into the USD export path via tinyusdz (currently silent)                                                                                                        | P2       | Medium | Medium |
| R9  | Add converter-package + runtime-package round-trip tests: export a 100 × 150 × 50 mm box to each format, re-import via `AssimpLoader`, assert dimensions and axis match within tolerance          | P2       | Medium | Medium |
| R10 | Investigate enabling `BRepLib::EnsureNormalConsistency` (or a per-shape "smooth-edges" hint) so live preview retains shared normals on smooth boundaries; revisits Replicad-OCCT normal pipeline  | P3       | High   | Medium |

### 8.1 R1 + R2 + R3 are the minimal viable patch

A complete fix for the user-visible 3MF defect requires only three coordinated changes:

1. **Converter transcoder — rescale and re-orient the GLB intermediate before handing to assimp**. Pseudocode:

   ```typescript
   // inside converter.transcoder.ts transcode()
   const targetProfile = formatProfiles[input.to];
   const normalisedGlb = await normaliseGlb(glbBytes, {
     scale: targetProfile.unit === 'millimeter' ? 1000 : targetProfile.unit === 'meter' ? 1 : ...,
     upAxis: targetProfile.upAxis,                  // 'y' or 'z'
     stripNormals: targetProfile.expectsManifold,   // true for 3mf/obj/ply
   });
   ```

   The actual GLB rewrite is mechanical (multiply position accessors, swap axes, drop NORMAL accessors). Three.js's `GLTFExporter`/`GLTFLoader` could be used in tests, but for production we want a tiny `glb-writer.ts` patch — the current implementation already owns the GLB writing path.

2. **Edge schema — give `coordinateSystem` and `unit` first-class status on the edge**, derived from `targetProfile`, so the user's UI selection is validated and forwarded:

   ```typescript
   const threeMfSchema = z.object({
     unit: z.enum(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter']).default('millimeter'),
     coordinateSystem: z.enum(['y-up', 'z-up']).default('z-up'),
     application: z.string().optional(),
   });
   ```

3. **Strip normals before assimp's import** — done inside the rescale pass above (drop `NORMAL` accessor from the GLB), so `JoinIdenticalVertices` welds by position. Lib3MFBridge then writes welded vertex indices and the slicer reports zero non-manifold edges.

### 8.2 Why the fix belongs in the transcoder, not the kernel

The kernel must continue producing a spec-compliant GLB for the live viewer. Putting unit/axis logic in the kernel forces every kernel to learn every downstream consumer's convention. The transcoder already owns the responsibility "convert from GLB to format X"; "convert from spec-compliant GLB to format X with X's conventions baked in" is the same job.

### 8.3 Why R3 is the right cure for non-manifold

The argument for stripping normals is that **every legitimate 3MF/OBJ/PLY consumer recomputes normals from triangles anyway** (slicers must, because they rotate / scale / orient parts on the build plate). Carrying replicad's per-face normals into a slicer is pure topological poison. Keeping them for FBX/DAE/USD (where the consumer is a DCC tool, not a slicer) is reasonable; the `expectsManifold` profile flag picks per format.

### 8.4 Test plan

1. Reproduce the 100 × 150 × 50 mm box defect with the existing pipeline (record vertex magnitudes via `unzip -p box.3mf 3D/3dmodel.model | head`).
2. Apply R1 + R2 + R3.
3. Re-export and verify the same `unzip` shows `100 …` magnitudes, `<model unit="millimeter">`, and a vertex count smaller than the pre-fix file (welded).
4. Open in Bambu Studio → expect no "scale to mm" prompt, footprint flat on plate, 0 non-manifold edges.
5. Repeat for OBJ, PLY (printable formats) and FBX, DAE, USDA, USDZ (DCC formats) — assert dimensions and orientation per their respective conventions.
6. Run `pnpm nx test runtime` and `pnpm nx test converter` for the per-format expectation matrix.

---

## 9. Appendix — Code References

### 9.1 Replicad GLB intermediate (mm → m + Z-up → Y-up)

```99:133:packages/runtime/src/kernels/replicad/utils/replicad-to-gltf.ts
/**
 * Convert replicad geometries to GLTF blob format.
 *
 * Always produces spec-compliant GLTF with:
 * - Y-up coordinate system (per glTF specification)
 * - Meter units (per glTF specification)
 *
 * This function preserves the original triangulation from replicad without re-triangulating,
 * resulting in better rendering quality and performance.
 *
 * @param geometries - Array of Shape3D objects from replicad
 * @param format - Output format: 'glb' for binary, 'gltf' for JSON
 * @returns GLTF blob
 */
export function convertReplicadGeometriesToGltf(
  geometries: GeometryReplicad[],
  format: 'glb' | 'gltf' = 'glb',
): Uint8Array<ArrayBuffer> {
```

### 9.2 Replicad kernel coordinate-system handling per format

```562:639:packages/runtime/src/kernels/replicad/replicad.kernel.ts
      case 'glb':
      case 'gltf': {
        const { linearTolerance, angularTolerance } = options.tessellation;
        const angularToleranceRad = angularTolerance * (Math.PI / 180);
        const { coordinateSystem } = options;

        const shapes =
          coordinateSystem === 'y-up'
            ? nativeHandle.map((s) => ({ ...s, shape: s.shape.clone().rotate(-90, [0, 0, 0], [1, 0, 0]) }))
            : nativeHandle;
```

### 9.3 Converter transcoder edge schemas (no `coordinateSystem`)

```43:54:packages/runtime/src/transcoders/converter/converter-export-options.ts
const threeMfSchema = z.object({
  unit: z
    .enum(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'])
    .default('millimeter')
    .describe('Unit of measurement for the 3MF model coordinates'),
  application: z.string().optional().describe('Creating application metadata (e.g. slicer name and version)'),
});
```

### 9.4 Lib3MF bridge writes vertices verbatim

```196:206:repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp
void exportToLib3MF(const aiScene *pScene, std::vector<Lib3MF_uint8> &outputBuffer,
                    const ExportProperties *pProperties) {
    Lib3MFHandle model;
    checkResult(lib3mf_createmodel(model.ptr()), nullptr, "Failed to create lib3mf model");

    if (pProperties) {
        std::string unitStr = pProperties->GetPropertyString("3MF_EXPORT_UNIT", "millimeter");
        checkResult(
            lib3mf_model_setunit(model.as<Lib3MF_Model>(), stringToModelUnit(unitStr)),
            model.get(), "Failed to set 3MF model unit"
        );
```

### 9.5 Assimp post-processing flags

```11:31:repos/assimpjs/assimpjs/src/assimpjs.cpp
static const aiScene* ImportFileListByMainFile (Assimp::Importer& importer, const File& file)
{
	try {
		const aiScene* scene = importer.ReadFile (file.path,
			aiProcess_Triangulate |
			aiProcess_GenUVCoords |
			aiProcess_JoinIdenticalVertices |
			aiProcess_SortByPType);
```

### 9.6 Symmetric (working) import-side handling

```19:43:packages/converter/src/loaders/assimp.loader.ts
/**
 * Loader for 3D file formats using the Assimp library compiled to WebAssembly.
 */
export class AssimpLoader extends BaseLoader<Uint8Array<ArrayBuffer>, AssimpOptions> {
  /**
   * Formats where Assimp's glTF2 output retains Z-up coordinates because
   * the importer does not bake a Y-up conversion into the scene.
   *
   * Formats NOT listed here already produce Y-up output from Assimp
   * (e.g. FBX, DAE, OBJ, 3DS bake a root transform during import).
   */
  private static readonly zUpFormats: Partial<Record<FileExtension, boolean>> = {
    stl: true,
    ply: true,
    '3mf': true,
    off: true,
    amf: true,
    wrl: true,
    x3dv: true,
    x3d: true,
    xgl: true,
    nff: true,
    ogex: true,
    'mesh.xml': true,
    cob: true,
    md5mesh: true,
    ac: true,
  };
```

This map already encodes the per-format axis convention for the **import** path. R6 calls for an analogous structure on the export side (with the addition of `unit` and `expectsManifold` flags).

---

## Addendum (2026-04-17) — Assimp-First Reframing

The first pass of this document put the fix inside the Tau converter transcoder ("§8.2 Why the fix belongs in the transcoder, not the kernel"). After deeper review of assimp's existing post-processing infrastructure and 13 years of upstream issue/PR history on this exact topic, that placement is wrong. The right home for unit-and-axis bake is **inside `Lib3MFBridge::exportToLib3MF` (and symmetrically the FBX/USD/etc. exporters)**, with Tau acting only as the metadata supplier. The transcoder should still own one job — promoting `coordinateSystem` to a first-class edge-schema field — but should not itself rescale or rotate vertices for any format that has spec-defined unit/axis conventions.

This addendum (a) catalogues the assimp infrastructure that already exists for this, (b) cites the multi-year upstream backlog that documents the same defect across formats, (c) revises the recommendations to put the fix where it belongs, and (d) describes the reduced Tau-side surface area.

### A1. Assimp Already Has Half the Solution

Assimp ships three pieces of post-processing infrastructure that are _intended_ to handle exactly this problem:

| Mechanism                                                                       | Source                                                                   | Direction   | What it does                                                                                                                                           | Limitation                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aiProcess_GlobalScale`                                                         | `code/PostProcessing/ScaleProcess.cpp`                                   | both        | Multiplies every vertex / animation key / node translation by `AI_CONFIG_GLOBAL_SCALE_FACTOR_KEY × AI_CONFIG_APP_SCALE_KEY`                            | Designed to be set by the importer (`AI_CONFIG_APP_SCALE_KEY`) and opted-into by the user (`AI_CONFIG_GLOBAL_SCALE_FACTOR_KEY`); not wired for the export direction by any current exporter |
| `aiProcess_MakeLeftHanded` / `aiProcess_FlipUVs` / `aiProcess_FlipWindingOrder` | `code/PostProcessing/ConvertToLHProcess.cpp`, `code/Common/Exporter.cpp` | both        | Documented as bidirectional in `Exporter.hpp` ("Specifying those flags for exporting has the opposite effect"); X File exporter auto-applies all three | Only handles handedness; does not perform a Y-up ↔ Z-up axis swap                                                                                                                           |
| `aiProcess_PreTransformVertices`                                                | `code/PostProcessing/PretransformVertices.cpp`                           | export-side | Bakes scene-graph node transforms into mesh vertex tables                                                                                              | STL and PLY exporters declare it (`Exporter.cpp:171,178`); makes a root-node rotation actually move vertices — perfect carrier for axis swap                                                |

The X File exporter's exporter-table entry is the precedent we need:

```157:158:repos/assimpjs/assimp/code/Common/Exporter.cpp
exporters.emplace_back("x", "X Files", "x", &ExportSceneXFile,
        aiProcess_MakeLeftHanded | aiProcess_FlipWindingOrder | aiProcess_FlipUVs);
```

The exporter declares the post-processing flags it needs to bridge from assimp's RH+CCW+lower-left-UV convention to its own format's LH convention. Assimp's `Exporter::Export()` then runs those passes on a copy of the scene before handing off to the writer (`Exporter.cpp:451–477`). 3MF's exporter table entry, by contrast, is `0` — no preset flags whatsoever:

```226:226:repos/assimpjs/assimp/code/Common/Exporter.cpp
exporters.emplace_back("3mf", "The 3MF-File-Format", "3mf", &ExportScene3MF, 0);
```

That is the upstream omission. STL declares `aiProcess_Triangulate | aiProcess_GenNormals | aiProcess_PreTransformVertices`, PLY declares `aiProcess_PreTransformVertices`, glTF2 declares `aiProcess_JoinIdenticalVertices | aiProcess_Triangulate | aiProcess_SortByPType` — and 3MF declares nothing. There is no automatic vertex bake, no axis convention, no spec-required validation; lib3mf is just handed an aiScene and asked to dump it.

### A2. Thirteen Years of Upstream Tickets Say the Same Thing

The pattern "assimp loses unit/axis information across import → export" is a well-trodden complaint in the tracker:

| Issue / PR                                                                                                                      | Year      | Format          | Status                                            | Verdict                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#115](https://github.com/assimp/assimp/issues/115) "Assimp flipping y/z axis on different formats"                             | 2013–2023 | dae/3ds/ase/obj | closed deprecated                                 | Never resolved structurally                                                                                                                                                                                                                                    |
| [#165](https://github.com/assimp/assimp/issues/165) "Scale Units and Up Axis metadata"                                          | 2013–2017 | all             | closed (post-process scale shipped, axis missing) | Maintainer comment: "We now have a post process for scaling the model" — referring to `aiProcess_GlobalScale`. Axis side never landed. Maintainer-quoted contributor: _"Assimp does a half assed attempt at making everything Y-up but it's basically broken"_ |
| [#849](https://github.com/assimp/assimp/issues/849) "Imported Model is rotated by 90 degrees"                                   | 2016–2025 | fbx/dae         | closed completed                                  | Took 9 years to close; thread documents 12+ users hitting per-format axis surprises                                                                                                                                                                            |
| [#2166](https://github.com/assimp/assimp/issues/2166) "FBX unit scale issue"                                                    | 2018–2020 | fbx             | closed (PR #3137 added metadata setter)           | "Fix" was the metadata API — the exporter still ignores the metadata. Users still complaining as of Dec 2024                                                                                                                                                   |
| [#2622](https://github.com/assimp/assimp/issues/2622) "FBX Exporter not re-creating imported FBX import metadata"               | 2019      | fbx             | open                                              | Direct evidence the export path drops scale metadata                                                                                                                                                                                                           |
| [#3153](https://github.com/assimp/assimp/issues/3153) "STL → 3MF, hardcoded `unit=\"millimeter\"`, malformed XML"               | 2020      | 3mf             | closed                                            | The pre-lib3mf exporter hardcoded the unit attribute; 3MF spec violations were ignored                                                                                                                                                                         |
| [#3292](https://github.com/assimp/assimp/pull/3292) "FBXExporter: Use scene metadata for global settings"                       | 2020      | fbx             | merged                                            | Partial — only certain settings honoured                                                                                                                                                                                                                       |
| [#3308](https://github.com/assimp/assimp/issues/3308) "How can I change up-axis from Z-Up to Y-Up using assimp?"                | 2020      | all             | closed (workaround only)                          | Maintainer answer: "rotate the transformation of your scene-root-node" — i.e., do it yourself                                                                                                                                                                  |
| [#4052](https://github.com/assimp/assimp/issues/4052) "UnitScaleFactor & AI_CONFIG_FBX_CONVERT_TO_M ignored on exporting scene" | 2021–2025 | fbx             | closed (no response)                              | Closed without a real fix four years later                                                                                                                                                                                                                     |
| [#5337](https://github.com/assimp/assimp/issues/5337) "Read FBX, write FBX, output is much bigger"                              | 2025      | fbx             | open                                              | Same defect, reported again                                                                                                                                                                                                                                    |
| [#5328](https://github.com/assimp/assimp/issues/5328) ".3mf files fail to load"                                                 | 2023–2025 | 3mf             | open                                              | The legacy XML 3MF importer is unstable — strong tailwind for promoting the lib3mf bridge upstream                                                                                                                                                             |
| [#6131](https://github.com/assimp/assimp/pull/6131) "Make broken 3D formats opt-in via CMake"                                   | 2024      | 3mf et al.      | merged                                            | 3MF was reclassified as opt-in because "completely broken" — lib3mf bridge is the cure                                                                                                                                                                         |

The picture is unambiguous: assimp has the right _infrastructure_ (`ScaleProcess`, the bidirectional handedness flags, `PreTransformVertices`), but the _plumbing_ between importer-side metadata and exporter-side write paths was never finished, especially for formats with strong spec-defined conventions (3MF, USD). Multiple maintainers have triaged these tickets across a decade and the fix has consistently slipped, in part because the responsible exporter is the right place to apply the bake but the issue is filed against "assimp" rather than against a specific exporter.

### A3. The 3MF Spec Is Unambiguous

3MF Core Specification §3.1 (verified against [3MFConsortium/spec_core@1.2.3](https://github.com/3MFConsortium/spec_core/blob/1.2.3/3MF%20Core%20Specification.md)):

> Coordinates in this specification are based on a **right-handed coordinate space**. Producers and consumers MUST define and map the origin of the coordinate space to the **bottom-front-left corner** of the device's output field … with the **x-axis increasing to the right**, the **y-axis increasing to the back**, and the **z-axis increasing to the top**.

§3.4 Model element:

> | Name | Type | Default | Annotation |
> | unit | ST_Unit | **millimeter** | Specifies the unit used to interpret all vertices, locations, or measurements in the model. Valid values are micron, millimeter, centimeter, inch, foot, and meter. |

These are MUST-level spec requirements, not application-specific conventions. A 3MF file that declares `unit="millimeter"` while carrying metre-magnitude coordinates is non-conformant; a 3MF file written from Y-up vertex data is non-conformant. Neither is a Tau-specific concern; they are upstream defects that affect every assimp consumer attempting to write printable 3MF. Bambu Studio's "scale to mm?" prompt and the on-side orientation are the visible symptoms of upstream lib3mf-bridge non-conformance.

### A4. Where the Fix Actually Belongs

| Layer                                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tau replicad kernel**                   | Produce a glTF-2 spec-compliant GLB intermediate (m, Y-up). Set asset metadata on the GLB so consumers know the source provenance. Continue rotating the BRep before mesh when `coordinateSystem === 'y-up'` is requested for direct GLB output.                                                                                                                                                                                                                                                                                   | The kernel must emit a spec-compliant GLB for the live viewer. It already does this correctly.                                                                                                                                                                   |
| **Tau converter transcoder**              | Promote `coordinateSystem` (and `unit` where the format admits it) to a first-class field on every edge schema so the route planner stops dropping the user's selection. Forward those values as `ExportProperties` (e.g. `3MF_EXPORT_UNIT`, `3MF_EXPORT_UPAXIS`, `FBX_EXPORT_UNIT_SCALE_FACTOR`). Do **not** rescale or rotate vertices.                                                                                                                                                                                          | Tau's only Tau-specific defect is the schema discontinuity. Everything beyond that is assimp's job.                                                                                                                                                              |
| **Assimp `Lib3MFBridge::exportToLib3MF`** | Treat `3MF_EXPORT_UNIT` as the **target** unit, not as a label. Read aiScene metadata `UnitScaleFactor` (set by the glTF2 importer from the GLB's `extensionsUsed`/`extras`) and rescale aiVertex positions before handing to lib3mf. Honour `3MF_EXPORT_UPAXIS` (default `z-up` per spec); rotate vertices and bake into the build-item transform when source is Y-up. Apply `aiProcess_RemoveDuplicateVertices` (or strip per-vertex normals so `JoinIdenticalVertices` welds by position) so the printable-mesh contract holds. | Lib3MFBridge is the canonical spec-encoder for the format. Every assimp consumer benefits — Blender add-ons, game engines, Unreal/Unity importers, command-line `assimp export`. This is the layer that knows "3MF is millimeters and Z-up by default per §3.1". |
| **Assimp glTF2 exporter / importer**      | Write/read `metersPerUnit` analogue as scene metadata so the round-trip survives GLB → 3MF / 3MF → GLB.                                                                                                                                                                                                                                                                                                                                                                                                                            | Symmetric infrastructure already exists for FBX (`UnitScaleFactor` metadata key); glTF2 should mirror it.                                                                                                                                                        |
| **Assimp 3MF exporter table entry**       | Add `aiProcess_PreTransformVertices \| aiProcess_RemoveDuplicateVertices \| aiProcess_Triangulate` as default flags so consumers don't have to know to set them.                                                                                                                                                                                                                                                                                                                                                                   | Mirrors STL/PLY's existing entries.                                                                                                                                                                                                                              |

This pushes the conformance burden onto the layer that _defines_ what conformance means for that file format. The Tau transcoder shrinks to a metadata-forwarding shim — its only judgement call is "the user said `coordinateSystem: 'z-up'`, so I'll forward `3MF_EXPORT_UPAXIS=z-up`". It never touches vertex math.

### A5. Why an Assimp-First Fix Is Better Than a Tau-First Fix

| Dimension             | Tau-only fix (original §8.2)                                               | Assimp-first fix (this addendum)                                                                                   |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Beneficiaries         | Tau users only                                                             | Every assimp consumer (~13K GitHub stars; Blender, Unreal, Unity, MeshLab, Open3D, etc.)                           |
| Spec authority        | Tau encodes 3MF's Z-up default in app code, far from the spec              | Lib3MFBridge encodes it inline with the lib3mf API call sequence — the obvious place for any maintainer to find it |
| Maintenance cost      | Tau owns bake logic for every format we route (n × format complexity)      | Each format's exporter owns its own conventions; we own zero geometry math                                         |
| Round-trip integrity  | A 3MF written by Tau is correct; one written by anyone else is still wrong | Round-trip works through any tool chain                                                                            |
| Upstream relationship | Diverges further; we maintain a private bake pipeline                      | Closes a 13-year-old gap with a focused PR; strengthens our position as a credible upstream contributor            |
| Risk of regression    | Single integration point                                                   | Defensive — even if upstream changes default flags, we still set them explicitly via `ExportProperties`            |

### A6. Why We Still Need a Tau-Side Patch in the Short Term

The historical record (issues taking 4–9 years to close, often without resolution) means we cannot block on upstream merging. A two-phase strategy is appropriate:

**Phase 1 — ship today (Tau only).** Apply R1+R2+R3 from §8 as a tactical bake inside the converter transcoder. This unblocks users immediately. Mark the bake clearly as a workaround for an upstream defect, with a TODO referencing the assimp issue we will file.

**Phase 2 — fix upstream (assimp PRs).** Submit:

1. A PR adding `3MF_EXPORT_UPAXIS` property handling and `UnitScaleFactor`-aware vertex bake to `Lib3MFBridge::exportToLib3MF`. Default to `z-up` and `millimeter` per spec §3.1/§3.4.
2. A PR adding `aiProcess_PreTransformVertices | aiProcess_RemoveDuplicateVertices` to the 3MF exporter's default flag set in `Exporter.cpp` (mirroring STL/PLY entries).
3. A PR adding round-trip metadata: `Lib3MFBridge::importFromLib3MF` writes `UnitScaleFactor` and `UpAxis` scene metadata; `exportToLib3MF` reads them back when `3MF_EXPORT_UNIT`/`3MF_EXPORT_UPAXIS` are not explicitly provided.
4. A PR for the glTF2 exporter so that scene metadata `UnitScaleFactor` is written to a glTF extras/extensions field so it survives a glTF → 3MF round trip.
5. A PR (smaller) that makes `Lib3MFBridge::exportToLib3MF` strip per-vertex normals before handing to lib3mf when `aiProcess_RemoveDuplicateVertices` is requested — kills the manifold-edge defect at source for every consumer.

**Phase 3 — retire the workaround.** Once the assimp PRs land in a release, wire `assimpjs` to that release, delete the Tau-side bake, and retain only the metadata-forwarding part of the transcoder.

We have institutional alignment with this approach: we already submit upstream PRs (`taucad/assimp` fork is active, the `submit-pr` skill governs the workflow, recent tinyusdz PR work is documented in `docs/research/tinyusdz-fork-fixes-vs-upstream.md`).

### A7. Revised Recommendations Table

| #    | Action                                                                                                                                                                                                                                                                                                                                 | Owner                | Phase | Priority | Effort | Impact |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----- | -------- | ------ | ------ |
| R1′  | **Tactical bake — temporary workaround.** Inside `converter.transcoder.ts`, rescale and re-orient the GLB intermediate to match each target format's spec (mm + Z-up for 3MF, etc.). Mark as `// TODO: remove once assimp lib3mf-bridge unit/axis fix lands upstream`.                                                                 | Tau                  | 1     | P0       | Low    | High   |
| R2   | Promote `coordinateSystem` (and `unit` where the format supports it) to a first-class shared schema fragment on every transcoder edge. Forward as `ExportProperties` (e.g. `3MF_EXPORT_UNIT`, `3MF_EXPORT_UPAXIS`).                                                                                                                    | Tau                  | 1     | P0       | Low    | High   |
| R3′  | Strip per-face normals from the GLB intermediate before assimp import for printable formats (3MF/OBJ/PLY), so `JoinIdenticalVertices` welds by position. Tactical fix; permanent home is upstream (R8′).                                                                                                                               | Tau                  | 1     | P0       | Low    | High   |
| R5   | Fix the broken `coordinateSystem === 'y-up'` branch in replicad GLB export.                                                                                                                                                                                                                                                            | Tau                  | 1     | P1       | Low    | Medium |
| R6   | Symmetric to `assimp.loader.ts`'s `zUpFormats`, add an `axisAndUnitProfiles: Record<FileExtension, { upAxis, unit, expectsManifold }>` so every transcoded format is normalised on export. Use it to drive R1′ until upstream catches up; afterwards use it only to choose the `*_EXPORT_*` properties forwarded to assimp.            | Tau                  | 1     | P1       | Medium | High   |
| R7   | Apply R1′+R2+R3′ to OBJ, PLY, FBX, DAE, USDA, USDZ, X3D, X, 3DS — not only 3MF.                                                                                                                                                                                                                                                        | Tau                  | 1     | P1       | Medium | High   |
| R8′  | **Upstream PR — Lib3MFBridge spec conformance.** Add `3MF_EXPORT_UPAXIS` (default `z-up`); read aiScene `UnitScaleFactor` metadata and rescale vertices when `3MF_EXPORT_UNIT` differs from the source. Bake axis swap via `PreTransformVertices`. Strip normals before handing to lib3mf when `RemoveDuplicateVertices` is requested. | assimp (taucad fork) | 2     | P1       | Medium | High   |
| R9′  | **Upstream PR — 3MF exporter default flags.** Add `aiProcess_PreTransformVertices \| aiProcess_RemoveDuplicateVertices \| aiProcess_Triangulate` to the `Exporter.cpp` registration line.                                                                                                                                              | assimp (taucad fork) | 2     | P1       | Low    | Medium |
| R10′ | **Upstream PR — round-trip metadata.** `importFromLib3MF` writes `UnitScaleFactor`/`UpAxis` scene metadata; `exportToLib3MF` reads them back as defaults. Mirrors what FBX importer/exporter do.                                                                                                                                       | assimp (taucad fork) | 2     | P2       | Low    | Medium |
| R11  | **Upstream PR — glTF2 unit metadata.** Glb/Gltf importer/exporter persist `UnitScaleFactor` via an extras/extensions field so GLB → assimp → 3MF round trips preserve scale.                                                                                                                                                           | assimp (taucad fork) | 2     | P2       | Medium | Medium |
| R12  | **File assimp issue.** Document the gap: 3MF spec §3.1/§3.4 conformance; cite #165, #849, #4052, #5337 as evidence the broader ecosystem hits this; propose the Lib3MFBridge fix path.                                                                                                                                                 | assimp               | 2     | P0       | Low    | High   |
| R13  | **Retire workaround.** Once assimp PRs land in a release wired into `assimpjs`, delete R1′ and R3′ from `converter.transcoder.ts`. R2 and R6 stay as the metadata-forwarding contract.                                                                                                                                                 | Tau                  | 3     | P2       | Low    | High   |
| R14  | Investigate enabling `BRepLib::EnsureNormalConsistency` (or per-shape "smooth-edges" hint) so live preview retains shared normals on smooth boundaries.                                                                                                                                                                                | Tau                  | —     | P3       | High   | Medium |

### A8. Concrete Code Sketch — the Upstream Lib3MFBridge Fix

```cpp
// Lib3MFBridge.cpp — addendum to exportToLib3MF
const Lib3MF::eModelUnit targetUnit = pProperties
    ? stringToModelUnit(pProperties->GetPropertyString("3MF_EXPORT_UNIT", "millimeter"))
    : Lib3MF::eModelUnit::MilliMeter;

const std::string upAxisStr = pProperties
    ? pProperties->GetPropertyString("3MF_EXPORT_UPAXIS", "z-up")
    : std::string("z-up");

// Read source unit from scene metadata (set by FBX/glTF/Collada importers, optional).
double sourceUnitToMeters = 1.0; // assume meters if not set (glTF default)
if (pScene->mMetaData) {
    double scaleFactor = 0.0;
    if (pScene->mMetaData->Get("UnitScaleFactor", scaleFactor) && scaleFactor > 0.0) {
        sourceUnitToMeters = scaleFactor;
    }
}
const double targetUnitToMeters = unitToMeters(targetUnit); // 0.001 for mm, 1.0 for m, etc.
const float scale = static_cast<float>(sourceUnitToMeters / targetUnitToMeters);

// Read source up-axis (set by importers that know it; glTF default is +Y, 3MF default is +Z).
char sourceUp = 'Y';
if (pScene->mMetaData) {
    int upAxisInt = 1;
    if (pScene->mMetaData->Get("UpAxis", upAxisInt)) {
        sourceUp = (upAxisInt == 2) ? 'Z' : (upAxisInt == 0) ? 'X' : 'Y';
    }
}
const char targetUp = (upAxisStr == "y-up") ? 'Y' : 'Z';
const aiMatrix4x4 axisMat = buildAxisRotationMatrix(sourceUp, targetUp);

// Apply scale + axis to each mesh's vertex table.
for (const auto &entry : meshEntries) {
    const aiMesh *mesh = pScene->mMeshes[entry.first];
    std::vector<Lib3MF::sPosition> vertices(mesh->mNumVertices);
    for (unsigned int v = 0; v < mesh->mNumVertices; ++v) {
        aiVector3D p = axisMat * (mesh->mVertices[v] * scale);
        vertices[v].m_Coordinates[0] = p.x;
        vertices[v].m_Coordinates[1] = p.y;
        vertices[v].m_Coordinates[2] = p.z;
    }
    /* … rest unchanged … */
}

// Existing setunit call now matches the data we just wrote.
checkResult(lib3mf_model_setunit(model.as<Lib3MF_Model>(), targetUnit), …);
```

The defaults (`millimeter`, `z-up`, source-Y if no metadata, source-meters if no metadata) match the expectation of every existing assimp consumer using glTF→3MF: a glTF source that doesn't set `UnitScaleFactor` is in metres+Y-up, and 3MF is millimetres+Z-up by spec, so the default conversion is the one most users want.

### A9. The Tau Surface Area Under the Assimp-First Model

Once R8′–R11 land:

```typescript
// converter.transcoder.ts — after the upstream fix lands
async transcode(input: TranscoderInput): Promise<TranscoderOutput> {
  const profile = formatProfiles[input.to]; // table of upAxis + unit per format
  const exportProperties = {
    ...input.options.toAssimpProperties(),
    [profile.unitPropertyKey]: input.options.unit ?? profile.defaultUnit,
    [profile.upAxisPropertyKey]: input.options.coordinateSystem ?? profile.defaultUpAxis,
  };
  return exportFromGlb(input.bytes, input.to, exportProperties);
}
```

No vertex math, no GLB rewriting, no normal stripping. Tau owns:

- The schema (R2 — `coordinateSystem` and `unit` on each edge)
- The per-format profile table (R6)
- The metadata-forwarding shim (the snippet above)

Everything else lives in assimp where it belongs, benefits the whole ecosystem, and aligns with the spec authority.

### A10. References

- 3MF Core Specification §3.1, §3.4: <https://github.com/3MFConsortium/spec_core/blob/1.2.3/3MF%20Core%20Specification.md>
- Assimp `Exporter.hpp` documentation of bidirectional `aiProcess_MakeLeftHanded`/`aiProcess_FlipUVs`/`aiProcess_FlipWindingOrder`: `repos/assimpjs/assimp/include/assimp/Exporter.hpp` lines 207–227
- Assimp `ScaleProcess`: `repos/assimpjs/assimp/code/PostProcessing/ScaleProcess.cpp`
- Assimp X File exporter precedent: `repos/assimpjs/assimp/code/Common/Exporter.cpp` line 157
- Long-running upstream tickets: [#115](https://github.com/assimp/assimp/issues/115), [#165](https://github.com/assimp/assimp/issues/165), [#849](https://github.com/assimp/assimp/issues/849), [#2166](https://github.com/assimp/assimp/issues/2166), [#2622](https://github.com/assimp/assimp/issues/2622), [#3153](https://github.com/assimp/assimp/issues/3153), [#3308](https://github.com/assimp/assimp/issues/3308), [#4052](https://github.com/assimp/assimp/issues/4052), [#5337](https://github.com/assimp/assimp/issues/5337), [#6131](https://github.com/assimp/assimp/pull/6131)
- Related Tau research: `docs/research/tinyusdz-fork-fixes-vs-upstream.md` (precedent for upstream-first fix pattern), `docs/research/3mf-activation-status.md`
