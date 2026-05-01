---
title: 'Assimp Unified Axis & Unit Export Contract'
description: 'Complete blueprint for a single, format-agnostic Assimp ExportProperty pair (EXPORT_TARGET_UPAXIS, EXPORT_TARGET_UNIT_SCALE_TO_METERS) replacing the 3MF-only knobs, with full per-format option inventory, current-state defaults matrix, and Tau-side schema cutover plan.'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: architecture
related:
  - docs/research/openscad-3mf-coordinate-orientation.md
  - docs/research/3mf-export-scale-orientation-manifold.md
  - docs/research/assimp-transform-architecture-landscape.md
  - docs/research/import-test-geometry-deviation-audit.md
  - docs/research/converter-runtime-consolidation.md
---

# Assimp Unified Axis & Unit Export Contract

A target-frame override mechanism that makes every bake-capable Assimp exporter — 3MF, FBX, DAE, USD, OBJ, PLY, STL, X, X3D, 3DS, glTF2 — consult the same two `ExportProperty` keys, with a complete per-format option inventory documenting every property each exporter reads today and how the cutover preserves their defaults.

## Executive Summary

The current Assimp fork has **three** incompatible axis/unit-control patterns that this work unifies:

1. **3MF** (`Lib3MFBridge.cpp`) — uses dedicated `ExportProperty` strings (`3MF_EXPORT_UPAXIS`, `3MF_EXPORT_UNIT`) and an **inline bake loop** that resolves the target from properties.
2. **glTF2** (`glTF2Exporter.cpp`) — uses an **inline bake loop** with `constexpr` target constants and reads the source frame from `aiScene::mMetaData` via shared `UnitAxisContract` helpers.
3. **All other bake-capable exporters** (FBX, DAE, USD, 3DS, OBJ, PLY, STL, X, X3D) — call the shared `bakeContractTransformIntoMeshes` helper with `constexpr` target constants and never read `ExportProperties` for axis/unit.

Total exporter set covered:

| Format                    | Pattern today                               | Reads source from `aiScene::mMetaData` | Header tag to sync                         |
| ------------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| **3MF**                   | Inline bake, target from properties         | yes                                    | lib3mf model unit                          |
| **FBX**                   | Helper bake, hardcoded target               | yes (helper)                           | `GlobalSettings::UpAxis`/`UnitScaleFactor` |
| **DAE**                   | Helper bake, hardcoded target               | yes (helper)                           | `<up_axis>`, `<unit>`                      |
| **USDA/USDZ**             | Helper bake, hardcoded target               | yes (helper)                           | `Stage::upAxis`, `metersPerUnit`           |
| **3DS**                   | Helper bake, hardcoded target               | yes (helper)                           | none (`MASTER_SCALE = 1.0` literal)        |
| **OBJ**                   | Helper bake, hardcoded target               | yes (helper)                           | none                                       |
| **PLY**                   | Helper bake, hardcoded target               | yes (helper)                           | none                                       |
| **STL**                   | Helper bake, hardcoded target               | yes (helper)                           | none                                       |
| **X** (DirectX)           | Helper bake, hardcoded target               | yes (helper)                           | none                                       |
| **X3D**                   | Helper bake (inline call), hardcoded target | yes (helper)                           | none                                       |
| **glTF2** (gltf+glb)      | Inline bake, hardcoded target               | yes (manual)                           | none (spec invariant Y-up + meters)        |
| **STEP**                  | No bake (per-node world matrices)           | no                                     | hardcoded `SI_UNIT(.MILLI.,.METRE.)`       |
| **M3D / Assxml / Assbin** | No bake                                     | no                                     | n/a (debug/native)                         |

**Recommendation**: introduce a single, universal `ExportProperty` pair — `AI_CONFIG_EXPORT_TARGET_UPAXIS` (`int32_t`) and `AI_CONFIG_EXPORT_TARGET_UNIT_SCALE_TO_METERS` (`double`) — plus a `resolveExportTarget(props, defaultUnit, defaultAxis)` helper. Every bake-capable exporter consults this helper to compute the effective target, then either passes the resolved pair to `bakeContractTransformIntoMeshes` (helper-bake formats) or feeds it into its own inline bake loop (3MF, glTF2). Format-specific header writers (FBX `GlobalSettings`, DAE `<asset>`, USD `Stage`) read the same resolved pair so vertices and headers never disagree. **Delete `3MF_EXPORT_UPAXIS` and `3MF_EXPORT_UNIT` outright** (no precedence rules, no aliases) — Lib3MFBridge is a Tau-fork addition with zero external consumers. **Reject overrides for glTF/GLB at the Tau-side Zod schema** (spec invariant); Assimp-side defense in depth via `DeadlyExportError`.

The Tau-side surface collapses to one shared `axisAndUnitSchema` Zod fragment + per-format extension schemas surfacing the format-specific options that are currently inaccessible (USDZ animations, FBX transparency, STL point clouds, X 64-bit header, OBJ/FBX vertex join, glTF2 PBR/extras, 3MF application + decimal precision).

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Methodology](#methodology)
3. [Findings](#findings)
4. [Recommendations](#recommendations)
5. [Per-Format Option Inventory](#per-format-option-inventory)
6. [Per-Format Patch Matrix](#per-format-patch-matrix)
7. [Current-State Defaults Matrix](#current-state-defaults-matrix)
8. [Tau-Side Delta](#tau-side-delta)
9. [Trade-offs](#trade-offs)
10. [Diagrams](#diagrams)
11. [Open Questions and Nuances](#open-questions-and-nuances)
12. [Implementation Phasing](#implementation-phasing)

## Problem Statement

Following the OpenSCAD→3MF orientation investigation (`docs/research/openscad-3mf-coordinate-orientation.md`), the planned fix consolidated coordinate-system control on the converter transcoder edge for 3MF only — wiring a `coordinateSystem` field on `threeMfSchema` to the existing `3MF_EXPORT_UPAXIS` property. This left every other Assimp-routed format (USDZ, FBX, DAE, OBJ, PLY, STL, X3D, X) unable to honor a user's axis preference, falling back to whatever target each exporter had hardcoded.

The user's directive — _"the divergence between 3mf (`3MF_EXPORT_UPAXIS`) and all other formats is unacceptable, we need a unified approach"_ — forces a deeper question: what is the correct architectural primitive for cross-format target-frame control inside Assimp, and how does it map to Tau's existing converter transcoder schema?

A second directive — _"avoid 3mf backwards compat since we are the ones adding lib3mf bridging support, we have full control over what happens there. we need to ensure there are no confusing overloads and conditions like this one across the board"_ — eliminates the temptation to keep `3MF_EXPORT_UPAXIS` as a deprecated alias. The unified mechanism replaces the 3MF keys entirely; no fallback, no precedence, no conditional behavior.

A third directive — _"do another deep pass over all formats to ensure we have accurate and complete information for all options they are taking to ensure a clean cutover"_ — drives the per-format option inventory captured here as a binding blueprint.

## Methodology

Three parallel structured audits of the Assimp fork at `/Users/rifont/git/tau/repos/assimpjs/`, dispatched as exploration subagents:

1. **Batch 1**: `3MF`, `FBX`, `glTF2`, `Step` — high-complexity exporters with format-specific spec constraints.
2. **Batch 2**: `Collada`, `USD` (USDA + USDZ), `X` — header-writing formats with non-trivial metadata blocks.
3. **Batch 3**: `3DS`, `OBJ`, `PLY`, `STL`, `X3D`, `M3D`, `Assxml`, `Assbin` — simpler bake or no-bake formats; also a completeness sweep for `bakeContractTransformIntoMeshes` call sites.

Each subagent produced a structured matrix per format covering: output extensions, exporter source files, every `pProperties->GetProperty*` call (with default and validation), the bake call site (with hardcoded constants), the header/metadata writer (with source of axis/unit values), format-specific options to preserve, and special edge cases. Source files inspected: every `code/AssetLib/<Format>/<Format>Exporter.{cpp,h}`, `code/AssetLib/3MF/{Lib3MFBridge,D3MFExporter}.{cpp,h}`, `code/Common/UnitAxisContract.{h,cpp}`, `include/assimp/config.h.in`, `code/Common/Exporter.cpp` (registration table).

## Findings

### Finding 1: Three distinct bake patterns, not two

The unification primitive must accommodate three call patterns:

| Pattern                                      | Examples                                              | Target source today                         | `pProperties` forwarded to bake helper? |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| **A. Helper bake, hardcoded target**         | FBX, DAE, USD, 3DS, OBJ, PLY, STL, X, X3D (9 formats) | `constexpr` per exporter                    | No                                      |
| **B. Inline bake, properties-driven target** | 3MF (`Lib3MFBridge::exportToLib3MF` lines 434-453)    | `ExportProperties` strings + scene metadata | n/a (no helper call)                    |
| **C. Inline bake, hardcoded target**         | glTF2 (`glTF2Exporter.cpp` lines 1214-1256)           | `constexpr` + scene metadata                | n/a (no helper call)                    |

The unification primitive must therefore be a `resolveExportTarget(const ExportProperties* props, double defaultUnit, int32_t defaultAxis)` helper consumed by **all three patterns**, plus an extended `bakeContractTransformIntoMeshes(scene, unit, axis, requireOptIn, props)` overload that internally calls the resolver. Patterns A and C call `resolve` once at the top of their export function; pattern B calls `resolve` to replace its existing `3MF_EXPORT_*` reads.

### Finding 2: Scene metadata describes the source, not the target (unchanged from prior version)

`bakeContractTransformIntoMeshes` (`code/Common/UnitAxisContract.cpp`) reads `AI_METADATA_UNIT_SCALE_TO_METERS` and `AI_METADATA_UP_AXIS` from `aiScene::mMetaData` to determine the _source_ frame, then transforms vertices to the _target_ frame supplied by the caller as explicit `targetUnitToMeters` and `targetUpAxis` arguments. Injecting `AI_METADATA_UP_AXIS` from JavaScript would lie about the source and cause the bake to apply the wrong rotation. The unification primitive must operate at the _target-resolution_ layer.

### Finding 3: OpenSCAD non-GLB exports route entirely through the converter transcoder

`packages/runtime/src/kernels/openscad/openscad.kernel.ts:exportGeometry` only implements `case 'glb'` and `case 'gltf'`. `KernelWorker.executeExportWithRoute` (`packages/runtime/src/framework/kernel-worker.ts:2024-2115`) detects missing native handlers and routes via the converter transcoder — for OpenSCAD that means every `stl`, `3mf`, `obj`, `dae`, `usdz`, `fbx`, `ply`, `x`, `x3d`, `3ds` export traverses Assimp. Replicad has kernel-native STL and STEP with its own pre-rotation; those bypass the unified mechanism by design.

### Finding 4: Three formats write a format-specific header that must match the bake

| Format       | Header element                                                                          | Source today                                                                                                                                                                                                                                                               | Behavior under bake override (no patch)                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FBX**      | `GlobalSettings::UpAxis`, `UnitScaleFactor`, plus legacy `UpAxisSign`/`OriginalUpAxis*` | `rewriteSceneMetaForBakedFbxFrame` (`FBXExporter.cpp:116-167`) writes hardcoded `kFbxTargetUpAxis = 1` (Y-up) and `kFbxTargetUnitToMeters = 1e-2` (cm) into `aiScene::mMetaData`; `WriteGlobalSettings` (`542-570`) reads those keys via `WritePropInt`/`WritePropDouble`. | Vertices baked to overridden target; header still claims Y-up + cm → viewer applies inverse and double-corrects.                                           |
| **DAE**      | `<up_axis>`, `<unit meter="…">`                                                         | Root-node TRS decomposition with `Y_UP` + `scale=1` fallback (`ColladaExporter::WriteHeader` lines 246-377). Bake never touches `mRootNode->mTransformation`. **DAE reads zero `ExportProperties` today.**                                                                 | Header always emits whatever the root rotation matches (typically `Y_UP`) regardless of bake target. **Already inconsistent today** for any non-Y-up root. |
| **USD/USDZ** | `Stage::metas().upAxis`, `metersPerUnit`                                                | Hardcoded `tinyusdz::Axis::Y` and `1.0` in `USDZExporter::ExportMetadata` (lines 254-263). Constructor sets `mIsPackaged` to dispatch USDA vs USDZ; both share `ExportMetadata`.                                                                                           | Vertices rotated; AR viewer (Quick Look) re-applies Y-up assumption → object lies on its side.                                                             |

### Finding 5: Six formats have no axis header — bake alone defines output frame

OBJ, PLY, STL, X (DirectX), X3D, and 3DS encode no axis tag. STL binary header is an 80-byte string (`AssimpScene` + zeros); 3DS writes a fixed `MASTER_SCALE = 1.0f` chunk; OBJ/PLY/X3D headers carry only a generator comment; X writes only `xof 0303txt 003{2|6}4`. For these formats, vertex bake is the only output and the patch surface is purely the bake-call arguments.

### Finding 6: glTF2 is a spec invariant — overrides must be rejected

`glTF2Exporter::ExportMeshes` (lines 1214-1256) performs its own inline bake with `targetUnitToMeters = 1.0` and `targetUpAxis = 1`. The exporter writes no axis or unit field into the JSON `asset` block. The glTF 2.0 specification mandates Y-up + meters. Honoring an `EXPORT_TARGET_UPAXIS=2` override for `.glb` / `.gltf` would silently produce non-conformant output. Rejection happens at the Tau-side Zod schema (the field is not exposed on the `gltf` / `glb` edges). Defense-in-depth: have `glTF2Exporter` validate that neither `EXPORT_TARGET_*` key is present and throw `DeadlyExportError` if so.

### Finding 7: Lib3MFBridge, UnitAxisContract, and `3MF_EXPORT_*` are Tau-fork additions

- `code/AssetLib/3MF/Lib3MFBridge.{cpp,h}` ships only in this fork; gated by `#ifdef ASSIMP_USE_LIB3MF`.
- `code/Common/UnitAxisContract.{cpp,h}` carries Tau-coupled docstrings (`UnitAxisContract.h:59-61` references `docs/research/...` and `repos/assimpjs/...`).
- `repos/assimpjs/UPSTREAM_3MF_ISSUE_DRAFT.md` documents intent to upstream as a future Assimp PR; nothing merged upstream yet.
- `repos.yaml` lists `assimpjs` as a Tau fork.
- `3MF_EXPORT_*` keys appear only as **string literals** in `Lib3MFBridge.cpp` — they are NOT defined as `#define` macros in `config.h.in`. Workspace search: `3MF_EXPORT_UPAXIS` has zero matches under `packages/`. `3MF_EXPORT_UNIT` is referenced in Tau converter code (mostly JSDoc and tests; the actual property string flows through `withAssimpKeyMap`).

**Implication**: full freedom to delete both keys. No back-compat, no precedence, no aliases.

### Finding 8: 3MF unit string mapping has a silent-fallback bug today

`Lib3MFBridge.cpp:182-205` maps the `3MF_EXPORT_UNIT` string to a lib3mf `eUnit` enum:

| String            | meters per unit                  |
| ----------------- | -------------------------------- |
| `micron`          | 1e-6                             |
| `millimeter`      | 1e-3                             |
| `centimeter`      | 1e-2                             |
| `inch`            | 0.0254                           |
| `foot`            | 0.3048                           |
| `meter`           | 1.0                              |
| **anything else** | **silently → 1e-3 (millimeter)** |

The unified `EXPORT_TARGET_UNIT_SCALE_TO_METERS` is a `double` directly; the silent-fallback class disappears at the property layer. Lib3MFBridge maps the float back to lib3mf `eUnit` via a closest-match table with tight tolerance and **throws `DeadlyExportError` for non-matching values** (six discrete enum constants). The pre-existing silent-fallback bug is fixed as a side effect of the cutover.

### Finding 9: glTF2 has an upstream macro typo

`include/assimp/config.h.in:1535-1536`:

```c
#define AI_CONFIG_EXPORT_GLTF_UNLIMITED_SKINNING_BONES_PER_VERTEX \
        "USE_UNLIMITED_BONES_PER VERTEX"
```

The macro value contains a literal space before `VERTEX`. C++ callers using the macro are unaffected; any external consumer setting the property by string must replicate the typo. Documented for awareness; not in scope to fix here.

### Finding 10: Multi-registration formats — single C++ exporter, multiple format IDs

The Assimp `Exporter.cpp` registration table maps several format IDs to the same C++ entry function. Tau-side schema must mirror these splits if/when surfacing format-specific options:

| Tau format ID | Assimp registration | Entry function         | Notes                                          |
| ------------- | ------------------- | ---------------------- | ---------------------------------------------- |
| `obj`         | `obj`               | `ExportSceneObj`       | Writes `.obj` + `.mtl`                         |
| `objnomtl`    | `objnomtl`          | `ExportSceneObjNoMtl`  | Writes `.obj` only — **distinct registration** |
| `ply`         | `ply`               | `ExportScenePly`       | ASCII                                          |
| `plyb`        | `plyb`              | `ExportScenePlyBinary` | Binary — distinct registration                 |
| `stl`         | `stl`               | `ExportSceneSTL`       | ASCII                                          |
| `stlb`        | `stlb`              | `ExportSceneSTLBinary` | Binary — distinct registration                 |
| `fbx`         | `fbx`               | `ExportSceneFBX`       | Binary                                         |
| `fbxa`        | `fbxa`              | `ExportSceneFBXA`      | ASCII — distinct registration                  |
| `gltf2`       | `gltf2`             | `ExportSceneGLTF2`     | JSON + buffer files                            |
| `glb2`        | `glb2`              | `ExportSceneGLB2`      | Binary glTF — distinct registration            |
| `m3d`         | `m3d`               | `ExportSceneM3D`       | Binary                                         |
| `a3d`         | `a3d`               | `ExportSceneM3DA`      | ASCII — distinct registration                  |
| `usda`        | `usda`              | `ExportSceneUSDA`      | Text                                           |
| `usdz`        | `usdz`              | `ExportSceneUSDZ`      | Zipped — distinct registration                 |

For axis/unit purposes, the ASCII/binary variants share the same bake and same target defaults; only the writer changes. Tau-side `axisAndUnitSchema` extends both variants identically.

### Finding 11: STEP is a real Assimp exporter but does not bake

`code/AssetLib/Step/StepExporter.cpp` is a **complete geometry exporter** (not a stub). It writes ISO-10303-21 / AP214-style text with `CARTESIAN_POINT`, `FACE_SURFACE`, `PLANE`, edge loops, etc. (lines 159-405). It reads zero `ExportProperties`. It does not call `bakeContractTransformIntoMeshes`. Vertices flow through per-node world matrices from the scene graph; the file header hardcodes `SI_UNIT(.MILLI.,.METRE.)` (mm, line 253). Tau's `converterEdgeSchemas.step = noEdgeOptions` is therefore **valid** — the converter can route STEP through Assimp.

**Implication**: STEP is **out of scope** for this unified work, but adding bake support to STEP is feasible in a follow-up. Document the routing decision in `runtime-export-pipeline-policy.md` so future contributors don't assume the converter doesn't handle STEP.

### Finding 12: Many format-specific options are inaccessible from Tau today

Most converter edges in `packages/runtime/src/transcoders/converter/converter-export-options.ts` are `noEdgeOptions`, meaning users cannot set any per-format Assimp option except for 3MF (`unit`, `application`). The unified work creates a natural opportunity to surface every property each exporter actually reads. See [Per-Format Option Inventory](#per-format-option-inventory) for the complete list.

## Recommendations

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                     | Priority | Effort | Impact                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ | --------------------------------------------------------------------------------------- |
| R1  | Add `AI_CONFIG_EXPORT_TARGET_UPAXIS` (`int32_t`) and `AI_CONFIG_EXPORT_TARGET_UNIT_SCALE_TO_METERS` (`double`) macros to `include/assimp/config.h.in`                                                                                                                                                                                                                                                                                      | P0       | XS     | Foundation                                                                              |
| R2  | Add `resolveExportTarget(const ExportProperties* props, double defaultUnit, int32_t defaultAxis) -> {double unit, int32_t axis, bool overridden}` helper in `UnitAxisContract.{h,cpp}`. `validateUpAxisInt` for axis; `> 0 && finite` for unit; throw `DeadlyExportError` on invalid.                                                                                                                                                      | P0       | S      | Single resolution point used by all three bake patterns                                 |
| R3  | Extend `bakeContractTransformIntoMeshes` with a `const ExportProperties* pProperties` parameter (defaulted to `nullptr`); when provided, internally call `resolveExportTarget(...)`. When `overridden == true`, force `requireOptIn = false` so the bake always runs.                                                                                                                                                                      | P0       | S      | Pattern-A formats just forward `pProperties`; behavior unchanged for callers that don't |
| R4  | Patch every Pattern-A bake call site to forward `pProperties` to `bakeContractTransformIntoMeshes`. Files: `3DS/3DSExporter.cpp`, `Obj/ObjExporter.cpp`, `Ply/PlyExporter.cpp`, `STL/STLExporter.cpp`, `X3D/X3DExporter.cpp`, `X/XFileExporter.cpp`, `USD/USDZExporter.cpp` (`bakeUsdContract`), `FBX/FBXExporter.cpp` (`bakeFbxContract`), `Collada/ColladaExporter.cpp` (`bakeColladaContract`)                                          | P0       | M      | Pattern-A formats covered                                                               |
| R5  | Refactor 3MF inline bake (`Lib3MFBridge::exportToLib3MF` lines 309-454) to call `resolveExportTarget(pProperties, /*defaultUnit*/ 1e-3, /*defaultAxis*/ 2)`. **Delete** the `3MF_EXPORT_UNIT` and `3MF_EXPORT_UPAXIS` reads (lines 314-334). Move `3MF_EXPORT_APPLICATION` and `3MF_EXPORT_DECIMAL_PRECISION` reads under their existing names (these stay format-scoped).                                                                 | P0       | S      | Pattern-B unified, dual-key precedence eliminated                                       |
| R6  | Refactor glTF2 inline bake (`glTF2Exporter.cpp:1214-1256`) to call `resolveExportTarget(pProperties, 1.0, 1)`. If `overridden == true`, throw `DeadlyExportError("glTF 2.0 mandates Y-up + meters; EXPORT_TARGET_* overrides are not supported for .gltf/.glb")`.                                                                                                                                                                          | P0       | S      | Pattern-C spec invariant enforced; defense in depth                                     |
| R7  | Patch `FBXExporter::rewriteSceneMetaForBakedFbxFrame` and `WriteGlobalSettings` to accept the resolved `(unit, axis)` pair. Map axis int → FBX `UpAxis` / `UpAxisSign` / `OriginalUpAxis` / `OriginalUpAxisSign` constants per the FBX SDK contract (Y=1+1, Z=2+1, X=0+1). Compute `UnitScaleFactor` as `unit * 100.0` (FBX expresses scale in cm).                                                                                        | P0       | M      | Eliminates header-vs-vertex desync for FBX                                              |
| R8  | Patch `ColladaExporter::WriteHeader` (lines 246-377) to emit `<up_axis>` and `<unit meter="…">` from the resolved target, **bypassing** the root-TRS decomposition + `mAdd_root_node` fallback for the asset-block axis/unit. The `mAdd_root_node` synthetic-root logic remains for non-axis-aligned root _rotations_; it just no longer determines `<up_axis>`.                                                                           | P0       | M      | Fixes pre-existing latent inconsistency and supports overrides                          |
| R9  | Patch `USDZExporter::ExportMetadata` (lines 254-263) to set `stageMeta.upAxis` and `stageMeta.metersPerUnit` from the resolved target. Map `EXPORT_TARGET_UPAXIS=0/1/2 → tinyusdz::Axis::X/Y/Z`.                                                                                                                                                                                                                                           | P0       | S      | Required for AR viewers to honor non-default targets                                    |
| R10 | Update Assimp unit tests (`test/unit/utD3MFImportExport.cpp` lines 419, 438, 442, 631) to use the new universal keys. Add new parameterized tests covering axis/unit overrides for FBX, DAE, USD, OBJ, STL, 3MF.                                                                                                                                                                                                                           | P0       | M      | Regression coverage                                                                     |
| R11 | Add `axisAndUnitSchema` to `packages/runtime/src/transcoders/converter/converter-export-options.ts`. Merge into every Pattern-A and Pattern-B converter edge (`3mf`, `3ds`, `dae`, `fbx`, `fbxa`, `obj`, `objnomtl`, `ply`, `plyb`, `stl`, `stlb`, `usda`, `usdz`, `x`, `x3d`). Exclude `gltf`, `glb`, `step`.                                                                                                                             | P0       | S      | Tau-side surface for the unified mechanism                                              |
| R12 | Enhance `withAssimpKeyMap` to support per-key value transforms (string-enum → double), enabling `unit` enum → `EXPORT_TARGET_UNIT_SCALE_TO_METERS` double and `coordinateSystem` enum → `EXPORT_TARGET_UPAXIS` int.                                                                                                                                                                                                                        | P0       | S      | Foundation already drafted in the parent plan                                           |
| R13 | Surface format-specific options that are currently inaccessible: `threeMfSchema` keeps `application` + adds `decimalPrecision` (with `[1, 16]` validation); add `fbxSchema` (transparency + join), `objSchema` (join), `stlSchema` (allow point clouds), `xSchema` (64-bit header), `usdzSchema` (animations, clearcoat, materialx, subdivision, volumes, optimizeForMobile). See [Tau-Side Delta](#tau-side-delta) for the schema shapes. | P1       | M      | Unlocks format features for users                                                       |
| R14 | Rebuild WASM via `repos/assimpjs/tools/build_wasm_deb.sh`, regenerate npm tarball under `tarballs/`, update root and `packages/runtime` package.json, run `pnpm install`                                                                                                                                                                                                                                                                   | P0       | M      | Activates the C++ patches in Tau                                                        |
| R15 | Update `repos/assimpjs/UPSTREAM_3MF_ISSUE_DRAFT.md` to reflect the unified contract (now generic, not 3MF-specific). Title becomes "Universal Export Target Frame Override".                                                                                                                                                                                                                                                               | P1       | S      | Positions for upstream contribution                                                     |
| R16 | Document the cutover in `docs/policy/runtime-export-pipeline-policy.md`: GLB Y-up + meters invariant, the unified `EXPORT_TARGET_*` contract, the spec-invariant rejection rule for glTF, and the kernel-native bypass for Replicad STL/STEP.                                                                                                                                                                                              | P0       | S      | Codifies the new convention                                                             |

## Per-Format Option Inventory

Complete inventory of every `ExportProperties` key each Assimp exporter reads today, with macros, defaults, and format-scope rationale. **Tau column** indicates whether the option is currently surfaced on the converter edge schema (✅) or inaccessible (✗). **Cutover** indicates the target post-unification state.

### 3MF (`Lib3MFBridge.cpp`)

| Property                       | Macro | Type        | Default        | Validation                               | Tau today | Cutover                                                                                          |
| ------------------------------ | ----- | ----------- | -------------- | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `3MF_EXPORT_UNIT`              | none  | string enum | `"millimeter"` | silent fallback to mm for unknown (BUG)  | ✅        | **DELETE** → `EXPORT_TARGET_UNIT_SCALE_TO_METERS` (double) via `axisAndUnitSchema`               |
| `3MF_EXPORT_UPAXIS`            | none  | int         | `2` (Z)        | `validateUpAxisInt` [0,2]                | ✗         | **DELETE** → `EXPORT_TARGET_UPAXIS` via `axisAndUnitSchema`                                      |
| `3MF_EXPORT_APPLICATION`       | none  | string      | `""`           | empty skips metadata                     | ✅        | **KEEP** as `application` on `threeMfSchema`                                                     |
| `3MF_EXPORT_DECIMAL_PRECISION` | none  | int         | `9`            | lib3mf `[1, 16]`, throws on out-of-range | ✗         | **SURFACE** as `decimalPrecision: z.number().int().min(1).max(16).default(9)` on `threeMfSchema` |

### FBX (`FBXExporter.cpp`)

| Property                                          | Macro                                                       | Type | Default | Validation | Tau today | Cutover                                                           |
| ------------------------------------------------- | ----------------------------------------------------------- | ---- | ------- | ---------- | --------- | ----------------------------------------------------------------- |
| `EXPORT_FBX_TRANSPARENCY_FACTOR_REFER_TO_OPACITY` | `AI_CONFIG_EXPORT_FBX_TRANSPARENCY_FACTOR_REFER_TO_OPACITY` | bool | `false` | none       | ✗         | **SURFACE** as `transparencyFactorRefersToOpacity` on `fbxSchema` |
| `bJoinIdenticalVertices`                          | none (set by `Exporter.cpp` from PP flags)                  | bool | `true`  | none       | ✗         | **SURFACE** as `joinIdenticalVertices` on `fbxSchema`             |

### glTF2 (`glTF2Exporter.cpp`)

| Property                             | Macro                                                                                   | Type     | Default | Tau today | Cutover                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- | -------- | ------- | --------- | -------------------------------------------------------- |
| `CHECK_IDENTITY_MATRIX_EPSILON`      | `AI_CONFIG_CHECK_IDENTITY_MATRIX_EPSILON`                                               | float    | `10e-3` | ✗         | **OPTIONAL** surface (advanced)                          |
| `extras`                             | (callback)                                                                              | callback | n/a     | ✗         | **NOT SURFACED** (callback-only API)                     |
| `USE_GLTF_PBR_SPECULAR_GLOSSINESS`   | `AI_CONFIG_USE_GLTF_PBR_SPECULAR_GLOSSINESS`                                            | bool     | `false` | ✗         | **OPTIONAL** surface (deprecated extension)              |
| `USE_UNLIMITED_BONES_PER VERTEX`     | `AI_CONFIG_EXPORT_GLTF_UNLIMITED_SKINNING_BONES_PER_VERTEX` (typo: space before VERTEX) | bool     | `false` | ✗         | **OPTIONAL** surface                                     |
| `GLTF2_SPARSE_ACCESSOR_EXP`          | none                                                                                    | bool     | `false` | ✗         | **NOT SURFACED** (experimental)                          |
| `GLTF2_TARGET_NORMAL_EXP`            | none                                                                                    | bool     | `false` | ✗         | **NOT SURFACED** (experimental)                          |
| `GLTF2_TARGETNAMES_EXP`              | none                                                                                    | bool     | `false` | ✗         | **NOT SURFACED** (experimental)                          |
| `GLTF2_CUSTOMIZE_PROPERTY`           | none                                                                                    | bool     | `false` | ✗         | **NOT SURFACED** (advanced)                              |
| `GLTF2_NODE_IN_TRS`                  | none                                                                                    | bool     | `false` | ✗         | **NOT SURFACED** (advanced)                              |
| `EXPORT_TARGET_UPAXIS`               | new                                                                                     | int      | n/a     | ✗         | **REJECT** (spec invariant) — throws `DeadlyExportError` |
| `EXPORT_TARGET_UNIT_SCALE_TO_METERS` | new                                                                                     | double   | n/a     | ✗         | **REJECT** (spec invariant)                              |

### Collada / DAE (`ColladaExporter.cpp`)

| Property              | Macro | Type | Default | Tau today | Cutover                                                                          |
| --------------------- | ----- | ---- | ------- | --------- | -------------------------------------------------------------------------------- |
| **(none read today)** | —     | —    | —       | ✗         | Adds `EXPORT_TARGET_*` via `axisAndUnitSchema`; no other format-specific options |

### USD (USDA + USDZ, `USDZExporter.cpp`)

| Property                   | Macro | Type | Default | Tau today | Cutover                                                                                           |
| -------------------------- | ----- | ---- | ------- | --------- | ------------------------------------------------------------------------------------------------- |
| `USDZ_EXPORT_ANIMATIONS`   | none  | bool | `true`  | ✗         | **SURFACE** as `exportAnimations` on `usdzSchema` (defaults to true to preserve current behavior) |
| `USDZ_EXPORT_CLEARCOAT`    | none  | bool | `true`  | ✗         | **SURFACE** as `exportClearcoat` on `usdzSchema`                                                  |
| `USDZ_EXPORT_MATERIALX`    | none  | bool | `false` | ✗         | **SURFACE** as `exportMaterialX` on `usdzSchema`                                                  |
| `USDZ_EXPORT_SUBDIVISION`  | none  | bool | `false` | ✗         | **SURFACE** as `exportSubdivision` on `usdzSchema`                                                |
| `USDZ_EXPORT_VOLUMES`      | none  | bool | `false` | ✗         | **SURFACE** as `exportVolumes` on `usdzSchema`                                                    |
| `USDZ_OPTIMIZE_FOR_MOBILE` | none  | bool | `true`  | ✗         | **SURFACE** as `optimizeForMobile` on `usdzSchema`                                                |

### X (DirectX, `XFileExporter.cpp`)

| Property             | Macro                          | Type | Default | Tau today | Cutover                                   |
| -------------------- | ------------------------------ | ---- | ------- | --------- | ----------------------------------------- |
| `EXPORT_XFILE_64BIT` | `AI_CONFIG_EXPORT_XFILE_64BIT` | bool | `false` | ✗         | **SURFACE** as `header64Bit` on `xSchema` |

### OBJ (`ObjExporter.cpp`)

| Property                 | Macro | Type | Default | Tau today | Cutover                                               |
| ------------------------ | ----- | ---- | ------- | --------- | ----------------------------------------------------- |
| `bJoinIdenticalVertices` | none  | bool | `true`  | ✗         | **SURFACE** as `joinIdenticalVertices` on `objSchema` |

### STL (`STLExporter.cpp`)

| Property              | Macro                           | Type | Default | Tau today | Cutover                                                                                  |
| --------------------- | ------------------------------- | ---- | ------- | --------- | ---------------------------------------------------------------------------------------- |
| `EXPORT_POINT_CLOUDS` | `AI_CONFIG_EXPORT_POINT_CLOUDS` | bool | `false` | ✗         | **SURFACE** as `exportPointClouds` on `stlSchema` (binary STL throws if true — document) |

### PLY, X3D, 3DS, M3D, Assxml, Assbin

**Read zero `ExportProperties`** — no format-specific options to surface beyond `axisAndUnitSchema` (where applicable). Bake-capable: PLY, X3D, 3DS. Non-bake: M3D, Assxml, Assbin (debug formats — deliberately preserve scene metadata as-is, no axis/unit override).

### STEP (`StepExporter.cpp`)

Reads zero `ExportProperties`. Does not bake. Hardcoded `SI_UNIT(.MILLI.,.METRE.)` header. Out of scope for this work; document in `runtime-export-pipeline-policy.md` that STEP from Assimp is fixed mm.

## Per-Format Patch Matrix

C++ patches required to enable the unified contract. Each row lists the bake-call patch and the header/metadata-writer patch (where applicable).

| Format        | Pattern    | Bake-call patch                                                                                             | Header/metadata patch                                                                            | Schema-level rejection? |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| 3MF           | B (inline) | Refactor `exportToLib3MF` to call `resolveExportTarget`; delete `3MF_EXPORT_UPAXIS`/`3MF_EXPORT_UNIT` reads | Update `lib3mf_model_setunit` and `vertexScale`/`buildAxisRotationMatrix` to use resolved values | n/a                     |
| FBX           | A (helper) | Forward `pProperties` to `bakeContractTransformIntoMeshes`; receive resolved `(unit, axis)` back            | Patch `rewriteSceneMetaForBakedFbxFrame` + `WriteGlobalSettings`                                 | n/a                     |
| DAE           | A (helper) | Forward `pProperties` to bake                                                                               | Patch `WriteHeader` to emit resolved `<up_axis>`/`<unit>`                                        | n/a                     |
| USD/USDZ      | A (helper) | Forward `pProperties` to bake                                                                               | Patch `ExportMetadata` to set `stageMeta.upAxis` + `metersPerUnit` from resolved                 | n/a                     |
| 3DS           | A (helper) | Forward `pProperties` to bake                                                                               | none (no header tag)                                                                             | n/a                     |
| OBJ           | A (helper) | Forward `pProperties` to bake                                                                               | none                                                                                             | n/a                     |
| PLY           | A (helper) | Forward `pProperties` to bake                                                                               | none                                                                                             | n/a                     |
| STL           | A (helper) | Forward `pProperties` to bake                                                                               | none                                                                                             | n/a                     |
| X             | A (helper) | Forward `pProperties` to bake                                                                               | none                                                                                             | n/a                     |
| X3D           | A (helper) | Forward `pProperties` to bake                                                                               | none                                                                                             | n/a                     |
| glTF2         | C (inline) | Refactor inline bake to call `resolveExportTarget`; if `overridden`, throw `DeadlyExportError`              | none (spec invariant)                                                                            | YES (throw on override) |
| STEP          | (no bake)  | n/a                                                                                                         | n/a                                                                                              | n/a (out of scope)      |
| M3D           | (no bake)  | n/a                                                                                                         | n/a                                                                                              | n/a (out of scope)      |
| Assxml/Assbin | (no bake)  | n/a                                                                                                         | n/a                                                                                              | n/a (debug formats)     |

## Current-State Defaults Matrix

Critical reference for cutover validation: every bake-capable exporter's current target frame, which becomes the default that `axisAndUnitSchema` must produce when the user does not specify `unit` or `coordinateSystem`. **Diverging defaults are deliberate** (each format mirrors its conventional frame on round-trip) and `axisAndUnitSchema.default('z-up') / default('millimeter')` would change behavior — instead, the resolver helper returns the per-exporter defaults when no override is present.

| Format      | Target unit (m/unit) | Target up-axis | Convention rationale                               |
| ----------- | -------------------- | -------------- | -------------------------------------------------- |
| 3MF         | 1e-3 (millimeter)    | 2 (Z-up)       | 3MF Core spec                                      |
| FBX         | 1e-2 (centimeter)    | 1 (Y-up)       | Autodesk FBX SDK convention                        |
| DAE         | 1.0 (meter)          | 1 (Y-up)       | COLLADA spec default                               |
| USD/USDZ    | 1.0 (meter)          | 1 (Y-up)       | USD AR convention; Apple Quick Look                |
| 3DS         | 1.0 (meter)          | 2 (Z-up)       | 3D Studio convention (importer canonicalizes here) |
| OBJ         | 1.0 (meter)          | 1 (Y-up)       | Wavefront convention (axis-less spec)              |
| PLY         | 1.0 (meter)          | 1 (Y-up)       | Stanford convention (axis-less spec)               |
| STL         | 1e-3 (millimeter)    | 2 (Z-up)       | 3D-printing convention                             |
| X (DirectX) | 1.0 (meter)          | 1 (Y-up)       | DirectX LH coordinate system                       |
| X3D         | 1.0 (meter)          | 1 (Y-up)       | X3D spec                                           |
| glTF2       | 1.0 (meter)          | 1 (Y-up)       | glTF 2.0 spec mandate                              |

**Schema implication**: `axisAndUnitSchema` does NOT set its own defaults. Instead, the field is `optional()`. The Tau converter omits the `EXPORT_TARGET_*` properties from the property record when the user passes nothing, and `resolveExportTarget` returns the per-exporter `(defaultUnit, defaultAxis)` constants. This preserves existing per-format defaults exactly.

## Tau-Side Delta

### Add: shared schema fragment (no defaults)

```typescript
// packages/runtime/src/transcoders/converter/converter-export-options.ts

const unitToMetersMap = {
  micron: 1e-6,
  millimeter: 1e-3,
  centimeter: 1e-2,
  inch: 0.0254,
  foot: 0.3048,
  meter: 1,
} as const;

type UnitName = keyof typeof unitToMetersMap;

const axisAndUnitSchema = z.object({
  unit: z
    .enum(['micron', 'millimeter', 'centimeter', 'inch', 'foot', 'meter'])
    .optional()
    .describe('Unit of measurement encoded in the exported file. Omit to use the format default.'),
  coordinateSystem: z
    .enum(['y-up', 'z-up'])
    .optional()
    .describe('Up-axis convention encoded in the exported file. Omit to use the format default.'),
});

const axisAndUnitKeyMap = {
  unit: {
    key: 'EXPORT_TARGET_UNIT_SCALE_TO_METERS',
    transform: (v: UnitName) => unitToMetersMap[v],
  },
  coordinateSystem: {
    key: 'EXPORT_TARGET_UPAXIS',
    transform: (v: 'y-up' | 'z-up') => (v === 'z-up' ? 2 : 1),
  },
} as const;
```

### Add: format-specific schemas (R13)

```typescript
const threeMfSchema = axisAndUnitSchema.extend({
  application: z.string().optional().describe('Creating application metadata'),
  decimalPrecision: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(9)
    .describe('Decimal precision for vertex coordinates [1, 16]'),
});

const fbxSchema = axisAndUnitSchema.extend({
  joinIdenticalVertices: z.boolean().default(true),
  transparencyFactorRefersToOpacity: z.boolean().default(false),
});

const objSchema = axisAndUnitSchema.extend({
  joinIdenticalVertices: z.boolean().default(true),
});

const stlSchema = axisAndUnitSchema.extend({
  exportPointClouds: z
    .boolean()
    .default(false)
    .describe('Export point clouds (ASCII only — binary STL throws if true)'),
});

const xSchema = axisAndUnitSchema.extend({
  header64Bit: z.boolean().default(false).describe('Emit 64-bit DirectX .x header'),
});

const usdzSchema = axisAndUnitSchema.extend({
  exportAnimations: z.boolean().default(true),
  exportClearcoat: z.boolean().default(true),
  exportMaterialX: z.boolean().default(false),
  exportSubdivision: z.boolean().default(false),
  exportVolumes: z.boolean().default(false),
  optimizeForMobile: z.boolean().default(true),
});
```

### Modify: `withAssimpKeyMap`

Accept either flat string mapping (today's contract) or enriched mapping with per-key value transforms. The enriched mapping handles the unit-string-to-double conversion and the axis-enum-to-int conversion atomically. Backward compatible with the existing 3MF entries that get migrated.

### Modify: `converterEdgeSchemas`

Replace `noEdgeOptions` per the [Per-Format Option Inventory](#per-format-option-inventory):

| Edge   | Was                   | Becomes                                                           |
| ------ | --------------------- | ----------------------------------------------------------------- |
| `3mf`  | `threeMfSchema` (old) | `threeMfSchema` (new with axis+unit+application+decimalPrecision) |
| `3ds`  | `noEdgeOptions`       | `axisAndUnitSchema`                                               |
| `dae`  | `noEdgeOptions`       | `axisAndUnitSchema`                                               |
| `fbx`  | `noEdgeOptions`       | `fbxSchema`                                                       |
| `obj`  | `noEdgeOptions`       | `objSchema`                                                       |
| `ply`  | `noEdgeOptions`       | `axisAndUnitSchema`                                               |
| `stl`  | `noEdgeOptions`       | `stlSchema`                                                       |
| `usda` | `noEdgeOptions`       | `axisAndUnitSchema`                                               |
| `usdz` | `noEdgeOptions`       | `usdzSchema`                                                      |
| `x`    | `noEdgeOptions`       | `xSchema`                                                         |
| `x3d`  | `noEdgeOptions`       | `axisAndUnitSchema`                                               |
| `gltf` | `noEdgeOptions`       | `noEdgeOptions` (unchanged — spec invariant)                      |
| `step` | `noEdgeOptions`       | `noEdgeOptions` (unchanged — out of scope)                        |

### Migration of existing `3MF_EXPORT_UNIT` consumers

`packages/converter/src/{conversion.ts:74, export.ts:45, exporters/assimp.exporter.ts:38}` reference `3MF_EXPORT_UNIT` only in JSDoc / log messages, not as hardcoded property keys (the actual key flows in via `exportProperties`). Update the JSDoc to the new key name. Tests in `export.test.ts:634-669`, `converter.transcoder.test.ts:155-176`, and `converter-export-options.test.ts:42-66` assert on the property string `3MF_EXPORT_UNIT` — those assertions become `EXPORT_TARGET_UNIT_SCALE_TO_METERS` with the value asserted as `0.001` (double) instead of `'millimeter'` (string).

### Unchanged

- `assimpjs.cpp` — no Embind changes; no new overloads.
- `packages/converter/src/exporters/assimp.exporter.ts` — `exportProperties` argument continues to flow through `ConvertFileList`.
- `packages/converter/src/conversion.ts:exportFromGlb` — already forwards `exportProperties` (verified).
- `packages/converter/src/types/assimpjs.d.ts` — no change.
- `RuntimeClient` typings — `MergeExportMap` automatically picks up the new fields from the wider edge schemas.

## Trade-offs

### Approach A: Universal `EXPORT_TARGET_*` ExportProperties (recommended)

| Pros                                                                                       | Cons                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Leverages Assimp's existing `ExportProperties` mechanism — proven by 3MF                   | Requires patching every bake-capable exporter (~11 files including 3MF + glTF2 inline bakes) |
| No new Embind APIs in `assimpjs.cpp`; no `.d.ts` extensions                                | Requires WASM rebuild + tarball regeneration                                                 |
| Single resolution helper; identical pattern across formats                                 | Header writers (FBX/DAE/USD) need additional patches                                         |
| Trivial Tau-side delta (one schema fragment + key-map enhancement + per-format extensions) | Out-of-tree C++ consumers of `3MF_EXPORT_*` would break (none exist)                         |
| Defense in depth: schema-level rejection for spec-invariant formats                        |                                                                                              |
| Surfaces previously-inaccessible per-format options as a free win                          |                                                                                              |

### Approach B: Universal scene-metadata override (rejected)

Inject `AI_METADATA_UP_AXIS` from the JS layer to coerce `bakeContractTransformIntoMeshes` to apply the desired rotation. **Architecturally wrong**: scene metadata describes the source frame. Lying about the source to coerce the target would silently produce wrong output for any scenario where the helper's internal target differs from the lie.

### Approach C: Pre-bake in the converter transcoder before Assimp (rejected)

Rotate GLB vertices on the JS side before handing them to Assimp. Violates the converter-does-no-geometry-computation invariant codified across `docs/research/converter-runtime-consolidation.md`. Also forfeits the per-format header writers' chance to align with the bake.

### Approach D: Per-format `<FORMAT>_EXPORT_UPAXIS` keys (rejected)

Generalize 3MF's pattern to every format. Mechanically possible but produces N parallel knobs. Defeats the unification goal and contradicts the directive to _"ensure there are no confusing overloads and conditions"_.

## Diagrams

### Resolution flow (target frame computation)

```
Tau client                             Tau converter                         Assimp C++
─────────────────────                  ─────────────────────────             ─────────────────────────────
RuntimeClient.export(                  converterEdgeSchemas[fmt]             exportToLib3MF / bake<X>Contract /
  '3mf',                          ──►  .parse(options)                  ──►  glTF2Exporter::ExportMeshes
  { unit: 'millimeter',                produces { EXPORT_TARGET_UPAXIS: 2,
    coordinateSystem: 'z-up' })          EXPORT_TARGET_UNIT_SCALE_TO_METERS:
                                         0.001 }                               resolveExportTarget(props,
                                                                                 defaultUnit, defaultAxis)
                                                                              returns { unit: 0.001, axis: 2,
                                                                                        overridden: true }
                                                                                          │
                                                                                          ▼
                                                                              bake (helper or inline) using
                                                                                resolved (unit, axis)
                                                                                          │
                                                                                          ▼
                                                                              header writer (Lib3MFBridge /
                                                                                FBX GlobalSettings / Collada
                                                                                <asset> / USD Stage) consults
                                                                                same { unit, axis }, emits
                                                                                matching header tag
```

### Source vs target separation

```
  aiScene::mMetaData                      ExportProperties
  ─────────────────────                   ────────────────────────────
  AI_METADATA_UNIT_SCALE_TO_METERS        EXPORT_TARGET_UNIT_SCALE_TO_METERS
  AI_METADATA_UP_AXIS                     EXPORT_TARGET_UPAXIS

  describes: input geometry               describes: desired output frame
  set by:    importer                     set by:    caller
  read by:   bake (as source frame)       read by:   resolveExportTarget
                                                     bake (via resolver)
                                                     header writers
```

## Open Questions and Nuances

### N1: `requireOptIn` semantics

`bakeContractTransformIntoMeshes` today gates rotation on `aiScene::mMetaData` carrying the source contract (`requireOptIn = true`). When `EXPORT_TARGET_*` is present, the user has explicitly stated their intent — the bake must run even if source metadata is missing. `resolveExportTarget` returns `overridden = true`; the helper sets `requireOptIn = false` in that case.

### N2: FBX axis-int and unit-scale mapping

FBX `GlobalSettings` distinguishes `UpAxis` and `UpAxisSign`. Mapping table:

| `EXPORT_TARGET_UPAXIS` | FBX `UpAxis` | FBX `UpAxisSign` |
| ---------------------- | ------------ | ---------------- |
| 0 (X)                  | 0            | 1                |
| 1 (Y)                  | 1            | 1                |
| 2 (Z)                  | 2            | 1                |

`OriginalUpAxis` and `OriginalUpAxisSign` mirror the resolved values (since we baked to the new frame, the "original" is now the same). `UnitScaleFactor` = `unit * 100.0` (FBX expresses scale in centimeters per source unit).

### N3: Collada synthetic root suppression

`mAdd_root_node` (`ColladaExporter.cpp:266-304`) triggers when the root has non-uniform scale, non-axis-aligned rotation, non-zero translation, or no children. After axis bake the root transform is unchanged (bake never touches it). The synthetic-root branch remains valid for non-axis rotations / non-zero translations; **only the `<up_axis>` and `<unit>` writes are decoupled** from this branch in R8 — they always use the resolved target.

### N4: USD enum mapping

`tinyusdz::Axis { X, Y, Z, Invalid }` — first three map to 0, 1, 2. Aligns directly with `EXPORT_TARGET_UPAXIS`. `metersPerUnit` is a free double in USD; no enum mapping needed.

### N5: Axis-tagless format warnings

3DS, OBJ, PLY, STL, X, X3D have no axis tag in the file. Overriding to a non-default axis produces vertices in the requested orientation, but downstream tools may apply their own convention (e.g., a slicer reading STL assumes Z-up regardless of what we baked). Schema description must warn:

> _"Some formats (3DS, OBJ, PLY, STL, X, X3D) have no axis tag in the file. Overriding `coordinateSystem` changes vertex orientation but does not signal the convention to downstream tools, which may assume the format's default."_

### N6: STL routing — kernel-native vs converter

Replicad has kernel-native STL with `coordinateSystem` already wired. OpenSCAD has only converter-routed STL. Two distinct user-facing surfaces today:

- For Replicad → STL: `replicadExportSchemas.stl.coordinateSystem` (kernel-side).
- For OpenSCAD → STL: edge-side `stlSchema.coordinateSystem` (converter-side, new).

Both layers ultimately apply the rotation correctly. The per-kernel JSON Schema (consumed by UI form generation) will differ. Document in `runtime-export-pipeline-policy.md` so UI authors expect this asymmetry.

### N7: glTF rejection — schema vs C++

Tau-side schema excludes `axisAndUnitSchema` from the `gltf`/`glb` edges, so the keys never reach Assimp via the official path. C++ rejection (R6) catches any future caller that constructs `ExportProperties` directly. Both layers fail loudly: Zod throws at parse time; `glTF2Exporter` throws `DeadlyExportError` at export time.

### N8: 3MF unit silent-fallback fix

The pre-existing silent fallback to `MilliMeter` for unknown unit strings (`Lib3MFBridge.cpp:182-205`) is a latent bug. The unified key is a `double`, so the string-to-enum coercion no longer applies. The double-to-`eUnit` mapping in `Lib3MFBridge` becomes strict: tolerance `< 1e-9` against the six discrete enum constants; `DeadlyExportError` for any other value. Tau-side `axisAndUnitSchema.unit` is constrained to the enum, so legitimate values always map cleanly.

### N9: STEP — out of scope but routable

`converterEdgeSchemas.step = noEdgeOptions` is valid. STEP from Assimp has hardcoded mm + per-node world matrices. Future work: add bake support to STEP via the same `resolveExportTarget` pattern; for now, document the fixed-mm behavior in `runtime-export-pipeline-policy.md`.

### N10: Multi-registration variant uniformity

ASCII vs binary variants (`ply`/`plyb`, `stl`/`stlb`, `obj`/`objnomtl`, `fbx`/`fbxa`, `gltf2`/`glb2`, `m3d`/`a3d`, `usda`/`usdz`) share the same bake and same target defaults. Tau-side schemas extend both variants with the same `axisAndUnitSchema` for consistency.

### N11: glTF2 macro typo (out of scope)

`AI_CONFIG_EXPORT_GLTF_UNLIMITED_SKINNING_BONES_PER_VERTEX` expands to `"USE_UNLIMITED_BONES_PER VERTEX"` (literal space). Documented for awareness. If the option is surfaced in `gltfSchema` (R13 optional), use the macro symbol — never hand-typed string literal.

### N12: Debug formats (Assxml, Assbin, M3D) — deliberately untouched

These formats preserve scene metadata as-is for debugging / native interchange. They do not bake. They do not get `axisAndUnitSchema`. Document as deliberate exclusions.

## Implementation Phasing

This work supersedes the original Phase G of `/Users/rifont/.cursor/plans/openscad_3mf_orientation_fix_dafc8320.plan.md`. The revised phase ordering:

| Phase | Scope                                                                                                                                                                      | Recommendations        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A–F   | Per the parent plan: kernel-side cleanup, R3 (now subsumed by `axisAndUnitSchema`), invariant tests, E2E tests, policy doc, CI validation                                  | parent plan            |
| G.1   | C++ scaffolding: `config.h.in` macros, `resolveExportTarget` helper, `bakeContractTransformIntoMeshes` extended signature                                                  | R1, R2, R3             |
| G.2   | Patch all 9 Pattern-A bake call sites + header writers (FBX, DAE, USD)                                                                                                     | R4, R7, R8, R9         |
| G.3   | Refactor 3MF inline bake; delete `3MF_EXPORT_UPAXIS`/`3MF_EXPORT_UNIT`; update Assimp unit tests                                                                           | R5, R10                |
| G.4   | Refactor glTF2 inline bake with override rejection                                                                                                                         | R6                     |
| G.5   | WASM rebuild, tarball regeneration, `pnpm install`                                                                                                                         | R14                    |
| G.6   | Tau schema unification: `axisAndUnitSchema`, `withAssimpKeyMap` value transforms, edge-schema rewiring (12 edges)                                                          | R11, R12               |
| G.7   | Surface format-specific options (`fbxSchema`, `objSchema`, `stlSchema`, `xSchema`, `usdzSchema`, expanded `threeMfSchema`)                                                 | R13                    |
| G.8   | Update `UPSTREAM_3MF_ISSUE_DRAFT.md` and create `runtime-export-pipeline-policy.md`                                                                                        | R15, R16               |
| G.9   | Parameterized E2E round-trip tests for representative formats (3mf, fbx, dae, usdz, obj, stl, x) asserting bbox extents under y-up vs z-up + per-format option round-trips | this doc + parent plan |

Each phase ends with `pnpm nx test/typecheck/lint runtime converter` + `pnpm docs:validate`.

## References

- Parent investigation: `docs/research/openscad-3mf-coordinate-orientation.md`
- Architecture landscape: `docs/research/assimp-transform-architecture-landscape.md`
- 3MF deep dive: `docs/research/3mf-export-scale-orientation-manifold.md`
- Convention enforcement: `docs/research/converter-runtime-consolidation.md`
- Upstream draft: `repos/assimpjs/UPSTREAM_3MF_ISSUE_DRAFT.md`
- glTF 2.0 spec, §3.3 "Coordinate System": https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units
- 3MF Core Specification §4.1: https://github.com/3MFConsortium/spec_core
- Autodesk FBX SDK Reference, `FbxAxisSystem`: https://help.autodesk.com/view/FBX/2020/ENU/
- USD Stage Metadata: https://openusd.org/release/api/group__Usd__StageMetadata.html
- Collada 1.4 `<asset>` schema: https://www.khronos.org/files/collada_spec_1_4.pdf §5.3.1
