# Build Flag Audit: opencascade.js

Comprehensive audit of all compile and link flags across the three build stages
of the opencascade.js WASM build system.

**Audit date**: 2026-03-06
**Files audited**:

- `build-wasm.sh` (shell orchestrator, env var defaults, `step_sources_cmake`)
- `src/Common.py` (shared flag definitions: `WASM_EXCEPTION_FLAGS`, `EXTRA_COMPILE_FLAGS`, `buildPch`, `buildFlatIncludes`)
- `src/compileBindings.py` (Stage 2 binding compilation)
- `src/compileSources.py` (legacy Stage 1 Python source compilation)
- `src/buildFromYaml.py` (Stage 3 link + wasm-opt)
- `src/customBuildSchema.py` (YAML schema with emccFlags defaults)
- `build-configs/full.yml` (production YAML config — no exceptions)
- `build-configs/full-exceptions.yml` (production YAML config — with exceptions)
- `build-configs/presets/*.yml` (O0-debug, O2-balanced, O3-maxperf, Os-minsize)

---

## Environment Variable Defaults

| Variable              | `build-wasm.sh` default | Python fallback  | Notes                                                 |
| --------------------- | ----------------------- | ---------------- | ----------------------------------------------------- |
| `OCJS_OPT`            | `-O2`                   | `-O0`            | Python fallback only used when scripts run standalone |
| `OCJS_LTO`            | `1` (enabled)           | `"0"` (disabled) | Python fallback only used when scripts run standalone |
| `OCJS_EXCEPTIONS`     | `0` (disabled)          | `"0"` (disabled) | Consistent                                            |
| `OCJS_WASM_OPT_LEVEL` | `-O3`                   | n/a              | Only used in buildFromYaml.py, reads env directly     |
| `OCJS_CLOSURE`        | `false`                 | n/a              | Only used at link time                                |
| `OCJS_EVAL_CTORS`     | `false`                 | n/a              | Only used at link time                                |
| `OCJS_CONVERGE`       | `false`                 | n/a              | Only used in wasm-opt                                 |
| `OCJS_DEFINES`        | `""`                    | `""`             | Consistent                                            |
| `OCJS_UNDEFINES`      | `""`                    | `""`             | Consistent                                            |
| `OCJS_PATCH_DUMP`     | `false`                 | n/a              | Patches Standard_Dump.hxx before compile              |
| `THREADING`           | `single-threaded`       | n/a              | Passed as CLI arg to Python                           |

---

## Flag Matrix

### Compile-Time Flags (Stages 1 & 2)

| Flag                                       | Stage 1: CMake sources                     | Stage 1: Legacy Python    | Stage 2: Bindings         | Stage 2: PCH              | Stage 2: additionalBindCode | Consistent? | Issue                                                                                                        |
| ------------------------------------------ | ------------------------------------------ | ------------------------- | ------------------------- | ------------------------- | --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `-std=c++17`                               | via CMakeLists.txt `CMAKE_CXX_STANDARD 17` | explicit                  | explicit                  | explicit                  | explicit                    | Yes         | CMake sets it indirectly via `CMAKE_CXX_STANDARD`                                                            |
| `-std=c17`                                 | via CMake for .c files                     | explicit for .c files     | n/a                       | n/a                       | n/a                         | Yes         | —                                                                                                            |
| `$OCJS_OPT`                                | yes (`-O2` default)                        | yes (`-O0` fallback)      | yes (`-O0` fallback)      | yes (`-O0` fallback)      | yes (`-O0` fallback)        | **PARTIAL** | Python fallback is `-O0`, shell default is `-O2`. Safe when invoked via `build-wasm.sh` which exports `-O2`. |
| `-flto`                                    | when `OCJS_LTO=1`                          | when `OCJS_LTO=1`         | when `OCJS_LTO=1`         | when `OCJS_LTO=1`         | when `OCJS_LTO=1`           | **PARTIAL** | Python fallback is `"0"` (off), shell default is `1` (on). Safe when invoked via `build-wasm.sh`.            |
| `-fwasm-exceptions`                        | when `OCJS_EXCEPTIONS=1` (CXX only)        | when `OCJS_EXCEPTIONS=1`  | when `OCJS_EXCEPTIONS=1`  | when `OCJS_EXCEPTIONS=1`  | when `OCJS_EXCEPTIONS=1`    | Yes         | See link-stage mismatch below                                                                                |
| `-DIGNORE_NO_ATOMICS=1`                    | yes                                        | yes                       | yes                       | yes                       | yes                         | Yes         | —                                                                                                            |
| `-DOCCT_NO_PLUGINS`                        | yes                                        | yes                       | yes                       | yes                       | yes                         | Yes         | —                                                                                                            |
| `-frtti`                                   | CXX only (correct)                         | CXX only                  | yes                       | yes                       | yes                         | Yes         | —                                                                                                            |
| `-DHAVE_RAPIDJSON`                         | yes                                        | yes                       | yes                       | yes                       | yes                         | Yes         | —                                                                                                            |
| `-w`                                       | **NO**                                     | yes                       | yes                       | yes                       | **NO**                      | **NO**      | CMake sources get warnings; bindings/PCH suppress all. additionalBindCode also gets warnings.                |
| `-pthread`                                 | when multi-threaded                        | when multi-threaded       | when multi-threaded       | when multi-threaded       | when multi-threaded         | Yes         | —                                                                                                            |
| `-include-pch`                             | n/a (CMake manages)                        | n/a                       | when PCH exists           | n/a (is the PCH)          | when PCH exists             | Yes         | —                                                                                                            |
| `-I` flat includes                         | n/a (CMake manages)                        | yes                       | yes                       | yes                       | yes                         | Yes         | —                                                                                                            |
| `EXTRA_COMPILE_FLAGS`                      | manual `-D`/`-U` expansion                 | via `EXTRA_COMPILE_FLAGS` | via `EXTRA_COMPILE_FLAGS` | via `EXTRA_COMPILE_FLAGS` | via `EXTRA_COMPILE_FLAGS`   | Yes         | Both expand `OCJS_DEFINES`/`OCJS_UNDEFINES` the same way                                                     |
| `-Wno-error=implicit-function-declaration` | n/a                                        | C files only              | n/a                       | n/a                       | n/a                         | Yes         | Legacy Python-only, for C files                                                                              |
| `-x c++-header`                            | n/a                                        | n/a                       | n/a                       | yes (PCH gen)             | n/a                         | Yes         | Correct: tells emcc to treat input as header                                                                 |

### Link-Time Flags (Stage 3)

| Flag                                | `full.yml`                  | `full-exceptions.yml`       | Schema default | Purpose                                   | Issue                                                                                                                                                 |
| ----------------------------------- | --------------------------- | --------------------------- | -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-flto`                             | yes                         | yes                         | yes            | Link-time optimization                    | **MISMATCH**: Always present in YAML, but compile stages respect `OCJS_LTO`. If `OCJS_LTO=0`, objects lack LTO bitcode but linker still requests LTO. |
| `-fexceptions`                      | **NO**                      | **YES**                     | **YES**        | JS exception handling (old/slow)          | See Inconsistency #1                                                                                                                                  |
| `-fwasm-exceptions`                 | **NO**                      | **NO**                      | **NO**         | Native WASM exceptions (fast)             | **MISSING**: Never in any YAML config. Compile stages use this when `OCJS_EXCEPTIONS=1`, but link stage doesn't pass it.                              |
| `-sDISABLE_EXCEPTION_CATCHING=1`    | **YES**                     | **NO**                      | `=0`           | Disable JS exception tables               | `full.yml` disables, schema enables. See Inconsistency #1.                                                                                            |
| `-O3`                               | yes                         | yes                         | yes            | Link optimization                         | Always `-O3` regardless of `OCJS_OPT` compile-time level                                                                                              |
| `-sEXPORT_ES6=1`                    | yes                         | yes                         | yes            | ES module output                          | Consistent                                                                                                                                            |
| `-sALLOW_MEMORY_GROWTH=1`           | yes                         | yes                         | yes            | Dynamic memory growth                     | Consistent                                                                                                                                            |
| `-sEXPORTED_RUNTIME_METHODS=["FS"]` | yes                         | yes                         | `=['FS']`      | Export FS API                             | Schema uses single quotes (may cause issues in some shells)                                                                                           |
| `-sINITIAL_MEMORY=100MB`            | yes                         | yes                         | yes            | Initial WASM memory                       | Consistent                                                                                                                                            |
| `-sMAXIMUM_MEMORY=4GB`              | yes                         | yes                         | yes            | Max WASM memory                           | Consistent                                                                                                                                            |
| `-sUSE_FREETYPE=1`                  | yes                         | yes                         | yes            | Link freetype                             | Consistent                                                                                                                                            |
| `-sERROR_ON_UNDEFINED_SYMBOLS=0`    | yes                         | yes                         | **NO**         | Suppress undefined symbol errors          | Schema default uses `-sLLD_REPORT_UNDEFINED` instead (different semantics)                                                                            |
| `-sLLD_REPORT_UNDEFINED`            | **NO**                      | **NO**                      | **YES**        | Report (don't error on) undefined symbols | Only in schema defaults, not in actual YAML configs                                                                                                   |
| `--no-entry`                        | yes                         | yes                         | yes            | No main() entry point                     | Consistent                                                                                                                                            |
| `-lembind`                          | yes (hardcoded)             | yes (hardcoded)             | n/a            | Embind library                            | Always added by `buildFromYaml.py`                                                                                                                    |
| `-pthread`                          | when multi-threaded         | when multi-threaded         | n/a            | Threading                                 | Added by `buildFromYaml.py` based on `THREADING` env                                                                                                  |
| `--closure 1`                       | when `OCJS_CLOSURE=true`    | when `OCJS_CLOSURE=true`    | n/a            | Closure compiler                          | Only via env var                                                                                                                                      |
| `-sEVAL_CTORS=1`                    | when `OCJS_EVAL_CTORS=true` | when `OCJS_EVAL_CTORS=true` | n/a            | Evaluate constructors at link time        | Only via env var                                                                                                                                      |

### wasm-opt Post-Link Flags (Stage 3)

| Flag                                | Value                                  | Conditional | Purpose                          |
| ----------------------------------- | -------------------------------------- | ----------- | -------------------------------- |
| Optimization level                  | `$OCJS_WASM_OPT_LEVEL` (default `-O3`) | always      | wasm-opt optimization level      |
| `--strip-debug`                     | always                                 | always      | Remove debug info                |
| `--strip-producers`                 | always                                 | always      | Remove producer info             |
| `--enable-mutable-globals`          | always                                 | always      | WASM mutable globals feature     |
| `--enable-bulk-memory`              | always                                 | always      | WASM bulk memory feature         |
| `--enable-sign-ext`                 | always                                 | always      | WASM sign extension feature      |
| `--enable-nontrapping-float-to-int` | always                                 | always      | WASM non-trapping conversions    |
| `--enable-exception-handling`       | always                                 | always      | WASM exception handling feature  |
| `--converge`                        | when `OCJS_CONVERGE=true`              | optional    | Run passes until no more changes |
| `--enable-threads`                  | when multi-threaded                    | conditional | WASM threads feature             |

### CMake `-D` Configuration Flags (Stage 1)

| Flag                                        | Value                     | Purpose                              |
| ------------------------------------------- | ------------------------- | ------------------------------------ |
| `-DCMAKE_BUILD_TYPE`                        | `Release`                 | CMake build type                     |
| `-DBUILD_LIBRARY_TYPE`                      | `Static`                  | Static libraries for WASM linking    |
| `-DBUILD_MODULE_FoundationClasses`          | `ON`                      | Core module                          |
| `-DBUILD_MODULE_ModelingData`               | `ON`                      | Modeling data module                 |
| `-DBUILD_MODULE_ModelingAlgorithms`         | `ON`                      | Modeling algorithms module           |
| `-DBUILD_MODULE_DataExchange`               | `ON`                      | Data exchange module                 |
| `-DBUILD_MODULE_ApplicationFramework`       | `ON`                      | XCAF/application framework           |
| `-DBUILD_MODULE_Visualization`              | `OFF`                     | No visualization (no OpenGL in WASM) |
| `-DBUILD_MODULE_Draw`                       | `OFF`                     | No Draw test harness                 |
| `-DBUILD_DOC_Overview`                      | `OFF`                     | No documentation                     |
| `-DUSE_TCL`                                 | `OFF`                     | No Tcl dependency                    |
| `-DUSE_TK`                                  | `OFF`                     | No Tk dependency                     |
| `-DUSE_RAPIDJSON`                           | `ON`                      | Enable RapidJSON support             |
| `-D3RDPARTY_RAPIDJSON_DIR`                  | `$RAPIDJSON_ROOT`         | RapidJSON path                       |
| `-D3RDPARTY_RAPIDJSON_INCLUDE_DIR`          | `$RAPIDJSON_ROOT/include` | RapidJSON headers                    |
| `-D3RDPARTY_FREETYPE_DIR`                   | `$FREETYPE_ROOT`          | FreeType path                        |
| `-D3RDPARTY_FREETYPE_INCLUDE_DIR_freetype2` | `$FREETYPE_ROOT/include`  | FreeType headers                     |
| `-D3RDPARTY_FREETYPE_INCLUDE_DIR_ft2build`  | `$FREETYPE_ROOT/include`  | FreeType ft2build header             |

---

## Inconsistencies Found

### Inconsistency #1 (CRITICAL): Exception mode mismatch between compile and link

**Compile stages** (when `OCJS_EXCEPTIONS=1`): Use `-fwasm-exceptions` — the modern, fast, zero-cost native WASM exception handling.

**Link stage YAML configs**:

- `full.yml`: `-sDISABLE_EXCEPTION_CATCHING=1` — exceptions completely disabled
- `full-exceptions.yml`: `-fexceptions` — the **old, slow JS-based** exception handling
- Schema defaults: `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0` — old JS exceptions enabled

**No YAML config or schema default includes `-fwasm-exceptions`.**

This means:

1. When building with `OCJS_EXCEPTIONS=1`, source `.o` files contain native WASM exception tables, but the linker is never told to emit WASM exception handling instructions. The linker may silently fall back to JS exceptions or strip exception code entirely.
2. `full-exceptions.yml` uses `-fexceptions` (JS exceptions) at link time but compile stages use `-fwasm-exceptions` (native WASM exceptions) — these are **incompatible ABI modes**. Object files compiled with `-fwasm-exceptions` cannot be correctly linked with `-fexceptions`.
3. `full.yml` disables exceptions entirely (`-sDISABLE_EXCEPTION_CATCHING=1`) even though OCCT internally uses `try`/`catch` for error recovery in Boolean operations, STEP import, meshing, etc.

### Inconsistency #2 (MODERATE): LTO flag hardcoded in YAML, conditional in compile

**Compile stages**: `-flto` is conditional on `OCJS_LTO` env var.
**Link stage**: `-flto` is **always present** in `full.yml`, `full-exceptions.yml`, and schema defaults.

When `OCJS_LTO=0`: object files are compiled without LTO bitcode, but the linker still receives `-flto`. This forces emscripten's linker into LTO mode on non-LTO objects, which either:

- Silently degrades (objects pass through without LTO optimization)
- Causes link errors (missing LTO bitcode)

The LTO flag at link time should be driven by the same `OCJS_LTO` env var.

### Inconsistency #3 (MODERATE): `-w` warning suppression inconsistency

| Compile context                                  | Has `-w`?                     |
| ------------------------------------------------ | ----------------------------- |
| CMake source compile (Stage 1)                   | **No** — warnings visible     |
| Legacy Python source compile                     | Yes — all warnings suppressed |
| Binding compile (Stage 2)                        | Yes — all warnings suppressed |
| PCH compile                                      | Yes — all warnings suppressed |
| additionalBindCode compile (in buildFromYaml.py) | **No** — warnings visible     |

The `-w` flag suppresses **all** compiler warnings including potentially dangerous ones (implicit conversions, narrowing, undefined behavior). The inconsistency means CMake-compiled sources get warnings but binding compilation does not, even though bindings may have issues that warnings would catch.

### Inconsistency #4 (LOW): Link optimization vs compile optimization

**Compile stages**: Optimization level is `$OCJS_OPT` (default `-O2`).
**Link stage**: Optimization level is hardcoded to `-O3` in all YAML configs.

While mixed optimization levels between compile and link are technically supported by emscripten, the mismatch means:

- Setting `OCJS_OPT=-Os` for small binary size is partially undermined by `-O3` at link time
- The wasm-opt stage adds another optimization layer (`-O3` by default, configurable via `OCJS_WASM_OPT_LEVEL`)

### Inconsistency #5 (LOW): Schema defaults vs actual YAML configs

| Setting                    | Schema default                                | `full.yml`                       | `full-exceptions.yml`            |
| -------------------------- | --------------------------------------------- | -------------------------------- | -------------------------------- |
| Exception flags            | `-fexceptions -sDISABLE_EXCEPTION_CATCHING=0` | `-sDISABLE_EXCEPTION_CATCHING=1` | `-fexceptions`                   |
| Undefined symbols          | `-sLLD_REPORT_UNDEFINED`                      | `-sERROR_ON_UNDEFINED_SYMBOLS=0` | `-sERROR_ON_UNDEFINED_SYMBOLS=0` |
| `EXPORTED_RUNTIME_METHODS` | `=['FS']` (single quotes)                     | `=["FS"]` (double quotes)        | `=["FS"]` (double quotes)        |

The schema defaults serve as fallback when YAML configs don't specify `emccFlags`. The schema defaults differ from both production configs, meaning a minimal YAML without `emccFlags` would get a different (and potentially broken) build profile.

### Inconsistency #6 (LOW): Python standalone defaults vs shell defaults

| Variable   | `build-wasm.sh` export | Python `os.environ.get()` fallback |
| ---------- | ---------------------- | ---------------------------------- |
| `OCJS_OPT` | `-O2`                  | `-O0`                              |
| `OCJS_LTO` | `1` (on)               | `"0"` (off)                        |

When Python scripts are invoked directly (not via `build-wasm.sh`), they use slower/different defaults. This only matters for manual/debugging invocations but can cause confusion.

---

## Flag Flow Diagram

```
Environment Variables (set by user or preset)
    │
    ├─ OCJS_OPT ──────────────┬──→ CMake: CMAKE_C_FLAGS, CMAKE_CXX_FLAGS
    │                          ├──→ Bindings: emcc -c (OPT_LEVEL)
    │                          ├──→ PCH: emcc -c (OPT_LEVEL)
    │                          └──→ Link: NOT USED (YAML has hardcoded -O3)  ← DISCONNECT
    │
    ├─ OCJS_LTO ───────────────┬──→ CMake: -flto in C/CXX_FLAGS
    │                          ├──→ Bindings: -flto conditional
    │                          ├──→ PCH: -flto conditional
    │                          └──→ Link: NOT USED (YAML has hardcoded -flto)  ← DISCONNECT
    │
    ├─ OCJS_EXCEPTIONS ────────┬──→ CMake: -fwasm-exceptions in CXX_FLAGS
    │                          ├──→ Bindings: -fwasm-exceptions (WASM_EXCEPTION_FLAGS)
    │                          ├──→ PCH: -fwasm-exceptions (WASM_EXCEPTION_FLAGS)
    │                          └──→ Link: NOT USED (YAML has -fexceptions or nothing)  ← CRITICAL DISCONNECT
    │
    ├─ OCJS_WASM_OPT_LEVEL ───└──→ wasm-opt: optimization level (default -O3)
    │
    ├─ OCJS_CLOSURE ───────────└──→ Link: --closure 1
    ├─ OCJS_EVAL_CTORS ────────└──→ Link: -sEVAL_CTORS=1
    ├─ OCJS_CONVERGE ──────────└──→ wasm-opt: --converge
    │
    ├─ OCJS_DEFINES ───────────┬──→ CMake: -D<name> in C/CXX_FLAGS
    │                          └──→ Bindings/PCH: -D<name> (EXTRA_COMPILE_FLAGS)
    │
    ├─ OCJS_UNDEFINES ─────────┬──→ CMake: -U<name> in C/CXX_FLAGS
    │                          └──→ Bindings/PCH: -U<name> (EXTRA_COMPILE_FLAGS)
    │
    └─ THREADING ──────────────┬──→ CMake: -pthread
                               ├──→ Bindings/PCH: -pthread
                               └──→ Link: -pthread
```

---

## Recommendations

### R1 (CRITICAL): Fix exception flag propagation to link stage

The YAML `emccFlags` for exception handling should match the compile-stage flags:

- When `OCJS_EXCEPTIONS=0`: use `-sDISABLE_EXCEPTION_CATCHING=1` (current `full.yml` behavior)
- When `OCJS_EXCEPTIONS=1`: use `-fwasm-exceptions` at link time (NOT `-fexceptions`)

Options:

1. **Inject flags at link time**: Have `buildFromYaml.py` read `OCJS_EXCEPTIONS` and append `-fwasm-exceptions` to the link command, overriding any conflicting YAML flags.
2. **Template YAML configs**: Create `full-wasm-exceptions.yml` with `-fwasm-exceptions` instead of `-fexceptions`.
3. **Remove exception flags from YAML entirely**: Let `buildFromYaml.py` compute them from `OCJS_EXCEPTIONS`.

### R2 (MODERATE): Make LTO flag at link time respect OCJS_LTO

Have `buildFromYaml.py` conditionally add/remove `-flto` based on `OCJS_LTO` rather than relying on YAML hardcoding. Alternatively, strip `-flto` from YAML emccFlags when `OCJS_LTO=0`.

### R3 (MODERATE): Reconsider blanket `-w` warning suppression

The `-w` flag hides all warnings including potentially dangerous ones in generated binding code. Consider:

- Replacing `-w` with targeted suppressions (e.g., `-Wno-unused-parameter -Wno-deprecated-declarations`)
- Or at minimum, making it configurable via an env var so developers can enable warnings when debugging

### R4 (LOW): Propagate OCJS_OPT to link stage

Either remove the hardcoded `-O3` from YAML configs and inject `$OCJS_OPT` at link time, or document that link-time optimization is intentionally different from compile-time optimization.

### R5 (LOW): Align schema defaults with production configs

Update `customBuildSchema.py` defaults to match `full.yml` rather than the legacy `-fexceptions` mode, since the schema defaults serve as the fallback configuration. Specifically:

- Change default exception flags to `-sDISABLE_EXCEPTION_CATCHING=1` (matching `full.yml`)
- Change `-sLLD_REPORT_UNDEFINED` to `-sERROR_ON_UNDEFINED_SYMBOLS=0` (matching production configs)
- Fix single quotes in `EXPORTED_RUNTIME_METHODS` to double quotes

### R6 (LOW): Align Python standalone defaults with shell defaults

Update Python fallbacks from `-O0`/`"0"` to `-O2`/`"1"` to match `build-wasm.sh` defaults, reducing confusion when scripts are invoked manually.
