---
title: 'Assimp Transform/Unit/Axis Architecture Landscape'
description: "Complete survey of every existing Assimp mechanism for handling scale, up-axis, and handedness, and an assessment of where Tau's metadata-contract additions overlap, complement, or conflict with that infrastructure."
status: active
created: '2026-04-17'
updated: '2026-04-17'
category: architecture
related:
  - docs/research/3mf-export-scale-orientation-manifold.md
  - docs/research/converter-runtime-consolidation.md
  - docs/research/unified-export-pipeline-architecture.md
  - docs/research/export-pipeline-v6-implementation-audit.md
---

# Assimp Transform/Unit/Axis Architecture Landscape

A complete inventory of how Assimp handles unit scaling, up-axis conversion, and handedness today, and how Tau's `AI_METADATA_UNIT_SCALE_TO_METERS` + `AI_METADATA_UP_AXIS` contract relates to that infrastructure. Written to answer "are we overengineering, are we duplicating, what is the architecturally correct path that maximises upstream merge probability?"

## Executive Summary

Assimp has **three distinct, partially overlapping** mechanisms for transforming geometry on import: (1) the `aiProcess_GlobalScale` post-process step backed by `BaseImporter::SetFileScale`, (2) per-importer root-matrix manipulation done inside loaders themselves (Collada, FBX, DXF, etc.), and (3) the `MakeLeftHandedProcess` handedness-flip post-process. **None of these survive into the exporter.** Once the importer has finished, the only persistent record of "what units / axis was the source in" is whatever the importer chose to write into `aiScene::mMetaData` — and only **FBX** (and now, in Tau's fork, **glTF2** and **3MF**) writes anything useful there. Every other importer applies the transform and discards the source-frame information.

Tau's contract (`AI_METADATA_UNIT_SCALE_TO_METERS` + `AI_METADATA_UP_AXIS` on `aiScene::mMetaData`) fills the **exporter round-trip gap** that the existing `aiProcess_GlobalScale` infrastructure cannot close. It is **complementary, not redundant**, but the comprehensive plan ("metadata contract everywhere") substantially overshoots what is needed to fix the specific bug (3MF + glTF2 export conformance) and incurs significant upstream-merge risk under the new (2026-03-08) AI Tool Use Policy. The architecturally cleanest path is a **two-tier split**: a small, focused upstream PR series that lands the contract keys + glTF2 + 3MF; and a larger, Tau-only follow-up that opportunistically migrates other importers behind upstream maintainer guidance via per-format issues.

The current plan also contains genuine **overlap** with existing infrastructure that should be removed: (a) the proposed `bakeContractTransformIntoMeshes` shared helper duplicates `ScaleProcess::Execute` for the scale half; (b) the `resolveImporterContract` helper is YAGNI — importers should just write the keys directly; (c) reusing the literal string `"UpAxis"` for both FBX's authored-axis semantics and Tau's post-import-axis semantics is a documented footgun that every consumer must guard against.

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Methodology](#2-methodology)
3. [Findings](#3-findings)
   - [3.1 The four existing scale mechanisms](#31-the-four-existing-scale-mechanisms)
   - [3.2 The existing axis/handedness mechanisms](#32-the-existing-axishandedness-mechanisms)
   - [3.3 Per-importer normalisation patterns (status quo)](#33-per-importer-normalisation-patterns-status-quo)
   - [3.4 Per-importer / per-exporter configuration surface](#34-per-importer--per-exporter-configuration-surface)
   - [3.5 The existing scene-metadata catalogue](#35-the-existing-scene-metadata-catalogue)
   - [3.6 Tau's current contract additions](#36-taus-current-contract-additions)
   - [3.7 Upstream maintainer history](#37-upstream-maintainer-history)
4. [Architectural Overlap Analysis](#4-architectural-overlap-analysis)
5. [Footgun: shared `"UpAxis"` string semantics](#5-footgun-shared-upaxis-string-semantics)
6. [Options for the Path Forward](#6-options-for-the-path-forward)
7. [Recommendation](#7-recommendation)
8. [Risk Register](#8-risk-register)
9. [References](#9-references)

---

## 1. Problem Statement

The in-flight plan "assimp metadata contract everywhere" proposes:

- A new `assimp/code/Common/UnitAxisContract.{h,cpp}` shared helper layer.
- Tier 1A migration of 11 importers (STL, PLY, OFF, AMF, X3D/VRML, XGL, NFF, OpenGEX, Ogre, COB, MD5, AC3D) to the contract.
- Tier 1B migration of 12 more importers (OBJ, FBX, COLLADA, 3DS, DXF, ASE, LWO, X, SMD, BVH, IFC, USD).
- Tier 2 migration of 8 exporters to consume the contract.

Before committing to this scope, we need to answer:

- Is `aiProcess_GlobalScale` already a suitable API that Tau is reinventing?
- Does Assimp already provide an axis-rotation post-process step?
- Are existing scene-metadata patterns (FBX `UnitScaleFactor`, Collada applied-but-not-declared) already serving the role our contract claims?
- What is the architecturally correct path that minimises overlap and maximises upstream merge likelihood?

## 2. Methodology

Four parallel investigations under `/Users/rifont/git/tau/repos/assimpjs/assimp/`:

1. Post-process step infrastructure — read `code/PostProcessing/ScaleProcess.{cpp,h}`, `ConvertToLHProcess.{cpp,h}`, `PretransformVertices.cpp`, and the full `aiProcess_*` enum in `include/assimp/postprocess.h`.
2. Per-importer self-applied root-transform code — Collada, FBX, DXF, ASE, MD5, 3DS, USD.
3. Scene metadata catalogue — `include/assimp/commonMetaData.h`, every `mMetaData->Add/Set/Get/HasKey` call site under `code/AssetLib/`.
4. Upstream history — `gh search` over `assimp/assimp` for issues + PRs on units, GlobalScale, up-axis, metersPerUnit, plus the AI Tool Use Policy [PR #6553](https://github.com/assimp/assimp/pull/6553) and the originating discussion [#6538](https://github.com/assimp/assimp/issues/6538).

## 3. Findings

### 3.1 The four existing scale mechanisms

Assimp has **four** distinct paths through which scale ends up applied to geometry. They are not unified; they often coexist on the same import.

| #   | Mechanism                                                                                         | Layer                            | Who reads                           | Who writes                    | Persists in `aiScene`?                  |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------- | ----------------------------- | --------------------------------------- |
| 1   | `BaseImporter::SetFileScale` → `UpdateImporterScale` → `AI_CONFIG_APP_SCALE_KEY` → `ScaleProcess` | Importer property + Post-process | `ScaleProcess::SetupProperties`     | FBX (cm→m), no other importer | **No** — Importer-level only            |
| 2   | `AI_CONFIG_GLOBAL_SCALE_FACTOR_KEY` (user override) → `ScaleProcess`                              | Caller property + Post-process   | `ScaleProcess::SetupProperties`     | User code                     | **No**                                  |
| 3   | Loader-side root-matrix scale (Collada `mUnitSize`, 3DS `mMasterScale`)                           | Importer (root node)             | n/a — applied directly              | Loader                        | **As baked-in transform**, not declared |
| 4   | `AI_METADATA_UNIT_SCALE_TO_METERS` (Tau contract)                                                 | Scene metadata                   | `glTF2Exporter`, 3MF `Lib3MFBridge` | Tau-added: glTF2, 3MF         | **Yes**                                 |

#### `aiProcess_GlobalScale` mechanics

`ScaleProcess::Execute` (`code/PostProcessing/ScaleProcess.cpp:83-161`) walks the entire scene:

- Animation position keys: `mValue *= mScale`
- Mesh vertices and anim-mesh vertices: `vertex *= mScale`
- Bone offset matrices: decompose, scale translation, preserve rotation/scale components
- Every node via `traverseNodes` → `applyScaling`: decompose, scale translation, preserve rotation/scale components

The scale factor comes from `pImp->GetPropertyFloat(AI_CONFIG_GLOBAL_SCALE_FACTOR_KEY, 1.0f) * pImp->GetPropertyFloat(AI_CONFIG_APP_SCALE_KEY, 1.0f)`. The latter is fed by `BaseImporter::SetFileScale` (`code/Common/BaseImporter.cpp:96-107`).

**Critical coupling** — `AI_CONFIG_APP_SCALE_KEY` is read by exactly one consumer: `ScaleProcess`. If the caller does not pass `aiProcess_GlobalScale` in the post-process flag mask, the FBX-set file scale is silently discarded.

#### Why this does not solve the exporter problem

`SetFileScale` lives on the `BaseImporter` instance. It is **not** copied onto `aiScene`. After `ApplyPostProcessing` completes, the scale information exists only as a baked-in geometric multiplication; the exporter has no way to recover "the source was in millimetres" from the resulting scene. This is the smoking gun for upstream issue [#6080](https://github.com/assimp/assimp/issues/6080) (glTF exporter writes incorrect units): the glTF2 exporter cannot read the source unit because it was thrown away by the time the exporter sees the scene.

**Conclusion**: `aiProcess_GlobalScale` is an **import-side normaliser**, not a round-trip mechanism. It cannot be substituted for the metadata contract.

### 3.2 The existing axis/handedness mechanisms

```98:114:repos/assimpjs/assimp/include/assimp/postprocess.h
    aiProcess_MakeLeftHanded = 0x4,
```

```610:624:repos/assimpjs/assimp/include/assimp/postprocess.h
#define aiProcess_ConvertToLeftHanded ( \
    aiProcess_MakeLeftHanded     | \
    aiProcess_FlipUVs            | \
    aiProcess_FlipWindingOrder   | \
    0 )
```

`MakeLeftHandedProcess` (`code/PostProcessing/ConvertToLHProcess.cpp:88-194`) mirrors the Z axis across nodes, meshes, materials, animations, cameras. It does **not** rotate the scene to align an arbitrary axis as up. There is **no** `aiProcess_GlobalAxisRotation` flag and no equivalent processor anywhere in the codebase.

Loaders that need axis alignment do it themselves on the root transform:

- **Collada** ([`ColladaLoader.cpp:188-203`](repos/assimpjs/assimp/code/AssetLib/Collada/ColladaLoader.cpp)): if `parser.mUpDirection != UP_Y`, multiplies a 4×4 rotation into `pScene->mRootNode->mTransformation`. Behind `AI_CONFIG_IMPORT_COLLADA_IGNORE_UP_DIRECTION`.
- **FBX** ([`FBXConverter.cpp:79-124`](repos/assimpjs/assimp/code/AssetLib/FBX/FBXConverter.cpp), `correctRootTransform`): builds an axis frame from FBX global settings and right-multiplies into the root transform. Behind `AI_CONFIG_IMPORT_FBX_IGNORE_UP_DIRECTION`.
- **DXF / ASE / MD5**: hard-coded +90° X rotation in the loader (no opt-out).
- **3DS**: `mMasterScale` applied to root.

These transformations rely on `aiProcess_PreTransformVertices` (or downstream consumer node traversal) to actually flow the root-matrix rotation into vertex coordinates. They never emit a record of what was done.

**Conclusion**: there is no upstream "rotate to target up-axis" infrastructure. The closest cross-cutting flag (`MakeLeftHanded`) does handedness only.

### 3.3 Per-importer normalisation patterns (status quo)

Comparing the four most spec-rich formats:

| Format  |         Spec defines unit          | Spec defines up-axis | Importer parses unit | Importer parses up-axis |   Importer applies unit   | Importer applies up-axis | Importer writes unit metadata | Importer writes up-axis metadata |       Per-importer override config        |
| ------- | :--------------------------------: | :------------------: | :------------------: | :---------------------: | :-----------------------: | :----------------------: | :---------------------------: | :------------------------------: | :---------------------------------------: |
| COLLADA |        Y (`<unit meter=>`)         |   Y (`<up_axis>`)    |          Y           |            Y            |      Y (root scale)       |    Y (root rotation)     |             **N**             |              **N**               | `IGNORE_UP_DIRECTION`, `IGNORE_UNIT_SIZE` |
| USD     |     Y (stage `metersPerUnit`)      |  Y (stage `upAxis`)  |        **N**         |          **N**          |           **N**           |          **N**           |             **N**             |              **N**               |                   none                    |
| glTF2   |         Y (1u = 1m, fixed)         |    Y (+Y, fixed)     |         n/a          |           n/a           |            n/a            |           n/a            |          **Y (Tau)**          |           **Y (Tau)**            |                   none                    |
| FBX     | Y (`UnitScaleFactor`, cm-relative) |   Y (`UpAxis` int)   |          Y           |            Y            | Y (`SetFileScale` × 0.01) |    Y (root rotation)     |   **Y** (legacy keys, raw)    |     **Y** (legacy keys, raw)     |    `IGNORE_UP_DIRECTION` (5.3.x-style)    |

Three observations:

1. **Collada is the model citizen for "applies but doesn't declare"** — it does the right thing on import but provides no information for round-trip.
2. **USD is broken upstream today** — it ignores `metersPerUnit`/`upAxis` entirely. Open issue, no PR. This is a credible candidate for a clean upstream contribution that does not require any cross-cutting infrastructure changes.
3. **FBX is the model citizen for "declares but in pre-normalisation terms"** — it writes the authored `UpAxis`, not the post-normalisation axis. Any consumer that reads `mMetaData->Get("UpAxis")` and expects "scene is currently this axis" is wrong for FBX scenes that have run `correctRootTransform`.

### 3.4 Per-importer / per-exporter configuration surface

The canonical Assimp pattern for optional per-format behaviour is `AI_CONFIG_IMPORT_<FMT>_<KNOB>`:

- `AI_CONFIG_IMPORT_COLLADA_IGNORE_UP_DIRECTION` (bool)
- `AI_CONFIG_IMPORT_COLLADA_IGNORE_UNIT_SIZE` (bool)
- `AI_CONFIG_IMPORT_FBX_IGNORE_UP_DIRECTION` (bool)
- `AI_CONFIG_FBX_CONVERT_TO_M` (bool — declared "deprecated and confusing" by triager in upstream issue [#6325](https://github.com/assimp/assimp/issues/6325))
- A dozen `AI_CONFIG_IMPORT_FBX_READ_*` flags
- Format-specific keyframe overrides for MD2/MD3/MD5/MDC/MDL/SMD/Unreal

Only Collada and FBX have axis/unit override flags. Adding a uniform `AI_CONFIG_IMPORT_<FMT>_UNIT_SCALE_TO_METERS` and `AI_CONFIG_IMPORT_<FMT>_UP_AXIS` per importer (as the current plan proposes) is consistent with the convention but multiplies the API surface by ~24 new flags.

Exporter properties follow a parallel `EXPORT_<FMT>_<KNOB>` convention. Tau already added `3MF_EXPORT_UNIT`, `3MF_EXPORT_UPAXIS`, `3MF_EXPORT_APPLICATION` to `Lib3MFBridge.cpp`.

### 3.5 The existing scene-metadata catalogue

`commonMetaData.h` (in Tau's fork) declares:

| Macro                               | String key                  | Type       | Source                                              |
| ----------------------------------- | --------------------------- | ---------- | --------------------------------------------------- |
| `AI_METADATA_SOURCE_FORMAT`         | `SourceAsset_Format`        | `aiString` | All importers (Common/Importer.cpp fallback)        |
| `AI_METADATA_SOURCE_FORMAT_VERSION` | `SourceAsset_FormatVersion` | `aiString` | Most importers                                      |
| `AI_METADATA_SOURCE_GENERATOR`      | `SourceAsset_Generator`     | `aiString` | glTF1/2, COLLADA, FBX                               |
| `AI_METADATA_SOURCE_COPYRIGHT`      | `SourceAsset_Copyright`     | `aiString` | glTF1/2, COLLADA                                    |
| `AI_METADATA_UNIT_SCALE_TO_METERS`  | `UnitScaleToMeters`         | `double`   | Tau-added: glTF2, 3MF                               |
| `AI_METADATA_UP_AXIS`               | `UpAxis`                    | `int32_t`  | Tau-added: glTF2, 3MF; **string-collides with FBX** |

FBX additionally writes 16 raw scene-metadata keys via `FBXConverter::ConvertGlobalSettings` (`FBXConverter.cpp:3689-3716`) without going through any macro: `UpAxis`, `UpAxisSign`, `FrontAxis`, `FrontAxisSign`, `CoordAxis`, `CoordAxisSign`, `OriginalUpAxis`, `OriginalUpAxisSign`, `UnitScaleFactor`, `OriginalUnitScaleFactor`, `AmbientColor`, `FrameRate`, `TimeSpanStart`, `TimeSpanStop`, `CustomFrameRate`, plus the version/generator commonMetaData macros.

**No other importer writes any axis or unit metadata at the scene level.** Collada, USD, 3MF (pre-Tau), STL, OBJ, PLY, etc. all leave that information on the floor.

### 3.6 Tau's current contract additions

Tau's fork has already merged:

- `AI_METADATA_UNIT_SCALE_TO_METERS` and `AI_METADATA_UP_AXIS` macros with explicit Doxygen warning ("Disjoint from the legacy `UnitScaleFactor` key").
- glTF2 importer writes `UnitScaleToMeters=1.0`, `UpAxis=1` unconditionally.
- 3MF importer (`Lib3MFBridge.cpp:929-931`) writes the model unit + `UpAxis=2`.
- glTF2 exporter (`glTF2Exporter.cpp`) gates an inverse-transform bake on `HasKey(AI_METADATA_UNIT_SCALE_TO_METERS)`, then reads both keys via `readSceneUnitScaleToMeters` / `readSceneUpAxis` and applies in-place per-mesh transformation.
- 3MF exporter (`Lib3MFBridge.cpp:274,288`) reads both keys and bakes to mm + Z-up.

The 3MF and glTF2 exporter test suites are green.

### 3.7 Upstream maintainer history

The architectural debate has happened before:

| Year    | Issue / PR                                                                                                                                              | Outcome                                                                                | Relevance                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2013    | [#165](https://github.com/assimp/assimp/issues/165) "Scale Units and Up Axis metadata"                                                                  | **Closed 2017** with kimkulling: _"We now have a post process for scaling the model."_ | The 2013 proposal is functionally a superset of Tau's contract. Maintainers consider this question closed, point at `aiProcess_GlobalScale`.      |
| 2019    | [#2611](https://github.com/assimp/assimp/pull/2611) "Prototype unit system" + [#2607](https://github.com/assimp/assimp/pull/2607) ScaleProcess overhaul | Merged                                                                                 | Settled the canonical architecture: importer-level `SetFileScale`, framework `ScaleProcess`, **not** scene metadata.                              |
| 2025    | [#6080](https://github.com/assimp/assimp/issues/6080) "gltf/glb Exporter Incorrect unit assumption"                                                     | Open, no PR, no owner                                                                  | The smoking gun proving `aiProcess_GlobalScale` does not solve the exporter round-trip. Tau's glTF2 exporter fix closes this.                     |
| 2025    | [#6325](https://github.com/assimp/assimp/issues/6325) "AI_CONFIG_FBX_CONVERT_TO_M not respected"                                                        | Closed; triager: _"deprecated and should probably be removed"_                         | Existing config-based scaling is acknowledged-broken.                                                                                             |
| 2025    | [#6320](https://github.com/assimp/assimp/issues/6320) "ConvertToLeftHanded should skip if already LH"                                                   | Open; triager response: _"fundamental problem with your pipeline"_                     | Triagers push complexity back on users; resistant to making post-process steps "smarter" via metadata.                                            |
| 2026-03 | [#6553](https://github.com/assimp/assimp/pull/6553) AI Tool Use Policy                                                                                  | **Merged 2026-03-08** by kimkulling                                                    | Explicit `extractive` label for large AI-generated PRs. Disclosure required. The contributor must be able to "answer questions about their work". |

Maintainer style:

- Decision-maker: `kimkulling` is the sole effective merger.
- Triage gatekeeper: `tellypresence` runs per-format epics ([#6147](https://github.com/assimp/assimp/issues/6147), [#6180](https://github.com/assimp/assimp/issues/6180), [#6215](https://github.com/assimp/assimp/issues/6215)).
- Median merged PR: ~10 lines, single file, single format. Largest 2025 outsider feature PR was ~30 lines, took 3 weeks.
- 2026-03 AI Policy was kimkulling's own PR responding to upstream "AI slop" concerns. Highly relevant to how a 23-importer migration would be received.

## 4. Architectural Overlap Analysis

Assessing each piece of the current plan against existing infrastructure:

| Plan element                                                                                           | Existing equivalent                                                                             | Overlap verdict                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_METADATA_UNIT_SCALE_TO_METERS` (scene metadata, declarative)                                       | `BaseImporter::SetFileScale` + `aiProcess_GlobalScale` (importer config, applies normalisation) | **Complementary.** Scene metadata persists across exporter boundary and `Importer` reuse; `SetFileScale` does not. The two solve different problems.                                                                                                                                                                                               |
| `AI_METADATA_UP_AXIS` (post-import axis declaration)                                                   | None — no `aiProcess_GlobalAxisRotation`; loaders self-apply via root matrix                    | **Fills a real gap.** No equivalent exists.                                                                                                                                                                                                                                                                                                        |
| `Tier 0` `bakeContractTransformIntoMeshes` shared helper (vertices + normals + tangents, anim meshes)  | `ScaleProcess::Execute` (vertices + bones + nodes + anims) for the scale half                   | **Partial overlap.** The exporter use case differs from `ScaleProcess` (we want to bake _into_ the geometry once, on export, with rotation as well as scale). But the _scale_ portion duplicates `ScaleProcess`'s mesh-vertex loop. The implementation should not be a "framework-grade" shared helper; it should be a pragmatic exporter utility. |
| `Tier 0` `resolveImporterContract` helper                                                              | n/a — each importer parses its own format                                                       | **YAGNI.** Importers have nothing to "resolve"; they read their format's own metadata and write the two contract keys. Wrapping that in a helper adds indirection without leverage.                                                                                                                                                                |
| `Tier 0` `writeContractMetadata` helper                                                                | `aiMetadata::Add(key, value)` is two lines                                                      | **YAGNI.** A two-line wrapper is not infrastructure.                                                                                                                                                                                                                                                                                               |
| `Tier 0` `validateUpAxisInt` / `buildAxisRotationMatrix` / `applyLinearTransform` / `isApproxIdentity` | Already inlined in `glTF2Exporter.cpp` and `Lib3MFBridge.cpp`                                   | **Modest dedup value.** A header with these primitives is reasonable, scoped to ~50 lines.                                                                                                                                                                                                                                                         |
| `Tier 1A` 11-importer migration (STL, PLY, OFF, AMF, X3D, XGL, NFF, OpenGEX, Ogre, COB, MD5, AC3D)     | Nothing                                                                                         | **No overlap.** But scope is very large; most of these are low-traffic formats that no Tau user exercises. Each import is ~5-20 lines but each requires `AI_CONFIG_IMPORT_<FMT>_*` flag pair, doc, and tests.                                                                                                                                      |
| `Tier 1B` 12-importer migration (OBJ, FBX, COLLADA, 3DS, DXF, ASE, LWO, X, SMD, BVH, IFC, USD)         | FBX already has 16 keys; COLLADA applies-but-doesn't-declare; USD is broken                     | **Mixed overlap.** FBX requires writing **both** legacy and new keys (already noted in plan); COLLADA is straightforward; USD is a clean bug fix. Others are low-value.                                                                                                                                                                            |
| `Tier 2` 8-exporter consumption (3DS, DAE, FBX, OBJ, PLY, STL, USDA/USDZ, X/X3D)                       | FBX exporter already reads `UnitScaleFactor` from metadata (cm-relative, legacy semantics)      | **Overlap with FBX exporter** — adding contract consumption alongside legacy FBX consumption is structurally fine but creates two parallel scale paths with FBX-specific bridging.                                                                                                                                                                 |

**Summary**: The contract keys themselves are a real architectural addition that fills a genuine gap. The shared helpers proposed in `Tier 0` are mostly unnecessary scaffolding. The 23-importer migration is scope inflation that has neither user demand nor upstream mandate.

## 5. Footgun: shared `"UpAxis"` string semantics

Tau's `AI_METADATA_UP_AXIS` macro deliberately reuses the literal string `"UpAxis"`, sharing it with the FBX importer's existing key. The Doxygen describes this as intentional. **It is a real footgun** and should be reconsidered.

| Aspect               | FBX `UpAxis`                                                                                                                                     | Tau contract `UpAxis`                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Encoding             | `int32_t`, 0=X / 1=Y / 2=Z                                                                                                                       | `int32_t`, 0=X / 1=Y / 2=Z                                              |
| Semantics            | Axis as **authored in the source file**, before any normalisation                                                                                | Axis of the **post-import vertex coordinates**, after any normalisation |
| FBX behaviour        | Written raw from `doc.GlobalSettings().UpAxis()`. After `correctRootTransform` runs, vertices are in a different space than this value declares. | n/a                                                                     |
| Consumer expectation | "What the file said"                                                                                                                             | "What the geometry currently is"                                        |

A consumer reading `scene->mMetaData->Get("UpAxis", &v)` cannot tell which semantics the writer intended. For an FBX scene that had `correctRootTransform` run (i.e. virtually all FBX imports), the legacy `UpAxis=2` value would be wrong under the contract semantics, because the geometry is now Y-up.

**Options to disambiguate**:

1. Use a different macro string. `"UpAxis_Normalized"` or `"PostImportUpAxis"`. Loses the "shared encoding" benefit but eliminates ambiguity.
2. Keep the shared string but require FBX to **overwrite** the legacy `UpAxis` value with the post-normalisation value when the contract is in effect. Breaks FBX consumers who depend on legacy semantics.
3. Keep the shared string and add a `"UpAxisSemantics"` companion key (`"authored"` vs `"normalized"`). Adds a third key for what should be a binary distinction.
4. Document the footgun and leave it. Current state.

Option 1 is the architecturally cleanest. The cost (FBX continues to write legacy `UpAxis`; a new importer writes a different key) is small. Recommended.

## 6. Options for the Path Forward

Three coherent strategies emerge from the landscape analysis:

### Option A — Comprehensive contract migration (current plan)

- Add the two contract keys (done).
- Migrate 23 importers to write them.
- Migrate 8 exporters to consume them.
- Build shared helpers (`UnitAxisContract.{h,cpp}`).

**Pros**: Eventually all formats are first-class. Maximum consistency.
**Cons**: Massive scope inflation. Highly likely to be labelled `extractive` upstream. Most migrated formats have zero Tau usage. Footgun in shared `"UpAxis"` string left in place. Duplicates `ScaleProcess` semantics in shared helper.

### Option B — Align with existing infrastructure, drop the contract

- Have each Tau-relevant importer call `SetFileScale` so `aiProcess_GlobalScale` works.
- Tau enables `aiProcess_GlobalScale` in the post-process flag mask before calling exporters.
- For axis: write a new `aiProcess_NormalizeUpAxis` post-process step that reads a `AI_CONFIG_TARGET_UP_AXIS` property and rotates root + bakes accordingly.
- Drop the `AI_METADATA_UNIT_SCALE_TO_METERS` and `AI_METADATA_UP_AXIS` keys.

**Pros**: Aligned with maintainer-blessed `ScaleProcess` pattern. New post-process step has clear precedent in `MakeLeftHandedProcess`.
**Cons**: Does not solve the exporter round-trip problem ([#6080](https://github.com/assimp/assimp/issues/6080)) — once `GlobalScale` runs, the source unit is gone. Exporters writing into formats that need source-unit metadata (3MF, USD) cannot recover it. **This is the same gap that drove us to the contract in the first place.** The new post-process step does help for axis, but introduces yet another transform layer.

### Option C — Minimal contract, scoped Tau use, narrow upstream PR

- Keep `AI_METADATA_UNIT_SCALE_TO_METERS` and `AI_METADATA_UP_AXIS` (already shipped).
- Drop the proposed `Tier 0` shared helper layer entirely. Inline math directly in the two exporters (already the case in glTF2Exporter; 3MF/Lib3MFBridge needs a small extraction).
- Drop the `Tier 1A` and `Tier 1B` migrations from this work. Defer to upstream issue-driven follow-ups.
- Drop the `Tier 2` exporter migrations from this work. Each is a separate "this format needs source unit info" decision that can be made when a consumer demands it.
- Rename `AI_METADATA_UP_AXIS` to `"UpAxis_Normalized"` or similar to eliminate the FBX semantic collision.
- Submit a focused upstream PR series:
  - **PR 1**: Add the two contract keys to `commonMetaData.h` + populate from glTF2 importer + 3MF importer. Closes part of the #6180 epic.
  - **PR 2**: glTF2 exporter consumes `UnitScaleToMeters` to bake inverse transform. Closes [#6080](https://github.com/assimp/assimp/issues/6080).
  - **PR 3**: 3MF exporter conformance fixes (units/axis/weld). Closes [#165](https://github.com/assimp/assimp/issues/165), [#849](https://github.com/assimp/assimp/issues/849), [#4052](https://github.com/assimp/assimp/issues/4052).
- Land an issue first that discusses the architectural choice (`commonMetaData.h` vs. extending `aiProcess_GlobalScale`) and explicitly addresses kimkulling's 2017 closing of [#165](https://github.com/assimp/assimp/issues/165). Disclose AI assistance per [PR #6553](https://github.com/assimp/assimp/pull/6553) policy.

**Pros**: Minimal new infrastructure. Tau-side bug is fully fixed (3MF + glTF2 are the only Tau-relevant exporters). Upstream PRs each have a single, defensible scope. Eliminates the FBX footgun. Respects the "small focused PR" maintainer norm.
**Cons**: Other importers (USD, COLLADA, etc.) remain non-conforming. Tau cannot expose new importers/exporters as first-class without a follow-up. Upstream maintainers may still ask "why two new keys instead of extending `SetFileScale` to write metadata" — needs a defensive paragraph in the issue.

### Option D — Hybrid: minimal upstream + Tau-only opportunistic migration

Same as Option C for the upstream contribution. **Additionally**, allow opportunistic per-format migrations in the Tau fork as Tau's own roadmap demands them — but track each as a separate ticket with concrete user value, not a sweep.

**Pros**: Best of both. Upstream PR is small and defensible; Tau is not blocked from improving format-specific behaviour locally.
**Cons**: Fork divergence grows over time; eventual upstream sync becomes harder.

## 7. Recommendation

**Adopt Option D.**

Rationale:

1. The contract keys (`AI_METADATA_UNIT_SCALE_TO_METERS`, `AI_METADATA_UP_AXIS`) **fill a real architectural gap** that cannot be closed by the existing `aiProcess_GlobalScale` infrastructure. The smoking gun is upstream issue [#6080](https://github.com/assimp/assimp/issues/6080) and the now-deprecated `AI_CONFIG_FBX_CONVERT_TO_M` flag.
2. The current plan's 23-format migration is **not justified by Tau's user-facing scope**. Tau's converter routes nine import formats and seven export formats through Assimp; migrating 23 importers and 8 exporters as a bundle violates the "smallest PR that solves the problem" principle.
3. The shared helper layer in `Tier 0` is **mostly YAGNI**. A ~50-line header with `validateUpAxisInt`, `buildAxisRotationMatrix`, `applyLinearTransform`, `isApproxIdentity` is reasonable; everything else (`resolveImporterContract`, `writeContractMetadata`, `bakeContractTransformIntoMeshes`) is scaffolding without leverage.
4. **Reusing the literal `"UpAxis"` string for two different semantic spaces is a documented footgun** that should be eliminated before more importers/exporters consume the contract.
5. The 2026-03 AI Tool Use Policy materially changes the upstream merge economics. Large multi-file refactors are now actively flagged as `extractive`. A 23-importer migration submitted as one PR is the canonical shape the policy was written against.
6. Tau already has working 3MF + glTF2 exports under the existing contract. The Tau-facing bug is **fixed**. Pulling more importers into the contract is **opportunity, not necessity**.

### Concrete next steps (Tau side)

| #   | Action                                                                                                                                                                                             | Effort                     | Value                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| 1   | Drop the `Tier 0` `UnitAxisContract.{h,cpp}` shared infrastructure plan in its current form                                                                                                        | None — just don't build it | Avoids overengineering                                     |
| 2   | Extract a minimal `UnitAxisContract.h` with only `validateUpAxisInt`, `buildAxisRotationMatrix`, `applyLinearTransform`, `isApproxIdentity` (the four primitives currently inlined in two places)  | S                          | Removes duplication between glTF2Exporter and Lib3MFBridge |
| 3   | Rename the macro to `AI_METADATA_UP_AXIS_NORMALIZED` (string `"UpAxis_Normalized"`); update the two writers and two readers; update Doxygen to call out the disambiguation                         | S                          | Eliminates the FBX semantic collision                      |
| 4   | Drop `Tier 1A`, `Tier 1B`, `Tier 2` from this work item. Capture each surviving format as a separate, individually-prioritised issue with explicit user-value justification                        | None                       | Right-sizes the scope to what Tau actually needs           |
| 5   | Proceed with the original Tier 4 (Tau-side cleanup): delete `zUpFormats` + `normalizeGlbToYup` from `assimp.loader.ts`, rebaseline converter test fixtures, rebuild WASM, repack, relink, validate | M-L                        | Delivers the user's actual ask                             |
| 6   | Write the audit-deliverable `docs/research/converter-geometry-removal-followup.md` for `gltf.exporter.ts`, `occt.loader.ts`, `3dm.loader.ts` (kept from original plan)                             | S                          | Documents the Tau-side leftovers                           |

### Concrete next steps (upstream side)

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                           | Effort | Value                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| 1   | Open an issue on `assimp/assimp` proposing the metadata contract. Explicitly address kimkulling's 2017 closure of [#165](https://github.com/assimp/assimp/issues/165): explain that `aiProcess_GlobalScale` solves the import-side problem but leaves exporters with no source-frame information, and cite [#6080](https://github.com/assimp/assimp/issues/6080) as evidence. Disclose AI assistance per the AI Tool Use Policy. | S      | Establishes maintainer alignment before PR investment                      |
| 2   | If the issue is well-received, submit **PR 1**: add the two contract keys to `commonMetaData.h`, populate from glTF2 importer (always +Y, 1.0) and 3MF importer (from model unit).                                                                                                                                                                                                                                               | S      | Trivially correct values; small surface                                    |
| 3   | Submit **PR 2**: glTF2 exporter consumes `UnitScaleToMeters` to bake inverse transform. Closes [#6080](https://github.com/assimp/assimp/issues/6080).                                                                                                                                                                                                                                                                            | M      | Direct upstream bug fix; defensible scope                                  |
| 4   | Submit **PR 3**: 3MF exporter conformance fixes (units/axis/weld). Closes [#165](https://github.com/assimp/assimp/issues/165), [#849](https://github.com/assimp/assimp/issues/849), [#4052](https://github.com/assimp/assimp/issues/4052).                                                                                                                                                                                       | M      | Direct upstream bug fix; closes long-standing issues                       |
| 5   | If maintainers express interest, follow up with **PR 4**: USD importer reads `metersPerUnit` + `upAxis` from stage and writes the contract keys.                                                                                                                                                                                                                                                                                 | M      | Closes the USD gap; isolated change; high user value if USD adoption grows |

## 8. Risk Register

| #   | Risk                                                                                                           | Likelihood                    | Impact                                     | Mitigation                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Upstream rejects the contract approach in favour of extending `aiProcess_GlobalScale`                          | Medium                        | Tau keeps the fork; no impact on Tau users | Issue-first discussion; defensive paragraph addressing #165 closure                                                               |
| R2  | Upstream demands FBX `UpAxis` semantics be "fixed" alongside the new contract                                  | Medium-Low                    | Larger PR scope                            | Already mitigated by the proposed string rename; FBX legacy keys stay untouched                                                   |
| R3  | Maintainers label the PR `extractive` under the AI Tool Use Policy                                             | Low (with split + disclosure) | PR closure, lost effort                    | Three small focused PRs instead of one large; explicit `Assisted-by:` trailers; human contributor able to answer review questions |
| R4  | Renaming `AI_METADATA_UP_AXIS` → `AI_METADATA_UP_AXIS_NORMALIZED` is rejected, semantic collision is preserved | Low                           | Footgun persists for downstream consumers  | Document explicitly in Doxygen; provide a `getNormalisedUpAxis(scene)` helper that handles FBX legacy semantics                   |
| R5  | Tau later needs USD/COLLADA round-trip and has to migrate them anyway                                          | Medium-High                   | Deferred work                              | Each format is a small, well-scoped follow-up; deferral cost is bounded                                                           |
| R6  | Fork drift increases as Tau-only contract changes accumulate                                                   | Medium                        | Sync cost grows                            | Track Tau-only changes in a single header; periodic review against upstream `commonMetaData.h`                                    |

## 9. References

- Existing landscape:
  - `repos/assimpjs/assimp/code/PostProcessing/ScaleProcess.cpp` — `aiProcess_GlobalScale` implementation
  - `repos/assimpjs/assimp/code/PostProcessing/ConvertToLHProcess.cpp` — `MakeLeftHandedProcess` implementation
  - `repos/assimpjs/assimp/code/PostProcessing/PretransformVertices.cpp` — root-matrix baking
  - `repos/assimpjs/assimp/code/Common/BaseImporter.cpp` — `SetFileScale` / `UpdateImporterScale`
  - `repos/assimpjs/assimp/code/AssetLib/Collada/ColladaLoader.cpp:179-203` — root-matrix unit + axis application
  - `repos/assimpjs/assimp/code/AssetLib/FBX/FBXConverter.cpp:79-124,3689-3716` — `correctRootTransform` + `ConvertGlobalSettings`
  - `repos/assimpjs/assimp/include/assimp/commonMetaData.h` — Tau's contract additions
- Upstream history:
  - [assimp/assimp#165](https://github.com/assimp/assimp/issues/165) — original 2013 unit/axis metadata proposal (closed)
  - [assimp/assimp#2611](https://github.com/assimp/assimp/pull/2611) — 2019 unit-system prototype (merged)
  - [assimp/assimp#6080](https://github.com/assimp/assimp/issues/6080) — open glTF exporter unit bug
  - [assimp/assimp#6325](https://github.com/assimp/assimp/issues/6325) — `AI_CONFIG_FBX_CONVERT_TO_M` deprecation discussion
  - [assimp/assimp#6553](https://github.com/assimp/assimp/pull/6553) — AI Tool Use Policy (merged 2026-03-08)
  - [assimp/assimp#6147](https://github.com/assimp/assimp/issues/6147), [#6180](https://github.com/assimp/assimp/issues/6180), [#6215](https://github.com/assimp/assimp/issues/6215) — per-format epics
- Related Tau research:
  - `docs/research/3mf-export-scale-orientation-manifold.md`
  - `docs/research/converter-runtime-consolidation.md`
  - `docs/research/unified-export-pipeline-architecture.md`
- Specifications:
  - [Khronos glTF 2.0 §3.1, §3.5](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) — coordinate system and units
  - [3MF Core Specification](https://3mf.io/specification/) — unit and axis conventions
  - [OpenUSD Glossary](https://openusd.org/release/glossary.html) — `metersPerUnit`, `upAxis`
  - [COLLADA Spec §`<asset>`](https://www.khronos.org/files/collada_spec_1_5.pdf) — `<unit>`, `<up_axis>`
