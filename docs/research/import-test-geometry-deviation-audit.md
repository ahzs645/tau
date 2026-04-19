---
title: 'Import Test Geometry Deviation Audit'
description: 'Audit of why packages/converter import tests assert on five different cube geometry shapes instead of one, with categorisation by root cause (fixture authoring, importer defaults, exporter bake bugs).'
status: active
created: '2026-04-16'
updated: '2026-04-17'
category: audit
related:
  - docs/research/assimp-transform-architecture-landscape.md
  - docs/research/3mf-export-scale-orientation-manifold.md
  - docs/research/converter-runtime-consolidation.md
---

# Import Test Geometry Deviation Audit

Why `packages/converter/src/import.test.ts` cannot use a single `standardCubeGeometry` expectation across every Assimp-routed format, what each deviating bucket actually represents, and which deviations are bugs vs. legitimate input differences.

## Executive Summary

The "gold-standard" test (a 2 mm Y-up cube on the ground plane, `size [0.002, 0.002, 0.002]`, `center [0, 0.001, 0]`) only passes for **3 of 24** Assimp-routed formats: STL, AMF, DXF. The other 21 formats fall into five distinct buckets, driven by **three independent root causes** that are presently entangled in test expectations:

1. **Fixture-corpus inconsistency (10 formats — biggest contributor).** The cube fixtures were exported from Rhino, which is Z-up + millimetre internally. Rhino _applies a Y-up swap when it knows the destination format demands Y-up_ (OBJ, X3D, 3DS-via-conversion) but _preserves Z-up source coordinates for axis-less formats_ (PLY, WRL, X3DV, OFF, COB, NFF, AC, XGL, MD5MESH, MESH.XML). That decision then collides with the new contract layer which assumes those axis-less formats are Y-up at 1 metre per unit.
2. **Importer default mismatch (10 formats — same set, opposite framing).** For each axis-less format above, the contract resolver in the Assimp fork picks `(unit=1.0 m, upAxis=1=Y)` as the post-import default. STL by contrast picks `(0.001 m, upAxis=2=Z)` — which matches the Rhino fixture exactly and is why STL is the only "axis-less" format that lands on `standardCubeGeometry`.
3. **Exporter bake bug (1 format — FBX).** FBX produces `center [0, 0, -0.001]`: the unit scale baked correctly but the contract carries the _authored_ up-axis (`Z`) while `correctRootTransform` already left a Z→Y rotation on the scene root, so the bake rotates a second time and the result is a net Z-mirror of the spec-correct cube.
4. **Fixture-corpus inconsistency carries through 3MF too (1 format — 3MF).** The 3MF bridge and `glTF2Exporter` are _both correct_; the deviation is entirely caused by `cube.3mf` itself authoring the cube on the −Y face (`y∈[−2, 0]`) rather than on the +Z build plate. After spec-conformant bake (mm → m, Z-up → Y-up), the cube's source-Y-axis (the −Y range) maps to the destination +Z axis, producing `center [0, 0, 0.001]`. This is mathematically right; the fixture is wrong.

The largest single intervention that would collapse buckets ZupSource / NegZupSource / FBX-shifted / 3MF-shifted into the gold standard is **re-authoring the 11 Rhino-exported fixtures into the convention each importer's defaults declare** (axis-less formats Y-up + metres; 3MF Z-up + ground-plane). The smallest individually-defensible change is **adding per-format `AI_CONFIG_IMPORT_<FMT>_*` overrides at the converter loader boundary** so each test fixture's authoring convention is declared at the call site instead of relying on importer defaults.

The FBX bake-bug residue is a separate (single-format) workstream that does not block fixture-corpus normalisation. The 3MF deviation is a fixture-only fix.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Findings](#findings)
   - [Finding 1: Five distinct geometry buckets, three root causes](#finding-1-five-distinct-geometry-buckets-three-root-causes)
   - [Finding 2: The Rhino-fixture inconsistency](#finding-2-the-rhino-fixture-inconsistency)
   - [Finding 3: Importer contract defaults vs. fixture authoring conventions](#finding-3-importer-contract-defaults-vs-fixture-authoring-conventions)
   - [Finding 4: 3MF — fixture authored Y-down, pipeline behaves correctly](#finding-4-3mf--fixture-authored-y-down-pipeline-behaves-correctly)
   - [Finding 5: FBX — double rotation between `correctRootTransform` and the bake](#finding-5-fbx--double-rotation-between-correctroottransform-and-the-bake)
   - [Finding 6: Variants that are legitimately not gold-standard](#finding-6-variants-that-are-legitimately-not-gold-standard)
4. [Per-Format Inventory](#per-format-inventory)
5. [Recommendations](#recommendations)
6. [Appendix: Reproduction commands](#appendix-reproduction-commands)

---

## Problem Statement

After moving all unit/axis transformation responsibility into the Assimp fork (per `docs/research/assimp-transform-architecture-landscape.md` and the now-shipped `Common/UnitAxisContract.{h,cpp}`), `packages/converter/src/import.test.ts` was rebaselined empirically. The result is **five distinct `GeometryExpectation` shapes** for what is conceptually "the same 2-unit cube":

| Bucket                           | `size`                  | `center`         | Used by                                                         |
| -------------------------------- | ----------------------- | ---------------- | --------------------------------------------------------------- |
| `standardCubeGeometry`           | `[0.002, 0.002, 0.002]` | `[0, 0.001, 0]`  | gltf, glb, stl, amf, dxf                                        |
| `assimpCubeGeometry`             | `[2, 2, 2]`             | `[0, 1, 0]`      | obj, dae, usdz, lwo, x3d, ase, x, ogex, 3dm/mesh                |
| `assimpCubeZupSourceGeometry`    | `[2, 2, 2]`             | `[0, 0, 1]`      | ply, wrl, x3dv, xgl, off, ac, nff, cob, md5mesh, mesh.xml, usda |
| `assimpCubeNegZupSourceGeometry` | `[2, 2, 2]`             | `[0, 0, -1]`     | 3ds, ifc/freecad, ifc/blender                                   |
| FBX-shifted                      | `[0.002, 0.002, 0.002]` | `[0, 0, -0.001]` | fbx (binary, ascii)                                             |
| 3MF-shifted                      | `[0.002, 0.002, 0.002]` | `[0, 0, 0.001]`  | 3mf                                                             |

The gold-standard hypothesis (everything ought to look like the STL test) is:

```typescript
createCubeTestCase('stl', {
  variant: 'binary',
  geometry: standardCubeGeometry,
});
```

This audit answers: _which of those five buckets are legitimate (different fixtures genuinely encode different geometry) and which are bugs (importer/exporter pipeline mistreating semantically-identical geometry)?_

## Methodology

1. Read every cube fixture under `packages/converter/src/fixtures/cube*` and recorded the authored vertex range and any in-file unit/axis declarations.
2. For each format that runs through Assimp, read the corresponding `ContractDefaults{unit, upAxis}` literal in `repos/assimpjs/assimp/code/AssetLib/<FMT>/<FMT>Loader.cpp` (or equivalent).
3. Cross-referenced the contract bake convention in `repos/assimpjs/assimp/code/Common/UnitAxisContract.cpp` (`bakeContractTransformIntoMeshes`) and the glTF2 exporter's target frame (`(1.0, 1)`) to derive expected post-bake bounds.
4. Compared the derived expected bounds to the empirically-observed bounds recorded in `_inspect-extents.test.ts` (used during rebaselining; deleted afterwards).
5. Classified each format into one of three buckets: _expected matches observed_ (bake works as designed); _expected does not match observed_ (bug); _expected was never the gold standard_ (fixture by design encodes something other than a 2 mm cube on the +Y ground plane).

## Findings

### Finding 1: Five distinct geometry buckets, three root causes

The five `GeometryExpectation` shapes collapse to three independent causes. Multiple buckets can share the same root cause:

| Root cause                                                         | Buckets affected                                                    | Format count |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------ |
| (A) Fixture authored at non-spec scale/position                    | `assimpCubeGeometry`, `assimpCubeNegZupSourceGeometry`, 3MF-shifted | 13           |
| (B) Importer default does not match fixture's authoring convention | `assimpCubeZupSourceGeometry`                                       | 11           |
| (C) Bake runs but result is offset by a small fixed amount         | FBX-shifted                                                         | 2            |

**Cause (A) is not a bug.** The OBJ/DAE/USDZ/LWO/X3D/X/ASE/OGEX/3DM fixtures encode a 2 m cube sitting on the +Y ground plane. That is what the importer reads, that is what the bake declines to touch (because source frame matches target frame), and that is what the exporter emits. A slightly different fixture would produce a slightly different observed shape. These tests are _valid measurements of a different physical object_. **3MF belongs in this bucket, not in (C)** — the `cube.3mf` fixture was authored with the cube on the −Y face (vertices `y∈[−2, 0]`, `z∈[−1, 1]`) instead of on the +Z build plate (`z∈[0, 2]`). The Assimp pipeline correctly applies the spec rotation to those source coordinates and the cube lands on +Z in glTF Y-up space; see Finding 4.

**Cause (B) is a coherence problem, not an Assimp pipeline bug.** Each affected format is officially axis-less in spec. The contract resolver picks Y-up as the default, but the Rhino fixture supplies Z-up vertex data without declaring the axis. The bake therefore runs in identity mode (target frame = declared source frame) and the Z-up vertex values flow through unchanged. The cube is "above the ground" along glTF's depth axis instead of standing on it. The behaviour is _correct given the inputs_; the inputs are _wrong given the contract_.

**Cause (C) is a real bug — FBX only.** FBX is the one remaining format whose source file declares both a unit and an axis AND whose post-import scene composes the contract bake on top of an importer-side rotation that was never cleared. The contract write succeeds, the unit half of the bake produces the right scale (`0.002` m), but the axis half is then run a second time at the node level. See Finding 5.

### Finding 2: The Rhino-fixture inconsistency

Almost every cube fixture was exported by **Rhinoceros 8** (visible in PLY headers, AMF metadata, OBJ first-line comment, X3D `<head>` block). Rhino is Z-up + millimetre internally. It makes a per-format decision when exporting:

| Rhino exporter behaviour                                         | Fixtures                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Applies Z→Y axis swap when target spec mandates Y-up             | `cube.obj` (Y∈[0,2]), `cube.x3d` (Y∈[0,2])                        |
| Applies neither axis swap nor mm→m scale; leaves source verbatim | `cube-ascii.stl` / `cube-ascii.ply` / `cube-binary.ply` (Z∈[0,2]) |
| Preserves Z-up despite spec preference for Y-up                  | `cube.wrl` / `cube.x3dv` (Z∈[0,2])                                |
| Preserves Z-up for axis-less formats                             | `cube.off`, `cube.xgl`, `cube.amf`, `cube.cob`, `cube.nff`        |

The `cube.x3d` vs `cube.x3dv` divergence is the smoking gun: same model, same Rhino, same export session, but `.x3d` (XML, Y-up swap applied) and `.x3dv` (Classic VRML text, Z-up preserved) end up with opposite axis conventions. X3D's spec mandates +Y as the default `viewpointBindable` orientation; Classic VRML's spec also mandates +Y but accepts a `<NavigationInfo>` orientation override that Rhino apparently does not emit. The result is a fixture corpus that contradicts itself.

Other authoring tools contribute additional heterogeneity:

| Fixture                | Authored by                            | Authored frame                                                                                                                                             |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cube.ase`             | "ImageToStl.com"                       | 3DS Max convention (Y-up, m)                                                                                                                               |
| `cube.lwo`             | unknown (LightWave)                    | Y-up, m                                                                                                                                                    |
| `cube.ogex`            | hand-authored                          | Declares `Metric (key="up") {string {"z"}}` — Z-up + 1 m, _and is read by the OpenGEX importer correctly_                                                  |
| `cube.x`               | unknown (legacy DirectX)               | Y-up, m                                                                                                                                                    |
| `cube.dae`             | (Collada)                              | Y-up, m on ground (Collada `<unit meter=>` element honoured)                                                                                               |
| `cube-millimeters.dae` | (Collada)                              | Y-up, mm on ground (`<unit meter="0.001">`)                                                                                                                |
| `cube.3ds`             | unknown                                | Z-up, m, cube in −Z half (z∈[−2, 0])                                                                                                                       |
| `cube.amf`             | Rhinoceros (sets `unit="Millimeters"`) | mm + Z-up — _importer reads both, applies bake correctly_                                                                                                  |
| `cube-binary.fbx`      | "FBX SDK 2020.3.2"                     | UpAxis=2 (Z), `UnitScaleFactor=0.1` (= 1 mm), cube at z∈[0,2]                                                                                              |
| `cube-blender.ifc`     | FreeCAD                                | Z-up (IFC convention), cube at z∈[−2, 0]                                                                                                                   |
| `cube.md5mesh`         | hand-authored                          | Comment in fixture: _"final positions after Y-up to Z-up transform"_ — fixture author **expected** the MD5 importer to apply a Y↔Z swap; today it does not |

The `cube.md5mesh` comments are particularly telling: the fixture author hand-pre-rotated the geometry on the assumption that the loader would un-rotate it. The contract default `(1.0, 1)` for MD5 declines to do that, leaving the pre-rotated geometry in its pre-rotated form.

### Finding 3: Importer contract defaults vs. fixture authoring conventions

The `ContractDefaults{unit, upAxis}` literal in each loader determines what the exporter bake will treat the source frame as. When the literal matches the fixture's authoring convention, the bake produces a spec-correct glTF. When it does not, the bake either no-ops in identity mode (and the geometry passes through in the wrong frame) or applies a transform that lands somewhere unexpected.

| Format   | `ContractDefaults`                                     | Rhino fixture frame              | Match?  | Resulting bucket                                                                 |
| -------- | ------------------------------------------------------ | -------------------------------- | ------- | -------------------------------------------------------------------------------- |
| STL      | `{0.001, 2}` (mm + Z-up)                               | mm + Z-up                        | ✅      | `standardCubeGeometry`                                                           |
| PLY      | `{1.0, 1}` (m + Y-up)                                  | mm-as-units + Z-up               | ❌      | `assimpCubeZupSourceGeometry` — bake is identity, Z-up data flows verbatim       |
| OBJ      | `{1.0, 1}`                                             | m + Y-up (Rhino swapped)         | ✅      | `assimpCubeGeometry`                                                             |
| AMF      | `{<read from file>, 2}`                                | mm + Z-up                        | ✅      | `standardCubeGeometry`                                                           |
| DXF      | `{0.001, 1}` _after_ loader-side +90°X root rotation   | mm + Z-up → loader Y-up          | ✅      | `standardCubeGeometry` (with 72-vertex/24-face triangulation)                    |
| OGEX     | `{<read from file>, <read from file>}` → `(1.0, 2)`    | m + Z-up (file declares)         | ✅      | `assimpCubeGeometry` (bake rotates Z→Y → cube on ground)                         |
| WRL/X3DV | `{<read>=1.0, 1}`                                      | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| OFF      | `{1.0, 1}`                                             | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| AC       | `{1.0, 1}`                                             | Y-up _with_ `loc 0 0 1` baked in | ❌      | `assimpCubeZupSourceGeometry` — fixture's loc translation looks like Z-up extent |
| NFF      | `{1.0, 1}`                                             | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| XGL      | `{1.0, 1}`                                             | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| MD5MESH  | `{1.0, 1}`                                             | author hand-pre-rotated          | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| MESH.XML | `{1.0, 1}` (Ogre)                                      | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| COB      | `{<read>, 1}`                                          | m + Z-up                         | ❌      | `assimpCubeZupSourceGeometry`                                                    |
| 3DS      | `{1.0, 2}`                                             | m + Z-up at −Z half              | ✅      | `assimpCubeNegZupSourceGeometry` — _fixture is in −Z half by design_             |
| IFC      | `{1.0, 2}`                                             | m + Z-up at −Z half              | ✅      | `assimpCubeNegZupSourceGeometry` — _fixture is in −Z half by design_             |
| FBX      | (FBX writes contract from `doc.GlobalSettings()`)      | mm + Z-up authored               | partial | FBX-shifted (see Finding 5)                                                      |
| 3MF      | (Lib3MFBridge writes from model unit + `(2)` constant) | mm + Z-up                        | partial | 3MF-shifted (see Finding 4)                                                      |
| Collada  | reads `<unit>` + `<up_axis>`                           | matches fixture                  | ✅      | `assimpCubeGeometry`                                                             |
| USDA     | reads stage `metersPerUnit`/`upAxis`                   | depends on usd file              | mixed   | one variant is `assimpCubeGeometry`, others `assimpCubeZupSourceGeometry`        |

The pattern is clear: **for every axis-less format whose default is `(1.0, 1)`, the Rhino fixture is `(some-mm-or-m, 2)`. The defaults systematically miss the fixture corpus.**

Two ways to interpret this:

- **Defaults are wrong.** Rhino is the dominant CAD/3D-printing authoring tool for these formats and it is Z-up + mm. The contract should have picked `{0.001, 2}` (matching STL) for every axis-less mesh format. Counter-argument: PLY in graphics research and PLY in MeshLab/CloudCompare workflows is universally Y-up + m; changing the upstream-equivalent default in our fork would break consumers outside the CAD/3DP cohort.
- **Fixtures are wrong.** Test fixtures should match the contract defaults so the round-trip lands on `standardCubeGeometry` for every format. This is purely a test-corpus change with no upstream implications.

### Finding 4: 3MF — fixture authored Y-down, pipeline behaves correctly

**Initial diagnosis** (this audit's first revision): "the axis half of the bake does not run; suspected `Lib3MFBridge` root-node interaction or `D3MFImporter` re-write race." That diagnosis was **wrong**. Direct inspection of the Lib3MF bridge, the lib3mf bundle in `repos/assimpjs/assimp/contrib/lib3mf/`, the glTF2 exporter, and the fixture itself proves the Assimp pipeline is mathematically correct. The deviation is entirely on the fixture-authoring side.

**Observed**: `size [0.002, 0.002, 0.002]`, `center [0, 0, 0.001]` (cube extends z∈[0, 0.002] in glTF Y-up space).

**Smoking-gun trace** — every step verified against current source:

1. **Fixture content.** `unzip -p packages/converter/src/fixtures/cube.3mf 3D/3dmodel.model` reveals

   ```xml
   <model unit="millimeter" ...>
     <object id="2" type="model" ...>
       <mesh>
         <vertices>
           <vertex x="1.000000" y="0" z="1.000000" />
           <vertex x="-1.000000" y="0" z="1.000000" />
           <vertex x="-1.000000" y="-2.000000" z="1.000000" />
           <vertex x="1.000000" y="-2.000000" z="1.000000" />
           <vertex x="1.000000" y="0" z="-1.000000" />
           <vertex x="1.000000" y="-2.000000" z="-1.000000" />
           <vertex x="-1.000000" y="0" z="-1.000000" />
           <vertex x="-1.000000" y="-2.000000" z="-1.000000" />
         </vertices>
         ...
       </mesh>
     </object>
     <build><item objectid="2" /></build>
   </model>
   ```

   Vertex bounds: `x∈[-1, 1]`, `y∈[-2, 0]`, `z∈[-1, 1]`. The cube is 2 mm on each axis but **the long axis (the cube's own ground plane → ceiling axis) is the source `−Y` direction**, not `+Z`. The 3MF Core Spec §3.3 declares `+Z` as the build-plate normal, so the fixture is unconventional: the cube is "lying on its side" (the +Z extent is just the ±1 lateral half-axis, not the cube's vertical extent). The build item carries no `transform` attribute, so the build-item transform is identity.

2. **Lib3MF reads vertices verbatim.** `Lib3MFBridge::importFromLib3MF` (`repos/assimpjs/assimp/code/AssetLib/3MF/Lib3MFBridge.cpp:740-746`) calls `lib3mf_meshobject_getvertex(meshObj, v, &pos)` for each vertex and assigns `aiMeshPtr->mVertices[v] = (pos.x, pos.y, pos.z)` with no transform. The lib3mf bundle in `repos/assimpjs/assimp/contrib/lib3mf/` likewise stores vertex positions raw — verified by reading `Source/Model/Reader/v100/NMR_ModelReaderNode100_Mesh.cpp` and `…/NMR_MeshExporter.cpp`. There is no implicit Z→Y rotation on the lib3mf side.

3. **Build-item transform is identity.** The bridge stores build-item transforms on child nodes (`Lib3MFBridge.cpp:834-836`). For this fixture `lib3mf_builditem_hasobjecttransform` returns false, so `child->mTransformation` stays at the default identity matrix.

4. **Bridge writes spec contract values.** `Lib3MFBridge.cpp:851` calls `writeContractMetadata(pScene, 0.001 /* mm */, 2 /* Z-up per 3MF Core Spec */, "3MF")`. The unit is read from `lib3mf_model_getunit`; the up-axis is hard-coded to `2` because the spec normatively defines +Z as up — _the spec axis, not the fixture's actual cube orientation_.

5. **`assimpjs` pipeline runs the right post-process flags.** `repos/assimpjs/assimpjs/src/assimpjs.cpp:14-18` enables `aiProcess_Triangulate | aiProcess_GenUVCoords | aiProcess_JoinIdenticalVertices | aiProcess_SortByPType` — notably _not_ `aiProcess_PreTransformVertices`. So node transforms remain on nodes (still identity for this fixture) and mesh-local vertices stay raw.

6. **glTF2 exporter bakes scale and rotation.** `repos/assimpjs/assimp/code/AssetLib/glTF2/glTF2Exporter.cpp:1241-1320` reads source `(0.001, 2)` from the contract metadata, computes target `(1.0, 1)`, then for each vertex applies `vertexScale=0.001` and the +90° rotation about +X (`buildAxisRotationMatrix(2, 1)`, see `UnitAxisContract.cpp:108-113`). The matrix is exactly `[[1,0,0],[0,0,1],[0,-1,0]]`, so the per-vertex map is `(x, y, z) → (x, z, -y)` after scale.

7. **Apply the math to the fixture vertices** (after both scale and rotation):
   - new x = old x × 0.001 ∈ [−0.001, 0.001]
   - new y = old z × 0.001 ∈ [−0.001, 0.001]
   - new z = -old y × 0.001 ∈ [0, 0.002]

   Final bounds: `size [0.002, 0.002, 0.002]`, `center [0, 0, 0.001]`. **Exactly the observed value.**

**Conclusion**: the bake's axis-half _did_ run. There is no Assimp bug. The Lib3MF bridge, the lib3mf library, and the glTF2 exporter all behave per spec. The cube ends up sitting on the +Z half-axis of glTF Y-up space because the _fixture_ authored the cube's vertical extent on the source `−Y` direction; the spec-conformant `Z→Y` rotation maps that source `−Y` to glTF `+Z`.

Verified by hand: a hypothetical fixture with vertices on z∈[0, 2] (the canonical 3MF +Z-up "ground plane" placement) would, after the same `(0.001 mm/unit, 2 → 1)` bake, land at exactly `center [0, 0.001, 0]` — the gold-standard result. The bake formula is `(x, y, z) → (x × 0.001, z × 0.001, −y × 0.001)`, so source `z∈[0, 2]` becomes glTF `y∈[0, 0.002]`.

**Recommendation**: re-author `cube.3mf` to encode the cube at `z∈[0, 2]` (the canonical 3MF +Z-up build-plate placement) and revert the test to `standardCubeGeometry`. The Assimp fork needs no changes for 3MF.

**Why the prior diagnosis missed this**: the audit's first pass observed that the _unit-scale_ half of the bake produced the right magnitude (`0.002`) but the cube was offset along the wrong axis, and inferred (incorrectly) that the rotation half was being skipped. The hidden assumption was that `cube.3mf` authored the cube the same way `cube.stl` does (long axis on +Z). Reading the actual XML — which we did not do in the first pass — surfaces the unconventional `−Y` long-axis authoring and resolves the entire deviation algebraically.

### Finding 5: FBX — double rotation between `correctRootTransform` and the bake

**Observed**: `size [0.002, 0.002, 0.002]`, `center [0, 0, -0.001]` (cube z∈[−0.002, 0]).

**Expected**: `center [0, 0.001, 0]` after `correctRootTransform` + bake.

**Trace**:

1. The FBX fixture declares `UpAxis=2`, `UnitScaleFactor=0.1` (= 1 mm), cube vertices `z∈[0, 2]` in fixture units.
2. `FBXConverter` runs `correctRootTransform` (`FBXConverter.cpp:79–124`): builds a Z-up→Y-up rotation matrix and **right-multiplies it into the scene root node's transformation**. Mesh vertices stay in Z-up local space.
3. `FBXConverter::ConvertGlobalSettings` (`FBXConverter.cpp:3721–3724`) writes `AI_METADATA_UNIT_SCALE_TO_METERS=0.001`, `AI_METADATA_UP_AXIS=2` (the _authored_ axis, not the post-`correctRootTransform` axis). This is the FBX semantic-collision footgun called out as R2 in `assimp-transform-architecture-landscape.md`.
4. `glTF2Exporter` bakes scale `0.001` and rotation `Z→Y` into the mesh vertices: `z∈[0,2] → y∈[0, 0.002]` (Y-up).
5. The exporter then walks the scene graph and emits the root-node transform — which still carries the `correctRootTransform` rotation from step 2 — into the glTF JSON.
6. Three.js / glTF readers compose the node transform on top of the already-baked vertex positions: a second Z→Y rotation. `y∈[0, 0.002] → z∈[−0.002, 0]`. Final cube center: `[0, 0, −0.001]`.

The math reproduces the observation exactly. The bug is **the FBX importer writes the contract from authored axis but does not clear the `correctRootTransform` rotation it left on the root node**, so the bake runs once at the mesh and the original rotation runs again at the node.

Two architecturally clean fixes:

- **Option A**: Change `FBXConverter::ConvertGlobalSettings` to read the post-`correctRootTransform` axis (i.e. always write `AI_METADATA_UP_AXIS=1` when `correctRootTransform` ran). Then the bake sees `(0.001, 1)` source / `(1.0, 1)` target, runs only the scale half, and the un-touched root rotation in the scene graph applies the Z→Y rotation exactly once. Risk: legacy consumers reading `mMetaData->Get("UpAxis")` for the authored axis (FBX-specific 16-key block) get the post-rotation value instead.
- **Option B**: Have `correctRootTransform` clear its rotation off the root node after writing the contract, so the bake performs the rotation. Risk: any consumer that traverses the node tree expecting the root-correction rotation gets the un-corrected mesh frame.

Option A aligns with the contract's documented "post-import frame" semantics. Option B aligns with the "geometry-only" baking philosophy of `bakeContractTransformIntoMeshes`. Pick one based on which set of legacy consumers we want to preserve; the FBX-specific 16-key metadata block is not affected by either.

### Finding 6: Variants that are legitimately not gold-standard

These are not bugs and should not be normalised:

| Test case                                         | `geometry`                                         | Why it is intentionally non-standard                                             |
| ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `glb` `draco`/`materials`/`animations`/`textures` | `optimizedCubeGeometry` (24 vert, 8 face) variants | Indexed cube with shared vertices; UV seams add or remove vertex count           |
| `obj` materials, FBX animations, FBX textures     | `assimpCubeGeometry` size variants                 | Different fixture authored at non-default scale (cm in FBX animations)           |
| `dae` `millimeters`                               | mm-scale assimpCubeGeometry                        | Collada importer applies `<unit meter=>` to root, not to vertices — known caveat |
| `step`/`stp`/`iges`/`igs`                         | `optimizedCubeGeometry`                            | Routed via OCCT kernel, not Assimp; shape is genuinely a 2 m cube on ground      |
| `3dm` `mesh`                                      | `optimizedCubeGeometry`                            | Routed via Rhino3dm parser, not Assimp                                           |
| `3dm` `instance`                                  | `[12, 2, 7]` arrayed instances                     | Programmatic fixture creating five instanced cubes                               |
| `bvh`                                             | `[2.4828..., 2.4, 2.4]` skinned mesh               | BVH represents a skeletal capsule, not a cube                                    |
| `drc`                                             | `[2, 2, 2]` Z-up source                            | Draco-only fixture; geometry is otherwise a clean indexed cube                   |
| `usda` / `usdz` `materials`                       | Z-up centred                                       | tinyusdz preserves source axis differently from the USDZ reader path             |

## Per-Format Inventory

Every Assimp-routed test case, classified by root cause and recommended outcome.

| Format                                                    | Bucket                           | Root cause                                              | Recommended path                                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stl, amf, dxf                                             | `standardCubeGeometry`           | Defaults match fixture                                  | Keep as gold-standard reference                                                                                                                                     |
| obj, dae, x3d, lwo, ase, x, ogex, 3dm, usdz               | `assimpCubeGeometry`             | Fixtures are 2 m on ground in Y-up by design            | Either (a) re-author fixtures at mm scale or (b) document and accept variant                                                                                        |
| ply, wrl, x3dv, off, ac, nff, cob, xgl, md5mesh, mesh.xml | `assimpCubeZupSourceGeometry`    | Cause B — Importer default Y-up; Rhino fixture Z-up     | **R1**: re-author Rhino exports with Y-up swap; or **R2**: pass `AI_CONFIG_IMPORT_<FMT>_UP_AXIS=2` from `assimp.loader.ts`                                          |
| 3ds, ifc                                                  | `assimpCubeNegZupSourceGeometry` | Fixture authored in −Z half by design                   | Re-author fixtures with cube in +Z half (matches 3DS canonical examples)                                                                                            |
| fbx                                                       | FBX-shifted                      | Cause C — `correctRootTransform` + bake double-rotation | **R3**: fix FBXConverter (Option A or B in Finding 5); revert FBX test to `standardCubeGeometry`                                                                    |
| 3mf                                                       | 3MF-shifted                      | Cause A — fixture authors the cube on −Y (Finding 4)    | **R4**: re-author `cube.3mf` to place the cube at `z∈[0, 2]` (canonical 3MF Z-up placement); revert test to `standardCubeGeometry`. **No Assimp changes required.** |
| usda variant 1                                            | `assimpCubeGeometry`             | tinyusdz USDA path preserves ground frame               | Keep as variant                                                                                                                                                     |
| usda variant 2                                            | Z-up centred                     | tinyusdz USDA path preserves source axis                | Investigate whether tinyusdz writes contract correctly                                                                                                              |
| step, iges, 3dm/mesh, drc, bvh                            | various                          | Not Assimp-routed                                       | Out of scope                                                                                                                                                        |

## Recommendations

| #   | Action                                                                                                                                                                                                                                                  | Priority | Effort | Impact                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Re-author the 10 Rhino-exported axis-less fixtures (PLY, WRL, X3DV, OFF, COB, NFF, AC, XGL, MD5MESH, MESH.XML) as Y-up by applying the `(x, y, z) → (x, z, −y)` swap and renaming the `assimpCubeZupSourceGeometry` cases to `standardCubeGeometry`     | P1       | M      | Removes 10 of the 11 Z-up bucket entries from the test surface; aligns with importer contract semantics                              |
| R2  | In `packages/converter/src/loaders/assimp.loader.ts`, expose per-format `AI_CONFIG_IMPORT_<FMT>_UNIT_SCALE_TO_METERS` / `..._UP_AXIS` overrides that the converter caller can set when format-specific source frame is known                            | P2       | S      | Lets downstream consumers (and the test corpus) declare the source frame at the call site, eliminating reliance on importer defaults |
| R3  | Fix the FBX `correctRootTransform` ↔ contract bake double-rotation. Recommended: option A (write post-rotation axis to the contract). Re-baseline FBX test to `standardCubeGeometry`                                                                    | P1       | M      | Closes one of two real exporter bake bugs; reverts FBX-shifted bucket                                                                |
| R4  | Re-author `cube.3mf` so the cube sits on the +Z build plate (`z∈[0, 2]`, `unit="millimeter"`). After re-authoring, revert the 3MF test to `standardCubeGeometry`. **No Assimp/lib3mf changes required** — the pipeline is verified correct in Finding 4 | P2       | S      | Removes the 3MF-shifted bucket entirely with a single-fixture change; no upstream risk                                               |
| R5  | Re-author the 3DS and IFC fixtures so the cube sits in the +Z half (z∈[0, 2]) instead of −Z half. Then the contract bake produces `standardCubeGeometry` (when also scaled to mm)                                                                       | P3       | M      | Removes `assimpCubeNegZupSourceGeometry` bucket entirely                                                                             |
| R6  | Re-author the `cube.x3dv` / `cube.wrl` fixtures with a Y-up swap so the X3D and X3DV tests assert identical geometry (currently they are split: X3D = `assimpCubeGeometry`, X3DV = `assimpCubeZupSourceGeometry`)                                       | P2       | S      | Eliminates the X3D ↔ X3DV inconsistency call out in Finding 2                                                                        |
| R7  | Decide whether `assimpCubeGeometry` (2 m cube on ground) should be normalised to `standardCubeGeometry` (2 mm cube on ground) by re-authoring OBJ/DAE/X3D/LWO/X/ASE/OGEX/3DM/USDZ fixtures at mm scale                                                  | P3       | L      | Removes the size-only bucket; cosmetic but allows exactly one cube expectation across the suite                                      |
| R8  | After R1–R7, document a fixture-authoring policy in `docs/policy/converter-fixture-policy.md`: every fixture must be authored in the convention each importer's contract default declares                                                               | P3       | S      | Prevents recurrence; makes future fixture additions trivially reviewable                                                             |

If only one recommendation can be acted on, **R1 has the highest leverage**: 10 fixtures, no upstream changes, all converge to `standardCubeGeometry` (modulo size — which becomes the next sweep). The fixtures are test-only artifacts with no production consumers.

For the bake bugs, **only R3 (FBX) requires upstream Assimp work**. R4 (3MF) is now a fixture-only change after Finding 4 confirmed the pipeline is correct.

## Appendix: Reproduction commands

```bash
pnpm nx test converter ./src/import.test.ts --watch=false

awk '/end_header/{flag=1;next}flag&&NF{print $1, $2, $3; if(++c==36)exit}' \
    packages/converter/src/fixtures/cube-ascii.ply

grep -B1 -A2 'ContractDefaults [a-z]\+\s*{' \
    repos/assimpjs/assimp/code/AssetLib/**/*.cpp
```

The deleted `_inspect-extents.test.ts` diagnostic from the rebaselining session can be reconstructed by adding a Vitest case that calls `getInspectReport` on each fixture's GLB output and `console.log`s `report.scenes[0].sceneExtras.bbox`.
