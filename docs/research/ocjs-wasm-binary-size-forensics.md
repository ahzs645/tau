---
title: 'WASM Binary Size Forensics: replicad_single.wasm v8.39'
description: 'Pathological dissection of the 19.31 MB non-exceptions WASM binary — function-level analysis, RBV impact, call table, data section, and trimming opportunities.'
status: active
created: '2026-03-24'
updated: '2026-03-25'
category: optimization
related:
  - docs/research/ocjs-wasm-size-analysis-v762-vs-v8rc4.md
  - docs/research/ocjs-wasm-optimization.md
  - docs/research/emscripten-optimization-flags.md
---

# WASM Binary Size Forensics: replicad_single.wasm v8.39

Pathological dissection of the `replicad_single.wasm` non-exceptions build to identify all code contributors, measure the impact of return-by-value (RBV) bindings, catalog the call table, and identify trimming opportunities.

## Executive Summary

The current `replicad_single.wasm` is **19.31 MB** (20,244,707 bytes) built from 218 requested OCCT symbols that expand to 4,456 compiled bindings. The binary contains **24,121 code functions** totaling **16.81 MB** in the code section, with a **2.38 MB** data section.

Compared to the v8.26 baseline (18.91 MB), the binary grew by **+592 KB** (+3.5%) in code despite having **576 fewer functions**. The growth concentrates in the medium-to-huge function buckets (+638 KB), partially offset by the removal of 681 tiny/small functions (-30 KB). This pattern indicates the RBV changes consolidated many small wrapper functions into fewer but larger dispatch functions.

The top trimming opportunities are:

1. **Pathological destructors** — 5 destructors exceed 30 KB each, totaling **~780 KB**. `STEPCAFControl_ActorWrite::~` alone is **555 KB**.
2. **STEP stack overhead** — 5,622 functions, **2.76 MB** (16.4% of code), pulled in via dependency chains despite not being directly requested.
3. **TopOpeBRep (deprecated)** — 650 functions, **695 KB** (4.0%), entirely deprecated in OCCT 8.
4. **Bloated RTTI** — `STEPCAFControl_Controller::DynamicType()` is **228 KB**; all RTTI totals **779 KB** (4.5%).

## Table of Contents

- [WASM Section Breakdown](#wasm-section-breakdown)
- [Finding 1: Function Size Distribution](#finding-1-function-size-distribution)
- [Finding 2: Top 30 Largest Functions](#finding-2-top-30-largest-functions)
- [Finding 3: Code Size by OCCT Package](#finding-3-code-size-by-occt-package)
- [Finding 4: RBV Impact Analysis](#finding-4-rbv-impact-analysis)
- [Finding 5: Indirect Call Table (Elem Section)](#finding-5-indirect-call-table-elem-section)
- [Finding 6: Data Section Analysis](#finding-6-data-section-analysis)
- [Finding 7: Git History Size Impact](#finding-7-git-history-size-impact)
- [Finding 8: Pathological Functions](#finding-8-pathological-functions)
- [Recommendations](#recommendations)

## Methodology

**Tools used:**

- `wasm-objdump -h/-x` (WABT, Homebrew) for section and function-level analysis
- `replicad_single.js.symbols` (Emscripten symbol map) for function name resolution
- Python scripts for aggregation, grouping, and cross-referencing
- Historical tarballs (v8.25, v8.26, v8.32) extracted for comparative analysis
- Git log analysis for commit-level size impact classification

**Build configuration:** O3-simd (non-exceptions), `custom_build_single_v8.yml`, 218 requested symbols, OCCT V8.0.0-RC4, Emscripten 5.0.1, wasm-opt -O4 with `--traps-never-happen --converge`.

## WASM Section Breakdown

### Current Build (v8.39)

| Section   | Size (bytes)   | Size (MB) | % of File | Count  |
| --------- | -------------- | --------- | --------- | ------ |
| Code      | 17,637,670     | 16.82     | 87.1%     | 24,121 |
| Data      | 2,490,756      | 2.38      | 12.3%     | 3,102  |
| Elem      | 54,854         | 0.05      | 0.3%      | 24,148 |
| Function  | 24,820         | 0.02      | 0.1%      | 24,121 |
| Type      | 6,962          | 0.01      | <0.1%     | 571    |
| Other     | 29,645         | 0.03      | 0.1%      | —      |
| **Total** | **20,244,707** | **19.31** | **100%**  |        |

### Historical Comparison

| Version | Total (MB) | Code (MB) | Data (MB) | Functions | Avg Size |
| ------- | ---------- | --------- | --------- | --------- | -------- |
| v8.26   | 18.91      | 16.24     | 2.55      | 24,697    | 689 B    |
| v8.32   | 19.23      | 16.74     | 2.37      | 24,038    | 730 B    |
| v8.39   | 19.31      | 16.82     | 2.38      | 24,121    | 731 B    |

| Transition    | Functions | Code Delta | Data Delta | Total Delta |
| ------------- | --------- | ---------- | ---------- | ----------- |
| v8.26 → v8.32 | -659      | +516 KB    | -186 KB    | +331 KB     |
| v8.32 → v8.39 | +83       | +76 KB     | +3 KB      | +80 KB      |
| v8.26 → v8.39 | -576      | +592 KB    | -183 KB    | +411 KB     |

## Finding 1: Function Size Distribution

| Bucket           | Count  | % Funcs | Total Size  | % of Code |
| ---------------- | ------ | ------- | ----------- | --------- |
| Tiny (0-64B)     | 6,644  | 27.5%   | 231,466 B   | 1.3%      |
| Small (64-256B)  | 10,186 | 42.2%   | 1,272,228 B | 7.2%      |
| Medium (256-1KB) | 4,618  | 19.1%   | 2,370,553 B | 13.4%     |
| Large (1-4KB)    | 2,021  | 8.4%    | 3,864,256 B | 21.9%     |
| Huge (4-16KB)    | 526    | 2.2%    | 3,947,835 B | 22.4%     |
| Gigantic (>16KB) | 126    | 0.5%    | 5,944,445 B | 33.7%     |

The top 126 functions (0.5% by count) contain **33.7%** of all code (5.67 MB). The top 50 alone total **4.09 MB** (24.3% of code). This extreme concentration makes individual large functions high-value trimming targets.

### Distribution Evolution (v8.26 → v8.39)

| Bucket           | v8.26 Count | v8.39 Count | v8.26 Size | v8.39 Size | Delta      |
| ---------------- | ----------- | ----------- | ---------- | ---------- | ---------- |
| Tiny (0-64B)     | 7,325       | 6,644       | 237,909 B  | 231,466 B  | -6,443 B   |
| Small (64-256B)  | 10,316      | 10,186      | 1,295,513  | 1,272,228  | -23,285 B  |
| Medium (256-1KB) | 4,548       | 4,618       | 2,288,406  | 2,370,553  | +82,147 B  |
| Large (1-4KB)    | 1,884       | 2,021       | 3,604,104  | 3,864,256  | +260,152 B |
| Huge (4-16KB)    | 505         | 526         | 3,847,463  | 3,947,835  | +100,372 B |
| Gigantic (>16KB) | 119         | 126         | 5,751,462  | 5,944,445  | +192,983 B |

Growth concentrates in the large (1-4 KB) bucket (+260 KB, +137 functions). Tiny/small functions decreased (-811 functions, -30 KB) — consistent with the RBV changes consolidating small embind stubs into larger dispatch wrappers.

## Finding 2: Top 30 Largest Functions

| #   | Size      | Function                                                              |
| --- | --------- | --------------------------------------------------------------------- |
| 1   | 555,002 B | `STEPCAFControl_ActorWrite::~STEPCAFControl_ActorWrite()`             |
| 2   | 377,308 B | `BRepOffset_Tool::Deboucle3D(...)`                                    |
| 3   | 330,129 B | `BRepPrimAPI_MakeBox::Shell()`                                        |
| 4   | 228,025 B | `STEPCAFControl_Controller::DynamicType() const`                      |
| 5   | 196,310 B | `BRepGProp_Face::Load(TopoDS_Face const&)`                            |
| 6   | 137,384 B | `BOPAlgo_SplitEdge::Perform()`                                        |
| 7   | 122,176 B | `STEPConstruct_Styles::MakeColorPSA(...)`                             |
| 8   | 117,510 B | `RWStepAP214_RWAutoDesignNominalDateAndTimeAssignment::ReadStep(...)` |
| 9   | 108,191 B | `BRepFill_NSections::BRepFill_NSections(...)`                         |
| 10  | 101,845 B | `IntPatch_Intersection::GeomParamPerfom(...)`                         |
| 11  | 97,908 B  | `HeaderSection_FileName::~HeaderSection_FileName()`                   |
| 12  | 88,660 B  | `BRepFilletAPI_MakeChamfer::Build(...)`                               |
| 13  | 84,312 B  | `ChFiDS_FilSpine::Radius() const`                                     |
| 14  | 75,344 B  | `Standard_Failure::Standard_Failure(Standard_Failure const&)`         |
| 15  | 73,575 B  | `ShapeUpgrade::C0BSplineToSequenceOfC1BSplineCurve(...)`              |
| 16  | 70,572 B  | `BRepOffset_SimpleOffset::NewPoint(...)`                              |
| 17  | 70,246 B  | `BRepGProp_Domain::Next()`                                            |
| 18  | 68,759 B  | `ChFi3d_CoutureOnVertex(...)`                                         |
| 19  | 65,439 B  | `STEPControl_Writer::STEPControl_Writer(...)`                         |
| 20  | 64,126 B  | `RWStepBasic_RWProduct::Share(...)`                                   |
| 21  | 62,836 B  | `ChFi3d_ComputesIntPC(...)`                                           |
| 22  | 61,761 B  | `ShapeFix_SplitTool::CutEdge(...)`                                    |
| 23  | 57,264 B  | `ShapeFix_Face::FixOrientation(...)`                                  |
| 24  | 55,418 B  | `BRepClass3d_SClassifier::Perform(...)`                               |
| 25  | 53,710 B  | `BRepFill_ShapeLaw::BRepFill_ShapeLaw(...)`                           |
| 26  | 49,596 B  | `BRepMAT2d_LinkTopoBilo::More()`                                      |
| 27  | 49,047 B  | `AppParCurves_MultiBSpCurve::~AppParCurves_MultiBSpCurve()`           |
| 28  | 49,039 B  | `GeomInt_ThePrmPrmSvSurfacesOfWLApprox::SeekPoint(...)`               |
| 29  | 49,039 B  | `BRepBlend_Line::TransitionOnS2() const`                              |
| 30  | 47,158 B  | `IntPatch_Intersection::SetTolerances(...)`                           |

Functions #1, #4, #11, and #14 are **structurally anomalous** — destructors, RTTI, and copy constructors should not be this large. See [Finding 8](#finding-8-pathological-functions).

## Finding 3: Code Size by OCCT Package

| #   | Package         | Funcs | Size        | % Code |
| --- | --------------- | ----- | ----------- | ------ |
| 1   | other           | 6,119 | 2,880,668 B | 16.3%  |
| 2   | STEPCAFControl  | 64    | 830,308 B   | 4.7%   |
| 3   | embind          | 1,390 | 785,324 B   | 4.5%   |
| 4   | BOPAlgo         | 273   | 655,347 B   | 3.7%   |
| 5   | BRepOffset      | 64    | 599,798 B   | 3.4%   |
| 6   | ShapeFix        | 235   | 527,654 B   | 3.0%   |
| 7   | TopOpeBRepBuild | 262   | 499,034 B   | 2.8%   |
| 8   | ChFi3d          | 145   | 411,875 B   | 2.3%   |
| 9   | BRepPrimAPI     | 50    | 408,504 B   | 2.3%   |
| 10  | BRepFill        | 117   | 395,202 B   | 2.2%   |
| 11  | GeomFill        | 390   | 360,060 B   | 2.0%   |
| 12  | IntPatch        | 150   | 346,768 B   | 2.0%   |
| 13  | BRepGProp       | 48    | 307,043 B   | 1.7%   |
| 14  | Geom            | 627   | 303,375 B   | 1.7%   |
| 15  | BRepBlend       | 271   | 280,729 B   | 1.6%   |
| 16  | NCollection     | 1,958 | 280,235 B   | 1.6%   |
| 17  | GeomInt         | 123   | 256,887 B   | 1.5%   |
| 18  | AppDef          | 99    | 236,020 B   | 1.3%   |
| 19  | BRepMesh        | 271   | 216,906 B   | 1.2%   |
| 20  | Extrema         | 222   | 216,452 B   | 1.2%   |

The YAML requests symbols from only **33 package prefixes** (e.g., `BRepBuilderAPI`, `BRepAlgoAPI`, `TopExp`, `TopoDS`, `gp`, etc.), but the binary contains code from **100+ packages** due to OCCT's deep dependency chains.

### Major Overhead Categories

| Category                    | Functions | Size    | % Code | Notes                                          |
| --------------------------- | --------- | ------- | ------ | ---------------------------------------------- |
| STEP stack                  | 5,622     | 2.76 MB | 16.4%  | Pulled via STEPControl_Writer dependency chain |
| Destructors                 | 4,075     | 2.06 MB | 12.2%  | 15 exceed 16 KB; top one is 555 KB             |
| RTTI (DynamicType)          | 2,119     | 779 KB  | 4.5%   | 4 exceed 16 KB; top one is 228 KB              |
| TopOpeBRep (deprecated)     | 650       | 695 KB  | 4.0%   | Entirely deprecated in OCCT 8                  |
| Embind/emval infrastructure | 1,173     | 676 KB  | 3.9%   | Binding registration and dispatch              |
| Exception handling          | 80        | 133 KB  | 0.8%   | Standard_Failure and \_\_cxa                   |

## Finding 4: RBV Impact Analysis

The return-by-value (RBV) feature (commits `508e00a` + `74f4b49`) changes how output parameters are returned from OCCT methods. Instead of mutating JavaScript `{current: ref}` wrappers, RBV packs return values and output parameters into embind `value_object` structs returned as plain JS objects.

### RBV Code Contribution

| Category                     | Count    | Size       | Notes                                            |
| ---------------------------- | -------- | ---------- | ------------------------------------------------ |
| `_Result` struct functions   | 108      | 33 KB      | Constructors, destructors, field getters/setters |
| `emscripten::val` dispatch   | 763      | —          | Includes non-RBV val usage                       |
| `value_object` registrations | 3        | —          | Import-side only (no code)                       |
| **RBV direct overhead**      | **~108** | **~33 KB** | Result struct registration is lightweight        |

The RBV feature's **direct** code contribution is modest (~33 KB for Result struct machinery). However, the **indirect** impact is visible in the distribution shift: 681 fewer tiny/small functions, +137 medium/large functions, net +592 KB code growth between v8.26 and v8.39. This suggests the RBV collision dispatch wrappers (which use `emscripten::val` for type-checking and routing) produce larger per-function code than the old suffix-based overload stubs they replaced.

### Net RBV Impact Estimate

The v8.26 → v8.39 delta is +592 KB in code. However, this period also includes size-decreasing changes (visualization exclusions, raw pointer filtering, deprecated symbol removal, `--traps-never-happen`). The net RBV impact is estimated at **+650-700 KB**, partially offset by ~100 KB in reductions from other commits.

## Finding 5: Indirect Call Table (Elem Section)

The elem section contains **24,148 entries** referencing **15,831 unique functions** (54,854 bytes, 0.3% of binary). This is the indirect call table used for C++ virtual dispatch, embind registration callbacks, and function pointer tables.

### Entry Categories

| Category                   | Entries | % Table |
| -------------------------- | ------- | ------- |
| OCCT methods               | 12,470  | 51.6%   |
| Destructors                | 4,028   | 16.7%   |
| Emscripten internals       | 3,886   | 16.1%   |
| Embind registration        | 1,606   | 6.7%    |
| DynamicType (RTTI)         | 1,576   | 6.5%    |
| get_type_descriptor (RTTI) | 299     | 1.2%    |
| emscripten::val dispatch   | 201     | 0.8%    |
| Operators                  | 68      | 0.3%    |
| RBV Result struct          | 14      | 0.1%    |

### Most-Referenced Functions

| Function                                                 | References | Notes                          |
| -------------------------------------------------------- | ---------- | ------------------------------ |
| `OCJS::getStandard_FailureData(long)`                    | 381        | Exception handler vtable entry |
| `embind_init_Standard_Transient()::$_0`                  | 349        | Transient downcast check       |
| `MethodInvoker<..., void (Quantity_Color::*)...>`        | 344        | Color setter dispatch          |
| `raw_destructor<Quantity_Color>`                         | 315        | Color cleanup                  |
| `MethodInvoker<..., bool (Message_ProgressRange::*)...>` | 226        | Progress range check           |

The elem table is small (55 KB) and well-optimized. The high duplication of exception handler and Transient downcast entries is inherent to OCCT's class hierarchy. RBV contributes only 14 entries (0.1%).

### Historical Comparison

The elem table actually **shrank** from v8.26 (60,020 bytes) to v8.39 (54,854 bytes), a -5,166 byte reduction. This is because the RBV changes and raw pointer filtering removed many small suffix-overload stubs that had indirect call table entries.

## Finding 6: Data Section Analysis

The data section contains **3,102 segments** totaling **2,466,321 bytes** (2.35 MB). Data shrank by **183 KB** from v8.26 to v8.39, likely due to `patch_standard_dump.py` removing OCCT dump macro string tables.

### Data Segment Distribution

| Bucket           | Segments | Notes                             |
| ---------------- | -------- | --------------------------------- |
| Tiny (<64B)      | 2,055    | Constants, small vtable fragments |
| Small (64-256B)  | 699      | String literals, small tables     |
| Medium (256-1KB) | 260      | Larger string tables, RTTI names  |
| Large (1-4KB)    | 57       | Static lookup tables              |
| Huge (>4KB)      | 31       | Major data structures             |

### Top 5 Data Segments

| Segment | Size     | Likely Content                                              |
| ------- | -------- | ----------------------------------------------------------- |
| [582]   | 990.3 KB | Primary RTTI type name table + STEP entity string constants |
| [0]     | 213.6 KB | Static initializer data                                     |
| [3015]  | 146.3 KB | STEP schema string tables                                   |
| [623]   | 108.0 KB | STEP entity recognition data                                |
| [3012]  | 79.9 KB  | Enum/constant lookup tables                                 |

### String Content Analysis

| String Category | Count | Bytes  | Notes                                              |
| --------------- | ----- | ------ | -------------------------------------------------- |
| STEP-related    | 2,019 | 133 KB | Entity names, schema strings                       |
| RTTI/type names | 1,092 | 72 KB  | C++ class names for `dynamic_cast`                 |
| Error/exception | 311   | 21 KB  | Error messages from Standard_Failure               |
| Dump-related    | 13    | <1 KB  | `patch_standard_dump.py` effectively removed these |

## Finding 7: Git History Size Impact

### Commit Classification (508e00a → HEAD)

| Commit    | Type    | Description                         | Estimated Impact                                     |
| --------- | ------- | ----------------------------------- | ---------------------------------------------------- |
| `508e00a` | size+   | RBV: return pointers by value       | +500-600 KB (adds Result structs, dispatch wrappers) |
| `74f4b49` | size+   | RBV fixes (more dispatch logic)     | +100-150 KB                                          |
| `fdf8e10` | size-   | Skip raw pointer params             | -20-40 KB                                            |
| `c60e53e` | size-   | Remove deprecated Transient symbols | -10-20 KB                                            |
| `5422659` | size-   | Exclude visualization classes       | -5-15 KB                                             |
| `3aee45d` | size-   | Exclude Intersector method          | -1-5 KB                                              |
| `dffe7a4` | size-   | `--traps-never-happen` wasm-opt     | -20 KB (~0.1%)                                       |
| `b8f99b1` | neutral | O3 vs O4 emcc fix (was already O3)  | 0                                                    |
| Others    | neutral | Nx config, docs, tests              | 0                                                    |

**Net v8.26 → v8.39**: +592 KB code, -183 KB data = **+411 KB total**

## Finding 8: Pathological Functions

Several functions are structurally anomalous — orders of magnitude larger than expected for their type.

### Pathological Destructors

| Function                        | Size   | Expected | Bloat Factor |
| ------------------------------- | ------ | -------- | ------------ |
| `STEPCAFControl_ActorWrite::~`  | 555 KB | <1 KB    | ~555x        |
| `HeaderSection_FileName::~`     | 98 KB  | <0.5 KB  | ~196x        |
| `AppParCurves_MultiBSpCurve::~` | 49 KB  | <0.5 KB  | ~98x         |
| `BRepFill_NSections::~`         | 42 KB  | <0.5 KB  | ~84x         |
| `BRepPrimAPI_MakeCylinder::~`   | 34 KB  | <0.5 KB  | ~68x         |

These bloated destructors are caused by C++ exception cleanup code. When `-fexceptions` is enabled at compile time (OCCT's CMake unconditionally adds it), the compiler generates "landing pad" cleanup code in every destructor that calls sub-destructors. For classes with many member variables of complex types (like `STEPCAFControl_ActorWrite` which holds Handle references to dozens of STEP entities), the cleanup code grows combinatorially.

### Pathological RTTI

| Function                                                            | Size   | Expected | Bloat Factor |
| ------------------------------------------------------------------- | ------ | -------- | ------------ |
| `STEPCAFControl_Controller::DynamicType()`                          | 228 KB | <1 KB    | ~228x        |
| `TopOpeBRepBuild_Loop::DynamicType()`                               | 40 KB  | <0.5 KB  | ~80x         |
| `StepBasic_ConversionBasedUnitAndLengthUnit::get_type_descriptor()` | 35 KB  | <0.5 KB  | ~70x         |

`DynamicType()` returns the RTTI `Standard_Type` descriptor. In OCCT, these functions involve initializing the full type hierarchy including all base classes and their registered methods. The 228 KB `STEPCAFControl_Controller::DynamicType()` likely initializes the entire STEP CAF controller type graph on first call.

### Pathological Methods

| Function                                     | Size   | Notes                                             |
| -------------------------------------------- | ------ | ------------------------------------------------- |
| `BRepPrimAPI_MakeBox::Shell()`               | 330 KB | Box primitive should be simple geometry           |
| `BRepOffset_Tool::Deboucle3D(...)`           | 377 KB | Offset wire deboucling — heavy template expansion |
| `Standard_Failure::Standard_Failure(const&)` | 75 KB  | Copy constructor of the base exception class      |

## Recommendations

| #   | Action                                                     | Priority | Effort | Est. Savings | Impact                                                                                        |
| --- | ---------------------------------------------------------- | -------- | ------ | ------------ | --------------------------------------------------------------------------------------------- |
| R1  | Patch OCCT to add `-fno-exceptions` for WASM builds        | P0       | High   | **1-3 MB**   | Eliminates destructor landing pads and exception tables                                       |
| R2  | Filter `STEPCAFControl` package in `bindgen-filters.yaml`  | P1       | Low    | **~820 KB**  | Not directly requested; pulled via dependency chain                                           |
| R3  | Filter `TopOpeBRep*` packages                              | P1       | Low    | **~695 KB**  | Entirely deprecated in OCCT 8                                                                 |
| R4  | Patch `STEPCAFControl_ActorWrite` destructor to be trivial | P1       | Medium | **~555 KB**  | Single largest function in the binary                                                         |
| R5  | Patch `STEPCAFControl_Controller::DynamicType()`           | P1       | Medium | **~228 KB**  | Largest RTTI function                                                                         |
| R6  | Filter `HeaderSection` package                             | P2       | Low    | **~113 KB**  | STEP header entity, not used by replicad                                                      |
| R7  | Investigate `-fno-exceptions` override in `build-wasm.sh`  | P0       | Medium | **1-3 MB**   | OCCT's cmake adds `-fexceptions` unconditionally; override with `-fno-exceptions` after cmake |
| R8  | Filter `AppDef`, `GeomPlate`, `ProjLib` packages           | P2       | Low    | **~460 KB**  | Pulled via dependency chains, not directly used                                               |
| R9  | Evaluate compile-time `-O2` instead of `-O3`               | P2       | Low    | **0.5-1 MB** | -O3 inlines more aggressively; -O2 keeps functions smaller                                    |
| R10 | Add `--closed-world` to wasm-opt                           | P3       | Low    | **10-50 KB** | Better DCE when no dynamic linking expected                                                   |

### Regarding R1/R7: Exception Flag Override

OCCT's `deps/occt/adm/cmake/occt_defs_flags.cmake` unconditionally adds `-fexceptions` to all C/C++ flags:

```cmake
set (CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions")
```

The non-exceptions build already passes `-sDISABLE_EXCEPTION_CATCHING=1` at link time, but this only affects Emscripten's JS-side exception handling — the LLVM backend still generates WASM exception cleanup code because `-fexceptions` was set at compile time. Overriding with `-fno-exceptions` in `build-wasm.sh` after the cmake step would eliminate landing pads in all OCCT `.o` files, potentially saving 1-3 MB.

**Risk**: OCCT uses `throw`/`catch` extensively. With `-fno-exceptions`, any `throw` becomes `std::terminate()`. The non-exceptions build already relies on this behavior via `-sDISABLE_EXCEPTION_CATCHING=1`, so the runtime behavior would be unchanged — but compile-time elimination of landing pad code would save significant binary size.

### Regarding R2: STEPCAFControl Filtering

`STEPCAFControl` contributes **820 KB** (64 functions) but is not among the 218 requested symbols. It is pulled into the binary because `STEPControl_Writer` (which IS requested) depends on `STEPCAFControl_Controller` internally. The filtering would need to target the `STEPCAFControl` package in `bindgen-filters.yaml` exclude.packages — but since it is already pulled by the linker as an OCCT library dependency (not as a binding), package filtering alone may not remove the code. An OCCT patch to decouple `STEPControl_Writer` from `STEPCAFControl` may be required.

## Appendix: Full Package Breakdown

<details>
<summary>All packages sorted by code size (click to expand)</summary>

| Package         | Funcs | Size (bytes) | % Code |
| --------------- | ----- | ------------ | ------ |
| other           | 6,119 | 2,880,668    | 16.3%  |
| STEPCAFControl  | 64    | 830,308      | 4.7%   |
| embind          | 1,390 | 785,324      | 4.5%   |
| BOPAlgo         | 273   | 655,347      | 3.7%   |
| BRepOffset      | 64    | 599,798      | 3.4%   |
| ShapeFix        | 235   | 527,654      | 3.0%   |
| TopOpeBRepBuild | 262   | 499,034      | 2.8%   |
| ChFi3d          | 145   | 411,875      | 2.3%   |
| BRepPrimAPI     | 50    | 408,504      | 2.3%   |
| BRepFill        | 117   | 395,202      | 2.2%   |
| GeomFill        | 390   | 360,060      | 2.0%   |
| IntPatch        | 150   | 346,768      | 2.0%   |
| BRepGProp       | 48    | 307,043      | 1.7%   |
| Geom            | 627   | 303,375      | 1.7%   |
| BRepBlend       | 271   | 280,729      | 1.6%   |
| NCollection     | 1,958 | 280,235      | 1.6%   |
| GeomInt         | 123   | 256,887      | 1.5%   |
| AppDef          | 99    | 236,020      | 1.3%   |
| BRepMesh        | 271   | 216,906      | 1.2%   |
| Extrema         | 222   | 216,452      | 1.2%   |
| ChFiDS          | 101   | 213,443      | 1.2%   |
| STEPControl     | 71    | 205,002      | 1.2%   |
| ShapeUpgrade    | 135   | 204,453      | 1.2%   |
| std             | 883   | 201,413      | 1.1%   |
| STEPConstruct   | 49    | 191,277      | 1.1%   |
| BRepFilletAPI   | 67    | 189,623      | 1.1%   |
| BRepBuilderAPI  | 160   | 170,677      | 1.0%   |
| BlendFunc       | 208   | 161,127      | 0.9%   |
| IntTools        | 109   | 143,920      | 0.8%   |
| gp              | 516   | 133,892      | 0.8%   |
| StepVisual      | 436   | 131,912      | 0.7%   |
| Standard        | 76    | 130,842      | 0.7%   |
| GeomPlate       | 63    | 125,424      | 0.7%   |
| HeaderSection   | 17    | 112,770      | 0.6%   |
| Geom2d          | 320   | 110,582      | 0.6%   |
| BRep            | 203   | 109,606      | 0.6%   |
| BRepClass3d     | 31    | 104,922      | 0.6%   |
| ProjLib         | 130   | 104,765      | 0.6%   |
| Approx          | 60    | 104,097      | 0.6%   |
| BRepLib         | 108   | 103,429      | 0.6%   |

</details>

## Optimization Experiment Results

### Summary

Starting from the v8.39 baseline (non-exceptions: 20.24 MB, exceptions: 21.83 MB), a systematic trimming campaign achieved:

| Variant                                      | Baseline | Optimized | Reduction   | %        |
| -------------------------------------------- | -------- | --------- | ----------- | -------- |
| Non-exceptions (`replicad_single.wasm`)      | 20.24 MB | 19.21 MB  | **1.03 MB** | **5.1%** |
| Exceptions (`replicad_with_exceptions.wasm`) | 21.83 MB | 20.73 MB  | **1.10 MB** | **5.0%** |

All 1,277 runtime kernel tests pass with both optimized variants.

### Optimizations Applied (working)

| Optimization                                                  | Mechanism                                                                                          | Impact                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| OCCT noexcept destructor patch (`STEPCAFControl_ActorWrite`)  | Explicit `noexcept` destructor eliminates EH landing pads for ~30 Handle<> members                 | Part of 1 MB reduction                                         |
| OCCT DynamicType simplification (`STEPCAFControl_Controller`) | Replaces `IMPLEMENT_STANDARD_RTTIEXT` macro with file-local static descriptor                      | Part of 1 MB reduction                                         |
| `BINARYEN_EXTRA_PASSES` support in `buildFromYaml.py`         | Allows injecting additional wasm-opt passes via env var                                            | Infrastructure (no direct savings)                             |
| Bindgen filter exclusions (opencascade_full only)             | Excluded `TopOpeBRep*`, `HeaderSection`, `AppDef`, `GeomPlate`, `ProjLib` from full build bindings | Reduces `opencascade_full` build; no effect on replicad builds |

### Optimizations Rejected (caused regressions)

| Optimization                               | Problem                                                                  | Root Cause                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No_Exception` define in `OCJS_DEFINES`    | 11 error handling tests fail with `unreachable` traps                    | Disables OCCT's `Raise_if` precondition macros; code continues with invalid state instead of throwing `Standard_Failure`, eventually hitting undefined behavior                    |
| `--closed-world` wasm-opt flag             | 77 tests fail with `unreachable` when exception handling code is present | wasm-opt cannot trace control flow through WASM exception handling tables; aggressively removes code reachable only via exception handlers, causing `unreachable` traps at runtime |
| `--closed-world` + `No_Exception` combined | 20 failures (fewer than closed-world alone)                              | With `No_Exception`, exception code paths are compiled out so `--closed-world` has less to incorrectly optimize away; but `No_Exception` itself breaks error handling              |

### Debugging Timeline

The root cause took extensive isolation testing to identify because of three compounding issues:

1. **`No_Exception` and `--closed-world` were always applied together** in early builds, making it impossible to attribute failures to one or the other
2. **Previous isolation attempts used link-only rebuilds** but `No_Exception` affects compiled `.o` files (requires full CMake rebuild); changing the config without recompiling produced stale artifacts
3. **The exceptions variant was accidentally overwritten** with non-exceptions build output during an earlier build session, adding 9 spurious `single-exceptions` test failures that obscured the pattern

The breakthrough came from comparing the original tarball with the optimized build byte-by-byte: the JS glue and `.d.ts` were identical, proving all changes were isolated to the WASM binary. Systematic A/B testing of individual flags against the full 1,277-test suite identified the exact failure modes.

### Build Configuration (final)

Non-exceptions (`replicad_single.wasm`):

- `OCJS_OPT=-O3`, `OCJS_SIMD=1`, `OCJS_LTO=0`, `OCJS_EXCEPTIONS=0`
- `OCJS_DEFINES=OCCT_NO_DUMP` (no `No_Exception`)
- wasm-opt: `-O4 --converge --traps-never-happen` (no `--closed-world`)
- OCCT patches: `patch_stepcaf_noexcept.py` + `patch_stepcaf_dyntype.py`

Exceptions (`replicad_with_exceptions.wasm`):

- `OCJS_OPT=-O3`, `OCJS_SIMD=1`, `OCJS_LTO=0`, `OCJS_EXCEPTIONS=1` (`-fwasm-exceptions`)
- Same OCCT patches and defines as non-exceptions
- wasm-opt: same flags (no `--closed-world`)

### Recommendation Status Update

| #   | Recommendation                                   | Outcome                                                                                    |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| R1  | `-fno-exceptions` for WASM                       | **Rejected** — `No_Exception` define (which has similar effect) breaks error handling      |
| R2  | Filter `STEPCAFControl` package                  | **Not applicable** — package is pulled by linker, not bindings; patching is more effective |
| R3  | Filter `TopOpeBRep*` packages                    | **Applied** to `opencascade_full` build; no effect on replicad builds                      |
| R4  | Patch `STEPCAFControl_ActorWrite` destructor     | **Applied** — `patch_stepcaf_noexcept.py` adds explicit `noexcept` destructor              |
| R5  | Patch `STEPCAFControl_Controller::DynamicType()` | **Applied** — `patch_stepcaf_dyntype.py` replaces RTTI macro with file-local static        |
| R6  | Filter `HeaderSection` package                   | **Applied** to `opencascade_full` build; no effect on replicad builds                      |
| R7  | `-fno-exceptions` override                       | **Rejected** — same as R1, breaks runtime exception handling                               |
| R8  | Filter `AppDef`, `GeomPlate`, `ProjLib`          | **Applied** to `opencascade_full` build; no effect on replicad builds                      |
| R9  | Evaluate `-O2` instead of `-O3`                  | **Not tested** — sticking with `-O3` for performance; patches provide sufficient savings   |
| R10 | Add `--closed-world` to wasm-opt                 | **Rejected** — causes `unreachable` traps when exception handling code is present          |

## References

- Previous forensic analysis: `docs/research/ocjs-wasm-size-analysis-v762-vs-v8rc4.md`
- Optimization audit: `docs/research/ocjs-wasm-optimization.md`
- Emscripten flag reference: `docs/research/emscripten-optimization-flags.md`
- OCCT cmake flags: `repos/opencascade.js/deps/occt/adm/cmake/occt_defs_flags.cmake`
- Existing patches: `repos/opencascade.js/src/patches/`
