---
title: 'Emscripten/LLVM/Binaryen Optimization Flags Reference'
description: 'Comprehensive catalog of optimization flags across the Emscripten WASM build pipeline — compile, link, and post-link stages'
status: active
created: '2026-03-24'
updated: '2026-03-24'
category: reference
related:
  - docs/research/ocjs-full-build-audit.md
---

# Emscripten/LLVM/Binaryen Optimization Flags Reference

Comprehensive catalog of optimization flags available across the Emscripten WebAssembly build pipeline (Emscripten 5.0.1 / Binaryen 125 / LLVM 20), organized by build stage and classified by effect type. Sourced from Emscripten source tree (commit `62e226525`, March 2026), Binaryen `wasm-opt --help`, and official documentation.

## Executive Summary

The Emscripten build pipeline has three optimization stages: **compile** (Clang/LLVM → object files), **link** (wasm-ld + Emscripten JS generation), and **post-link** (Binaryen wasm-opt + wasm-ctor-eval + wasm-metadce). Optimization levels (`-O0` through `-O3`, `-Os`, `-Oz`) propagate through all three stages via internal `OPT_LEVEL` / `SHRINK_LEVEL` variables. Beyond the standard `-O` levels, dozens of flags affect performance, size, and correctness — from LLVM codegen flags like `-fno-rtti` and `-flto`, to Emscripten-specific settings like `EVAL_CTORS` and `BINARYEN_EXTRA_PASSES`, to wasm-opt passes like `--traps-never-happen` and `--fast-math`. Many flags interact: e.g., `-sWASM_BIGINT` eliminates the i64 legalization pass, and `-fwasm-exceptions` is mutually exclusive with `DISABLE_EXCEPTION_CATCHING`.

## Table of Contents

- [Build Pipeline Overview](#build-pipeline-overview)
- [Stage 1: Compile-Time Flags (Clang/LLVM)](#stage-1-compile-time-flags-clangllvm)
- [Stage 2: Link-Time Flags (emcc + wasm-ld)](#stage-2-link-time-flags-emcc--wasm-ld)
- [Stage 3: Post-Link (Binaryen/wasm-opt)](#stage-3-post-link-binaryenwasm-opt)
- [Binaryen Tools](#binaryen-tools)
- [wasm-opt Feature Flags](#wasm-opt-feature-flags)
- [wasm-opt Passes (Full Inventory)](#wasm-opt-passes-full-inventory)
- [Meta-Flags and Super-Flags](#meta-flags-and-super-flags)
- [Emscripten Settings (-s flags)](#emscripten-settings--s-flags)
- [wasm-ld Linker Flags](#wasm-ld-linker-flags)
- [CMake Integration](#cmake-integration)
- [Flag Interaction Matrix](#flag-interaction-matrix)
- [Recent Developments (2024–2026)](#recent-developments-20242026)

## Build Pipeline Overview

```
Source (.c/.cpp)
  │
  ├─ emcc -c -O3 -msimd128         ← Stage 1: Clang/LLVM compile
  │  └─ .o (object files or bitcode with -flto)
  │
  ├─ emcc -O3 -sWASM_BIGINT ...    ← Stage 2: Link (wasm-ld + JS gen)
  │  ├─ wasm-ld                     ← Binary linking
  │  ├─ wasm-emscripten-finalize    ← ABI fixups, metadata extraction
  │  ├─ wasm-opt (pass pipeline)    ← Stage 3: Post-link optimization
  │  ├─ wasm-ctor-eval              ← If EVAL_CTORS enabled
  │  ├─ wasm-metadce                ← If -O3 or -Os/-Oz (no ASSERTIONS)
  │  └─ wasm-opt (final StackIR)    ← Last-step optimization
  │
  └─ .wasm + .js + .d.ts
```

## Stage 1: Compile-Time Flags (Clang/LLVM)

These flags affect LLVM IR generation and optimization when compiling `.c`/`.cpp` → `.o` object files.

### Optimization Levels

Parsed in `tools/cmdline.py`. Each level sets internal `OPT_LEVEL` and `SHRINK_LEVEL`:

| Flag     | `OPT_LEVEL` | `SHRINK_LEVEL` | Type  | Effect                                                          |
| -------- | ----------- | -------------- | ----- | --------------------------------------------------------------- |
| `-O0`    | 0           | 0              | debug | No optimization. Includes assertions. Fastest compile.          |
| `-O`     | 2           | 0              | speed | Alias for `-O2`.                                                |
| `-O1`    | 1           | 0              | mixed | Basic optimizations. Binaryen optimizer **skipped** at link.    |
| `-O2`    | 2           | 0              | speed | Most optimizations. Binaryen optimizer **runs** at link.        |
| `-O3`    | 3           | 0              | speed | Aggressive optimization, may increase code size. Meta-DCE runs. |
| `-Os`    | 2           | 1              | size  | Like `-O2` but Binaryen runs with `-Os` (size-focused).         |
| `-Oz`    | 2           | 2              | size  | Maximum size reduction. Sets `TEXTDECODER=2` at link.           |
| `-Og`    | 1           | 0              | debug | Like `-O1` but bumps `DEBUG_LEVEL` to ≥1 for debuggability.     |
| `-Ofast` | 3           | 0              | speed | `-O3` plus `options.fast_math = True` (see meta-flags).         |

Invalid numeric levels (e.g., `-O4`) warn and coerce to `-O3`.

### C++ Language Flags

| Flag                  | Stage        | Type        | Default | Effect                                                                                                                   |
| --------------------- | ------------ | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `-fno-exceptions`     | compile      | size/speed  | off     | Sets `DISABLE_EXCEPTION_CATCHING=1` + `DISABLE_EXCEPTION_THROWING=1`. Up to 15% smaller.                                 |
| `-fexceptions`        | compile+link | correctness | off     | Emscripten JS-based EH. Sets `DISABLE_EXCEPTION_THROWING=0`, `DISABLE_EXCEPTION_CATCHING=0`.                             |
| `-fwasm-exceptions`   | compile+link | speed/size  | off     | Native WASM exception handling. Sets internal `WASM_EXCEPTIONS=1`. Mutually exclusive with `DISABLE_EXCEPTION_CATCHING`. |
| `-fignore-exceptions` | compile      | size        | off     | Sets `DISABLE_EXCEPTION_CATCHING=1`. Exceptions may still be thrown but won't be caught.                                 |
| `-fno-rtti`           | compile      | size        | off     | Disables C++ RTTI (`dynamic_cast`, `typeid`). Combined with `-fno-exceptions`: ~15% size reduction.                      |

### Math and Floating Point

| Flag                          | Stage        | Type  | Default | Effect                                                                |
| ----------------------------- | ------------ | ----- | ------- | --------------------------------------------------------------------- |
| `-ffast-math`                 | compile+link | speed | off     | LLVM unsafe FP opts at compile + `wasm-opt --fast-math` at post-link. |
| `-fno-math-errno`             | compile      | speed | off     | Don't set `errno` on math function errors.                            |
| `-ffinite-math-only`          | compile      | speed | off     | Assume no NaN or Infinity values.                                     |
| `-fno-signed-zeros`           | compile      | speed | off     | Treat +0.0 and -0.0 as equivalent.                                    |
| `-fassociative-math`          | compile      | speed | off     | Allow reassociation of FP operations.                                 |
| `-freciprocal-math`           | compile      | speed | off     | Allow `x/y` → `x * (1/y)`.                                            |
| `-fno-trapping-math`          | compile      | speed | off     | Assume FP operations don't trap.                                      |
| `-funsafe-math-optimizations` | compile      | speed | off     | Umbrella for several unsafe FP opts.                                  |
| `-ffp-contract=fast`          | compile      | speed | off     | Allow FP expression contraction (FMA).                                |
| `-fno-rounding-math`          | compile      | speed | off     | Assume default FP rounding mode.                                      |
| `-fno-signaling-nans`         | compile      | speed | off     | Assume no signaling NaN values.                                       |
| `-fexcess-precision=fast`     | compile      | speed | off     | Allow excess precision in FP calculations.                            |
| `-fcx-limited-range`          | compile      | speed | off     | Simplified complex number range.                                      |

All of the above (except `-ffp-contract=fast`) are enabled by `-ffast-math`.

### LTO (Link-Time Optimization)

| Flag                   | Stage        | Type       | Default | Effect                                                                                                                                                     |
| ---------------------- | ------------ | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-flto` / `-flto=full` | compile+link | speed/size | off     | Full LTO. Emits bitcode, enables cross-TU optimization. Link time 2–5× longer. **Caveat**: Can _increase_ WASM code size (Box2D: +2.5%, BananaBread: +8%). |
| `-flto=thin`           | compile+link | speed      | off     | Thin LTO — faster link. "Not heavily tested" per Emscripten docs.                                                                                          |
| `-fno-lto`             | compile      | —          | default | Explicitly disable LTO.                                                                                                                                    |

### WebAssembly Target Features (`-m` flags)

| Flag                    | Stage   | Type        | Default (generic CPU) | Effect                                                                |
| ----------------------- | ------- | ----------- | --------------------- | --------------------------------------------------------------------- |
| `-msimd128`             | compile | speed       | off                   | 128-bit SIMD instructions. Significant speedup for vectorizable code. |
| `-mrelaxed-simd`        | compile | speed       | off                   | Relaxed SIMD (determinism tradeoffs for speed).                       |
| `-mbulk-memory`         | compile | speed/size  | **on** (Jan 2025)     | Bulk memory operations (`memory.copy`, `memory.fill`).                |
| `-mmutable-globals`     | compile | correctness | **on**                | Mutable global imports/exports.                                       |
| `-mnontrapping-fptoint` | compile | correctness | **on**                | Non-trapping float-to-int conversions.                                |
| `-msign-ext`            | compile | size        | **on**                | Sign-extension operators.                                             |
| `-mtail-call`           | compile | speed       | off                   | Tail call optimization.                                               |
| `-mmultivalue`          | compile | mixed       | off                   | Multiple return values from functions.                                |
| `-matomics`             | compile | correctness | off                   | Atomic operations (requires `-pthread`).                              |

### Other Compile Flags

| Flag                 | Stage        | Type  | Default      | Effect                                                                                  |
| -------------------- | ------------ | ----- | ------------ | --------------------------------------------------------------------------------------- |
| `-fvectorize`        | compile      | speed | on at `-O2`+ | Auto-vectorization (requires `-msimd128` for WASM SIMD output).                         |
| `-funroll-loops`     | compile      | speed | on at `-O2`+ | Loop unrolling.                                                                         |
| `-finline-functions` | compile      | speed | on at `-O2`+ | Function inlining.                                                                      |
| `-g`                 | compile      | debug | off          | DWARF debug info.                                                                       |
| `-gsource-map`       | compile+link | debug | off          | Generate source maps. Since Sep 2025: independent of name sections and JS minification. |
| `-gsplit-dwarf`      | compile      | debug | off          | Split DWARF for faster links (must use with `-c`).                                      |

## Stage 2: Link-Time Flags (emcc + wasm-ld)

### Optimization Level Effects at Link Time

| Link Level | `OPT_LEVEL` | `SHRINK_LEVEL` | Binaryen Optimizer | Meta-DCE | JS Optimizations                        | Assertions |
| ---------- | ----------- | -------------- | ------------------ | -------- | --------------------------------------- | ---------- |
| `-O0`      | 0           | 0              | **skipped**        | no       | none                                    | on         |
| `-O1`      | 1           | 0              | **skipped**        | no       | minimal                                 | off        |
| `-O2`      | 2           | 0              | **run** (`-O2`)    | no       | JS DCE + minification                   | off        |
| `-O3`      | 3           | 0              | **run** (`-O3`)    | **yes**  | JS DCE + minification                   | off        |
| `-Os`      | 2           | 1              | **run** (`-Os`)    | **yes**  | JS DCE + minification                   | off        |
| `-Oz`      | 2           | 2              | **run** (`-Oz`)    | **yes**  | JS DCE + minification + `TEXTDECODER=2` | off        |

**Dev tip**: Compile at `-O2`, link at `-O0` for fast iteration (skips Binaryen entirely).

Meta-DCE requires: `(OPT_LEVEL >= 3 OR SHRINK_LEVEL >= 1) AND NOT ASSERTIONS`. Implements `will_metadce()` in `tools/link.py`.

### Emcc Auto-Enabled wasm-opt Passes

When `OPT_LEVEL >= 2`, emcc builds the wasm-opt pass pipeline in `get_binaryen_passes()` (`tools/link.py`):

| Pass/Flag                                         | Condition                                   | Purpose                               |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `--strip-target-features`                         | always (optimizing)                         | Strip features section                |
| `--post-emscripten`                               | always (optimizing)                         | Emscripten-specific post-processing   |
| `-O{N}` / `-Os` / `-Oz`                           | always (optimizing)                         | Main optimization level string        |
| `--low-memory-unused`                             | `GLOBAL_BASE >= 1024` and not `STACK_FIRST` | Assume low 1K unused                  |
| `--fast-math`                                     | `-ffast-math` or `-Ofast`                   | Unsafe FP optimizations               |
| `--ignore-implicit-traps`                         | `BINARYEN_IGNORE_IMPLICIT_TRAPS`            | Assume loads don't trap               |
| `--zero-filled-memory`                            | optimizing and not `SIDE_MODULE`            | Assume zero-initialized memory        |
| `--pass-arg=directize-initial-contents-immutable` | always (optimizing)                         | Initial table contents are immutable  |
| `--safe-heap`                                     | `SAFE_HEAP`                                 | Instrument heap accesses              |
| `--fpcast-emu`                                    | `EMULATE_FUNCTION_POINTER_CASTS`            | Emulate bad indirect calls            |
| `--asyncify`                                      | `ASYNCIFY == 1`                             | Async/await transform                 |
| `--no-stack-ir`                                   | `will_metadce()`                            | Defer StackIR opts to last invocation |
| `BINARYEN_EXTRA_PASSES` contents                  | non-empty string                            | User-specified extra passes           |

**Last-step Binaryen flags** (after meta-DCE, from `get_last_binaryen_opts()`):

- `--optimize-level={OPT_LEVEL}`
- `--shrink-level={SHRINK_LEVEL}`
- `--optimize-stack-ir`

### Closure Compiler

| Flag          | Stage | Type | Default | Effect                                                                          |
| ------------- | ----- | ---- | ------- | ------------------------------------------------------------------------------- |
| `--closure 0` | link  | —    | **yes** | No Closure Compiler.                                                            |
| `--closure 1` | link  | size | no      | Run Google Closure on JS glue. Hugely reduces JS size. Recommended for release. |
| `--closure 2` | link  | size | no      | Closure on all emitted code including asm.js. Not recommended.                  |

### Debug and Profiling (Link)

| Flag                  | Stage | Type  | Default | Effect                                                                    |
| --------------------- | ----- | ----- | ------- | ------------------------------------------------------------------------- |
| `-g0`                 | link  | debug | off     | No debug effort.                                                          |
| `-g1`                 | link  | debug | off     | Preserve JS whitespace.                                                   |
| `-g2` / `--profiling` | link  | debug | off     | Preserve function names (wasm name section).                              |
| `-g3` / `-g`          | link  | debug | off     | Keep DWARF info.                                                          |
| `-gseparate-dwarf`    | link  | debug | off     | DWARF in separate `.debug.wasm` file.                                     |
| `--profiling-funcs`   | link  | debug | off     | Preserve wasm function names only, still minify JS.                       |
| `--emit-symbol-map`   | link  | debug | off     | Map file: function index → name.                                          |
| `-gsource-map`        | link  | debug | off     | Generate `.wasm.map`. Works with optimized release builds since Sep 2025. |

### Other Link Flags

| Flag                | Stage | Type        | Default | Effect                                   |
| ------------------- | ----- | ----------- | ------- | ---------------------------------------- |
| `-lembind`          | link  | correctness | off     | Link embind library for C++/JS bindings. |
| `--emit-tsd <path>` | link  | correctness | off     | Generate TypeScript definition file.     |
| `--no-entry`        | link  | correctness | off     | No main entry point (library/reactor).   |

## Stage 3: Post-Link (Binaryen/wasm-opt)

Binaryen's `wasm-opt` runs automatically at link time when `OPT_LEVEL >= 2`. Can also be run standalone.

### wasm-opt Optimization Levels

| Flag  | Type  | Effect                                                                     |
| ----- | ----- | -------------------------------------------------------------------------- |
| `-O0` | —     | No optimization passes.                                                    |
| `-O1` | speed | Quick and useful passes for iteration builds.                              |
| `-O2` | speed | Most passes. Generally gets most performance.                              |
| `-O3` | speed | Spends potentially a lot of time optimizing.                               |
| `-O4` | speed | `-O3` plus flattens IR. More time/memory. Useful for complex/nested input. |
| `-Os` | size  | Default passes, focus on code size. Equivalent to bare `-O`.               |
| `-Oz` | size  | Super-focused on code size.                                                |

`-O4` is **only valid for wasm-opt**, not emcc. In emcc, `-O4` warns and coerces to `-O3`. Use `OCJS_WASM_OPT_LEVEL=-O4` or run wasm-opt standalone.

### wasm-opt Global Optimization Options

These tune what the optimizer is allowed to assume:

| Flag                      | Alias  | Type       | Default | Safety                      | Effect                                                                                             |
| ------------------------- | ------ | ---------- | ------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `--traps-never-happen`    | `-tnh` | speed/size | off     | **unsafe**                  | Assume no trap is ever reached. Enables aggressive dead-code and reordering. Strongest assumption. |
| `--ignore-implicit-traps` | `-iit` | speed/size | off     | **unsafe**                  | Assume loads, div/mod don't trap. Weaker than `--traps-never-happen`.                              |
| `--fast-math`             | `-ffm` | speed      | off     | **unsafe**                  | Optimize floats without strict NaN/rounding.                                                       |
| `--low-memory-unused`     | `-lmu` | speed/size | off     | unsafe if 1st KB used       | Assume low 1 KiB of memory is unused.                                                              |
| `--zero-filled-memory`    | `-uim` | speed/size | off     | unsafe if memory pre-filled | Assume imported memory is zero-initialized.                                                        |
| `--closed-world`          | `-cw`  | speed/size | off     | GC/ref specific             | Assume external code doesn't inspect GC/function refs.                                             |
| `--converge`              | `-c`   | mixed      | off     | safe                        | Run passes until binary size stops decreasing.                                                     |
| `--no-validation`         | `-n`   | speed      | off     | **dangerous**               | Skip validation. Faster but can emit invalid wasm.                                                 |

### wasm-opt Inlining Controls

| Flag                                    | Alias     | Type       | Default  | Effect                                                 |
| --------------------------------------- | --------- | ---------- | -------- | ------------------------------------------------------ |
| `--always-inline-max-function-size`     | `-aimfs`  | speed/size | 2        | Max size for always-inlined functions.                 |
| `--flexible-inline-max-function-size`   | `-fimfs`  | speed      | 20       | Max size for lightweight inlines at `-O3`.             |
| `--one-caller-inline-max-function-size` | `-ocimfs` | speed      | -1 (all) | Max size for single-caller functions. -1 = inline all. |
| `--inline-max-combined-binary-size`     | `-imcbs`  | size       | 409600   | Cap combined function size after inlining.             |
| `--inline-functions-with-loops`         | `-ifwl`   | speed      | off      | Allow inlining functions containing loops.             |
| `--partial-inlining-ifs`                | `-pii`    | speed      | 0        | Max ifs for partial inlining. 0 = disabled.            |

### wasm-opt Stripping Passes

| Pass                            | Type | Effect                                    |
| ------------------------------- | ---- | ----------------------------------------- |
| `--strip-debug`                 | size | Strip debug info including names section. |
| `--strip-dwarf`                 | size | Strip DWARF debug sections only.          |
| `--strip-producers`             | size | Strip wasm producers section.             |
| `--strip-target-features`       | size | Strip target features section.            |
| `--strip-eh`                    | size | Strip exception handling instructions.    |
| `--strip-toolchain-annotations` | size | Strip toolchain-specific annotations.     |

## Binaryen Tools

Beyond `wasm-opt`, the post-link stage uses several specialized Binaryen tools:

| Tool                       | When Used        | Purpose                                                                            |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `wasm-emscripten-finalize` | Always at link   | ABI fixups, metadata extraction, legalization, DWARF processing.                   |
| `wasm-ctor-eval`           | `EVAL_CTORS > 0` | Evaluate global constructors at compile time. `=2` adds `--ignore-external-input`. |
| `wasm-metadce`             | `will_metadce()` | Cross-language (JS+WASM) dead code elimination.                                    |
| `wasm-split`               | `SPLIT_MODULE`   | Instrument/split module for lazy loading.                                          |

## wasm-opt Feature Flags

Each feature has `--enable-*` and `--disable-*` variants:

| Feature                   | Enable Flag                          | Status         |
| ------------------------- | ------------------------------------ | -------------- |
| Sign extension            | `--enable-sign-ext`                  | Default on     |
| Threads / atomics         | `--enable-threads`                   | Off by default |
| Mutable globals           | `--enable-mutable-globals`           | Default on     |
| Nontrapping float→int     | `--enable-nontrapping-float-to-int`  | Default on     |
| SIMD                      | `--enable-simd`                      | Off by default |
| Bulk memory               | `--enable-bulk-memory`               | Default on     |
| Bulk memory opt           | `--enable-bulk-memory-opt`           | Off by default |
| Exception handling        | `--enable-exception-handling`        | Off by default |
| Tail call                 | `--enable-tail-call`                 | Off by default |
| Reference types           | `--enable-reference-types`           | Off by default |
| Multivalue                | `--enable-multivalue`                | Off by default |
| GC                        | `--enable-gc`                        | Off by default |
| Memory64                  | `--enable-memory64`                  | Off by default |
| Relaxed SIMD              | `--enable-relaxed-simd`              | Off by default |
| Extended const            | `--enable-extended-const`            | Off by default |
| Strings                   | `--enable-strings`                   | Off by default |
| Multimemory               | `--enable-multimemory`               | Off by default |
| Stack switching           | `--enable-stack-switching`           | Off by default |
| Shared-everything threads | `--enable-shared-everything`         | Off by default |
| FP16                      | `--enable-fp16`                      | Off by default |
| Custom descriptors / RTTs | `--enable-custom-descriptors`        | Off by default |
| Relaxed atomics           | `--enable-relaxed-atomics`           | Off by default |
| Typed function refs       | `--enable-typed-function-references` | **Deprecated** |

Umbrella flags: `--mvp-features` (disable all non-MVP), `--all-features` (enable all).

## wasm-opt Passes (Full Inventory)

Complete list from `wasm-opt --help` (Binaryen version 125). Passes run via `--<pass-name>` or via `BINARYEN_EXTRA_PASSES`.

### Size Optimization Passes

| Pass                                          | Effect                                           |
| --------------------------------------------- | ------------------------------------------------ |
| `--dce`                                       | Dead code elimination — remove unreachable code. |
| `--vacuum`                                    | Remove obviously unneeded code.                  |
| `--duplicate-function-elimination`            | Remove duplicate functions.                      |
| `--duplicate-import-elimination`              | Remove duplicate imports.                        |
| `--dae`                                       | Dead argument elimination (LTO-style).           |
| `--dae-optimizing`                            | `dae` + optimize where args removed.             |
| `--code-folding`                              | Fold/merge duplicate code sequences.             |
| `--merge-blocks`                              | Merge blocks into parents.                       |
| `--merge-locals`                              | Merge locals when beneficial.                    |
| `--merge-similar-functions`                   | Merge similar functions.                         |
| `--remove-unused-brs`                         | Remove unnecessary breaks.                       |
| `--remove-unused-module-elements`             | Remove unused module elements.                   |
| `--remove-unused-nonfunction-module-elements` | Remove unused non-function module elements.      |
| `--remove-unused-names`                       | Remove names from unneeded locations.            |
| `--remove-unused-types`                       | Remove unused private GC types.                  |
| `--minimize-rec-groups`                       | Split types into minimal recursion groups.       |
| `--reorder-functions`                         | Sort functions by access frequency.              |
| `--reorder-globals`                           | Sort globals by access frequency.                |
| `--reorder-locals`                            | Sort locals by access frequency.                 |
| `--reorder-types`                             | Sort private types by access frequency.          |
| `--memory-packing`                            | Pack memory into segments, skip zeros.           |
| `--const-hoisting`                            | Hoist repeated constants to a local.             |
| `--signature-pruning`                         | Drop unused params from signatures.              |
| `--signature-refining`                        | Narrow signature subtypes.                       |
| `--outlining`                                 | Outline repeated instruction sequences.          |
| `--once-reduction`                            | Reduce calls to code that runs only once.        |
| `--pick-load-signs`                           | Pick load signs from uses.                       |

### Speed Optimization Passes

| Pass                                   | Effect                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `--optimize-instructions`              | Optimize instruction combinations.                              |
| `--precompute`                         | Constant-fold at compile time.                                  |
| `--precompute-propagate`               | Precompute + propagate through locals.                          |
| `--inlining`                           | Inline functions.                                               |
| `--inlining-optimizing`                | Inline + optimize at inline sites. Preferred over `--inlining`. |
| `--directize`                          | Convert indirect calls to direct.                               |
| `--local-cse`                          | Common subexpression elimination in basic blocks.               |
| `--licm`                               | Loop invariant code motion.                                     |
| `--coalesce-locals`                    | Reduce number of locals by coalescing.                          |
| `--coalesce-locals-learning`           | Coalesce locals with learning heuristic.                        |
| `--simplify-locals`                    | Miscellaneous local optimizations.                              |
| `--simplify-locals-nonesting`          | Local opts without nesting (keeps flatness).                    |
| `--simplify-locals-nostructure`        | Local opts without structure.                                   |
| `--simplify-locals-notee`              | Local opts without tees.                                        |
| `--simplify-locals-notee-nostructure`  | No tees or structure.                                           |
| `--simplify-globals`                   | Miscellaneous global optimizations.                             |
| `--simplify-globals-optimizing`        | `simplify-globals` + optimize replaced `global.get`s.           |
| `--code-pushing`                       | Push code forward (may not always run).                         |
| `--optimize-added-constants`           | Fold constants into load/store offsets.                         |
| `--optimize-added-constants-propagate` | Same + propagate across locals.                                 |
| `--ssa`                                | SSA form: single assignment.                                    |
| `--ssa-nomerge`                        | SSA ignoring merges.                                            |
| `--cfp`                                | Constant field propagation (struct fields).                     |
| `--cfp-reftest`                        | `cfp` using `ref.test`.                                         |
| `--gufa`                               | Grand Unified Flow Analysis — whole-program content tracking.   |
| `--gufa-optimizing`                    | GUFA + local opts in modified functions.                        |
| `--gufa-cast-all`                      | GUFA + add casts for all inferences.                            |
| `--monomorphize`                       | Create specialized function versions.                           |
| `--monomorphize-always`                | Specialize even if unhelpful.                                   |
| `--rse`                                | Remove redundant `local.set`s.                                  |
| `--avoid-reinterprets`                 | Avoid reinterpret ops via more loads.                           |
| `--flatten`                            | Flatten code; remove nesting. Used by `-O4`.                    |
| `--rereloop`                           | Re-optimize CFG with relooper.                                  |
| `--dfo`                                | Optimize using DataFlow SSA IR.                                 |
| `--inline-main`                        | Inline `__original_main` into `main`.                           |
| `--optimize-for-js`                    | Early opts for JS instruction combos.                           |

### GC / Reference Type Passes

| Pass                        | Effect                                           |
| --------------------------- | ------------------------------------------------ |
| `--abstract-type-refining`  | Refine and merge abstract (never-created) types. |
| `--global-refining`         | Refine global types.                             |
| `--gsi`                     | Globally optimize struct values.                 |
| `--gsi-desc-cast`           | `gsi` + emit `ref.cast_desc_eq`.                 |
| `--gto`                     | Globally optimize GC types.                      |
| `--heap-store-optimization` | Optimize GC heap stores.                         |
| `--heap2local`              | Replace GC allocations with locals.              |
| `--local-subtyping`         | Narrow local subtypes.                           |
| `--optimize-casts`          | Eliminate/reuse casts.                           |
| `--type-finalizing`         | Mark leaf types final.                           |
| `--type-merging`            | Merge types toward supertypes.                   |
| `--type-refining`           | Narrow type fields.                              |
| `--type-refining-gufa`      | Type refining using GUFA.                        |
| `--type-ssa`                | New types to help other opts.                    |
| `--type-unfinalizing`       | Mark all types non-final (open).                 |
| `--unsubtyping`             | Remove unnecessary subtyping edges.              |
| `--tuple-optimization`      | Optimize away trivial tuples.                    |

### Emscripten / ABI Passes

| Pass                                       | Effect                                           |
| ------------------------------------------ | ------------------------------------------------ |
| `--post-emscripten`                        | Miscellaneous Emscripten-specific optimizations. |
| `--asyncify`                               | Async/await transform for pausing/resuming.      |
| `--generate-dyncalls`                      | Generate `dynCall` functions for Emscripten ABI. |
| `--generate-i64-dyncalls`                  | dynCalls for i64 signatures (BigInt).            |
| `--legalize-js-interface`                  | Legalize i64 types on import/export boundary.    |
| `--legalize-and-prune-js-interface`        | Legalize + prune unused imports.                 |
| `--minify-imports`                         | Minify import names + mapping.                   |
| `--minify-imports-and-exports`             | Minify imports and exports + mapping.            |
| `--minify-imports-and-exports-and-modules` | Same + minify modules.                           |

### Feature Lowering Passes

| Pass                                         | Effect                                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| `--signext-lowering`                         | Lower sign-ext to MVP; disable sign-ext feature.                |
| `--llvm-nontrapping-fptoint-lowering`        | Lower nontrapping fptoint; disable feature.                     |
| `--llvm-memory-copy-fill-lowering`           | Lower `memory.copy`/`fill` to MVP; disable bulk-memory feature. |
| `--memory64-lowering` / `--table64-lowering` | Lower 64-bit memory/table to 32-bit.                            |
| `--multi-memory-lowering`                    | Combine multiple memories → one.                                |
| `--multi-memory-lowering-with-bounds-checks` | Same + trap on OOB access.                                      |
| `--i64-to-i32-lowering`                      | Lower i64 uses to i32.                                          |
| `--alignment-lowering`                       | Lower unaligned loads/stores.                                   |
| `--emit-exnref`                              | Translate to new EH instructions (exnref).                      |
| `--translate-to-exnref`                      | Old Phase 3 EH → exnref.                                        |
| `--string-lowering`                          | Lower wasm strings to imports.                                  |
| `--string-lowering-magic-imports`            | Strings as magic imports.                                       |
| `--string-lifting`                           | Lift string imports to wasm strings.                            |
| `--string-gathering`                         | Gather wasm strings to globals.                                 |

### Debugging / Instrumentation Passes

| Pass                        | Effect                                                   |
| --------------------------- | -------------------------------------------------------- |
| `--safe-heap`               | Instrument memory ops to catch invalid behavior.         |
| `--instrument-locals`       | Intercept all local loads/stores.                        |
| `--instrument-memory`       | Intercept all memory loads/stores.                       |
| `--instrument-branch-hints` | Instrument branch hints (check prediction accuracy).     |
| `--log-execution`           | Log where execution goes.                                |
| `--stack-check`             | Enforce limits on LLVM `__stack_pointer`.                |
| `--denan`                   | Instrument wasm: convert NaN → 0 at runtime.             |
| `--fpcast-emu`              | Emulate bad indirect calls (incorrect casts may "work"). |
| `--trap-mode-clamp`         | Trapping ops → clamping semantics.                       |
| `--trap-mode-js`            | Trapping ops → JS semantics.                             |
| `--spill-pointers`          | Spill pointers to C stack (e.g. Boehm GC).               |

### Printing / Analysis Passes

| Pass                                   | Effect                       |
| -------------------------------------- | ---------------------------- |
| `--print`                              | Print s-expression.          |
| `--print-full`                         | Print full s-expression.     |
| `--print-minified`                     | Print minified s-expression. |
| `--print-call-graph`                   | Print call graph.            |
| `--print-function-map` / `--symbolmap` | Map function index → name.   |
| `--print-features`                     | Print enabled features.      |
| `--func-metrics`                       | Report function metrics.     |
| `--metrics`                            | Report module metrics.       |
| `--nm`                                 | Name list.                   |
| `--dwarfdump`                          | Dump DWARF debug sections.   |

### Other Passes

| Pass                                                       | Effect                                            |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `--generate-global-effects`                                | Generate global effect info (helps later passes). |
| `--discard-global-effects`                                 | Discard global effect info.                       |
| `--propagate-globals-globally`                             | Propagate global values.                          |
| `--propagate-debug-locs`                                   | Propagate debug locations to children.            |
| `--set-globals`                                            | Set specified globals to values.                  |
| `--name-types`                                             | (Re)name all heap types.                          |
| `--no-full-inline` / `--no-inline` / `--no-partial-inline` | Mark functions as no-inline.                      |
| `--enclose-world`                                          | Modify wasm destructively for closed-world.       |
| `--emit-target-features`                                   | Emit target features section in output.           |
| `--extract-function` / `--extract-function-index`          | Keep one function (debugging).                    |
| `--remove-imports`                                         | Remove imports → nops.                            |
| `--remove-memory-init`                                     | Remove memory initialization.                     |
| `--remove-non-js-ops`                                      | Remove ops incompatible with JS.                  |
| `--remove-relaxed-simd`                                    | Replace relaxed SIMD with unreachable.            |
| `--roundtrip`                                              | Write module to binary, then read back.           |
| `--separate-data-segments`                                 | Write data segments to file; strip from module.   |
| `--untee`                                                  | Replace `local.tee` with set/get.                 |
| `--limit-segments`                                         | Merge segments to fit web limits.                 |
| `--optimize-j2cl` / `--merge-j2cl-itables`                 | J2CL-specific optimizations.                      |
| `--poppify`                                                | Transform Binaryen IR → Poppy IR.                 |
| `--stub-unsupported-js`                                    | Stub unsupported JS operations.                   |
| `--trace-calls`                                            | Intercept specific function calls.                |
| `--intrinsic-lowering`                                     | Lower Binaryen intrinsics.                        |

## Meta-Flags and Super-Flags

### `-Ofast` (Clang/emcc)

`-Ofast` = `-O3` + `-ffast-math`. Sets `OPT_LEVEL=3`, `SHRINK_LEVEL=0`, `options.fast_math=True`.

The `-ffast-math` component expands to 12 LLVM sub-flags (see Math and Floating Point above) **plus** `wasm-opt --fast-math` at post-link.

### `-Os` / `-Oz` (Clang/emcc)

These set `OPT_LEVEL=2` with `SHRINK_LEVEL=1` or `2`. At LLVM level, Clang sees `-Os`/`-Oz` natively. At Binaryen level, `opt_level_to_str()` maps to wasm-opt `-Os`/`-Oz`. Additional effects at `-Oz`: `TEXTDECODER=2` (assume TextDecoder available).

### `-Og` (Clang/emcc)

Sets `OPT_LEVEL=1`, bumps `DEBUG_LEVEL` to at least 1. Oriented to debuggable optimized builds. Binaryen optimizer is **skipped** (like `-O1`).

### emcc `-O` Level → Internal Mapping

| emcc     | `OPT_LEVEL` | `SHRINK_LEVEL` | LLVM              | Binaryen          | JS Min | Meta-DCE |
| -------- | ----------- | -------------- | ----------------- | ----------------- | ------ | -------- |
| `-O0`    | 0           | 0              | none              | skipped           | no     | no       |
| `-O1`    | 1           | 0              | `-O1`             | skipped           | no     | no       |
| `-O2`    | 2           | 0              | `-O2`             | `-O2`             | yes    | no       |
| `-O3`    | 3           | 0              | `-O3`             | `-O3`             | yes    | **yes**  |
| `-Os`    | 2           | 1              | `-Os`             | `-Os`             | yes    | **yes**  |
| `-Oz`    | 2           | 2              | `-Oz`             | `-Oz`             | yes    | **yes**  |
| `-Ofast` | 3           | 0              | `-O3 -ffast-math` | `-O3 --fast-math` | yes    | **yes**  |

## Emscripten Settings (-s flags)

These are Emscripten-specific settings passed via `-sKEY=VALUE`. Unless noted, they apply at link time.

### Performance and Behavior

| Setting                          | Type        | Default      | Stage        | Effect                                                                                                                                                                                              |
| -------------------------------- | ----------- | ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_CTORS`                     | speed/size  | `0`          | link         | Evaluate global constructors at compile time via `wasm-ctor-eval`. `=1`: safe. `=2`: also `--ignore-external-input` (env vars, argc/argv ignored). ~2.6% wasm size reduction on `hello_libcxx -O3`. |
| `WASM_BIGINT`                    | speed       | `true`       | link         | Use JS BigInt for i64. Eliminates i64 legalization pass. Faster link.                                                                                                                               |
| `ALLOW_MEMORY_GROWTH`            | correctness | `false`      | link         | Allow heap to grow at runtime.                                                                                                                                                                      |
| `MALLOC`                         | speed/size  | `"dlmalloc"` | link         | Allocator: `dlmalloc` (default), `emmalloc` (smaller), `mimalloc` (better multithreaded).                                                                                                           |
| `ASYNCIFY`                       | correctness | `0`          | link         | Enable async/await transform. Significant code size and speed cost.                                                                                                                                 |
| `JSPI`                           | speed       | `0`          | link         | JS Promise Integration — lighter alternative to ASYNCIFY. No whole-program instrumentation.                                                                                                         |
| `SUPPORT_LONGJMP`                | size        | `true`       | compile+link | `"emscripten"`: JS-based (default). `"wasm"`: native Wasm EH-based (smaller). `0`: disabled.                                                                                                        |
| `INLINING_LIMIT`                 | size        | `false`      | compile      | If `1`, prevents LLVM inlining.                                                                                                                                                                     |
| `STANDALONE_WASM`                | correctness | `false`      | link         | Emit WASI-compatible wasm.                                                                                                                                                                          |
| `BINARYEN_IGNORE_IMPLICIT_TRAPS` | speed       | `false`      | link         | Adds `--ignore-implicit-traps` to wasm-opt.                                                                                                                                                         |
| `BINARYEN_EXTRA_PASSES`          | mixed       | `""`         | link         | Comma-separated extra wasm-opt passes.                                                                                                                                                              |
| `LEGALIZE_JS_FFI`                | correctness | `true`       | link         | Legalize i64 at JS boundary. Auto-set to `0` when `WASM_BIGINT`.                                                                                                                                    |

### Code Size

| Setting                  | Type | Default                             | Stage        | Effect                                                                  |
| ------------------------ | ---- | ----------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `ENVIRONMENT`            | size | `['web','webview','worker','node']` | link         | Restrict target environments. `"web"` saves ~2KB.                       |
| `FILESYSTEM`             | size | `true`                              | link         | Set to `0` for pure computational libraries.                            |
| `INCOMING_MODULE_JS_API` | size | (common subset)                     | link         | Restrict Module attributes. `[]` for max size reduction. ~2.5% savings. |
| `MODULARIZE`             | size | `false`                             | link         | Wrap output in factory function.                                        |
| `EXPORT_ES6`             | size | `false`                             | link         | ES6 module export. Implicitly enables `MODULARIZE`.                     |
| `SINGLE_FILE`            | size | `false`                             | link         | Embed wasm in JS file.                                                  |
| `TEXTDECODER`            | size | `1`                                 | link         | `2`: assume TextDecoder available. Auto-set at `-Oz`.                   |
| `MINIMAL_RUNTIME`        | size | `0`                                 | link         | `1`/`2`: minimal runtime, no POSIX, no Module object.                   |
| `SUPPORT_ERRNO`          | size | `true`                              | link         | Set `0` to skip errno support.                                          |
| `STRICT`                 | size | `false`                             | compile+link | Drop deprecated features. Sets `INCOMING_MODULE_JS_API=[]`.             |

### Exception Handling

| Setting                             | Type        | Default | Stage        | Effect                                                                      |
| ----------------------------------- | ----------- | ------- | ------------ | --------------------------------------------------------------------------- |
| `DISABLE_EXCEPTION_CATCHING`        | speed/size  | `1`     | compile+link | Disable JS-based catch blocks. Mutually exclusive with `-fwasm-exceptions`. |
| `DISABLE_EXCEPTION_THROWING`        | size        | `false` | compile+link | Disable exception throwing. Triggered by `-fno-exceptions`.                 |
| `EXCEPTION_CATCHING_ALLOWED`        | speed/size  | `[]`    | compile+link | Whitelist functions that may catch exceptions.                              |
| `WASM_LEGACY_EXCEPTIONS`            | correctness | `true`  | compile+link | Use legacy Wasm EH proposal. Set `false` for standardized proposal.         |
| `EXPORT_EXCEPTION_HANDLING_HELPERS` | correctness | —       | link         | **Deprecated**: use `EXPORTED_RUNTIME_METHODS` instead.                     |

### Memory

| Setting           | Type        | Default         | Stage        | Effect                                                                     |
| ----------------- | ----------- | --------------- | ------------ | -------------------------------------------------------------------------- |
| `INITIAL_HEAP`    | correctness | `16MB`          | link         | Initial heap for dynamic allocations.                                      |
| `INITIAL_MEMORY`  | correctness | auto-calculated | link         | Total initial memory.                                                      |
| `MAXIMUM_MEMORY`  | correctness | `2GB`           | link         | Maximum memory with `ALLOW_MEMORY_GROWTH`.                                 |
| `STACK_SIZE`      | correctness | `64KB`          | link         | Total stack size. Not growable.                                            |
| `MEMORY64`        | correctness | `0`             | compile+link | `0`: wasm32. `1`: wasm64. `2`: wasm64 internally, lowered to wasm32.       |
| `GLOBAL_BASE`     | speed/size  | `1024`          | link         | Start of static memory. ≥1024 enables `--low-memory-unused`.               |
| `IMPORTED_MEMORY` | correctness | `false`         | link         | Define Memory in JS. Required for pthreads.                                |
| `STACK_FIRST`     | size/speed  | transitioning   | link         | Place stack before static data. Affects `--low-memory-unused` eligibility. |

### Runtime Exports

| Setting                    | Type        | Default     | Stage | Effect                                                                |
| -------------------------- | ----------- | ----------- | ----- | --------------------------------------------------------------------- |
| `EXPORTED_FUNCTIONS`       | correctness | `['_main']` | link  | Functions to export from wasm.                                        |
| `EXPORTED_RUNTIME_METHODS` | correctness | `[]`        | link  | Runtime methods available on Module (e.g., `["FS","ccall","cwrap"]`). |
| `EXPORT_ALL`               | size        | `false`     | link  | Export all symbols (debugging).                                       |

### Debug and Assertions

| Setting                            | Type        | Default               | Stage | Effect                                                            |
| ---------------------------------- | ----------- | --------------------- | ----- | ----------------------------------------------------------------- |
| `ASSERTIONS`                       | debug       | `1` (off at `-O1`+)   | link  | Runtime assertions. `2` = extra checks.                           |
| `STACK_OVERFLOW_CHECK`             | debug       | `0` (1 if ASSERTIONS) | link  | `1`: security cookie. `2`: binaryen pass checks all stack writes. |
| `SAFE_HEAP`                        | debug       | `0`                   | link  | `1`: check all heap reads/writes. `2`: wasm-only checks.          |
| `ERROR_ON_WASM_CHANGES_AFTER_LINK` | debug       | `false`               | link  | Error if wasm must be modified post-link.                         |
| `ERROR_ON_UNDEFINED_SYMBOLS`       | correctness | `true`                | link  | Error (vs warning) on undefined symbols.                          |
| `DETERMINISTIC`                    | debug       | `false`               | link  | Force deterministic Date.now(), Math.random().                    |

### Browser Targeting

| Setting               | Type | Default  | Stage | Effect                                |
| --------------------- | ---- | -------- | ----- | ------------------------------------- |
| `MIN_CHROME_VERSION`  | size | `85`     | link  | Drop code for older Chrome versions.  |
| `MIN_FIREFOX_VERSION` | size | `79`     | link  | Drop code for older Firefox versions. |
| `MIN_SAFARI_VERSION`  | size | `150000` | link  | Drop code for older Safari versions.  |
| `MIN_NODE_VERSION`    | size | `160000` | link  | Drop code for older Node.js versions. |

### Deprecated Settings

| Setting                             | Status     | Replacement                      |
| ----------------------------------- | ---------- | -------------------------------- |
| `CLOSURE_WARNINGS`                  | deprecated | Use `-Wclosure` / `-Wno-closure` |
| `EXPORT_EXCEPTION_HANDLING_HELPERS` | deprecated | Use `EXPORTED_RUNTIME_METHODS`   |

## wasm-ld Linker Flags

These flags are passed to wasm-ld by emcc and affect binary linking:

| Flag                                       | Condition                                                            | Effect                                            |
| ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| `--strip-debug`                            | No DWARF, no symbol map, no source map, no name section, no ASYNCIFY | Strip debug info from linked binary.              |
| `--import-undefined`                       | `!ERROR_ON_UNDEFINED_SYMBOLS`                                        | Allow undefined symbols as imports.               |
| `-z stack-size=N`                          | always (non side-module)                                             | Set stack size.                                   |
| `--initial-memory=N`                       | `INITIAL_MEMORY` set                                                 | Set initial memory.                               |
| `--initial-heap=N`                         | `INITIAL_HEAP` set                                                   | Set initial heap.                                 |
| `--max-memory=N`                           | `ALLOW_MEMORY_GROWTH`                                                | Set maximum memory.                               |
| `--no-growable-memory`                     | `!ALLOW_MEMORY_GROWTH`                                               | Disable memory growth.                            |
| `--stack-first` / `--no-stack-first`       | `STACK_FIRST`                                                        | Place stack before/after static data.             |
| `--global-base=N`                          | not `STACK_FIRST`                                                    | Set start of static memory.                       |
| `--table-base=N`                           | always (non side-module)                                             | Set table base.                                   |
| `--export=SYM`                             | `ERROR_ON_UNDEFINED_SYMBOLS`                                         | Export specific symbol.                           |
| `--export-if-defined=SYM`                  | `!ERROR_ON_UNDEFINED_SYMBOLS`                                        | Export symbol if defined.                         |
| `--export-dynamic`                         | `LINKABLE`                                                           | Export dynamic symbols.                           |
| `--import-memory`                          | `IMPORTED_MEMORY`                                                    | Import memory from JS.                            |
| `--shared-memory`                          | `SHARED_MEMORY`                                                      | Enable shared memory (pthreads).                  |
| `--fatal-warnings`                         | `STRICT`                                                             | Treat warnings as errors.                         |
| `--keep-section=target_features`           | with `--strip-debug`                                                 | Preserve target features when stripping.          |
| `-mwasm64`                                 | `MEMORY64`                                                           | Enable wasm64.                                    |
| `--experimental-pic`                       | `MAIN_MODULE` or `SIDE_MODULE`                                       | Position-independent code.                        |
| `-u__cxa_atexit`                           | `LTO` and not `EXIT_RUNTIME`                                         | Force `__cxa_atexit` inclusion for LTO.           |
| `-mllvm -wasm-enable-eh`                   | `WASM_EXCEPTIONS`                                                    | Enable WASM exception handling in LLVM backend.   |
| `-mllvm -exception-model=wasm`             | `WASM_EXCEPTIONS` or `SUPPORT_LONGJMP == 'wasm'`                     | Set exception model.                              |
| `-mllvm -enable-emscripten-cxx-exceptions` | Emscripten C++ EH                                                    | Enable Emscripten C++ exceptions in LLVM backend. |
| `-mllvm -enable-emscripten-sjlj`           | `SUPPORT_LONGJMP == 'emscripten'`                                    | Enable Emscripten setjmp/longjmp.                 |
| `-mllvm -wasm-enable-sjlj`                 | `SUPPORT_LONGJMP == 'wasm'`                                          | Enable WASM setjmp/longjmp.                       |

## CMake Integration

### Toolchain Setup

```cmake
cmake -DCMAKE_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake ..
```

Or use the wrapper: `emcmake cmake ..`

### Setting Flags in CMakeLists.txt

```cmake
if(EMSCRIPTEN)
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fno-rtti -fno-exceptions -msimd128")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fno-rtti -fno-exceptions -msimd128")

  set(CMAKE_C_FLAGS_RELEASE "-O3")
  set(CMAKE_CXX_FLAGS_RELEASE "-O3")

  string(JOIN " " EMSCRIPTEN_LINK_FLAGS
    "-O3"
    "-flto"
    "--closure=1"
    "-sWASM_BIGINT"
    "-sENVIRONMENT=web"
    "-sALLOW_MEMORY_GROWTH"
    "-sEVAL_CTORS=2"
    "-sFILESYSTEM=0"
    "-sINCOMING_MODULE_JS_API=[]"
    "-sMODULARIZE"
    "-sEXPORT_ES6"
  )
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} ${EMSCRIPTEN_LINK_FLAGS}")
endif()
```

**Important**: `-s` flags must appear in linker flags, not compile flags. Feature flags like `-msimd128` and `-fno-exceptions` should appear in both compile and link flags.

## Flag Interaction Matrix

| Flag A                 | Flag B                       | Interaction                                                                        |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `-fwasm-exceptions`    | `DISABLE_EXCEPTION_CATCHING` | **Mutually exclusive**. Cannot combine.                                            |
| `-fwasm-exceptions`    | `SUPPORT_LONGJMP`            | Auto-selects `"wasm"` mode for longjmp.                                            |
| `-flto`                | Link at `-O0`                | LTO defers codegen to link. `-O0` link skips Binaryen but runs LLVM codegen.       |
| `WASM_BIGINT`          | i64 legalization             | `WASM_BIGINT=true` skips legalization, enables `ERROR_ON_WASM_CHANGES_AFTER_LINK`. |
| `ASYNCIFY`             | `WASM_BIGINT`                | ASYNCIFY can fail with WASM_BIGINT. Use `JSPI` instead.                            |
| `ASYNCIFY`             | `JSPI`                       | Alternatives. JSPI is lighter (no whole-program transform).                        |
| `EVAL_CTORS=2`         | `argc`/`argv` or `getenv()`  | `=2` ignores external input — program must not depend on these.                    |
| `EVAL_CTORS`           | `WASM2JS` / `ASYNCIFY`       | Incompatible. Cannot use together.                                                 |
| `--closure 1`          | `MODULARIZE`                 | Recommended together.                                                              |
| `GLOBAL_BASE >= 1024`  | `--low-memory-unused`        | ≥1024 (default) enables the pass. Disabled if `STACK_FIRST`.                       |
| `TEXTDECODER`          | `-Oz`                        | `-Oz` auto-sets `TEXTDECODER=2`.                                                   |
| `MINIMAL_RUNTIME`      | `SUPPORT_ERRNO`              | MINIMAL_RUNTIME auto-disables errno.                                               |
| `STANDALONE_WASM`      | `WASM_BIGINT`                | STANDALONE skips JS legalization; pair with WASM_BIGINT.                           |
| `OPT_LEVEL >= 2`       | Binaryen optimizer           | Binaryen only runs at `-O2`+. `-O0`/`-O1` skip it entirely.                        |
| `-ffast-math`          | `--fast-math` (wasm-opt)     | emcc maps `-ffast-math` to both LLVM + Binaryen `--fast-math`.                     |
| `--zero-filled-memory` | `SIDE_MODULE`                | Auto-enabled when optimizing, but **not** for side modules.                        |

## Recent Developments (2024–2026)

### 2026

| Change                                                   | Date     | Impact                                                       |
| -------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| Dev build speed guide (emscripten#26455)                 | Mar 2026 | Avoid `-flto` in dev, link at `-O0`, use JSPI over ASYNCIFY. |
| `EXPORT_EXCEPTION_HANDLING_HELPERS` deprecation (#26517) | Mar 2026 | Use `EXPORTED_RUNTIME_METHODS` instead.                      |

### 2025

| Change                                                  | Date         | Impact                                                    |
| ------------------------------------------------------- | ------------ | --------------------------------------------------------- |
| `-ffast-math` → `wasm-opt --fast-math` mapping (#25498) | Oct 2025     | `-Ofast` correctly passes `--fast-math` to wasm-opt.      |
| `-gsource-map` independence (#25238)                    | Sep 2025     | Source maps work with fully optimized release builds.     |
| Binaryen TypeOrdering pass (binaryen#7879)              | Sep 2025     | Orders types to minimize binary encoding size.            |
| Binaryen Precompute rewrite (binaryen#7863)             | Aug 2025     | Better handling of effects; measurable size improvements. |
| Binaryen StringLifting/Lowering (binaryen#7389, #7540)  | Mar–Apr 2025 | Automated string optimization in `-O2`+ pipeline.         |
| Bulk-memory enabled by default (#22873)                 | Jan 2025     | `-mbulk-memory` now default.                              |

### 2024

| Change                                                   | Date     | Impact                                             |
| -------------------------------------------------------- | -------- | -------------------------------------------------- |
| Clang `--no-wasm-opt` flag (llvm#95208)                  | Jun 2024 | Control wasm-opt invocation from Clang.            |
| Nontrapping-fptoint + bulk-memory defaults (llvm#112049) | Oct 2024 | These features now default-on in LLVM WebAssembly. |
| `WASM_BIGINT` defaulted to `true`                        | 2024     | Eliminates i64 legalization overhead by default.   |

## References

- [Emscripten: Optimizing Code](https://emscripten.org/docs/optimizing/Optimizing-Code.html)
- [Emscripten: emcc Reference](https://emscripten.org/docs/tools_reference/emcc.html)
- [Emscripten: Settings Reference](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Emscripten: settings.js source](https://github.com/emscripten-core/emscripten/blob/main/src/settings.js)
- [Binaryen GitHub / wasm-opt](https://github.com/WebAssembly/binaryen)
- [Binaryen Optimizer Cookbook](https://github.com/WebAssembly/binaryen/wiki/Optimizer-Cookbook)
- [Binaryen GC Optimization Guidebook](https://github.com/WebAssembly/binaryen/wiki/GC-Optimization-Guidebook)
- [Emscripten: C++ Exceptions](https://emscripten.org/docs/porting/exceptions.html)
- [Emscripten: Building to WebAssembly](https://emscripten.org/docs/compiling/WebAssembly.html)
- Emscripten source: `tools/cmdline.py`, `tools/link.py`, `tools/building.py`, `tools/compile.py`
- Binaryen source: `wasm-opt --help` (version 125)
