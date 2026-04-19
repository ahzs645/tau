---
title: 'OpenCascade.js Full Build Audit'
description: 'Audit of the full opencascade.js WASM exceptions build: binding failures, linker warnings, missing symbols, and test results'
status: draft
created: '2026-03-23'
updated: '2026-03-24'
category: audit
related:
  - docs/research/ocjs-wasm-optimization.md
---

# OpenCascade.js Full Build Audit

Systematic audit of the `full-exceptions.yml` build with WASM exceptions and max-performance flags (`O3-wasm-exc-simd`), cataloguing all compilation errors, linker warnings, missing symbols, and test failures.

## Executive Summary

The full OCJS build (4,454 bindings, ~4,442 requested symbols) compiles **all bindings successfully** (0 failures) and **passes validation with 0 missing symbols** after removing 10 unresolvable template aliases. The **full smoke test suite passes** (168 tests, 0 failures) after fixing OCCT 8 API changes and WASM exception handling. The build retains **114 non-fatal linker warnings** for undefined symbols across 29 C++ classes (visualization stack and document persistence drivers) — these are accepted as known limitations of headless WASM builds.

## Problem Statement

After upgrading `full-exceptions.yml` from legacy C++ exceptions (`-fexceptions`) to native WASM exceptions (`-fwasm-exceptions`) with all performance optimizations (O3, SIMD, BIGINT, EVAL_CTORS), we need a complete inventory of all issues in the build to prioritize remediation.

## Methodology

1. Updated `full-exceptions.yml` emccFlags to match the replicad exceptions build (`-fwasm-exceptions`, `-msimd128`, `-mrelaxed-simd`, `-sWASM_BIGINT`, `-sEVAL_CTORS=2`, `-O4`)
2. Ran `pnpm nx build ocjs --skip-nx-cache` with `OCJS_CONFIG=O3-wasm-exc-simd`
3. Collected binding compilation report, linker warnings, validation results, and build manifest
4. Ran the full Vitest smoke suite (`npm run test:smoke`)

## Findings

### Finding 1: Binding Compilation — Zero Failures

All 4,454 bindings compile successfully (4,442 requested symbols, 4,453 compiled). The systemic codegen fixes applied during the replicad binding work (nested type qualification, raw pointer nullptr emission, RBV JS index correction) eliminated all compilation failures across the full binding set. Validation passes with 0 missing symbols.

### Finding 2: Linker Undefined Symbols — 114 Non-Fatal Warnings

The linker reports 114 undefined symbol warnings (non-fatal due to `-sERROR_ON_UNDEFINED_SYMBOLS=0`). These originate from OCCT static library cross-references, not from generated binding code. They fall into three categories:

#### Category A: Visualization Stack (17 classes, ~85 symbols) — Resolved

Classes from OCCT's visualization/presentation framework whose implementations depend on OpenGL or rendering backends not available in WASM. All 17 are excluded in `bindgen-filters.yaml` (both package-level and explicit class-level). No symbols from these classes appear in `full-exceptions.yml`. The linker warnings originate from OCCT static library cross-references (`TKService`/`TKV3d` referencing `TKOpenGl`), not from generated binding code. Accepted as known limitations.

#### Category B: Document Persistence Drivers (10 classes, ~10 symbols) — Open

All 10 share the same pattern: `<Driver>::DefineFormat(Handle<TDocStd_Application> const&)`.

| Class            | OCCT Toolkit |
| ---------------- | ------------ |
| `BinDrivers`     | TKBin        |
| `BinLDrivers`    | TKBinL       |
| `BinTObjDrivers` | TKBinTObj    |
| `BinXCAFDrivers` | TKBinXCAF    |
| `StdDrivers`     | TKStd        |
| `StdLDrivers`    | TKStdL       |
| `XmlDrivers`     | TKXml        |
| `XmlLDrivers`    | TKXmlL       |
| `XmlTObjDrivers` | TKXmlTObj    |
| `XmlXCAFDrivers` | TKXmlXCAF    |

**Root cause**: The `DefineFormat` methods are plugin registration entry points. Their static libraries (`TKBin`, `TKStd`, `TKXml`, etc.) ARE linked, but the `DefineFormat` symbols appear to be defined in `.cxx` files that the WASM CMake build excludes or the linker garbage-collects.

**Remediation**: These are non-critical. Document persistence works through `STEPControl_Reader/Writer` and `StlAPI_Reader` which resolve correctly. The `DefineFormat` entry points are for OCCT's plugin-based application framework, which is rarely used directly in WASM builds. May be recoverable by adjusting CMake.

#### Category C: Isolated Missing Symbols (2 classes, 2-3 symbols) — Open

| Class                     | Symbol                   | Root Cause                                                                  |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `BRepBlend_CSWalking`     | 1 method                 | Depends on internal `Blend_CSWalking` which may be excluded from WASM build |
| `TCollection_AsciiString` | `IsEqual` 3-arg overload | Single overload depends on C string comparison not linked                   |

**Remediation**: Minor — filter the specific methods in `bindgen-filters.yaml` or accept as warnings.

### Finding 3: Build Output Summary

| Artifact                               | Size      | Gzipped |
| -------------------------------------- | --------- | ------- |
| `opencascade_full.wasm`                | 37.0 MB   | 10.5 MB |
| `opencascade_full.js`                  | 68.2 KB   | —       |
| `opencascade_full.d.ts`                | 7.8 MB    | —       |
| `opencascade_full.js.symbols`          | —         | —       |
| `opencascade_full.provenance.json`     | generated | —       |
| `opencascade_full.build-manifest.json` | generated | —       |

Build configuration: `O3-wasm-exc-simd` (O3 compile, O4 wasm-opt, WASM exceptions, SIMD, BIGINT, EVAL_CTORS=2).

## Open Items

| #   | Action                                                                            | Priority | Impact                      |
| --- | --------------------------------------------------------------------------------- | -------- | --------------------------- |
| 1   | Investigate `DefineFormat` driver symbols — may be recoverable by adjusting CMake | P2       | Cleaner link                |
| 2   | Track OCCT 8 API changes affecting tests (breaking change inventory)              | P3       | Prevents future regressions |
