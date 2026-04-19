---
title: '3MF Activation Status: lib3mf Integration and Remaining Steps'
description: 'Comprehensive status assessment of the lib3mf integration in assimpjs and the remaining steps to fully activate 3MF export in Tau.'
status: active
created: '2026-04-16'
updated: '2026-04-16'
category: audit
related:
  - docs/research/3mf-assimp-audit.md
---

# 3MF Activation Status: lib3mf Integration and Remaining Steps

Assessment of the lib3mf integration progress in assimp/assimpjs and the exact steps remaining to enable 3MF export in Tau's converter and UI.

## Executive Summary

The lib3mf integration into assimp is **substantially complete at the C++ layer**. A `Lib3MFBridge` module implements both import and export using the 3MF Consortium's reference library (v2.4.1), the WASM binaries are already built with lib3mf enabled, and the compiled artifacts are deployed in Tau's converter package. C++ tests for import, export, and roundtrip are written and active. The **only blocking work** is in the Tau TypeScript layer: uncommenting the 3MF export config, adding `'3mf'` to three format arrays, and writing converter-level export tests. Once those changes land, the runtime transcoder will automatically discover the `glb → 3mf` edge and the manifest-driven UI will surface 3MF as an export option. Beyond basic activation, the bridge has known feature gaps (no textures, no color groups, no components, no slicer metadata) that are non-blocking but matter for production quality.

---

## Table of Contents

1. [Current State of the Fork](#1-current-state-of-the-fork)
2. [Lib3MFBridge Implementation Audit](#2-lib3mfbridge-implementation-audit)
3. [WASM Build and Deployment Status](#3-wasm-build-and-deployment-status)
4. [Tau TypeScript Layer Status](#4-tau-typescript-layer-status)
5. [Standalone export-3mf.ts Status](#5-standalone-export-3mfts-status)
6. [Known Limitations and Feature Gaps](#6-known-limitations-and-feature-gaps)
7. [Recommendations](#7-recommendations)

---

## 1. Current State of the Fork

### 1.1 Repository Structure

Both repos are managed via `repos.yaml` with `taucad` remotes:

| Repo     | Path                    | Remote                                         | Branch/State                               |
| -------- | ----------------------- | ---------------------------------------------- | ------------------------------------------ |
| assimpjs | `repos/assimpjs`        | `taucad/assimpjs` (fork of `kovacsv/assimpjs`) | `main` @ `877787b`, clean tracked diff     |
| assimp   | `repos/assimpjs/assimp` | `taucad/assimp` (fork of `assimp/assimp`)      | Detached @ `caf486a6d`, no tracked changes |

The assimp submodule is detached from `1e8722e4d` but `HEAD` is at `caf486a6d` (the commit recorded in the parent's index). All 3MF-relevant work is committed; the only untracked items are build artifacts (`build_test/`, `contrib/lib3mf/autoclone/`, USD docs).

### 1.2 Key Commits

| Commit      | Repo     | Description                                                                                             |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `caf486a6d` | assimp   | `feat: add lib3mf bridge for 3MF import/export, enhance USD pipeline` — the core lib3mf integration     |
| `ff29d04`   | assimpjs | `feat: rebuild WASM with lib3mf, enhanced USD support, and ConvertFile API` — WASM binaries with lib3mf |
| `877787b`   | assimpjs | `fix: remove "type": "module" to match CJS/UMD dist output` — latest main                               |

### 1.3 CMake Configuration

The `ASSIMP_BUILD_3MF_LIB3MF` option (default OFF) is explicitly set ON for two build profiles:

| Profile           | lib3mf | 3MF Import                     | 3MF Export                          | Purpose                                        |
| ----------------- | ------ | ------------------------------ | ----------------------------------- | ---------------------------------------------- |
| `ReleaseMini`     | OFF    | ON (all importers default ON)  | OFF (only ASSJSON + GLTF exporters) | Lightweight import-only                        |
| `ReleaseAll`      | **ON** | ON                             | OFF (only ASSJSON + GLTF exporters) | Full import with lib3mf reader                 |
| `ReleaseExporter` | **ON** | ON (GLTF + ASSJSON + USD only) | **ON** (all exporters default ON)   | Export-focused — the primary 3MF export target |

When `ASSIMP_BUILD_3MF_LIB3MF` is ON, CMake:

1. FetchContent clones lib3mf v2.4.1 from `3MFConsortium/lib3mf` into `contrib/lib3mf/autoclone/`
2. Defines `ASSIMP_USE_LIB3MF` and `__LIB3MF_EXPORTS`
3. Uses `miniz_standalone.c` instead of kuba-zip to avoid symbol clashes with lib3mf's bundled libzip
4. Patches libzip headers from `contrib/lib3mf/patches/libzip/` (tracked: `config.h`, `zipconf.h`)
5. Sets `GUID_CUSTOM` on Emscripten for non-platform UUID generation

### 1.4 C++ Tests

The test file `repos/assimpjs/assimp/test/unit/utD3MFImportExport.cpp` contains **8 active tests** (none commented out):

| Test                             | What it validates                                        |
| -------------------------------- | -------------------------------------------------------- |
| `import3MFFromFileTest`          | Basic import success                                     |
| `import3MFBoxGeometry`           | 8 vertices, 12 triangles from box.3mf                    |
| `import3MFHasRootNode`           | Scene has root node                                      |
| `import3MFHasMaterial`           | At least 1 material present                              |
| `export3MFBasicMesh`             | Basic export roundtrip                                   |
| `export3MFProducesFile`          | Export produces non-empty file                           |
| `export3MFWithMaterials`         | GLB → 3MF with materials                                 |
| `roundtrip3MFBox`                | Vertex/face count preservation through export + reimport |
| `roundtrip3MFPreservesTriangles` | All faces remain triangles after roundtrip               |
| `roundtrip3MFWithMaterial`       | Diffuse color preserved within ±0.02 tolerance           |

This is a significant improvement over the previous state (all export/roundtrip tests were commented out in the original assimp exporter).

---

## 2. Lib3MFBridge Implementation Audit

### 2.1 Architecture

The bridge uses a compile-time switch via `#ifdef ASSIMP_USE_LIB3MF`. When enabled, both `D3MFImporter::InternReadFile` and `ExportScene3MF` delegate to the bridge:

```
D3MFImporter::InternReadFile()    → Lib3MFBridge::ImportScene()
ExportScene3MF()                  → Lib3MFBridge::ExportScene()
```

When `ASSIMP_USE_LIB3MF` is not defined, the original XML-based importer and kuba-zip-based exporter compile instead.

### 2.2 Export Pipeline (aiScene → 3MF)

The `exportToLib3MF()` function (670 lines total file, ~150 lines of export logic):

1. Creates a lib3mf model
2. Iterates `aiScene.mMaterials` → creates a single `IBaseMaterialGroup` with all materials (diffuse color + name)
3. **Recursively** walks the node tree via `collectMeshNodes()` — collects `(meshIndex, globalTransform)` pairs. Falls back to flat `mMeshes` iteration if no root node.
4. For each mesh entry: creates `IMeshObject`, sets vertices/triangles, applies object-level + per-triangle material properties (uniform material per mesh)
5. Adds build items with 4×3 affine transforms from the accumulated node transform
6. Writes to buffer via `lib3mf_writer_writetobuffer`

**Strengths vs old exporter:**

| Feature                 | Old Exporter                    | Lib3MFBridge                                 |
| ----------------------- | ------------------------------- | -------------------------------------------- |
| Node traversal          | Root children only (flat)       | Recursive with global transform accumulation |
| Transforms              | Missing — all objects at origin | Full 4×3 affine transforms on build items    |
| Material IDs            | Hardcoded `pid="1"`             | Correct unique resource ID from lib3mf       |
| Per-triangle properties | Only `p1`                       | All three `m_PropertyIDs` set (uniform)      |
| Object names            | Missing                         | Set from `aiMesh.mName`                      |
| Object-level material   | Missing                         | `setObjectLevelProperty` called              |
| OPC packaging           | Hand-built XML + kuba-zip       | lib3mf's validated writer                    |

### 2.3 Import Pipeline (3MF → aiScene)

The `importFromLib3MF()` function:

1. Creates lib3mf model + reader (strict mode OFF)
2. Reads from buffer
3. First pass: counts meshes and collects vertex/triangle counts
4. Builds materials from base material groups (iterates all groups, all properties within each group)
5. Second pass: creates `aiMesh` instances with geometry + material index from triangle 0's properties
6. Collects build item transforms
7. Creates scene graph: flat hierarchy with one child node per mesh, transforms applied from build items

**Known assumption:** Build item order is assumed to align with mesh object iteration order. This is valid for simple files but fragile for multi-component 3MF files where build items reference objects by ID, not by iteration order.

### 2.4 RAII and Error Handling

- `Lib3MFHandle` class: RAII wrapper with move semantics, auto-releases via `lib3mf_release`
- `checkResult` / `checkImportResult`: extracts lib3mf error messages and throws `DeadlyExportError` / `DeadlyImportError`
- Color conversion helpers: `aiColorToLib3MF` / `lib3MFColorToAi` with proper 0-255 ↔ 0.0-1.0 scaling

---

## 3. WASM Build and Deployment Status

### 3.1 Built Artifacts

All three WASM variants are built and committed at `ff29d04`:

| Variant                  | Size    | lib3mf | 3MF Export | Used for            |
| ------------------------ | ------- | ------ | ---------- | ------------------- |
| `assimpjs-mini.wasm`     | 4.1 MB  | OFF    | OFF        | Not used by Tau     |
| `assimpjs-all.wasm`      | 15.6 MB | ON     | OFF        | Tau import pipeline |
| `assimpjs-exporter.wasm` | 11.9 MB | ON     | **ON**     | Tau export pipeline |

The exporter WASM grew from the ~8.7 MB estimate in the prior audit to 11.9 MB, reflecting lib3mf + USD exporter additions.

### 3.2 Deployment in Tau

| Location                                         | Status                                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| `repos/assimpjs/dist/`                           | WASM committed, tracked by git                           |
| `packages/converter/node_modules/assimpjs/dist/` | Installed via GitHub tarball @ `877787b`                 |
| `packages/converter/src/assets/assimpjs/`        | Both `.wasm` files copied by `copy-files-from-to` target |

The Tau converter already uses the lib3mf-enabled WASM binaries. The export pipeline (`assimpjs-exporter.wasm`) has 3MF export compiled in and ready.

### 3.3 Binding Layer

The assimpjs C++ binding (`assimpjs/src/assimpjs.cpp`) already maps the `"3mf"` format string to `.3mf` extension. No binding changes are needed.

---

## 4. Tau TypeScript Layer Status

This is where the remaining activation work lives. The architecture is manifest-driven: format arrays propagate through the converter package → runtime transcoder → capabilities manifest → UI export panel.

### 4.1 Converter Package (`packages/converter`)

| File                                                     | Current State                   | Required Change          |
| -------------------------------------------------------- | ------------------------------- | ------------------------ |
| `src/formats.ts` `exportFormatKeys`                      | 3MF absent                      | Add `'3mf'` to the array |
| `src/exporters/assimp.exporter.ts` `assimpExportFormats` | 3MF absent                      | Add `'3mf'` to the array |
| `src/export.ts` `exportConfigs`                          | 3MF commented out (line 35)     | Uncomment                |
| `src/export.test.ts`                                     | No 3MF export test              | Add export test case     |
| `src/loaders/assimp.loader.ts`                           | 3MF import works, Z-up flag set | No change needed         |
| `src/import.ts`                                          | 3MF mapped to `AssimpLoader`    | No change needed         |

### 4.2 Runtime Package (`packages/runtime`)

| Component                        | Current State                                 | Required Change                                                    |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Converter transcoder             | Discovers edges from `supportedExportFormats` | **Automatic** — will advertise `glb → 3mf` once converter adds 3MF |
| Kernel plugins (`exportSchemas`) | Only `glb`/`gltf` for Tau/OpenSCAD/etc.       | No change — 3MF via transcoder, not native kernel export           |
| Capabilities manifest            | Aggregates kernel exports + transcoder edges  | **Automatic** — will include 3MF route                             |

### 4.3 UI (`apps/ui`)

| Component                             | Current State                                | Required Change                 |
| ------------------------------------- | -------------------------------------------- | ------------------------------- |
| Chat converter (`chat-converter.tsx`) | Reads from `capabilities.exportRoutes`       | **Automatic** — manifest-driven |
| Hero viewer (`hero-viewer.tsx`)       | Reads from `capabilities.exportRoutes`       | **Automatic** — manifest-driven |
| Convert page (`convert/route.tsx`)    | Uses `supportedExportFormats` from converter | **Automatic**                   |
| Format selector                       | Maps `supportedExportFormats`                | **Automatic**                   |
| MIME types (`libs/types`)             | `'3mf': 'model/3mf'` already present         | No change needed                |
| Format names (`libs/types`)           | Human-readable 3MF name present              | No change needed                |

The UI is fully manifest-driven. Once the converter advertises 3MF as a supported export format, the UI will show it automatically.

---

## 5. Standalone export-3mf.ts Status

A standalone TypeScript 3MF generator exists at `packages/runtime/src/utils/export-3mf.ts` (~247 lines). It was originally written for the OpenSCAD kernel's OFF → 3MF path.

### 5.1 Current Usage

`export3mf` has **no runtime references** outside its own test file. No kernel plugin, kernel implementation, or public export wires to it. The OpenSCAD kernel's `exportSchemas` only lists `glb`/`gltf`.

### 5.2 Capabilities

- Takes `IndexedPolyhedron` (vertices, faces, per-face colors) as input
- Fan triangulation for non-triangle faces
- Per-face color via base materials
- Multi-material printing with extruder color mapping and `paint_color` attribute
- Slicer compatibility metadata (`BambuStudio:3mfVersion`, `slic3rpe:Version3mf`, `slic3rpe:MmPaintingVersion`)
- Production Extension UUIDs on objects and build items
- ZIP packaging via `UZIP`

### 5.3 Assessment

This utility is **more slicer-aware** than the lib3mf bridge (it includes slicer metadata, paint color encoding, Production Extension UUIDs) but is **less capable** architecturally (single-object, no transforms, no textures, no validation). It is effectively dead code in the current codebase. Once 3MF export is activated through the converter, this file should be either:

- **Removed** if no kernel needs direct 3MF generation bypassing the converter
- **Retained** only if there's a future use case for kernel-native 3MF with slicer metadata that cannot go through the GLB → 3MF converter path

---

## 6. Known Limitations and Feature Gaps

### 6.1 Lib3MFBridge Export Gaps

Compared to the full 3MF spec and slicer compatibility requirements from the prior audit:

| Feature                                  | Status      | Impact                                                       |
| ---------------------------------------- | ----------- | ------------------------------------------------------------ |
| Core mesh (vertices/triangles)           | Implemented | None                                                         |
| Base materials (diffuse color + name)    | Implemented | None                                                         |
| Build item transforms                    | Implemented | None                                                         |
| Recursive node traversal                 | Implemented | None                                                         |
| Object names                             | Implemented | None                                                         |
| Object-level material property           | Implemented | None                                                         |
| Per-triangle material (uniform per mesh) | Implemented | Low — no per-triangle gradients                              |
| Color groups (`m:colorgroup`)            | **Missing** | High — required by BambuStudio/OrcaSlicer for multi-material |
| Texture2D resources                      | **Missing** | High — no embedded textures                                  |
| Texture coordinates                      | **Missing** | High — no UV mapping                                         |
| Vertex colors                            | **Missing** | Medium — no per-vertex color                                 |
| Components / hierarchy                   | **Missing** | Medium — no object reuse                                     |
| Slicer metadata                          | **Missing** | Medium — slicers may not detect file version                 |
| Production Extension UUIDs               | **Missing** | Medium — BambuStudio/OrcaSlicer compatibility                |
| Thumbnails                               | **Missing** | Low — preview images                                         |
| Print tickets                            | **Missing** | Low — embedded print settings                                |

### 6.2 Lib3MFBridge Import Gaps

| Feature               | Status                                        | Impact                                    |
| --------------------- | --------------------------------------------- | ----------------------------------------- |
| Mesh geometry         | Implemented                                   | None                                      |
| Base materials        | Implemented                                   | None                                      |
| Build item transforms | Implemented (ordering assumption)             | Medium — fragile for complex files        |
| Color groups          | **Missing**                                   | Medium — per-vertex colors lost on import |
| Texture2D             | **Missing** (was supported by old XML parser) | High — regression from built-in importer  |
| Composite materials   | **Missing**                                   | Low                                       |
| Components            | **Missing** (was supported by old XML parser) | High — regression from built-in importer  |

**Import regression risk:** The lib3mf bridge import is **less capable** than the old XML-based importer for textures and components. The old importer handled `Texture2DGroup`, `ColorGroup`, and `Components` with transforms. The bridge only handles base materials and flat mesh iteration. This is mitigated because `ReleaseAll` (the import WASM) also has lib3mf ON, but could be toggled off if needed since the CMake switch is compile-time.

### 6.3 Non-Blocking Issues

These do not prevent basic 3MF export activation:

1. **Per-mesh uniform material**: Every triangle in a mesh gets the same material. Per-face material variation (p1/p2/p3 varying) is not implemented, but this is acceptable for the GLB → 3MF pipeline since GLB meshes are already split by material.

2. **Build item ↔ mesh ordering assumption** (import): The import side assumes build item iteration order matches mesh object iteration order. This works for files exported by the bridge itself and most simple 3MF files, but may fail for complex multi-component files from other tools.

3. **No unit handling**: Coordinates are passed through without unit conversion. Since the bridge hardcodes `millimeter` (the 3MF default) and GLB uses meters, the converter pipeline may need unit scaling. However, assimp's internal processing may handle this.

---

## 7. Recommendations

### R1: Activate 3MF Export in Converter (Priority: P0, Effort: Low, Impact: High)

The critical path to showing 3MF in the UI export panel. Three file changes + one test file:

1. Add `'3mf'` to `exportFormatKeys` in `packages/converter/src/formats.ts`
2. Add `'3mf'` to `assimpExportFormats` in `packages/converter/src/exporters/assimp.exporter.ts`
3. Uncomment the 3MF config in `packages/converter/src/export.ts` (line 35)
4. Add 3MF export test in `packages/converter/src/export.test.ts`

**Verification**: After these changes, the converter transcoder will automatically discover `glb → 3mf`, the capabilities manifest will include a 3MF export route, and the UI will show 3MF in the format selector. Run `pnpm nx test converter --watch=false` and verify manual export in the dev server.

### R2: Validate GLB → 3MF Pipeline End-to-End (Priority: P0, Effort: Medium, Impact: High)

Before shipping, verify that the full pipeline works:

1. Export a simple geometry (cube, cylinder) as 3MF from the UI
2. Verify the exported file opens in BambuStudio, PrusaSlicer, and OrcaSlicer
3. Verify geometry is correct (vertex count, face count, dimensions)
4. Verify colors are preserved (import colored GLB, export 3MF, check diffuse colors)
5. Check unit scaling — GLB uses meters, 3MF uses millimeters. If dimensions are 1000× off, add unit conversion in the bridge or at the converter level

### R3: Assess Import Regression Risk (Priority: P1, Effort: Low, Impact: Medium)

The lib3mf bridge import is less capable than the old XML-based importer (no textures, no components). Since `ReleaseAll` has `ASSIMP_BUILD_3MF_LIB3MF ON`, all 3MF imports now go through the bridge. Options:

1. **Accept**: If 3MF import is only used for simple geometry files (likely for Tau's current usage), the bridge is sufficient
2. **Enhance**: Add texture and component support to `importFromLib3MF()` using lib3mf's APIs (`lib3mf_model_gettexture2dgroups`, `lib3mf_model_getcomponentsobjects`)
3. **Revert for import**: Set `ASSIMP_BUILD_3MF_LIB3MF OFF` for `ReleaseAll` to keep the old XML importer for import-only builds, while keeping lib3mf ON for `ReleaseExporter`

Import regression is **non-blocking** for export activation (R1).

### R4: Clean Up Standalone export-3mf.ts (Priority: P2, Effort: Low, Impact: Low)

`packages/runtime/src/utils/export-3mf.ts` and its test file are dead code with no runtime references. Two options:

1. **Remove**: Delete `export-3mf.ts` and `export-3mf.test.ts` since 3MF export will go through the converter pipeline
2. **Preserve for slicer metadata**: If future work requires slicer-specific 3MF features (paint_color, thumbnails, print tickets) that the lib3mf bridge does not yet support, this file contains useful reference patterns for slicer compatibility metadata

Recommendation: Remove now, reference the git history if slicer metadata patterns are needed later.

### R5: Enhance Lib3MFBridge for Production Quality (Priority: P2, Effort: High, Impact: Medium)

Non-blocking improvements for better 3MF fidelity, ordered by user impact:

| #    | Enhancement                                                                   | Effort | Impact |
| ---- | ----------------------------------------------------------------------------- | ------ | ------ |
| R5.1 | Add slicer version metadata (`BambuStudio:3mfVersion`, `slic3rpe:Version3mf`) | Low    | Medium |
| R5.2 | Add Production Extension UUIDs on objects and build items                     | Low    | Medium |
| R5.3 | Add color group support for per-vertex colors                                 | Medium | High   |
| R5.4 | Add texture2D export (embedded images + UV coords)                            | High   | High   |
| R5.5 | Add component/hierarchy support                                               | High   | Medium |
| R5.6 | Fix import build-item ordering (use object ID matching)                       | Medium | Medium |
| R5.7 | Add texture2D import (regression from XML parser)                             | Medium | Medium |
| R5.8 | Add thumbnail generation                                                      | Medium | Low    |

### R6: Native Tests in WASM (Priority: P3, Effort: Medium, Impact: Low)

The C++ tests (`utD3MFImportExport.cpp`) run in native builds only. Consider adding a WASM-level test that exercises the `ConvertFileList(fileList, '3mf')` path from JavaScript to verify the full Emscripten binding + lib3mf pipeline.

---

## Appendix: File Inventory

### Assimp 3MF Source Files (repos/assimpjs/assimp/code/AssetLib/3MF/)

| File                   | Purpose                                                     | Active when               |
| ---------------------- | ----------------------------------------------------------- | ------------------------- |
| `Lib3MFBridge.h`       | Bridge API declaration                                      | `ASSIMP_USE_LIB3MF`       |
| `Lib3MFBridge.cpp`     | lib3mf ↔ aiScene conversion (670 lines)                     | `ASSIMP_USE_LIB3MF`       |
| `D3MFImporter.h/cpp`   | Import entry point; delegates to bridge or XML parser       | Always                    |
| `D3MFExporter.h/cpp`   | Export entry point; delegates to bridge or kuba-zip builder | When 3MF exporter enabled |
| `XmlSerializer.h/cpp`  | Manual XML parser for built-in importer                     | `!ASSIMP_USE_LIB3MF`      |
| `D3MFOpcPackage.h/cpp` | OPC ZIP reader for built-in importer                        | `!ASSIMP_USE_LIB3MF`      |
| `3MFTypes.h`           | Type definitions for built-in parser                        | `!ASSIMP_USE_LIB3MF`      |
| `3MFXmlTags.h`         | XML tag constants for built-in parser                       | `!ASSIMP_USE_LIB3MF`      |

### Tau TypeScript Files

| File                                                                 | 3MF Status                            |
| -------------------------------------------------------------------- | ------------------------------------- |
| `packages/converter/src/formats.ts`                                  | Not in `exportFormatKeys`             |
| `packages/converter/src/export.ts`                                   | Commented out (line 35)               |
| `packages/converter/src/exporters/assimp.exporter.ts`                | Not in `assimpExportFormats`          |
| `packages/converter/src/import.ts`                                   | Mapped to `AssimpLoader` (working)    |
| `packages/converter/src/loaders/assimp.loader.ts`                    | Z-up flag set for 3MF (working)       |
| `packages/runtime/src/utils/export-3mf.ts`                           | Standalone utility, dead code         |
| `packages/runtime/src/transcoders/converter/converter.transcoder.ts` | Auto-discovers from converter formats |
| `libs/types/src/constants/mime-types.constants.ts`                   | `'3mf': 'model/3mf'` present          |
