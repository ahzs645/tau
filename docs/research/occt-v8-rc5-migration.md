---
title: 'OCCT V8 RC5 Migration'
description: 'Migration of opencascade.js from OCCT V8.0.0-rc4 to V8.0.0-rc5 — removed symbols, build patches, and validation'
status: active
created: '2026-03-26'
updated: '2026-03-26'
category: migration
related:
  - docs/research/occt-v8-migration.md
---

# OCCT V8 RC5 Migration

Migration of the opencascade.js OCCT dependency from V8.0.0-rc4 (commit `48ebca0f`) to V8.0.0-rc5 (commit `0ebbbedb`), documenting all required changes, issues encountered, and validation results.

## Executive Summary

OCCT V8.0.0-rc5 incorporates 64 improvements and bug fixes. The migration required removing 12 symbols from build configs (packages deleted upstream), adding a WASM32 compatibility patch for the new BRepGraph module, and cleaning stale build artifacts from toolkit reorganization. All 259 smoke tests pass and typecheck is clean.

## Problem Statement

OCCT released RC5 on April 6, 2026. The opencascade.js build was pinned to RC4. The update required:

1. Updating the OCCT git pointer in `DEPS.json`
2. Handling removed/deprecated packages in build config symbol lists
3. Verifying existing source patches still apply to RC5 headers
4. Resolving new compilation issues introduced by RC5
5. Cleaning stale build artifacts from toolkit reorganization
6. Full rebuild and test validation

## Methodology

1. Updated `DEPS.json` commit hash, ran `pnpm nx setup ocjs` to checkout RC5
2. Audited RC5 changelog for removed packages, compared against build config symbol lists
3. Ran `applyPatches.py` against RC5 source to verify patch compatibility
4. Executed full build pipeline: sources (CMake) -> PCH -> generate -> bindings -> link
5. Diagnosed and fixed build failures iteratively
6. Ran all smoke tests and typecheck

## Findings

### Finding 1: 12 Symbols Removed from Build Configs

RC5 removed several packages that were listed in `full.yml` and `full-exceptions.yml`:

| Symbol                        | Reason                                | RC5 PR |
| ----------------------------- | ------------------------------------- | ------ |
| `GProp_EquaType`              | Enum removed (zero consumers)         | #1140  |
| `LProp_AnalyticCurInf`        | Dead code removed                     | #1159  |
| `Geom2dLProp_CLProps2d`       | Package removed, aliases in GeomLProp | #1156  |
| `Geom2dLProp_CurAndInf2d`     | Package removed, aliases in GeomLProp | #1156  |
| `Geom2dLProp_Curve2dTool`     | Package removed, aliases in GeomLProp | #1156  |
| `Geom2dLProp_FuncCurExt`      | Package removed, aliases in GeomLProp | #1156  |
| `Geom2dLProp_FuncCurNul`      | Package removed, aliases in GeomLProp | #1156  |
| `Geom2dLProp_NumericCurInf2d` | Package removed, aliases in GeomLProp | #1156  |
| `LProp3d_CLProps`             | Package removed, aliases in GeomLProp | #1156  |
| `LProp3d_CurveTool`           | Package removed, aliases in GeomLProp | #1156  |
| `LProp3d_SLProps`             | Package removed, aliases in GeomLProp | #1156  |
| `LProp3d_SurfaceTool`         | Package removed, aliases in GeomLProp | #1156  |

Deprecated symbols (`GProp_PGProps`, `GProp_PEquation`, `GProp_CelGProps`, `GProp_SelGProps`, `GProp_VelGProps`) were kept in the YAML. They compile with deprecation warnings but remain functional.

### Finding 2: BRepGraph WASM32 Static Assert Failure

The new `BRepGraph_VersionStamp.cxx` (#1166) contains:

```cpp
static_assert(sizeof(size_t) >= 8, "Expected 64-bit size_t");
std::memcpy(&aResultUUID, &aHash1, 8);
```

In Emscripten's WASM32 target, `size_t` is 4 bytes, causing a compilation failure. This is an upstream bug — the code copies 8 bytes from a `size_t` value that is only 4 bytes wide.

**Fix**: Added a patch to `applyPatches.py` that widens the hash values to `uint64_t` before the `memcpy`:

```cpp
const uint64_t aWide1 = static_cast<uint64_t>(aHash1);
const uint64_t aWide2 = static_cast<uint64_t>(aHash2);
std::memcpy(&aResultUUID, &aWide1, 8);
std::memcpy(reinterpret_cast<uint8_t*>(&aResultUUID) + 8, &aWide2, 8);
```

### Finding 3: Toolkit Reorganization Causes Stale Build Artifacts

RC5 moved several packages between toolkits (#1156):

| Package     | Old Toolkit | New Toolkit  |
| ----------- | ----------- | ------------ |
| `GProp`     | `TKG3d`     | `TKGeomBase` |
| `GeomLProp` | `TKG3d`     | `TKGeomBase` |
| `LProp`     | `TKG2d`     | `TKGeomBase` |

The binding generation system creates compiled `.o` files organized by toolkit path. After RC5, new bindings were generated under `TKGeomBase/` while stale `.o` files persisted under the old `TKG2d/`/`TKG3d/` paths. The linker saw duplicate `raw_destructor` symbols for the affected classes.

**Fix**: Deleted stale `build/compiled-bindings/` and `build/bindings/` directories for the moved packages before re-linking.

### Finding 4: CMake Include Wrappers Require Rebuild

The CMake build step generates include wrapper headers in `build/occt-cmake/include/opencascade/` with hardcoded absolute paths to the OCCT source tree. When OCCT packages move between toolkits, these wrappers point to nonexistent paths. The PCH step, which runs before CMake sources, depends on these wrappers.

**Fix**: Deleted the stale `build/occt-cmake/` directory and ran `cmake sources` before `pch` to regenerate correct include wrappers.

### Finding 5: All Existing Patches Apply Cleanly to RC5

All 9 patches in `applyPatches.py` applied without warnings:

| Patch                                    | Target File                    | Status                       |
| ---------------------------------------- | ------------------------------ | ---------------------------- |
| AIS_Shape using-statement                | `AIS_Shape.hxx`                | Applied                      |
| BlendFunc_ChamfInv using-statement       | `BlendFunc_ChamfInv.hxx`       | Applied                      |
| BlendFunc_ConstThroatInv using-statement | `BlendFunc_ConstThroatInv.hxx` | Applied                      |
| Graphic3d_Buffer using-statement         | `Graphic3d_Buffer.hxx`         | Applied                      |
| V3d_DirectionalLight using-statement     | `V3d_DirectionalLight.hxx`     | Applied                      |
| V3d_SpotLight using-statement            | `V3d_SpotLight.hxx`            | Applied                      |
| BRepAlgoAPI_Algo using-statement         | `BRepAlgoAPI_Algo.hxx`         | Applied                      |
| MathLin_EigenSearch bugfix               | `MathLin_EigenSearch.hxx`      | Applied (not fixed upstream) |
| IntCurve_IntConicConic macro undef       | `IntCurve_IntConicConic.lxx`   | Applied                      |

### Finding 6: Adaptor Evaluation Hierarchy Change is Transparent

RC5 makes `Value()/D0-DN` on `Adaptor3d_Curve`/`Adaptor3d_Surface` non-virtual inline wrappers delegating to `EvalD*` (#1139). This change is transparent to the binding system — the public API remains unchanged and all smoke tests that use `adaptor.Value(param)` continue to pass.

### Finding 7: New GeomBndLib Classes Have Deleted Copy Constructors

Several new RC5 classes (`GeomBndLib_BezierCurve2d`, `GeomBndLib_BezierSurface`, etc.) have deleted copy constructors, which Embind requires. These classes fail to compile as bindings (70 total binding compilation failures, including 52 template errors and 16 undefined symbols). This is expected behavior — not all OCCT classes are compatible with Embind. The link step verifies only the required symbols are present.

## Build Results

| Metric              | Value                                |
| ------------------- | ------------------------------------ |
| OCCT version        | V8.0.0-rc5 (commit `0ebbbedb`)       |
| Build config        | `O3-wasm-exc-simd`                   |
| CMake libraries     | 49 static libraries                  |
| Binding compilation | 4471 succeeded, 70 failed (expected) |
| WASM size           | 35.42 MB (10.28 MB gzipped)          |
| JS size             | 80.5 KB                              |
| Types size          | 7751.2 KB                            |
| Smoke tests         | 61 files, 259 tests, all passed      |
| Typecheck           | No errors                            |

## Changes Made

| File                                | Change                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `DEPS.json`                         | Updated OCCT commit from `48ebca0f` to `0ebbbedb`, version label to `V8_0_0_rc5` |
| `build-configs/full.yml`            | Removed 12 symbols for deleted packages                                          |
| `build-configs/full-exceptions.yml` | Removed 12 symbols for deleted packages (identical changes)                      |
| `src/applyPatches.py`               | Added BRepGraph_VersionStamp WASM32 patch (uint64_t widening)                    |

## References

- [OCCT V8.0.0-rc5 release notes](https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_0_rc5)
- [Full changelog: RC4...RC5](https://github.com/Open-Cascade-SAS/OCCT/compare/V8_0_0_rc4...V8_0_0_rc5)
- Related: `docs/research/occt-v8-migration.md`
