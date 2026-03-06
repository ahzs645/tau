# Consumer-Agnostic Audit: opencascade.js Core Scripts

**Date**: 2025-03-07
**Scope**: `repos/opencascade.js/` — all Python, shell, and YAML files
**Verdict**: **PASS** — no replicad-specific behaviour found in core scripts

## Summary

A full audit of the opencascade.js fork confirms that the core build pipeline
is consumer-agnostic. The string "replicad" appears only in upstream
documentation files (README.md, website/docs/01-about.md) where it is listed
as one of several community projects. No build logic, filter, patch, schema,
or configuration references replicad.

## Files Checked

### Python files (src/)

| File                                     | Replicad references | Notes                                                                       |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `src/Common.py`                          | None                | Path defaults use env vars (`OCJS_ROOT`, `OCCT_ROOT`, etc.)                 |
| `src/buildFromYaml.py`                   | None                | Links WASM from any YAML config passed as argument                          |
| `src/compileSources.py`                  | None                | Compiles OCCT sources using generic `filterPackages`                        |
| `src/compileBindings.py`                 | None                | Compiles binding .cpp files                                                 |
| `src/generateBindings.py`                | None                | Generates Embind/TS bindings from OCCT headers                              |
| `src/customBuildSchema.py`               | None                | Generic Cerberus schema, no hardcoded names                                 |
| `src/provenance.py`                      | None                | Build provenance tracking, fully generic                                    |
| `src/build-cache.py`                     | None                | Config-keyed compilation cache                                              |
| `src/applyPatches.py`                    | None                | OCCT-generic patches (Embind `using` workarounds, V8 bugfixes, macro leaks) |
| `src/bindings.py`                        | None                | Core Embind/TS code generation                                              |
| `src/TuInfo.py`                          | None                | libclang translation unit parsing                                           |
| `src/patches/patch_standard_dump.py`     | None                | Stubs OCCT_DUMP macros for size reduction                                   |
| `src/filter/filterPackages.py`           | None                | Empty-name guard only; all name-based filtering moved to YAML               |
| `src/filter/filterClasses.py`            | None                | Returns `True` (all logic in YAML config)                                   |
| `src/filter/filterMethodOrProperties.py` | None                | AST-based semantic checks only (streams, iterators, deleted ctors)          |
| `src/filter/filterTypedefs.py`           | None                | Semantic: `::Iterator` and handle-type checks                               |
| `src/filter/filterEnums.py`              | None                | Empty-name guard only                                                       |
| `src/filter/filterIncludeFiles.py`       | None                | Extension check (`.hxx` only)                                               |
| `src/filter/filterSourceFiles.py`        | None                | Extension + GTest exclusion                                                 |
| `src/ocjs_bindgen/__init__.py`           | None                | Package docstring only                                                      |
| `src/ocjs_bindgen/__main__.py`           | None                | CLI entry point, config-driven                                              |
| `src/ocjs_bindgen/config.py`             | None                | Loads YAML config, defaults to `bindgen-filters.yaml`                       |
| `src/ocjs_bindgen/filters.py`            | None                | Monkey-patches filter modules with config-driven wrappers                   |
| `src/wasmGenerator/Common.py`            | None                | Shared utilities (SkipException, overload postfix, etc.)                    |

### Shell scripts

| File                             | Replicad references | Notes                                                               |
| -------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `build-wasm.sh`                  | None                | Generic build orchestrator; YAML config path is a required argument |
| `build-native.sh`                | None                | Native (non-WASM) build variant                                     |
| `scripts/clone-deps.sh`          | None                | Clones deps from `DEPS.json` at pinned commits                      |
| `scripts/docker-e2e-validate.sh` | None                | Docker E2E using generic `build-configs/full.yml`                   |
| `src/createPatch.sh`             | None                | Patch creation helper                                               |
| `runAction.sh`                   | None                | GitHub Actions CI runner setup (upstream)                           |

### YAML configs

| File                                 | Replicad references | Notes                                                |
| ------------------------------------ | ------------------- | ---------------------------------------------------- |
| `bindgen-filters.yaml`               | None                | Generic exclusion lists with clear category comments |
| `bindgen-filters-no-deprecated.yaml` | None                | Minimal overlay for deprecated symbols               |

### Build schema

| File                       | Replicad references | Notes                                                                      |
| -------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `src/customBuildSchema.py` | None                | Cerberus schema — `name`, `bindings`, `emccFlags` fields are fully generic |

## Documentation-only mentions

| File                       | Line | Content                                                                | Verdict                                 |
| -------------------------- | ---- | ---------------------------------------------------------------------- | --------------------------------------- |
| `README.md`                | 148  | `[RepliCAD](https://replicad.xyz/) — Library and Code-CAD Design Tool` | Acceptable (upstream community listing) |
| `website/docs/01-about.md` | 17   | `[RepliCAD](https://replicad.xyz/): Library and Code-CAD Design Tool`  | Acceptable (upstream community listing) |

## Patch Analysis (applyPatches.py)

All patches are OCCT-generic, required for Emscripten/Embind compilation:

| Patch                                           | Purpose                                          | Consumer-agnostic? |
| ----------------------------------------------- | ------------------------------------------------ | ------------------ |
| `AIS_Shape.hxx` using→forwarding                | Embind can't bind C++ `using` declarations       | Yes                |
| `BlendFunc_ChamfInv.hxx` using→forwarding       | Same Embind limitation                           | Yes                |
| `BlendFunc_ConstThroatInv.hxx` using→forwarding | Same Embind limitation                           | Yes                |
| `Graphic3d_Buffer.hxx` using→forwarding         | Same Embind limitation                           | Yes                |
| `V3d_DirectionalLight.hxx` using→forwarding     | Same Embind limitation                           | Yes                |
| `V3d_SpotLight.hxx` using→forwarding            | Same Embind limitation                           | Yes                |
| `BRepAlgoAPI_Algo.hxx` using→forwarding         | Same Embind limitation (14 methods)              | Yes                |
| `MathLin_EigenSearch.hxx` missing field         | OCCT V8 RC bug — missing `NbIterations` field    | Yes                |
| `IntCurve_IntConicConic.lxx` macro undef        | Leaking `CONSTRUCTOR`/`PERFORM` macros from .lxx | Yes                |

## Filter Analysis (bindgen-filters.yaml)

All package exclusions fall into generic categories:

- **Draw module** (interactive testing tools, not needed in WASM)
- **Visualization module** (rendering done in Three.js/WebGL, not OCCT)
- **Data Exchange** (IGES, VRML, GLTF, OBJ, PLY, Cascade native — only STEP+STL kept)
- **Persistence/serialization drivers** (Bin/Xml/Std drivers — not needed in WASM)
- **Expression parser** (Expr/ExprIntrp — not needed)
- **Helix geometry** (TKHelix — not bound)
- **XBRepMesh** (naming clash with BRepMesh)
- **TKDE plugin framework** (no bindings needed)

No exclusion references replicad or any other consumer by name.

## Remaining Replicad Integration Points (Expected)

These are the **only** places replicad should appear in the Tau workspace:

1. **YAML overlay config** — consumer-specific symbol list for link-time selection
   (e.g. `tarballs/experiments/*/` build configs listing which OCCT symbols replicad needs)
2. **Tau test suite** — validation that the WASM binary works with replicad
   (e.g. `packages/kernels/` replicad kernel tests)
3. **Tau orchestrator** — `packages/wasm-build/` which invokes opencascade.js
   build-wasm.sh with a consumer-specific YAML config

## Conclusion

The opencascade.js core scripts are fully consumer-agnostic. Replicad
integrates exclusively through:

- An overlay YAML config that selects symbols at link time
- The Tau test suite that validates the resulting WASM binary

No changes were required.
