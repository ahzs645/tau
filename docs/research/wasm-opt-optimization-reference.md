---
title: 'wasm-opt (Binaryen) Post-Link Optimization Reference'
description: 'Comprehensive reference of all wasm-opt optimization flags, passes, and feature flags for post-link WASM optimization'
status: active
created: '2025-03-24'
updated: '2025-03-24'
category: reference
related:
  - docs/research/ocjs-full-build-audit.md
---

# wasm-opt (Binaryen) Post-Link Optimization Reference

Comprehensive catalog of all wasm-opt (Binaryen) optimization flags, passes, and feature enable flags for post-link WebAssembly optimization. Sourced directly from Binaryen `main` branch source code (v127+).

## Executive Summary

Binaryen's `wasm-opt` is the primary post-link optimizer for WebAssembly. It operates on wasm binary files, applying transformation passes to reduce code size and improve runtime performance. The optimizer uses a two-dimensional system: `optimizeLevel` (0-4, speed focus) and `shrinkLevel` (0-2, size focus). Standard `-O` flags map to combinations of these. Beyond standard levels, performance flags like `--traps-never-happen` and `--fast-math` unlock unsafe-but-effective optimizations. Emscripten invokes wasm-opt automatically at `-O2` and above, passing through a curated set of passes and flags.

## Table of Contents

- [1. Optimization Levels](#1-optimization-levels)
- [2. Performance Flags](#2-performance-flags)
- [3. Optimization Passes Catalog](#3-optimization-passes-catalog)
- [4. Feature Enable/Disable Flags](#4-feature-enabledisable-flags)
- [5. Emscripten Integration](#5-emscripten-integration)
- [6. The Default Optimization Pipeline](#6-the-default-optimization-pipeline)

## 1. Optimization Levels

wasm-opt uses two internal dimensions to control optimization behavior:

- **`optimizeLevel`** (0-4): How much to focus on optimizing code for speed. Higher values enable more aggressive and expensive passes.
- **`shrinkLevel`** (0-2): How much to focus on shrinking code size. Higher values prefer smaller output even at cost to speed.

These are set by the `-O` flags, but can also be set independently via `--optimize-level N` (`-ol`) and `--shrink-level N` (`-s`).

### Level Mapping

| Flag  | optimizeLevel | shrinkLevel | Description                                                                                                                                          |
| ----- | ------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-O0` | 0             | 0           | No optimization passes. Only parses and re-emits.                                                                                                    |
| `-O1` | 1             | 0           | Quick & useful opts, suitable for iteration builds. Minimal pass set.                                                                                |
| `-O2` | 2             | 0           | Most opts, generally gets most perf. Enables StackIR.                                                                                                |
| `-O3` | 3             | 0           | Spends potentially a lot of time optimizing. Enables SSA, merge-locals, code-folding, precompute-propagate, local-cse.                               |
| `-O4` | 4             | 0           | Also flattens the IR (can take a lot more time and memory). Useful on more nested/complex/less-optimized input. Adds flatten + local-cse on flat IR. |
| `-Os` | 2             | 1           | Default optimization passes, focusing on code size. **This is the default `-O` behavior.**                                                           |
| `-Oz` | 2             | 2           | Super-focusing on code size. Enables merge-similar-functions, aggressive inlining, extra DCE passes.                                                 |

### What Each Level Enables (Incremental)

**`-O` / `-Os`** (optimizeLevel=2, shrinkLevel=1) — the **default**:

- StackIR generation and optimization (at `optimizeLevel >= 2` or `shrinkLevel >= 1`)
- `ssa-nomerge` (at `optimizeLevel >= 3` OR `shrinkLevel >= 1`)
- `pick-load-signs` (at `optimizeLevel >= 2` or `shrinkLevel >= 2`)
- `code-pushing` (at `optimizeLevel >= 2` or `shrinkLevel >= 2`)
- `dae-optimizing` (at `optimizeLevel >= 2` or `shrinkLevel >= 1`)
- `inlining-optimizing` (at `optimizeLevel >= 2` or `shrinkLevel >= 2`)
- `rse` (at `optimizeLevel >= 2` or `shrinkLevel >= 1`)
- `code-folding` (at `optimizeLevel >= 3` or `shrinkLevel >= 1`)
- `local-cse` (at `optimizeLevel >= 3` or `shrinkLevel >= 1`)
- `reorder-globals` (at `optimizeLevel >= 2` or `shrinkLevel >= 1`)
- `remove-unused-module-elements` pre-pass (at `optimizeLevel >= 2`)
- `once-reduction` (at `optimizeLevel >= 2`)
- GC passes: `type-refining`, `signature-pruning/refining`, `gto`, `cfp`, etc. (at `optimizeLevel >= 2` with `--closed-world`)

**`-O1`** (optimizeLevel=1, shrinkLevel=0) — runs everything that has no level gate plus:

- The minimum pipeline: `dce`, `remove-unused-names`, `remove-unused-brs`, `optimize-instructions`, `precompute`, `simplify-locals-nostructure`, `vacuum`, `reorder-locals`, `coalesce-locals`, `simplify-locals`, `merge-blocks`, `precompute`, `optimize-instructions`
- No StackIR (requires level 2+)
- No `ssa-nomerge`, no `code-folding`, no `local-cse`, no `merge-locals`

**`-O3`** (optimizeLevel=3, shrinkLevel=0) — adds to `-O2`:

- `ssa-nomerge` (untangle to semi-SSA form)
- `precompute-propagate` instead of plain `precompute` (both early and late)
- `merge-locals` (very slow on large functions like sqlite)
- `code-folding`
- `local-cse`
- `optimize-added-constants-propagate` (with `--low-memory-unused`)
- `cfp-reftest` instead of `cfp` (GC, closed-world, aggressively optimizing for speed)

**`-O4`** (optimizeLevel=4, shrinkLevel=0) — adds to `-O3`:

- `flatten` (flattens nested IR to flat form)
- `simplify-locals-notee-nostructure` (cleanup after flatten)
- `local-cse` (particularly effective after flatten)
- This level can dramatically increase time and memory usage

**`-Oz`** (optimizeLevel=2, shrinkLevel=2) — size-focused additions:

- `merge-similar-functions` (at `shrinkLevel >= 2`)
- `simplify-globals-optimizing` (at `optimizeLevel >= 2` or `shrinkLevel >= 2`)
- `inlining-optimizing` (at `optimizeLevel >= 2` or `shrinkLevel >= 2`)
- `precompute-propagate` (at `shrinkLevel >= 2`)
- `code-pushing` (at `shrinkLevel >= 2`)
- `pick-load-signs` (at `shrinkLevel >= 2`)
- `merge-locals` (at `shrinkLevel >= 2`)

### StackIR

StackIR is a secondary IR representation optimized for the wasm stack machine. It is generated and optimized during binary writing when `optimizeLevel >= 2` or `shrinkLevel >= 1`. It provides additional size reductions beyond what Binaryen IR passes alone achieve. Can be disabled with `--no-stack-ir` (Emscripten does this when further binaryen tools will run after the main pass, since they would undo StackIR optimizations).

## 2. Performance Flags

### `--traps-never-happen` (`-tnh`)

**What it does**: Assumes that no trap instruction is ever reached at runtime. This includes traps from `unreachable`, division by zero, out-of-bounds memory access, null dereferences, and failed casts.

**Optimizations enabled**:

- Can **remove** code that would lead to a trap (since the trap would never be reached anyway)
- Can remove stores/operations preceding an `unreachable` (since if the store executes, the unreachable would be reached, contradicting the assumption)
- GUFA can use it to reason "backwards" — if a cast would trap, the value must have been the right type
- **Does NOT** move trapping code to execute unconditionally (unlike `--ignore-implicit-traps`). It removes traps rather than ignoring their side effects
- Cannot remove calls to imports (assumes imports may do things we can't understand)

**Category**: SPEED + SIZE (removes dead code)

**Safety**: Safe on production code where traps are either fatal errors or assertions that are assumed not to occur. **Undefined behavior if a trap actually occurs at runtime.** Equivalent to C/C++ UB assumptions.

**In standard `-O` levels**: No — must be explicitly passed.

**Supersedes**: `--ignore-implicit-traps` (`-iit`), which is deprecated. The key difference: `--ignore-implicit-traps` ignores the side effect of trapping (may move trapping code to execute unconditionally), while `--traps-never-happen` removes trapping paths entirely but does not reorder them.

### `--fast-math` (`-ffm`)

**What it does**: Optimizes floating-point operations without handling corner cases of NaNs and rounding. Inspired by GCC/Clang's `-ffast-math`.

**Assumptions**:

- NaN values do not need to be preserved or handled correctly
- Algebraic rules for associativity, commutativity, etc. can be applied to floats (IEEE 754 does not guarantee these)
- Rounding behavior differences are acceptable

**Optimizations enabled**:

- Algebraic simplification of float expressions (e.g., `x * 1.0 → x`, `x + 0.0 → x`)
- Reordering of float operations
- Constant folding that ignores NaN propagation rules

**Category**: SPEED (primarily)

**Safety**: **Unsafe** for code that depends on IEEE 754 compliance, NaN propagation, or specific rounding behavior. Do NOT use for financial calculations, scientific computing, or any code that tests for NaN.

**In standard `-O` levels**: No — must be explicitly passed.

### `--closed-world` (`-cw`)

**What it does**: Assumes code outside the module does not inspect or interact with GC and function references. The outside may hold references and pass them back in, but may not inspect their contents, call them, or reflect on their types.

**Optimizations enabled** (all GC-related, require `optimizeLevel >= 2`):

- `type-refining` — apply more specific subtypes to type fields
- `signature-pruning` — remove unused params from function signature types
- `signature-refining` — apply more specific subtypes to signatures
- `gto` (global type optimization) — remove fields, refine GC types
- `cfp` / `cfp-reftest` — constant field propagation on structs
- `abstract-type-refining` — refine and merge abstract types
- `unsubtyping` — remove unnecessary subtyping relationships
- `remove-unused-types` — remove unused private GC types

**Category**: SIZE + SPEED (enables aggressive type system optimization)

**When useful**: Primarily for WASM GC applications (Dart, Kotlin, Java compiled to wasm). For **linear memory** programs (C/C++/Rust via Emscripten), this flag has **no effect** since those don't use GC types.

**Safety**: Safe as long as the host environment doesn't reflect on, inspect fields of, or directly call exported GC references. Standard JS host code that receives opaque references is fine.

**In standard `-O` levels**: No — must be explicitly passed.

### `--converge` (`-c`)

**What it does**: Runs the entire pass pipeline repeatedly to convergence, continuing while binary size decreases. After each complete pipeline run, measures binary size; if it didn't shrink, stops.

**How it works**: After the initial optimization pass, the binary is serialized and its size is measured. The passes are run again. If the resulting binary is not smaller, iteration stops. Otherwise, continues until convergence.

**Category**: SIZE (iterates for maximum reduction)

**Safety**: Completely safe — just runs the same passes multiple times.

**Use case**: When maximum code size reduction is needed and compile time is not a concern. Particularly useful when passes like `directize` and `inlining` create cascading optimization opportunities.

**In standard `-O` levels**: No — must be explicitly passed.

### `--low-memory-unused` (`-lmu`)

**What it does**: Assumes the low 1KB (1024 bytes) of linear memory is not used by the application. This allows optimizing load/store offsets.

**Optimizations enabled**:

- `optimize-added-constants` / `optimize-added-constants-propagate` — can fold base addresses into load/store offsets when the result would be in the low 1K range (which is provably unused)

**Category**: SIZE + SPEED (reduces instruction count for memory operations)

**Safety**: Safe when `GLOBAL_BASE >= 1024` (which is typical — Emscripten defaults to 1024 or higher). **Unsafe** if the application uses memory addresses 0-1023.

**In standard `-O` levels**: No — but Emscripten passes it automatically when `GLOBAL_BASE >= 1024` and `STACK_FIRST` is false.

### `--zero-filled-memory` (`-uim`)

**What it does**: Assumes imported memory is zero-initialized. Without this, the optimizer cannot optimize memory segments because prior modifications may exist.

**Optimizations enabled**:

- Can remove zero bytes from data segments (since memory is already zero)
- Better `memory-packing` results

**Category**: SIZE

**Safety**: Safe for most use cases (memory is typically zero-initialized). **Unsafe** only for dynamic linking side modules where memory may have been previously used.

**In standard `-O` levels**: No — but Emscripten passes it automatically for non-side-modules in optimized builds.

### `--ignore-implicit-traps` (`-iit`) [DEPRECATED]

**What it does**: Optimizes under the assumption that no surprising traps occur from loads, divs, etc. Simply ignores the side effect of trapping when computing side effects.

**Danger**: May move trapping code to execute unconditionally. For example, `if (condition) { code_that_traps }` → `code_that_traps; if (condition) { ... }`.

**Status**: Deprecated in favor of `--traps-never-happen`, which is safer.

## 3. Optimization Passes Catalog

### Core Optimization Passes

#### Dead Code and Cleanup

| Pass                                        | Description                                                             | Category   | In default -O                  |
| ------------------------------------------- | ----------------------------------------------------------------------- | ---------- | ------------------------------ |
| `dce`                                       | Removes unreachable code                                                | SIZE+SPEED | Yes (all levels)               |
| `vacuum`                                    | Removes obviously unneeded code (nops, empty blocks, unreachable tails) | SIZE       | Yes (all levels, run 3-4×)     |
| `remove-unused-names`                       | Removes names from locations never branched to                          | SIZE       | Yes (all levels)               |
| `remove-unused-brs`                         | Removes breaks from locations that are not needed                       | SIZE+SPEED | Yes (all levels, run 3×)       |
| `remove-unused-module-elements`             | Removes unused functions, globals, tags, tables, memories               | SIZE       | Yes (≥O2 pre-pass + post-pass) |
| `remove-unused-nonfunction-module-elements` | Like above but preserves functions                                      | SIZE       | No                             |
| `remove-unused-types`                       | Removes unused private GC types                                         | SIZE       | Yes (≥O2, closed-world only)   |

#### Instruction-Level Optimization

| Pass                                 | Description                                                                 | Category   | In default -O                           |
| ------------------------------------ | --------------------------------------------------------------------------- | ---------- | --------------------------------------- |
| `optimize-instructions`              | Optimizes instruction combinations (peephole). Core workhorse pass.         | SIZE+SPEED | Yes (all levels, run 2×)                |
| `precompute`                         | Computes compile-time evaluatable expressions (constant folding)            | SIZE+SPEED | Yes (O1-O2)                             |
| `precompute-propagate`               | Like precompute but also propagates constants through locals                | SIZE+SPEED | Yes (O3+, Oz)                           |
| `optimize-added-constants`           | Folds added constants into load/store offsets                               | SIZE+SPEED | Yes (with `--low-memory-unused`, O1-O2) |
| `optimize-added-constants-propagate` | Like above but also propagates across locals                                | SIZE+SPEED | Yes (with `--low-memory-unused`, O3+)   |
| `pick-load-signs`                    | Picks load signs (signed vs unsigned) based on how the loaded value is used | SIZE       | Yes (≥O2 or shrink≥2)                   |

#### Local Variable Optimization

| Pass                                | Description                                                                                      | Category   | In default -O                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------- |
| `simplify-locals`                   | Miscellaneous locals-related optimizations (tee insertion, structure creation, copy propagation) | SIZE+SPEED | Yes (all levels)                             |
| `simplify-locals-nostructure`       | Like simplify-locals but doesn't create if/block return values                                   | SIZE+SPEED | Yes (all levels)                             |
| `simplify-locals-nonesting`         | Like simplify-locals but preserves flatness (no nesting)                                         | SIZE       | No (manual use after flatten)                |
| `simplify-locals-notee`             | Like simplify-locals but no tee insertion                                                        | SIZE+SPEED | No                                           |
| `simplify-locals-notee-nostructure` | No tees or structure creation                                                                    | SIZE       | Yes (O4 only, after flatten)                 |
| `simplify-locals-nostructure`       | No structure creation                                                                            | SIZE+SPEED | Yes (all levels)                             |
| `coalesce-locals`                   | Reduces number of locals by coalescing (register allocation)                                     | SIZE+SPEED | Yes (all levels, run 2×)                     |
| `coalesce-locals-learning`          | Like coalesce-locals but uses a learning algorithm                                               | SIZE+SPEED | No (not in default pipeline)                 |
| `reorder-locals`                    | Sorts locals by access frequency (most-used get smaller indices → smaller LEB128 encoding)       | SIZE       | Yes (all levels, run 3×)                     |
| `merge-locals`                      | Merges locals when beneficial (very slow on large functions)                                     | SIZE       | Yes (≥O3 or shrink≥2)                        |
| `local-cse`                         | Common subexpression elimination inside basic blocks                                             | SIZE+SPEED | Yes (≥O3 or shrink≥1; also O4 after flatten) |
| `local-subtyping`                   | Applies more specific subtypes to locals where possible (GC)                                     | SIZE       | Yes (optimizeLevel>1, GC)                    |
| `untee`                             | Removes local.tees, replacing with sets and gets                                                 | OTHER      | No (utility pass)                            |

#### SSA and Control Flow

| Pass           | Description                                                                               | Category | In default -O                |
| -------------- | ----------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| `ssa`          | SSA-ify variables (single assignment)                                                     | OTHER    | No                           |
| `ssa-nomerge`  | SSA-ify but ignoring merges (avoids introducing copies)                                   | SPEED    | Yes (≥O3 or shrink≥1)        |
| `flatten`      | Flattens out code, removing nesting. Makes all expressions simple (no nested calls, etc.) | OTHER    | Yes (O4 only)                |
| `rse`          | Redundant set elimination — removes local.sets that write a value the local already holds | SIZE     | Yes (≥O2 or shrink≥1)        |
| `merge-blocks` | Merges blocks into their parents when possible                                            | SIZE     | Yes (all levels, run 2×)     |
| `code-folding` | Folds code by merging duplicate tails of if-else arms and blocks                          | SIZE     | Yes (≥O3 or shrink≥1)        |
| `code-pushing` | Pushes code forward into conditional branches, potentially making it not always execute   | SPEED    | Yes (≥O2 or shrink≥2)        |
| `rereloop`     | Re-optimizes control flow using the Relooper algorithm                                    | SPEED    | No (experimental)            |
| `licm`         | Loop invariant code motion                                                                | SPEED    | No (not in default pipeline) |

#### Function-Level Optimization

| Pass                             | Description                                                                                        | Category   | In default -O                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------ |
| `inlining`                       | Inline functions (raw — use inlining-optimizing instead)                                           | SIZE+SPEED | No (use inlining-optimizing)   |
| `inlining-optimizing`            | Inline functions and optimize at inline sites                                                      | SIZE+SPEED | Yes (≥O2 or shrink≥2)          |
| `dae`                            | Dead argument elimination — removes unused function parameters in an LTO-like manner               | SIZE       | No (use dae-optimizing)        |
| `dae-optimizing`                 | DAE plus optimizes where arguments were removed                                                    | SIZE+SPEED | Yes (≥O2 or shrink≥1)          |
| `dae2`                           | Experimental reimplementation of DAE                                                               | SIZE       | No (experimental)              |
| `directize`                      | Turns indirect calls (`call_indirect`) into direct calls where the table entry is known            | SPEED      | Yes (all levels, in post-pass) |
| `duplicate-function-elimination` | Removes duplicate functions (by content hash)                                                      | SIZE       | Yes (all levels, pre+post)     |
| `duplicate-import-elimination`   | Removes duplicate imports                                                                          | SIZE       | Yes (all levels, post-pass)    |
| `once-reduction`                 | Reduces calls to code that only runs once (e.g., init-once patterns)                               | SIZE+SPEED | Yes (≥O2)                      |
| `extract-function`               | Leaves just one function — utility for debugging                                                   | OTHER      | No                             |
| `extract-function-index`         | Leaves one function selected by index                                                              | OTHER      | No                             |
| `merge-similar-functions`        | Merges functions with similar bodies into shared implementations                                   | SIZE       | Yes (shrink≥2 only)            |
| `monomorphize`                   | Creates specialized versions of functions                                                          | SPEED      | No                             |
| `monomorphize-always`            | Creates specialized versions (even if unhelpful)                                                   | OTHER      | No                             |
| `no-inline`                      | Mark functions as no-inline                                                                        | OTHER      | No                             |
| `no-full-inline`                 | Mark functions as no-inline (full inlining only)                                                   | OTHER      | No                             |
| `no-partial-inline`              | Mark functions as no-inline (partial inlining only)                                                | OTHER      | No                             |
| `inline-main`                    | Inline `__original_main` into `main`                                                               | SIZE       | No                             |
| `outlining`                      | Outline repeated instruction sequences into functions (not available in Emscripten-built Binaryen) | SIZE       | No                             |

#### Inlining Configuration

Inlining behavior can be tuned with these flags (not passes):

| Flag                                    | Short     | Default  | Description                                             |
| --------------------------------------- | --------- | -------- | ------------------------------------------------------- |
| `--always-inline-max-function-size`     | `-aimfs`  | 2        | Max size of functions that are always inlined           |
| `--flexible-inline-max-function-size`   | `-fimfs`  | 20       | Max size for lightweight functions inlined at -O3       |
| `--one-caller-inline-max-function-size` | `-ocimfs` | -1 (all) | Max size for single-caller inlining                     |
| `--inline-max-combined-binary-size`     | `-imcbs`  | 400K     | Absolute limit on combined function size after inlining |
| `--inline-functions-with-loops`         | `-ifwl`   | false    | Allow inlining functions containing loops               |
| `--partial-inlining-ifs`                | `-pii`    | 0        | Number of ifs to allow partial inlining (0 = disabled)  |

#### Global Optimization

| Pass                          | Description                                                                     | Category   | In default -O                       |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| `simplify-globals`            | Miscellaneous globals-related optimizations                                     | SIZE       | Yes (O1, in post-pass)              |
| `simplify-globals-optimizing` | Like above plus optimizes where global.gets were replaced with constants        | SIZE+SPEED | Yes (≥O2 or shrink≥2, in post-pass) |
| `memory-packing`              | Packs memory into separate segments, skipping zeros                             | SIZE       | Yes (all levels, pre-pass)          |
| `reorder-functions`           | Sorts functions by access frequency (more-called functions get smaller indices) | SIZE       | No (not in default, but useful)     |
| `reorder-globals`             | Sorts globals by access frequency                                               | SIZE       | Yes (≥O2 or shrink≥1)               |
| `reorder-types`               | Sorts private types by access frequency                                         | SIZE       | No                                  |
| `propagate-globals-globally`  | Propagate global values to other globals                                        | OTHER      | No (test utility)                   |

#### GC-Specific Passes (require `--closed-world` and GC features)

| Pass                      | Description                                                                                      | Category   | In default -O                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------- |
| `cfp`                     | Constant field propagation — propagates constant struct field values                             | SIZE+SPEED | Yes (≥O2, closed-world)                 |
| `cfp-reftest`             | Like cfp but using ref.test                                                                      | SPEED      | Yes (≥O3, closed-world)                 |
| `gto`                     | Global type optimization — optimizes GC types                                                    | SIZE+SPEED | Yes (≥O2, closed-world)                 |
| `gsi`                     | Global struct inference — globally optimizes struct values                                       | SIZE+SPEED | Yes (≥O2)                               |
| `gsi-desc-cast`           | Like gsi but emits ref.cast_desc_eq                                                              | SPEED      | No                                      |
| `global-refining`         | Refines the types of globals                                                                     | SIZE       | Yes (≥O2, GC)                           |
| `gufa`                    | Grand Unified Flow Analysis — whole-program analysis tracking possible contents at each location | SIZE+SPEED | No (expensive, not in default pipeline) |
| `gufa-cast-all`           | GUFA plus adds casts for all inferences                                                          | SPEED      | No                                      |
| `gufa-optimizing`         | GUFA plus local optimizations in modified functions                                              | SIZE+SPEED | No                                      |
| `type-refining`           | Apply more specific subtypes to type fields                                                      | SIZE       | Yes (≥O2, closed-world)                 |
| `type-refining-gufa`      | Type refining using GUFA data                                                                    | SIZE       | No                                      |
| `signature-pruning`       | Remove unused params from function signature types                                               | SIZE       | Yes (≥O2, closed-world)                 |
| `signature-refining`      | Apply more specific subtypes to signatures                                                       | SIZE       | Yes (≥O2, closed-world)                 |
| `abstract-type-refining`  | Refine and merge abstract (never-created) types                                                  | SIZE       | Yes (≥O2, closed-world)                 |
| `unsubtyping`             | Remove unnecessary subtyping relationships                                                       | SIZE       | Yes (≥O2, closed-world)                 |
| `type-merging`            | Merge types to their supertypes where possible                                                   | SIZE       | No                                      |
| `type-ssa`                | Create new types to help other optimizations                                                     | SPEED      | No                                      |
| `type-finalizing`         | Mark all leaf types as final                                                                     | SIZE       | No                                      |
| `type-unfinalizing`       | Mark all types as non-final (open)                                                               | OTHER      | No                                      |
| `minimize-rec-groups`     | Split types into minimal recursion groups                                                        | SIZE       | No                                      |
| `heap2local`              | Replace GC allocations with locals (escape analysis)                                             | SPEED      | Yes (optimizeLevel>1, GC)               |
| `heap-store-optimization` | Optimize heap (GC) stores                                                                        | SIZE+SPEED | Yes (all levels, GC)                    |
| `optimize-casts`          | Eliminate and reuse casts                                                                        | SIZE+SPEED | Yes (optimizeLevel>1, GC)               |
| `tuple-optimization`      | Optimize trivial tuples away                                                                     | SIZE       | Yes (when multivalue enabled)           |
| `string-gathering`        | Gather wasm strings to globals                                                                   | SIZE       | Yes (≥O2, strings)                      |
| `string-lifting`          | Lift string imports to wasm strings                                                              | OTHER      | No                                      |
| `string-lowering`         | Lower wasm strings to imports                                                                    | OTHER      | No                                      |

### Emscripten-Specific Passes

| Pass                              | Description                                                                   | Category    |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| `post-emscripten`                 | Miscellaneous optimizations for Emscripten-generated code (sbrk fixups, etc.) | SIZE+SPEED  |
| `optimize-for-js`                 | Early optimization of instruction combinations targeting JS execution         | SPEED       |
| `legalize-js-interface`           | Legalizes i64 types on the import/export boundary for JS                      | COMPAT      |
| `legalize-and-prune-js-interface` | Legalizes and prunes the import/export boundary                               | COMPAT+SIZE |
| `generate-dyncalls`               | Generate dynCall functions for Emscripten ABI                                 | COMPAT      |
| `generate-i64-dyncalls`           | Generate dynCall functions for i64 signatures (pre-BigInt)                    | COMPAT      |
| `fpcast-emu`                      | Emulates function pointer casts for incorrect indirect calls                  | COMPAT      |
| `asyncify`                        | Async/await transform, allowing pausing and resuming                          | COMPAT      |
| `safe-heap`                       | Instrument loads/stores to check for invalid behavior                         | DEBUG       |
| `remove-non-js-ops`               | Remove operations incompatible with JS                                        | COMPAT      |

### Strip and Debug Passes

| Pass                          | Description                                               | Category | In default -O                             |
| ----------------------------- | --------------------------------------------------------- | -------- | ----------------------------------------- |
| `strip-debug`                 | Strip debug info including names section                  | SIZE     | No (explicit)                             |
| `strip-dwarf`                 | Strip only DWARF debug info                               | SIZE     | No                                        |
| `strip-producers`             | Strip the wasm producers section                          | SIZE     | No                                        |
| `strip-target-features`       | Strip the wasm target features section                    | SIZE     | Yes (Emscripten adds in optimized builds) |
| `strip-eh`                    | Strip EH instructions                                     | SIZE     | No                                        |
| `strip-toolchain-annotations` | Strip all toolchain-specific code annotations             | SIZE     | No                                        |
| `roundtrip`                   | Write module to binary, then read it back (normalization) | OTHER    | No                                        |

### Instrumentation and Debugging Passes

| Pass                               | Description                                                 | Category |
| ---------------------------------- | ----------------------------------------------------------- | -------- |
| `log-execution`                    | Instrument with logging of execution flow                   | DEBUG    |
| `instrument-locals`                | Intercept all local loads and stores                        | DEBUG    |
| `instrument-memory`                | Intercept all memory loads and stores                       | DEBUG    |
| `instrument-branch-hints`          | Instrument branch hints for profiling                       | DEBUG    |
| `trace-calls`                      | Intercept specific function calls                           | DEBUG    |
| `func-metrics`                     | Report function metrics                                     | DEBUG    |
| `metrics`                          | Report module metrics (with optional title)                 | DEBUG    |
| `print`                            | Print in s-expression format                                | DEBUG    |
| `print-full`                       | Print in full s-expression format                           | DEBUG    |
| `print-minified`                   | Print in minified s-expression format                       | DEBUG    |
| `print-call-graph`                 | Print call graph                                            | DEBUG    |
| `print-function-map` / `symbolmap` | Print map of function indexes to names                      | DEBUG    |
| `print-features`                   | Print enabled features                                      | DEBUG    |
| `nm`                               | Name list                                                   | DEBUG    |
| `name-types`                       | (Re)name all heap types                                     | DEBUG    |
| `dwarfdump`                        | Dump DWARF debug info sections                              | DEBUG    |
| `propagate-debug-locs`             | Propagate debug locations from parents/siblings to children | DEBUG    |

### Lowering Passes

| Pass                                       | Description                                          | Category |
| ------------------------------------------ | ---------------------------------------------------- | -------- |
| `alignment-lowering`                       | Lower unaligned loads/stores to smaller aligned ones | COMPAT   |
| `signext-lowering`                         | Lower sign-ext operations to wasm MVP                | COMPAT   |
| `llvm-nontrapping-fptoint-lowering`        | Lower nontrapping float-to-int to MVP                | COMPAT   |
| `llvm-memory-copy-fill-lowering`           | Lower memory.copy/fill to MVP                        | COMPAT   |
| `memory64-lowering` / `table64-lowering`   | Lower 64-bit memory/table to 32-bit                  | COMPAT   |
| `multi-memory-lowering`                    | Combine multiple memories into one                   | COMPAT   |
| `multi-memory-lowering-with-bounds-checks` | Like above with bounds checking                      | COMPAT   |
| `i64-to-i32-lowering`                      | Lower i64 to pairs of i32s                           | COMPAT   |
| `trap-mode-clamp`                          | Replace trapping operations with clamping            | COMPAT   |
| `trap-mode-js`                             | Replace trapping operations with JS semantics        | COMPAT   |
| `remove-relaxed-simd`                      | Replace relaxed SIMD with unreachable                | COMPAT   |
| `translate-to-exnref`                      | Translate Phase 3 EH to new exnref instructions      | COMPAT   |
| `poppify`                                  | Transform Binaryen IR into Poppy IR                  | OTHER    |
| `enclose-world`                            | Modify wasm (destructively) for closed-world         | OTHER    |

### Miscellaneous Passes

| Pass                                     | Description                                       | Category |
| ---------------------------------------- | ------------------------------------------------- | -------- |
| `avoid-reinterprets`                     | Replace reinterpret operations with loads         | SPEED    |
| `const-hoisting`                         | Hoist repeated constants to a local               | SIZE     |
| `denan`                                  | Convert NaNs into 0 at runtime (instrumentation)  | COMPAT   |
| `dealign`                                | Force all loads/stores to alignment 1             | OTHER    |
| `discard-global-effects`                 | Discard computed global effect info               | OTHER    |
| `generate-global-effects`                | Generate global effect info for later passes      | OTHER    |
| `set-globals`                            | Set specified globals to specified values         | OTHER    |
| `separate-data-segments`                 | Write data segments to file and strip from module | SIZE     |
| `limit-segments`                         | Merge segments to fit within web limits           | COMPAT   |
| `stack-check`                            | Enforce limits on LLVM's `__stack_pointer` global | COMPAT   |
| `spill-pointers`                         | Spill pointers to C stack (Boehm GC support)      | COMPAT   |
| `stub-unsupported-js`                    | Stub out unsupported JS operations                | COMPAT   |
| `dfo`                                    | DataFlow SSA IR optimizations                     | SPEED    |
| `souperify` / `souperify-single-use`     | Emit Souper IR in text form                       | OTHER    |
| `minify-imports`                         | Minify import names                               | SIZE     |
| `minify-imports-and-exports`             | Minify both import and export names               | SIZE     |
| `minify-imports-and-exports-and-modules` | Minify names and module names                     | SIZE     |
| `remove-imports`                         | Remove imports, replace with nops                 | OTHER    |
| `remove-memory-init` / `remove-memory`   | Remove memory initialization                      | SIZE     |
| `reorder-functions-by-name`              | Sort functions by name (debugging)                | OTHER    |
| `optimize-stack-ir`                      | Optimize StackIR during binary writing            | SIZE     |
| `J2CL-specific: optimize-j2cl`           | Optimize J2CL constructs                          | SPEED    |
| `J2CL-specific: merge-j2cl-itables`      | Merge itable structures into vtables              | SIZE     |

## 4. Feature Enable/Disable Flags

Each feature can be enabled with `--enable-<name>` or disabled with `--disable-<name>`. Shorthand: `--all-features` (`-all`) enables all, `--mvp-features` (`-mvp`) disables all non-MVP features.

| Flag                                | Feature                | Description                                                                       |
| ----------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `--enable-sign-ext`                 | sign-ext               | Sign extension operations (`i32.extend8_s`, etc.) **[Default ON]**                |
| `--enable-mutable-globals`          | mutable-globals        | Mutable global imports/exports **[Default ON]**                                   |
| `--enable-nontrapping-float-to-int` | truncsat               | Non-trapping float-to-int operations (`i32.trunc_sat_f32_s`, etc.)                |
| `--enable-simd`                     | simd                   | 128-bit SIMD operations and types                                                 |
| `--enable-bulk-memory`              | bulk-memory            | Bulk memory operations (`memory.copy`, `memory.fill`, `memory.init`, `data.drop`) |
| `--enable-bulk-memory-opt`          | bulk-memory-opt        | Just `memory.copy` and `memory.fill` (subset of bulk-memory)                      |
| `--enable-exception-handling`       | exception-handling     | Exception handling (`try`, `catch`, `throw`, `rethrow`)                           |
| `--enable-tail-call`                | tail-call              | Tail call operations (`return_call`, `return_call_indirect`)                      |
| `--enable-reference-types`          | reference-types        | Reference types (`externref`, `funcref`)                                          |
| `--enable-multivalue`               | multivalue             | Functions returning multiple values                                               |
| `--enable-gc`                       | gc                     | Garbage collection types and instructions (`struct`, `array`, `ref.cast`, etc.)   |
| `--enable-memory64`                 | memory64               | 64-bit memory (memory with i64 indices)                                           |
| `--enable-relaxed-simd`             | relaxed-simd           | Relaxed SIMD operations                                                           |
| `--enable-extended-const`           | extended-const         | Extended constant expressions                                                     |
| `--enable-strings`                  | strings                | String reference types and operations                                             |
| `--enable-multimemory`              | multimemory            | Multiple memories                                                                 |
| `--enable-threads`                  | threads                | Atomic operations (shared memory)                                                 |
| `--enable-stack-switching`          | stack-switching        | Stack switching                                                                   |
| `--enable-shared-everything`        | shared-everything      | Shared-everything threads                                                         |
| `--enable-fp16`                     | fp16                   | Float 16 operations                                                               |
| `--enable-custom-descriptors`       | custom-descriptors     | Custom descriptors (RTTs) and exact references                                    |
| `--enable-relaxed-atomics`          | relaxed-atomics        | Acquire/release atomic operations                                                 |
| `--enable-custom-page-sizes`        | custom-page-sizes      | Custom page sizes                                                                 |
| `--enable-multibyte`                | multibyte              | Multibyte array loads and stores                                                  |
| `--enable-call-indirect-overlong`   | call-indirect-overlong | LEB encoding of call-indirect (no-op, compatibility only)                         |

**Default features** (enabled without any flags): `sign-ext`, `mutable-globals`.

**Important**: These flags control what wasm features Binaryen recognizes in the input/output. They do NOT add new instructions — they tell the optimizer which instructions are valid.

## 5. Emscripten Integration

### When wasm-opt Runs

Emscripten runs wasm-opt as a post-link step. The `should_run_binaryen_optimizer()` function in `tools/link.py` gates this:

```python
def should_run_binaryen_optimizer():
    # run the binaryen optimizer in -O2+. in -O0 we don't need it obviously,
    # while in -O1 we don't run it as the LLVM optimizer has been run, and
    # it does the great majority of the work; not running the binaryen
    # optimizer in that case keeps -O1 mostly-optimized while compiling
    # quickly and without rewriting DWARF etc.
    return settings.OPT_LEVEL >= 2
```

At `-O0` and `-O1`, Emscripten does **not** run wasm-opt optimization passes (though it may still run wasm-opt for lowering passes like asyncify, safe-heap, etc.).

### Emscripten's -O to wasm-opt Mapping

Emscripten translates its own `-O` flags to wasm-opt flags via `opt_level_to_str()`:

| Emscripten flag | wasm-opt flag | optimizeLevel | shrinkLevel |
| --------------- | ------------- | ------------- | ----------- |
| `-O0`           | `-O0`         | 0             | 0           |
| `-O1`           | _not run_     | —             | —           |
| `-O2`           | `-O2`         | 2             | 0           |
| `-O3`           | `-O3`         | 3             | 0           |
| `-Os`           | `-Os`         | 2             | 1           |
| `-Oz`           | `-Oz`         | 2             | 2           |

Note: Emscripten caps at `-O3` for wasm-opt (i.e., `min(opt_level, 3)`). To use `-O4` you must invoke wasm-opt manually.

### Full Emscripten wasm-opt Invocation

When Emscripten runs wasm-opt at `-O2`+, the pass list is constructed by `get_binaryen_passes()`. The typical invocation for an `-O2` build looks like:

```
wasm-opt input.wasm \
  --strip-target-features \
  --post-emscripten \
  -O2 \
  --low-memory-unused \
  --zero-filled-memory \
  --pass-arg=directize-initial-contents-immutable \
  --detect-features \
  -o output.wasm
```

Additional flags Emscripten conditionally adds:

| Condition                             | Flags added                                       |
| ------------------------------------- | ------------------------------------------------- |
| `SAFE_HEAP`                           | `--safe-heap` (before post-emscripten)            |
| `EMULATE_FUNCTION_POINTER_CASTS`      | `--fpcast-emu` (before -Ox)                       |
| `ASYNCIFY == 1`                       | `--asyncify` + various `--pass-arg` configs       |
| `MEMORY64 == 2`                       | `--memory64-lowering --table64-lowering`          |
| `BINARYEN_IGNORE_IMPLICIT_TRAPS`      | `--ignore-implicit-traps`                         |
| `GLOBAL_BASE >= 1024 && !STACK_FIRST` | `--low-memory-unused`                             |
| `!SIDE_MODULE`                        | `--zero-filled-memory`                            |
| Optimizing                            | `--pass-arg=directize-initial-contents-immutable` |
| `BINARYEN_EXTRA_PASSES`               | User-specified comma-separated passes             |
| Will run metadce afterwards           | `--no-stack-ir`                                   |
| `-ffm` / `fast_math`                  | `--fast-math`                                     |

### Emscripten's Final Binaryen Invocation

After metadce and minification, the last binaryen tool run gets:

```python
def get_last_binaryen_opts():
    return [f'--optimize-level={settings.OPT_LEVEL}',
            f'--shrink-level={settings.SHRINK_LEVEL}',
            '--optimize-stack-ir']
```

This ensures StackIR optimization happens in the very last pass (since intermediate tools would undo it).

## 6. The Default Optimization Pipeline

When you run `wasm-opt -Os` (or any `-O` flag), the passes execute in this order. This is the actual pipeline from `PassRunner::addDefaultOptimizationPasses()`:

### Phase 1: Global Pre-Passes (`addDefaultGlobalOptimizationPrePasses`)

1. `duplicate-function-elimination` — fast dedup
2. `remove-unused-module-elements` (≥O2) — global DCE
3. `memory-packing` — compact data segments
4. `once-reduction` (≥O2) — reduce init-once patterns
5. _GC passes_ (≥O2, if GC features present and closed-world):
   - `type-refining` → `signature-pruning` → `signature-refining`
   - `global-refining`
   - `gto` → `remove-unused-module-elements`
   - `cfp` (or `cfp-reftest` at O3) → `gsi`
   - `abstract-type-refining` → `unsubtyping`

### Phase 2: Function Optimization Passes (`addDefaultFunctionOptimizationPasses`)

1. `ssa-nomerge` (≥O3 or shrink≥1)
2. **O4 only**: `flatten` → `simplify-locals-notee-nostructure` → `local-cse`
3. `dce`
4. `remove-unused-names` → `remove-unused-brs` → `remove-unused-names`
5. `optimize-instructions`
6. `heap-store-optimization` (if GC)
7. `pick-load-signs` (≥O2 or shrink≥2)
8. `precompute-propagate` (≥O3 or shrink≥2) OR `precompute`
9. `optimize-added-constants[-propagate]` (if `lowMemoryUnused`)
10. `code-pushing` (≥O2 or shrink≥2)
11. `tuple-optimization` (if multivalue)
12. `simplify-locals-nostructure` → `vacuum` → `reorder-locals`
13. `remove-unused-brs`
14. `heap2local` (optimizeLevel>1, GC)
15. `merge-locals` (≥O3 or shrink≥2)
16. `optimize-casts` (optimizeLevel>1, GC) → `local-subtyping` (GC)
17. `coalesce-locals`
18. `local-cse` (≥O3 or shrink≥1)
19. `simplify-locals` → `vacuum` → `reorder-locals`
20. `coalesce-locals` → `reorder-locals` → `vacuum`
21. `code-folding` (≥O3 or shrink≥1)
22. `merge-blocks` → `remove-unused-brs` → `remove-unused-names` → `merge-blocks`
23. `precompute-propagate` (≥O3 or shrink≥2) OR `precompute` (late propagation)
24. `optimize-instructions`
25. `heap-store-optimization` (if GC)
26. `rse` (≥O2 or shrink≥1)
27. `vacuum`

### Phase 3: Global Post-Passes (`addDefaultGlobalOptimizationPostPasses`)

1. `dae-optimizing` (≥O2 or shrink≥1)
2. `inlining-optimizing` (≥O2 or shrink≥2)
3. `duplicate-function-elimination`
4. `duplicate-import-elimination`
5. `merge-similar-functions` (shrink≥2 only)
6. `simplify-globals-optimizing` (≥O2 or shrink≥2) OR `simplify-globals`
7. `remove-unused-module-elements`
8. `string-gathering` (≥O2, if strings)
9. `reorder-globals` (≥O2 or shrink≥1)
10. `directize`

### Pipeline Notes

- The entire pipeline (Phase 1→2→3) is what a single `-O` invocation runs
- With `--converge` (`-c`), this entire pipeline repeats until binary size stabilizes
- DWARF-sensitive passes are skipped when debug info must be preserved
- Nested pass runners (inside function-parallel passes) cap optimize/shrink levels at 1

## References

- [Binaryen source: `src/passes/pass.cpp`](https://github.com/WebAssembly/binaryen/blob/main/src/passes/pass.cpp) — pass registration and default pipeline
- [Binaryen source: `src/pass.h`](https://github.com/WebAssembly/binaryen/blob/main/src/pass.h) — PassOptions definition
- [Binaryen source: `src/tools/optimization-options.h`](https://github.com/WebAssembly/binaryen/blob/main/src/tools/optimization-options.h) — CLI flag definitions
- [Binaryen source: `src/wasm-features.h`](https://github.com/WebAssembly/binaryen/blob/main/src/wasm-features.h) — feature flag definitions
- [Emscripten source: `tools/link.py`](https://github.com/emscripten-core/emscripten/blob/main/tools/link.py) — `get_binaryen_passes()`
- [Emscripten source: `tools/building.py`](https://github.com/emscripten-core/emscripten/blob/main/tools/building.py) — `opt_level_to_str()`, `run_wasm_opt()`
- [GUFA PR #4598](https://github.com/WebAssembly/binaryen/pull/4598) — Grand Unified Flow Analysis
- [web.dev: Compiling to and optimizing Wasm with Binaryen](https://web.dev/articles/binaryen)
