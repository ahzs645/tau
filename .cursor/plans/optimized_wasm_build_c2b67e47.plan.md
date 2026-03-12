---
name: Optimized WASM Build
overview: Apply all optimization recommendations from the research doc (-fno-exceptions, --closure 1, -sEVAL_CTORS, --converge) as configurable options through the experiment YAML, then run a full -O2/-O3 optimized build with benchmarks.
todos:
  - id: common-py
    content: Change WASM_EXCEPTION_FLAGS to [-fno-exceptions] when OCJS_EXCEPTIONS=0 in Common.py
    status: completed
  - id: build-from-yaml
    content: Add --closure, -sEVAL_CTORS, and --converge support in buildFromYaml.py (link + wasm-opt)
    status: completed
  - id: provenance
    content: Update provenance.py to record -fno-exceptions instead of -sDISABLE_EXCEPTION_CATCHING=1
    status: completed
  - id: build-wasm-sh
    content: Export OCJS_CLOSURE, OCJS_EVAL_CTORS, OCJS_CONVERGE env vars in build-wasm.sh
    status: completed
  - id: experiment-sh
    content: Parse optimizations.* fields from YAML and pass as env vars in wasm-experiment.sh
    status: completed
  - id: experiment-yml
    content: Create O2-noLTO-optimized.yml experiment config
    status: completed
  - id: run-build
    content: Run the full experiment build (compile + link + wasm-opt)
    status: in_progress
  - id: run-tests
    content: Validate with pnpm nx test runtime Example models
    status: pending
  - id: run-benchmarks
    content: Run benchmarks via wasm-experiment.sh
    status: pending
isProject: false
---

# Optimized WASM Build

## Goal

Build a fully optimized `-O2` compile / `-O3` wasm-opt / no-exceptions build, applying all 4 recommendations from `docs/research/occt-wasm-optimization.md`:

1. `-fno-exceptions` on no-exceptions builds (compile stage)
2. `--closure 1` for JS minification (link stage)
3. `-sEVAL_CTORS=1` for faster startup (link stage)
4. `--converge` in wasm-opt (post-link stage)

All flags must be configurable through the experiment YAML config, not hardcoded.

## Changes

### 1. Add experiment YAML fields for new flags

Extend the experiment YAML schema with optional fields under a new `optimizations` section:

```yaml
optimizations:
  closure: true          # --closure 1 at link time
  evalCtors: true        # -sEVAL_CTORS=1 at link time
  converge: true         # --converge in wasm-opt
```

These default to `false` when absent, preserving backward compatibility with existing experiment configs.

### 2. Wire flags through `wasm-experiment.sh`

In [scripts/wasm-experiment.sh](scripts/wasm-experiment.sh), after the existing `parse_yaml_field` calls (~line 273), add parsing for the new fields:

```
EXP_CLOSURE=$(parse_yaml_field "optimizations.closure" "false")
EXP_EVAL_CTORS=$(parse_yaml_field "optimizations.evalCtors" "false")
EXP_CONVERGE=$(parse_yaml_field "optimizations.converge" "false")
```

Pass them as env vars to `build-wasm.sh` (~line 331):

```
OCJS_CLOSURE="$EXP_CLOSURE"
OCJS_EVAL_CTORS="$EXP_EVAL_CTORS"
OCJS_CONVERGE="$EXP_CONVERGE"
```

### 3. Export new env vars in `build-wasm.sh`

In [repos/opencascade.js/build-wasm.sh](repos/opencascade.js/build-wasm.sh) after line 94, add:

```bash
export OCJS_CLOSURE="${OCJS_CLOSURE:-false}"
export OCJS_EVAL_CTORS="${OCJS_EVAL_CTORS:-false}"
export OCJS_CONVERGE="${OCJS_CONVERGE:-false}"
```

### 4. Apply `-fno-exceptions` in `Common.py`

In [repos/opencascade.js/src/Common.py](repos/opencascade.js/src/Common.py) line 14, change:

```python
# Before:
WASM_EXCEPTION_FLAGS = ["-fwasm-exceptions"] if USE_WASM_EXCEPTIONS else []

# After:
WASM_EXCEPTION_FLAGS = ["-fwasm-exceptions"] if USE_WASM_EXCEPTIONS else ["-fno-exceptions"]
```

This affects all compilation units (sources, bindings, PCH, additional bind code) since they all import `WASM_EXCEPTION_FLAGS` from `Common.py`.

### 5. Apply `--closure 1` and `-sEVAL_CTORS` in `buildFromYaml.py`

In [repos/opencascade.js/src/buildFromYaml.py](repos/opencascade.js/src/buildFromYaml.py), in the `runBuild` function, inject flags into `build["emccFlags"]` before the link command (~line 104):

```python
if os.environ.get("OCJS_CLOSURE", "false") == "true":
    linkCmd.extend(["--closure", "1"])
if os.environ.get("OCJS_EVAL_CTORS", "false") == "true":
    linkCmd.append("-sEVAL_CTORS=1")
```

### 6. Apply `--converge` in wasm-opt invocation

In [repos/opencascade.js/src/buildFromYaml.py](repos/opencascade.js/src/buildFromYaml.py) line 129, after building `wasm_opt_flag_list`, add:

```python
if os.environ.get("OCJS_CONVERGE", "false") == "true":
    wasm_opt_flag_list.append("--converge")
```

### 7. Update provenance recording

In [repos/opencascade.js/src/provenance.py](repos/opencascade.js/src/provenance.py), update `_build_compile_flags` (~line 198) to record `-fno-exceptions` instead of `-sDISABLE_EXCEPTION_CATCHING=1` when exceptions are off:

```python
if exceptions == "1":
    flags.append("-fwasm-exceptions")
else:
    flags.append("-fno-exceptions")
```

### 8. Create experiment config

Create [scripts/experiments/O2-noLTO-optimized.yml](scripts/experiments/O2-noLTO-optimized.yml):

```yaml
name: "v8-O2-noLTO-optimized"
description: "Fully optimized production build: -O2 compile, -O3 wasm-opt, no exceptions, all optimizations"

compilation:
  optimization: "-O2"
  lto: false
  exceptions: "none"
  threading: "single-threaded"

linking:
  yaml: "custom_build_single_v8.yml"
  wasmOptLevel: "-O3"

optimizations:
  closure: true
  evalCtors: true
  converge: true

benchmark:
  iterations: 10
  filter: ["primitives", "booleans", "fillets", "extrusions", "complex", "examples", "stress"]
```

### 9. Run the build

```bash
./scripts/wasm-experiment.sh scripts/experiments/O2-noLTO-optimized.yml --skip-benchmark
```

The build will require a new compilation cache entry (the cache key changes because `-fno-exceptions` changes the `.o` files vs the previous `[]` flags). Compilation will take ~15-30 minutes. Linking + wasm-opt should take ~2-3 minutes, potentially longer with `--converge`.

### 10. Validate with tests

```bash
pnpm nx test runtime --testNamePattern="Example models" --watch=false
```

If `--closure 1` breaks tests (known embind compatibility issues), revert closure by setting `closure: false` in the experiment YAML and re-run from the link step only (compilation cache is still valid).

### 11. Run benchmarks

Re-run the experiment without `--skip-benchmark`:

```bash
./scripts/wasm-experiment.sh scripts/experiments/O2-noLTO-optimized.yml
```

## Risk: --closure 1 and embind

If closure breaks, the fallback is straightforward: set `closure: false` in the YAML. Since closure only affects linking (not compilation), the cached `.o` files are reusable and only a re-link is needed. The experiment script handles this automatically via the `full` command (cache hit on compilation, re-link with new flags).

## Files Modified

- `repos/opencascade.js/src/Common.py` (1 line)
- `repos/opencascade.js/src/buildFromYaml.py` (~6 lines)
- `repos/opencascade.js/src/provenance.py` (~2 lines)
- `repos/opencascade.js/build-wasm.sh` (~3 lines)
- `scripts/wasm-experiment.sh` (~12 lines)
- `scripts/experiments/O2-noLTO-optimized.yml` (new file)
