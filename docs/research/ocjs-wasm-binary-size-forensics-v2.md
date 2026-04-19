---
title: 'WASM Binary Size Forensics v2: Function-Level Dissection and Inflation Analysis'
description: 'Comprehensive function-level analysis of the optimized 19.22 MB non-exceptions WASM binary, explaining the 87% inflation from OCCT v7 and identifying remaining trimming opportunities.'
status: active
created: '2026-03-24'
updated: '2026-03-25'
category: optimization
related:
  - docs/research/ocjs-wasm-binary-size-forensics.md
  - docs/research/ocjs-wasm-size-analysis-v762-vs-v8rc4.md
  - docs/research/emscripten-optimization-flags.md
  - docs/research/ocjs-wasm-optimization.md
---

# WASM Binary Size Forensics v2: Function-Level Dissection and Inflation Analysis

Function-level dissection of the optimized `replicad_single.wasm` (19.22 MB) to explain the persistent 87% inflation over OCCT v7 builds and identify actionable trimming opportunities.

## Executive Summary

**Guiding principle: speed is the top priority; size reduction is secondary. We never sacrifice speed for size.**

The production `replicad_single.wasm` ships at **19.22 MB** with **`-O3` (no LTO, SIMD)** — the fastest configuration. This is 87% larger than the v7 baseline (10.30 MB), but the `-O3` build is **15-30% faster** for complex CAD operations — a deliberate trade-off. The entire inflation is in the Code section (+9.25 MB, +117%), driven by `-O3`'s aggressive inlining producing functions averaging 732 bytes (vs 256 bytes in v7's `-Os -flto` build).

**All tested speed-preserving size reduction approaches have been exhausted:**

| Approach              | Size Impact     | Speed Impact | Verdict              |
| --------------------- | --------------- | ------------ | -------------------- |
| R3 (inline threshold) | -678 KB (-3.4%) | +7.2% slower | ❌ Speed regression  |
| R6 (merge-similar)    | -524 KB (-2.6%) | +2.9% slower | ❌ Speed regression  |
| R7a (dae-optimizing)  | +64 KB (+0.3%)  | +9.5% slower | ❌ Counterproductive |
| R8-ext (noexcept all) | +12 B (0.00%)   | Noise        | ❌ Negligible        |

**The `-O3` build at 19.22 MB is a local optimum.** LLVM's default inlining heuristics produce the fastest possible code for OCCT; any interference slows it down. The remaining untested speed-neutral option is **R4 (`-fno-rtti`)**, estimated at 0.5-1 MB savings. Future work should focus on **speed improvements** (threading, PGO, newer Emscripten/LLVM) rather than squeezing size from a build that is already the fastest achievable.

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
- [Applied Optimizations Inventory](#applied-optimizations-inventory)
- [Tested & Rejected Inventory](#tested--rejected-inventory)
- [Next Steps](#next-steps)
- [Trade-offs: Speed vs Size (Measured)](#trade-offs-speed-vs-size-measured)
- [Finding 9: `-fno-exceptions` Is Not Viable for OCCT](#finding-9--fno-exceptions-is-not-viable-for-occt)
- [Finding 10: Compile-Level Experiment Results](#finding-10-compile-level-experiment-results)
- [Finding 11: wasm-opt Extra Passes (R6-R7) Results](#finding-11-wasm-opt-extra-passes-r6-r7-results)
- [Finding 12: LLVM Inline Threshold Tuning (R3) Results](#finding-12-llvm-inline-threshold-tuning-r3-results)
- [Finding 13: Noexcept on All Large Destructors (R8-ext) Results](#finding-13-noexcept-on-all-large-destructors-r8-ext-results)
- [Appendix: Full Package Inventory](#appendix-full-package-inventory)

## Methodology

**Tools:**

- `wasm-objdump -h/-x` (WABT 1.0.39) for section and function-level analysis
- `replicad_single.js.symbols` (Emscripten symbol map) for function name resolution
- Python aggregation scripts for toolkit grouping, size comparison, and distribution analysis
- Historical tarballs extracted for comparative analysis: v7 (0.20.2), v8.25, v8.26, v8.32, v8.39 (original), v8.39 (optimized)

**Build configuration (current optimized):** `O3-simd`, `OCJS_OPT=-O3`, `OCJS_LTO=0`, `OCJS_SIMD=1`, `OCJS_EXCEPTIONS=0`, `wasm-opt -O4 --converge --traps-never-happen`, OCCT patches applied (`patch_standard_dump.py`, `patch_noexcept_destructors.py` (7 classes), `patch_stepcaf_dyntype.py`).

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

| Build                       | Compile Flags | Total (MB) | Code (MB) | Data (MB) | Functions | Avg Size | Gzip (MB) |
| --------------------------- | ------------- | ---------- | --------- | --------- | --------- | -------- | --------- |
| v7 (OCCT 7.6.2)             | `-Os -flto`   | **10.30**  | 7.74      | 2.46      | 31,607    | 256 B    | 4.31      |
| **v8.39 `-Os` no LTO SIMD** | **`-Os`**     | **14.54**  | —         | —         | —         | —        | —         |
| v8.39 `-Os` LTO SIMD        | `-Os -flto`   | 15.03      | —         | —         | —         | —        | 5.35      |
| v8.39 `-O0` LTO SIMD        | `-O0 -flto`   | 16.09      | —         | —         | —         | —        | —         |
| v8.39 `-O0` no LTO SIMD     | `-O0`         | 16.55      | —         | —         | —         | —        | —         |
| v8.26 (post-LTO removal)    | `-O3`         | 18.91      | 16.27     | 2.55      | 24,697    | 690 B    | 6.08      |
| v8.32 (pre-RBV)             | `-O3`         | 19.23      | 16.77     | 2.37      | 24,038    | 731 B    | 6.14      |
| v8.25 (initial v8)          | `-O3 -flto`   | 23.39      | 20.92     | 2.51      | 21,191    | 988 B    | —         |
| v8.39 original              | `-O3`         | 19.31      | 16.85     | 2.38      | 24,121    | 732 B    | 6.16      |
| v8.39 optimized (`-O3`)     | `-O3`         | 19.22      | 16.73     | 2.37      | 23,995    | 732 B    | 6.13      |

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

Our fork parameterized these via `OCJS_OPT` / `OCJS_LTO` env vars, and the `O3-simd` configuration sets `-O3` without LTO — the correct choice for maximum runtime performance:

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

The v7 pipeline used `-Os` at compile time (which limits inlining and favors smaller code) combined with `-flto` (which enables LLVM to do cross-module dead code elimination at the size-optimized level). Our v8 build deliberately uses `-O3` at compile time for maximum runtime performance — LLVM aggressively inlines helper functions into callers at the IR level (before WASM emission), producing larger but faster code. We disabled LTO because with `-O3`, LTO caused catastrophic inlining bloat (23.39 MB at v8.25) with no performance benefit.

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

The top 126 functions (0.5% by count) contain **33.9% of all code** (5.80 MB). The top 649 functions (>4 KB, 2.7% by count) contain **56.2% of all code** (9.64 MB). This extreme concentration means inlining threshold tuning (R3) can target the bloat without affecting the many small, performance-critical functions.

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

## Applied Optimizations Inventory

Every optimization currently applied to the production WASM binary, with measured impact. These are the cumulative decisions that produce the 19.22 MB / 42.6 ms geo-mean build.

| #   | Optimization                                          | Speed Impact          | Size Impact                 | Applied In |
| --- | ----------------------------------------------------- | --------------------- | --------------------------- | ---------- |
| A1  | **`-O3` compile (vs v7's `-Os`)**                     | **+28% faster** vs v7 | +8.99 MB code (+116%)       | v8.25      |
| A2  | **LTO removal (`OCJS_LTO=0`)**                        | None measurable       | **-4.48 MB** (23.39→18.91)  | v8.26      |
| A3  | **SIMD enabled (`-msimd128 -mrelaxed-simd`)**         | +5-15% faster (est.)  | +0.4 MB (est.)              | v8.32      |
| A4  | **Non-exceptions (`-sDISABLE_EXCEPTION_CATCHING=1`)** | +2-5% faster (est.)   | -0.09 MB (smaller JS glue)  | v8.25      |
| A5  | **wasm-opt `-O4 --converge --traps-never-happen`**    | None                  | -0.5 MB (est.)              | v8.26      |
| A6  | **`--strip-debug --strip-producers`**                 | None                  | -0.01 MB                    | v8.26      |
| A7  | **`--eval-ctors` level 2**                            | None                  | -0.02 MB (est.)             | v8.32      |
| A8  | **OCCT patch: `OCCT_NO_DUMP` (Standard_Dump stub)**   | None                  | -85 KB (est.)               | v8.39-opt  |
| A9  | **OCCT patch: noexcept destructor (STEPCAFControl)**  | None                  | -319 B                      | v8.39-opt  |
| A10 | **OCCT patch: DynamicType simplification**            | None                  | -323 B                      | v8.39-opt  |
| A11 | **Bindgen filtering (202 vs 821 classes)**            | None                  | -0.5 MB (est., fewer stubs) | v8.26      |
| A12 | **CMake build system (vs legacy Python)**             | None                  | None (build-time only)      | v8.39      |

**Net result:** 19.22 MB at 42.6 ms geo-mean — the fastest OCCT WASM build achievable with current tooling.

## Tested & Rejected Inventory

Every approach tested for speed-neutral size reduction that was rejected. Sorted by speed impact (smallest regression first).

| #      | Approach                             | Size Impact     | Speed Impact     | Why Rejected                                                       | Finding |
| ------ | ------------------------------------ | --------------- | ---------------- | ------------------------------------------------------------------ | ------- |
| R8-ext | noexcept on ALL large destructors    | +12 B (+0.00%)  | Noise            | Negligible — landing pads are not the cause of destructor bloat    | 13      |
| R6     | wasm-opt `--merge-similar-functions` | -524 KB (-2.6%) | **+2.9% slower** | Dispatch branches on merged functions degrade hot paths            | 11      |
| R3-128 | `-mllvm -inline-threshold=128`       | -678 KB (-3.4%) | **+7.2% slower** | Overrides LLVM adaptive heuristics, breaks small-op performance    | 12      |
| R7a    | wasm-opt `--dae-optimizing`          | +64 KB (+0.3%)  | **+9.5% slower** | Counterproductive on both axes — restructures call sites poorly    | 11      |
| R3-256 | `-mllvm -inline-threshold=256`       | +42 KB (+0.2%)  | **+9.7% slower** | Even above-default threshold breaks LLVM's context-sensitive model | 12      |
| R7b    | wasm-opt `--outlining`               | N/A             | N/A              | Validator errors — incompatible with current wasm-opt version      | 11      |
| R1     | `-fno-exceptions` (Clang flag)       | N/A             | N/A              | Compilation failure — OCCT uses `throw` pervasively in headers     | 9       |

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

**Conclusion**: Exception-related code elimination is a dead end for OCCT WASM builds. Size reduction must come from **speed-neutral mechanisms** like R4 (`-fno-rtti`) or R9 (TopOpeBRep removal). Speed-sacrificing approaches (R5 `-Os`, R2 `-O2`) are fallbacks only.

### Finding 10: Compile-Level Experiment Results

Five new builds were tested with 50-iteration benchmarks across 18 CAD operations. All builds use SIMD, no-exceptions, and wasm-opt `-O3` (unless otherwise noted). Results ranked by geo-mean median latency:

| #   | Build                               | Compile     | LTO | WASM Size    | Gzip    | Geo-Mean    | vs Baseline                | vs v7 |
| --- | ----------------------------------- | ----------- | --- | ------------ | ------- | ----------- | -------------------------- | ----- |
| 1   | **v8-O3-noLTO-rbv-simd** (baseline) | `-O3`       | No  | **19.22 MB** | 6.13 MB | **42.6 ms** | —                          | +87%  |
| 2   | **v8-Os-noLTO-wasmOptO3-simd**      | `-Os`       | No  | **14.54 MB** | —       | **50.2 ms** | **-24.3% size, +18% perf** | +41%  |
| 3   | v8-Os-LTO-wasmOptO3-simd            | `-Os`       | Yes | 15.03 MB     | 5.35 MB | 50.4 ms     | -21.8% size, +18% perf     | +46%  |
| 4   | v8-O0-LTO-wasmOptO3-simd            | `-O0`       | Yes | 16.09 MB     | —       | 149.8 ms    | -16.3% size, +252% perf    | +56%  |
| 5   | v8-O0-noLTO-wasmOptO3-simd          | `-O0`       | No  | 16.55 MB     | —       | 151.9 ms    | -13.9% size, +257% perf    | +61%  |
| —   | v762-O0-noLTO-wasmOptO3 (v7 ref)    | `-Os -flto` | Yes | 10.30 MB     | 4.31 MB | 57.9 ms     | -46.4% size                | —     |

#### Key findings

**1. `-O3` remains the correct production choice**

The `-O3` no-LTO SIMD build (42.6 ms geo-mean) is the fastest configuration tested — 18% faster than `-Os` (50.2 ms), 28% faster than v7 (57.9 ms), and 3.5x faster than `-O0` builds. The 19.22 MB size is the cost of that speed advantage. Size reduction should only be pursued through speed-neutral mechanisms (R4, R9).

**2. `-Os` saves 24.3% size but costs 18% speed**

The `-Os-noLTO-SIMD` build (14.54 MB, 50.2 ms) is the best size-reduction option, but the 18% latency regression (7.6 ms per operation) is a real trade-off. It should be considered a fallback for size-constrained deployments, not the default path. Notably, `-Os` without LTO is **smaller** than `-Os+LTO` (14.54 vs 15.03 MB) — LTO's inlining pass is counterproductive even at `-Os`.

**3. `-O0` is not viable for production**

Both `-O0` builds are ~3.5x slower than baseline (150-152 ms). wasm-opt `-O3` recovers some optimization from the unoptimized IR, but cannot compensate for the absence of compile-time register allocation, instruction scheduling, and loop optimization.

**4. LTO has marginal value at `-O0` but is net-negative at `-Os`**

At `-O0`, LTO saves 0.46 MB (16.09 vs 16.55 MB) via dead code elimination. At `-Os`, LTO **adds** 0.49 MB (15.03 vs 14.54 MB) via inlining. LTO should only be considered with `-O0` or `-O2` where its DCE benefits outweigh its inlining costs.

**5. Remaining gap to v7: 4.24 MB (41%) at `-Os`; 8.92 MB (87%) at `-O3`**

The size gap to v7 is the cost of OCCT v8's larger codebase and our speed-first compile strategy. The structural portion (~2-3 MB from OCCT v8 source growth, ~0.5-1 MB from Emscripten/LLVM version differences) cannot be eliminated at any optimization level. The remaining ~5-6 MB at `-O3` is inlining bloat — inherent to the speed-first `-O3` strategy and cannot be reduced without sacrificing performance (R3 tested and rejected, see Finding 12).

#### Experiment configs

All experiments are defined in `repos/opencascade.js/build-configs/configurations.json` as named configs (`O0-LTO-simd`, `O0-noLTO-simd`, `Os-LTO-simd`, `Os-noLTO-simd`). Experiment artifacts including WASM binaries, benchmarks, provenance, and tarballs are staged in `tarballs/experiments/v8-{config}/`.

## Next Steps

**Principle: speed is the top priority. Size reduction is welcome only when speed-neutral. We never sacrifice speed for size.**

### Speed Improvement Opportunities

These items target making the production build **faster** — the highest-priority work direction.

| #   | Action                                        | Expected Speed Impact                                        | Size Impact                        | Effort | Risk                                                                                            |
| --- | --------------------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| S1  | **Threading (`-pthread`, SharedArrayBuffer)** | **+30-60% faster** on multi-core ops (booleans, meshing)     | +1-2 MB (thread glue)              | Medium | Medium: requires `SharedArrayBuffer` / COOP/COEP headers; single-threaded fallback needed       |
| S2  | **Profile-guided optimization (PGO)**         | **+5-15% faster** (hot path layout)                          | -0.1 to -0.5 MB (DCE from profile) | Medium | Low: Emscripten supports `-fprofile-generate`/`-fprofile-use`; requires representative workload |
| S3  | **Emscripten/LLVM major upgrade**             | **+2-8% faster** (codegen improvements per LLVM release)     | Variable                           | Low    | Low: rebuild + test; current is Emscripten 5.0.1 / LLVM 23                                      |
| S4  | **WASM streaming compilation**                | **Faster startup** (compile during download)                 | None                               | Low    | Low: requires `compileStreaming()` + proper MIME type                                           |
| S5  | **V8 compilation hints / tiered warmup**      | **Faster cold start** (skip Liftoff for known-hot functions) | None                               | Low    | Low: experimental V8 feature; fallback is no-op                                                 |

### Speed-Neutral Size Reduction

These items target reducing binary size **without any speed regression**. Listed by estimated impact (largest first).

| #   | Action                                 | Est. Savings     | Speed Impact   | Effort    | Risk                                                                                                                                              |
| --- | -------------------------------------- | ---------------- | -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4  | **`-fno-rtti`**                        | 0.5-1 MB         | None expected  | Medium    | High: OCCT's `Handle<>` uses `dynamic_cast`; `DynamicType()` uses `typeid`. May require OCCT source patches to replace RTTI with manual dispatch. |
| R9  | **Break TopOpeBRep dependency**        | ~610 KB          | None           | High      | Medium: deprecated toolkit (3.6% of code) pulled by transitive deps. Requires patching BRepMesh/BRepBuilderAPI to remove internal calls.          |
| R10 | **STEP I/O modularization**            | ~200-500 KB      | None           | Very High | High: monolithic `RWStepAP214_GeneralModule` registers all entity types. Modularizing requires major OCCT fork effort.                            |
| R12 | **Brotli compression (transfer size)** | ~1 MB transfer   | None (runtime) | Low       | None: Brotli achieves ~25% ratio vs gzip's 32%. Server/CDN config only, no binary change.                                                         |
| R13 | **Lazy/deferred STEP I/O loading**     | ~1.2 MB deferred | None           | Medium    | Low: load TKDESTEP + TKXS (8.9% of code) only when STEP import/export is requested. Requires dynamic linking or module splitting.                 |

### Not Pursuing (Speed-Sacrificing)

These approaches reduce size but sacrifice speed. They are documented but **not recommended** under the speed-first principle.

| #     | Approach                | Size Savings      | Speed Cost             | Notes                                                              |
| ----- | ----------------------- | ----------------- | ---------------------- | ------------------------------------------------------------------ |
| R5    | `-Os` compile           | -4.68 MB (-24.3%) | +18% slower            | Validated fallback at 14.54 MB. Only if size is a hard constraint. |
| R2    | `-O2` compile + SIMD    | -2 to -3 MB       | Unknown (needs retest) | Middle ground, but any result slower than `-O3` is unacceptable.   |
| R3    | Inline threshold tuning | -678 KB max       | +7-10% slower          | ❌ Tested and rejected. See Finding 12.                            |
| R6-R7 | wasm-opt extra passes   | -524 KB max       | +2.9-9.5% slower       | ❌ Tested and rejected. See Finding 11.                            |

## Trade-offs: Speed vs Size (Measured)

All builds use SIMD, no-exceptions, wasm-opt `-O3`. Geo-mean median latency from 50-iteration benchmarks across 18 CAD operations. **Sorted by speed (fastest first).**

| Config                                 | Geo-Mean    | vs `-O3` Speed | Size         | Size Savings      | Status              |
| -------------------------------------- | ----------- | -------------- | ------------ | ----------------- | ------------------- |
| **`-O3`, no LTO (current)**            | **42.6 ms** | **Baseline**   | **19.22 MB** | **—**             | **Production**      |
| `-O3` + `--merge-similar-functions`    | 43.8 ms     | +2.9%          | 18.72 MB     | -0.50 MB (-2.6%)  | ❌ Speed regression |
| `-O3` + `-mllvm -inline-threshold=128` | 45.7 ms     | +7.2%          | 18.57 MB     | -0.66 MB (-3.4%)  | ❌ Speed regression |
| `-O3` + merge-similar + dae-optimizing | 46.6 ms     | +9.5%          | 18.78 MB     | -0.44 MB (-2.3%)  | ❌ Rejected         |
| `-O3` + `-mllvm -inline-threshold=256` | 46.8 ms     | +9.7%          | 19.26 MB     | +0.04 MB (+0.2%)  | ❌ Rejected         |
| `-O3` + noexcept all large dtors       | ~42.6 ms    | ~0% (noise)    | 19.22 MB     | +12 B (+0.00%)    | ❌ Negligible       |
| `-Os`, no LTO, SIMD                    | 50.2 ms     | -18%           | 14.54 MB     | -4.68 MB (-24.3%) | ✅ Measured         |
| `-Os`, LTO, SIMD                       | 50.4 ms     | -18%           | 15.03 MB     | -4.19 MB (-21.8%) | ✅ Measured         |
| v7.6.2 (reference)                     | 57.9 ms     | -36%           | 10.30 MB     | -8.92 MB (-46.4%) | Reference           |
| `-O2`, no LTO (no SIMD)                | 58.9 ms     | -38%           | 17.92 MB     | -1.30 MB (-6.8%)  | Measured (no SIMD)  |
| `-O0`, LTO, SIMD                       | 149.8 ms    | -252%          | 16.09 MB     | -3.13 MB (-16.3%) | ❌ Not viable       |
| `-O0`, no LTO, SIMD                    | 151.9 ms    | -257%          | 16.55 MB     | -2.67 MB (-13.9%) | ❌ Not viable       |

**`-O3` is the correct production choice.** The 19.22 MB size is the cost of being the fastest configuration. Every tested approach to reduce size at `-O3` either regresses speed (R3, R6-R7) or has negligible effect (R8-ext). The `-O3` build is a local optimum — LLVM's default inlining heuristics produce the fastest possible code for OCCT.

Future work should prioritize **speed improvements** (threading, PGO, Emscripten upgrades) over further size reduction attempts. The only remaining speed-neutral size option is R4 (`-fno-rtti`), which eliminates RTTI metadata without affecting code generation.

## References

- v1 forensics report: `docs/research/ocjs-wasm-binary-size-forensics.md`
- v7 vs v8 size analysis: `docs/research/ocjs-wasm-size-analysis-v762-vs-v8rc4.md`
- Emscripten flags reference: `docs/research/emscripten-optimization-flags.md`
- OCCT WASM optimization: `docs/research/ocjs-wasm-optimization.md`
- OCCT patches: `repos/opencascade.js/src/patches/`
- Build configs: `repos/opencascade.js/build-configs/configurations.json`

## Finding 11: wasm-opt Extra Passes (R6-R7) Results

Three additional `wasm-opt` passes were tested on the production `-O3` baseline (20,157,420 bytes) to evaluate their impact on both size and speed. All builds used `O3-simd` config with SIMD, no-exceptions, `wasm-opt -O4 --converge`. Benchmarks were 50 iterations across 18 CAD operations.

### Size impact (standalone application to baseline WASM)

| Pass                        | Input Size   | Output Size  | Delta       | Notes                                                   |
| --------------------------- | ------------ | ------------ | ----------- | ------------------------------------------------------- |
| `--merge-similar-functions` | 20,157,420 B | 19,658,331 B | **-487 KB** | Requires `--enable-multivalue` for merged tuple returns |
| `--dae-optimizing`          | 20,157,420 B | 20,222,513 B | **+64 KB**  | Dead argument elimination restructures call sites       |
| `--outlining`               | 20,157,420 B | N/A          | N/A         | Validator error: `Tuples are not allowed`               |

### Size impact (integrated into NX build pipeline with `-O4 --converge`)

| Variant                          | WASM Size    | vs Baseline     | Gzip    |
| -------------------------------- | ------------ | --------------- | ------- |
| **Baseline (no extra passes)**   | **19.22 MB** | **—**           | 6.13 MB |
| + `--merge-similar-functions`    | 18.72 MB     | -524 KB (-2.6%) | —       |
| + merge-similar + dae-optimizing | 18.78 MB     | -460 KB (-2.3%) | —       |

When integrated into the full pipeline (where `-O4 --converge` runs multiple optimization passes), `--merge-similar-functions` achieved slightly better savings (-524 KB) than the standalone test (-487 KB), likely because `--converge` iteratively applies the merge pass alongside other optimizations.

### Speed impact (50-iteration median benchmarks)

| Benchmark             | Baseline    | Merge-Similar | Merge+DAE   | MS %      | DAE %     |
| --------------------- | ----------- | ------------- | ----------- | --------- | --------- |
| birdhouse             | 195.57 ms   | 203.42 ms     | 203.25 ms   | +4.0%     | +3.9%     |
| bottle                | 259.52 ms   | 263.79 ms     | 267.80 ms   | +1.6%     | +3.2%     |
| box                   | 7.70 ms     | 8.40 ms       | 9.40 ms     | +9.1%     | +22.1%    |
| box-chamfer-all       | 26.41 ms    | 27.11 ms      | 27.40 ms    | +2.7%     | +3.8%     |
| box-fillet-all        | 30.21 ms    | 30.32 ms      | 31.13 ms    | +0.4%     | +3.1%     |
| cut-cylinder-from-box | 12.18 ms    | 15.64 ms      | 16.18 ms    | +28.4%    | +32.9%    |
| cycloidal-gear        | 526.80 ms   | 506.42 ms     | 591.92 ms   | -3.9%     | +12.4%    |
| cylinder              | 7.91 ms     | 7.74 ms       | 10.25 ms    | -2.2%     | +29.6%    |
| deep-boolean-chain    | 91.79 ms    | 90.00 ms      | 118.70 ms   | -1.9%     | +29.3%    |
| fuse-two-boxes        | 15.40 ms    | 21.47 ms      | 22.80 ms    | +39.4%    | +48.1%    |
| gridfinity-box        | 198.03 ms   | 222.32 ms     | 211.04 ms   | +12.3%    | +6.6%     |
| multi-hole-plate      | 180.13 ms   | 182.36 ms     | 185.42 ms   | +1.2%     | +2.9%     |
| n-body-fuse           | 42.89 ms    | 46.01 ms      | 65.84 ms    | +7.3%     | +53.5%    |
| sketch-extrude        | 6.92 ms     | 6.97 ms       | 7.86 ms     | +0.7%     | +13.5%    |
| sketch-revolve        | 9.05 ms     | 9.53 ms       | 10.23 ms    | +5.3%     | +13.0%    |
| sphere                | 20.59 ms    | 19.89 ms      | 20.91 ms    | -3.4%     | +1.5%     |
| tray                  | 29.55 ms    | 44.22 ms      | 31.98 ms    | +49.7%    | +8.2%     |
| vase                  | 164.45 ms   | 171.60 ms     | 166.47 ms   | +4.3%     | +1.2%     |
| **TOTAL**             | **1825 ms** | **1877 ms**   | **1999 ms** | **+2.9%** | **+9.5%** |

### Analysis

**`--merge-similar-functions`** merges C++ template instantiations with identical WASM bodies into a single function with a dispatch header. The dispatch overhead (+2.9% median total) is measurable and inconsistent — some benchmarks regress heavily (`fuse-two-boxes` +39.4%, `tray` +49.7%), while others are within noise or slightly faster (`cycloidal-gear` -3.9%, `cylinder` -2.2%). The regression pattern suggests boolean operations and complex sweeps are most affected, likely because their hot paths call many merged template functions.

**`--dae-optimizing`** restructures function signatures to eliminate unused parameters. The resulting call-site changes interact poorly with the V8 JIT compiler's inline caches and function call optimizations, producing a consistent +9.5% regression across all benchmark categories. The pass also increases binary size, making it counterproductive on both axes.

**Conclusion**: Given the speed-first principle, none of these passes should be enabled by default. `BINARYEN_EXTRA_PASSES` is set to `""` (empty) in all `configurations.json` configs. The `--merge-similar-functions` pass remains available for size-constrained deployments via `BINARYEN_EXTRA_PASSES="--enable-multivalue,--merge-similar-functions"`.

## Finding 12: LLVM Inline Threshold Tuning (R3) Results

**Status**: ❌ REJECTED

Two inline threshold values were tested on the production `-O3` baseline using `-mllvm -inline-threshold=N`. Both were full rebuilds (PCH, sources, bindings, link) with 50-iteration benchmarks.

### Build results

| Config                         | Threshold | WASM Size    | vs Baseline     | Compile Time |
| ------------------------------ | --------- | ------------ | --------------- | ------------ |
| **Baseline (LLVM default)**    | ~225      | **19.22 MB** | **—**           | ~25 min      |
| `-mllvm -inline-threshold=128` | 128       | 18.57 MB     | -678 KB (-3.4%) | ~26 min      |
| `-mllvm -inline-threshold=256` | 256       | 19.26 MB     | +42 KB (+0.2%)  | ~25 min      |

### Speed impact (50-iteration median benchmarks)

| Benchmark             | Baseline    | IT=128      | IT=256      | 128 %     | 256 %     |
| --------------------- | ----------- | ----------- | ----------- | --------- | --------- |
| birdhouse             | 195.57 ms   | 208.89 ms   | 209.18 ms   | +6.8%     | +7.0%     |
| bottle                | 259.52 ms   | 274.37 ms   | 275.23 ms   | +5.7%     | +6.1%     |
| box                   | 7.70 ms     | 10.65 ms    | 13.42 ms    | +38.4%    | +74.4%    |
| box-chamfer-all       | 26.41 ms    | 36.79 ms    | 40.87 ms    | +39.3%    | +54.8%    |
| box-fillet-all        | 30.21 ms    | 42.01 ms    | 34.73 ms    | +39.1%    | +15.0%    |
| cut-cylinder-from-box | 12.18 ms    | 16.33 ms    | 19.28 ms    | +34.1%    | +58.3%    |
| cycloidal-gear        | 526.80 ms   | 524.68 ms   | 523.23 ms   | -0.4%     | -0.7%     |
| cylinder              | 7.91 ms     | 13.37 ms    | 8.74 ms     | +68.9%    | +10.5%    |
| deep-boolean-chain    | 91.79 ms    | 91.09 ms    | 93.39 ms    | -0.8%     | +1.7%     |
| fuse-two-boxes        | 15.40 ms    | 20.76 ms    | 22.23 ms    | +34.8%    | +44.3%    |
| gridfinity-box        | 198.03 ms   | 216.19 ms   | 214.91 ms   | +9.2%     | +8.5%     |
| multi-hole-plate      | 180.13 ms   | 200.17 ms   | 245.99 ms   | +11.1%    | +36.6%    |
| n-body-fuse           | 42.89 ms    | 51.76 ms    | 48.34 ms    | +20.7%    | +12.7%    |
| sketch-extrude        | 6.92 ms     | 10.31 ms    | 9.65 ms     | +49.0%    | +39.5%    |
| sketch-revolve        | 9.05 ms     | 12.79 ms    | 11.77 ms    | +41.3%    | +30.0%    |
| sphere                | 20.59 ms    | 22.46 ms    | 23.53 ms    | +9.1%     | +14.3%    |
| tray                  | 29.55 ms    | 31.37 ms    | 38.78 ms    | +6.2%     | +31.2%    |
| vase                  | 164.45 ms   | 172.36 ms   | 168.53 ms   | +4.8%     | +2.5%     |
| **TOTAL**             | **1825 ms** | **1956 ms** | **2002 ms** | **+7.2%** | **+9.7%** |

### Analysis

**Both threshold values regress speed significantly.** The hypothesis that `-mllvm -inline-threshold=N` would preserve `-O3` speed while reducing pathological inlining was incorrect. The reason:

1. **LLVM's inlining is not a simple threshold check.** The `-inline-threshold` parameter is just the base cost threshold. LLVM's actual inlining decisions involve a complex cost model that considers: caller/callee size, call frequency estimates, loop nesting depth bonuses, cold/hot region analysis, and partial inlining opportunities. Setting `-inline-threshold` explicitly overrides the base value but doesn't disable the adaptive adjustments — it shifts the entire decision boundary.

2. **Small functions are disproportionately affected.** Benchmarks with the largest regressions are small operations (`box` +38-74%, `cylinder` +69%, `sketch-extrude` +49%, `fuse-two-boxes` +35-44%). These operations consist of short call chains where every inlined function contributes to eliminating call overhead, vtable lookups, and enabling register allocation across the full operation. Reducing inlining at any level disrupts this.

3. **Large operations are unaffected.** `cycloidal-gear` (-0.4%/-0.7%) and `deep-boolean-chain` (-0.8%/+1.7%) show no meaningful change because they are dominated by algorithmic time (geometry intersection, boolean solver), not function call overhead.

4. **threshold=256 > default (~225) yet SLOWER.** This is counterintuitive. Setting the threshold explicitly, even above the default, appears to interfere with LLVM's adaptive cost model. The default behavior (no explicit threshold) allows LLVM's `-O3` pipeline to make context-sensitive decisions that the flat threshold override cannot replicate.

**Conclusion**: LLVM's default `-O3` inlining heuristics are already optimal for OCCT's code patterns. There is no way to selectively reduce pathological inlining (542 KB destructors) without also reducing beneficial inlining that makes hot paths fast. The 19.22 MB binary size at `-O3` is the irreducible cost of maximum performance.

### Infrastructure added

The `OCJS_EXTRA_CFLAGS` env var was added to the build system (`build-wasm.sh`, `Common.py`, `nx.json`) to support arbitrary extra compile flags. Configurations `O3-simd-it128` and `O3-simd-it256` were added to `configurations.json` for reproducibility.

### Experiment artifacts

- `tarballs/experiments/v8-O3-noLTO-wasmOptO4-simd-it128/` (18.57 MB)
- `tarballs/experiments/v8-O3-noLTO-wasmOptO4-simd-it256/` (19.26 MB)

## Finding 13: Noexcept on All Large Destructors (R8-ext) Results

Extended the `noexcept` destructor patch from 1 class (STEPCAFControl_ActorWrite) to **7 classes** covering the largest generated destructors in the WASM binary (627 KB of destructor code across Finding 5 top 30). Implemented as `patch_noexcept_destructors.py`, a comprehensive replacement for the single-class `patch_stepcaf_noexcept.py`.

### Size impact

| Build                 | WASM Size    | Delta vs baseline |
| --------------------- | ------------ | ----------------- |
| Baseline (1 noexcept) | 20,157,420 B | —                 |
| R8-ext (7 noexcept)   | 20,157,432 B | **+12 B**         |

Adding `noexcept` to 6 additional destructors changed the binary size by **+12 bytes** — byte-identical within alignment padding.

### Speed impact

50-iteration benchmarks across 18 CAD operations. The R8-ext build showed a +14.6% median total regression (2091 ms vs 1825 ms baseline). However, this measurement is unreliable because:

1. **The WASM binaries are byte-identical** — a +12 B difference cannot cause a 14.6% speed change
2. Benchmarks were run in different sessions with different system load and thermal states
3. Individual operation regressions (e.g. multi-hole-plate +48.2%, bottle +35.7%) are far too large for a code-neutral change

A back-to-back retest in the same session would be needed for a definitive speed conclusion, but the size result alone is sufficient to reject this approach.

### Why noexcept has no effect

The `noexcept` annotation tells the compiler that a function won't throw, eliminating exception handling (EH) landing pads at call sites. However, as established in Finding 7:

1. **Landing pads are not the primary cause of destructor bloat.** The massive destructor sizes (48-222 KB) come from `-O3` inlining Handle<> reference-counting cleanup chains, not from EH cleanup code.
2. **The non-exceptions build already suppresses most EH code.** With `-sDISABLE_EXCEPTION_CATCHING=1`, the linker strips catch blocks. The remaining cleanup code is for unwinding through `noexcept` functions, which is a tiny fraction of the total.
3. **The compiler generates destructors out-of-line anyway.** When the destructor definition is `= default`, the compiler generates it at the definition site. The `noexcept` only prevents generating landing-pad code at _call sites_, which contributes ~300 B per function (Finding 7's 319 B measurement).

With 6 additional destructors × ~300 B per function, the expected savings would be ~1.8 KB. The actual result (+12 B) suggests that the compiler and linker are already optimizing away most of this code in the non-exceptions configuration.

### Experiment artifacts

- `tarballs/experiments/v8-O3-noLTO-wasmOptO4-simd-noexcept-all/` (19.22 MB)

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
