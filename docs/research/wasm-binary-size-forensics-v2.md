---
title: 'WASM Binary Size Forensics v2: Function-Level Dissection and Inflation Analysis'
description: 'Comprehensive function-level analysis of the optimized 19.22 MB non-exceptions WASM binary, explaining the 87% inflation from OCCT v7 and identifying remaining trimming opportunities.'
status: active
created: '2026-03-24'
updated: '2026-03-24'
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

**Guiding principle: speed is the top priority; size reduction is secondary. We always prefer speed over size.**

The production `replicad_single.wasm` ships at **19.22 MB** with **`-O3` (no LTO, SIMD)** — the fastest configuration. This is 87% larger than the v7 baseline (10.30 MB), but the `-O3` build is **15-30% faster** for complex CAD operations — a deliberate trade-off. The entire inflation is in the Code section (+9.25 MB, +117%), driven by `-O3`'s aggressive inlining producing functions averaging 732 bytes (vs 256 bytes in v7's `-Os -flto` build).

The v1 report's OCCT source patches (noexcept destructor, DynamicType simplification) reduced pathological functions by only **319 B and 323 B respectively** — not the hundreds of kilobytes expected. The landing pad code is not the primary cause of these functions' size; -O3 inlining is.

**Update (2026-03-24):** Compile-level experiments confirm that the `-O3` production build is the correct choice. The highest-value next experiment is **R3: LLVM inlining threshold tuning** (`-O3 -mllvm -inline-threshold=100`), which could reduce size by 1-2 MB while **preserving full `-O3` speed** — the only approach that improves size without sacrificing performance. The `-Os` build (R5, validated at **14.54 MB**, -24.3%) is available as a fallback but carries an **18% latency regression** (50.2 ms vs 42.6 ms) — acceptable only if size constraints outweigh speed. `-O0` builds are not viable (~3.5x slower). LTO is **counterproductive** at `-Os`, adding 0.49 MB.

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
- [Finding 10: Compile-Level Experiment Results](#finding-10-compile-level-experiment-results)
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

## Recommendations

**Principle: speed first, size second.** Recommendations are prioritized by speed preservation — size-only wins that sacrifice performance are ranked lower.

### P0: Speed-Preserving Size Reduction

| #   | Action                                     | Speed Impact               | Mechanism                                                                                                                                                                                                                                                                                            | Est. Savings | Risk                                                                      |
| --- | ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| R3  | **`-O3` + `-mllvm -inline-threshold=100`** | **None (preserves `-O3`)** | Keeps `-O3` optimizations (loop unrolling, vectorization, instruction scheduling) but caps inlining depth. LLVM default threshold for `-O3` is 250; reducing to 100 prevents pathological cases (542 KB destructors) while preserving hot-path performance. Threshold is tunable (try 150, 100, 75). | 1-2 MB       | Low: easily reversible.                                                   |
| R4  | **Compile with `-fno-rtti`**               | **None expected**          | Disables C++ RTTI (`dynamic_cast`, `typeid`). Eliminates typeinfo structures and vtable RTTI pointers. Stackable on any compile level.                                                                                                                                                               | 0.5-1 MB     | High: OCCT's `Handle<>` uses `dynamic_cast` internally. Requires testing. |

### P1: Speed-Regressing Size Reduction (Fallback)

These options deliver larger size savings but sacrifice runtime performance. Only pursue if size constraints outweigh the speed regression.

| #      | Action                                            | Speed Impact                  | Mechanism                                                                                                                                       | Savings                | Risk                                             |
| ------ | ------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| R5     | **`-Os` compile + `-O3` wasm-opt (no LTO, SIMD)** | **-18% (50.2 ms vs 42.6 ms)** | ✅ **VALIDATED** — Measured: **14.54 MB** (-24.3%). LTO is counterproductive at `-Os` (adds 0.49 MB). Still 13% faster than v7. See Finding 10. | **4.68 MB** (measured) | Low: 18% latency regression.                     |
| R2     | **`-O2` compile with SIMD**                       | **Unknown (retest needed)**   | Partially tested without SIMD: 17.92 MB, 58.9 ms (+38%). SIMD may significantly close the speed gap — re-test needed for a fair comparison.     | 1-3 MB                 | Low-Med: speed impact unclear until SIMD retest. |
| ~~R1~~ | ~~**Compile with `-fno-exceptions`**~~            | —                             | —                                                                                                                                               | ~~1-3 MB~~             | **REJECTED — not viable (see Finding 9)**        |

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

**Conclusion**: Exception-related code elimination is a dead end for OCCT WASM builds. Size reduction must come from **speed-preserving inlining controls** (R3, R4) or, if size constraints force it, **optimization level changes** (R5, R2) that trade speed for size.

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

The `-O3` no-LTO SIMD build (42.6 ms geo-mean) is the fastest configuration tested — 18% faster than `-Os` (50.2 ms), 28% faster than v7 (57.9 ms), and 3.5x faster than `-O0` builds. The 19.22 MB size is the cost of that speed advantage. Size reduction should only be pursued through mechanisms that preserve this speed (R3, R4).

**2. `-Os` saves 24.3% size but costs 18% speed**

The `-Os-noLTO-SIMD` build (14.54 MB, 50.2 ms) is the best size-reduction option, but the 18% latency regression (7.6 ms per operation) is a real trade-off. It should be considered a fallback for size-constrained deployments, not the default path. Notably, `-Os` without LTO is **smaller** than `-Os+LTO` (14.54 vs 15.03 MB) — LTO's inlining pass is counterproductive even at `-Os`.

**3. `-O0` is not viable for production**

Both `-O0` builds are ~3.5x slower than baseline (150-152 ms). wasm-opt `-O3` recovers some optimization from the unoptimized IR, but cannot compensate for the absence of compile-time register allocation, instruction scheduling, and loop optimization.

**4. LTO has marginal value at `-O0` but is net-negative at `-Os`**

At `-O0`, LTO saves 0.46 MB (16.09 vs 16.55 MB) via dead code elimination. At `-Os`, LTO **adds** 0.49 MB (15.03 vs 14.54 MB) via inlining. LTO should only be considered with `-O0` or `-O2` where its DCE benefits outweigh its inlining costs.

**5. Remaining gap to v7: 4.24 MB (41%) at `-Os`; 8.92 MB (87%) at `-O3`**

The size gap to v7 is the cost of OCCT v8's larger codebase and our speed-first compile strategy. The structural portion (~2-3 MB from OCCT v8 source growth, ~0.5-1 MB from Emscripten/LLVM version differences) cannot be eliminated at any optimization level. The remaining ~5-6 MB at `-O3` is inlining bloat — the target for R3 (inline threshold tuning).

#### Experiment configs

All experiments are defined in `repos/opencascade.js/build-configs/configurations.json` as named configs (`O0-LTO-simd`, `O0-noLTO-simd`, `Os-LTO-simd`, `Os-noLTO-simd`). Experiment artifacts including WASM binaries, benchmarks, provenance, and tarballs are staged in `tarballs/experiments/v8-{config}/`.

### P2: Speed-Neutral Marginal Gains

These are stackable on top of the `-O3` production build with no expected speed impact.

| #   | Action                                              | Speed Impact | Mechanism                                                                                                     | Est. Savings | Risk |
| --- | --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- | ------------ | ---- |
| R6  | **wasm-opt `--merge-similar-functions`**            | **None**     | Merges functions with identical bodies (common with template instantiations). May already be included in -O4. | 50-200 KB    | Low  |
| R7  | **wasm-opt `--dae-optimizing` + `--outlining`**     | **None**     | Dead argument elimination and code outlining (extract common code sequences).                                 | 50-150 KB    | Low  |
| R8  | **OCCT patch: `noexcept` on ALL large destructors** | **None**     | Extend `patch_stepcaf_noexcept.py` to top 15 destructors. Marginal per-function but aggregates across many.   | 30-100 KB    | Low  |

### P3: Deferred (High Effort, Speed-Neutral)

| #       | Action                                             | Notes                                                                                                                                                                                                     |
| ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R9      | OCCT source patches to break TopOpeBRep dependency | TopOpeBRep (610 KB) is deprecated but cannot be linker-removed. Requires patching BRepMesh/BRepBuilderAPI to remove internal calls. High effort for moderate reward.                                      |
| R10     | STEP I/O modularization                            | The monolithic `RWStepAP214_GeneralModule` registers ALL STEP entity types. Modularizing it would allow linker DCE to remove unused entity types (StepFEA, StepKinematics, etc.). Major OCCT fork effort. |
| ~~R11~~ | ~~`--closed-world` with `-fno-exceptions`~~        | **Moot** — `-fno-exceptions` is not viable (Finding 9). `--closed-world` alone was rejected in v1 (77 test failures).                                                                                     |

### Cumulative Impact (Measured + Estimated)

Ordered by speed preservation (speed-first principle).

| Scenario                                    | Size         | vs Current        | Speed Impact            | Status             |
| ------------------------------------------- | ------------ | ----------------- | ----------------------- | ------------------ |
| **Current (`-O3`, no LTO, SIMD)**           | **19.22 MB** | **—**             | **Fastest (42.6 ms)**   | **Production**     |
| + R3 (`-O3` + inline threshold)             | ~17-18 MB    | -1 to -2 MB       | None expected           | Untested           |
| + R3 + R4 (`-O3` + threshold + `-fno-rtti`) | ~16-17 MB    | -2 to -3 MB       | None expected           | Untested           |
| + R6-R8 (wasm-opt passes)                   | ~19-19.2 MB  | -0.1 to -0.3 MB   | None                    | Untested           |
| R5 (`-Os`, no LTO, SIMD)                    | 14.54 MB     | -4.68 MB (-24.3%) | **-18% (50.2 ms)**      | ✅ Measured        |
| R5 + R4 (`-Os` + `-fno-rtti`)               | ~13-14 MB    | -5 to -6 MB       | -18%                    | Estimated          |
| R2 (`-O2`, SIMD, retest)                    | ~16-17 MB    | -2 to -3 MB       | Unknown (retest needed) | Partially measured |
| Theoretical minimum (v7 ratio)              | ~10.3 MB     | -8.9 MB           | -36% (57.9 ms)          | Theoretical        |

The realistic floor for OCCT v8 is ~12-13 MB even with maximally aggressive size optimization, due to v8's larger source code and algorithms.

**Next priorities (speed-first order):**

1. **R3 (`-O3` + `-mllvm -inline-threshold=100`)** — Top priority. The only approach that reduces size **without sacrificing `-O3` speed**. Caps inlining depth to prevent pathological bloat while preserving loop unrolling, vectorization, and instruction scheduling. Tunable threshold.
2. **R4 (`-fno-rtti`)** — Speed-neutral, stackable on top of R3 or any config. OCCT's `DynamicType()` uses RTTI, but the replicad binding surface may not need it at runtime. High risk, moderate reward.
3. **R6-R8 (wasm-opt passes)** — Speed-neutral marginal gains on top of any compile config. Low effort, low risk.
4. **R2 (`-O2` with SIMD retest)** — Speed impact unknown until SIMD retest. May be moot if R3 delivers similar size at `-O3` speed.
5. **R5 (`-Os` fallback)** — Already validated. Only deploy if size constraints force accepting the 18% speed regression.

## Trade-offs: Speed vs Size (Measured)

All builds use SIMD, no-exceptions, wasm-opt `-O3`. Geo-mean median latency from 50-iteration benchmarks across 18 CAD operations. **Sorted by speed (fastest first).**

| Config                      | Geo-Mean    | vs `-O3` Speed | Size         | Size Savings      | Status             |
| --------------------------- | ----------- | -------------- | ------------ | ----------------- | ------------------ |
| **`-O3`, no LTO (current)** | **42.6 ms** | **Baseline**   | **19.22 MB** | **—**             | **Production**     |
| `-Os`, no LTO, SIMD         | 50.2 ms     | -18%           | 14.54 MB     | -4.68 MB (-24.3%) | ✅ Measured        |
| `-Os`, LTO, SIMD            | 50.4 ms     | -18%           | 15.03 MB     | -4.19 MB (-21.8%) | ✅ Measured        |
| v7.6.2 (reference)          | 57.9 ms     | -36%           | 10.30 MB     | -8.92 MB (-46.4%) | Reference          |
| `-O2`, no LTO (no SIMD)     | 58.9 ms     | -38%           | 17.92 MB     | -1.30 MB (-6.8%)  | Measured (no SIMD) |
| `-O0`, LTO, SIMD            | 149.8 ms    | -252%          | 16.09 MB     | -3.13 MB (-16.3%) | ❌ Not viable      |
| `-O0`, no LTO, SIMD         | 151.9 ms    | -257%          | 16.55 MB     | -2.67 MB (-13.9%) | ❌ Not viable      |

**`-O3` is the correct production choice.** The 19.22 MB size is the cost of being the fastest configuration. Every alternative that reduces size also reduces speed — the question is whether the size savings justify the regression.

The `-Os` no-LTO SIMD build is the best fallback if size becomes a hard constraint: it saves 4.68 MB (24.3%) at an 18% speed cost, and remains 13% faster than v7. The `-Os + LTO` combination is **counterproductive for size** — LTO adds 0.49 MB vs no-LTO, because LLVM's LTO pass inlines more aggressively across modules than its DCE removes.

The highest-leverage untested approach is **R3 (inline threshold tuning)**, which would reduce size at `-O3` speed — the only path that doesn't appear in this table because it hasn't been measured yet.

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
