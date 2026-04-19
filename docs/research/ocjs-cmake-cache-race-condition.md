---
title: 'OCJS CMake Cache Race Condition'
description: 'Root cause analysis of llvm-ranlib failure during cmake incremental rebuild with stale artifacts from a previous configuration'
status: draft
created: '2026-03-27'
updated: '2026-03-27'
category: investigation
related:
  - docs/research/ocjs-test-failure-resolution.md
---

# OCJS CMake Cache Race Condition

Investigation into `llvm-ranlib` failures during `compile-sources` when switching between exception and non-exception WASM configurations. Root cause: stale cmake artifacts from a previous configuration are not cleaned on flag change, causing parallel cmake rebuilds to race on archive creation.

## Executive Summary

When switching between build configurations (e.g., `OCJS_EXCEPTIONS=0` to `OCJS_EXCEPTIONS=1`), the `compile-sources` target fails with `llvm-ranlib` errors on `.a` files. The failure is caused by three compounding gaps: (1) `step_sources_cmake` does not detect flag changes or clean stale cmake state, (2) Nx does not clean output directories on cache miss, and (3) `compile-sources` is the only compile target that skips `validate_build_flags`. The result is cmake attempting a parallel incremental rebuild over incompatible artifacts, producing transient archive-creation race conditions that Nx marks as "flaky."

## Problem Statement

During an OCJS build session, switching from a non-exception configuration to an exception configuration caused this failure sequence:

1. `llvm-ranlib` failed with "archive file not found" on `libTKShHealing.a`
2. The `.a` file existed on disk with a timestamp from the previous (non-exception) build
3. cmake's parallel rebuild (`-j N`) was attempting to rebuild the archive with new flags
4. The archive was transiently deleted during the rebuild, causing `llvm-ranlib` to fail
5. On retry, `compile-sources` succeeded — Nx classified the first failure as a flaky task

## Methodology

- Read the image transcript of the failing build session
- Traced the `compile-sources` → `step_sources_cmake` → cmake execution path
- Analyzed Nx cache key computation via `nx.json` named inputs and `project.json` targets
- Compared build-flag validation coverage across all build steps
- Examined cmake's incremental rebuild behavior when `CMAKE_CXX_FLAGS` change

## Findings

### Finding 1: `compile-sources` skips build-flag validation

The `sources` command in `build-wasm.sh` does not call `validate_build_flags` before running:

```bash
bindings)  validate_build_flags && step_bindings ;;
sources)   step_sources ;;            # ← no validation
link)      validate_build_flags && step_link "$YAML_CONFIG" ;;
```

Both `bindings` (line 777) and `link` (line 781) validate, but `sources` (line 778) runs cmake blindly against whatever artifacts exist in `build/occt-cmake/`. This is the only compile target that lacks this guard.

### Finding 2: No cmake flag-change detection or clean rebuild trigger

`step_sources_cmake` (lines 483–590) has no mechanism to detect that compile flags have changed since the last cmake configure/build:

```bash
step_sources_cmake() {
  local cmake_build_dir="$OCJS_ROOT/build/occt-cmake"
  local lib_dir="$cmake_build_dir/lin32/clang/lib"

  if [ -d "$lib_dir" ] && [ "$(ls "$lib_dir"/*.a 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "  CMake build directory exists with ... libraries, checking if rebuild needed..."
  fi

  # ... assembles cmake_flags from current OCJS_* env vars ...

  emcmake cmake -B "$cmake_build_dir" "${cmake_flags[@]}" "$OCCT_ROOT"
  cmake --build "$cmake_build_dir" -j"$nproc"
}
```

When flags change (e.g., `-fwasm-exceptions` added), cmake detects the flag change via `CMakeCache.txt` and marks all targets for recompilation. But the old `.a` files, `.o` files, and cmake internal state from the previous configuration remain on disk, forcing an incremental rebuild rather than a clean one.

### Finding 3: Nx does not clean outputs on cache miss

The `compile-sources` target declares its outputs as:

```json
"outputs": ["{projectRoot}/build/occt-cmake/", "{projectRoot}/build/.cmake-lib-dir"]
```

Nx behavior:

- **Cache HIT**: Restores `build/occt-cmake/` from cache (clean state from the matching config)
- **Cache MISS**: Runs the command **without cleaning** the output directory

When `OCJS_EXCEPTIONS` changes, Nx correctly computes a new hash (cache miss), but the stale `build/occt-cmake/` from the previous config remains on disk. The build script is expected to handle its own cleanup, but `step_sources_cmake` does not.

### Finding 4: cmake parallel rebuild race condition

When cmake detects that `CMAKE_CXX_FLAGS` changed:

1. All source files are marked for recompilation
2. Parallel build (`-j N`) recompiles `.o` files and recreates `.a` archives
3. Archive creation involves: (a) `ar` deletes old `.a`, (b) `ar` creates new `.a` from `.o` files, (c) `llvm-ranlib` indexes the `.a`
4. With many targets rebuilding simultaneously, there is a window where `llvm-ranlib` is invoked on an archive that `ar` has already deleted but not yet recreated

This is a known cmake/make limitation — archive targets are not truly atomic. The race is particularly likely when switching the entire flag set (exception vs non-exception) because ALL OCCT libraries need rebuilding simultaneously.

### Finding 5: The "flaky task" pattern masks the systemic issue

Nx classified the retry success as a "flaky task" — the first attempt failed, the second succeeded. This is technically accurate (the failure is transient), but it masks the root cause. The race condition will recur every time configurations are switched unless the stale-state problem is addressed.

## Root Cause Chain

```
Non-exception build succeeds
  → build/occt-cmake/ populated with non-exception .a files
  → Nx caches output for hash H1

Switch to OCJS_EXCEPTIONS=1
  → Nx computes hash H2 (cache miss for compile-sources)
  → Nx runs step_sources_cmake WITHOUT cleaning build/occt-cmake/
  → build/occt-cmake/ still contains non-exception artifacts
  → cmake detects CMAKE_CXX_FLAGS change → marks ALL targets dirty
  → cmake -j N parallel rebuild over stale artifacts
  → ar deletes old .a → llvm-ranlib tries to index → file not found
  → BUILD FAILS (transient race condition)

Retry
  → cmake picks up where it left off (partial rebuild)
  → Succeeds (Nx marks as flaky)
```

## Recommendations

| #   | Action                                                  | Priority | Effort  | Impact |
| --- | ------------------------------------------------------- | -------- | ------- | ------ |
| R1  | Add cmake flag-change detection to `step_sources_cmake` | P0       | Low     | High   |
| R2  | Add `validate_build_flags` to the `sources` command     | P1       | Trivial | Medium |
| R3  | Consider Nx `clean` option or pre-clean script          | P2       | Low     | Medium |

### R1: cmake flag-change detection (recommended fix)

Save a hash of cmake-relevant compile flags and compare before running cmake. If flags changed, delete `build/occt-cmake/` for a clean rebuild:

```bash
step_sources_cmake() {
  local cmake_build_dir="$OCJS_ROOT/build/occt-cmake"
  local cmake_flags_hash_file="$OCJS_ROOT/build/.cmake-flags-hash"

  # Compute hash of flags that affect cmake compilation
  local flags_hash
  flags_hash=$(echo "${OCJS_OPT}|${OCJS_EXTRA_CFLAGS}|${OCJS_LTO}|${OCJS_EXCEPTIONS}|${OCJS_EH_MODE:-wasm}|${OCJS_SIMD}|${THREADING}|${OCJS_DEFINES}|${OCJS_UNDEFINES}" | shasum -a 256 | cut -d' ' -f1)

  if [ -f "$cmake_flags_hash_file" ]; then
    local stored_hash
    stored_hash=$(cat "$cmake_flags_hash_file")
    if [ "$flags_hash" != "$stored_hash" ]; then
      echo "  Compile flags changed — cleaning cmake build directory for clean rebuild..."
      rm -rf "$cmake_build_dir"
    fi
  fi

  # ... existing cmake configure + build ...

  # Save hash after successful build
  echo "$flags_hash" > "$cmake_flags_hash_file"
}
```

This preserves fast incremental builds when flags haven't changed (same-config iteration) while ensuring a clean rebuild when switching configurations.

### R2: Add `validate_build_flags` to `sources`

Change line 778 in `build-wasm.sh`:

```bash
# Before:
sources)   step_sources ;;

# After:
sources)   validate_build_flags && step_sources ;;
```

This ensures `compile-sources` fails fast with a clear error when `build-flags.json` (written by PCH) doesn't match the current environment, rather than producing a cryptic `llvm-ranlib` race condition.

### R3: Nx-level pre-clean

Add the cmake flags hash file to the `compile-sources` outputs so Nx tracks it:

```json
"outputs": [
  "{projectRoot}/build/occt-cmake/",
  "{projectRoot}/build/.cmake-lib-dir",
  "{projectRoot}/build/.cmake-flags-hash"
]
```

This ensures that on cache HIT, the flags hash file is restored alongside the cmake artifacts, keeping them consistent.

## References

- `repos/opencascade.js/build-wasm.sh` — lines 483–590 (`step_sources_cmake`)
- `repos/opencascade.js/project.json` — `compile-sources` target (lines 90–108)
- `repos/opencascade.js/nx.json` — `namedInputs` cache key definitions
- `repos/opencascade.js/src/Common.py` — `validate_build_flags` / `write_build_flags`
- `repos/opencascade.js/BUILD_SYSTEM.md` — Nx caching documentation
