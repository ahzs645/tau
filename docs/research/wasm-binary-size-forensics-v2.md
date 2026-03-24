---
title: 'WASM Binary Size Forensics v2: Function-Level Dissection and Inflation Analysis'
description: 'Comprehensive function-level analysis of the optimized 19.22 MB non-exceptions WASM binary, explaining the 87% inflation from OCCT v7 and identifying remaining trimming opportunities.'
status: active
created: '2026-03-24'
updated: '2026-03-23'
category: optimization
related:
  - docs/research/wasm-binary-size-forensics.md
  - docs/research/wasm-size-analysis-v762-vs-v8rc4.md
  - docs/research/emscripten-optimization-flags.md
  - docs/research/occt-wasm-optimization.md
---

# WASM Binary Size Forensics v2: Function-Level Dissection and Inflation Analysis

Function-level dissection of the optimized `replicad_single.wasm` (19.22 MB) to explain the persistent 87% inflation over OCCT v7 builds and identify actionable trimming opportunities.

## Executive Summary

The optimized `replicad_single.wasm` is **19.22 MB** (20,153,116 bytes), down from 19.31 MB pre-optimization — a **89 KB (0.44%) actual reduction** from the OCCT source patches applied in the v1 optimization round. The binary remains **87% larger** than the v7 baseline (10.30 MB) despite having **7,612 fewer functions**. The entire inflation is in the Code section (+9.25 MB, +117%).

The root cause is **compile-time -O3 optimization**, which produces aggressively inlined functions averaging 732 bytes (vs 256 bytes in v7's `-Os -flto` build). Functions >4 KB grew by **+6.69 MB** — accounting for 72% of the total code growth. If the v8 build had v7-like average function sizes, the code section would be 5.85 MB instead of 16.73 MB.

The v1 report's OCCT source patches (noexcept destructor, DynamicType simplification) reduced pathological functions by only **319 B and 323 B respectively** — not the hundreds of kilobytes expected. The landing pad code is not the primary cause of these functions' size; -O3 inlining is.

The highest-value remaining opportunities are **compile-time optimization reduction** (`-O2` or `-Os`) and **LLVM inlining threshold tuning**, which directly address the primary root cause of -O3 inlining bloat. `-fno-exceptions` was investigated and found to be **not viable** — Clang treats `throw` as a hard compilation error with `-fno-exceptions`, and OCCT uses `throw` extensively in its headers. The upstream v7 build never used `-fno-exceptions` either; it always compiled with `-fexceptions`. Estimated savings from optimization level changes are **3–7 MB**.

## Table of Contents

- [Methodology](#methodology)
- [Finding 1: WASM Section Breakdown](#finding-1-wasm-section-breakdown)
- [Finding 2: Historical Size Evolution](#finding-2-historical-size-evolution)
- [Finding 3: v7 → v8 Inflation Root Cause](#finding-3-v7--v8-inflation-root-cause)
- [Finding 4: Function Size Distribution](#finding-4-function-size-distribution)
- [Finding 5: Top 30 Largest Functions](#finding-5-top-30-largest-functions)
- [Finding 6: OCCT Toolkit Code Breakdown](#finding-6-occt-toolkit-code-breakdown)
- [Finding 7: Patch Effectiveness Analysis](#finding-7-patch-effectiveness-analysis)
- [Finding 8: Gzipped Transfer Sizes](#finding-8-gzipped-transfer-sizes)
- [Recommendations](#recommendations)
- [Finding 9: `-fno-exceptions` Is Not Viable for OCCT](#finding-9--fno-exceptions-is-not-viable-for-occt)
- [Appendix: Full Package Inventory](#appendix-full-package-inventory)

## Methodology

**Tools:**

- `wasm-objdump -h/-x` (WABT 1.0.39) for section and function-level analysis
- `replicad_single.js.symbols` (Emscripten symbol map) for function name resolution
- Python aggregation scripts for toolkit grouping, size comparison, and distribution analysis
- Historical tarballs extracted for comparative analysis: v7 (0.20.2), v8.25, v8.26, v8.32, v8.39 (original), v8.39 (optimized)

**Build configuration (current optimized):** `O3-simd`, `OCJS_OPT=-O3`, `OCJS_LTO=0`, `OCJS_SIMD=1`, `OCJS_EXCEPTIONS=0`, `wasm-opt -O4 --converge --traps-never-happen`, OCCT patches applied (`patch_stepcaf_noexcept.py` + `patch_stepcaf_dyntype.py`).

**Symbol map caveat:** The `.js.symbols` file maps pre-wasm-opt function indices to C++ names. After wasm-opt renumbers functions, name assignments in the analysis may be shifted. Function SIZE data (from `wasm-objdump`) is accurate; name resolution is best-effort. Cross-build comparisons use size-based matching.

## Finding 1: WASM Section Breakdown

| Section   | Size                        | % of File | Count  |
| --------- | --------------------------- | --------- | ------ |
| Code      | 17,545,596 B (16.73 MB)     | 87.1%     | 23,995 |
| Data      | 2,488,918 B (2.37 MB)       | 12.3%     | 3,101  |
| Elem      | 54,730 B (53.4 KB)          | 0.3%      | 1      |
| Function  | 24,694 B (24.1 KB)          | 0.1%      | 23,995 |
| Type      | 6,962 B (6.8 KB)            | <0.1%     | 571    |
| Other     | 31,216 B (30.5 KB)          | 0.2%      | —      |
| **Total** | **20,153,116 B (19.22 MB)** | **100%**  |        |

The Code section dominates at 87.1%. The Data section (2.37 MB) is the only other significant contributor. Elem (indirect call table) and metadata sections are negligible.

## Finding 2: Historical Size Evolution

### All Builds Compared

| Build                    | Compile Flags | Total (MB) | Code (MB) | Data (MB) | Functions  | Avg Size  | Gzip (MB) |
| ------------------------ | ------------- | ---------- | --------- | --------- | ---------- | --------- | --------- |
| v7 (OCCT 7.6.2)          | `-Os -flto`   | **10.30**  | 7.74      | 2.46      | 31,607     | 256 B     | 4.31      |
| v8.25 (initial v8)       | `-O3 -flto`   | 23.39      | 20.92     | 2.51      | 21,191     | 988 B     | —         |
| v8.26 (post-LTO removal) | `-O3`         | 18.91      | 16.27     | 2.55      | 24,697     | 690 B     | 6.08      |
| v8.32 (pre-RBV)          | `-O3`         | 19.23      | 16.77     | 2.37      | 24,038     | 731 B     | 6.14      |
| v8.39 original           | `-O3`         | 19.31      | 16.85     | 2.38      | 24,121     | 732 B     | 6.16      |
| **v8.39 optimized**      | **`-O3`**     | **19.22**  | **16.73** | **2.37**  | **23,995** | **732 B** | **6.13**  |

### Key Transitions

| Transition         | Code Delta   | Data Delta | Total Delta   | Root Cause                  |
| ------------------ | ------------ | ---------- | ------------- | --------------------------- |
| v7 → v8.25         | +13.18 MB    | +0.05 MB   | **+13.09 MB** | LTO cross-module inlining   |
| v8.25 → v8.26      | -4.65 MB     | +0.04 MB   | **-4.48 MB**  | Removed LTO (OCJS_LTO=0)    |
| v8.26 → v8.32      | +0.50 MB     | -0.18 MB   | **+0.32 MB**  | Config changes, filtering   |
| v8.32 → v8.39 orig | +0.08 MB     | +0.01 MB   | **+0.08 MB**  | RBV bindings, minor changes |
| v8.39 orig → opt   | **-0.08 MB** | -0.01 MB   | **-0.09 MB**  | OCCT source patches         |

The v8.25 build (with LTO) was 23.39 MB — **127% larger** than v7. Removing LTO (OCJS_LTO=0) in v8.26 saved 4.48 MB, bringing it to 18.91 MB. Since then, incremental changes added ~0.31 MB and patches removed ~0.09 MB.

## Finding 3: v7 → v8 Inflation Root Cause

The v8 optimized build is **+8.92 MB (+87%)** larger than v7. Growth by section:

| Section   | v7           | v8 opt       | Delta        | % Change  |
| --------- | ------------ | ------------ | ------------ | --------- |
| Code      | 7.74 MB      | 16.73 MB     | **+8.99 MB** | **+116%** |
| Data      | 2.46 MB      | 2.37 MB      | -0.09 MB     | -4%       |
| Elem      | 67.7 KB      | 53.4 KB      | -14.2 KB     | -21%      |
| **Total** | **10.30 MB** | **19.22 MB** | **+8.92 MB** | **+87%**  |

The entire inflation is in the Code section. Data actually shrank.

### Root Cause 1: Compile-Time -O3 vs -Os + LTO Pipeline Difference (Primary — ~6-8 MB)

The upstream v7 build compiled OCCT at **`-Os -flto`** (size-optimized with LTO). Our v8 build compiles at **`-O3`** without LTO. The upstream flags are hardcoded in `repos/opencascade.js-upstream/src/compileSources.py` (lines 55-62):

```python
# Upstream master (v7 npm package)
command = ["emcc", "-flto", "-fexceptions", ..., "-Os", ...]
```

Our fork parameterized these via `OCJS_OPT` / `OCJS_LTO` env vars, and the `O3-simd` configuration sets `-O3` without LTO — prioritizing runtime performance over binary size:

| Flag        | Upstream v7       | Our v8        | Effect                                                   |
| ----------- | ----------------- | ------------- | -------------------------------------------------------- |
| Compile opt | `-Os` (size)      | `-O3` (speed) | -O3 inlines aggressively, duplicating code at call sites |
| LTO         | `-flto` (enabled) | no LTO        | LTO with -Os enables cross-module size optimization      |

| Metric                | v7 (-Os + LTO) | v8 opt (-O3, no LTO) | Ratio         |
| --------------------- | -------------- | -------------------- | ------------- |
| Function count        | 31,607         | 23,995               | 0.76x         |
| Average function size | 256 B          | 732 B                | **2.86x**     |
| Median function size  | 51 B           | 108 B                | 2.1x          |
| P99 function size     | 3,404 B        | 9,715 B              | 2.9x          |
| P99.9 function size   | 16,078 B       | 55,414 B             | **3.4x**      |
| Functions >4 KB       | 235 (2,955 KB) | 649 (9,642 KB)       | **+6,687 KB** |
| Functions >16 KB      | 31 (1,478 KB)  | 126 (5,804 KB)       | **+4,326 KB** |

The v8 build has 7,612 fewer functions but each is nearly 3x larger. Functions >4 KB grew by **+6.69 MB**, accounting for **72% of total code growth**. If the v8 build had v7-like average function sizes, the code section would be **5.85 MB** instead of 16.73 MB.

The v7 pipeline used `-Os` at compile time (which limits inlining and favors smaller code) combined with `-flto` (which enables LLVM to do cross-module dead code elimination at the size-optimized level). Our v8 build uses `-O3` at compile time, causing LLVM to aggressively inline helper functions into callers at the IR level (before WASM emission), duplicating code at every call site. We disabled LTO because with `-O3`, LTO caused catastrophic inlining bloat (23.39 MB at v8.25).

### Root Cause 2: OCCT v8 Source Code Growth (~2-3 MB)

OCCT v8 introduces larger, more complex algorithms: improved BOPAlgo boolean operations, rewritten BRepOffset, NCollection robin-hood hash maps (more template instantiations), and AP242 STEP support with PMI. Even without inlining differences, the v8 source code is ~20-30% larger in compiled toolkits.

### Root Cause 3: Emscripten / LLVM Version (~0.5-1 MB)

v7 used Emscripten 3.1.14 (LLVM ~15), v8 uses Emscripten 5.0.1 (LLVM 23). Different code generation patterns, instruction selection, and lowering strategies produce slightly larger WASM.

### API Surface Paradox

Despite the larger binary, v8 exposes **fewer bound classes** than v7:

| Metric             | v7    | v8 opt |
| ------------------ | ----- | ------ |
| Bound classes      | 821   | 202    |
| Methods/properties | 5,285 | 5,598  |

v7 had 821 classes (including many `Handle_*` wrappers). v8 consolidated to 202 classes with +313 methods. The size increase is NOT from more bindings — it's from the underlying compiled code being larger per function.

## Finding 4: Function Size Distribution

| Bucket              | Count  | % Funcs | Total Size             | % Code |
| ------------------- | ------ | ------- | ---------------------- | ------ |
| Tiny (0-64 B)       | 6,637  | 27.7%   | 230,498 B (225 KB)     | 1.3%   |
| Small (64-256 B)    | 10,134 | 42.2%   | 1,265,055 B (1,235 KB) | 7.2%   |
| Medium (256 B-1 KB) | 4,572  | 19.1%   | 2,341,455 B (2,287 KB) | 13.3%  |
| Large (1-4 KB)      | 2,003  | 8.4%    | 3,834,993 B (3,745 KB) | 21.9%  |
| Huge (4-16 KB)      | 523    | 2.2%    | 3,930,008 B (3,838 KB) | 22.4%  |
| Gigantic (16-64 KB) | 108    | 0.5%    | 3,041,138 B (2,970 KB) | 17.3%  |
| Colossal (>64 KB)   | 18     | 0.1%    | 2,902,449 B (2,834 KB) | 16.5%  |

The top 126 functions (0.5% by count) contain **33.9% of all code** (5.80 MB). The top 649 functions (>4 KB, 2.7% by count) contain **56.2% of all code** (9.64 MB). This extreme concentration makes inlining reduction the highest-leverage optimization.

## Finding 5: Top 30 Largest Functions

| #   | Size               | Function (resolved from symbol map)                                      |
| --- | ------------------ | ------------------------------------------------------------------------ |
| 1   | 554,683 B (542 KB) | `Resource_Manager::SetResource(char const*, int)`                        |
| 2   | 377,277 B (368 KB) | `BRepOffset_Tool::FindCommonShapes(...)`                                 |
| 3   | 330,115 B (322 KB) | `BRepPrimAPI_MakeBox::Build(...)`                                        |
| 4   | 227,702 B (222 KB) | `Resource_Manager::~Resource_Manager()`                                  |
| 5   | 196,221 B (192 KB) | `BRepLProp::Continuity(...)`                                             |
| 6   | 137,385 B (134 KB) | `BOPAlgo_ShapeSolid::~BOPAlgo_ShapeSolid()`                              |
| 7   | 122,177 B (119 KB) | `STEPConstruct_Styles::NbStyles() const`                                 |
| 8   | 117,510 B (115 KB) | `RWStepAP214_RWAutoDesignActualDateAndTimeAssignment::ReadStep(...)`     |
| 9   | 108,179 B (106 KB) | `BRepFill_NSections::~BRepFill_NSections()`                              |
| 10  | 101,846 B (99 KB)  | `IntPatch_Intersection::Perform(...)`                                    |
| 11  | 97,901 B (96 KB)   | `HatchGen_PointOnElement::Dump(int) const`                               |
| 12  | 88,658 B (87 KB)   | `BRepFilletAPI_MakeChamfer::Builder() const`                             |
| 13  | 84,312 B (82 KB)   | `ChFiDS_FilSpine::Radius() const`                                        |
| 14  | 75,343 B (74 KB)   | `Standard_Failure::Standard_Failure(char const*, char const*)`           |
| 15  | 73,561 B (72 KB)   | `ShapeUpgrade_ConvertCurve2dToBezier::Compute()`                         |
| 16  | 70,571 B (69 KB)   | `BRepOffsetAPI_ThruSections::~BRepOffsetAPI_ThruSections()`              |
| 17  | 70,248 B (69 KB)   | `BRepGProp_Face::Load(TopoDS_Edge const&)`                               |
| 18  | 68,760 B (67 KB)   | `ChFi3d_FilBuilder::SetRadius(...)`                                      |
| 19  | 65,438 B (64 KB)   | `STEPControl_Writer::STEPControl_Writer(...)`                            |
| 20  | 64,126 B (63 KB)   | `RWStepBasic_RWProductDefinitionRelationship::ReadStep(...)`             |
| 21  | 62,830 B (61 KB)   | `ChFi3d_NumberOfSharpEdges(...)`                                         |
| 22  | 61,764 B (60 KB)   | `ShapeFix_Wire::FixConnectedMode()`                                      |
| 23  | 57,264 B (56 KB)   | `ShapeFix_IntersectionTool::FindVertAndSplitEdge(...)`                   |
| 24  | 55,414 B (54 KB)   | `BRepClass3d_SolidClassifier::BRepClass3d_SolidClassifier()`             |
| 25  | 53,706 B (52 KB)   | `BRepFill_Sweep::MergeVertex(...) const`                                 |
| 26  | 49,597 B (48 KB)   | `BRepMeshData_Edge::~BRepMeshData_Edge()`                                |
| 27  | 49,047 B (48 KB)   | `AppParCurves_MultiCurve::Pole(int, int) const`                          |
| 28  | 49,039 B (48 KB)   | `GeomInt_TheZerImpFuncOfTheImpPrmSvSurfacesOfWLApprox::Derivatives(...)` |
| 29  | 49,039 B (48 KB)   | `BRepBlend_Line::~BRepBlend_Line()`                                      |
| 30  | 47,160 B (46 KB)   | `IntPatch_Point::IntPatch_Point(IntPatch_Point const&)`                  |

**Note:** Function names are resolved from the pre-wasm-opt symbol map and may be shifted by wasm-opt renumbering. Sizes are accurate.

Functions #1 (542 KB), #4 (222 KB), #6 (134 KB), #9 (106 KB), #11 (96 KB), #14 (74 KB), and #16 (69 KB) are **structurally anomalous** — destructors, copy constructors, accessors, and dump methods should not be this large. These are inflated by -O3 inlining of their member operations into the function body.

## Finding 6: OCCT Toolkit Code Breakdown

| #   | Toolkit                                                  | Functions | Size (KB) | % Code   |
| --- | -------------------------------------------------------- | --------- | --------- | -------- |
| 1   | TKGeomBase/Algo (Geom, GeomFill, GeomInt, etc.)          | 1,909     | 1,271     | 7.4%     |
| 2   | TKDESTEP (STEP I/O)                                      | 2,650     | 1,161     | 6.8%     |
| 3   | TKernel Core (Standard, Message, Resource)               | 319       | 1,030     | 6.0%     |
| 4   | TKShHealing/Prim/Algo (BRepPrimAPI, BRepAlgoAPI, etc.)   | 512       | 982       | 5.7%     |
| 5   | TKShHealing (ShapeFix, ShapeAnalysis, ShapeUpgrade)      | 598       | 945       | 5.5%     |
| 6   | TKBO (BOPAlgo, BOPTools, IntTools)                       | 540       | 905       | 5.3%     |
| 7   | TKFillet (BRepFill, BRepBlend, BlendFunc)                | 643       | 839       | 4.9%     |
| 8   | Embind (JS binding infrastructure)                       | 1,893     | 794       | 4.6%     |
| 9   | TKGeomAlgo Approximation (AppDef, Extrema, BSplCLib)     | 550       | 736       | 4.3%     |
| 10  | TKOffset (BRepOffset, BRepClass3d)                       | 106       | 664       | 3.9%     |
| 11  | TKFillet Chamfer/Fillet (ChFi3d, ChFiDS, ChFiKPart)      | 254       | 612       | 3.6%     |
| 12  | **TKTopOpeBRep (deprecated old booleans)**               | **488**   | **610**   | **3.6%** |
| 13  | TKGeomAlgo Intersection (IntPatch, IntSurf, IntCurve)    | 376       | 482       | 2.8%     |
| 14  | TKBRep Core (BRep, BRepTools, BRepLib, TopExp)           | 450       | 354       | 2.1%     |
| 15  | TKXS Transfer (IFSelect, Interface, XSControl, Transfer) | 910       | 347       | 2.0%     |
| 16  | TKernel Collections (NCollection, TCollection, TColStd)  | 2,107     | 324       | 1.9%     |
| 17  | TKMesh (BRepMesh)                                        | 350       | 291       | 1.7%     |
| 18  | TKXCAF Document/Label (XCAFDoc, TDF, TDataStd)           | 669       | 234       | 1.4%     |
| 19  | C++ Runtime/stdlib                                       | 505       | 189       | 1.1%     |
| 20  | TKHLRBRep (Hidden Line Removal)                          | 208       | 182       | 1.1%     |
| 21  | Other/Unknown                                            | 4,556     | 2,090     | 12.2%    |

### Category Rollup

| Category                   | Size     | % Code | Notes                                          |
| -------------------------- | -------- | ------ | ---------------------------------------------- |
| Boolean/Offset operations  | 2,179 KB | 12.7%  | TKBO + TKOffset + TopOpeBRep (deprecated)      |
| Geometry algorithms        | 2,760 KB | 16.1%  | TKGeomBase/Algo + Intersection + Approximation |
| STEP I/O + Transfer        | 1,530 KB | 8.9%   | TKDESTEP + TKXS                                |
| Shape healing + primitives | 1,927 KB | 11.2%  | TKShHealing + TKShHealing/Prim/Algo            |
| Fillet/Chamfer             | 1,451 KB | 8.5%   | TKFillet + TKFillet Chamfer                    |
| Embind                     | 794 KB   | 4.6%   | JS binding dispatch and registration           |
| Kernel/Runtime             | 1,543 KB | 9.0%   | TKernel + Collections + C++ runtime            |

**TopOpeBRep (deprecated old boolean engine)** consumes 610 KB (3.6%) despite being entirely deprecated in OCCT 8. It is pulled by transitive dependencies from BRepMesh and BRepBuilderAPI and cannot be removed via bindgen filters or linker-level dead code elimination.

## Finding 7: Patch Effectiveness Analysis

The v1 optimization round applied two OCCT source patches and various build flag changes. Direct comparison of function sizes between the v8.39 original and optimized builds reveals the actual impact.

### Patch Impact: Top 20 Functions

| Rank | Original Size | Optimized Size | Delta           | Function (v1 report identity)          |
| ---- | ------------- | -------------- | --------------- | -------------------------------------- |
| 1    | 555,002 B     | 554,683 B      | **-319 B**      | STEPCAFControl_ActorWrite::~           |
| 2    | 377,308 B     | 377,277 B      | -31 B           | BRepOffset_Tool::Deboucle3D            |
| 3    | 330,129 B     | 330,115 B      | -14 B           | BRepPrimAPI_MakeBox::Shell             |
| 4    | 228,025 B     | 227,702 B      | **-323 B**      | STEPCAFControl_Controller::DynamicType |
| 5    | 196,310 B     | 196,221 B      | -89 B           | BRepGProp_Face::Load                   |
| 6-20 | —             | —              | -1 to +2 B each | Various                                |

**The noexcept destructor patch reduced the target function by only 319 B (0.06%).** The DynamicType patch reduced its target by only 323 B (0.14%). These are orders of magnitude less than the 555 KB and 228 KB savings estimated in the v1 report.

### Why Patches Had Minimal Effect

1. **Landing pads are not the primary cause of function bloat.** The v1 report assumed the 555 KB destructor was large because of exception handling landing pads. The patches eliminated landing pad generation for those specific functions. However, the 319 B reduction proves that landing pads contributed negligibly — the 542 KB is almost entirely from -O3 inlining of member destructor bodies (Handle<> reference counting, NCollection cleanup) into the parent destructor.

2. **`-sDISABLE_EXCEPTION_CATCHING=1` already neutralizes landing pads at the JS level.** The non-exceptions build converts all `throw` to abort via JS stubs. The WASM landing pad code exists but never executes. The noexcept patch prevented the compiler from _generating_ landing pads, but the generated landing pads were already small relative to the inlined cleanup code.

3. **Overall binary savings: 89 KB across 23,995 functions.** The 126 removed functions and scattered small reductions totaled 85 KB in code + 4 KB in data. The savings came from wasm-opt being able to eliminate slightly more dead code after the patched functions had fewer internal branches.

### Corrected v1 Report Claims

The v1 report's "Optimization Experiment Results" section stated a 5.1% (1.03 MB) reduction for non-exceptions. The actual measured reduction is:

| Metric    | v1 Report Claim         | Actual Measured               |
| --------- | ----------------------- | ----------------------------- |
| Original  | 20.24 MB (20,244,707 B) | 20,244,707 B (19.31 MiB)      |
| Optimized | 19.21 MB (claimed)      | 20,153,116 B (19.22 MiB)      |
| Reduction | 1.03 MB (5.1%)          | **91,591 B (89.4 KB, 0.44%)** |

The discrepancy suggests the v1 report may have compared against a different baseline or used inconsistent units.

## Finding 8: Gzipped Transfer Sizes

Gzip compression significantly reduces the impact of code bloat:

| Build           | Raw (MB) | Gzip (MB) | Ratio |
| --------------- | -------- | --------- | ----- |
| v7 (OCCT 7.6.2) | 10.30    | 4.31      | 42%   |
| v8.26           | 18.91    | 6.08      | 32%   |
| v8.32           | 19.23    | 6.14      | 32%   |
| v8.39 original  | 19.31    | 6.16      | 32%   |
| v8.39 optimized | 19.22    | 6.13      | 32%   |

The v8 binary compresses more efficiently (32% ratio vs v7's 42%) due to the -O3 inlined code having more repetitive patterns. The gzipped v8 delta vs v7 is **+1.82 MB** (42% inflation), far less severe than the raw +8.92 MB (87% inflation). Brotli compression would reduce the transfer size further.

## Recommendations

### P0: Critical — Estimated 2-5 MB Savings

| #      | Action                                                   | Mechanism                                                                                                               | Est. Savings | Risk                                                                          |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| ~~R1~~ | ~~**Compile with `-fno-exceptions`**~~                   | ~~Eliminates ALL landing pad code~~                                                                                     | ~~1-3 MB~~   | **REJECTED — not viable (see Finding 9)**                                     |
| R2     | **Switch compile-time optimization from `-O3` to `-O2`** | Reduces LLVM inlining aggressiveness. Functions stay smaller and more numerous. wasm-opt still optimizes at WASM level. | 1-3 MB       | Low: -O2 produces slightly slower code. v7 shipped with -Os and was adequate. |
| R3     | **Test `-O3` with `-mllvm -inline-threshold=100`**       | Keeps -O3 optimizations but limits inlining depth. Fine-tunable threshold.                                              | 1-2 MB       | Low: easily reversible.                                                       |

### Finding 9: `-fno-exceptions` Is Not Viable for OCCT

**Status**: ❌ REJECTED

The original v2 R1 recommendation claimed `-fno-exceptions` was distinct from the v1-rejected `-DNo_Exception` define and would silently convert `throw` to `std::terminate`. **This was incorrect.** Build testing and upstream investigation disproved the recommendation.

#### Build failure

Clang's `-fno-exceptions` makes `throw` and `try`/`catch` **hard compilation errors**, not silent conversions:

```
error: cannot use 'throw' with exceptions disabled
  Standard_ConstructionError_Raise_if(aD <= gp::Resolution(), ...)
  ^
note: expanded from macro 'Standard_ConstructionError_Raise_if'
  throw Standard_ConstructionError(MESSAGE);
  ^
fatal error: too many errors emitted, stopping now [-ferror-limit=]
```

OCCT uses `throw` pervasively in its headers via `_Raise_if` macros (hundreds of call sites across all toolkits). The PCH compilation fails immediately.

#### Upstream never used `-fno-exceptions`

Investigation of the upstream `opencascade.js` repo (`repos/opencascade.js-upstream/src/compileSources.py`) confirmed that **`-fno-exceptions` was never used in any version**:

- **Upstream v7 flags**: `-fexceptions`, `-sDISABLE_EXCEPTION_CATCHING=0`, `-Os`, `-flto`
- **Our fork v8 flags**: no explicit `-fexceptions` (Clang default: exceptions enabled), `-sDISABLE_EXCEPTION_CATCHING=1`
- **No trace** of `-fno-exceptions` anywhere in the upstream codebase or its git history

The upstream "no exceptions" mode (`no-exceptions.yml`) uses Emscripten's `-sDISABLE_EXCEPTION_CATCHING=1` — a runtime-level toggle — not Clang's `-fno-exceptions`.

#### OCCT v8 vs v7.6.2: exception handling is structurally identical

The `No_Exception` / `_Raise_if` preprocessor pattern is **unchanged between OCCT v7.6.2 and v8**:

```cpp
// Same pattern in both v7.6.2 and v8:
#if !defined No_Exception && !defined No_Standard_ConstructionError
  #define Standard_ConstructionError_Raise_if(COND, MSG) \
    if (COND) throw Standard_ConstructionError(MSG);
#else
  #define Standard_ConstructionError_Raise_if(COND, MSG)
#endif
```

What v8 changed was the `Standard_Failure` class model (from inheriting `Standard_Transient` with `Raise()`/`Reraise()` to inheriting `std::exception` with `what()`, commit `e1d36343e4`). This is a style refactor, not a fundamental exception architecture change — both versions use `throw`.

#### All exception-related approaches exhausted

| Approach                                      | Viable?                 | Why                                                                              |
| --------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `-fno-exceptions` (Clang flag)                | **No**                  | `throw` is a hard compilation error; OCCT headers use `throw` pervasively        |
| `-DNo_Exception` (OCCT define)                | **No**                  | Removes precondition checks; 11 tests fail with `unreachable` traps (v1 finding) |
| `-sDISABLE_EXCEPTION_CATCHING=1` (Emscripten) | **Already applied**     | Neutralizes JS-side catch wrappers; does not eliminate LLVM landing pads         |
| `-sDISABLE_EXCEPTION_THROWING=1` (Emscripten) | **Untested, low value** | Converts `__cxa_throw` to abort at link time; landing pads still generated       |

**Conclusion**: Exception-related code elimination is a dead end for OCCT WASM builds. The binary size reduction must come from **optimization level changes** (R2, R3, R5) which address the primary root cause: `-O3` inlining bloat.

### P1: High Priority — Estimated 0.5-1.5 MB Savings

| #   | Action                                  | Mechanism                                                                                                                                                     | Est. Savings | Risk                                                                            |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| R4  | **Compile with `-fno-rtti`**            | Disables C++ RTTI (`dynamic_cast`, `typeid`). OCCT uses RTTI extensively via `DynamicType()`, but the replicad binding surface may not require it at runtime. | 0.5-1 MB     | High: OCCT's Handle<> casting uses `dynamic_cast` internally. Requires testing. |
| R5  | **Test `-Os` compile + `-O3` wasm-opt** | Compile OCCT at -Os (size-optimized) but run wasm-opt at -O3/O4. Previous `-Os` LTO build produced 14.85 MB. Without LTO, estimated ~15-16 MB.                | 1-2 MB       | Low: may reduce runtime performance by 5-10%.                                   |

### P2: Medium Priority — Estimated 0.3-1 MB Savings

| #   | Action                                                  | Mechanism                                                                                                                                                                                                                                        | Est. Savings | Risk |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---- |
| R6  | **wasm-opt `--merge-similar-functions`** pass           | Merges functions with identical bodies (common with template instantiations). May already be included in -O4.                                                                                                                                    | 50-200 KB    | Low  |
| R7  | **wasm-opt `--dae-optimizing` + `--outlining`**         | Dead argument elimination and code outlining (extract common code sequences).                                                                                                                                                                    | 50-150 KB    | Low  |
| R8  | **OCCT patch: add `noexcept` to ALL large destructors** | Extend `patch_stepcaf_noexcept.py` pattern to the top 15 destructors (currently only covers STEPCAFControl_ActorWrite). Even though the v1 patch had minimal effect per function, aggregating across 15+ functions may yield measurable savings. | 30-100 KB    | Low  |

### P3: Low Priority / Deferred

| #       | Action                                             | Notes                                                                                                                                                                                                     |
| ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R9      | OCCT source patches to break TopOpeBRep dependency | TopOpeBRep (610 KB) is deprecated but cannot be linker-removed. Requires patching BRepMesh/BRepBuilderAPI to remove internal calls. High effort for moderate reward.                                      |
| R10     | STEP I/O modularization                            | The monolithic `RWStepAP214_GeneralModule` registers ALL STEP entity types. Modularizing it would allow linker DCE to remove unused entity types (StepFEA, StepKinematics, etc.). Major OCCT fork effort. |
| ~~R11~~ | ~~`--closed-world` with `-fno-exceptions`~~        | **Moot** — `-fno-exceptions` is not viable (Finding 9). `--closed-world` alone was rejected in v1 (77 test failures).                                                                                     |

### Estimated Cumulative Impact

| Scenario                              | Estimated Size | vs Current      | vs v7                      |
| ------------------------------------- | -------------- | --------------- | -------------------------- |
| Current optimized                     | 19.22 MB       | —               | +87%                       |
| ~~+ R1 (`-fno-exceptions`)~~          | ~~~17-18 MB~~  | ~~-1 to -2 MB~~ | **Not viable (Finding 9)** |
| + R2 (`-O2` compile)                  | ~16-17 MB      | -2 to -3 MB     | +55-65%                    |
| + R3 (inline threshold)               | ~17-18 MB      | -1 to -2 MB     | +65-75%                    |
| + R5 (`-Os` compile + `-O3` wasm-opt) | ~14-16 MB      | -3 to -5 MB     | +36-55%                    |
| + R2 + R5 hybrid (`-Os` compile)      | ~14-16 MB      | -3 to -5 MB     | +36-55%                    |
| Theoretical minimum (v7 ratio)        | ~10.3 MB       | -8.9 MB         | 0%                         |

The theoretical minimum assumes v7-equivalent compilation efficiency with v8's code. Realistically, v8's larger source code and additional algorithms set a floor of ~12-13 MB even with maximally aggressive size optimization.

## Trade-offs: Size vs Performance

| Config        | Expected Size | Performance vs -O3 | Notes                                               |
| ------------- | ------------- | ------------------ | --------------------------------------------------- |
| -O3 (current) | 19.22 MB      | Baseline (fastest) | Best for complex boolean/fillet operations          |
| -O2           | ~16-17 MB     | -5 to -10% slower  | Good balance                                        |
| -Os           | ~14-16 MB     | -10 to -15% slower | Matches upstream v7 pipeline; adequate for most CAD |
| -Os + -flto   | ~10-12 MB     | -10 to -15% slower | Closest match to upstream v7 pipeline               |

Performance benchmarks from the v1 report show v8 with -O3 is 15-30% faster than v7 with -Os for complex operations. Even with -O2 or -Os, v8 would likely match or exceed v7's performance due to OCCT's improved algorithms.

## References

- v1 forensics report: `docs/research/wasm-binary-size-forensics.md`
- v7 vs v8 size analysis: `docs/research/wasm-size-analysis-v762-vs-v8rc4.md`
- Emscripten flags reference: `docs/research/emscripten-optimization-flags.md`
- OCCT WASM optimization: `docs/research/occt-wasm-optimization.md`
- OCCT patches: `repos/opencascade.js/src/patches/`
- Build configs: `repos/opencascade.js/build-configs/configurations.json`

## Appendix: Full Package Inventory

<details>
<summary>All OCCT packages by code size (click to expand)</summary>

| #   | Package                 | Functions | Size (KB) | % Code |
| --- | ----------------------- | --------- | --------- | ------ |
| 1   | Other/Unknown           | 4,556     | 2,090     | 12.2%  |
| 2   | TKGeomBase/Algo         | 1,909     | 1,271     | 7.4%   |
| 3   | TKDESTEP                | 2,650     | 1,161     | 6.8%   |
| 4   | TKernel Core            | 319       | 1,030     | 6.0%   |
| 5   | TKShHealing/Prim/Algo   | 512       | 982       | 5.7%   |
| 6   | TKShHealing             | 598       | 945       | 5.5%   |
| 7   | TKBO                    | 540       | 905       | 5.3%   |
| 8   | TKFillet                | 643       | 839       | 4.9%   |
| 9   | Embind                  | 1,893     | 794       | 4.6%   |
| 10  | TKGeomAlgo Approx       | 550       | 736       | 4.3%   |
| 11  | TKOffset                | 106       | 664       | 3.9%   |
| 12  | TKFillet Chamfer        | 254       | 612       | 3.6%   |
| 13  | TKTopOpeBRep            | 488       | 610       | 3.6%   |
| 14  | TKGeomAlgo Intersection | 376       | 482       | 2.8%   |
| 15  | TKBRep Core             | 450       | 354       | 2.1%   |
| 16  | TKXS Transfer           | 910       | 347       | 2.0%   |
| 17  | TKernel Collections     | 2,107     | 324       | 1.9%   |
| 18  | TKMesh                  | 350       | 291       | 1.7%   |
| 19  | TKXCAF                  | 669       | 234       | 1.4%   |
| 20  | TKBRep Properties       | 169       | 194       | 1.1%   |
| 21  | C++ Runtime             | 505       | 189       | 1.1%   |
| 22  | TKHLRBRep               | 208       | 182       | 1.1%   |
| 23  | TKGeomBase Adaptors     | 359       | 138       | 0.8%   |
| 24  | ProjLib                 | 130       | 103       | 0.6%   |
| 25  | TKTopAlgo Hatching      | 11        | 99        | 0.6%   |
| 26  | TKMath                  | 233       | 95        | 0.6%   |
| 27  | BRepPrim                | 67        | 88        | 0.5%   |
| 28  | MAT2d                   | 40        | 75        | 0.4%   |
| 29  | BRepApprox              | 56        | 66        | 0.4%   |
| 30  | BRepTopAdaptor          | 37        | 65        | 0.4%   |
| 31  | Bisector                | 94        | 59        | 0.3%   |
| 32  | Quantity                | 59        | 52        | 0.3%   |
| 33  | TKBRep Topology         | 102       | 51        | 0.3%   |
| 34  | MAT                     | 50        | 48        | 0.3%   |
| 35  | AdvApp2Var              | 56        | 46        | 0.3%   |
| 36  | Contap                  | 43        | 45        | 0.3%   |
| 37  | IntPolyh                | 38        | 42        | 0.2%   |
| 38  | StepDimTol              | 184       | 41        | 0.2%   |
| 39+ | (61 more packages)      | 1,077     | 433       | 2.5%   |

</details>
